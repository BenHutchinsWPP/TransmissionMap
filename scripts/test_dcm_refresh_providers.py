"""Tests for moratoriums.refresh.{search,fetch,llm}: fake HTTP only, stdlib only, no network."""
import email.message
import http.client
import io
import json
import tempfile
import threading
import unittest
import urllib.error
import urllib.parse
from pathlib import Path

from moratoriums.refresh import config
from moratoriums.refresh import fetch as F
from moratoriums.refresh import llm as L
from moratoriums.refresh import search as S

FIX = Path(__file__).parent / "moratoriums" / "refresh" / "fixtures"


class FakeResp:
    def __init__(self, body: bytes, ctype="text/html; charset=utf-8", status=200, url="https://x.test/"):
        self._io = io.BytesIO(body)
        self.status = status
        self.headers = email.message.Message()
        self.headers["Content-Type"] = ctype
        self._url = url

    def read(self, n=-1):
        return self._io.read(n)

    def geturl(self):
        return self._url

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def http_error(code):
    return urllib.error.HTTPError("https://x.test/", code, "err", {}, None)


class Opener:
    """Records requests; plays a script of responses/exceptions in order (last one repeats)."""

    def __init__(self, *script):
        self.script = list(script)
        self.requests = []

    def __call__(self, req, timeout=None):
        self.requests.append((req, timeout))
        item = self.script.pop(0) if len(self.script) > 1 else self.script[0]
        if isinstance(item, Exception):
            raise item
        return item


def brave_resp(name="brave_web.json"):
    return FakeResp((FIX / name).read_bytes(), "application/json")


class SearchTests(unittest.TestCase):
    def test_brave_params_and_header_key(self):
        op = Opener(brave_resp())
        b = S.BraveSearch("SECRET", opener=op)
        hits = b.search("data center moratorium", "2026-09-01to2026-10-08", "q1", endpoint="web")
        req = op.requests[0][0]
        u = urllib.parse.urlsplit(req.full_url)
        q = dict(urllib.parse.parse_qsl(u.query))
        self.assertEqual(u.path, "/res/v1/web/search")
        self.assertEqual(q["freshness"], "2026-09-01to2026-10-08")
        self.assertEqual((q["count"], q["country"], q["search_lang"]), ("20", "us", "en"))
        self.assertEqual(q["q"], "data center moratorium")
        self.assertNotIn("SECRET", req.full_url)
        self.assertEqual(req.get_header("X-subscription-token"), "SECRET")
        self.assertEqual(req.get_header("Accept"), "application/json")
        self.assertEqual(b.requests, 1)
        self.assertTrue(all(h.query_id == "q1" for h in hits))
        self.assertEqual(hits[0].age, "2 days ago")

    def test_news_endpoint_and_freshness_keyword(self):
        op = Opener(brave_resp("brave_news.json"))
        hits = S.BraveSearch("k", opener=op).search("crypto pause", "pw", endpoint="news")
        self.assertIn("/res/v1/news/search", op.requests[0][0].full_url)
        self.assertIn("freshness=pw", op.requests[0][0].full_url)
        self.assertEqual([h.url for h in hits], ["https://news.example.org/a"])

    def test_dedupe_by_normalised_url(self):
        hits = S.BraveSearch("k", opener=Opener(brave_resp())).search("q")
        self.assertEqual(len(hits), 2)
        self.assertEqual(hits[0].title, "Council votes for data center moratorium")

    def test_retry_429_then_success(self):
        sleeps = []
        op = Opener(http_error(429), http_error(503), brave_resp())
        b = S.BraveSearch("k", opener=op, sleep=sleeps.append)
        self.assertEqual(len(b.search("q")), 2)
        self.assertEqual(b.requests, 3)
        self.assertEqual(sleeps, [1.0, 2.0])

    def test_retry_gives_up_after_three(self):
        b = S.BraveSearch("SECRET", opener=Opener(http_error(429)), sleep=lambda s: None)
        with self.assertRaises(RuntimeError) as cm:
            b.search("q")
        self.assertEqual(b.requests, 4)
        self.assertNotIn("SECRET", str(cm.exception))

    def test_non_retryable_raises_at_once(self):
        b = S.BraveSearch("k", opener=Opener(http_error(401)), sleep=lambda s: None)
        with self.assertRaises(RuntimeError):
            b.search("q")
        self.assertEqual(b.requests, 1)

    def test_fixture_search_deterministic(self):
        with tempfile.TemporaryDirectory() as d:
            (Path(d) / "search").mkdir()
            key = S.fixture_key("q one", "pw", "news")
            (Path(d) / "search" / f"{key}.json").write_bytes((FIX / "brave_web.json").read_bytes())
            fs = S.FixtureSearch(d)
            a, b = fs.search("q one", "pw"), fs.search("q one", "pw")
            self.assertEqual(a, b)
            self.assertEqual(len(a), 2)
            self.assertEqual(fs.search("q one", "pm"), [])
            self.assertEqual(fs.search("q one", "pw", endpoint="web"), [])


