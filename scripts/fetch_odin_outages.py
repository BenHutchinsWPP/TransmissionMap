#!/usr/bin/env python3
"""Fetch a server-side-aggregated snapshot of live US power outages from the
ORNL ODIN Opendatasoft portal (Opendatasoft explore API, county+utility
aggregation).

Single upstream call — server does the group_by/sum/count, so we never
paginate and never fetch per-outage geometry. `communitydescriptor` is a
5-digit county FIPS string; `out` is customers-affected (summed);
`n` is incident count. Rows come back per (county, utility); this script
aggregates them client-side into `counties[fips] = [out, n, utils]` where
`out`/`n` are the county totals and `utils` is a list of
`[displayName, out, n, since]` sorted by `out` descending (`since` = earliest
`reportedstarttime` in the group, ISO string or null — sparse upstream).

Usage:
  python3 scripts/fetch_odin_outages.py -o data/layers/odin_outages.json

Auth: reads ODIN_ODS_APIKEY and sends it as `Authorization: Apikey <KEY>`
when present. GitHub-hosted runners share pooled IPs and Opendatasoft's
anonymous quota is per-IP, so CI must pass --require-key (making a missing
key a hard failure) and rely on our account-billed key; local dev can run
keyless (anonymous, with a loud warning).

Self-check (no network):
  python3 scripts/fetch_odin_outages.py --self-check
"""

import argparse
import json
import os
import re
import socket
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone

# GitHub-hosted runners sometimes have a broken/unreachable IPv6 route while
# IPv4 works fine; urllib picks whichever getaddrinfo() returns first, which
# is often the AAAA record, causing "Network is unreachable" (errno 101).
# Force IPv4-only resolution everywhere in this process.
_orig_getaddrinfo = socket.getaddrinfo


def _ipv4_only_getaddrinfo(host, port, family=0, type=0, proto=0, flags=0):
    return _orig_getaddrinfo(host, port, socket.AF_INET, type, proto, flags)


socket.getaddrinfo = _ipv4_only_getaddrinfo

# ── ODIN (Opendatasoft) endpoints ─────────────────────────────────────────────
ODIN_BASE = "https://ornl.opendatasoft.com/api/explore/v2.1/catalog/datasets/odin-real-time-outages-county"
# Per-incident records via the EXPORT endpoint (the /records endpoint hard-caps
# at 100 rows; /exports/json returns the whole dataset — ~300 rows, ~80 KB).
# We fetch the individual outage records ONCE and derive the county/utility
# aggregates from them client-side (see build_snapshot), so the map choropleth
# and the popup incident cards come from the same instant and can never disagree.
# The per-record display fields are shipped verbatim so the frontend never has
# to hit ODIN itself (no per-browser CORS call, no per-IP quota exposure).
ODIN_RECORD_FIELDS = (
    "communitydescriptor,name,cause,causekind,metersaffected,customersrestored,"
    "reportedstarttime,estimatedrestorationtime,statuskind"
)
ODIN_RECORDS_URL = (
    f"{ODIN_BASE}/exports/json"
    f"?select={ODIN_RECORD_FIELDS}"
    "&order_by=metersaffected%20desc"
)
ODIN_METADATA_URL = ODIN_BASE

# Per-record fields shipped to the frontend for the popup incident cards (the
# `select` above also pulls communitydescriptor/name/metersaffected/
# reportedstarttime, which the aggregation consumes; only these reach `records`).
CARD_FIELDS = (
    "name", "cause", "causekind", "metersaffected", "customersrestored",
    "reportedstarttime", "estimatedrestorationtime", "statuskind",
)

FIPS_RE = re.compile(r"^\d{5}$")
UTILITY_ID_SUFFIX_RE = re.compile(r",\d+$")

# The county tileset (county_boundaries.pmtiles) is Census GENZ2024 vintage.
# These FIPS codes are pre-2022/2019 and will never match a GENZ2024 GEOID, so
# rows keyed to them silently fail the frontend feature-state join (no crash,
# just an unpainted county) — flag them instead of guessing:
#   - Connecticut's 8 legacy counties (09001-09015, odd only) were replaced by
#     planning regions 09110-09190 in the 2022 Census vintage.
#   - Alaska's Valdez-Cordova census area (02261) was split into Chugach
#     (02063) and Copper River (02066) in 2019.
LEGACY_FIPS = frozenset({
    "09001", "09003", "09005", "09007", "09009", "09011", "09013", "09015",
    "02261",
})


