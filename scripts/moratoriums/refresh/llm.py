"""LLM clients for the weekly data center moratorium refresh.

Role: one interface, `complete_json(system, user, schema, model, max_tokens)
-> (obj, Usage)`, over Anthropic Messages (structured outputs), OpenRouter
chat completions, and a deterministic `StubClient` for dry runs. The model
only fills a JSON schema; no tools are offered. `make_client(env)` picks
ANTHROPIC_API_KEY, then OPENROUTER_API_KEY, else the stub.

`python -m moratoriums.refresh.llm --probe [--provider P] --out DIR` sends one
tiny real request and saves the raw response as a fixture for the parser tests.

Dependencies: config.py (prices, probe models); stdlib otherwise. Keys and
request headers are never logged or included in error messages; an `LlmError`
carries the HTTP `status` (0 for a network failure), the API's own error
type/message, and the `usage` billed for the failed call when the response
reported one (a refusal, a truncation or unparseable JSON is still billed).
"""
from __future__ import annotations

import argparse
import hashlib
import http.client
import json
import os
import sys
import threading
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Mapping, Protocol

from .config import PRICES, PROBE_MODELS

ANTHROPIC_URL = "https://api.anthropic.com/v1/messages"
OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"
RETRY_CODES = {429, 500, 502, 503, 504, 529}
MAX_RETRIES = 3
# A rate limit (429) is retried more often and waits longer than a server or network error: the
# API's Retry-After when it sends one, else 10, 20, 40, 60, 60 seconds. New OpenRouter accounts
# have a low per-minute limit.
RATE_LIMIT_RETRIES = 5
RATE_LIMIT_WAIT_MAX = 60
JSON_ONLY_NOTE = "\n\nReturn only JSON matching the schema"
NETWORK_ERRORS = (urllib.error.URLError, TimeoutError, ConnectionResetError, http.client.RemoteDisconnected)


class LlmError(Exception):
    def __init__(self, message: str, status: int = 0, usage: "Usage | None" = None):
        super().__init__(message)
        self.status = status  # HTTP status; 0 for a network failure or a non-HTTP problem
        self.usage = usage  # tokens billed for the failed call, when the response said


class LlmRefusal(LlmError):
    pass


class LlmTruncated(LlmError):
    pass


@dataclass(frozen=True)
class Usage:
    input_tokens: int = 0
    output_tokens: int = 0
    cache_read_input_tokens: int = 0
    cache_creation_input_tokens: int = 0

    def __add__(self, o: "Usage") -> "Usage":
        return Usage(*(a + b for a, b in zip(self._t(), o._t())))

    def _t(self):
        return (self.input_tokens, self.output_tokens,
                self.cache_read_input_tokens, self.cache_creation_input_tokens)


class LlmClient(Protocol):
    def complete_json(self, system: str, user: str, schema: dict, model: str,
                      max_tokens: int) -> tuple[dict, Usage]: ...


def price_for(model: str, prices: Mapping[str, Mapping[str, float]]) -> tuple[Mapping[str, float] | None, str]:
    """(price, family): the model's own entry (family ""), else the first priced model of the same
    family named in its id ("haiku", "sonnet" or "opus"), else (None, "")."""
    own = prices.get(model)
    if own:
        return own, ""
    low = model.lower()
    for family in ("opus", "sonnet", "haiku"):
        if family in low:
            for key, p in prices.items():
                if family in key.lower() and p:
                    return p, family
    return None, ""


class UsageTally:
    def __init__(self) -> None:
        self.by_model: dict[str, Usage] = {}
        self.calls: dict[str, int] = {}
        self._lock = threading.Lock()

    def add(self, model: str, usage: Usage) -> None:
        with self._lock:
            self.by_model[model] = self.by_model.get(model, Usage()) + usage
            self.calls[model] = self.calls.get(model, 0) + 1

    def total(self) -> Usage:
        return sum(self.by_model.values(), Usage())

    def price_notes(self, prices: Mapping[str, Mapping[str, float]] = PRICES) -> dict[str, str]:
        """Models billed at a family price rather than their own: {model: "haiku"|"sonnet"|"opus"}; a model with
        no family match is {model: "unpriced"} and adds nothing to `est_cost`."""
        out = {}
        for model in self.by_model:
            p, family = price_for(model, prices)
            if p is None:
                out[model] = "unpriced"
            elif family:
                out[model] = family
        return out

    def est_cost(self, prices: Mapping[str, Mapping[str, float]] = PRICES) -> float:
        """USD from per-million-token prices: {model: {input, output, cache_read?, cache_write?}}.
        `input_tokens` excludes cache reads and writes, which are priced separately. A model id with
        no entry (an OpenRouter slug or an env override) is priced as its family, see `price_for`."""
        cost = 0.0
        for model, u in self.by_model.items():
            p, _ = price_for(model, prices)
            if not p:
                continue
            cost += (u.input_tokens * p["input"]
                     + u.output_tokens * p["output"]
                     + u.cache_read_input_tokens * p.get("cache_read", p["input"] * 0.1)
                     + u.cache_creation_input_tokens * p.get("cache_write", p["input"] * 1.25)) / 1e6
        return round(cost, 6)


