"""What the moratorium refresh remembers between runs: inputs/refresh_ledger.json.

Role: load, prune and save the ledger, plus the keys its sections use. One JSON object, written
beside refresh_state.json on `data-moratoriums` at the end of every research run:
  claims  claim key (`claim_key`) -> {date, who, problems, reason, pages}: a change the review
          model rejected, with the sha (`page_sha`) of each page it was rejected from. The same
          claim from one of those pages is rejected again without a model call; a changed page
          (a new sha) is reviewed afresh.
  pages   normalize_url -> {date, sha, ctx, claims, idle}: the last time the page was read, its
          text's sha, the tracked rows it was read for, whether it gave a claim, and how many runs in
          a row it gave none. `unchanged` skips the model read of a page whose text and rows are the
          same and that gave no claim; `idle` skips fetching one that gave none IDLE_RUNS runs running,
          until REFETCH_DAYS after its last read.
  seeds   seed key (`seed_key`) -> {date, zero}: the last run a seed page was tried and how many runs
          in a row it gave no cited URL. A seed with SEED_ZERO_RUNS such runs is paused until
          REFETCH_DAYS after its last try, then tried again.
  discovery  query text -> the last run date it was searched; discovery queries rotate oldest first.
  hosts   host -> {date}: a host that answered HTTP 403 with no page fetched from it that run. Its
          search hits are not fetched for BLOCK_DAYS; then it is tried again.
Entries are dated (a "date" field, or the value itself when it is a date string) and dropped
KEEP_DAYS after that date, so the file stays small.
Dependencies: textnorm.py (jn); stdlib otherwise. No network.
"""
from __future__ import annotations

import hashlib
import json
import re
import urllib.parse
from datetime import date, timedelta
from pathlib import Path

from .textnorm import jn

NAME = "refresh_ledger.json"
KEEP_DAYS = 180
SECTIONS = ("claims", "pages", "hosts", "seeds", "discovery")
MAX_PAGES_PER_CLAIM = 10
IDLE_RUNS = 2
REFETCH_DAYS = 90
BLOCK_DAYS = 30
SEED_ZERO_RUNS = 3


def empty() -> dict:
    return {k: {} for k in SECTIONS}


def load(path: Path) -> dict:
    """The ledger at `path`, every section present; a missing or unreadable file is an empty ledger."""
    try:
        raw = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        raw = {}
    out = empty()
    if isinstance(raw, dict):
        for k in SECTIONS:
            if isinstance(raw.get(k), dict):
                out[k] = raw[k]
    return out


def _dated(v) -> str:
    return v if isinstance(v, str) else v.get("date", "") if isinstance(v, dict) else ""


def prune(ledger: dict, run_date: date) -> dict:
    """Entries dated within KEEP_DAYS of `run_date`; an undated entry is dropped."""
    floor = (run_date - timedelta(days=KEEP_DAYS)).isoformat()
    return {k: {key: v for key, v in ledger.get(k, {}).items() if _dated(v) >= floor} for k in SECTIONS}


def save(path: Path, ledger: dict, run_date: date) -> None:
    """Pruned, sorted JSON with one entry per line, so a run's commit diffs only the entries it changed."""
    parts = []
    for sec, entries in prune(ledger, run_date).items():
        body = ",\n".join(f"  {json.dumps(k)}: {json.dumps(v, sort_keys=True, separators=(',', ':'))}"
                          for k, v in sorted(entries.items()))
        parts.append(f" {json.dumps(sec)}: {{" + (f"\n{body}\n " if body else "") + "}")
    Path(path).write_text("{\n" + ",\n".join(parts) + "\n}\n", encoding="utf-8")


def page_sha(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:20]


def who(c: dict) -> str:
    """The place a claim is about: state and jurisdiction key."""
    return f"{c['state']}|{jn(c['jurisdiction_name'])}"


