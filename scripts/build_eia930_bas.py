#!/usr/bin/env python3
"""Builds the Grid Operations layer's balancing-authority table
(`make eia930-bas`): src/registry/eia930-bas.json, committed, so the frontend
never needs data/.

One row per BA code EIA-930 can name (PUDL's core_eia__codes_balancing_authorities):
its display name, EIA region, interconnect, retirement date and where its
bubble sits. The bubble sits at the pole of inaccessibility of the BA's largest
polygon in data/build/eia_ba.gpkg (the EIA BA layer's own boundaries), or at a
hand-placed point for the few codes that layer lacks (POSITION_OVERRIDES);
DISPLAY_POSITIONS moves a few far-north bubbles near the US border.
Nested BAs (SCL and TPWR inside BPAT, the Florida munis) would stack, so the
points are pushed apart until no two sit closer than MIN_SEP_PX at zoom
RELAX_ZOOM; `anchor` keeps the unmoved point.

Codes with neither a polygon nor an override are left out and listed on stderr;
the frontend drops their rows and says how many it dropped.

Inputs: data/build/eia_ba.gpkg (scripts/extract_eia_ba.py) and the PUDL codes
table at PUDL_VERSION (network, ~10 KB).

    venv/bin/python scripts/build_eia930_bas.py
"""
from __future__ import annotations

import io
import json
import math
import re
import sys
import urllib.request
from pathlib import Path

import geopandas as gpd
import pandas as pd
from shapely.ops import polylabel

ROOT = Path(__file__).resolve().parent.parent
GPKG = ROOT / "data" / "build" / "eia_ba.gpkg"
OUT = ROOT / "src" / "registry" / "eia930-bas.json"

# Held equal to PUDL_VERSION in assets/constants.ts by scripts/test_eia930_bas.py.
PUDL_VERSION = "v2026.8.0"
CODES_URL = ("https://s3.us-west-2.amazonaws.com/pudl.catalyst.coop/"
             f"{PUDL_VERSION}/core_eia__codes_balancing_authorities.parquet")

# Codes the EIA BA polygons do not carry: the BA's main load centre.
POSITION_OVERRIDES = {
    "BHBA": (-103.23, 44.08),   # Black Hills, Rapid City SD
    "EPE":  (-106.44, 31.90),   # El Paso Electric
    "NWMT": (-110.50, 46.90),   # NorthWestern Energy, central MT
    "SIKE": (-89.59, 36.88),    # Sikeston MO
    "SWPW": (-105.60, 41.30),   # SPP West RTO, WY/CO (WACM + WAUW from 2026-04)
    "CEN":  (-116.20, 31.60),   # CENACE Baja California, the WECC-tied system
    "CFE":  (-116.00, 31.40),   # CFE Baja California (until 2018-07)
}

# Codes whose polygon centre sits far from the rest of the West: placed near the
# US border so the whole Western Interconnection fits one view. These win over the polygon.
DISPLAY_POSITIONS = {
    "BCHA": (-120.40, 50.70),   # BC Hydro, Kamloops (southern interior)
    "AESO": (-114.07, 51.05),   # AESO, Calgary
}

# Codes EIA-930 reports that PUDL's code table lacks: name, EIA region, interconnect.
EXTRA_CODES = {
    "SIKE": ("Sikeston Board of Municipal Utilities", "MIDW", "eastern"),
}

RELAX_ZOOM = 4.5
MIN_SEP_PX = 34.0


def mercator_px(lon: float, lat: float, z: float) -> tuple[float, float]:
    s = 256 * 2 ** z
    x = (lon + 180) / 360 * s
    y = (1 - math.log(math.tan(math.radians(lat)) + 1 / math.cos(math.radians(lat))) / math.pi) / 2 * s
    return x, y


def lonlat(x: float, y: float, z: float) -> tuple[float, float]:
    s = 256 * 2 ** z
    lon = x / s * 360 - 180
    lat = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * y / s))))
    return lon, lat


