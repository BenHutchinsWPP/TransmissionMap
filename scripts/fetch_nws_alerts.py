#!/usr/bin/env python3
"""Fetch NWS active alerts (api.weather.gov) + ECCC active alerts (MSC GeoMet)
→ curated GeoJSON. See HANDOFF.md "PHASE 2 PLAN" Stage 0 findings for the
locked ECCC mapping/recipe this file implements.

Phase 1 scope (see HANDOFF.md "NWS Weather Alerts" section, "Design decisions
(locked)"): only a curated allowlist of events is kept, grouped server-side
into a `_group` prop (convective/flood/fire/heat/wind/winter/tropical/other).

Phase 2 additions:
- Curated US alerts with null geometry (forecast-zone-only, e.g. Heat
  Advisory/Red Flag Warning) are no longer dropped — they're emitted into a
  top-level `zone_alerts` sidecar array (parsed from `affectedZones` +
  `geocode.SAME`) for a frontend zone-polygon join. Old frontends ignore
  unknown top-level keys.
- Canadian alerts (ECCC / MSC GeoMet, real polygon geometry) are merged into
  the same `features` array with `country: "CA"` (US features get
  `country: "US"`). ECCC fetch/parse failure degrades to US-only (never a
  hard fail) and is recorded via a `feed_status` dict on feature[0]'s
  properties, mirroring the `feed_status` pattern in fetch_wildfire_live.py
  (dict of sub-key → "ok"/"failed", read by assets/ui/ui-legends.ts).

Usage (dev + GH Actions — fetches live):
  python3 scripts/fetch_nws_alerts.py -o data/layers/nws_alerts.geojson

Usage (offline — pass pre-downloaded responses instead of fetching):
  python3 scripts/fetch_nws_alerts.py --input saved_nws.json \\
      --input-eccc saved_eccc.json -o output.geojson
"""

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone

from geo_common import write_json_atomic

NWS_ALERTS_URL = "https://api.weather.gov/alerts/active?status=actual"
ECCC_ALERTS_URL = "https://api.weather.gc.ca/collections/weather-alerts/items?f=json&limit=1000"
USER_AGENT = "TransmissionMap (benrhutchins@gmail.com)"

