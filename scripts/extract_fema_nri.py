#!/usr/bin/env python3
"""Extract FEMA National Risk Index (counties) → a geometry-less FIPS → scores table.

Pipeline role:
    ArcGIS FeatureServer  ->  this script  ->  data/layers/fema_nri.json
    The map joins it onto the shared county_boundaries PMTiles by GEOID via
    MapLibre feature-state (assets/fema-nri.ts), so no county geometry ships twice.

Source: FEMA National Risk Index, county level, ArcGIS FeatureServer
  https://services.arcgis.com/XG15cJAlne2vxtgt/arcgis/rest/services/National_Risk_Index_Counties/FeatureServer/0
  ~3,232 rows (states, DC and territories); attributes only, no geometry fetched.
  Auto-downloads to data/raw/fema_nri/nri_counties.json (delete it to refetch).
  Terms: FEMA NRI Terms & Conditions — see docs/layers/fema-nri.md.

Output schema (data/layers/fema_nri.json):
  version        NRI data version string from the service (e.g. "December 2025")
  retrieved_utc  when the raw table was downloaded
  hazards        column order: ["RISK", "AVLN", ...] — RISK is the composite index
  ratings        rating code → label; 0 = not applicable, 1–5 = Very Low…Very High,
                 6 = insufficient data
  counties       { "01001": [score, rating, score, rating, ...] } in `hazards` order;
                 score = national percentile 0–100 (1 decimal) or null

With data/build/county_boundaries.geojson present (make boundaries), also
reports join coverage against it: the county-boundary GEOIDs the map keys on.
"""
from __future__ import annotations

import json
import sys
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

RAW_DIR = Path("data/raw/fema_nri")
RAW_FILE = RAW_DIR / "nri_counties.json"
OUT_FILE = Path("data/layers/fema_nri.json")
COUNTY_GEOJSON = Path("data/build/county_boundaries.geojson")

QUERY_URL = (
    "https://services.arcgis.com/XG15cJAlne2vxtgt/arcgis/rest/services/"
    "National_Risk_Index_Counties/FeatureServer/0/query"
)
PAGE = 2000  # the service's maxRecordCount

# Composite first, then the 18 hazards in FEMA's field-prefix spelling. The
# frontend's NRI_HAZARDS list (src/registry/conditions.ts) mirrors this order.
HAZARDS = [
    "RISK", "AVLN", "CFLD", "CWAV", "DRGT", "ERQK", "HAIL", "HWAV", "HRCN", "ISTM",
    "IFLD", "LNDS", "LTNG", "SWND", "TRND", "TSUN", "VLCN", "WFIR", "WNTW",
]

# Rating labels as FEMA spells them → codes 1–5. "Insufficient Data" is code 6
# (the map greys it: the hazard occurs, but FEMA could not score it). Anything
# else — "Not Applicable", "No Rating", blank — is code 0, left unpainted: the
# hazard does not apply to that county.
RATINGS = ["Very Low", "Relatively Low", "Relatively Moderate", "Relatively High", "Very High"]
RATING_CODE = {label: i + 1 for i, label in enumerate(RATINGS)} | {"Insufficient Data": 6}


def fields_for(prefix: str) -> tuple[str, str]:
    """(score field, rating field) for a hazard prefix."""
    return ("RISK_SCORE", "RISK_RATNG") if prefix == "RISK" else (f"{prefix}_RISKS", f"{prefix}_RISKR")


def fetch_rows() -> list[dict]:
    """Every county row's attributes, paged past maxRecordCount."""
    out_fields = ["STCOFIPS", "NRI_VER"] + [f for h in HAZARDS for f in fields_for(h)]
    rows: list[dict] = []
    offset = 0
    while True:
        params = {
            "where": "1=1", "outFields": ",".join(out_fields), "returnGeometry": "false",
            "orderByFields": "STCOFIPS", "resultOffset": offset, "resultRecordCount": PAGE, "f": "json",
        }
        with urllib.request.urlopen(f"{QUERY_URL}?{urllib.parse.urlencode(params)}", timeout=120) as r:
            page = json.load(r)
        if "error" in page:
            raise RuntimeError(f"FEMA NRI query failed: {page['error']}")
        feats = page.get("features", [])
        rows.extend(f["attributes"] for f in feats)
        if not page.get("exceededTransferLimit") and len(feats) < PAGE:
            return rows
        offset += len(feats)


def build_snapshot(rows: list[dict], retrieved_utc: str) -> dict:
    """Pure: raw attribute rows → the served table."""
    counties: dict[str, list] = {}
    versions: set[str] = set()
    for row in rows:
        fips = str(row.get("STCOFIPS") or "").strip()
        if len(fips) != 5 or not fips.isdigit():
            continue
        if row.get("NRI_VER"):
            versions.add(str(row["NRI_VER"]))
        vals: list = []
        for h in HAZARDS:
            sf, rf = fields_for(h)
            score = row.get(sf)
            vals.append(round(float(score), 1) if isinstance(score, (int, float)) else None)
            vals.append(RATING_CODE.get(str(row.get(rf) or "").strip(), 0))
        counties[fips] = vals
    return {
        "version": " / ".join(sorted(versions)) or None,
        "retrieved_utc": retrieved_utc,
        "hazards": HAZARDS,
        "ratings": ["Not applicable"] + RATINGS + ["Insufficient data"],
        "counties": counties,
    }


def report_coverage(snapshot: dict) -> None:
    """Join coverage against the county-boundary GEOIDs, when that build exists."""
    if not COUNTY_GEOJSON.exists():
        print(f"  (skip coverage: {COUNTY_GEOJSON} absent — run `make boundaries`)")
        return
    with COUNTY_GEOJSON.open() as f:
        geoids = {feat["properties"]["GEOID"] for feat in json.load(f)["features"]}
    nri = set(snapshot["counties"])
    only_nri, only_geo = sorted(nri - geoids), sorted(geoids - nri)
    print(f"  join: {len(nri & geoids)} of {len(nri)} NRI counties match a boundary; "
          f"{len(only_geo)} of {len(geoids)} boundaries have no NRI row")
    if only_nri:
        print(f"  NRI rows with no boundary: {', '.join(only_nri)}")
    if only_geo:
        print(f"  boundaries with no NRI row: {', '.join(only_geo)}")


def main() -> int:
    RAW_DIR.mkdir(parents=True, exist_ok=True)
    if RAW_FILE.exists():
        raw = json.loads(RAW_FILE.read_text())
        print(f"  using cached {RAW_FILE} ({len(raw['rows'])} rows, retrieved {raw['retrieved_utc']})")
    else:
        rows = fetch_rows()
        raw = {"retrieved_utc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), "rows": rows}
        RAW_FILE.write_text(json.dumps(raw))
        print(f"  downloaded {len(rows)} rows → {RAW_FILE}")

    snapshot = build_snapshot(raw["rows"], raw["retrieved_utc"])
    OUT_FILE.parent.mkdir(parents=True, exist_ok=True)
    OUT_FILE.write_text(json.dumps(snapshot, separators=(",", ":")))
    print(f"  wrote {len(snapshot['counties'])} counties, NRI {snapshot['version']} → "
          f"{OUT_FILE} ({OUT_FILE.stat().st_size / 1024:.0f} KB)")
    report_coverage(snapshot)
    return 0


if __name__ == "__main__":
    sys.exit(main())
