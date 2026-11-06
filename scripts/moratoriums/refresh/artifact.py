"""Checks the research job's hand-off artifact and copies it into the publish checkout.

Role: the trust boundary between the two jobs of moratorium-refresh.yml. The research job (web
pages, model output, search and model keys, read-only token) uploads what run.py wrote; the publish
job (write token, no research keys) treats that upload as untrusted input and applies it only
after every check below passes. The artifact holds exactly:
  run_report.json
  inputs/refresh_state.json, inputs/refresh_ledger.json
  inputs/research/weekly/<run date>/{moratoriums,bans,utilities,updates}.csv (each optional) + notes.md
Rejected:
  - any other path or directory, symlinks, hard links, device files and other non-regular entries,
    names outside [A-Za-z0-9._-], more than MAX_FILES files or MAX_TOTAL bytes, a file over its cap;
  - non-UTF-8 text or a NUL byte;
  - a CSV whose header is not schema.HEADERS for its name, a row of the wrong width, a row that
    schema.validate_row or verify.check_dates refuses, a state outside config.US_STATES, a level
    outside run.LEVELS, a source URL not http(s), a control, bidi or zero-width character in any cell,
    a notes cell other than run.py's `_note` (so no `Supersedes ... (upstream <id>)`), a summary over
    200 characters;
  - a research row id already used in the checkout (research CSVs outside this run's folder,
    additions.csv, moratoriums.csv) or repeated within the artifact;
  - an updates.csv row other than what run.py writes: on a tracked row id, field status (new in
    STATUSES), date_adopted or date_expires (YYYY-MM or YYYY-MM-DD, through verify.check_dates with
    the row's adoption date), or source_urls (`append <http(s) urls>`), naming a research file the
    checkout has (or additions.csv / this run's own files);
  - JSON that is not an object, duplicate keys, NaN or infinity;
  - a run report off the shape run.py writes (REPORT_SPEC: known keys, types, string caps with no
    invisible characters or HTML entities, mode research, this run date and folder);
  - a refresh_state.json or ledger entry that neither equals the checkout's copy (the published one,
    after carry-over) nor is this run's own: dated exactly the run date, keys http(s) URLs, hosts or
    tracked row ids, counters (pages.idle, seeds.zero) unchanged, 0 or one up, claims matching a
    model rejection in the report, and no more new entries per section than the report accounts for
    (rows queried, pages fetched, seed pages, discovery queries, HTTP 403s capped at MAX_NEW_HOSTS);
  - notes.md with raw HTML, invisible characters, a reference-style link, or a link or autolink whose
    target is not http(s) (the file is committed to data-moratoriums, where GitHub renders it).
Files are read once into memory, checked, and the same bytes are written, so nothing can change
between the check and the copy. The run date's weekly folder in the checkout is replaced whole, as
run.py replaces it.
Dependencies: schema.py, ledger.py, verify.py, config.py, textnorm.py, run.py (constants only); stdlib otherwise.
Usage: python -m moratoriums.refresh.artifact validate --artifact DIR --run-date YYYY-MM-DD
         --dest CHECKOUT --report-out PATH
Exit 0 when the artifact passed and was copied; 1 with one ::error:: line per problem.
"""
from __future__ import annotations

import argparse
import csv
import io
import json
import math
import os
import re
import shutil
import stat
import sys
import urllib.parse
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path

from . import ledger as ledger_mod
from .config import US_STATES
from .run import LEVELS
from .schema import HEADERS, STATUSES, validate_row
from .textnorm import jn
from .verify import _parse, check_dates

