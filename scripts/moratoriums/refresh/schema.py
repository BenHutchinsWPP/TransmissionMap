"""Research CSV layouts, vocabularies, row validation and deterministic writers.

Role: header constants for the weekly research files (moratoriums, bans,
utilities, updates) and the read-only published dataset, plus `write_rows`
(rows sorted by id, "\\n" line endings, UTF-8, exact header).
Dependencies: stdlib only; imported by verify.py and the run orchestrator.
"""
import csv
from pathlib import Path

MORATORIUMS = ["id", "jurisdiction_name", "jurisdiction_level", "state", "county", "type", "sectors", "status", "date_adopted", "date_expires", "duration", "summary", "source_urls", "source_quality", "upstream_id", "kind", "notes"]
BANS = ["id", "jurisdiction_name", "jurisdiction_level", "state", "county", "type", "sectors", "status", "date_adopted", "date_expires", "duration", "summary", "source_urls", "source_quality", "in_upstream", "notes"]
UTILITIES = ["id", "jurisdiction_name", "jurisdiction_level", "state", "service_area_counties", "type", "sectors", "status", "date_adopted", "date_expires", "duration", "summary", "source_urls", "source_quality", "in_upstream", "notes", "eia_id", "ba_code"]
UPDATES = ["file", "id", "field", "old", "new", "source_urls", "source_quality", "notes"]
# Read-only: the published dataset/moratoriums.csv.
DATASET = ["id", "level", "name", "state", "county_fips", "place_geoid", "lat", "lon", "type", "scope", "status", "date_adopted", "date_expires", "duration_days", "extended", "summary", "source_urls", "upstream_id", "verify", "date_uncertain", "last_verified", "eia_id"]

HEADERS = {"moratoriums": MORATORIUMS, "bans": BANS, "utilities": UTILITIES, "updates": UPDATES}

STATUSES = ("active", "extended", "pending", "expired", "lifted", "replaced", "withdrawn")
SOURCE_QUALITIES = ("primary", "secondary", "snippet_only")
KINDS = ("new", "correction", "extension", "lift", "replacement")
TYPES = ("temporary moratorium", "permanent ban", "interconnection pause", "service pause", "load cap", "executive order", "permit pause")


def validate_row(row, kind="moratoriums"):
    """Problems with one research row (empty list when clean). `kind` names the file."""
    header = HEADERS[kind]
    problems = [f"unknown column: {k}" for k in row if k not in header]
    if not row.get("id"):
        problems.append("id missing")
    if kind == "updates":
        if not row.get("file"):
            problems.append("file missing")
        if not row.get("field"):
            problems.append("field missing")
        vocab = (("source_quality", SOURCE_QUALITIES),)
    else:
        for col in ("jurisdiction_name", "jurisdiction_level", "state", "source_urls"):
            if not row.get(col):
                problems.append(f"{col} missing")
        vocab = (("status", STATUSES), ("source_quality", SOURCE_QUALITIES), ("type", TYPES))
        if kind == "moratoriums":
            vocab += (("kind", KINDS),)
    for col, allowed in vocab:
        v = row.get(col, "")
        if v and v not in allowed:
            problems.append(f"{col} not in vocabulary: {v}")
        elif not v and kind != "updates":
            problems.append(f"{col} missing")
    return problems


def write_rows(path, kind, rows):
    """Write `rows` (dicts) sorted by id with the exact header for `kind`."""
    header = HEADERS[kind]
    with open(Path(path), "w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=header, lineterminator="\n")
        w.writeheader()
        for r in sorted(rows, key=lambda r: (r["id"], r.get("file", ""), r.get("field", ""))):
            extra = set(r) - set(header)
            if extra:
                raise ValueError(f"unknown columns for {kind}: {sorted(extra)}")
            w.writerow({k: r.get(k, "") for k in header})
