"""Page fetching for the weekly data center moratorium refresh.

Role: `fetch(url)` returns a `Page` with the FULL plain text (HTML via stdlib
`html.parser`, PDF via a lazily imported `pypdf`), read up to 5 MB within a 30 s
deadline; only http(s) URLs are fetched. `Page.text` is what quote checks run
against; `truncate_for_prompt` (20k characters around keyword windows) is for
building the model prompt only. `Page.links` holds the page's outbound links,
absolute and in page order: `<a href>` outside the dropped tags, plus bare
http(s) URLs found in the text (how PDFs and JSON cite). Seed citations are
checked against it. `FixtureFetcher` replays saved pages; `fetch_many` runs any
fetcher 4 at a time, preserving order.

Dependencies: stdlib only; `pypdf` is optional and imported on first PDF.
"""
from __future__ import annotations

import hashlib
import io
import os
import re
import socket
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from html.parser import HTMLParser
from pathlib import Path
from typing import Callable

REPO_URL = "https://github.com/BenHutchinsWPP/TransmissionMap"
TIMEOUT_S = 15
DEADLINE_S = 30
CHUNK = 64 * 1024
MAX_BYTES = 5 * 1024 * 1024
MAX_CHARS = 20_000
WINDOW = 800
MAX_PDF_PAGES = 40
MAX_LINKS = 400
MAX_ANCHOR = 80
_BARE_URL = re.compile(r"https?://[^\s<>\"'`]+", re.I)
KEYWORDS = ("moratorium", "data center", "ban", "prohibit", "pause", "ordinance",
            "cryptocurrency", "large load")


def user_agent(env=None) -> str:
    """UA with a contact (SEC EDGAR requires one): env DCM_CONTACT, default the repo URL."""
    contact = (os.environ if env is None else env).get("DCM_CONTACT") or REPO_URL
    return f"TransmissionMap-moratorium-refresh/1 (+{contact})"


@dataclass(frozen=True)
class Page:
    url: str
    final_url: str
    status: int
    content_type: str
    text: str
    error: str = ""
    truncated: bool = False  # the 5 MB read cap was hit
    kind: str = ""  # "pdf" | "html" | "text", sniffed from the bytes as well as the content type
    links: tuple[tuple[str, str], ...] = ()  # (absolute http(s) URL, anchor text <= 80 chars), deduped, <= 400


class PdfUnsupported(Exception):
    pass


def pypdf_extract(data: bytes) -> str:
    try:
        import pypdf
    except ImportError:
        raise PdfUnsupported from None
    reader = pypdf.PdfReader(io.BytesIO(data))
    return "\n\n".join((p.extract_text() or "") for p in reader.pages[:MAX_PDF_PAGES])


_SKIP = {"script", "style", "nav", "footer", "noscript"}
_SKIP_MIN = {"script", "style", "noscript"}
_BLOCK = {"p", "div", "br", "li", "ul", "ol", "tr", "table", "section", "article", "main", "aside",
          "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "pre", "hr", "form",
          "td", "th", "dt", "dd", "caption", "figcaption"}


class _TextParser(HTMLParser):
    def __init__(self, skip=_SKIP) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self.links: list[tuple[str, str]] = []  # (raw href, anchor text) outside skipped tags
        self._skip_tags = skip
        self._depth: dict[str, int] = {}  # open skipped tags, counted per tag
        self._href: str | None = None
        self._anchor: list[str] = []

    def _skipping(self) -> bool:
        return any(self._depth.values())

    def _close_link(self):
        if self._href is not None:
            self.links.append((self._href, " ".join("".join(self._anchor).split())))
            self._href, self._anchor = None, []

    def handle_starttag(self, tag, attrs):
        if tag in self._skip_tags:
            self._depth[tag] = self._depth.get(tag, 0) + 1
        elif tag == "a" and not self._skipping():
            self._close_link()
            href = dict(attrs).get("href")
            if href:
                self._href = href.strip()
        elif tag in _BLOCK:
            self.parts.append("\n")

    def handle_endtag(self, tag):
        if tag in self._skip_tags:
            self._depth[tag] = max(0, self._depth.get(tag, 0) - 1)
        elif tag == "a":
            self._close_link()
        elif tag in _BLOCK:
            self.parts.append("\n")

    def handle_data(self, data):
        if not self._skipping():
            self.parts.append(data)
            if self._href is not None:
                self._anchor.append(data)