# ── Curated event allowlist → _group (HANDOFF "Design decisions (locked)") ───
EVENT_GROUPS: dict[str, str] = {
    # convective
    "Tornado Warning": "convective",
    "Tornado Watch": "convective",
    "Severe Thunderstorm Warning": "convective",
    "Severe Thunderstorm Watch": "convective",
    "Special Marine Warning": "convective",
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
    "Gale Warning": "wind",
    "Gale Watch": "wind",
    "Storm Warning": "wind",
    "Storm Watch": "wind",
    "Hurricane Force Wind Warning": "wind",
    "Hurricane Force Wind Watch": "wind",
    # winter
    "Ice Storm Warning": "winter",
    "Blizzard Warning": "winter",
    "Extreme Cold Warning": "winter",
    "Extreme Cold Watch": "winter",
    "Freeze Warning": "winter",
    "Snow Squall Warning": "winter",
    "Winter Storm Warning": "winter",
    "Winter Storm Watch": "winter",
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

# ── ECCC (MSC GeoMet) alert_name_en → _group (HANDOFF Stage 0, locked) ───────
# Matched on lowercase alert_name_en. Excluded by design (parity with US
# curation): special weather statement, air quality warning.
ECCC_EVENT_GROUPS: dict[str, str] = {
    # convective
    "tornado warning": "convective",
    "tornado watch": "convective",
    "severe thunderstorm warning": "convective",
    "severe thunderstorm watch": "convective",
    # flood
    "rainfall warning": "flood",
    "flood warning": "flood",
    # heat
    "heat warning": "heat",
    # wind
    "wind warning": "wind",
    "arctic outflow warning": "wind",
    "dust storm warning": "wind",
    # winter
    "blizzard warning": "winter",
    "blizzard watch": "winter",
    "winter storm warning": "winter",
    "winter storm watch": "winter",
    "snowfall warning": "winter",
    "snowfall watch": "winter",
    "snow squall warning": "winter",
    "snow squall watch": "winter",
    "freezing rain warning": "winter",
    "extreme cold warning": "winter",
    "flash freeze warning": "winter",
    # tropical
    "hurricane warning": "tropical",
    "hurricane watch": "tropical",
    "tropical storm warning": "tropical",
    "tropical storm watch": "tropical",
    "storm surge warning": "tropical",
    "storm surge watch": "tropical",
}

KEPT_PROPS = [
    "event", "severity", "certainty", "urgency", "headline",
    "onset", "ends", "expires", "areaDesc", "senderName", "id",
]

# Marine area codes (R6): marine UGCs are served under /zones/forecast/ too,
# but need a distinct type ("marine") since they join a separate marine-zone
# tileset (key prefix "m"), not the land-only forecast-zone tileset.
MARINE_UGC_PREFIXES = {
    "AM", "AN", "GM", "PZ", "PK", "PH", "PM", "PS",
    "LE", "LH", "LM", "LO", "LC", "LS", "SL",
}

# State/territory abbrev → FIPS (R5): lets county UGCs (SSC###) derive a
# county FIPS when geocode.SAME is absent (SAME is not a required CAP field).
STATE_FIPS = {
    "AL": "01", "AK": "02", "AZ": "04", "AR": "05", "CA": "06", "CO": "08",
    "CT": "09", "DE": "10", "DC": "11", "FL": "12", "GA": "13", "HI": "15",
    "ID": "16", "IL": "17", "IN": "18", "IA": "19", "KS": "20", "KY": "21",
    "LA": "22", "ME": "23", "MD": "24", "MA": "25", "MI": "26", "MN": "27",
    "MS": "28", "MO": "29", "MT": "30", "NE": "31", "NV": "32", "NH": "33",
    "NJ": "34", "NM": "35", "NY": "36", "NC": "37", "ND": "38", "OH": "39",
    "OK": "40", "OR": "41", "PA": "42", "RI": "44", "SC": "45", "SD": "46",
    "TN": "47", "TX": "48", "UT": "49", "VT": "50", "VA": "51", "WA": "53",
    "WV": "54", "WI": "55", "WY": "56",
    "AS": "60", "GU": "66", "MP": "69", "PR": "72", "VI": "78",
}


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


def fetch_all_eccc(start_url: str) -> list[dict]:
    """Follow OGC API Features `links` rel="next" until absent."""
    all_features: list[dict] = []
    url = start_url
    page = 1
    while url:
        print(f"  fetching ECCC page {page}…", file=sys.stderr)
        data = _fetch_json(url)
        feats = data.get("features", [])
        all_features.extend(feats)
        next_url = None
        for link in data.get("links") or []:
            if link.get("rel") == "next":
                next_url = link.get("href")
                break
        url = next_url
        if not feats or page >= 10:
            break
        page += 1
    return all_features


def _round_coords(coords):
    """Recursively round nested coordinate arrays to 4 decimals."""
    if isinstance(coords, (int, float)):
        return round(coords, 4)
    return [_round_coords(c) for c in coords]


def _parse_zone_url(url: str) -> tuple[str, str] | None:
    """`/zones/forecast/<UGC>` -> ("forecast", UGC); `/zones/fire/<UGC>` ->
    ("fire", UGC); `/zones/county/<UGC>` -> ("county", UGC) — used only as a
    FIPS fallback when geocode.SAME is absent (R5). Marine UGCs (observed on
    the /zones/forecast/ path, but /zones/marine/ is accepted too) ->
    ("marine", UGC), a distinct type joined onto the separate marine-zone
    tileset (R6). Anything else -> None."""
    path = urllib.parse.urlparse(url).path
    parts = [p for p in path.split("/") if p]
    if len(parts) >= 3 and parts[0] == "zones" and parts[1] in ("forecast", "fire", "county", "marine"):
        ztype, ugc = parts[1], parts[2]
        if ztype != "county" and ugc[:2] in MARINE_UGC_PREFIXES:
            return ("marine", ugc)
        return (ztype, ugc)
    return None


def _load_zone_keys() -> set[str] | None:
    """Load the committed nws_zone_keys.txt sitting next to this script
    (data-feed.yml copies both to /tmp) for zone-vintage drift detection
    (R7). Fail-open: missing file -> None -> validation skipped."""
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "nws_zone_keys.txt")
    try:
        with open(path) as f:
            return {line.strip() for line in f if line.strip()}
    except OSError:
        print(f"  WARNING: {path} not found — zone-key validation skipped", file=sys.stderr)
        return None


