"""Writes the mini columns Parquet fixtures columns-read.test.ts reads (run: venv/bin/python make-fixtures.py).

Runs scripts/build_columns_parquet.py --fixture --row-group-size 4 over three small datasets:
a world line set (12 rows, 3 row groups; fids above 2^32, real admin-1 and country lists, nulls,
"", -1 kV), a polygon set with a string id (one hole; a null type and customers) and a point set with a String nominal_kv. Output:
analysis/ (columns/<ds>.<sha8>.parquet + index.json) and <ds>.features.json, the same rows as
GeoJSON the way the tiles carry them (native id as the feature id, nulls left out): the parity
reference for the TS tests.

Also writes decode/multipage.parquet for columns-decode.test.ts: 1,500 rows in 3 row groups with
the columns preset, but pages of ~512 bytes, so each column chunk spans many data pages and the
name column's dictionary overflows into plain pages; a float column holds -0.0, NaN and nulls.
"""
import json
import shutil
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent.parent.parent / "scripts"))
import build_columns_parquet as bcp  # noqa: E402

E = 10 ** 10  # fids above 2^32


def line(i, kv, name, admin1, states, coords):
    countries = {"|none|": "|FRA|" if coords[0][0] < 5 else "|DEU|"}.get(admin1, "|USA|")
    return {"fid": E + i * 10 + 2, "nominal_kv": kv, "name": name, "admin1": admin1,
            "states": states, "countries": countries}, coords


# Real admin-1 codes (scripts/admin1_codes.csv): USAB Texas, USAA New Mexico.
TX, NM = "|USAB|USAA|", "|USAA|"
LINES = [line(i, kv, name, a, s, c) for i, (kv, name, a, s, c) in enumerate([
    (345, "Alpha", "|USAB|", "|TX|", [[-97.0, 32.0], [-96.5, 32.4]]),
    (138, None, "|USAB|", "|TX|", [[-97.2, 31.0], [-96.9, 31.3]]),
    (-1, "", "|USAB|", "|TX|", [[-99.0, 31.5], [-98.4, 31.9]]),
    (230, "Bravo", "|USAB|", "|TX|", [[-101.9, 33.5], [-101.0, 33.9]]),
    (115, "Charlie", TX, "|TX|NM|", [[-103.2, 32.5], [-102.8, 32.9]]),
    (500, "Delta", TX, "|TX|NM|", [[-103.1, 33.0], [-102.2, 33.4]]),
    (69, None, "|USAA|", "|NM|", [[-106.7, 35.1], [-106.2, 35.3]]),
    (-1, "Echo", "|USAA|", "|NM|", [[-106.9, 32.3], [-106.5, 32.6]]),
    (345, "Foxtrot", "|USAA|", "|NM|", [[-108.2, 32.7], [-107.6, 33.0]]),
    (230, "Golf", "|USAA|", "|NM|", [[-107.9, 36.7], [-107.2, 36.9]]),
    (400, "Hotel", "|none|", "|none|", [[2.3, 48.8], [2.9, 49.2]]),
    (220, "India", "|none|", "|none|", [[11.5, 48.1], [12.0, 48.4]]),
], start=1)]


def sq(x, y, d=1.0):
    return [[x, y], [x + d, y], [x + d, y + d], [x, y + d], [x, y]]


POLYS = [
    ({"id": f"R{i}", "name": n, "retail": f"|{n}|", "type": t, "customers": c}, g)
    for i, (n, t, c, g) in enumerate([
        ("Aqua", "COOPERATIVE", 1200, [sq(-100, 31)]),
        ("Birch", "INVESTOR OWNED", 350000, [sq(-100, 33), sq(-99.7, 33.3, 0.4)[::-1]]),
        ("Cedar", None, None, [sq(-106, 34)]),
        ("Dune", "MUNICIPAL", 0, [sq(-105, 32)]),
        ("Elm", "COOPERATIVE", 8800, [sq(-98, 29)]),
        ("Fir", "STATE", 52000, [sq(10, 48)]),
    ], start=1)
]