# ── Fetch helper ──────────────────────────────────────────────────────────────

def _fetch_json(url: str, headers: dict) -> tuple[object, dict]:
    """Fetch JSON with retry (3 attempts, backoff) on network error / 429 / 5xx.
    Returns (parsed_json, response_headers). parsed_json is a dict for the
    metadata endpoint and a list for the /exports/json records endpoint."""
    last_err = None
    for attempt in range(3):
        try:
            req = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(req, timeout=60) as r:
                data = json.loads(r.read().decode("utf-8"))
                return data, dict(r.headers)
        except urllib.error.HTTPError as e:
            last_err = e
            if e.code == 429 or 500 <= e.code < 600:
                if attempt < 2:
                    print(f"  retrying {url} after HTTP {e.code}", file=sys.stderr)
                    time.sleep(2 ** attempt)
                    continue
            raise
        except Exception as e:
            last_err = e
            if attempt < 2:
                print(f"  retrying {url} after {e}", file=sys.stderr)
                time.sleep(2 ** attempt)
                continue
            raise
    raise last_err  # unreachable in practice


# ── Pure aggregation/validation (self-check target) ─────────────────────────

def build_snapshot(results: list[dict], source_modified: str | None, now: datetime) -> dict:
    """Validate + shape the raw per-incident `results` rows into the output
    snapshot dict. Each row is ONE outage record; the county/utility aggregates
    that drive the choropleth are derived here from the same rows that populate
    the popup incident cards, so the two can never disagree.
    Raises ValueError if `results` is empty (treated as upstream failure —
    a genuine zero-outage nationwide snapshot is essentially impossible)."""
    if not results:
        raise ValueError("empty results — treating as upstream failure, not zero outages")

    # fips -> [out, n, {displayName: [out, n, since]}] while accumulating; the
    # utils dict is converted to a sorted list at the end. `since` is the
    # earliest reportedstarttime (ISO string) or None — ~31% of upstream
    # records lack it, so None is a normal value, not an error.
    counties: dict[str, list] = {}
    # fips -> [ {CARD_FIELDS…}, … ] per-incident records for the popup pager,
    # kept in the metersaffected-desc order the upstream `order_by` gives us.
    records: dict[str, list] = {}
    total = 0
    dropped = 0
    legacy_fips_seen: set[str] = set()
    legacy_fips_count = 0
    for row in results:
        fips = row.get("communitydescriptor")
        if not isinstance(fips, str) or not FIPS_RE.match(fips):
            print(f"  WARNING: skipping row with bad FIPS {fips!r}", file=sys.stderr)
            dropped += 1
            continue
        if fips in LEGACY_FIPS:
            legacy_fips_count += 1
            if fips not in legacy_fips_seen:
                legacy_fips_seen.add(fips)
                print(f"  WARNING: county row uses pre-2022 legacy FIPS {fips!r} "
                      "(CT planning region / AK Valdez-Cordova split) — will not "
                      "paint on map", file=sys.stderr)
        # Each record contributes its own customers-out and counts as one incident.
        out = row.get("metersaffected") or 0
        since = row.get("reportedstarttime") or None

        name = row.get("name")
        if not name:
            display_name = "Unknown utility"
        else:
            display_name = UTILITY_ID_SUFFIX_RE.sub("", name)

        county = counties.setdefault(fips, [0, 0, {}])
        county[0] += out
        county[1] += 1
        util = county[2].setdefault(display_name, [0, 0, None])
        util[0] += out
        util[1] += 1
        # min of non-null ISO timestamps (lexicographic min == chronological min).
        if since and (util[2] is None or since < util[2]):
            util[2] = since

        # Ship the raw per-record display fields verbatim for the popup cards.
        records.setdefault(fips, []).append({k: row.get(k) for k in CARD_FIELDS})

        total += out

    for fips, county in counties.items():
        utils = sorted(
            ([name, u[0], u[1], u[2]] for name, u in county[2].items()),
            key=lambda u: u[1],
            reverse=True,
        )
        county[2] = utils

    return {
        "generated_utc": now.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "source_modified": source_modified,
        "county_count": len(counties),
        "total_customers_out": total,
        "dropped": dropped,
        "legacy_fips": legacy_fips_count,
        "counties": dict(sorted(counties.items())),
        "records": dict(sorted(records.items())),
    }


