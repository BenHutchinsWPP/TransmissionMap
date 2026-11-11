"""Writes the mini routing cube route.test.ts reads (run: python3 make-cube.py; needs GDAL + numpy).

cube/: a 90 x 60-cell grid of 250 m cells (super-tile 64, block 32, so super-tile 1_0 is a
26-wide edge file and every file ends in partial blocks), same layout as the real cube (band spec v8):
  pd_{c}_{r}.tif  19 bands landcover, slope, protect, agency, wildfire, whpclass, flags, state,
                  desig, flags2, isoreg, landval, bldg, wetland, built, nonres, bldgunk, aviation, nfhl
  osm_{c}_{r}.tif 3 bands flags, maxkv, adj
Band order, code tables and `version` come from scripts/route_grid.py (grid_json(), geometry overridden).
Everywhere: grassland (71), slope bin 1, agency 1, wildfire 1, whpclass 1, state 8 (CO),
isoreg TEPPC, landval $1,500/ac, bldg 1 (no home; 0 under the wall), wetland 1 (none; 0 under the wall), adj class 0 (computed).
Row 5, cols 75-81 (super-tile 1_0, off every tested path) carry one v3 bit each: flags bit 7 at col 75,
flags2 bits 2, 3, 4, 6, 7 at cols 76-80; adj at (75, 7) is >= 230 kV class 1 + 100-229 kV class 2,
at (76, 7) 100-229 kV class 3 only, at (85, 7) on a >= 500 kV line (class 1, bits 2 and 3),
at (86, 7) within 1 cell of a >= 345 kV line only (class 2, bit 2).
Row 5, cols 82-84 carry bldg 2, 5 and 12 (1, 4 and 11 homes).
Row 5, cols 86-88 carry wetland 11, 41 and 81 (10, 40 and 80 % of the cell).
aviation and nfhl are 1 (evaluated, none) on land, 0 under the wall; row 9, cols 75-79 carry
aviation 2-6, and row 9, cols 82-83 carry nfhl 2 (SFHA) and 3 (no effective panel).
Observed building coverage is cols 10-35, rows 5-40; nonresidential footprints
fill col 25, rows 15-35. Unknown-class footprint at (30, 8) has a tiny positive share.
A wall of state 0 (barrier) fills column 40 except a gap at rows 55-57.

cube-wall/: the same grid and values, but the wall in column 40 has two gaps, rows 12-14 and
45-47, so a route from row 29 on one side to row 29 on the other has two near-equal choices
(about 2.5 % apart) for the Alternatives test.
"""
import json
import os
import sys
import numpy as np
from osgeo import gdal, osr

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..", "scripts"))
import route_grid as rg  # noqa: E402

gdal.UseExceptions()

fixtures = os.path.dirname(os.path.abspath(__file__))
X0, Y0, CELL, COLS, ROWS, SUPER, BLOCK = -1000000.0, 2000000.0, 250.0, 90, 60, 64, 32
OPTS = ["COMPRESS=DEFLATE", "PREDICTOR=NO", "INTERLEAVE=PIXEL", "BIGTIFF=NO", "OVERVIEWS=NONE",
        f"BLOCKSIZE={BLOCK}"]
srs = osr.SpatialReference()
srs.ImportFromEPSG(5070)


def write_cube(name, gaps):
    """Writes fixtures/<name>/: the uniform grid with a wall down column 40, open at `gaps` (row slices)."""
    here = os.path.join(fixtures, name)
    os.makedirs(here, exist_ok=True)
    pd = np.zeros((len(rg.PD_BANDS), ROWS, COLS), np.uint8)
    pd[0], pd[1], pd[3], pd[4], pd[5], pd[7] = 71, 1, 1, 1, 1, 8
    pd[7, :, 40] = 0
    for g in gaps:
        pd[7, g, 40] = 8
    pd[10] = rg.ISO_CODE_BY_NAME["TEPPC"]
    pd[11] = rg.landval_encode(1500)
    pd[12] = np.where(pd[7] > 0, rg.bldg_encode(0), 0)
    pd[13] = np.where(pd[7] > 0, rg.wetland_encode(0), 0)
    pd[14:17, 5:41, 10:36] = 1
    pd[14:16, 15:36, 25] = rg.footprint_encode(1)
    pd[14, 8, 30] = pd[16, 8, 30] = rg.footprint_encode(0.000001)
    pd[17] = np.where(pd[7] > 0, 1, 0)  # aviation
    pd[18] = np.where(pd[7] > 0, 1, 0)  # nfhl
    pd[17, 9, 75:80] = [2, 3, 4, 5, 6]
    pd[18, 9, 82:84] = [2, 3]
    osm = np.zeros((len(rg.OSM_BANDS), ROWS, COLS), np.uint8)
    osm[2] = rg.adj_encode(0)
    pd[6, 5, 75] = 1 << 7
    for col, bit in zip(range(76, 81), (2, 3, 4, 6, 7)):
        pd[9, 5, col] = 1 << bit
    for col, n in zip(range(82, 85), (1, 4, 11)):
        pd[12, 5, col] = rg.bldg_encode(n)
    for col, share in zip(range(86, 89), (0.1, 0.4, 0.8)):
        pd[13, 5, col] = rg.wetland_encode(share)
    osm[2, 7, 75] = rg.adj_encode(1, 2)
    osm[2, 7, 76] = rg.adj_encode(0, 3)
    osm[2, 7, 85] = rg.adj_encode(1, 0, True, True)
    osm[2, 7, 86] = rg.adj_encode(2, 0, True)

    for kind, arr in (("pd", pd), ("osm", osm)):
        for sc in range((COLS + SUPER - 1) // SUPER):
            c0 = sc * SUPER
            sub = arr[:, :, c0:c0 + SUPER]
            mem = gdal.GetDriverByName("MEM").Create("", sub.shape[2], ROWS, sub.shape[0], gdal.GDT_Byte)
            mem.SetGeoTransform((X0 + c0 * CELL, CELL, 0, Y0, 0, -CELL))
            mem.SetProjection(srs.ExportToWkt())
            for k in range(sub.shape[0]):
                mem.GetRasterBand(k + 1).WriteArray(sub[k])
            out = os.path.join(here, f"{kind}_{sc}_0.tif")
            if os.path.exists(out):
                os.remove(out)
            gdal.Translate(out, mem, format="COG", creationOptions=OPTS)  # BLOCKSIZE < 128 warns; honoured

    grid = rg.grid_json({
        "origin": [X0, Y0], "cell": CELL, "cols": COLS, "rows": ROWS, "super": SUPER, "block": BLOCK,
        "super_tiles_present": [[0, 0], [1, 0]],
    })
    with open(os.path.join(here, "grid.json"), "w") as f:
        json.dump(grid, f, indent=1)


write_cube("cube", [slice(55, 58)])
write_cube("cube-wall", [slice(12, 15), slice(45, 48)])