def relax(pts: dict[str, list[float]], weight: dict[str, float]) -> None:
    """Push points apart in place until none sit closer than MIN_SEP_PX.
    A heavier point (a larger BA) moves less."""
    codes = sorted(pts)
    for _ in range(400):
        moved = False
        for i, a in enumerate(codes):
            for b in codes[i + 1:]:
                dx, dy = pts[b][0] - pts[a][0], pts[b][1] - pts[a][1]
                d = math.hypot(dx, dy)
                if d >= MIN_SEP_PX:
                    continue
                if d < 1e-6:
                    dx, dy, d = 1.0, 0.0, 1.0
                push = (MIN_SEP_PX - d) / 2
                wa, wb = weight[a], weight[b]
                fa, fb = 2 * wb / (wa + wb), 2 * wa / (wa + wb)
                pts[a][0] -= dx / d * push * fa
                pts[a][1] -= dy / d * push * fa
                pts[b][0] += dx / d * push * fb
                pts[b][1] += dy / d * push * fb
                moved = True
        if not moved:
            return
    print("relax: not fully separated after 400 rounds", file=sys.stderr)


def title(label: str) -> str:
    return " ".join(w.capitalize() for w in label.split("_"))


def main() -> int:
    with urllib.request.urlopen(CODES_URL, timeout=60) as r:
        codes = pd.read_parquet(io.BytesIO(r.read()))
    extra = [{"code": c, "label": n, "balancing_authority_region_code_eia": rg, "interconnect_code_eia": ic,
              "balancing_authority_retirement_date": None} for c, (n, rg, ic) in EXTRA_CODES.items()
             if c not in set(codes.code)]
    codes = pd.concat([codes, pd.DataFrame(extra)], ignore_index=True)
    polys = gpd.read_file(GPKG).to_crs(3857)

    anchor: dict[str, tuple[float, float]] = {}
    area: dict[str, float] = {}
    names: dict[str, str] = {}
    for row in polys.itertuples():
        geom = row.geometry
        part = max(getattr(geom, "geoms", [geom]), key=lambda g: g.area)
        p = polylabel(part, tolerance=2000)
        lon, lat = gpd.GeoSeries([p], crs=3857).to_crs(4326).iloc[0].coords[0]
        anchor[row.abbrev] = (lon, lat)
        area[row.abbrev] = float(geom.area)
        names[row.abbrev] = re.sub(r"\s*\(Balancing Authority\)$", "", row.name)
    for code, ll in POSITION_OVERRIDES.items():
        anchor.setdefault(code, ll)
    anchor.update(DISPLAY_POSITIONS)

    rows, missing = [], []
    for c in codes.itertuples():
        if c.code not in anchor:
            missing.append(c.code)
            continue
        rows.append(c)
    if missing:
        print("no position (left out): " + " ".join(sorted(missing)), file=sys.stderr)

    pts = {c.code: list(mercator_px(*anchor[c.code], RELAX_ZOOM)) for c in rows}
    weight = {c.code: math.sqrt(area.get(c.code, 1e9)) for c in rows}
    relax(pts, weight)

    def text(v: object) -> str | None:
        return None if v is None or (isinstance(v, float) and math.isnan(v)) or v is pd.NA else str(v)

    out = []
    for c in sorted(rows, key=lambda r: r.code):
        lon, lat = lonlat(*pts[c.code], RELAX_ZOOM)
        retired = c.balancing_authority_retirement_date
        out.append({
            "code": c.code,
            "name": names.get(c.code) or (c.label if c.code in EXTRA_CODES else title(c.label)),
            "region": text(c.balancing_authority_region_code_eia),
            "interconnect": text(c.interconnect_code_eia),
            "retired": None if retired is None or pd.isna(retired) else str(retired)[:10],
            "lon": round(lon, 3), "lat": round(lat, 3),
            "anchor": [round(anchor[c.code][0], 3), round(anchor[c.code][1], 3)],
        })
    OUT.write_text(json.dumps({"pudl_version": PUDL_VERSION, "bas": out}, indent=1) + "\n")
    print(f"wrote {OUT.relative_to(ROOT)}: {len(out)} BAs")
    return 0


if __name__ == "__main__":
    sys.exit(main())
