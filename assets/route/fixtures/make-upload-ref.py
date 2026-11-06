"""Writes upload-ref.json, the reference rasters upload-layer.test.ts checks
assets/route/upload-layer.ts against (run: venv/bin/python -I make-upload-ref.py).

The reference is independent of the TS code: lng/lat goes to EPSG:5070 through pyproj, and
each polygon part is burned by rasterio (GDAL) with all_touched=False — the cell-centre rule
of build_route_bands.py — as its own shape, so parts union (GDAL's multipart even-odd would
XOR an overlap). Grid constants come from scripts/route_grid.py.

Two sets:
  lnglat  irregular lng/lat shapes (square, donut, bowtie, overlapping parts, clockwise outer,
          island in a hole, a 300-vertex star, one across the grid's west edge). The script
          fails if any cell centre of a box lies within 1e-6 cell of an edge, so pyproj vs
          grid.ts rounding can never decide a cell.
  5070    EPSG:5070 metres on a small exact grid (cell 256, origin 0) with edges exactly on
          cell-centre lines (both windings, a donut, a diagonal through centres, a notch, a
          spike) and 40 random rings on the half-cell lattice: GDAL's tie rules (each ring
          turned clockwise on the map by OGR's isClockwise, y half-open [top, bottom),
          x (left, right], a horizontal edge on a centre line burned when it runs leftward
          in pixel space).
Each fixture: polygons (MultiPolygon coordinates), box {col0, row0, cols, rows} on the grid
(the file's GRID_250, or the fixture's own `grid`),
rows (one '0'/'1' string per box row, top first).
"""
import json
import math
import os
import random
import sys

import numpy as np
import rasterio
from affine import Affine
from pyproj import Transformer
from rasterio.features import rasterize

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "..", "..", "scripts"))
import route_grid as rg  # noqa: E402

TO_5070 = Transformer.from_crs("EPSG:4326", rg.CRS, always_xy=True)
TO_LL = Transformer.from_crs(rg.CRS, "EPSG:4326", always_xy=True)
BOX = 56


def pix(x, y):
    return (x - rg.X0) / rg.CELL, (rg.Y0 - y) / rg.CELL


def project(polys):
    out = []
    for poly in polys:
        rings = []
        for ring in poly:
            xs, ys = TO_5070.transform([p[0] for p in ring], [p[1] for p in ring])
            rings.append([[x, y] for x, y in zip(xs, ys)])
        out.append(rings)
    return out


def burn(xy_polys, box, grid=None):
    x0, y0, cell = (grid["origin"][0], grid["origin"][1], grid["cell"]) if grid else (rg.X0, rg.Y0, rg.CELL)
    t = Affine(cell, 0, x0 + box["col0"] * cell, 0, -cell, y0 - box["row0"] * cell)
    shapes = [({"type": "Polygon", "coordinates": poly}, 1) for poly in xy_polys]
    return rasterize(shapes, out_shape=(box["rows"], box["cols"]), transform=t,
                     all_touched=False, fill=0, dtype="uint8")


def margin(xy_polys, box):
    """Smallest distance, in cells, from a box cell centre to any edge."""
    cx, cy = np.meshgrid(box["col0"] + 0.5 + np.arange(box["cols"]),
                         box["row0"] + 0.5 + np.arange(box["rows"]))
    cx, cy = cx.ravel(), cy.ravel()
    best = math.inf
    for poly in xy_polys:
        for ring in poly:
            p = np.array([pix(x, y) for x, y in ring])
            for (ax, ay), (bx, by) in zip(p[:-1], p[1:]):
                dx, dy = bx - ax, by - ay
                L = dx * dx + dy * dy
                t = np.clip(((cx - ax) * dx + (cy - ay) * dy) / L, 0, 1) if L else 0
                best = min(best, float(np.min(np.hypot(cx - (ax + t * dx), cy - (ay + t * dy)))))
    return best