def err_resp(code, body: bytes):
    return urllib.error.HTTPError("https://x.test/", code, "err", {}, io.BytesIO(body))


class SearchRobustnessTests(unittest.TestCase):
    def test_network_error_retried_then_success(self):
        op = Opener(urllib.error.URLError(TimeoutError()), brave_resp())
        b = S.BraveSearch("k", opener=op, sleep=lambda s: None)
        self.assertEqual(len(b.search("q")), 2)
        self.assertEqual(len(op.requests), 2)
        self.assertEqual(b.requests, 2)

    def test_other_network_errors_retryable(self):
        for exc in (TimeoutError(), ConnectionResetError(), http.client.RemoteDisconnected("gone")):
            op = Opener(exc, brave_resp())
            self.assertEqual(len(S.BraveSearch("k", opener=op, sleep=lambda s: None).search("q")), 2)

    def test_four_timeouts_raise_without_key(self):
        op = Opener(TimeoutError())
        b = S.BraveSearch("SECRET", opener=op, sleep=lambda s: None)
        with self.assertRaises(S.SearchError) as cm:
            b.search("q")
        self.assertEqual(cm.exception.status, 0)
        self.assertEqual(len(op.requests), 4)
        self.assertNotIn("SECRET", str(cm.exception))

    def test_error_body_included_status_integer(self):
        body = json.dumps({"type": "ErrorResponse", "error": {"code": "SUBSCRIPTION_TOKEN_INVALID",
                                                              "detail": "token SECRET is invalid", "status": 401}}).encode()
        b = S.BraveSearch("SECRET", opener=Opener(err_resp(401, body)), sleep=lambda s: None)
        with self.assertRaises(S.SearchError) as cm:
            b.search("q")
        self.assertEqual(cm.exception.status, 401)
        self.assertIn("SUBSCRIPTION_TOKEN_INVALID", str(cm.exception))
        self.assertNotIn("SECRET", str(cm.exception))

    def test_hard_stop_at_max_requests(self):
        calls = []
        b = S.BraveSearch("k", max_requests=2, opener=lambda r, timeout=None: calls.append(r) or brave_resp(),
                          sleep=lambda s: None)
        b.search("a")
        b.search("b")
        with self.assertRaises(S.SearchBudgetExhausted):
            b.search("c")
        self.assertEqual((b.requests, len(calls)), (2, 2))

    def test_retries_count_against_budget(self):
        op = Opener(http_error(429))
        b = S.BraveSearch("k", max_requests=2, opener=op, sleep=lambda s: None)
        with self.assertRaises(S.SearchBudgetExhausted):
            b.search("a")
        self.assertEqual(len(op.requests), 2)

    def test_bad_endpoint_rejected(self):
        with self.assertRaises(ValueError):
            S.BraveSearch("k", opener=Opener(brave_resp())).search("q", endpoint="images")

    def test_normalize_url_http_https_alike(self):
        self.assertEqual(S.normalize_url("http://www.x.test/a/"), S.normalize_url("https://x.test/a"))

    def test_request_counter_thread_safe(self):
        b = S.BraveSearch("k", opener=lambda req, timeout=None: brave_resp())
        ts = [threading.Thread(target=lambda: [b.search("q") for _ in range(25)]) for _ in range(8)]
        [t.start() for t in ts]
        [t.join() for t in ts]
        self.assertEqual(b.requests, 200)


