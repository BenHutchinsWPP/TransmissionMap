"""Deterministic claim checks for extracted candidates.

Role: quote-in-page check, date rules, dedupe key and classification against
the dataset (`classify`, and `matching_ids` for a year-agnostic or multi-type
look-up), and collision-free ids. Nothing here calls a model or the network.
Dependencies: textnorm.py; stdlib csv/datetime. `TYPE` and `LEVEL` mirror the
same-named maps in build_research.py (a test keeps them equal).
"""
import calendar
import csv
from datetime import date

from .textnorm import jn, match_key, normalize_text

MIN_QUOTE = 40
EARLIEST = date(2015, 1, 1)
TYPE = {"service pause": "interconnection pause", "load cap": "interconnection pause"}
LEVEL = {"borough": "town", "state_agency": "state"}


def quote_in_page(quote, page_text):
    """True when the quote (>= 40 normalised characters) occurs in the FULL page text.

    Hyphens are ignored on both sides (`match_key`), so line-break hyphenation and
    dash spacing never decide the outcome. Never pass truncated text here."""
    if len(normalize_text(quote or "")) < MIN_QUOTE:
        return False
    return match_key(quote) in match_key(page_text or "")


def _parse(s, end=False):
    """ISO YYYY-MM-DD or YYYY-MM; None when malformed.

    A month-only value is the first day of the month (right for an adoption date) or,
    with `end=True`, the last day (right for an expiry date)."""
    try:
        s = s.strip()
        if len(s) == 7:
            d = date.fromisoformat(s + "-01")
            return d.replace(day=calendar.monthrange(d.year, d.month)[1]) if end else d
        return date.fromisoformat(s) if len(s) == 10 else None
    except ValueError:
        return None


def check_dates(row, run_date):
    """Problems with a row's dates (empty list when fine). Blank dates are skipped."""
    problems = []
    adopted = expires = None
    for col in ("date_adopted", "date_expires"):
        v = (row.get(col) or "").strip()
        if not v:
            continue
        d = _parse(v, end=col == "date_expires")
        if d is None:
            problems.append(f"{col} not ISO: {v}")
        elif col == "date_adopted":
            adopted = d
            if d > run_date:
                problems.append(f"date_adopted after run date: {v}")
            elif d < EARLIEST:
                problems.append(f"date_adopted before 2015-01-01: {v}")
        else:
            expires = d
    if adopted and expires and expires < adopted:
        problems.append("date_expires before date_adopted")
    return problems


def dedupe_key(state, name, county, level, type):
    level = LEVEL.get(level, level)
    t = (type or "").strip().lower()
    return (state, jn(name), jn(county or ""), level == "county", level == "utility", TYPE.get(t, t))


def load_county_names(path):
    """county_names.csv (county_fips,state,county_name) -> {fips: name}."""
    with open(path, encoding="utf-8", newline="") as f:
        return {r["county_fips"]: r["county_name"] for r in csv.DictReader(f)}


def build_index(dataset_rows, county_names):
    """dedupe key -> [(id, date_adopted)] for every dataset row, in row order."""
    idx = {}
    for r in dataset_rows:
        county = county_names.get(r.get("county_fips", ""), "")
        k = dedupe_key(r["state"], r["name"], county, r["level"], r["type"])
        idx.setdefault(k, []).append((r["id"], r.get("date_adopted", "") or ""))
    return idx


def unique_id(candidate_id, existing_ids):
    existing = set(existing_ids)
    if candidate_id not in existing:
        return candidate_id
    n = 2
    while f"{candidate_id}-{n}" in existing:
        n += 1
    return f"{candidate_id}-{n}"


def matching_ids(candidate, index, types=None, any_year=False):
    """Ids of indexed rows with the candidate's key, under each of `types` (default: the
    candidate's own `type`), in index order without repeats; None when the county is
    blank (see classify). `any_year` drops the adoption-year agreement rule."""
    level = LEVEL.get(candidate.get("jurisdiction_level", ""), candidate.get("jurisdiction_level", ""))
    county = (candidate.get("county") or "").strip()
    if not county and level not in ("state", "utility"):
        return None
    year = "" if any_year else (candidate.get("date_adopted") or "")[:4]
    out = []
    for t in types or (candidate.get("type", ""),):
        key = dedupe_key(candidate.get("state", ""), candidate.get("jurisdiction_name", ""), county, level, t)
        out += [i for i, d in index.get(key, []) if not (d and year and d[:4] != year) and i not in out]
    return out


def classify(candidate, index):
    """'new' | 'match:<existing id>' | 'lead:<reason>' for a candidate dict.

    A blank county is a lead (the key would collide across same-named townships),
    except for state-level and utility candidates, which have no single county.
    Only rows whose adoption year agrees with the candidate's (or where either date
    is blank) match, as build_research.py does.
    """
    hits = matching_ids(candidate, index)
    if hits is None:
        return "lead:no county"
    return f"match:{hits[0]}" if hits else "new"