def _error_detail(body: bytes) -> str:
    """The API's JSON error type/message from an error body ("" when there is none)."""
    try:
        err = json.loads(body.decode("utf-8", "replace"))
    except ValueError:
        return ""
    inner = err.get("error") if isinstance(err, dict) else None
    if isinstance(inner, dict):
        parts = [inner.get("type") or inner.get("code"), inner.get("message")]
    else:
        parts = [inner] if isinstance(inner, str) else []
    return ": ".join(str(x) for x in parts if x)[:300]


def _retry_after(headers) -> float:
    """Seconds from a Retry-After header (capped at RATE_LIMIT_WAIT_MAX), 0 when absent or not a number."""
    try:
        return min(float(RATE_LIMIT_WAIT_MAX), max(0.0, float((headers or {}).get("Retry-After") or 0)))
    except (TypeError, ValueError):
        return 0.0


def _post_json(url: str, headers: dict, body: dict, opener: Callable | None,
               sleep: Callable[[float], None]) -> dict:
    data = json.dumps(body).encode()
    host = url.split("/")[2]
    for attempt in range(RATE_LIMIT_RETRIES + 1):
        req = urllib.request.Request(url, data=data, headers=headers, method="POST")
        try:
            with (opener or urllib.request.urlopen)(req, timeout=120) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except json.JSONDecodeError:
            raise LlmError("response body is not JSON") from None
        except urllib.error.HTTPError as e:
            try:
                detail = _error_detail(e.read(4000))
            except Exception:
                detail = ""
            finally:
                e.close()
            last = attempt >= (RATE_LIMIT_RETRIES if e.code == 429 else MAX_RETRIES)
            if e.code not in RETRY_CODES or last:
                raise LlmError(f"HTTP {e.code} from {host}" + (f" ({detail})" if detail else ""), e.code) from None
            if e.code == 429:
                sleep(_retry_after(e.headers) or min(RATE_LIMIT_WAIT_MAX, 10.0 * 2 ** attempt))
                continue
        except NETWORK_ERRORS as e:
            if attempt >= MAX_RETRIES:
                raise LlmError(f"network error {type(e).__name__} from {host}", 0) from None
        sleep(2.0 ** attempt)
    raise LlmError("unreachable")


class AnthropicClient:
    def __init__(self, api_key: str, opener: Callable | None = None,
                 sleep: Callable[[float], None] = time.sleep):
        self._key = api_key
        self._opener = opener
        self._sleep = sleep
        self.last_raw: dict | None = None

    def build_body(self, system: str, user: str, schema: dict, model: str, max_tokens: int) -> dict:
        # Structured outputs: no assistant prefill and no forced tool_choice (both 400 on these models).
        return {
            "model": model,
            "max_tokens": max_tokens,
            "system": [{"type": "text", "text": system, "cache_control": {"type": "ephemeral"}}],
            "messages": [{"role": "user", "content": user}],
            "output_config": {"format": {"type": "json_schema", "schema": schema}, "effort": "low"},
        }

    def complete_json(self, system, user, schema, model, max_tokens):
        headers = {"x-api-key": self._key, "anthropic-version": "2023-06-01",
                   "content-type": "application/json"}
        raw = _post_json(ANTHROPIC_URL, headers,
                         self.build_body(system, user, schema, model, max_tokens),
                         self._opener, self._sleep)
        self.last_raw = raw
        return parse_anthropic(raw)