class FetchTests(unittest.TestCase):
    def test_bad_scheme_never_opens(self):
        for url in ("file:///etc/passwd", "ftp://x.test/a", "data:text/html,hi", "/etc/passwd"):
            op = Opener(FakeResp(b"secret"))
            p = F.fetch(url, opener=op)
            self.assertEqual(p, F.Page(url, url, 0, "", "", "bad_scheme"))
            self.assertEqual(op.requests, [])
            with tempfile.TemporaryDirectory() as d:
                self.assertEqual(F.FixtureFetcher(d)(url).error, "bad_scheme")

    def test_unsupported_type(self):
        for ctype in ("image/png", "application/octet-stream", "application/zip"):
            p = F.fetch("https://x.test/a", opener=Opener(FakeResp(b"\x89PNG....", ctype)))
            self.assertEqual((p.error, p.text), ("unsupported_type", ""), ctype)

    def test_octet_stream_html_sniffed(self):
        p = F.fetch("https://x.test/a", opener=Opener(FakeResp(b"<!DOCTYPE html><p>moratorium</p>", "application/octet-stream")))
        self.assertEqual((p.error, p.kind, p.text), ("", "html", "moratorium"))

    def test_json_and_plain_text_accepted(self):
        for ctype in ("application/json", "text/plain"):
            p = F.fetch("https://x.test/a", opener=Opener(FakeResp(b'{"a": 1}', ctype)))
            self.assertEqual((p.error, p.kind), ("", "text"))

    def test_total_deadline(self):
        ticks = iter([0, 1, 31, 32, 33])
        p = F.fetch("https://x.test/a", opener=Opener(FakeResp(b"<p>x</p>" * 100)), clock=lambda: next(ticks))
        self.assertEqual(p.error, "timeout")

    def test_http_error_closed(self):
        closed = []
        e = err_resp(404, b"")
        e.close = lambda: closed.append(1)
        self.assertEqual(F.fetch("https://x.test/", opener=Opener(e)).error, "http_404")
        self.assertEqual(closed, [1])

    def test_user_agent_contact(self):
        self.assertIn(F.REPO_URL, F.user_agent({}))
        self.assertIn("ops@example.org", F.user_agent({"DCM_CONTACT": "ops@example.org"}))

    def test_html_to_text_table_cells_separated(self):
        text = F.html_to_text("<table><tr><td>Mesa</td><td>CO</td></tr><tr><th>Dell</th><dd>TX</dd></tr></table>")
        self.assertEqual(text.splitlines(), ["Mesa", "CO", "Dell", "TX"])

    def test_html_to_text_keeps_article_header(self):
        text = F.html_to_text("<article><header><h1>Headline</h1><time>Oct 8</time></header><p>Body</p></article>")
        self.assertIn("Headline", text)

    def test_html_to_text_unclosed_nav_keeps_body(self):
        body = "The council discussed the moratorium at length. " * 40
        text = F.html_to_text(f"<html><body><nav><p>x<main><p>{body}</p></main></body></html>")
        self.assertIn("discussed the moratorium", text)
        self.assertGreater(len(text), 1000)

    def test_html_to_text_short_page_stays_short(self):
        self.assertEqual(F.html_to_text("<nav>menu</nav><p>hello</p>"), "hello")

    def test_skip_counts_per_tag(self):
        self.assertEqual(F.html_to_text("<nav><footer>f</footer>still nav</nav><p>after</p>"), "after")

    def test_fixture_fetcher_not_truncated(self):
        self.assertFalse(F.fetch("https://x.test/", opener=Opener(FakeResp(b"<p>hi</p>"))).truncated)

    def test_html_to_text_drops_chrome(self):
        text = F.html_to_text((FIX / "page.html").read_text())
        for gone in ("SCRIPT_TEXT", "NAV LINK", "FOOTER TEXT", "NOSCRIPT TEXT", "color:red"):
            self.assertNotIn(gone, text)
        self.assertIn("SITE HEADER", text)  # <header> is content, not chrome
        self.assertIn("180-day moratorium", text)
        self.assertIn("ordinance & return", text)
        self.assertGreater(len(text.splitlines()), 2)  # block breaks kept

    def test_fetch_html_sends_user_agent_and_timeout(self):
        op = Opener(FakeResp((FIX / "page.html").read_bytes(), url="https://final.test/p"))
        p = F.fetch("https://x.test/p", opener=op)
        req, timeout = op.requests[0]
        self.assertEqual(req.get_header("User-agent"), F.user_agent())
        self.assertEqual(timeout, 15)
        self.assertEqual((p.status, p.error, p.final_url), (200, "", "https://final.test/p"))
        self.assertIn("moratorium", p.text)

    def test_http_and_timeout_errors(self):
        self.assertEqual(F.fetch("https://x.test/", opener=Opener(http_error(403))).error, "http_403")
        self.assertEqual(F.fetch("https://x.test/", opener=Opener(TimeoutError())).error, "timeout")
        url_to = urllib.error.URLError(TimeoutError())
        self.assertEqual(F.fetch("https://x.test/", opener=Opener(url_to)).error, "timeout")

    def test_five_mb_cap(self):
        body = b"<p>" + b"a" * (F.MAX_BYTES + 5000) + b"</p>"
        resp = FakeResp(body)
        p = F.fetch("https://x.test/", opener=Opener(resp))
        self.assertLessEqual(resp._io.tell(), F.MAX_BYTES + 1)
        self.assertEqual(p.error, "")
        self.assertTrue(p.truncated)
        self.assertGreater(len(p.text), F.MAX_CHARS)  # Page.text is the full text; truncating is for prompts

    def test_truncate_short_text_kept_whole(self):
        t = "x" * F.MAX_CHARS
        self.assertEqual(F.truncate_for_prompt(t), t)

    def test_truncate_keeps_keyword_windows(self):
        filler = "lorem ipsum dolor sit amet. " * 2000
        text = filler + "The council passed a MORATORIUM on data centers." + filler + "the end"
        out = F.truncate_for_prompt(text)
        self.assertLessEqual(len(out), F.MAX_CHARS)
        self.assertIn("MORATORIUM", out)
        self.assertLess(len(out), len(text))

    def test_truncate_without_keywords_takes_head(self):
        self.assertEqual(F.truncate_for_prompt("z" * 30000), "z" * F.MAX_CHARS)

    def test_ban_keyword_not_matched_inside_words(self):
        self.assertIsNone(F._KW.search("urban banner bank"))
        self.assertIsNotNone(F._KW.search("a ban on mining"))

    def test_pdf_branch_with_stub_extractor(self):
        op = Opener(FakeResp(b"%PDF-1.4 fake", "application/pdf"))
        p = F.fetch("https://x.test/o.pdf", opener=op, pdf_extractor=lambda b: "Ordinance moratorium text")
        self.assertEqual((p.error, p.text), ("", "Ordinance moratorium text"))

    def test_pdf_detected_by_magic_bytes(self):
        op = Opener(FakeResp(b"%PDF-1.7 x", "application/octet-stream"))
        p = F.fetch("https://x.test/o", opener=op, pdf_extractor=lambda b: "from pdf")
        self.assertEqual(p.text, "from pdf")

    def test_pdf_unsupported_when_pypdf_missing(self):
        def missing(_):
            raise F.PdfUnsupported
        p = F.fetch("https://x.test/o.pdf", opener=Opener(FakeResp(b"%PDF-1.4", "application/pdf")),
                    pdf_extractor=missing)
        self.assertEqual((p.error, p.text), ("pdf_unsupported", ""))

    def test_pypdf_extract_raises_unsupported_without_pypdf(self):
        try:
            import pypdf  # noqa: F401
        except ImportError:
            with self.assertRaises(F.PdfUnsupported):
                F.pypdf_extract(b"%PDF-1.4")

    def test_fixture_fetcher(self):
        with tempfile.TemporaryDirectory() as d:
            pages = Path(d) / "pages"
            pages.mkdir()
            u = "https://x.test/a"
            (pages / f"{F.url_key(u)}.html").write_bytes((FIX / "page.html").read_bytes())
            ff = F.FixtureFetcher(d)
            self.assertIn("180-day", ff(u).text)
            self.assertEqual(ff("https://x.test/none").error, "http_404")

    def test_fetch_many_preserves_order(self):
        import time

        def slow(url):
            time.sleep(0.05 if url.endswith("0") else 0)
            return F.Page(url, url, 200, "text/plain", url)

        urls = [f"https://x.test/{i}" for i in range(10)]
        self.assertEqual([p.url for p in F.fetch_many(urls, slow, workers=4)], urls)