def _parse_html(html: str, skip) -> tuple[str, list[tuple[str, str]]]:
    p = _TextParser(skip)
    p.feed(html)
    p.close()
    p._close_link()
    lines = (re.sub(r"[ \t\r\f\v\u00a0]+", " ", ln).strip() for ln in "".join(p.parts).split("\n"))
    return re.sub(r"\n{2,}", "\n", "\n".join(ln for ln in lines if ln)), p.links


def _html_text_links(html: str) -> tuple[str, list[tuple[str, str]]]:
    text, links = _parse_html(html, _SKIP)
    if len(text) < 200:
        full = _parse_html(html, _SKIP_MIN)
        if len(full[0]) > 1000:
            return full
    return text, links


def html_to_text(html: str) -> str:
    """Visible text with block breaks. Drops script/style/nav/footer/noscript; when that leaves
    almost nothing (an unclosed <nav> swallowing the page) the page is re-read dropping only
    script/style/noscript."""
    return _html_text_links(html)[0]


def page_links(final_url: str, hrefs, text: str) -> tuple[tuple[str, str], ...]:
    """Absolute http(s) links: each href resolved against `final_url` (fragment dropped), then bare
    URLs in `text`; deduplicated in order, at most MAX_LINKS."""
    out: dict[str, str] = {}
    bare = ((m.group(0).rstrip(".,;:!?)]}"), "") for m in _BARE_URL.finditer(text))
    for href, anchor in [*hrefs, *bare]:
        if len(out) >= MAX_LINKS:
            break
        try:
            u = urllib.parse.urldefrag(urllib.parse.urljoin(final_url, href))[0]
        except ValueError:
            continue
        if _is_web_url(u) and u not in out:
            out[u] = anchor[:MAX_ANCHOR]
    return tuple(out.items())


def _keyword_re() -> re.Pattern:
    alts = []
    for k in KEYWORDS:
        body = re.escape(k).replace(r"\ ", r"\s+")
        alts.append(body + (r"(?:s|ned|ning)?\b" if k == "ban" else r"\w*"))
    return re.compile(r"\b(?:" + "|".join(alts) + ")", re.I)


_KW = _keyword_re()


def truncate_for_prompt(text: str, limit: int = MAX_CHARS, window: int = WINDOW) -> str:
    """Prompt text only, never for quote checks: the whole text when it fits, otherwise merged
    keyword windows in page order, up to `limit`."""
    if len(text) <= limit:
        return text
    spans: list[list[int]] = []
    for m in _KW.finditer(text):
        a, b = max(0, m.start() - window), min(len(text), m.end() + window)
        if spans and a <= spans[-1][1]:
            spans[-1][1] = max(spans[-1][1], b)
        else:
            spans.append([a, b])
    if not spans:
        return text[:limit]
    out, used = [], 0
    for a, b in spans:
        room = limit - used
        if room <= 0:
            break
        out.append(text[a:min(b, a + room)])
        used += len(out[-1]) + 1
    return "\n".join(out)[:limit]


def _decode(data: bytes, charset: str | None) -> str:
    try:
        return data.decode(charset or "utf-8", errors="replace")
    except LookupError:
        return data.decode("utf-8", errors="replace")


def _looks_html(data: bytes) -> bool:
    head = data[:512].lstrip().lower()
    return head.startswith((b"<!doctype html", b"<html", b"<?xml"))


