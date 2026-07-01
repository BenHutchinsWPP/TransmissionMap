#!/usr/bin/env python3
"""Merge NASA FIRMS VIIRS CSVs + NIFC WFIGS perimeters + incidents + NOAA HMS smoke → single GeoJSON.

All four feature types share one output file; _type distinguishes them:
  hotspot  — raw VIIRS satellite heat pixel (Point)
  perimeter — WFIGS fire boundary polygon (Polygon)
  incident  — WFIGS named dispatch record (Point)
  smoke     — NOAA HMS smoke detection polygon (Polygon)

Usage (local dev — fetches live perimeters, incidents, and smoke):
  python3 scripts/firms_csv_to_geojson.py \\
      tmp/wildfire-data/viirs_snpp_24h.csv \\
      tmp/wildfire-data/viirs_noaa20_24h.csv \\
      -o data/layers/wildfire_live.geojson

Usage (GH Actions):
  python3 scripts/firms_csv_to_geojson.py /tmp/snpp.csv /tmp/n20.csv -o output.geojson
"""

import argparse
import csv
import io
import json
import struct
import sys
import urllib.request
import zipfile
from datetime import datetime, timedelta, timezone

# ── WFIGS endpoints ───────────────────────────────────────────────────────────
NIFC_PERIMETERS_URL = (
    "https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services"
    "/WFIGS_Interagency_Perimeters_Current/FeatureServer/0/query"
    "?where=1%3D1"
    "&outFields=attr_IncidentName,attr_FireCause,attr_FireDiscoveryDateTime"
    ",attr_POOState,attr_IncidentSize,attr_PercentContained"
    ",poly_GISAcres,poly_PolygonDateTime,attr_IrwinID"
    "&f=geojson&outSR=4326&resultRecordCount=2000"
)

NIFC_INCIDENTS_URL = (
    "https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services"
    "/WFIGS_Incident_Locations_Current/FeatureServer/0/query"
    "?where=1%3D1"
    "&outFields=UniqueFireIdentifier,IncidentName,IncidentTypeCategory"
    ",FireDiscoveryDateTime,PercentContained,IncidentSize,POOState,ModifiedOnDateTime_dt"
    "&f=geojson&outSR=4326&resultRecordCount=2000"
)

# ── CWFIS (Canada) perimeter-estimate URL ─────────────────────────────────────
# Fire M3 burned-area estimate polygons (hotspot-derived, daily). The only
# national near-real-time Canadian perimeter feed. WFS 2.0, GeoJSON, CORS *,
# Open Government Licence – Canada. No incident name / containment / cause —
# these are estimated extents, not surveyed boundaries.
CWFIS_PERIMETERS_URL = (
    "https://cwfis.cfs.nrcan.gc.ca/geoserver/public/ows"
    "?service=WFS&version=2.0.0&request=GetFeature"
    "&typeNames=public:m3_polygons_current"
    "&outputFormat=application/json&srsName=EPSG:4326"
    "&count=1000"
)

# ── NOAA HMS smoke URL ────────────────────────────────────────────────────────
HMS_BASE_URL = (
    "https://satepsanone.nesdis.noaa.gov/pub/FIRE/web/HMS"
    "/Smoke_Polygons/Shapefile/{year}/{month}/hms_smoke{date}.zip"
)


# ── Shared helpers ────────────────────────────────────────────────────────────

def _epoch_ms_to_iso(ms: int | None) -> str | None:
    if ms is None:
        return None
    try:
        return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).strftime("%Y-%m-%dT%H:%MZ")
    except Exception:
        return None


def _parse_julian_dt(s: str) -> str | None:
    """Parse HMS Julian datetime '2026177 1200' (YYYYdoy HHMM) → ISO-8601 UTC."""
    s = s.strip()
    if len(s) < 7:
        return None
    try:
        year, doy = int(s[:4]), int(s[4:7])
        hhmm = s[8:12] if len(s) >= 12 else "0000"
        hh, mm = int(hhmm[:2]), int(hhmm[2:])
        dt = datetime(year, 1, 1, tzinfo=timezone.utc) + timedelta(days=doy - 1, hours=hh, minutes=mm)
        return dt.strftime("%Y-%m-%dT%H:%MZ")
    except Exception:
        return None


