"""Deterministic query planner for the weekly refresh.

Role: turn the published dataset rows into an ordered, capped list of search
`Query` records. Priority: pending rows, rows expiring near the run date,
utilities, a rotating slice of open-ended active rows, then discovery. Within a
group, rows go oldest max(last_verified, last_queried) first, and each row's
window starts at that date less OVERLAP_DAYS. Discovery (and the
seed pages, through `since_last_run`) searches from the previous run's date, less
OVERLAP_DAYS for search-index lag, so no day between two runs goes unsearched.
Discovery is the fixed `discovery_queries` plus `discovery_state_queries` state queries for the
less covered half of the states (fewest dataset rows per county); within each kind the query
searched longest ago (the ledger's discovery dates) goes first, so both rotate between runs.
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
OVERLAP_DAYS = 2  # search engines index a story a day or two after it runs
DEFAULT_GAP_DAYS = 16  # the longest gap between runs (the 15th to the 1st), used when no earlier run is known


@dataclass(frozen=True)
class Query:
    id: str
    text: str
    kind: str  # pending | expiring | utility | rotating | discovery
    freshness: str  # Brave: "YYYY-MM-DDtoYYYY-MM-DD"
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


def _freshness(row, run_date, stale_days, last_queried=""):
    """From the row's last check, max(last_verified, last_queried) less OVERLAP_DAYS, so a row searched
    last run is not searched over the same days again; at most `stale_days` back, and never after
    the day before the run."""
    floor = run_date - timedelta(days=stale_days)
    checked = [d for d in (_date(row.get("last_verified")), _date(last_queried)) if d is not None]
    start = max(checked) - timedelta(days=OVERLAP_DAYS) if checked else floor
    start = min(max(start, floor), run_date - timedelta(days=1))
    return f"{start.isoformat()}to{run_date.isoformat()}"


def since_last_run(run_date, last_run=None, stale_days=90):
    """First day a run-wide search window covers: the previous run's date less OVERLAP_DAYS
    (DEFAULT_GAP_DAYS back when there was none), never more than `stale_days` back and never
    after the day before the run."""
    start = (last_run or run_date - timedelta(days=DEFAULT_GAP_DAYS)) - timedelta(days=OVERLAP_DAYS)
    return min(max(start, run_date - timedelta(days=stale_days)), run_date - timedelta(days=1))


def _state_order(rows, counties_per_state):
    """The less covered half of the states, fewest rows per county first."""
    n = {}
    for r in rows:
        n[r.get("state", "")] = n.get(r.get("state", ""), 0) + 1
    cover = sorted(US_STATES, key=lambda st: (n.get(st, 0) / max(1, (counties_per_state or {}).get(st, 0)), st))
    return cover[:(len(cover) + 1) // 2]


def plan_queries(dataset_rows, run_date, county_names=None, caps=None, refresh_state=None, last_run=None,
                 counties_per_state=None, discovery_seen=None):
    """Ordered queries within `caps.max_requests_for_planning`.

    Each priority group takes its share (`caps.shares`) plus whatever the groups above it
    left unused; discovery gets `discovery_reserved` plus the remaining carry. A candidate
    group longer than its allowance is cut from its bottom. `refresh_state` ({row id:
    last_queried}) rotates a row that was searched without a find to the back of its group.
    `last_run` (the previous run's date) starts the discovery window (`since_last_run`).
    `counties_per_state` ({state: county count}) ranks the states for state discovery queries, and
    `discovery_seen` ({query text: last run date}) rotates the discovery queries.
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
                             _freshness(r, run_date, cfg.stale_days, (refresh_state or {}).get(r["id"], "")),
                             r["id"], endpoint))

    disc_window = f"{since_last_run(run_date, last_run, cfg.stale_days).isoformat()}to{run_date.isoformat()}"
    seen = discovery_seen or {}
    states = [(f"q-disc-{st.lower()}", f"data center moratorium {US_STATES[st]}")
              for st in _state_order(rows, counties_per_state)]
    states.sort(key=lambda q: seen.get(q[1], ""))  # stable: the least covered first among equals
    fixed = [(f"q-disc-{i:02d}", t) for i, t in enumerate(cfg.discovery_queries, 1)]
    n_disc = min(len(fixed) + len(states), cfg.discovery_reserved + carry)
    n_state = min(cfg.discovery_state_queries, len(states), n_disc)
    fixed = sorted(sorted(fixed, key=lambda q: seen.get(q[1], ""))[:n_disc - n_state])
    for qid, text in fixed + states[:n_state]:
        out.append(Query(qid, text, "discovery", disc_window))

    return out[:cfg.max_requests_for_planning]