SCHEMA = {"type": "object", "properties": {"items": {"type": "array"}}, "required": ["items"]}


def anth_client(*script):
    op = Opener(*script)
    return L.AnthropicClient("SECRET", opener=op, sleep=lambda s: None), op


class AnthropicTests(unittest.TestCase):
    def fixture(self):
        return (FIX / "anthropic_response.json").read_bytes()

    def test_request_shape(self):
        c, op = anth_client(FakeResp(self.fixture(), "application/json"))
        c.complete_json("SYS", "USER", SCHEMA, "claude-sonnet-5-5", 2000)
        req = op.requests[0][0]
        body = json.loads(req.data)
        self.assertEqual(req.full_url, "https://api.anthropic.com/v1/messages")
        self.assertEqual(req.get_header("X-api-key"), "SECRET")
        self.assertEqual(req.get_header("Anthropic-version"), "2023-06-01")
        self.assertEqual(body["system"], [{"type": "text", "text": "SYS", "cache_control": {"type": "ephemeral"}}])
        self.assertEqual(body["messages"], [{"role": "user", "content": "USER"}])
        self.assertEqual(body["output_config"]["effort"], "low")
        self.assertEqual(body["output_config"]["format"], {"type": "json_schema", "schema": SCHEMA})
        self.assertEqual((body["model"], body["max_tokens"]), ("claude-sonnet-5-5", 2000))
        self.assertNotIn("tool_choice", body)
        self.assertNotIn("tools", body)
        self.assertEqual(body["messages"][-1]["role"], "user")  # no assistant prefill
        self.assertNotIn("SECRET", req.data.decode())

    def test_parse_ignores_thinking_and_reads_usage(self):
        c, _ = anth_client(FakeResp(self.fixture(), "application/json"))
        obj, u = c.complete_json("s", "u", SCHEMA, "m", 100)
        self.assertEqual(obj["items"][0]["jurisdiction"], "Springfield")
        self.assertEqual(u, L.Usage(1200, 85, 0, 900))

    def test_refusal_and_max_tokens(self):
        for reason, exc in (("refusal", L.LlmRefusal), ("max_tokens", L.LlmTruncated)):
            raw = json.loads(self.fixture())
            raw["stop_reason"] = reason
            c, _ = anth_client(FakeResp(json.dumps(raw).encode(), "application/json"))
            with self.assertRaises(exc) as cm:
                c.complete_json("s", "u", SCHEMA, "m", 100)
            self.assertEqual(cm.exception.usage, L.Usage(1200, 85, 0, 900))  # still billed

    def test_not_json_carries_usage(self):
        raw = json.loads(self.fixture())
        raw["content"] = [{"type": "text", "text": "not json"}]
        with self.assertRaises(L.LlmError) as cm:
            L.parse_anthropic(raw)
        self.assertEqual(cm.exception.usage, L.Usage(1200, 85, 0, 900))

    def test_retries_529_then_succeeds(self):
        c, op = anth_client(http_error(529), http_error(429), FakeResp(self.fixture(), "application/json"))
        obj, _ = c.complete_json("s", "u", SCHEMA, "m", 100)
        self.assertEqual(len(op.requests), 3)
        self.assertIn("items", obj)

    def test_error_does_not_leak_key(self):
        c, _ = anth_client(http_error(401))
        with self.assertRaises(L.LlmError) as cm:
            c.complete_json("s", "u", SCHEMA, "m", 100)
        self.assertNotIn("SECRET", str(cm.exception))