# ── VIIRS hotspots ────────────────────────────────────────────────────────────

def _parse_acq_dt(acq_date: str, acq_time: str) -> datetime | None:
    try:
        t = acq_time.zfill(4)
        return datetime.strptime(f"{acq_date} {t[:2]}:{t[2:]}", "%Y-%m-%d %H:%M").replace(tzinfo=timezone.utc)
    except Exception:
        return None


def read_viirs_csvs(paths: list[str], now: datetime) -> list[dict]:
    seen: set[str] = set()
    features = []
    for path in paths:
        with open(path, newline="") as f:
            for row in csv.DictReader(f):
                if row.get("confidence", "").lower() == "l":
                    continue
                key = f"{row['latitude']},{row['longitude']},{row.get('acq_date','')},{row.get('acq_time','')}"
                if key in seen:
                    continue
                seen.add(key)
                acq_dt = _parse_acq_dt(row.get("acq_date", ""), row.get("acq_time", ""))
                age_hours = round((now - acq_dt).total_seconds() / 3600, 1) if acq_dt else None
                features.append({
                    "type": "Feature",
                    "geometry": {"type": "Point", "coordinates": [float(row["longitude"]), float(row["latitude"])]},
                    "properties": {
                        "_type": "hotspot",
                        "frp": float(row["frp"]) if row.get("frp") else None,
                        "confidence": row.get("confidence"),
                        "satellite": row.get("satellite"),
                        "acq_date": row.get("acq_date"),
                        "acq_time": row.get("acq_time"),
                        "age_hours": age_hours,
                    },
                })
    return features


# ── WFIGS perimeters ──────────────────────────────────────────────────────────

def _fetch_paginated(url: str) -> list[dict]:
    all_features: list[dict] = []
    offset = 0
    while True:
        with urllib.request.urlopen(url + f"&resultOffset={offset}", timeout=60) as r:
            data = json.load(r)
        feats = data.get("features", [])
        all_features.extend(feats)
        if not data.get("properties", {}).get("exceededTransferLimit") or not feats:
            break
        offset += 2000
    return all_features


def normalize_perimeter(f: dict) -> dict:
    p = f.get("properties") or {}
    return {
        "type": "Feature",
        "geometry": f.get("geometry"),
        "properties": {
            "_type": "perimeter",
            "country": "US",
            "name": p.get("attr_IncidentName"),
            "state": p.get("attr_POOState"),
            "cause": p.get("attr_FireCause"),
            "discovery_date": _epoch_ms_to_iso(p.get("attr_FireDiscoveryDateTime")),
            "pct_contained": p.get("attr_PercentContained"),
            "acres": p.get("attr_IncidentSize"),
            "gis_acres": p.get("poly_GISAcres"),
            "updated_dt": _epoch_ms_to_iso(p.get("poly_PolygonDateTime")),
            "irwin_id": p.get("attr_IrwinID"),
        },
    }


# ── CWFIS perimeter estimates (Canada) ────────────────────────────────────────

def _fetch_wfs_paginated(url: str) -> list[dict]:
    """GeoServer WFS 2.0 pagination (startIndex), distinct from the ArcGIS
    resultOffset paging in _fetch_paginated."""
    all_features: list[dict] = []
    start = 0
    while True:
        with urllib.request.urlopen(url + f"&startIndex={start}", timeout=60) as r:
            data = json.load(r)
        feats = data.get("features", [])
        all_features.extend(feats)
        if len(feats) < 1000:  # matches &count=1000 in the URL
            break
        start += 1000
    return all_features


