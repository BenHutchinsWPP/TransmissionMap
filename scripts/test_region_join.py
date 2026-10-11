"""Tests for region_join.py — the region value codec, the admin-1 short-code
table, the REGION_STATS format, retail ID disambiguation, the GeoPackage
helpers, and (under venv/bin/python only) the spatial join and the file
taggers over toy boundaries. Synthetic files only; no data/."""
import contextlib
import gzip
import hashlib
import importlib.util
import io
import json
import sqlite3
import tempfile
import unittest
from pathlib import Path

import region_join as rj

_HAS_GEO = all(importlib.util.find_spec(m) for m in ("shapely", "pyogrio", "numpy"))


class CodecTests(unittest.TestCase):
    def test_encode_sorts_dedupes_wraps(self):
        self.assertEqual(rj.encode(["TX", "NM", "TX"]), "|NM|TX|")
        self.assertEqual(rj.encode(["USA1"]), "|USA1|")

    def test_encode_empty_is_none(self):
        self.assertEqual(rj.encode([]), "|none|")

    def test_encode_rejects_bad_codes(self):
        for bad in ("a|b", "a b", "", "none", "a\tb", "TX\n"):
            with self.assertRaises(ValueError, msg=bad):
                rj.encode([bad])

    def test_decode(self):
        self.assertEqual(rj.decode("|NM|TX|"), ["NM", "TX"])
        self.assertEqual(rj.decode("|none|"), [])
        for bad in ("TX", "|TX", "||", "|TX||NM|", "|none|TX|"):
            with self.assertRaises(ValueError, msg=bad):
                rj.decode(bad)

    def test_prefer(self):
        self.assertEqual(rj.prefer("TX", "|NM|"), "|TX|")
        self.assertEqual(rj.prefer(" TX ", "|NM|"), "|TX|")
        for blank in (None, "", "  "):
            self.assertEqual(rj.prefer(blank, "|NM|"), "|NM|")

    def test_base36(self):
        self.assertEqual([rj.to_base36(n) for n in (0, 9, 10, 35, 36, 1295)],
                         ["0", "9", "a", "z", "10", "zz"])


class Admin1Tests(unittest.TestCase):
    def test_new_table_orders_by_shape_id_within_country(self):
        cur = [("B2", "USA", "b"), ("A1", "USA", "a"), ("C1", "CAN", "c")]
        rows = rj.assign_admin1_codes([], cur)
        self.assertEqual({r["shapeID"]: r["code"] for r in rows},
                         {"A1": "USA0", "B2": "USA1", "C1": "CAN0"})
        self.assertTrue(all(r["current"] == "1" for r in rows))

    def test_known_ids_keep_codes_and_new_ones_append(self):
        first = rj.assign_admin1_codes([], [("A1", "USA", "a"), ("B2", "USA", "b")])
        again = rj.assign_admin1_codes(first, [("0", "USA", "new"), ("A1", "USA", "a"), ("B2", "USA", "b")])
        codes = {r["shapeID"]: r["code"] for r in again}
        self.assertEqual((codes["A1"], codes["B2"], codes["0"]), ("USA0", "USA1", "USA2"))

    def test_retired_unit_stays_and_code_is_not_reused(self):
        first = rj.assign_admin1_codes([], [("A1", "USA", "a"), ("B2", "USA", "b")])
        second = rj.assign_admin1_codes(first, [("B2", "USA", "b"), ("C3", "USA", "c")])
        by_id = {r["shapeID"]: r for r in second}
        self.assertEqual((by_id["A1"]["code"], by_id["A1"]["current"]), ("USA0", "0"))
        self.assertEqual(by_id["C3"]["code"], "USA2")

    def test_base36_ordinals_and_length_cap(self):
        cur = [(f"id{n:03d}", "RUS", "x") for n in range(40)]
        rows = rj.assign_admin1_codes([], cur)
        self.assertEqual(rows[-1]["code"], "RUS13")
        self.assertTrue(all(len(r["code"]) <= 5 for r in rows))

    def test_table_round_trip(self):
        rows = rj.assign_admin1_codes([], [("A1", "USA", "a, b")])
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "t.csv"
            rj.write_admin1_table(rows, p)
            self.assertEqual(rj.read_admin1_table(p), rows)
            self.assertEqual(rj.read_admin1_table(Path(d) / "missing.csv"), [])


    def test_code_over_five_chars_raises(self):
        cur = [(f"id{i:05d}", "USA", "u") for i in range(1297)]
        with self.assertRaises(ValueError):
            rj.assign_admin1_codes([], cur)