class LlmRobustnessTests(unittest.TestCase):
    def fixture(self):
        return (FIX / "anthropic_response.json").read_bytes()

    def test_timeout_retried_then_success(self):
        c, op = anth_client(urllib.error.URLError(TimeoutError()), FakeResp(self.fixture(), "application/json"))
        c.complete_json("s", "u", SCHEMA, "m", 100)
        self.assertEqual(len(op.requests), 2)

    def test_four_timeouts_raise_without_key(self):
        for exc in (TimeoutError(), ConnectionResetError(), http.client.RemoteDisconnected("x")):
            c, op = anth_client(exc)
            with self.assertRaises(L.LlmError) as cm:
                c.complete_json("s", "u", SCHEMA, "m", 100)
            self.assertEqual((cm.exception.status, len(op.requests)), (0, 4))
            self.assertNotIn("SECRET", str(cm.exception))

    def test_rate_limit_waits_longer_and_retries_more(self):
        # 2026-10-09: 73 of 246 calls failed on OpenRouter's new-account per-minute limit
        waits = []
        limited = urllib.error.HTTPError("https://x.test/", 429, "err", {"Retry-After": "7"}, None)
        op = Opener(limited, http_error(429), http_error(429), http_error(429), FakeResp(self.fixture(), "application/json"))
        c = L.AnthropicClient("SECRET", opener=op, sleep=waits.append)
        c.complete_json("s", "u", SCHEMA, "m", 100)
        self.assertEqual(len(op.requests), 5)  # more than MAX_RETRIES (3) for a rate limit
        self.assertEqual(waits, [7.0, 20.0, 40.0, 60.0])  # Retry-After first, then 10 * 2**attempt, capped at 60

    def test_rate_limit_gives_up_after_its_own_cap(self):
        op = Opener(*[http_error(429)] * 10)
        c = L.AnthropicClient("SECRET", opener=op, sleep=lambda s: None)
        with self.assertRaises(L.LlmError) as cm:
            c.complete_json("s", "u", SCHEMA, "m", 100)
        self.assertEqual((cm.exception.status, len(op.requests)), (429, L.RATE_LIMIT_RETRIES + 1))

    def test_server_error_keeps_the_short_retry_count(self):
        op = Opener(*[http_error(503)] * 10)
        c = L.AnthropicClient("SECRET", opener=op, sleep=lambda s: None)
        with self.assertRaises(L.LlmError):
            c.complete_json("s", "u", SCHEMA, "m", 100)
        self.assertEqual(len(op.requests), L.MAX_RETRIES + 1)

    def test_401_body_message_included(self):
        body = json.dumps({"type": "error", "error": {"type": "authentication_error", "message": "invalid x-api-key"}}).encode()
        c, _ = anth_client(err_resp(401, body))
        with self.assertRaises(L.LlmError) as cm:
            c.complete_json("s", "u", SCHEMA, "m", 100)
        self.assertEqual(cm.exception.status, 401)
        self.assertIn("authentication_error: invalid x-api-key", str(cm.exception))
        self.assertNotIn("SECRET", str(cm.exception))