def normalize_cwfis_perimeter(f: dict) -> dict:
    """CWFIS Fire M3 estimate → perimeter feature. No name/cause/containment
    (estimated extent only); area is hectares → acres (×2.471)."""
    p = f.get("properties") or {}
    area_ha = p.get("area")
    acres = round(area_ha * 2.471, 1) if isinstance(area_ha, (int, float)) else None
    return {
        "type": "Feature",
        "geometry": f.get("geometry"),
        "properties": {
            "_type": "perimeter",
            "country": "CA",
            "name": None,            # CWFIS m3 estimates are unnamed
            "state": None,
            "cause": None,
            "discovery_date": p.get("firstdate"),  # already ISO-8601 UTC
            "pct_contained": None,
            "acres": acres,
            "gis_acres": acres,
            "updated_dt": p.get("lastdate"),
            "irwin_id": None,
            "hotspot_count": p.get("hcount"),
        },
    }


# ── WFIGS incidents ───────────────────────────────────────────────────────────

def normalize_incident(f: dict) -> dict:
    p = f.get("properties") or {}
    return {
        "type": "Feature",
        "geometry": f.get("geometry"),
        "properties": {
            "_type": "incident",
            "fire_id": p.get("UniqueFireIdentifier"),
            "name": p.get("IncidentName"),
            "type_cat": p.get("IncidentTypeCategory"),
            "state": p.get("POOState"),
            "discovery_dt": _epoch_ms_to_iso(p.get("FireDiscoveryDateTime")),
            "modified_dt": _epoch_ms_to_iso(p.get("ModifiedOnDateTime_dt")),
            "pct_contained": p.get("PercentContained"),
            "acres": p.get("IncidentSize"),
        },
    }


# ── NOAA HMS smoke (inline shapefile parser — no GDAL needed) ─────────────────

def _read_dbf(data: bytes) -> list[dict]:
    f = io.BytesIO(data)
    header = f.read(32)
    num_records = struct.unpack("<I", header[4:8])[0]
    header_size = struct.unpack("<H", header[8:10])[0]
    record_size = struct.unpack("<H", header[10:12])[0]
    fields: list[tuple[str, int]] = []
    while True:
        b = f.read(32)
        if not b or b[0] == 0x0D:
            break
        fields.append((b[:11].replace(b"\x00", b"").decode("ascii", "replace").strip(), b[16]))
    f.seek(header_size)
    records = []
    for _ in range(num_records):
        rec = f.read(record_size)
        if rec[0] == 0x2A:
            continue
        offset = 1
        row: dict = {}
        for name, size in fields:
            row[name] = rec[offset : offset + size].decode("latin1", "replace").strip()
            offset += size
        records.append(row)
    return records


def _read_shp(data: bytes) -> list[list[list[list[float]]]]:
    f = io.BytesIO(data)
    f.read(100)
    all_rings: list[list[list[list[float]]]] = []
    while True:
        rec_hdr = f.read(8)
        if len(rec_hdr) < 8:
            break
        content_len = struct.unpack(">I", rec_hdr[4:])[0] * 2
        content = f.read(content_len)
        shp_type = struct.unpack("<i", content[:4])[0]
        if shp_type == 0:
            all_rings.append([])
            continue
        if shp_type not in (5, 15, 25):
            all_rings.append([])
            continue
        num_parts = struct.unpack("<i", content[36:40])[0]
        num_points = struct.unpack("<i", content[40:44])[0]
        parts = list(struct.unpack(f"<{num_parts}i", content[44 : 44 + num_parts * 4]))
        pts_start = 44 + num_parts * 4
        points = [[round(x, 6), round(y, 6)]
                  for i in range(num_points)
                  for x, y in [struct.unpack("<dd", content[pts_start + i * 16 : pts_start + i * 16 + 16])]]
        rings: list[list[list[float]]] = []
        for i, start in enumerate(parts):
            end = parts[i + 1] if i + 1 < len(parts) else num_points
            rings.append(points[start:end])
        all_rings.append(rings)
    return all_rings