class StatsTests(unittest.TestCase):
    def test_format(self):
        vals = {"states": ["|TX|", "|NM|TX|", "|none|", None, ""]}
        self.assertEqual(rj.stats_lines("padus", vals),
                         ["REGION_STATS padus states n=5 absent=2 none=1 multi=1 maxlen=7"])


class RetailTests(unittest.TestCase):
    def test_unique_ids_unchanged(self):
        self.assertEqual(rj.retail_ids([(1, b"a"), (2, b"b")]), ["1", "2"])

    def test_duplicates_suffixed_by_wkb_hash_order(self):
        import hashlib
        a, b = b"first", b"second"
        lo, hi = sorted([a, b], key=lambda w: hashlib.sha1(w).hexdigest())
        ids = rj.retail_ids([("7", hi), ("7", lo), ("8", b"x")])
        self.assertEqual(ids, ["7_2", "7", "8"])

    def test_bad_id_raises(self):
        with self.assertRaises(ValueError):
            rj.retail_ids([("a|b", b"x")])


    def test_suffix_collision_raises(self):
        with self.assertRaises(ValueError):
            rj.retail_ids([("7", b"a"), ("7", b"b"), ("7_2", b"c")])


class CliTests(unittest.TestCase):
    def test_prefer_without_equals_is_an_argparse_error(self):
        with contextlib.redirect_stderr(io.StringIO()) as err, self.assertRaises(SystemExit):
            rj.main(["tag", "--scope", "usa", "x.csv", "--prefer", "state"])
        self.assertIn("expected COL=FIELD, got 'state'", err.getvalue())


class BoundaryTests(unittest.TestCase):
    def test_registry_covers_every_non_zcta_field(self):
        self.assertEqual(set(rj.BOUNDARIES), set(rj.REGION_FIELDS) - {"zcta"})
        self.assertEqual(rj.BOUNDARIES["admin1"][1], "code")
        self.assertEqual(rj.BOUNDARIES["retail"][1], "id")

    def test_missing_boundaries_names_file_and_target(self):
        saved = rj.BOUNDARIES
        try:
            rj.BOUNDARIES = {"states": (Path("/nonexistent/us_states.gpkg"), "stusps", "census-boundaries")}
            self.assertEqual(rj.missing_boundaries(["states"]),
                             [(Path("/nonexistent/us_states.gpkg"), "census-boundaries")])
        finally:
            rj.BOUNDARIES = saved


def _gpkg_shaped(path):
    """A sqlite file shaped like a GDAL gpkg: a feature table plus a trigger that
    names ST_IsEmpty, written the way GDAL's rtree triggers are."""
    con = sqlite3.connect(path)
    con.executescript("""
        CREATE TABLE gpkg_contents (table_name TEXT, data_type TEXT);
        INSERT INTO gpkg_contents VALUES ('t', 'features');
        CREATE TABLE t (fid INTEGER PRIMARY KEY, geom BLOB, name TEXT);
        INSERT INTO t VALUES (1, x'00', 'a'), (2, x'01', 'b');
        CREATE TABLE idx (id, minx, maxx, miny, maxy);
        CREATE TRIGGER rtree_t_geom_update4 AFTER UPDATE ON t
        WHEN OLD.fid != NEW.fid AND (NEW.geom IS NOT NULL AND NOT ST_IsEmpty(NEW.geom))
        BEGIN
          INSERT OR REPLACE INTO idx VALUES (NEW.fid, ST_MinX(NEW.geom), ST_MaxX(NEW.geom),
                                             ST_MinY(NEW.geom), ST_MaxY(NEW.geom));
        END;
    """)
    con.commit()
    con.close()


class GpkgTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.path = str(Path(self._tmp.name) / "x.gpkg")
        _gpkg_shaped(self.path)

    def test_update_needs_the_stubs(self):
        con = sqlite3.connect(self.path)
        with self.assertRaises(sqlite3.OperationalError):
            con.execute("UPDATE t SET name = 'z' WHERE fid = 1")
        rj.gpkg_stub_functions(con)
        con.execute("UPDATE t SET name = 'z' WHERE fid = 1")
        con.commit()
        self.assertEqual(con.execute("SELECT name FROM t WHERE fid = 1").fetchone()[0], "z")
        con.close()

    def test_stubs_raise_when_called(self):
        con = sqlite3.connect(":memory:")
        self.addCleanup(con.close)
        rj.gpkg_stub_functions(con)
        for name in ("ST_IsEmpty", "ST_MinX", "ST_MaxX", "ST_MinY", "ST_MaxY"):
            with self.assertRaises(sqlite3.OperationalError) as cm:
                con.execute(f"SELECT {name}(x'00')")
            self.assertIn("user-defined function raised", str(cm.exception))

    def test_row_hash_tracks_rows_not_file_bytes(self):
        h = rj.gpkg_row_hash(self.path)
        con = sqlite3.connect(self.path)
        rj.gpkg_stub_functions(con)
        con.execute("UPDATE t SET name = 'z' WHERE fid = 1")
        con.execute("UPDATE t SET name = 'a' WHERE fid = 1")
        con.commit()
        con.close()
        self.assertEqual(rj.gpkg_row_hash(self.path), h)
        con = sqlite3.connect(self.path)
        con.execute("INSERT INTO t VALUES (3, x'02', 'c')")
        con.commit()
        con.close()
        self.assertNotEqual(rj.gpkg_row_hash(self.path), h)

    def test_file_hash_dispatch(self):
        p = Path(self._tmp.name) / "a.csv"
        p.write_text("a\n")
        self.assertEqual(len(rj.file_hash(p)), 64)
        self.assertEqual(rj.file_hash(self.path), rj.gpkg_row_hash(self.path))


def _write_layer(path, geoms, fields, geometry_type, crs="EPSG:4326", driver=None):
    """A GDAL/pyogrio-written layer (a gpkg gets its spatial index and rtree triggers)."""
    import numpy as np
    import pyogrio.raw
    import shapely
    pyogrio.raw.write(str(path), shapely.to_wkb(np.array(geoms, dtype=object)),
                      [np.array(v) for v in fields.values()], list(fields),
                      geometry_type=geometry_type, crs=crs, driver=driver)


@unittest.skipUnless(_HAS_GEO, "shapely, pyogrio and numpy are not installed")
class GeoTestCase(unittest.TestCase):
    """Toy boundaries: states AA (x 0..1) and BB (x 1..2) in a USA box y 0..1,
    with CAN above it (y 1..2)."""

    @classmethod
    def setUpClass(cls):
        from shapely.geometry import MultiPolygon, box
        cls._tmp = tempfile.TemporaryDirectory()
        d = Path(cls._tmp.name)
        a, b, us, ca = box(0, 0, 1, 1), box(1, 0, 2, 1), box(0, 0, 2, 1), box(0, 1, 2, 2)
        layers = {
            "countries": ("countries.gpkg", "iso_a3", [us, ca], ["USA", "CAN"]),
            "admin1": ("admin1.gpkg", "code", [a, b, ca], ["USA0", "USA1", "CAN0"]),
            "states": ("states.gpkg", "stusps", [a, b], ["AA", "BB"]),
            "counties": ("counties.geojson", "GEOID", [a, b], ["01001", "01003"]),
            "ba": ("ba.gpkg", "abbrev", [us], ["BA1"]),
            "nerc": ("nerc.gpkg", "code", [a, b, a], ["N1", "N2", "N1"]),
            "retail": ("retail.gpkg", "id", [MultiPolygon([a, b])], ["7"]),
        }
        cls._saved = rj.BOUNDARIES
        rj.BOUNDARIES = {}
        for field, (name, key, geoms, codes) in layers.items():
            _write_layer(d / name, geoms, {key: codes}, "Unknown")
            rj.BOUNDARIES[field] = (d / name, key, "make-" + field)

    @classmethod
    def tearDownClass(cls):
        rj.BOUNDARIES = cls._saved
        cls._tmp.cleanup()

    def setUp(self):
        self.dir = Path(tempfile.mkdtemp(dir=self._tmp.name))

    def quiet(self, fn, *args, **kwargs):
        with contextlib.redirect_stdout(io.StringIO()) as out:
            result = fn(*args, **kwargs)
        self.printed = out.getvalue()
        return result