class OpenRouterTests(unittest.TestCase):
    def fixture(self):
        return (FIX / "openrouter_response.json").read_bytes()

    def client(self, *script):
        op = Opener(*script)
        return L.OpenRouterClient("SECRET", opener=op, sleep=lambda s: None), op

    def test_request_and_parse(self):
        c, op = self.client(FakeResp(self.fixture(), "application/json"))
        obj, u = c.complete_json("SYS", "USER", SCHEMA, "anthropic/x", 500)
        req = op.requests[0][0]
        body = json.loads(req.data)
        self.assertEqual(req.get_header("Authorization"), "Bearer SECRET")
        self.assertEqual(body["messages"][0], {"role": "system", "content": [
            {"type": "text", "text": "SYS", "cache_control": {"type": "ephemeral"}}]})
        self.assertEqual(body["response_format"]["json_schema"],
                         {"name": "extract", "strict": True, "schema": SCHEMA})
        self.assertEqual(obj["items"][0]["state"], "OH")
        self.assertEqual(u, L.Usage(300, 85, 900, 0))  # prompt_tokens 1200 includes the 900 cached

    def test_fallback_retry_once_on_bad_json(self):
        bad = json.loads(self.fixture())
        bad["choices"][0]["message"]["content"] = "Sure! Here is the result"
        c, op = self.client(FakeResp(json.dumps(bad).encode(), "application/json"),
                            FakeResp(self.fixture(), "application/json"))
        obj, u = c.complete_json("SYS", "USER", SCHEMA, "m", 500)
        self.assertEqual(len(op.requests), 2)
        second = json.loads(op.requests[1][0].data)
        self.assertTrue(second["messages"][1]["content"].endswith("Return only JSON matching the schema"))
        self.assertIn("items", obj)
        self.assertEqual(u.input_tokens, 600)  # both calls tallied, cached tokens excluded

    def test_400_retries_without_response_format(self):
        c, op = self.client(http_error(400), FakeResp(self.fixture(), "application/json"))
        obj, u = c.complete_json("SYS", "USER", SCHEMA, "m", 500)
        self.assertEqual(len(op.requests), 2)
        first, second = (json.loads(r[0].data) for r in op.requests)
        self.assertIn("response_format", first)
        self.assertNotIn("response_format", second)
        self.assertTrue(second["messages"][1]["content"].endswith(L.JSON_ONLY_NOTE))
        self.assertIn("items", obj)

    def test_400_path_validates_schema(self):
        bad = json.loads(self.fixture())
        bad["choices"][0]["message"]["content"] = '{"other": 1}'
        c, _ = self.client(http_error(400), FakeResp(json.dumps(bad).encode(), "application/json"))
        with self.assertRaises(L.LlmError) as cm:
            c.complete_json("s", "u", SCHEMA, "m", 500)
        self.assertIn("items", str(cm.exception))

    def test_second_400_raises(self):
        c, op = self.client(http_error(400))
        with self.assertRaises(L.LlmError) as cm:
            c.complete_json("s", "u", SCHEMA, "m", 500)
        self.assertEqual((cm.exception.status, len(op.requests)), (400, 2))

    def test_non_400_not_downgraded(self):
        c, op = self.client(http_error(401))
        with self.assertRaises(L.LlmError):
            c.complete_json("s", "u", SCHEMA, "m", 500)
        self.assertEqual(len(op.requests), 1)

    def test_check_schema(self):
        sch = {"type": "object", "required": ["items", "n"],
               "properties": {"items": {"type": "array", "items": {"type": "object", "required": ["a"]}},
                              "n": {"type": "integer"}}}
        L.check_schema({"items": [{"a": 1}], "n": 2}, sch)
        for bad in ({"items": [{"b": 1}], "n": 2}, {"items": [], "n": True}, {"items": {}, "n": 1}, {"n": 1}, []):
            with self.assertRaises(L.LlmError, msg=str(bad)):
                L.check_schema(bad, sch)

    def test_second_bad_json_raises(self):
        bad = json.loads(self.fixture())
        bad["choices"][0]["message"]["content"] = "nope"
        c, op = self.client(FakeResp(json.dumps(bad).encode(), "application/json"),
                            FakeResp(json.dumps(bad).encode(), "application/json"))
        with self.assertRaises(L.LlmError) as cm:
            c.complete_json("s", "u", SCHEMA, "m", 500)
        self.assertEqual(len(op.requests), 2)
        self.assertEqual(cm.exception.usage, L.Usage(600, 170, 1800, 0))  # both billed calls

    def test_refusal_and_truncation_carry_usage(self):
        for edit, exc in ((lambda r: r["choices"][0]["message"].update(refusal="no"), L.LlmRefusal),
                          (lambda r: r["choices"][0].update(finish_reason="length"), L.LlmTruncated),
                          (lambda r: r.update(choices=[]), L.LlmError)):
            raw = json.loads(self.fixture())
            edit(raw)
            with self.assertRaises(exc) as cm:
                L.parse_openrouter(raw)
            self.assertEqual(cm.exception.usage, L.Usage(300, 85, 900, 0))