def _county_ugc_to_fips(ugc: str) -> str | None:
    """County UGC `SSC###` -> 5-digit county FIPS (stateFIPS + ###), else None."""
    if len(ugc) == 6 and ugc[2] == "C" and ugc[3:].isdigit():
        state = STATE_FIPS.get(ugc[:2])
        if state:
            return state + ugc[3:]
    return None


def curate(features: list[dict], generated_utc: str) -> tuple[list[dict], list[dict], dict, dict, dict]:
    """Filter to allowlisted events. Non-null geometry -> polygon feature
    (kept). Null geometry -> zone_alerts sidecar entry (zone-joined), unless
    it has neither zones nor fips, in which case it's truly dropped (logged
    loudly). Returns (kept_features, zone_alerts, kept_counts_by_group,
    zone_joined_counts_by_group, stats)."""
    kept: list[dict] = []
    zone_alerts: list[dict] = []
    kept_counts: dict[str, int] = {}
    zone_joined_counts: dict[str, int] = {}
    stats = {
        "dropped": 0,
        "same_statewide_skipped": 0,
        "malformed_same": 0,
        "county_ugc_fallback": 0,
        "unknown_zone_keys": 0,
    }
    zone_keys = _load_zone_keys()

    for f in features:
        props = f.get("properties") or {}
        event = props.get("event")
        group = EVENT_GROUPS.get(event)
        if group is None:
            continue

        if f.get("geometry"):
            geom = dict(f["geometry"])
            geom["coordinates"] = _round_coords(geom["coordinates"])
            out_props = {k: props.get(k) for k in KEPT_PROPS}
            out_props["_group"] = group
            out_props["country"] = "US"
            out_props["generated_utc"] = generated_utc
            kept.append({"type": "Feature", "geometry": geom, "properties": out_props})
            kept_counts[group] = kept_counts.get(group, 0) + 1
            continue

        # Null geometry: try to zone/county-join.
        zones: list[list[str]] = []
        county_ugcs: list[str] = []
        for zurl in props.get("affectedZones") or []:
            parsed = _parse_zone_url(zurl)
            if not parsed:
                continue
            ztype, ugc = parsed
            if ztype == "county":
                county_ugcs.append(ugc)
            else:
                # R7 drift check: key format mirrors assets/nws-zone-join.ts
                # tileKey() — an alert naming a UGC absent from the tileset
                # vintage would silently no-paint.
                prefix = {"forecast": "z", "fire": "f", "marine": "m"}[ztype]
                tile_key = prefix + ugc
                if zone_keys is not None and tile_key not in zone_keys:
                    stats["unknown_zone_keys"] += 1
                    print(
                        f"  WARNING: zone key {tile_key} not in tileset "
                        f"(vintage drift?) event={event!r} id={props.get('id')!r}",
                        file=sys.stderr,
                    )
                zones.append([ztype, ugc])
        same = ((props.get("geocode") or {}).get("SAME")) or []
        fips: list[str] = []
        for s in same:
            if len(s) == 6:
                # SAME format PSSCCC: P is a portion digit (can be 1-9 for
                # partial-county coverage, e.g. Puerto Rico); last 5 chars are
                # always state+county FIPS. County part "000" = statewide —
                # no county to join, so skip (counted for stats).
                if s[-3:] == "000":
                    stats["same_statewide_skipped"] += 1
                    continue
                fips.append(s[1:])
            else:
                print(
                    f"  WARNING: suspect SAME code (not 6 digits): {s!r} "
                    f"event={event!r} id={props.get('id')!r}",
                    file=sys.stderr,
                )
                stats["malformed_same"] += 1
                continue

        # R5: SAME is not a required CAP field — when absent, derive county
        # FIPS from the county UGCs instead of dropping the alert.
        if not fips and county_ugcs:
            for ugc in county_ugcs:
                code = _county_ugc_to_fips(ugc)
                if code and code not in fips:
                    fips.append(code)
            if fips:
                stats["county_ugc_fallback"] += 1

        if not zones and not fips:
            stats["dropped"] += 1
            print(
                f"  WARNING: dropped (no zones/fips) group={group} "
                f"event={event!r} id={props.get('id')!r}",
                file=sys.stderr,
            )
            continue

        entry = {k: props.get(k) for k in KEPT_PROPS}
        entry["_group"] = group
        entry["zones"] = zones
        entry["fips"] = fips
        zone_alerts.append(entry)
        zone_joined_counts[group] = zone_joined_counts.get(group, 0) + 1

    if stats["dropped"]:
        print(f"  WARNING: {stats['dropped']} curated alert(s) truly dropped (no zones/fips)", file=sys.stderr)
    for key, label in (
        ("same_statewide_skipped", "statewide SAME code(s) skipped (no county to join)"),
        ("malformed_same", "malformed SAME code(s) skipped"),
        ("county_ugc_fallback", "alert(s) used county-UGC FIPS fallback (no SAME)"),
        ("unknown_zone_keys", "zone key(s) not in tileset — rebuild nws_zones? (make nws-zones)"),
    ):
        if stats[key]:
            print(f"  {stats[key]} {label}", file=sys.stderr)

    return kept, zone_alerts, kept_counts, zone_joined_counts, stats