WEEKLY = "inputs/research/weekly"
STATE = "inputs/refresh_state.json"
LEDGER = f"inputs/{ledger_mod.NAME}"
REPORT = "run_report.json"
MB = 1024 * 1024
CAPS = {"csv": 4 * MB, "notes.md": 4 * MB, REPORT: 1 * MB, STATE: 4 * MB, LEDGER: 16 * MB}
MAX_FILES = 16
MAX_TOTAL = 32 * MB
URL_SCHEMES = ("https", "http")  # what fetch.py reads and the popup links (isHttpUrl)
_NAME = re.compile(r"[A-Za-z0-9._-]+")
_DATE = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}", re.ASCII)
_MONTH_OR_DATE = re.compile(r"[0-9]{4}-[0-9]{2}(?:-[0-9]{2})?", re.ASCII)
_ID = re.compile(r"[A-Za-z0-9._-]{1,160}", re.ASCII)
_CSV_NAME = re.compile(r"[A-Za-z0-9._-]{1,120}\.csv", re.ASCII)
_SHA = re.compile(r"[0-9a-f]{20}", re.ASCII)
_HTML = re.compile(r"<(?!https?://)[A-Za-z/!?]")
_AUTOLINK = re.compile(r"<(https?://[^>]*)>")
_MD_LINK = re.compile(r"\]\(\s*<?([^)\s>]*)")
# A reference definition anywhere, in a quote or a list too: run.py never writes one.
_MD_REF = re.compile(r"^[ \t]*(?:>[ \t]*|[-*+][ \t]+|[0-9]+[.)][ \t]+)*\[[^\]]*\]:", re.M)
# Bidi controls and zero-width characters: never in a text cell, a report string or notes.md.
_BIDI_ZW = "\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff"
_CELL_BAD = re.compile(f"[\\x00-\\x1f\\x7f-\\x9f{_BIDI_ZW}]")
_MD_BAD = re.compile(f"[\\x00-\\x08\\x0b\\x0c\\x0e-\\x1f\\x7f-\\x9f{_BIDI_ZW}]")
# run.py's notes cell (_note, run.py:353-360): the quote is one line, at most 400 characters, with no
# parentheses, so it can never spell build_research.REPL's `Supersedes ... (upstream <id>)`.
_NOTE = re.compile(r'AI-extracted by [A-Za-z0-9_.:/+-]{1,100} \(confidence (?:0\.[0-9]{2}|1\.00)\)\. '
                   r'Quote: "[^()\n]{0,400}"(?: eia_id given by the model is not on the page, blanked\.)?')
SUMMARY_MAX = 200  # run.py writes _one_line(summary, 200)
UPDATE_FIELDS = ("status", "date_adopted", "date_expires", "source_urls")
MAX_NEW_HOSTS = 100  # hosts one run may newly block; honest runs on data-moratoriums blocked 47 and 34


class Rejected(Exception):
    pass


def allowed(run_date: str) -> tuple[set[str], set[str], set[str]]:
    """(allowed directories, allowed files, required files), as posix paths relative to the root."""
    week = f"{WEEKLY}/{run_date}"
    dirs = {"", "inputs", "inputs/research", WEEKLY, week}
    files = {REPORT, STATE, LEDGER, f"{week}/notes.md"} | {f"{week}/{k}.csv" for k in HEADERS}
    return dirs, files, {REPORT, STATE, LEDGER, f"{week}/notes.md"}


def cap(rel: str) -> int:
    return CAPS["csv"] if rel.endswith(".csv") else CAPS["notes.md"] if rel.endswith("notes.md") else CAPS[rel]