def parse_anthropic(raw: dict) -> tuple[dict, Usage]:
    u = raw.get("usage") or {}
    usage = Usage(u.get("input_tokens", 0) or 0, u.get("output_tokens", 0) or 0,
                  u.get("cache_read_input_tokens", 0) or 0,
                  u.get("cache_creation_input_tokens", 0) or 0)
    stop = raw.get("stop_reason")
    if stop == "refusal":
        raise LlmRefusal("model refused", usage=usage)
    if stop == "max_tokens":
        raise LlmTruncated("output hit max_tokens", usage=usage)
    text = "".join(b.get("text", "") for b in raw.get("content", []) if b.get("type") == "text")
    try:
        obj = json.loads(text)
    except json.JSONDecodeError as e:
        raise LlmError(f"response is not JSON: {e.msg}", usage=usage) from None
    return obj, usage


_JSON_TYPES = {"string": str, "array": list, "object": dict, "boolean": bool, "null": type(None),
               "integer": int, "number": (int, float)}


def _type_ok(v, t) -> bool:
    if isinstance(t, list):
        return any(_type_ok(v, x) for x in t)
    if t in ("integer", "number") and isinstance(v, bool):
        return False
    return t not in _JSON_TYPES or isinstance(v, _JSON_TYPES[t])


def check_schema(obj, schema: dict, _depth: int = 0) -> None:
    """Minimal stdlib check: required keys and top-level property types, recursing one level
    into array items' required keys. Raises LlmError."""
    if not isinstance(obj, dict):
        raise LlmError("response is not a JSON object")
    for k in schema.get("required", []):
        if k not in obj:
            raise LlmError(f"response lacks required key: {k}")
    for k, sub in (schema.get("properties") or {}).items():
        if k in obj and "type" in sub and not _type_ok(obj[k], sub["type"]):
            raise LlmError(f"response key {k} has the wrong type")
        items = sub.get("items") if isinstance(sub, dict) else None
        if _depth == 0 and k in obj and isinstance(obj[k], list) and isinstance(items, dict):
            for it in obj[k]:
                if items.get("type") == "object" or "required" in items:
                    check_schema(it, {"required": items.get("required", [])}, 1)


class OpenRouterClient:
    """OpenRouter chat completions with a JSON-schema `response_format`. Two fallbacks: content that is not valid JSON retries once with a prompt-only instruction; an
    HTTP 400 on the first call (response_format refused) retries once without `response_format`
    and with the instruction, and that result is checked against the schema with `check_schema`."""

    def __init__(self, api_key: str, opener: Callable | None = None,
                 sleep: Callable[[float], None] = time.sleep):
        self._key = api_key
        self._opener = opener
        self._sleep = sleep
        self.last_raw: dict | None = None

    def build_body(self, system: str, user: str, schema: dict, model: str, max_tokens: int,
                   structured: bool = True) -> dict:
        body = {
            "model": model,
            "max_tokens": max_tokens,
            # The system prompt is the same on every call of a stage: marked cacheable, Anthropic models
            # behind OpenRouter bill repeat reads at the cache price.
            "messages": [{"role": "system", "content": [{"type": "text", "text": system,
                                                         "cache_control": {"type": "ephemeral"}}]},
                         {"role": "user", "content": user}],
        }
        if structured:
            body["response_format"] = {"type": "json_schema",
                                       "json_schema": {"name": "extract", "strict": True, "schema": schema}}
        return body

    def _call(self, body: dict) -> dict:
        headers = {"Authorization": f"Bearer {self._key}", "Content-Type": "application/json"}
        raw = _post_json(OPENROUTER_URL, headers, body, self._opener, self._sleep)
        self.last_raw = raw
        return raw

    def complete_json(self, system, user, schema, model, max_tokens):
        body = self.build_body(system, user, schema, model, max_tokens)
        total = Usage()
        plain = False
        for attempt in range(2):
            try:
                raw = self._call(body)
            except LlmError as e:
                if attempt or e.status != 400:
                    e.usage = total + (e.usage or Usage())
                    raise
                plain = True
                body = self.build_body(system, user + JSON_ONLY_NOTE, schema, model, max_tokens, structured=False)
                continue
            try:
                obj, usage = parse_openrouter(raw)
                if plain:
                    check_schema(obj, schema)
                return obj, total + usage
            except LlmError as e:
                total = total + (e.usage if e.usage is not None else _openrouter_usage(raw))
                if attempt or plain or isinstance(e, (LlmTruncated, LlmRefusal)):
                    e.usage = total
                    raise
                body = self.build_body(system, user + JSON_ONLY_NOTE, schema, model, max_tokens)
        raise LlmError("unreachable")