def fetch_hms_smoke() -> list[dict]:
    now = datetime.now(timezone.utc)
    for delta in (0, 1, 2):
        dt = now - timedelta(days=delta)
        url = HMS_BASE_URL.format(year=dt.strftime("%Y"), month=dt.strftime("%m"), date=dt.strftime("%Y%m%d"))
        try:
            print(f"  Trying {url}", file=sys.stderr)
            with urllib.request.urlopen(url, timeout=60) as r:
                zip_bytes = r.read()
            with zipfile.ZipFile(io.BytesIO(zip_bytes)) as z:
                names = z.namelist()
                shp_data = z.read(next(n for n in names if n.endswith(".shp")))
                dbf_data = z.read(next(n for n in names if n.endswith(".dbf")))
            records = _read_dbf(dbf_data)
            rings_list = _read_shp(shp_data)
            features = []
            for attr, rings in zip(records, rings_list):
                if not rings:
                    continue
                geom = ({"type": "Polygon", "coordinates": rings} if len(rings) == 1
                        else {"type": "MultiPolygon", "coordinates": [[r] for r in rings]})
                features.append({
                    "type": "Feature",
                    "geometry": geom,
                    "properties": {
                        "_type": "smoke",
                        "density": attr.get("Density", ""),
                        "satellite": attr.get("Satellite", ""),
                        "start_dt": _parse_julian_dt(attr.get("Start", "")),
                        "end_dt": _parse_julian_dt(attr.get("End", "")),
                    },
                })
            print(f"  {len(features)} smoke polygons from {dt.strftime('%Y-%m-%d')}", file=sys.stderr)
            if features:
                return features
            # empty (clear-sky or not-yet-posted day) — fall back to prior day
        except Exception as e:
            print(f"  {e}", file=sys.stderr)
    print("  WARNING: HMS smoke unavailable", file=sys.stderr)
    return []


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("viirs_csvs", nargs="+", help="FIRMS VIIRS CSV files (SNPP, NOAA-20, …)")
    ap.add_argument("-o", "--output", required=True)
    args = ap.parse_args()

    now = datetime.now(timezone.utc)
    generated_utc = now.strftime("%Y-%m-%dT%H:%MZ")

    print("Reading VIIRS CSVs…", file=sys.stderr)
    hotspots = read_viirs_csvs(args.viirs_csvs, now)
    print(f"  {len(hotspots)} hotspots", file=sys.stderr)

    # Perimeters/incidents/smoke each degrade to [] on upstream failure so one
    # flaky source (ArcGIS especially) doesn't blank the whole hourly update.
    print("Fetching NIFC perimeters…", file=sys.stderr)
    try:
        perimeters = [normalize_perimeter(f) for f in _fetch_paginated(NIFC_PERIMETERS_URL) if f.get("geometry")]
        print(f"  {len(perimeters)} perimeters", file=sys.stderr)
    except Exception as e:
        perimeters = []
        print(f"  WARNING: perimeters unavailable: {e}", file=sys.stderr)

    print("Fetching CWFIS Canada perimeter estimates…", file=sys.stderr)
    try:
        ca_perimeters = [normalize_cwfis_perimeter(f)
                         for f in _fetch_wfs_paginated(CWFIS_PERIMETERS_URL) if f.get("geometry")]
        perimeters += ca_perimeters
        print(f"  {len(ca_perimeters)} CA perimeter estimates", file=sys.stderr)
    except Exception as e:
        print(f"  WARNING: CWFIS perimeters unavailable: {e}", file=sys.stderr)

    print("Fetching WFIGS incidents…", file=sys.stderr)
    try:
        incidents = [normalize_incident(f) for f in _fetch_paginated(NIFC_INCIDENTS_URL) if f.get("geometry")]
        print(f"  {len(incidents)} incidents", file=sys.stderr)
    except Exception as e:
        incidents = []
        print(f"  WARNING: incidents unavailable: {e}", file=sys.stderr)

    print("Fetching NOAA HMS smoke…", file=sys.stderr)
    smoke = fetch_hms_smoke()

    all_features = hotspots + perimeters + incidents + smoke
    for feat in all_features:
        feat["properties"]["generated_utc"] = generated_utc

    fc = {"type": "FeatureCollection", "features": all_features}
    with open(args.output, "w") as f:
        json.dump(fc, f, separators=(",", ":"))
    print(
        f"Wrote {len(all_features)} features "
        f"({len(hotspots)} hotspots, {len(perimeters)} perimeters, "
        f"{len(incidents)} incidents, {len(smoke)} smoke) → {args.output}",
        file=sys.stderr,
    )


if __name__ == "__main__":
    main()