POINTS = [
    ({"fid": E + i * 10 + 1, "nominal_kv": kv, "name": n}, [x, y])
    for i, (kv, n, x, y) in enumerate([
        ("345", "S1", -97.0, 32.0), ("138", "S2", -97.2, 31.0), ("230", "S3", -101.5, 33.7),
        ("115", None, -106.6, 35.2), ("69", "S5", -108.0, 32.8), ("400", "S6", 2.5, 48.9)], start=1)
]

# dataset -> (geometry type, rows, fields, id property, native)
DATASETS = {
    "osm_transmission_lines": ("LineString", LINES, "fid", True,
                               {"fid": "Number", "nominal_kv": "Number", "name": "String",
                                "admin1": "String", "states": "String", "countries": "String"}),
    "retail_territories": ("Polygon", POLYS, "id", False,
                           {"id": "String", "name": "String", "retail": "String",
                            "type": "String", "customers": "Number"}),
    "osm_substations_points": ("Point", POINTS, "fid", True,
                               {"fid": "Number", "nominal_kv": "String", "name": "String"}),
}


def multipage(path):
    """The decode fixture: multi-page chunks, a dictionary-to-plain fallback, -0.0 and NaN."""
    import pyarrow as pa
    import geoparquet_common as gc
    n = 1500
    kv = [None if i % 7 == 3 else -0.0 if i % 11 == 5 else float("nan") if i % 13 == 6 else float(i % 9) * 57.5
          for i in range(n)]
    table = pa.table({
        "fid": pa.array([E + i * 10 + 2 for i in range(n)], pa.int64()),
        "name": pa.array([None if i % 17 == 0 else "" if i % 19 == 0 else f"line {i:04d}" for i in range(n)]),
        "kind": pa.array([None if i % 5 == 4 else ("ac", "dc", "été")[i % 3] for i in range(n)]),
        "nominal_kv": pa.array(kv, pa.float64()),
        "built": pa.array([None if i % 6 == 0 else i % 4 == 1 for i in range(n)], pa.bool_()),
        "px": pa.array([-97_000_000 + i * 1000 for i in range(n)], pa.int32()),
        "length_km": pa.array([None if i % 8 == 0 else i / 3 for i in range(n)], pa.float32()),
    })
    preset = dict(gc.COLUMNS_PRESET, row_group_size=600, data_page_size=512,
                  dictionary_pagesize_limit=256, write_batch_size=16)
    gc.write_parquet(table, path, preset, metadata={"build_id": "fixture", "dataset": "multipage"},
                     no_dictionary={"fid", "px", "length_km"})


def main():
    tmp = Path(tempfile.mkdtemp())
    inp = tmp / "input"
    inp.mkdir()
    fields = {}
    feats = {}
    for ds, (gt, rows, idf, native, flds) in DATASETS.items():
        fields[ds] = flds
        fc = []
        with open(inp / f"{ds}.geojsonl", "w") as f:
            for props, geom in rows:
                f.write(json.dumps({"type": "Feature", "properties": props,
                                    "geometry": {"type": gt, "coordinates": geom}},
                                   sort_keys=True) + "\n")
                p = {k: v for k, v in props.items() if v is not None and not (native and k == idf)}
                ft = {"type": "Feature", "properties": p,
                      "geometry": {"type": gt, "coordinates": geom}}
                if native:
                    ft["id"] = props[idf]
                fc.append(ft)
        feats[ds] = {"type": "FeatureCollection", "features": fc}
    (inp / "fields.json").write_text(json.dumps(fields, sort_keys=True))
    bcp.main(["--fixture", str(tmp), "--row-group-size", "4"])
    out = HERE / "analysis"
    shutil.rmtree(out, ignore_errors=True)
    shutil.copytree(tmp / "analysis", out)
    shutil.rmtree(tmp)
    (HERE / "decode").mkdir(exist_ok=True)
    multipage(HERE / "decode" / "multipage.parquet")
    for ds, fc in feats.items():
        (HERE / f"{ds}.features.json").write_text(json.dumps(fc, sort_keys=True, indent=1) + "\n")
    total = sum(p.stat().st_size for p in HERE.rglob("*") if p.is_file() and p.suffix != ".py")
    print(f"wrote {HERE} ({total:,} bytes)")


if __name__ == "__main__":
    main()