class JoinTests(GeoTestCase):
    def test_point_on_a_border_gets_both(self):
        from shapely.geometry import Point
        self.assertEqual(rj.join([Point(1, 0.5)], "states"), ["|AA|BB|"])

    def test_touch_only_line_and_polygon_excluded(self):
        from shapely.geometry import LineString, box
        self.assertEqual(rj.join([LineString([(0.2, 0.5), (1, 0.5)]), box(0.2, 0.2, 1, 0.8)],
                                 "states"), ["|AA|", "|AA|"])

    def test_line_along_a_border_keeps_both(self):
        from shapely.geometry import GeometryCollection, LineString, Point
        self.assertEqual(rj.join([LineString([(1, 0.2), (1, 0.8)]),
                                  GeometryCollection([Point(1, 0.5)])], "states"),
                         ["|AA|BB|", "|AA|BB|"])

    def test_polygon_on_a_shared_edge_drops_the_neighbour(self):
        from shapely.geometry import box
        self.assertEqual(rj.join([box(0.5, 0.2, 1, 0.8)], "states"), ["|AA|"])

    def test_multi_region_line(self):
        from shapely.geometry import LineString
        self.assertEqual(rj.join([LineString([(0.5, 0.5), (1.5, 0.5)])], "states"), ["|AA|BB|"])

    def test_empty_null_and_outside_are_none(self):
        from shapely.geometry import Point
        self.assertEqual(rj.join([Point(), None, Point(5, 5)], "states"), ["|none|"] * 3)

    def test_repeated_codes_and_leading_zeros(self):
        from shapely.geometry import Point
        self.assertEqual(rj.join([Point(0.5, 0.5)], "nerc"), ["|N1|"])
        self.assertEqual(rj.join([Point(0.5, 0.5)], "counties"), ["|01001|"])

    def test_giant_geometries_join_the_same(self):
        from unittest import mock
        from shapely.geometry import LineString, Point, box
        geoms = [Point(1, 0.5), LineString([(1, 0.2), (1, 0.8)]), box(0.2, 0.2, 1, 0.8),
                 LineString([(0.5, 0.5), (1.5, 0.5)]), Point(), None, Point(5, 5)]
        want = rj.join(geoms, "states")
        with mock.patch.object(rj, "GIANT", 0):
            self.assertEqual(rj.join(geoms, "states"), want)

    def test_global_omits_us_fields_outside_the_us(self):
        from shapely.geometry import Point
        v = rj.tag_geoms([Point(0.5, 0.5), Point(0.5, 1.5), Point(0.5, 1)], "global")
        self.assertEqual(list(v), list(rj.SCOPES["global"]))
        self.assertEqual(v["countries"], ["|USA|", "|CAN|", "|CAN|USA|"])
        self.assertEqual(v["admin1"], ["|USA0|", "|CAN0|", "|CAN0|USA0|"])
        self.assertEqual(v["counties"], ["|01001|", None, "|01001|"])
        self.assertEqual(v["retail"], ["|7|", None, "|7|"])

    def test_usa_scope_and_field_subset(self):
        from shapely.geometry import Point
        self.assertEqual(list(rj.tag_geoms([Point(0.5, 0.5)], "usa")), list(rj.FIELDS_USA))
        self.assertEqual(rj.tag_geoms([Point(0.5, 0.5)], "usa", ["ba"]), {"ba": ["|BA1|"]})
        with self.assertRaises(ValueError):
            rj.tag_geoms([Point(0.5, 0.5)], "usa", ["countries"])

    def test_missing_boundary_names_file_and_target(self):
        saved = rj.BOUNDARIES
        try:
            rj.BOUNDARIES = dict(saved, states=(Path("/nonexistent/s.gpkg"), "stusps", "census-boundaries"))
            with self.assertRaisesRegex(FileNotFoundError, r"/nonexistent/s.gpkg \(make census-boundaries\)"):
                rj.load_boundaries(["states"])
        finally:
            rj.BOUNDARIES = saved

    def test_reprojects_for_the_join_only(self):
        import pyproj
        from shapely.geometry import Point
        x, y = pyproj.Transformer.from_crs(4326, 3857, always_xy=True).transform(0.5, 0.5)
        path = self.dir / "m.gpkg"
        _write_layer(path, [Point(x, y)], {"name": ["p"]}, "Point", crs="EPSG:3857")
        self.quiet(rj.tag_file, path, "usa", fields=["states"])
        con = sqlite3.connect(path)
        self.assertEqual(con.execute("SELECT states FROM m").fetchone()[0], "|AA|")
        self.assertEqual(con.execute("SELECT srs_id FROM gpkg_geometry_columns").fetchone()[0], 3857)
        con.close()