def box_around(lng, lat):
    x, y = TO_5070.transform(lng, lat)
    c, r = pix(x, y)
    return {"col0": int(c) - BOX // 2, "row0": int(r) - BOX // 2, "cols": BOX, "rows": BOX}


def ring(cx, cy, pts, cw=False):
    r = [[cx + dx, cy + dy] for dx, dy in pts]
    if cw:
        r.reverse()
    return r + [r[0]]


# ---- lng/lat set, around (-105.3, 39.7) ----
LNG, LAT = -105.3, 39.7
SQ = [(-0.0513, -0.0472), (0.0491, -0.0438), (0.0467, 0.0529), (-0.0482, 0.0507)]
PENT = [(-0.081, -0.012), (-0.017, -0.071), (0.063, -0.054), (0.071, 0.049), (-0.023, 0.067)]
HOLE = [(-0.0213, -0.0187), (0.0231, -0.0204), (0.0198, 0.0241), (-0.0247, 0.0176)]

rnd = random.Random(5070)
STAR = []
for i in range(300):
    a = 2 * math.pi * i / 300
    rad = (0.05 if i % 2 else 0.028) * (1 + 0.15 * (rnd.random() - 0.5))
    STAR.append((rad * math.cos(a) * 1.3, rad * math.sin(a)))

west_lng, west_lat = TO_LL.transform(rg.X0, rg.Y0 - 6000 * rg.CELL)

LNGLAT = {
    "square": [[ring(LNG, LAT, SQ)]],
    "donut": [[ring(LNG, LAT, PENT), ring(LNG, LAT, HOLE, cw=True)]],
    "bowtie": [[ring(LNG, LAT, [(-0.061, -0.052), (0.057, 0.049), (0.059, -0.047), (-0.054, 0.058)])]],
    "overlap": [[ring(LNG, LAT, [(-0.062, -0.041), (0.021, -0.043), (0.019, 0.039), (-0.058, 0.042)])],
                [ring(LNG, LAT, [(-0.018, -0.022), (0.061, -0.019), (0.058, 0.061), (-0.021, 0.057)])]],
    "cw-outer": [[ring(LNG, LAT, PENT, cw=True), ring(LNG, LAT, HOLE)]],
    "island-in-hole": [[ring(LNG, LAT, PENT), ring(LNG, LAT, HOLE, cw=True)],
                       [ring(LNG, LAT, [(-0.0091, -0.0083), (0.0103, -0.0079), (0.0087, 0.0094)])]],
    "star": [[ring(LNG, LAT, STAR)]],
    "grid-edge": [[ring(west_lng, west_lat, [(-0.031, -0.043), (0.052, -0.039), (0.047, 0.051), (-0.036, 0.046)])]],
}

# ---- tie set: exact ties need exact arithmetic, so it has its own grid (cell 256, origin 0:
# GDAL's inverse geotransform and grid.ts's (x - x0) / cell are both exact there; on GRID_250 a
# tie falls whichever way GDAL's rounding sends it). Pixel (u, v) -> metres.
TIE_GRID = {"crs": rg.CRS, "origin": [0.0, 4096.0], "cell": 256.0, "cols": 16, "rows": 16}
TIE_BOX = {"col0": 0, "row0": 0, "cols": 16, "rows": 16}


def m(u, v):
    return [u * TIE_GRID["cell"], TIE_GRID["origin"][1] - v * TIE_GRID["cell"]]


def mring(pts, cw=False):
    """pts in pixel (u, v), listed clockwise on screen (y down) = counter-clockwise on the map."""
    r = [m(u, v) for u, v in pts]
    if cw:
        r.reverse()
    return r + [r[0]]


SQ_C = [(1.5, 1.5), (6.5, 1.5), (6.5, 7.5), (1.5, 7.5)]
TIES = {
    "centre-lines": [[mring(SQ_C)]],
    "centre-lines-cw": [[mring(SQ_C, cw=True)]],
    "tie-donut": [[mring([(0.5, 0.5), (9.5, 0.5), (9.5, 9.5), (0.5, 9.5)]),
                   mring([(2.5, 2.5), (6.5, 2.5), (6.5, 6.5), (2.5, 6.5)], cw=True)]],
    "tie-diag": [[mring([(0.5, 0.5), (8.5, 8.5), (0.5, 8.5)])]],
    "tie-notch": [[mring([(0.5, 0.5), (9.5, 0.5), (9.5, 9.5), (6.5, 9.5), (6.5, 4.5),
                          (3.5, 4.5), (3.5, 9.5), (0.5, 9.5)])]],
    "tie-spike": [[mring([(9, 8.5), (9, 11.5), (5.5, 11.5), (5.5, 3.5), (2.5, 3.5), (2.5, 11.5),
                          (1.5, 11.5), (9, 11.5)])]],
    "corners": [[mring([(1, 1), (7, 1), (7, 9), (1, 9)])]],
}
# Random rings with every vertex on the half-cell lattice: ties everywhere, including
# self-overlapping horizontal runs and duplicate pivots of the ring-orientation test.
tr = random.Random(256)
for k in range(40):
    polys = []
    for _ in range(tr.choice([1, 1, 2])):
        n = tr.randint(3, 7)
        rings = []
        for _ in range(tr.choice([1, 1, 2])):
            if tr.random() < 0.5:
                pts = [(tr.randint(1, 28) / 2, tr.randint(1, 28) / 2) for _ in range(n)]
            else:
                pts, x, y = [], tr.randint(1, 13) + 0.5, tr.randint(1, 13) + 0.5
                for j in range(n):
                    if j % 2:
                        y = tr.randint(1, 13) + 0.5
                    else:
                        x = tr.randint(1, 13) + tr.choice([0, 0.5])
                    pts.append((x, y))
                pts.append((pts[0][0], pts[-1][1]))
            rings.append(mring(pts))
        polys.append(rings)
    TIES[f"tie-random-{k:02d}"] = polys


def rows_of(a):
    return ["".join("1" if v else "0" for v in row) for row in a]


fixtures = []
for name, polys in LNGLAT.items():
    xy = project(polys)
    box = {"col0": 0, "row0": 6000 - BOX // 2, "cols": BOX, "rows": BOX} if name == "grid-edge" \
        else box_around(LNG, LAT)
    a = burn(xy, box)
    mg = margin(xy, box)
    assert mg > 1e-6, f"{name}: a cell centre lies {mg} cells from an edge"
    assert 0 < a.sum() < a.size, f"{name}: trivial raster"
    fixtures.append({"name": name, "crs": "lnglat", "polygons": polys, "box": box, "rows": rows_of(a)})
    print(f"{name:16s} {int(a.sum()):5d} cells, margin {mg:.2e}")

for name, polys in TIES.items():
    a = burn(polys, TIE_BOX, TIE_GRID)
    if not name.startswith("tie-random"):
        assert 0 < a.sum() < a.size, f"{name}: trivial raster"
    fixtures.append({"name": name, "crs": "5070", "grid": TIE_GRID, "polygons": polys, "box": TIE_BOX,
                     "rows": rows_of(a)})
    print(f"{name:16s} {int(a.sum()):5d} cells")

out = {
    "made_by": f"make-upload-ref.py: pyproj + rasterio {rasterio.__version__} (GDAL {rasterio.__gdal_version__})",
    "grid": {"crs": rg.CRS, "origin": [rg.X0, rg.Y0], "cell": rg.CELL, "cols": rg.COLS, "rows": rg.ROWS},
    "fixtures": fixtures,
}
with open(os.path.join(HERE, "upload-ref.json"), "w") as f:
    json.dump(out, f, indent=1)
    f.write("\n")
