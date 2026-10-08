"""Deterministic query planner for the weekly refresh.

Role: turn the published dataset rows into an ordered, capped list of search
`Query` records. Priority: pending rows, rows expiring near the run date,
utilities, a rotating slice of open-ended active rows, then discovery. Within a
group, rows go oldest max(last_verified, last_queried) first.
Dates go through `verify._parse`: YYYY-MM-DD or YYYY-MM. A month-only expiry
spans the whole month, so the row counts as expiring when any day of it falls
inside the window.
Dependencies: config.py, verify.py; no I/O.
"""
from dataclasses import dataclass
from datetime import timedelta

from .config import Config, US_STATES
from .verify import _parse

ACTIVE = ("active", "extended")


@dataclass(frozen=True)
class Query:
    id: str
    text: str
    kind: str  # pending | expiring | utility | rotating | discovery
    freshness: str  # Brave: "pw" or "YYYY-MM-DDtoYYYY-MM-DD"
    row_id: str = ""
    endpoint: str = "news"  # Brave endpoint: utility rows use "web", everything else "news"


def _date(s, end=False):
    return _parse((s or "").strip()[:10], end)


def _oldest(rows, refresh_state=None):
    """Oldest check first: max(last_verified, last_queried from refresh_state); empty sorts first."""
    state = refresh_state or {}
    return sorted(rows, key=lambda r: (max(r.get("last_verified") or "", state.get(r["id"]) or ""), r["id"]))


def _text(row, county_names):
    name = row["name"]
    if row.get("level") == "utility":
        return f'"{name}" data center OR cryptocurrency load moratorium'
    state = US_STATES.get(row.get("state", ""), row.get("state", ""))
    county = (county_names or {}).get(row.get("county_fips", ""), "")
    if county and row.get("level") not in ("county", "state"):
        county = county if county.lower().endswith(" county") else f"{county} County"
        return f'"{name}" {county} {state} data center moratorium'
    return f'"{name}" {state} data center moratorium'.replace("  ", " ")


def _freshness(row, run_date, stale_days):
    floor = run_date - timedelta(days=stale_days)
    lv = _date(row.get("last_verified"))
    start = floor if lv is None or lv < floor else lv
    start = min(start, run_date - timedelta(days=1))
    return f"{start.isoformat()}to{run_date.isoformat()}"


def plan_queries(dataset_rows, run_date, county_names=None, caps=None, refresh_state=None):
    """Ordered queries within `caps.max_requests_for_planning`.

    Each priority group takes its share (`caps.shares`) plus whatever the groups above it
    left unused; discovery gets `discovery_reserved` plus the remaining carry. A candidate
    group longer than its allowance is cut from its bottom. `refresh_state` ({row id:
    last_queried}) rotates a row that was searched without a find to the back of its group.
    """
    cfg = caps or Config()
    rows = sorted(dataset_rows, key=lambda r: r["id"])
    seen = set()
    out = []

    w = timedelta(days=cfg.expiry_window_days)

    def expiring(r):
        v = (r.get("date_expires") or "").strip()[:10]
        lo, hi = _parse(v), _parse(v, True)
        return r.get("status") in ACTIVE and lo is not None and lo <= run_date + w and hi >= run_date - w

    pending = _oldest((r for r in rows if r.get("status") == "pending"), refresh_state)
    exp = sorted((r for r in rows if expiring(r)), key=lambda r: (r["date_expires"], r["id"]))
    util = _oldest((r for r in rows if r.get("level") == "utility"), refresh_state)
    open_ended = _oldest((r for r in rows if r.get("status") in ACTIVE and not (r.get("date_expires") or "").strip()),
                         refresh_state)
    groups = {"pending": (pending, "news"), "expiring": (exp, "news"),
              "utility": (util, "web"), "rotating": (open_ended, "news")}

    carry = 0
    for kind, share in cfg.shares:
        members, endpoint = groups[kind]
        members = [r for r in members if r["id"] not in seen]
        take = min(len(members), share + carry)
        carry = share + carry - take
        for r in members[:take]:
            seen.add(r["id"])
            out.append(Query(f"q-{r['id']}", _text(r, county_names), kind,
                             _freshness(r, run_date, cfg.stale_days), r["id"], endpoint))

    n_disc = min(len(cfg.discovery_queries), cfg.discovery_reserved + carry)
    for i, text in enumerate(cfg.discovery_queries[:n_disc], 1):
        out.append(Query(f"q-disc-{i:02d}", text, "discovery", "pw"))

    return out[:cfg.max_requests_for_planning]