class RoundTripTests(GeoTestCase):
    def test_gpkg_in_place_with_spatial_index(self):
        import numpy as np
        import pyogrio.raw
        from shapely.geometry import LineString
        path = self.dir / "lines.gpkg"
        _write_layer(path, [LineString([(0.5, 0.5), (1.5, 0.5)]), LineString([(5, 5), (6, 6)])],
                     {"name": ["x", "y"], "kv": np.array([345, 69], dtype="int64"),
                      "mw": np.array([1.5, 2.0])}, "LineString", driver="GPKG")
        con = sqlite3.connect(path)
        triggers = con.execute("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'rtree_%'").fetchall()
        self.assertTrue(triggers)
        info = con.execute('PRAGMA table_info("lines")').fetchall()
        gcols = con.execute("SELECT * FROM gpkg_geometry_columns").fetchall()
        con.close()

        self.quiet(rj.tag_file, path, "usa")
        self.assertEqual(len([l for l in self.printed.splitlines() if l.startswith("REGION_STATS lines.gpkg ")]), 5)
        con = sqlite3.connect(path)
        after = con.execute('PRAGMA table_info("lines")').fetchall()
        self.assertEqual(after[:len(info)], info)
        self.assertEqual([(r[1], r[2]) for r in after[len(info):]], [(f, "TEXT") for f in rj.FIELDS_USA])
        self.assertEqual(con.execute("SELECT * FROM gpkg_geometry_columns").fetchall(), gcols)
        self.assertEqual(con.execute("SELECT name, kv, mw, states, counties, retail FROM lines ORDER BY fid").fetchall(),
                         [("x", 345, 1.5, "|AA|BB|", "|01001|01003|", "|7|"),
                          ("y", 69, 2.0, "|none|", "|none|", "|none|")])
        con.close()
        meta = pyogrio.raw.read(path, read_geometry=False)[0]
        self.assertEqual(list(meta["fields"]), ["name", "kv", "mw", *rj.FIELDS_USA])

        h = rj.gpkg_row_hash(path)
        self.quiet(rj.tag_file, path, "usa")
        self.assertEqual(rj.gpkg_row_hash(path), h)
        con = sqlite3.connect(path)
        self.assertEqual(con.execute('PRAGMA table_info("lines")').fetchall(), after)
        con.close()

    def test_gpkg_failed_update_rolls_back_the_new_columns(self):
        from shapely.geometry import Point
        path = self.dir / "r.gpkg"
        _write_layer(path, [Point(0.5, 0.5)], {"name": ["p"]}, "Point", driver="GPKG")
        con = sqlite3.connect(path)
        con.execute("CREATE TRIGGER boom BEFORE UPDATE ON r BEGIN SELECT RAISE(ABORT, 'boom'); END")
        con.commit()
        info = con.execute('PRAGMA table_info("r")').fetchall()
        con.close()
        h = rj.gpkg_row_hash(path)
        with self.assertRaisesRegex(sqlite3.IntegrityError, "boom"):
            self.quiet(rj.tag_file, path, "usa")
        con = sqlite3.connect(path)
        self.assertEqual(con.execute('PRAGMA table_info("r")').fetchall(), info)
        con.close()
        self.assertEqual(rj.gpkg_row_hash(path), h)

    def test_rewrite_keeps_the_source_mode(self):
        import os
        path = self.dir / "m.csv"
        path.write_text("lat,lon\n0.5,0.5\n")
        os.chmod(path, 0o664)
        self.quiet(rj.tag_file, path, "usa", fields=["states"])
        self.assertEqual(path.stat().st_mode & 0o777, 0o664)

    def test_csv_without_lon_lat_names_the_file(self):
        path = self.dir / "nolonlat.csv"
        path.write_text("x,y\n1,2\n")
        with self.assertRaisesRegex(ValueError, "nolonlat.csv: no lon/lat"):
            self.quiet(rj.tag_file, path, "usa")

    def test_gpkg_out_leaves_the_source(self):
        from shapely.geometry import Point
        src, dst = self.dir / "p.gpkg", self.dir / "q.gpkg"
        _write_layer(src, [Point(0.5, 0.5)], {"name": ["p"]}, "Point", driver="GPKG")
        h = rj.gpkg_row_hash(src)
        self.quiet(rj.main, ["tag", "--scope", "usa", str(src), "--out", str(dst), "--fields", "states,ba"])
        self.assertEqual(rj.gpkg_row_hash(src), h)
        con = sqlite3.connect(dst)
        self.assertEqual(con.execute("SELECT states, ba FROM p").fetchone(), ("|AA|", "|BA1|"))
        con.close()

    def test_csv_keeps_strings_and_order(self):
        path = self.dir / "g.csv"
        path.write_text("plant_code,lat,lon,state\n007,0.5,0.5,ZZ\n010,0.5,1.5,\n011,,,\n")
        self.quiet(rj.tag_file, path, "usa", prefer={"state": "states"})
        rows = path.read_text().splitlines()
        self.assertEqual(rows[0], "plant_code,lat,lon,state," + ",".join(rj.FIELDS_USA))
        self.assertTrue(rows[1].startswith("007,0.5,0.5,ZZ,|ZZ|,|01001|,|BA1|,|N1|,|7|"))
        self.assertTrue(rows[2].startswith("010,0.5,1.5,,|BB|,|01003|"))
        self.assertEqual(rows[3], "011,,,," + ",".join(["|none|"] * 5))
        first = hashlib.sha256(path.read_bytes()).hexdigest()
        self.quiet(rj.tag_file, path, "usa", prefer={"state": "states"})
        self.assertEqual(hashlib.sha256(path.read_bytes()).hexdigest(), first)

    def test_geojson_appends_keys_and_omits_non_us(self):
        path = self.dir / "f.geojson"
        geom = {"type": "Point", "coordinates": [0.5, 0.5]}
        fc = {"type": "FeatureCollection", "name": "f", "features": [
            {"type": "Feature", "properties": {"b": 1, "a": "x"}, "geometry": geom},
            {"type": "Feature", "properties": {"b": 2, "a": None},
             "geometry": {"type": "Point", "coordinates": [0.5, 1.5]}},
            {"type": "Feature", "properties": {"b": 3}, "geometry": None}]}
        path.write_text(json.dumps(fc))
        self.quiet(rj.tag_file, path, "global")
        out = json.loads(path.read_text())
        self.assertEqual(list(out), ["type", "name", "features"])
        us, ca, null = (f["properties"] for f in out["features"])
        self.assertEqual(list(us), ["b", "a", *rj.SCOPES["global"]])
        self.assertEqual(ca, {"b": 2, "a": None, "countries": "|CAN|", "admin1": "|CAN0|"})
        self.assertEqual(null, {"b": 3, "countries": "|none|", "admin1": "|none|"})
        self.assertEqual(out["features"][0]["geometry"], geom)
        self.assertIn("REGION_STATS f.geojson counties n=3 absent=2 none=0", self.printed)
        first = path.read_bytes()
        self.quiet(rj.tag_file, path, "global")
        self.assertEqual(path.read_bytes(), first)

    def test_geojsonseq_gz(self):
        src, dst = self.dir / "s.geojsonl", self.dir / "s.geojsonl.gz"
        src.write_text("".join(json.dumps({"type": "Feature", "properties": {"n": i},
                                           "geometry": {"type": "Point", "coordinates": [x, 0.5]}}) + "\n"
                               for i, x in enumerate((0.5, 1.5))))
        self.quiet(rj.tag_file, src, "usa", out=dst, fields=["states"])
        first = dst.read_bytes()
        lines = gzip.decompress(first).decode().splitlines()
        self.assertEqual([json.loads(l)["properties"] for l in lines],
                         [{"n": 0, "states": "|AA|"}, {"n": 1, "states": "|BB|"}])
        self.quiet(rj.tag_file, dst, "usa", fields=["states"])
        self.assertEqual(dst.read_bytes(), first)


if __name__ == "__main__":
    unittest.main()