def collect(root: Path, run_date: str) -> tuple[dict[str, bytes], list[str]]:
    """Every allowed file's bytes by relative path, and the problems met walking `root`."""
    dirs, files, required = allowed(run_date)
    problems: list[str] = []
    out: dict[str, bytes] = {}
    total = 0
    st = os.lstat(root)
    if not stat.S_ISDIR(st.st_mode):
        return {}, [f"{root}: not a directory"]
    stack = [""]
    while stack:
        rel_dir = stack.pop()
        with os.scandir(root / rel_dir if rel_dir else root) as it:
            entries = sorted(it, key=lambda e: e.name)
        for e in entries:
            rel = f"{rel_dir}/{e.name}" if rel_dir else e.name
            if not _NAME.fullmatch(e.name) or e.name in (".", ".."):
                problems.append(f"{rel!r}: name not allowed")
                continue
            st = os.lstat(e.path)
            if stat.S_ISLNK(st.st_mode):
                problems.append(f"{rel}: symlink")
            elif stat.S_ISDIR(st.st_mode):
                if rel in dirs:
                    stack.append(rel)
                else:
                    problems.append(f"{rel}/: directory not allowed")
            elif not stat.S_ISREG(st.st_mode):
                problems.append(f"{rel}: not a regular file")
            elif st.st_nlink != 1:
                problems.append(f"{rel}: hard link")
            elif rel not in files:
                problems.append(f"{rel}: file not allowed")
            elif st.st_size > cap(rel):
                problems.append(f"{rel}: {st.st_size} bytes, over the {cap(rel)}-byte cap")
            elif len(out) >= MAX_FILES or total + st.st_size > MAX_TOTAL:
                problems.append(f"{rel}: over the artifact cap ({MAX_FILES} files, {MAX_TOTAL} bytes)")
            else:
                fd = os.open(e.path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
                with os.fdopen(fd, "rb") as f:
                    data = f.read(cap(rel) + 1)
                if len(data) > cap(rel):
                    problems.append(f"{rel}: grew past its cap while read")
                    continue
                out[rel] = data
                total += len(data)
    problems += [f"{p}: missing" for p in sorted(required - set(out))]
    return out, problems


def text(rel: str, data: bytes) -> str:
    try:
        s = data.decode("utf-8")
    except UnicodeDecodeError as e:
        raise Rejected(f"{rel}: not UTF-8 ({e.reason} at byte {e.start})") from None
    if "\x00" in s:
        raise Rejected(f"{rel}: NUL byte")
    return s


def url_ok(u: str) -> bool:
    if not u or u != u.strip() or any(c.isspace() or ord(c) < 32 or ord(c) == 127 for c in u):
        return False
    p = urllib.parse.urlsplit(u)
    return p.scheme in URL_SCHEMES and bool(p.hostname)


def urls_problems(cell: str) -> list[str]:
    return [f"URL not {'/'.join(URL_SCHEMES)}: {u[:120]!r}" for u in cell.split("|") if not url_ok(u)]


def research_files(dest: Path) -> set[str]:
    """The `file` values an updates row may name: the checkout's research CSVs, additions.csv and this run's own."""
    names = {"additions.csv"} | {f"{k}.csv" for k in HEADERS if k != "updates"}
    research = dest / "inputs" / "research"
    if research.is_dir():
        names |= {p.name for p in research.rglob("*.csv") if p.name != "updates.csv"}
    return names


def _csv_rows(path: Path) -> list[dict]:
    try:
        with path.open(newline="", encoding="utf-8") as f:
            return [r for r in csv.DictReader(f) if r.get("id")]
    except (OSError, UnicodeDecodeError, csv.Error):
        return []


def tracked(dest: Path, run_date: str) -> tuple[set[str], dict[str, str]]:
    """(ids run.py holds taken, each tracked row's date_adopted). Taken is Inputs.research_ids | dataset ids
    (run.py:293-308, 433): every id in the checkout's research CSVs outside this run's own folder,
    additions.csv and the published moratoriums.csv."""
    own = dest / WEEKLY / run_date
    research = dest / "inputs" / "research"
    paths = [p for p in sorted(research.rglob("*.csv")) if own not in p.parents] if research.is_dir() else []
    ids: set[str] = set()
    adopted: dict[str, str] = {}
    for p in paths + [dest / "inputs" / "additions.csv", dest / "moratoriums.csv"]:
        for r in _csv_rows(p):
            ids.add(r["id"])
            if r.get("date_adopted"):
                adopted[r["id"]] = r["date_adopted"]
    return ids, adopted


@dataclass
class Ctx:
    """What the checks compare against: the publish checkout and this run."""
    run_date: str
    dest: Path
    files: set[str] = field(default_factory=set)  # research file names an updates row may name
    taken: set[str] = field(default_factory=set)  # ids already used before this run
    adopted: dict[str, str] = field(default_factory=dict)  # tracked row id -> date_adopted
    new_ids: dict[str, str] = field(default_factory=dict)  # this run's research row ids -> file
    report: dict = field(default_factory=dict)


def update_problems(row: dict, ctx: Ctx, upd_adopted: dict[str, str]) -> list[str]:
    """An updates row may only do what run.py writes: a status, a date or an appended source, on a tracked row."""
    f, new = row["field"], row["new"]
    p = [] if row["file"] in ctx.files and _CSV_NAME.fullmatch(row["file"]) else [f"file {row['file'][:60]!r} is not a research file"]
    if row["id"] not in ctx.taken:
        p.append("id is not a tracked row")
    if f not in UPDATE_FIELDS:
        return p + [f"field {f[:40]!r} is not one run.py writes"]
    if f == "status" and new not in STATUSES:
        p.append(f"status {new[:40]!r} not in vocabulary")
    elif f in ("date_adopted", "date_expires"):
        if not (_MONTH_OR_DATE.fullmatch(new) and _parse(new)):
            p.append(f"{f} {new[:40]!r} is not YYYY-MM or YYYY-MM-DD")
        else:
            # As run.py checks the claim's dates together (verify.check_dates): the adoption date is this
            # run's update to it, else the tracked row's.
            dates = {"date_adopted": upd_adopted.get(row["id"]) or ctx.adopted.get(row["id"], ""), f: new}
            p += check_dates(dates, date.fromisoformat(ctx.run_date))
    elif f == "source_urls":
        p += urls_problems(new[len("append "):]) if new.startswith("append ") else ["source_urls new is not `append <url>`"]
    return p


def row_problems(row: dict, kind: str, ctx: Ctx) -> list[str]:
    """Field formats on a research row (not updates): a fresh id, dates as run.py checks them, state and level
    vocabularies, a one-line summary."""
    p = [] if _ID.fullmatch(row["id"]) else ["id has characters outside [A-Za-z0-9._-]"]
    if row["id"] in ctx.taken:
        p.append("id already used before this run")  # run.py never reuses one (Verifier.taken, run.py:433, 528-532)
    elif row["id"] in ctx.new_ids:
        p.append(f"id repeated (also in {ctx.new_ids[row['id']]})")
    ctx.new_ids.setdefault(row["id"], kind)
    p += check_dates(row, date.fromisoformat(ctx.run_date))
    if any(row[c] and not _MONTH_OR_DATE.fullmatch(row[c]) for c in ("date_adopted", "date_expires")):
        p.append("date not YYYY-MM or YYYY-MM-DD")
    if row["state"] not in US_STATES:
        p.append(f"state {row['state'][:10]!r} unknown")
    if row["jurisdiction_level"] not in LEVELS:
        p.append(f"jurisdiction_level {row['jurisdiction_level'][:30]!r} unknown")
    if len(row["summary"]) > SUMMARY_MAX:
        p.append(f"summary over {SUMMARY_MAX} characters")
    return p


def check_csv(rel: str, s: str, ctx: Ctx) -> list[str]:
    kind = Path(rel).stem
    header = HEADERS[kind]
    try:
        rows = list(csv.reader(io.StringIO(s, newline="")))
    except csv.Error as e:
        return [f"{rel}: unreadable CSV ({e})"]
    if not rows or rows[0] != header:
        return [f"{rel}: header is not the {kind} header"]
    problems = []
    upd_adopted = {r[1]: r[4] for r in rows[1:] if kind == "updates" and len(r) == len(header) and r[2] == "date_adopted"}
    for n, cells in enumerate(rows[1:], start=2):
        if len(cells) != len(header):
            problems.append(f"{rel} line {n}: {len(cells)} cells, expected {len(header)}")
            continue
        row = dict(zip(header, cells))
        bad = validate_row(row, kind) + urls_problems(row["source_urls"])
        bad += [f"{c}: control, bidi or zero-width character" for c in header if _CELL_BAD.search(row[c])]
        if not _NOTE.fullmatch(row["notes"]):
            bad.append("notes is not the cell run.py writes")
        bad += update_problems(row, ctx, upd_adopted) if kind == "updates" else row_problems(row, kind, ctx)
        if kind == "updates" and not _ID.fullmatch(row["id"]):
            bad.append("id has characters outside [A-Za-z0-9._-]")
        problems += [f"{rel} line {n} ({row['id'][:60]!r}): {p}" for p in bad]
    return problems


def check_notes(rel: str, s: str) -> list[str]:
    p = [f"{rel}: raw HTML"] if _HTML.search(s) else []
    p += [f"{rel}: control, bidi or zero-width character"] if _MD_BAD.search(s) else []
    p += [f"{rel}: reference-style link"] if _MD_REF.search(s) else []
    targets = _MD_LINK.findall(s) + _AUTOLINK.findall(s)
    return p + [f"{rel}: link target not http(s): {t[:80]!r}" for t in targets if not url_ok(t)]


def _pairs(pairs):
    keys = [k for k, _ in pairs]
    if len(keys) != len(set(keys)):
        raise ValueError("duplicate key")
    return dict(pairs)


def _no_constant(name):
    raise ValueError(f"{name} not allowed")


def load_json(rel: str, s: str) -> dict:
    try:
        v = json.loads(s, object_pairs_hook=_pairs, parse_constant=_no_constant)
    except (ValueError, RecursionError) as e:
        raise Rejected(f"{rel}: not valid JSON ({e})") from None
    if not isinstance(v, dict):
        raise Rejected(f"{rel}: not a JSON object")
    return v


# ---------------------------------------------------------------- run_report.json

INT, NUM = "int", "num"
IDENT = re.compile(r"[A-Za-z0-9_.:/+-]{1,100}", re.ASCII)
TEXT = 300  # a free-text string: at most this many characters, no control characters


def _opt(spec):
    return ("opt", spec)


def _map(keys, val, n=500):
    return ("map", keys, val, n)


def _list(item, n=500):
    return ("list", item, n)


_COUNTS = _map(IDENT, INT)
_REJECTED = {"kind": IDENT, "state": re.compile(r"[A-Z]{2}", re.ASCII), "name": TEXT, "target": ("id_or_empty",),
             "problems": _list(TEXT, 20), "reason": 2000, "url": ("url",), "by": IDENT}
REPORT_SPEC = {
    "run_date": ("const_date",), "mode": ("const", "research"), "out_dir": ("const_out",),
    "providers": _map(IDENT, IDENT, 5), "upstream_sha": re.compile(r"[0-9a-f]{0,40}", re.ASCII),
    "caps_hit": _list(("enum", "wall_clock", "max_llm_calls", "max_pages", "max_requests", "max_escalation_calls"), 10),
    "queries": {"planned": INT, "by_kind": _COUNTS, "run": INT, "errors": INT, "error_ids": _list(IDENT, 2000),
                "stopped_on_http": INT, "rows_queried": INT},
    "search_requests": INT, "seeds": _COUNTS, "hits": _COUNTS, "ledger": _COUNTS,
    "fetch": {"pages": INT, "outcomes": _COUNTS, "rate": NUM},
    "llm": {"calls": INT, "by_model": _map(IDENT, _COUNTS, 20), "escalated": INT, "refusals": INT, "errors": INT,
            "est_cost_usd": NUM, "price_assumed": _opt(_map(IDENT, IDENT, 20))},
    "items": _COUNTS, "rows": {k: INT for k in HEADERS},
    "review": {"claims": INT, "accepted": INT, "model_calls": INT, "rejected": _list(_REJECTED, 2000), "by": _COUNTS},
    "leads": {"total": INT, "by_reason": _map(TEXT, INT)},
    "refresh_state_updated": INT,
}


_ENTITY = re.compile(r"&(?:#|[A-Za-z][A-Za-z0-9]*;)")  # an HTML entity spells what pr.py's defanging removes


def _text_ok(v, n: int) -> bool:
    return isinstance(v, str) and len(v) <= n and not _CELL_BAD.search(v) and not _ENTITY.search(v)


def spec_problems(v, spec, where: str, run_date: str) -> list[str]:
    if isinstance(spec, tuple) and spec[0] == "opt":
        spec = spec[1]
    bad = [f"{where}: unexpected value"]
    if spec == INT:
        return [] if type(v) is int and v >= 0 else bad
    if spec == NUM:
        return [] if type(v) in (int, float) and math.isfinite(v) and v >= 0 else bad
    if isinstance(spec, int):
        return [] if _text_ok(v, spec) else bad
    if isinstance(spec, re.Pattern):
        return [] if isinstance(v, str) and spec.fullmatch(v) else bad
    if isinstance(spec, dict):
        if not isinstance(v, dict):
            return bad
        p = [f"{where}.{str(k)[:40]}: unknown key" for k in v if k not in spec]
        p += [f"{where}.{k}: missing" for k, s in spec.items() if k not in v and not (isinstance(s, tuple) and s[0] == "opt")]
        for k, s in spec.items():
            if k in v:
                p += spec_problems(v[k], s, f"{where}.{k}", run_date)
        return p
    kind = spec[0]
    if kind == "map":
        _, keys, val, n = spec
        if not isinstance(v, dict) or len(v) > n:
            return bad
        p = []
        for k, x in v.items():
            if spec_problems(k, keys, "", run_date):
                p.append(f"{where}: key {str(k)[:40]!r} not allowed")
            p += spec_problems(x, val, f"{where}.{str(k)[:40]}", run_date)
        return p
    if kind == "list":
        _, item, n = spec
        if not isinstance(v, list) or len(v) > n:
            return bad
        return [x for i, e in enumerate(v) for x in spec_problems(e, item, f"{where}[{i}]", run_date)]
    ok = {"enum": lambda: v in spec[1:], "const": lambda: v == spec[1], "const_date": lambda: v == run_date,
          "const_out": lambda: v == f"{WEEKLY}/{run_date}", "url": lambda: isinstance(v, str) and url_ok(v),
          "id_or_empty": lambda: v == "" or (isinstance(v, str) and bool(_ID.fullmatch(v)))}[kind]()
    return [] if ok else bad


# ---------------------------------------------------------------- state and ledger

def _host_ok(h) -> bool:
    return isinstance(h, str) and url_ok(f"https://{h}/") and urllib.parse.urlsplit(f"https://{h}/").hostname == h


def _dated(v: dict, keys: dict, run_date: str) -> bool:
    """A ledger value as ledger.py writes it: exactly `keys` ({name: check}) and date == run_date."""
    return (isinstance(v, dict) and set(v) == set(keys) | {"date"} and v["date"] == run_date
            and all(chk(v[k]) for k, chk in keys.items()))


def _str_list(n: int, item=lambda x: _text_ok(x, TEXT)):
    return lambda v: isinstance(v, list) and len(v) <= n and all(item(x) for x in v)


_NAT = lambda v: type(v) is int and v >= 0  # noqa: E731
LEDGER_ENTRY = {
    "claims": (lambda k: _text_ok(k, 1000),
               {"who": lambda v: _text_ok(v, TEXT), "problems": _str_list(50), "reason": lambda v: _text_ok(v, 2000),
                "pages": _str_list(ledger_mod.MAX_PAGES_PER_CLAIM, lambda x: isinstance(x, str) and bool(_SHA.fullmatch(x)))}),
    "pages": (url_ok, {"sha": lambda v: isinstance(v, str) and bool(_SHA.fullmatch(v)),
                       "ctx": _str_list(500, lambda x: isinstance(x, str) and bool(_ID.fullmatch(x))),
                       "claims": lambda v: type(v) is bool, "idle": _NAT}),
    "seeds": (url_ok, {"zero": _NAT}),
    "hosts": (_host_ok, {}),
    "discovery": (lambda k: _text_ok(k, 500), None),  # query text -> run date string
}


def _num(d, *path) -> int:
    for k in path:
        d = d.get(k) if isinstance(d, dict) else None
    return d if type(d) is int and d >= 0 else 0


def _counter_ok(e, old, name: str) -> bool:
    """A run counter (pages.idle, seeds.zero) stays, resets to 0 or rises by exactly 1 (ledger.note_page/note_seed)."""
    before = old.get(name, 0) if isinstance(old, dict) and type(old.get(name)) is int else 0
    return e[name] in (0, before, before + 1)


def _who(x: dict) -> str:
    return f"{x.get('state', '')}|{jn(str(x.get('name', '')).replace('＆', '&'))}"  # run.clean_text wrote & as ＆


def _rejected_by_model(ctx: Ctx) -> list[dict]:
    rv = ctx.report.get("review")
    rej = rv.get("rejected") if isinstance(rv, dict) else None
    return [x for x in rej if isinstance(x, dict) and x.get("by") == "model"] if isinstance(rej, list) else []


def _claim_tied(e: dict, rejected: list[dict]) -> bool:
    """A new ledger rejection matches one the report lists (review.py:187-189 writes both)."""
    return any(_who(x) == e["who"] and x.get("problems") == e["problems"]
               and (x.get("reason") == e["reason"] or (e["reason"] == "" and x.get("reason") == "rejected without a reason"))
               for x in rejected)


def state_problems(v: dict, prior: dict, ctx: Ctx) -> list[str]:
    """Each entry the published one, or this run's date on a tracked row; no more new ones than rows queried."""
    p = [f"{STATE}: entry {str(k)[:60]!r} is neither the published one nor a tracked row -> {ctx.run_date}"
         for k, d in v.items() if k not in ctx.taken or (d != prior.get(k) and d != ctx.run_date)]
    fresh = sum(1 for k, d in v.items() if d != prior.get(k))
    if fresh > _num(ctx.report, "queries", "rows_queried"):
        p.append(f"{STATE}: {fresh} new entries, more than the report's rows_queried")
    return p


def ledger_problems(v: dict, prior: dict, ctx: Ctx) -> list[str]:
    run_date = ctx.run_date
    extra = sorted(set(v) - set(ledger_mod.SECTIONS))
    p = [f"{LEDGER}: unknown sections {extra}"] if extra else []
    rejected = _rejected_by_model(ctx)
    caps = {"claims": len(rejected), "pages": _num(ctx.report, "fetch", "pages"), "seeds": _num(ctx.report, "seeds", "pages"),
            "discovery": _num(ctx.report, "queries", "by_kind", "discovery"),
            "hosts": min(MAX_NEW_HOSTS, _num(ctx.report, "fetch", "outcomes", "http_403"))}
    for sec in ledger_mod.SECTIONS:
        entries = v.get(sec, {})
        if not isinstance(entries, dict):
            p.append(f"{LEDGER}: section {sec} is not an object")
            continue
        old = prior.get(sec) if isinstance(prior.get(sec), dict) else {}
        key_ok, keys = LEDGER_ENTRY[sec]
        fresh = 0
        for k, e in entries.items():
            if k in old and old[k] == e:
                continue
            fresh += 1
            ok = key_ok(k) and (e == run_date if keys is None else _dated(e, keys, run_date))
            if ok and sec == "pages":
                ok = _counter_ok(e, old.get(k), "idle") and set(e["ctx"]) <= ctx.taken
            elif ok and sec == "seeds":
                ok = _counter_ok(e, old.get(k), "zero")
            elif ok and sec == "claims":
                ok = _claim_tied(e, rejected)
            if not ok:
                p.append(f"{LEDGER}: {sec} entry {str(k)[:60]!r} is neither the published one nor this run's own")
        if fresh > caps[sec]:
            p.append(f"{LEDGER}: {fresh} new {sec} entries, more than this run accounts for ({caps[sec]})")
    return p


def _prior(dest: Path, rel: str) -> dict:
    try:
        v = json.loads((dest / rel).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return v if isinstance(v, dict) else {}


def check_json(rel: str, s: str, ctx: Ctx) -> list[str]:
    v = load_json(rel, s)
    if rel == REPORT:
        return spec_problems(v, REPORT_SPEC, "run_report", ctx.run_date)
    if rel == STATE:
        return state_problems(v, _prior(ctx.dest, STATE), ctx)
    return ledger_problems(v, _prior(ctx.dest, LEDGER), ctx)


def validate(root: Path, run_date: str, dest: Path) -> tuple[dict[str, bytes], list[str]]:
    """(files by relative path, problems), checked against the checkout `dest` it would be copied into.
    The files are safe to copy only when problems is empty."""
    if not (_DATE.fullmatch(run_date) and _is_date(run_date)):
        return {}, [f"run date {run_date[:20]!r} is not YYYY-MM-DD"]
    files, problems = collect(Path(root), run_date)
    dest = Path(dest)
    ctx = Ctx(run_date, dest, research_files(dest), *tracked(dest, run_date))
    texts = {}
    for rel, data in sorted(files.items()):
        try:
            texts[rel] = text(rel, data)
        except Rejected as e:
            problems.append(str(e))
    try:
        ctx.report = load_json(REPORT, texts[REPORT]) if REPORT in texts else {}
    except Rejected:
        pass  # reported below
    for rel in sorted(texts):
        try:
            if rel.endswith(".csv"):
                problems += check_csv(rel, texts[rel], ctx)
            elif rel.endswith(".md"):
                problems += check_notes(rel, texts[rel])
            else:
                problems += check_json(rel, texts[rel], ctx)
        except Rejected as e:
            problems.append(str(e))
    return files, problems


def _is_date(s: str) -> bool:
    try:
        date.fromisoformat(s)
        return True
    except ValueError:
        return False


def apply(files: dict[str, bytes], dest: Path, run_date: str, report_out: Path) -> None:
    """Write checked files: the weekly folder replaced whole, state and ledger over the checkout's, the report to report_out."""
    week = dest / WEEKLY / run_date
    if week.is_symlink() or week.exists():
        if week.is_symlink() or not week.is_dir():
            week.unlink()
        else:
            shutil.rmtree(week)
    week.mkdir(parents=True)
    for rel, data in files.items():
        target = report_out if rel == REPORT else dest / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        if target.is_symlink():
            target.unlink()
        target.write_bytes(data)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Check the moratorium research artifact and copy it into the checkout")
    sub = ap.add_subparsers(dest="cmd", required=True)
    v = sub.add_parser("validate")
    v.add_argument("--artifact", type=Path, required=True)
    v.add_argument("--run-date", required=True)
    v.add_argument("--dest", type=Path, required=True, help="checkout the artifact is checked against and copied into")
    v.add_argument("--report-out", type=Path, required=True, help="where run_report.json goes")
    a = ap.parse_args(argv)
    files, problems = validate(a.artifact, a.run_date, a.dest)
    for p in problems:
        print(f"::error::research artifact: {p}")
    if problems:
        return 1
    apply(files, a.dest, a.run_date, a.report_out)
    print(f"research artifact: {len(files)} files passed, copied into {a.dest}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