def _page_from_bytes(url: str, final_url: str, status: int, ctype: str, data: bytes,
                     charset: str | None, pdf_extractor: Callable[[bytes], str],
                     truncated: bool = False) -> Page:
    lc = ctype.lower()
    is_pdf = "application/pdf" in lc or data[:5] == b"%PDF-"
    is_html = not is_pdf and ("html" in lc or "xml" in lc or not lc or _looks_html(data))
    if not (is_pdf or is_html or lc.startswith("text/") or "json" in lc):
        return Page(url, final_url, status, ctype, "", "unsupported_type", truncated)
    hrefs: list[tuple[str, str]] = []
    try:
        if is_pdf:
            text = pdf_extractor(data)
        elif is_html:
            text, hrefs = _html_text_links(_decode(data, charset))
        else:
            text = _decode(data, charset)
    except PdfUnsupported:
        return Page(url, final_url, status, ctype, "", "pdf_unsupported", truncated)
    except Exception:
        return Page(url, final_url, status, ctype, "", "pdf_error" if is_pdf else "parse_error", truncated)
    return Page(url, final_url, status, ctype, text, "", truncated,
                "pdf" if is_pdf else "html" if is_html else "text", page_links(final_url, hrefs, text))


def _is_web_url(url: str) -> bool:
    return urllib.parse.urlsplit(url.strip()).scheme.lower() in ("http", "https")


def _read_capped(resp, clock: Callable[[], float]) -> tuple[bytes, bool]:
    """Read up to MAX_BYTES in chunks within DEADLINE_S; (bytes, cap_hit). Raises TimeoutError."""
    deadline = clock() + DEADLINE_S
    buf = bytearray()
    while len(buf) <= MAX_BYTES:
        if clock() > deadline:
            raise TimeoutError
        chunk = resp.read(min(CHUNK, MAX_BYTES + 1 - len(buf)))
        if not chunk:
            break
        buf += chunk
    return bytes(buf[:MAX_BYTES]), len(buf) > MAX_BYTES


def fetch(url: str, opener: Callable | None = None,
          pdf_extractor: Callable[[bytes], str] = pypdf_extract,
          clock: Callable[[], float] = time.monotonic) -> Page:
    if not _is_web_url(url):
        return Page(url, url, 0, "", "", "bad_scheme")
    req = urllib.request.Request(url, headers={
        "User-Agent": user_agent(),
        "Accept": "text/html,application/xhtml+xml,application/pdf;q=0.9,*/*;q=0.5",
    })
    try:
        with (opener or urllib.request.urlopen)(req, timeout=TIMEOUT_S) as resp:
            data, capped = _read_capped(resp, clock)
            ctype = resp.headers.get("Content-Type", "") or ""
            charset = resp.headers.get_content_charset() if resp.headers else None
            status = getattr(resp, "status", 200)
            final_url = resp.geturl() if hasattr(resp, "geturl") else url
    except urllib.error.HTTPError as e:
        e.close()
        return Page(url, url, e.code, "", "", f"http_{e.code}")
    except (socket.timeout, TimeoutError):
        return Page(url, url, 0, "", "", "timeout")
    except urllib.error.URLError as e:
        kind = "timeout" if isinstance(e.reason, (socket.timeout, TimeoutError)) else "url_error"
        return Page(url, url, 0, "", "", kind)
    except Exception as e:
        return Page(url, url, 0, "", "", f"error_{type(e).__name__}")
    if not _is_web_url(final_url):
        return Page(url, url, 0, "", "", "bad_scheme")
    return _page_from_bytes(url, final_url, status, ctype, data, charset, pdf_extractor, capped)


def url_key(url: str) -> str:
    return hashlib.sha1(url.encode()).hexdigest()


class FixtureFetcher:
    """Replays <dir>/pages/<sha1(url)>.{html,pdf,txt}; a missing file is a 404."""

    def __init__(self, directory: str | Path, pdf_extractor: Callable[[bytes], str] = pypdf_extract):
        self.dir = Path(directory)
        self._pdf = pdf_extractor

    def __call__(self, url: str) -> Page:
        if not _is_web_url(url):
            return Page(url, url, 0, "", "", "bad_scheme")
        for ext, ctype in (("html", "text/html"), ("pdf", "application/pdf"), ("txt", "text/plain")):
            path = self.dir / "pages" / f"{url_key(url)}.{ext}"
            if path.exists():
                return _page_from_bytes(url, url, 200, ctype, path.read_bytes(), "utf-8", self._pdf)
        return Page(url, url, 404, "", "", "http_404")


def fetch_many(urls: list[str], fetcher: Callable[[str], Page] = fetch, workers: int = 4) -> list[Page]:
    with ThreadPoolExecutor(max_workers=workers) as pool:
        return list(pool.map(fetcher, urls))
