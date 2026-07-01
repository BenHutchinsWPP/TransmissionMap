#!/usr/bin/env python3
"""Download NOAA HMS Smoke Detection shapefile → GeoJSON.

Downloads today's (or yesterday's fallback) HMS smoke polygon shapefile from
satepsanone.nesdis.noaa.gov and converts it to GeoJSON. Pure Python; no GDAL needed.

Usage:
  # Production (fetches live):
  python3 scripts/hms_smoke_to_geojson.py -o data/layers/smoke_live.geojson

  # Local dev (pass a pre-downloaded zip):
  python3 scripts/hms_smoke_to_geojson.py --zip /tmp/hms_smoke.zip -o data/layers/smoke_live.geojson
"""

import argparse
import io
import json
import struct
import sys
import urllib.request
import zipfile
from datetime import datetime, timedelta, timezone

BASE_URL = (
    "https://satepsanone.nesdis.noaa.gov/pub/FIRE/web/HMS"
    "/Smoke_Polygons/Shapefile/{year}/{month}/hms_smoke{date}.zip"
)


def _day_url(dt: datetime) -> str:
    return BASE_URL.format(year=dt.strftime("%Y"), month=dt.strftime("%m"), date=dt.strftime("%Y%m%d"))


def fetch_zip(timeout: int = 60) -> bytes:
    now = datetime.now(timezone.utc)
    for delta in (0, 1, 2):
        dt = now - timedelta(days=delta)
        url = _day_url(dt)
        try:
            print(f"Trying {url}", file=sys.stderr)
            with urllib.request.urlopen(url, timeout=timeout) as r:
                if r.status == 200:
                    print(f"  OK — {dt.strftime('%Y-%m-%d')}", file=sys.stderr)
                    return r.read()
        except Exception as e:
            print(f"  {e}", file=sys.stderr)
    raise RuntimeError("HMS smoke file unavailable for today, yesterday, and day before")


def _parse_julian_dt(s: str) -> str | None:
    """Parse HMS datetime '2026177 1200' (YYYYdoy HHMM) → ISO-8601 UTC string."""
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
        name = b[:11].replace(b"\x00", b"").decode("ascii", "replace").strip()
        size = b[16]
        fields.append((name, size))
    f.seek(header_size)
    records = []
    for _ in range(num_records):
        rec = f.read(record_size)
        if rec[0] == 0x2A:  # deleted record
            continue
        offset = 1
        row: dict = {}
        for name, size in fields:
            row[name] = rec[offset : offset + size].decode("latin1", "replace").strip()
            offset += size
        records.append(row)
    return records


def _read_shp(data: bytes) -> list[list[list[list[float]]]]:
    """Read SHP polygon rings → list of ring-lists per record."""
    f = io.BytesIO(data)
    f.read(100)  # file header
    all_rings: list[list[list[list[float]]]] = []
    while True:
        rec_hdr = f.read(8)
        if len(rec_hdr) < 8:
            break
        content_len = struct.unpack(">I", rec_hdr[4:])[0] * 2
        content = f.read(content_len)
        shp_type = struct.unpack("<i", content[:4])[0]
        if shp_type == 0:  # Null shape
            all_rings.append([])
            continue
        if shp_type not in (5, 15, 25):  # Polygon / PolygonZ / PolygonM
            all_rings.append([])
            continue
        num_parts = struct.unpack("<i", content[36:40])[0]
        num_points = struct.unpack("<i", content[40:44])[0]
        parts = list(struct.unpack(f"<{num_parts}i", content[44 : 44 + num_parts * 4]))
        pts_start = 44 + num_parts * 4
        points = []
        for i in range(num_points):
            x, y = struct.unpack("<dd", content[pts_start + i * 16 : pts_start + i * 16 + 16])
            points.append([round(x, 6), round(y, 6)])
        rings: list[list[list[float]]] = []
        for i, start in enumerate(parts):
            end = parts[i + 1] if i + 1 < len(parts) else num_points
            rings.append(points[start:end])
        all_rings.append(rings)
    return all_rings


def zip_to_geojson(zip_bytes: bytes, generated_utc: str) -> dict:
    with zipfile.ZipFile(io.BytesIO(zip_bytes)) as z:
        names = z.namelist()
        shp_name = next(n for n in names if n.endswith(".shp"))
        dbf_name = next(n for n in names if n.endswith(".dbf"))
        shp_data = z.read(shp_name)
        dbf_data = z.read(dbf_name)

    records = _read_dbf(dbf_data)
    rings_list = _read_shp(shp_data)
    features = []
    for attr, rings in zip(records, rings_list):
        if not rings:
            continue
        geom = {"type": "Polygon", "coordinates": rings} if len(rings) == 1 else {"type": "MultiPolygon", "coordinates": [[r] for r in rings]}
        features.append({
            "type": "Feature",
            "geometry": geom,
            "properties": {
                "density":   attr.get("Density", ""),
                "satellite": attr.get("Satellite", ""),
                "start_dt":  _parse_julian_dt(attr.get("Start", "")),
                "end_dt":    _parse_julian_dt(attr.get("End", "")),
                "generated_utc": generated_utc,
            },
        })
    return {"type": "FeatureCollection", "features": features}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--zip", help="Pre-downloaded HMS zip (omit to fetch live)")
    ap.add_argument("-o", "--output", required=True)
    args = ap.parse_args()

    generated_utc = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%MZ")
    zip_bytes = open(args.zip, "rb").read() if args.zip else fetch_zip()
    fc = zip_to_geojson(zip_bytes, generated_utc)
    with open(args.output, "w") as f:
        json.dump(fc, f, separators=(",", ":"))
    counts = {}
    for feat in fc["features"]:
        d = feat["properties"].get("density", "?")
        counts[d] = counts.get(d, 0) + 1
    print(f"Wrote {len(fc['features'])} features {counts} → {args.output}", file=sys.stderr)


if __name__ == "__main__":
    main()