def _openrouter_usage(raw: dict) -> Usage:
    """OpenRouter's prompt_tokens includes cached tokens; input_tokens here excludes them (as Anthropic's does)."""
    u = raw.get("usage") or {}
    cached = (u.get("prompt_tokens_details") or {}).get("cached_tokens", 0) or 0
    prompt = u.get("prompt_tokens", 0) or 0
    return Usage(max(0, prompt - cached), u.get("completion_tokens", 0) or 0, cached, 0)


def parse_openrouter(raw: dict) -> tuple[dict, Usage]:
    usage = _openrouter_usage(raw)
    choices = raw.get("choices") or []
    if not choices:
        raise LlmError("no choices in response", usage=usage)
    msg = choices[0].get("message") or {}
    if msg.get("refusal"):
        raise LlmRefusal("model refused", usage=usage)
    if choices[0].get("finish_reason") == "length":
        raise LlmTruncated("output hit max_tokens", usage=usage)
    content = msg.get("content")
    if isinstance(content, list):
        content = "".join(p.get("text", "") for p in content if isinstance(p, dict))
    try:
        obj = json.loads(content or "")
    except json.JSONDecodeError as e:
        raise LlmError(f"response is not JSON: {e.msg}", usage=usage) from None
    return obj, usage


def stub_key(model: str, user: str) -> str:
    return hashlib.sha1(f"{model}|{user}".encode()).hexdigest()


class StubClient:
    """Canned answers from <dir>/llm/<sha1(model|user)>.json, else {"items": []} (an accept for a
    review schema); no network.
    A canned answer may carry `"_usage": {...}` (Usage fields, tallied as if billed) and
    `"_refusal": true` (raises LlmRefusal carrying that usage, as a real refusal does)."""

    def __init__(self, directory: str | Path | None = None):
        self.dir = Path(directory) if directory else None

    def complete_json(self, system, user, schema, model, max_tokens):
        if self.dir:
            path = self.dir / "llm" / f"{stub_key(model, user)}.json"
            if path.exists():
                obj = json.loads(path.read_text(encoding="utf-8"))
                usage = Usage(**obj.pop("_usage", {}))
                if obj.pop("_refusal", False):
                    raise LlmRefusal("model refused", usage=usage)
                return obj, usage
        if "verdict" in (schema.get("properties") or {}):
            return {"verdict": "accept", "problems": [], "reason": "stub review"}, Usage()
        return {"items": []}, Usage()


def make_client(env: Mapping[str, str] | None = None, fixtures_dir: str | Path | None = None,
                provider: str | None = None):
    """Anthropic, then OpenRouter, by key; `provider` restricts the choice to one. Else the stub."""
    env = os.environ if env is None else env
    if provider in (None, "anthropic") and env.get("ANTHROPIC_API_KEY"):
        return AnthropicClient(env["ANTHROPIC_API_KEY"])
    if provider in (None, "openrouter") and env.get("OPENROUTER_API_KEY"):
        return OpenRouterClient(env["OPENROUTER_API_KEY"])
    return StubClient(fixtures_dir)


PROBE_SCHEMA = {"type": "object", "properties": {"ok": {"type": "boolean"}},
                "required": ["ok"], "additionalProperties": False}


def probe(out_dir: Path, env: Mapping[str, str], model: str | None = None, provider: str | None = None) -> int:
    client = make_client(env, provider=provider)
    if isinstance(client, StubClient):
        print("no key")
        return 0
    name = "anthropic" if isinstance(client, AnthropicClient) else "openrouter"
    obj, usage = client.complete_json("Reply with the JSON object requested.", 'Return {"ok": true}.',
                                      PROBE_SCHEMA, model or PROBE_MODELS[name], 200)
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / f"probe_{name}.json"
    path.write_text(json.dumps(client.last_raw, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(f"{name}: parsed {obj}, usage {usage}, saved {path}")
    return 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--probe", action="store_true", help="send one tiny real request and save the response")
    ap.add_argument("--provider", choices=sorted(PROBE_MODELS), help="probe only this provider")
    ap.add_argument("--out", type=Path, default=Path("."), help="directory for the saved response")
    ap.add_argument("--model", help="override the probe model id")
    args = ap.parse_args(argv)
    if not args.probe:
        ap.print_help()
        return 0
    try:
        return probe(args.out, os.environ, args.model, args.provider)
    except LlmError as e:
        print(f"probe failed: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
