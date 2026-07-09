#!/usr/bin/env python3
"""Fetch a server-side-aggregated snapshot of live US power outages from the
ORNL ODIN Opendatasoft portal (Opendatasoft explore API, county aggregation).

Single upstream call — server does the group_by/sum/count, so we never
paginate and never fetch per-outage geometry. `communitydescriptor` is a
5-digit county FIPS string; `out` is customers-affected (summed);
`n` is incident count.

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
ODIN_RECORDS_URL = (
    f"{ODIN_BASE}/records"
    "?select=communitydescriptor,sum(metersaffected)%20as%20out,count(*)%20as%20n"
    "&group_by=communitydescriptor"
    "&order_by=out%20desc"
    "&limit=-1"
)
ODIN_METADATA_URL = ODIN_BASE

FIPS_RE = re.compile(r"^\d{5}$")


# ── Fetch helper ──────────────────────────────────────────────────────────────

def _fetch_json(url: str, headers: dict) -> tuple[dict, dict]:
    """Fetch JSON with retry (3 attempts, backoff) on network error / 429 / 5xx.
    Returns (parsed_json, response_headers)."""
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
    """Validate + shape the raw `results` rows into the output snapshot dict.
    Raises ValueError if `results` is empty (treated as upstream failure —
    a genuine zero-outage nationwide snapshot is essentially impossible)."""
    if not results:
        raise ValueError("empty results — treating as upstream failure, not zero outages")

    counties: dict[str, list] = {}
    total = 0
    for row in results:
        fips = row.get("communitydescriptor")
        if not isinstance(fips, str) or not FIPS_RE.match(fips):
            print(f"  WARNING: skipping row with bad FIPS {fips!r}", file=sys.stderr)
            continue
        out = row.get("out") or 0
        n = row.get("n") or 0
        counties[fips] = [out, n]
        total += out

    return {
        "generated_utc": now.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "source_modified": source_modified,
        "county_count": len(counties),
        "total_customers_out": total,
        "counties": dict(sorted(counties.items())),
    }


# ── Self-check ────────────────────────────────────────────────────────────────

def _self_check():
    now = datetime(2026, 7, 8, 23, 59, 0, tzinfo=timezone.utc)

    # Normal case: FIPS filtering + total sum.
    results = [
        {"communitydescriptor": "48201", "out": 3208, "n": 167},
        {"communitydescriptor": "41033", "out": 2367, "n": 8},
        {"communitydescriptor": "bad", "out": 999, "n": 1},  # invalid FIPS, must be skipped
    ]
    snap = build_snapshot(results, "2026-07-08T23:45:00Z", now)
    assert snap["county_count"] == 2, snap
    assert snap["total_customers_out"] == 3208 + 2367, snap
    assert "bad" not in snap["counties"], snap
    assert snap["counties"]["48201"] == [3208, 167], snap
    assert snap["counties"]["41033"] == [2367, 8], snap
    assert list(snap["counties"].keys()) == sorted(snap["counties"].keys()), "keys must be sorted"
    assert snap["source_modified"] == "2026-07-08T23:45:00Z"
    assert snap["generated_utc"] == "2026-07-08T23:59:00Z"

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

    print("Fetching ODIN county outage aggregates…", file=sys.stderr)
    try:
        data, resp_headers = _fetch_json(ODIN_RECORDS_URL, headers)
    except Exception as e:
        print(f"ERROR: ODIN records fetch failed: {e}", file=sys.stderr)
        sys.exit(1)

    remaining = resp_headers.get("X-RateLimit-Remaining")
    limit = resp_headers.get("X-RateLimit-Limit")
    print(f"  X-RateLimit-Remaining={remaining} X-RateLimit-Limit={limit}", file=sys.stderr)

    results = data.get("results") or []
    print(f"  {len(results)} counties in raw response", file=sys.stderr)

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


if __name__ == "__main__":
    main()