# ── Self-check ────────────────────────────────────────────────────────────────

def _self_check():
    now = datetime(2026, 7, 8, 23, 59, 0, tzinfo=timezone.utc)

    # Each input row is ONE outage record; aggregates are derived from them.
    # Helper to write a per-incident row with the display fields the cards use.
    def rec(fips, name, out, since=None, cause=None, status=None):
        return {"communitydescriptor": fips, "name": name, "metersaffected": out,
                "reportedstarttime": since, "cause": cause, "causekind": None,
                "customersrestored": None, "estimatedrestorationtime": None,
                "statuskind": status}

    # Normal case: FIPS filtering + total sum + multi-utility aggregation.
    # 48201: CenterPoint with 2 incidents (3000 earliest, 0 later) + 1 coop incident.
    results = [
        rec("48201", "CENTERPOINT ENERGY,8901", 3000, "2026-07-08T18:55:00+00:00", cause="Storm"),
        rec("48201", "CENTERPOINT ENERGY,8901", 0, "2026-07-08T20:00:00+00:00"),
        rec("48201", "FOO, BAR COOP,123", 208),  # no since
        # 41033: single utility, single incident.
        rec("41033", "PACIFIC POWER,456", 2367, "2026-07-08T15:00:00+00:00"),
        rec("bad", "SOMEUTIL,1", 999),  # invalid FIPS, must be skipped
        # None name -> "Unknown utility".
        rec("06001", None, 50),
        # Legacy pre-2022 CT FIPS: kept (not dropped) but counted + warned.
        rec("09001", "LEGACY UTIL,1", 12),
    ]
    snap = build_snapshot(results, "2026-07-08T23:45:00Z", now)
    assert snap["county_count"] == 4, snap
    assert snap["total_customers_out"] == 3000 + 0 + 208 + 2367 + 50 + 12, snap
    assert "bad" not in snap["counties"], snap
    assert snap["dropped"] == 1, snap  # only the "bad" FIPS row
    assert snap["legacy_fips"] == 1, snap  # the 09001 row
    assert snap["counties"]["09001"] == [12, 1, [["LEGACY UTIL", 12, 1, None]]], snap["counties"]["09001"]

    assert snap["counties"]["48201"][0] == 3208, snap
    assert snap["counties"]["48201"][1] == 3, snap  # 3 incident rows
    utils_48201 = snap["counties"]["48201"][2]
    assert utils_48201 == [
        ["CENTERPOINT ENERGY", 3000, 2, "2026-07-08T18:55:00+00:00"],
        ["FOO, BAR COOP", 208, 1, None],
    ], utils_48201  # sorted by incident count desc; earliest since kept

    assert snap["counties"]["41033"] == [2367, 1, [["PACIFIC POWER", 2367, 1, "2026-07-08T15:00:00+00:00"]]], \
        snap["counties"]["41033"]

    assert snap["counties"]["06001"] == [50, 1, [["Unknown utility", 50, 1, None]]], snap["counties"]["06001"]

    # records: per-incident cards, verbatim display fields, metersaffected order preserved.
    assert list(snap["records"].keys()) == sorted(snap["records"].keys()), "record keys must be sorted"
    assert [r["metersaffected"] for r in snap["records"]["48201"]] == [3000, 0, 208], snap["records"]["48201"]
    assert snap["records"]["48201"][0]["cause"] == "Storm", snap["records"]["48201"][0]
    assert set(snap["records"]["48201"][0].keys()) == set(CARD_FIELDS), snap["records"]["48201"][0]
    assert "bad" not in snap["records"], snap["records"]  # dropped FIPS carries no cards

    assert list(snap["counties"].keys()) == sorted(snap["counties"].keys()), "keys must be sorted"
    assert snap["source_modified"] == "2026-07-08T23:45:00Z"
    assert snap["generated_utc"] == "2026-07-08T23:59:00Z"

    # Duplicate displayName within a county (same utility, e.g. two id variants
    # collapsing to the same stripped name) must merge, not create two entries.
    dup_results = [
        rec("48201", "SAME UTIL,111", 100, "2026-07-08T20:00:00+00:00"),
        rec("48201", "SAME UTIL,222", 50, "2026-07-08T14:30:00+00:00"),  # earlier — must win the merge
    ]
    dup_snap = build_snapshot(dup_results, None, now)
    assert dup_snap["counties"]["48201"] == \
        [150, 2, [["SAME UTIL", 150, 2, "2026-07-08T14:30:00+00:00"]]], dup_snap["counties"]["48201"]
    # Clean input (no bad/legacy FIPS) -> both counters present and zero.
    assert dup_snap["dropped"] == 0, dup_snap
    assert dup_snap["legacy_fips"] == 0, dup_snap

    # source_modified missing → None, must not raise.
    snap2 = build_snapshot(results, None, now)
    assert snap2["source_modified"] is None

    # Empty input → hard failure.
    try:
        build_snapshot([], "2026-07-08T23:45:00Z", now)
        raise AssertionError("expected ValueError on empty results")
    except ValueError:
        pass

    print("self-check OK", file=sys.stderr)


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("-o", "--output", default="data/layers/odin_outages.json")
    ap.add_argument("--require-key", action="store_true",
                    help="hard-fail if ODIN_ODS_APIKEY is missing/empty (set in CI)")
    ap.add_argument("--self-check", action="store_true",
                    help="run offline aggregation/validation checks and exit")
    args = ap.parse_args()

    if args.self_check:
        _self_check()
        return

    key = os.environ.get("ODIN_ODS_APIKEY")
    if key:
        headers = {"Authorization": f"Apikey {key}"}
    else:
        if args.require_key:
            print("ERROR: ODIN_ODS_APIKEY is required (--require-key) but not set", file=sys.stderr)
            sys.exit(1)
        print("WARNING: ODIN_ODS_APIKEY not set — fetching anonymously "
              "(shared per-IP quota; fine for local dev, not for CI)", file=sys.stderr)
        headers = {}

    print("Fetching ODIN per-incident outage records…", file=sys.stderr)
    try:
        data, resp_headers = _fetch_json(ODIN_RECORDS_URL, headers)
    except Exception as e:
        print(f"ERROR: ODIN records fetch failed: {e}", file=sys.stderr)
        sys.exit(1)

    remaining = resp_headers.get("X-RateLimit-Remaining")
    limit = resp_headers.get("X-RateLimit-Limit")
    print(f"  X-RateLimit-Remaining={remaining} X-RateLimit-Limit={limit}", file=sys.stderr)

    # The /exports/json endpoint returns a bare JSON array of records.
    results = data if isinstance(data, list) else (data.get("results") or [])
    print(f"  {len(results)} incident records in raw response", file=sys.stderr)

    print("Fetching ODIN dataset metadata (freshness)…", file=sys.stderr)
    source_modified = None
    try:
        meta, _ = _fetch_json(ODIN_METADATA_URL, headers)
        source_modified = meta.get("metadata", {}).get("default", {}).get("modified")
    except Exception as e:
        print(f"  WARNING: metadata fetch failed (non-fatal): {e}", file=sys.stderr)

    now = datetime.now(timezone.utc)
    try:
        snapshot = build_snapshot(results, source_modified, now)
    except ValueError as e:
        print(f"ERROR: {e} — refusing to write (keeping last good snapshot)", file=sys.stderr)
        sys.exit(1)

    with open(args.output, "w") as f:
        json.dump(snapshot, f, separators=(",", ":"))

    print(
        f"Wrote {snapshot['county_count']} counties "
        f"({snapshot['total_customers_out']} customers out) → {args.output}",
        file=sys.stderr,
    )

    # GH Actions annotations are parsed from stdout only, not stderr.
    if os.environ.get("GITHUB_ACTIONS"):
        if snapshot["dropped"] > 0:
            print(f"::warning::fetch_odin_outages: {snapshot['dropped']} row(s) "
                  "dropped (bad communitydescriptor)")
        if snapshot["legacy_fips"] > 0:
            print(f"::warning::fetch_odin_outages: {snapshot['legacy_fips']} "
                  "county row(s) use pre-2022 FIPS (CT/AK) — will not paint on map")


if __name__ == "__main__":
    main()