class StubAndFactoryTests(unittest.TestCase):
    def test_stub_default_and_canned_deterministic(self):
        with tempfile.TemporaryDirectory() as d:
            (Path(d) / "llm").mkdir()
            (Path(d) / "llm" / f"{L.stub_key('m', 'u1')}.json").write_text('{"items": [1]}')
            s = L.StubClient(d)
            self.assertEqual(s.complete_json("s", "u1", SCHEMA, "m", 1), ({"items": [1]}, L.Usage()))
            self.assertEqual(s.complete_json("s", "u1", SCHEMA, "m", 1), s.complete_json("s", "u1", SCHEMA, "m", 1))
            self.assertEqual(s.complete_json("s", "other", SCHEMA, "m", 1)[0], {"items": []})
        self.assertEqual(L.StubClient().complete_json("s", "u", SCHEMA, "m", 1)[0], {"items": []})

    def test_stub_refusal_carries_usage(self):
        with tempfile.TemporaryDirectory() as d:
            (Path(d) / "llm").mkdir()
            (Path(d) / "llm" / f"{L.stub_key('m', 'u')}.json").write_text('{"_refusal": true, "_usage": {"input_tokens": 7}}')
            with self.assertRaises(L.LlmRefusal) as cm:
                L.StubClient(d).complete_json("s", "u", SCHEMA, "m", 1)
            self.assertEqual(cm.exception.usage, L.Usage(7))

    def test_llm_error_signature(self):
        e = L.LlmError("x", 400)
        self.assertEqual((e.status, e.usage), (400, None))

    def test_make_client_selection(self):
        both = {"ANTHROPIC_API_KEY": "a", "OPENROUTER_API_KEY": "b"}
        self.assertIsInstance(L.make_client(both), L.AnthropicClient)
        self.assertIsInstance(L.make_client({"OPENROUTER_API_KEY": "b"}), L.OpenRouterClient)
        self.assertIsInstance(L.make_client({}), L.StubClient)
        self.assertIsInstance(L.make_client({"ANTHROPIC_API_KEY": ""}), L.StubClient)

    def test_usage_tally_and_cost(self):
        t = L.UsageTally()
        t.add("m", L.Usage(1_000_000, 100_000, 500_000, 0))
        t.add("m", L.Usage(1_000_000, 0, 0, 0))
        self.assertEqual(t.total(), L.Usage(2_000_000, 100_000, 500_000, 0))
        self.assertEqual(t.calls["m"], 2)
        cost = t.est_cost({"m": {"input": 3.0, "output": 15.0, "cache_read": 0.3}})
        self.assertAlmostEqual(cost, 6.0 + 1.5 + 0.15)
        self.assertEqual(t.est_cost({}), 0.0)

    def test_opus_cost_from_price_table(self):
        t = L.UsageTally()
        t.add(config.REVIEW_MODEL, L.Usage(1_000_000, 1_000_000, 1_000_000, 1_000_000))
        self.assertAlmostEqual(t.est_cost(config.PRICES), 4.0 + 20.0 + 0.2 + 5.0)
        self.assertAlmostEqual(t.est_cost(), 29.2)
        s = L.UsageTally()
        s.add(config.ESCALATION_MODEL, L.Usage(1_000_000, 1_000_000, 0, 0))
        self.assertAlmostEqual(s.est_cost(), 12.0)

    def test_tally_thread_safe(self):
        t = L.UsageTally()
        ts = [threading.Thread(target=lambda: [t.add("m", L.Usage(1, 1)) for _ in range(500)]) for _ in range(8)]
        [x.start() for x in ts]
        [x.join() for x in ts]
        self.assertEqual((t.calls["m"], t.total().input_tokens), (4000, 4000))

    def test_make_client_provider(self):
        both = {"ANTHROPIC_API_KEY": "a", "OPENROUTER_API_KEY": "b"}
        self.assertIsInstance(L.make_client(both, provider="openrouter"), L.OpenRouterClient)
        self.assertIsInstance(L.make_client({"ANTHROPIC_API_KEY": "a"}, provider="openrouter"), L.StubClient)

    def test_probe_models_from_config(self):
        self.assertIs(L.PROBE_MODELS, config.PROBE_MODELS)

    def test_probe_without_key_prints_no_key(self):
        buf = io.StringIO()
        from contextlib import redirect_stdout
        with redirect_stdout(buf), tempfile.TemporaryDirectory() as d:
            self.assertEqual(L.probe(Path(d), {}), 0)
        self.assertEqual(buf.getvalue().strip(), "no key")


if __name__ == "__main__":
    unittest.main()
