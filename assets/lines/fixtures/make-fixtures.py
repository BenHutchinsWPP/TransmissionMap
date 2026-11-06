"""Writes the mini line GeoParquet line-read.test.ts reads (run: venv/bin/python make-fixtures.py).

Runs scripts/build_line_parquet.py --fixture over a small input, so the files have the real
layout (IDX, Hilbert GEO with 256-row pages and a page index, CHAINS, manifests, index.json),
then copies the output to analysis/ beside this script.

OSM input: the chain fixture of scripts/test_line_parquet.py (fids 11-71: 11, 21 (drawn
reversed) and 31 form one 230 kV chain from a substation polygon to a tap), plus a 30 x 20 grid
of short 115 kV lines near (20°E, 10°N), fids 1000-1599, so GEO spans three pages and a bbox read
can skip some. HIFLD input: ID "160421" (a two-part MultiLineString) and "99".
"""
import json
import shutil
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent.parent.parent / "scripts"))
import build_line_parquet as blp  # noqa: E402
from test_line_parquet import LINES, SUB_POLY_FID, SUB_POINT_FID, _feature  # noqa: E402


def main():
    tmp = Path(tempfile.mkdtemp())
    inp = tmp / "input"
    inp.mkdir()
    with open(inp / "transmission_world.geojsonl", "w") as f:
        for fid, kv, circ, coords in LINES:
            f.write(_feature({"fid": fid, "nominal_kv": kv, "circuits": circ}, coords) + "\n")
        for i in range(600):
            x, y = 20 + (i % 30) * 0.1, 10 + (i // 30) * 0.1
            f.write(_feature({"fid": 1000 + i, "nominal_kv": 115.0, "circuits": 1},
                             [[round(x, 6), round(y, 6)], [round(x + 0.05, 6), round(y + 0.01, 6)]]) + "\n")
    ring = [[-0.001, -0.001], [0.001, -0.001], [0.001, 0.001], [-0.001, 0.001], [-0.001, -0.001]]
    (inp / "substation_polygons.geojsonl").write_text(
        _feature({"fid": SUB_POLY_FID}, [ring], "Polygon") + "\n")
    (inp / "substation_points.csv").write_text(f"fid,lon,lat\n{SUB_POINT_FID},0.030011,0.010559\n")
    with open(inp / "transmission_hifld.geojsonl", "w") as f:
        f.write(_feature({"ID": "160421"}, [[[-157.1, 21.9], [-157.2, 22.0]],
                                            [[-157.3, 22.1], [-157.31, 22.11]]],
                         "MultiLineString") + "\n")
        f.write(_feature({"ID": "99"}, [[[-120.000001, 35.5], [-120.1, 35.6]]],
                         "MultiLineString") + "\n")
    blp.main(["--fixture", str(tmp)])
    out = HERE / "analysis"
    shutil.rmtree(out, ignore_errors=True)
    shutil.copytree(tmp / "analysis", out)
    shutil.rmtree(tmp)
    total = sum(p.stat().st_size for p in out.rglob("*") if p.is_file())
    print(f"wrote {out} ({total:,} bytes)")
    print(json.dumps(json.loads((out / "index.json").read_text())["datasets"]["osm_transmission_lines"]["geo"], indent=1))


if __name__ == "__main__":
    main()
