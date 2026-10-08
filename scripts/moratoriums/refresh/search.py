"""Search providers for the weekly data center moratorium refresh.

Role: turn a query text (plus a freshness window) into deduplicated `Hit`s.
`BraveSearch` calls the Brave Search API (web or news endpoint, chosen per
request); `FixtureSearch` replays saved responses so dry runs and tests need no
key and no network. Both satisfy `SearchProvider` and count `requests`.
`BraveSearch` stops hard at `max_requests` (retries included).

Dependencies: stdlib only. Config values (count, freshness, caps) arrive as
arguments; nothing here imports `config.py`.
"""
from __future__ import annotations

import hashlib
import http.client
import json
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Protocol

BRAVE_URLS = {
    "web": "https://api.search.brave.com/res/v1/web/search",
    "news": "https://api.search.brave.com/res/v1/news/search",
}
RETRY_CODES = {429, 500, 502, 503, 504}
MAX_RETRIES = 3
NETWORK_ERRORS = (urllib.error.URLError, TimeoutError, ConnectionResetError, http.client.RemoteDisconnected)


class SearchError(RuntimeError):
    """A failed search request. `status` is the HTTP status, or 0 for a network failure."""

    def __init__(self, message: str, status: int = 0):
        super().__init__(message)
        self.status = status


class SearchBudgetExhausted(SearchError):
    pass


@dataclass(frozen=True)
class Hit:
    url: str
    title: str
    snippet: str
    age: str
    query_id: str


class SearchProvider(Protocol):
    requests: int

    def search(self, query: str, freshness: str | None = None, query_id: str = "",
               endpoint: str = "news") -> list[Hit]: ...


def normalize_url(url: str) -> str:
    """Key for deduplication: http and https alike, lowercase host, no www/fragment/utm params/trailing slash."""
    p = urllib.parse.urlsplit(url.strip())
    host = p.netloc.lower().removeprefix("www.")
    query = urllib.parse.urlencode(
        sorted((k, v) for k, v in urllib.parse.parse_qsl(p.query) if not k.lower().startswith("utm_"))
    )
    return urllib.parse.urlunsplit(({"http": "https"}.get(p.scheme.lower(), p.scheme.lower()), host, p.path.rstrip("/"), query, ""))


def dedupe(hits: list[Hit]) -> list[Hit]:
    seen: set[str] = set()
    out = []
    for h in hits:
        key = normalize_url(h.url)
        if key not in seen:
            seen.add(key)
            out.append(h)
    return out


def parse_results(payload: dict, query_id: str) -> list[Hit]:
    """Brave web responses nest results under `web`; news responses carry them at the top."""
    rows = (payload.get("web") or {}).get("results") or payload.get("results") or []
    hits = []
    for r in rows:
        url = r.get("url")
        if not url:
            continue
        hits.append(Hit(
            url=url,
            title=r.get("title") or "",
            snippet=r.get("description") or "",
            age=r.get("age") or r.get("page_age") or "",
            query_id=query_id,
        ))
    return dedupe(hits)


def _error_detail(body: bytes, secret: str) -> str:
    """The API's JSON error type/message from an error body ("" when there is none)."""
    try:
        err = json.loads(body.decode("utf-8", "replace"))
    except ValueError:
        return ""
    if not isinstance(err, dict):
        return ""
    inner = err.get("error")
    if isinstance(inner, dict):
        parts = [inner.get("code") or inner.get("type"), inner.get("detail") or inner.get("message")]
    else:
        parts = [err.get("type"), inner if isinstance(inner, str) else err.get("message")]
    text = ": ".join(str(x) for x in parts if x)
    return text.replace(secret, "***")[:300] if secret else text[:300]


class BraveSearch:
    def __init__(self, api_key: str, count: int = 20, max_requests: int | None = None,
                 opener: Callable | None = None, sleep: Callable[[float], None] = time.sleep):
        self._key = api_key
        self.count = count
        self.max_requests = max_requests
        self.requests = 0
        self._lock = threading.Lock()
        self._opener = opener
        self._sleep = sleep

    def _count_request(self) -> None:
        with self._lock:
            if self.max_requests is not None and self.requests >= self.max_requests:
                raise SearchBudgetExhausted(f"search request budget of {self.max_requests} exhausted")
            self.requests += 1

    def search(self, query: str, freshness: str | None = None, query_id: str = "",
               endpoint: str = "news") -> list[Hit]:
        if endpoint not in BRAVE_URLS:
            raise ValueError(f"endpoint must be one of {sorted(BRAVE_URLS)}")
        params = {"q": query, "count": self.count, "country": "us", "search_lang": "en"}
        if freshness:
            params["freshness"] = freshness
        url = BRAVE_URLS[endpoint] + "?" + urllib.parse.urlencode(params)
        req = urllib.request.Request(url, headers={
            "Accept": "application/json",
            "X-Subscription-Token": self._key,
        })
        for attempt in range(MAX_RETRIES + 1):
            self._count_request()
            try:
                with (self._opener or urllib.request.urlopen)(req, timeout=30) as resp:
                    return parse_results(json.loads(resp.read().decode("utf-8")), query_id)
            except urllib.error.HTTPError as e:
                try:
                    detail = _error_detail(e.read(4000), self._key)
                except Exception:
                    detail = ""
                finally:
                    e.close()
                if e.code not in RETRY_CODES or attempt == MAX_RETRIES:
                    raise SearchError(f"brave search failed: HTTP {e.code}" + (f" ({detail})" if detail else ""),
                                      e.code) from None
            except NETWORK_ERRORS as e:
                if attempt == MAX_RETRIES:
                    raise SearchError(f"brave search failed: network error {type(e).__name__}", 0) from None
            except json.JSONDecodeError:
                raise SearchError("brave search failed: response is not JSON", 200) from None
            self._sleep(2.0 ** attempt)
        raise SearchError("unreachable")


def fixture_key(query: str, freshness: str | None, endpoint: str = "news") -> str:
    return hashlib.sha1(f"{query}|{freshness or ''}|{endpoint}".encode()).hexdigest()


class FixtureSearch:
    """Replays <dir>/search/<sha1(query|freshness|endpoint)>.json (Brave response shape); unknown queries return no hits."""

    def __init__(self, directory: str | Path):
        self.dir = Path(directory)
        self.requests = 0
        self._lock = threading.Lock()

    def search(self, query: str, freshness: str | None = None, query_id: str = "",
               endpoint: str = "news") -> list[Hit]:
        with self._lock:
            self.requests += 1
        path = self.dir / "search" / f"{fixture_key(query, freshness, endpoint)}.json"
        if not path.exists():
            return []
        return parse_results(json.loads(path.read_text(encoding="utf-8")), query_id)
