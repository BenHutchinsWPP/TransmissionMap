#!/usr/bin/env python3
"""Fetch NWS active alerts (api.weather.gov) → curated, polygon-only GeoJSON.

Phase 1 scope (see HANDOFF.md "NWS Weather Alerts" section, "Design decisions
(locked)"): only a curated allowlist of events is kept, grouped server-side
into a `_group` prop (convective/flood/fire/heat/wind/winter/tropical/other).
Alerts with null geometry are dropped (heat/red-flag alerts are forecast-zone
only) — the count of curated-but-dropped alerts is logged per group so a
future phase-2 county join can pick them up via geocode.SAME.

Usage (dev + GH Actions — fetches live):
  python3 scripts/fetch_nws_alerts.py -o data/layers/nws_alerts.geojson

Usage (offline — pass a pre-downloaded `alerts/active` response instead of
fetching):
  python3 scripts/fetch_nws_alerts.py --input saved_response.json -o output.geojson
"""

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone

NWS_ALERTS_URL = "https://api.weather.gov/alerts/active?status=actual"
USER_AGENT = "TransmissionMap (benrhutchins@gmail.com)"

# ── Curated event allowlist → _group (HANDOFF "Design decisions (locked)") ───
EVENT_GROUPS: dict[str, str] = {
    # convective
    "Tornado Warning": "convective",
    "Tornado Watch": "convective",
    "Severe Thunderstorm Warning": "convective",
    "Severe Thunderstorm Watch": "convective",
    # flood
    "Flash Flood Warning": "flood",
    "Flash Flood Watch": "flood",
    "Flood Warning": "flood",
    "Flood Watch": "flood",
    # fire
    "Red Flag Warning": "fire",
    "Fire Weather Watch": "fire",
    "Extreme Fire Danger": "fire",
    # heat
    "Extreme Heat Warning": "heat",
    "Extreme Heat Watch": "heat",
    "Heat Advisory": "heat",
    # wind
    "High Wind Warning": "wind",
    "High Wind Watch": "wind",
    "Extreme Wind Warning": "wind",
    "Dust Storm Warning": "wind",
    "Blowing Dust Warning": "wind",
    # winter
    "Ice Storm Warning": "winter",
    "Blizzard Warning": "winter",
    "Extreme Cold Warning": "winter",
    "Extreme Cold Watch": "winter",
    "Freeze Warning": "winter",
    "Snow Squall Warning": "winter",
    # tropical
    "Hurricane Warning": "tropical",
    "Hurricane Watch": "tropical",
    "Tropical Storm Warning": "tropical",
    "Tropical Storm Watch": "tropical",
    "Storm Surge Warning": "tropical",
    "Storm Surge Watch": "tropical",
    # other
    "Nuclear Power Plant Warning": "other",
    "Radiological Hazard Warning": "other",
    "Ashfall Warning": "other",
}

KEPT_PROPS = [
    "event", "severity", "certainty", "urgency", "headline",
    "onset", "ends", "expires", "areaDesc", "senderName", "id",
]


def _fetch_json(url: str) -> dict:
    req = urllib.request.Request(
        url,
        headers={"User-Agent": USER_AGENT, "Accept": "application/geo+json"},
    )
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                return json.load(r)
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as e:
            if attempt == 2:
                raise
            wait = 2 ** attempt
            print(f"  retrying {url} after {e} (sleep {wait}s)", file=sys.stderr)
            time.sleep(wait)
    raise AssertionError("unreachable")


def fetch_all_alerts(start_url: str) -> list[dict]:
    """Follow pagination.next until absent, concatenating features."""
    all_features: list[dict] = []
    url = start_url
    page = 1
    while url:
        print(f"  fetching page {page}…", file=sys.stderr)
        data = _fetch_json(url)
        feats = data.get("features", [])
        all_features.extend(feats)
        url = (data.get("pagination") or {}).get("next")
        # The API can hand back a `next` cursor even on the final page (empty
        # follow-up) — stop on an empty page / page cap so we never loop forever.
        if not feats or page >= 10:
            break
        page += 1
    return all_features


def _round_coords(coords):
    """Recursively round nested coordinate arrays to 4 decimals."""
    if isinstance(coords, (int, float)):
        return round(coords, 4)
    return [_round_coords(c) for c in coords]


def curate(features: list[dict], generated_utc: str) -> tuple[list[dict], dict, dict]:
    """Filter to allowlisted events with non-null geometry. Returns
    (kept_features, kept_counts_by_group, dropped_null_geom_counts_by_group)."""
    kept: list[dict] = []
    kept_counts: dict[str, int] = {}
    dropped_counts: dict[str, int] = {}

    for f in features:
        props = f.get("properties") or {}
        event = props.get("event")
        group = EVENT_GROUPS.get(event)
        if group is None:
            continue
        if not f.get("geometry"):
            dropped_counts[group] = dropped_counts.get(group, 0) + 1
            continue
        geom = dict(f["geometry"])
        geom["coordinates"] = _round_coords(geom["coordinates"])
        out_props = {k: props.get(k) for k in KEPT_PROPS}
        out_props["_group"] = group
        out_props["generated_utc"] = generated_utc
        kept.append({"type": "Feature", "geometry": geom, "properties": out_props})
        kept_counts[group] = kept_counts.get(group, 0) + 1

    return kept, kept_counts, dropped_counts


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", help="pre-downloaded alerts/active JSON; omit to fetch live")
    ap.add_argument("-o", "--output", default="data/layers/nws_alerts.geojson")
    args = ap.parse_args()

    generated_utc = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    if args.input:
        print(f"Reading saved response {args.input}…", file=sys.stderr)
        with open(args.input) as f:
            data = json.load(f)
        features = data.get("features", [])
        # Still follow pagination.next if the saved sample happens to carry one.
        next_url = (data.get("pagination") or {}).get("next")
        if next_url:
            features += fetch_all_alerts(next_url)
    else:
        print("Fetching NWS active alerts…", file=sys.stderr)
        try:
            features = fetch_all_alerts(NWS_ALERTS_URL)
        except Exception as e:
            print(f"ERROR: fetch failed after retries: {e}", file=sys.stderr)
            sys.exit(1)

    total_fetched = len(features)
    kept, kept_counts, dropped_counts = curate(features, generated_utc)

    for group in sorted(set(kept_counts) | set(dropped_counts)):
        print(
            f"  {group}: kept {kept_counts.get(group, 0)}, "
            f"dropped (null geometry) {dropped_counts.get(group, 0)}",
            file=sys.stderr,
        )

    fc = {"type": "FeatureCollection", "features": kept}

    out_dir = os.path.dirname(args.output)
    if out_dir:
        os.makedirs(out_dir, exist_ok=True)
    tmp_path = f"{args.output}.tmp"
    with open(tmp_path, "w") as f:
        json.dump(fc, f, separators=(",", ":"))
    os.replace(tmp_path, args.output)

    total_kept = len(kept)
    total_dropped = sum(dropped_counts.values())
    size = os.path.getsize(args.output)
    print(
        f"Wrote {total_kept} alerts (fetched {total_fetched}, "
        f"dropped-null-geom {total_dropped}) → {args.output} ({size} bytes)",
        file=sys.stderr,
    )


if __name__ == "__main__":
    main()