def eccc_to_feature(f: dict, generated_utc: str) -> tuple[dict | None, str | None]:
    """Map one ECCC weather-alerts item to a curated Feature. Returns
    (feature_or_None, exclusion_reason_or_None) — reason is the lowercase
    alert name for deliberate/unmatched exclusions, or "(geometry null)" for
    an allowlisted alert missing geometry (R8: counted separately from
    parity exclusions)."""
    from shapely.geometry import mapping, shape

    props = f.get("properties") or {}
    if (props.get("status_en") or "").lower() == "ended":
        return None, None

    name_en = (props.get("alert_name_en") or "").strip()
    name_lower = name_en.lower()
    group = ECCC_EVENT_GROUPS.get(name_lower)
    if group is None:
        return None, name_lower

    geom_in = f.get("geometry")
    if not geom_in:
        return None, "(geometry null)"

    shp = shape(geom_in).simplify(0.01, preserve_topology=True)
    geom_out = mapping(shp)
    geom_out = {"type": geom_out["type"], "coordinates": _round_coords(geom_out["coordinates"])}

    alert_type = props.get("alert_type")
    severity = {"warning": "Severe", "watch": "Moderate"}.get(alert_type)
    area = props.get("feature_name_en") or ""
    out_props = {
        "event": name_en.title(),
        "severity": severity,
        "certainty": None,
        "urgency": None,
        "headline": f"{name_en}, {area}" if area else name_en,
        "onset": props.get("validity_datetime"),
        "ends": props.get("event_end_datetime"),
        "expires": props.get("expiration_datetime"),
        "areaDesc": area,
        "senderName": "Environment and Climate Change Canada",
        "id": props.get("id"),
        "_group": group,
        "country": "CA",
        "generated_utc": generated_utc,
    }
    return {"type": "Feature", "geometry": geom_out, "properties": out_props}, None