def claim_key(kind: str, c: dict, target_id: str = "") -> str:
    """One proposed change: its kind, the row it changes, the place, and the values it would set."""
    return "|".join((kind, target_id, who(c), c["measure_type"], c["status"], c["date_adopted"], c["date_expires"]))


def remember_rejection(ledger: dict, key: str, c: dict, sha: str, problems: list[str], reason: str, run_date: date) -> None:
    e = ledger["claims"].get(key) or {"pages": []}
    pages = [p for p in e.get("pages", []) if p != sha] + [sha]
    ledger["claims"][key] = {"date": run_date.isoformat(), "who": who(c), "problems": problems,
                             "reason": reason, "pages": pages[-MAX_PAGES_PER_CLAIM:]}


def rejected_before(ledger: dict, key: str, sha: str) -> dict | None:
    """The ledger entry when this claim was rejected from this very page, else None."""
    e = ledger["claims"].get(key)
    return e if e and sha in e.get("pages", []) else None


def idle(ledger: dict, key: str, rows, run_date: date) -> bool:
    """Fetching this page can be skipped: it gave no claim in the last IDLE_RUNS runs it was read, was
    last read within REFETCH_DAYS, and is wanted for no tracked row it was not read for then."""
    e = ledger["pages"].get(key)
    return (bool(e) and not e.get("claims") and e.get("idle", 0) >= IDLE_RUNS and set(rows) <= set(e.get("ctx", []))
            and e.get("date", "") >= (run_date - timedelta(days=REFETCH_DAYS)).isoformat())


def unchanged(ledger: dict, key: str, sha: str, rows) -> bool:
    """The model read of this page can be skipped: same text, no new tracked row, and no claim last time."""
    e = ledger["pages"].get(key)
    return bool(e) and e.get("sha") == sha and not e.get("claims") and set(rows) <= set(e.get("ctx", []))


def note_page(ledger: dict, key: str, sha: str, rows, claims: bool, run_date: date) -> None:
    """Record one read (or unchanged-skipped) page."""
    old = ledger["pages"].get(key) or {}
    ledger["pages"][key] = {"date": run_date.isoformat(), "sha": sha, "ctx": sorted(set(rows)), "claims": claims,
                            "idle": 0 if claims else old.get("idle", 0) + 1}


def host(url: str) -> str:
    return (urllib.parse.urlsplit(url).hostname or "").lower().removeprefix("www.")


def blocked(ledger: dict, url: str, run_date: date) -> bool:
    e = ledger["hosts"].get(host(url))
    return bool(e) and e.get("date", "") > (run_date - timedelta(days=BLOCK_DAYS)).isoformat()


def note_hosts(ledger: dict, pages, run_date: date) -> None:
    """Block each host whose every fetch this run was a 403; a host that served a page is cleared."""
    ok = {host(p.url) for p in pages if p.text} | {host(p.final_url) for p in pages if p.text}
    for h in ok:
        ledger["hosts"].pop(h, None)
    for h in {host(p.url) for p in pages if p.error == "http_403"} - ok:
        ledger["hosts"][h] = {"date": run_date.isoformat()}


def seed_key(url: str) -> str:
    """A seed URL without its run-dependent date range (SEC full-text search startdt/enddt)."""
    return re.sub(r"&(?:startdt|enddt)=[^&]*", "", url)


def seed_paused(ledger: dict, url: str, run_date: date) -> bool:
    e = ledger["seeds"].get(seed_key(url))
    return (bool(e) and e.get("zero", 0) >= SEED_ZERO_RUNS
            and e.get("date", "") > (run_date - timedelta(days=REFETCH_DAYS)).isoformat())


def note_seed(ledger: dict, url: str, kept: int, run_date: date) -> None:
    old = ledger["seeds"].get(seed_key(url)) or {}
    ledger["seeds"][seed_key(url)] = {"date": run_date.isoformat(), "zero": 0 if kept else old.get("zero", 0) + 1}