def curate_eccc(features: list[dict], generated_utc: str) -> tuple[list[dict], dict, dict]:
    """Returns (kept_features, kept_counts_by_group, excluded_counts_by_name)."""
    kept: list[dict] = []
    kept_counts: dict[str, int] = {}
    excluded_counts: dict[str, int] = {}
    for f in features:
        feat, reason = eccc_to_feature(f, generated_utc)
        if feat is not None:
            kept.append(feat)
            g = feat["properties"]["_group"]
            kept_counts[g] = kept_counts.get(g, 0) + 1
        elif reason:
            excluded_counts[reason] = excluded_counts.get(reason, 0) + 1
    return kept, kept_counts, excluded_counts


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", help="pre-downloaded NWS alerts/active JSON; omit to fetch live")
    ap.add_argument("--input-eccc", help="pre-downloaded ECCC weather-alerts JSON; omit to fetch live")
    ap.add_argument("-o", "--output", default="data/layers/nws_alerts.geojson")
    args = ap.parse_args()

    generated_utc = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    # ── NWS (US) ──────────────────────────────────────────────────────────
    if args.input:
        print(f"Reading saved NWS response {args.input}…", file=sys.stderr)
        with open(args.input) as f:
            data = json.load(f)
        nws_features = data.get("features", [])
        # Still follow pagination.next if the saved sample happens to carry one.
        next_url = (data.get("pagination") or {}).get("next")
        if next_url:
            nws_features += fetch_all_alerts(next_url)
    else:
        print("Fetching NWS active alerts…", file=sys.stderr)
        try:
            nws_features = fetch_all_alerts(NWS_ALERTS_URL)
        except Exception as e:
            print(f"ERROR: NWS fetch failed after retries: {e}", file=sys.stderr)
            sys.exit(1)

    total_fetched = len(nws_features)
    kept, zone_alerts, kept_counts, zone_joined_counts, curate_stats = curate(
        nws_features, generated_utc
    )

    for group in sorted(set(kept_counts) | set(zone_joined_counts)):
        print(
            f"  {group}: kept {kept_counts.get(group, 0)}, "
            f"zone-joined {zone_joined_counts.get(group, 0)}",
            file=sys.stderr,
        )

    # ── ECCC (Canada) — degrades to US-only on any failure ─────────────────
    # feed_status mirrors fetch_wildfire_live.py's pattern (dict of sub-key
    # -> "ok"/"failed", read by assets/ui/ui-legends.ts) so the frontend
    # legend-chip logic transfers unchanged in a later stage.
    feed_status = {"eccc": "ok"}
    eccc_kept: list[dict] = []
    try:
        if args.input_eccc:
            print(f"Reading saved ECCC response {args.input_eccc}…", file=sys.stderr)
            with open(args.input_eccc) as f:
                eccc_data = json.load(f)
            eccc_features = eccc_data.get("features", [])
            next_url = None
            for link in eccc_data.get("links") or []:
                if link.get("rel") == "next":
                    next_url = link.get("href")
                    break
            if next_url:
                eccc_features += fetch_all_eccc(next_url)
        else:
            print("Fetching ECCC active alerts…", file=sys.stderr)
            eccc_features = fetch_all_eccc(ECCC_ALERTS_URL)

        eccc_kept, eccc_kept_counts, eccc_excluded_counts = curate_eccc(eccc_features, generated_utc)
        for group in sorted(eccc_kept_counts):
            print(f"  eccc/{group}: kept {eccc_kept_counts[group]}", file=sys.stderr)
        if eccc_excluded_counts:
            top = sorted(eccc_excluded_counts.items(), key=lambda kv: -kv[1])
            print(f"  eccc excluded (unmatched/parity/geometry-null): {top}", file=sys.stderr)
    except Exception as e:
        feed_status["eccc"] = "failed"
        print(f"WARNING: ECCC fetch/parse failed, degrading to US-only: {e}", file=sys.stderr)
        eccc_kept = []

    all_features = kept + eccc_kept

    fc: dict = {"type": "FeatureCollection", "features": all_features}
    if zone_alerts:
        fc["zone_alerts"] = zone_alerts
    if all_features:
        all_features[0]["properties"]["feed_status"] = feed_status
    # Top-level mirrors of generated_utc/feed_status (R3) — always present, even
    # when features is empty, unlike the features[0] write above.
    fc["generated_utc"] = generated_utc
    fc["feed_status"] = feed_status
    fc["stats"] = {
        "fetched": total_fetched,
        "kept": len(kept),
        "zone_joined": len(zone_alerts),
        "eccc_kept": len(eccc_kept),
        **curate_stats,
    }

    out_dir = os.path.dirname(args.output)
    if out_dir:
        os.makedirs(out_dir, exist_ok=True)
    write_json_atomic(fc, args.output, separators=(",", ":"))

    if os.environ.get("GITHUB_ACTIONS"):
        if curate_stats["dropped"] > 0:
            print(f"::warning::fetch_nws_alerts: {curate_stats['dropped']} curated alert(s) dropped (no zones/fips)")
        if curate_stats["unknown_zone_keys"] > 0:
            print(
                f"::warning::fetch_nws_alerts: {curate_stats['unknown_zone_keys']} zone key(s) "
                f"not in nws_zones tileset — vintage drift, rebuild via `make nws-zones`"
            )

    total_kept = len(kept)
    total_zone_joined = len(zone_alerts)
    total_eccc = len(eccc_kept)
    size = os.path.getsize(args.output)
    print(
        f"Wrote {total_kept} US polygon alerts + {total_eccc} CA alerts "
        f"(fetched {total_fetched} US, zone-joined {total_zone_joined}, "
        f"feed_status={feed_status}) → {args.output} ({size} bytes)",
        file=sys.stderr,
    )


if __name__ == "__main__":
    main()
