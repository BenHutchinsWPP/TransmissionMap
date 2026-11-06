#!/usr/bin/env python3
"""Tests for check_geometry_parquet.py — the geometry files held to the kept
input and to an archive tippecanoe builds here with tile_polygons' flags.

Needs numpy, pyarrow, shapely, pyogrio and scipy (the venv) and skips without
them, like test_line_parquet.py; without tippecanoe the tests fail."""
import contextlib
import gzip
import importlib.util
import io
import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
ROOT = HERE.parent
FIXTURES = ROOT / "assets" / "lines" / "fixtures"
MANIFEST = HERE / "tile_manifest.yaml"
SUBS_POLY = "osm_substations_polygons"

HAVE_STACK = all(importlib.util.find_spec(m) for m in
                 ("numpy", "pyarrow", "shapely", "pyogrio", "scipy", "yaml"))


def tile_polygons_flags(base=SUBS_POLY):
    """The tippecanoe flags build_global_tiles.tile_polygons passes for `base`,
    read from its dry run (so they follow the build)."""
    import build_global_tiles as g
    spec = next(s for s in g.TILE_POLYGONS if s["base"] == base)
    with tempfile.TemporaryDirectory() as tmp:
        (Path(tmp) / f"{spec['src']}_na.gpkg").touch()
        with mock.patch.object(g, "BUILD_DIR", Path(tmp)), mock.patch.object(g, "ROOT", Path(tmp)), \
                mock.patch.object(g, "log") as log:
            g.tile_polygons(spec, dry_run=True)
    line = next(c.args for c in log.info.call_args_list if c.args[0].startswith("  $ tippecanoe"))
    return ["-l", base, *line[2].split(), "--read-parallel", "--force"]


def build_polygon_archive(src, out, base=SUBS_POLY):
    """Tile a kept GeoJSONSeq (plain or .gz) into `out` with tile_polygons' flags.
    Runs on relative names in a scratch dir, so the archive's bytes do not
    depend on where it is built."""
    with tempfile.TemporaryDirectory() as tmp:
        seq = Path(tmp) / f"{base}.geojsonl"
        opener = gzip.open if str(src).endswith(".gz") else open
        with opener(src, "rb") as f, open(seq, "wb") as g:
            shutil.copyfileobj(f, g)
        subprocess.run(["tippecanoe", "-q", "-o", f"{base}.pmtiles", *tile_polygons_flags(base),
                        seq.name], cwd=tmp, check=True)
        Path(out).parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(Path(tmp) / f"{base}.pmtiles", out)


def write_kept(src, dest):
    """A gzipped copy of a GeoJSONSeq with no timestamp (byte-stable)."""
    Path(dest).parent.mkdir(parents=True, exist_ok=True)
    with open(src, "rb") as f, open(dest, "wb") as raw, \
            gzip.GzipFile(filename="", mode="wb", fileobj=raw, mtime=0) as g:
        shutil.copyfileobj(f, g)


def run(argv):
    import check_geometry_parquet as cg
    out = io.StringIO()
    with contextlib.redirect_stdout(out):
        rc = cg.main(argv)
    return rc, out.getvalue()


@unittest.skipUnless(HAVE_STACK and shutil.which("ogr2ogr"), "needs the venv stack and ogr2ogr")
class TestNatgasReference1(unittest.TestCase):
    """hifld_natgas_lines: reference 1 reads the tile build's GeoPackage through ogr2ogr at precision 6."""
    DS = "hifld_natgas_lines"
    ROWS = [("ng:12", [[-95.01234567, 30.00000049], [-95.02, 30.01234549]]),
            ("hgl:7", [[-96.0, 31.0], [-96.02000051, 31.0], [-96.02, 31.02]])]

    def test_the_conversion_options_are_the_tile_manifests(self):
        import check_geometry_parquet as cg
        import yaml
        doc = yaml.safe_load(MANIFEST.read_text())
        entry = next(L for L in doc["layers"] if L["id"] == self.DS)
        self.assertEqual(entry["id_field"], cg.ID_FIELD.get(self.DS, "fid"))
        self.assertEqual(entry["precision"], cg.GPKG_PRECISION[self.DS])
        self.assertEqual(Path(entry["src"]).name, cg.GPKG_INPUT[self.DS])

    def test_good_files_pass_and_a_moved_vertex_fails(self):
        import build_line_parquet as blp
        import check_geometry_parquet as cg
        import pyarrow as pa
        import pyarrow.parquet as pq
        import shapely
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            full, rounded = tmp / "full.geojsonl", tmp / "input"
            rounded.mkdir()
            gj = lambda c, r=None: json.dumps({"type": "Feature", "properties": {"fid": r[0]},
                                               "geometry": {"type": "LineString", "coordinates": c}})
            full.write_text("\n".join(gj(c, (f,)) for f, c in self.ROWS) + "\n")
            (tmp / "build").mkdir()
            subprocess.run(["ogr2ogr", "-f", "GPKG", str(tmp / "build" / f"{self.DS}.gpkg"), str(full),
                            "-nln", self.DS, "-lco", "FID=ogc_fid"], check=True)
            (rounded / f"{self.DS}.geojsonl").write_text(
                "\n".join(gj([[round(x, 6), round(y, 6)] for x, y in c], (f,)) for f, c in self.ROWS) + "\n")
            with contextlib.redirect_stderr(io.StringIO()), mock.patch.object(blp.log, "info"):
                blp.main(["--fixture", str(tmp), "--only", self.DS])
            root = tmp / "analysis"
            m = json.loads((root / "index.json").read_text())["datasets"][self.DS]
            src = cg.kept_input(self.DS, tmp / "build" / "world")
            self.assertEqual(src, tmp / "build" / f"{self.DS}.gpkg")
            ok, c, text = cg.reference1(self.DS, m, root, src)
            self.assertTrue(ok, text)
            self.assertEqual((c["IDX rows"], c["geometry mismatches"], c["missing"]), (2, 0, 0))
            p = root / m["path"] / m["geo"][0]["name"]
            t = pq.read_table(p)
            col = t.column("geometry").to_pylist()
            col[0] = shapely.to_wkb(shapely.transform(shapely.from_wkb(col[0]), lambda xy: xy + [1e-6, 0]))
            i = t.schema.get_field_index("geometry")
            pq.write_table(t.set_column(i, t.schema.field(i), pa.array(col, t.schema.field(i).type)), p)
            ok, c, _ = cg.reference1(self.DS, m, root, src)
            self.assertFalse(ok)
            self.assertEqual(c["geometry mismatches"], 1)


@unittest.skipUnless(HAVE_STACK, "needs the venv stack")
class TestRailroadsReference1(unittest.TestCase):
    """railroads: reference 1 reads the raw GeoJSON as stored; int FRAARCID ids, source precision kept."""
    DS = "railroads"
    ROWS = [(2147483647, [[-95.0123456789, 30.0], [-95.02, 30.0123456789]]),
            (301, [[-96.0, 31.0], [-96.02, 31.0], [-96.02, 31.02]])]

    def test_good_files_pass_and_a_moved_vertex_fails(self):
        import build_line_parquet as blp
        import check_geometry_parquet as cg
        import pyarrow as pa
        import pyarrow.parquet as pq
        import shapely
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            (tmp / "input").mkdir()
            text = "\n".join(json.dumps({"type": "Feature", "properties": {"FRAARCID": f},
                                         "geometry": {"type": "LineString", "coordinates": c}})
                             for f, c in self.ROWS) + "\n"
            (tmp / "input" / f"{self.DS}.geojsonl").write_text(text)
            raw = tmp / "data" / "raw" / "railroads"
            raw.mkdir(parents=True)
            (raw / "narn_rail_lines.geojson").write_text(json.dumps({"type": "FeatureCollection", "features": [
                json.loads(ln) for ln in text.splitlines()]}))
            with contextlib.redirect_stderr(io.StringIO()), mock.patch.object(blp.log, "info"):
                blp.main(["--fixture", str(tmp), "--only", self.DS])
            root = tmp / "analysis"
            m = json.loads((root / "index.json").read_text())["datasets"][self.DS]
            src = cg.kept_input(self.DS, tmp / "data" / "build" / "world")
            self.assertEqual(src, raw / "narn_rail_lines.geojson")
            ok, c, text = cg.reference1(self.DS, m, root, src)
            self.assertTrue(ok, text)
            self.assertEqual((c["IDX rows"], c["geometry mismatches"], c["missing"], c["extra"]), (2, 0, 0, 0))
            p = root / m["path"] / m["geo"][0]["name"]
            t = pq.read_table(p)
            col = t.column("geometry").to_pylist()
            col[0] = shapely.to_wkb(shapely.transform(shapely.from_wkb(col[0]), lambda xy: xy + [1e-9, 0]))
            i = t.schema.get_field_index("geometry")
            pq.write_table(t.set_column(i, t.schema.field(i), pa.array(col, t.schema.field(i).type)), p)
            ok, c, _ = cg.reference1(self.DS, m, root, src)
            self.assertFalse(ok)
            self.assertEqual(c["geometry mismatches"], 1)


@unittest.skipUnless(HAVE_STACK and shutil.which("ogr2ogr"), "needs the venv stack and ogr2ogr")
class TestRegionPolygonsReference1(unittest.TestCase):
    """retail_territories, eia_ba, nerc_regions, control_areas, crithab, padus, us_states, countries, admin1_boundaries, tribal_lands: reference 1 reads the tile build's GeoPackage as stored."""
    # id column per dataset; the second vertex has more than 6 decimals, which the tiles round away
    CASES = {"retail_territories": ("id", ["40429", "19547"]),
             "eia_ba": ("abbrev", ["AESO", "YAD"]),
             "nerc_regions": ("sub_nm", ["CA-MX US", "NWPP"]),
             "control_areas": ("id", ["19547", "5580"]),
             # integer ids; padus's `fid` is a normal column, not the GeoPackage FID (ogc_fid)
             "crithab": ("entity_id", [11686, 3]),
             "padus": ("fid", [4503599627370495, 1234567890123]),
             "us_states": ("stusps", ["WA", "AS"]),
             "countries": ("iso_a3", ["NZL", "115"]),
             "admin1_boundaries": ("code", ["1", "3224"]),
             "tribal_lands": ("geoid", ["4075T", "0010R"]),
             "us_zcta": ("zcta5", ["00601", "99950"])}

    def test_the_county_input_is_the_tile_manifests(self):
        import build_line_parquet as blp
        import check_geometry_parquet as cg
        import yaml
        entry = next(L for L in yaml.safe_load(MANIFEST.read_text())["layers"] if L["id"] == "county_boundaries")
        self.assertEqual(entry["id_field"], "GEOID")
        self.assertEqual(cg.ID_FIELD["county_boundaries"], "GEOID")
        self.assertEqual(blp.DATASET["county_boundaries"]["id_field"], "GEOID")
        self.assertEqual(cg.GPKG_INPUT["county_boundaries"], entry["src"])
        self.assertEqual(blp.DATASET["county_boundaries"]["path"], entry["src"])
        self.assertNotIn("county_boundaries", cg.GPKG_PRECISION)
        self.assertNotIn("where", entry)

    def test_the_bia_and_boem_inputs_are_the_tile_manifests(self):
        import build_line_parquet as blp
        import check_geometry_parquet as cg
        import yaml
        layers = {L["id"]: L for L in yaml.safe_load(MANIFEST.read_text())["layers"]}
        for ds, field in (("bia_tribal_lands", "LARID"), ("boem_wind_leases", "fid")):
            entry = layers[ds]
            self.assertEqual(entry["id_field"], field)
            self.assertEqual(cg.ID_FIELD[ds], field)
            self.assertEqual(blp.DATASET[ds]["id_field"], field)
            self.assertEqual(cg.GPKG_INPUT[ds], entry["src"])
            self.assertEqual(blp.DATASET[ds]["path"], entry["src"])
            self.assertNotIn(ds, cg.GPKG_PRECISION)
            self.assertNotIn("where", entry)

    def test_the_railroads_input_is_the_tile_manifests(self):
        import build_line_parquet as blp
        import check_geometry_parquet as cg
        import yaml
        entry = next(L for L in yaml.safe_load(MANIFEST.read_text())["layers"] if L["id"] == "railroads")
        self.assertEqual((entry["id_field"], entry["native_id"]), ("FRAARCID", True))
        self.assertEqual(cg.ID_FIELD["railroads"], "FRAARCID")
        self.assertEqual(blp.DATASET["railroads"]["id_field"], "FRAARCID")
        self.assertEqual(cg.GPKG_INPUT["railroads"], entry["src"])
        self.assertEqual(blp.DATASET["railroads"]["path"], entry["src"])
        self.assertNotIn("railroads", cg.GPKG_PRECISION)
        self.assertNotIn("where", entry)

    def test_the_inputs_match_the_tile_manifest(self):
        import build_line_parquet as blp
        import check_geometry_parquet as cg
        import yaml
        doc = yaml.safe_load(MANIFEST.read_text())
        for ds, (field, _) in self.CASES.items():
            entry = next(L for L in doc["layers"] if L["id"] == ds)
            self.assertEqual(entry["id_field"], field, ds)
            self.assertEqual(cg.ID_FIELD[ds], field, ds)
            self.assertEqual(blp.DATASET[ds]["id_field"], field, ds)
            self.assertEqual(Path(entry["src"]).name, cg.GPKG_INPUT[ds], ds)
            self.assertEqual(Path(entry["src"]).stem, blp.DATASET[ds]["file"], ds)
            self.assertNotIn(ds, cg.GPKG_PRECISION, ds)   # read as stored, whatever the tiles' precision
            self.assertNotIn("where", entry, ds)

    def test_good_files_pass_and_a_moved_vertex_fails(self):
        import build_line_parquet as blp
        import check_geometry_parquet as cg
        import pyarrow as pa
        import pyarrow.parquet as pq
        import shapely
        for ds, (field, ids) in self.CASES.items():
            with self.subTest(ds), tempfile.TemporaryDirectory() as tmp:
                tmp = Path(tmp)
                rows = [(ids[0], [[[-95.0123456789, 30.0], [-95.0, 30.0123456789], [-94.9, 30.0], [-95.0123456789, 30.0]]]),
                        (ids[1], [[[-96.0, 31.0], [-96.0, 31.1], [-95.9, 31.1], [-96.0, 31.0]]])]
                full = tmp / "full.geojsonl"
                full.write_text("".join(json.dumps({"type": "Feature", "properties": {field: i}, "geometry": {
                    "type": "MultiPolygon", "coordinates": [c]}}) + "\n" for i, c in rows))
                (tmp / "build").mkdir()
                subprocess.run(["ogr2ogr", "-f", "GPKG", str(tmp / "build" / f"{ds}.gpkg"), str(full),
                                "-nln", ds, "-lco", "FID=ogc_fid"], check=True)
                (tmp / "input").mkdir()
                shutil.copyfile(full, tmp / "input" / f"{ds}.geojsonl")
                with contextlib.redirect_stderr(io.StringIO()), mock.patch.object(blp.log, "info"):
                    blp.main(["--fixture", str(tmp), "--only", ds])
                root = tmp / "analysis"
                m = json.loads((root / "index.json").read_text())["datasets"][ds]
                src = cg.kept_input(ds, tmp / "build" / "world")
                self.assertEqual(src, tmp / "build" / f"{ds}.gpkg")
                ok, c, text = cg.reference1(ds, m, root, src)
                self.assertTrue(ok, text)
                self.assertEqual((c["IDX rows"], c["geometry mismatches"], c["missing"], c["extra"]), (2, 0, 0, 0))
                p = root / m["path"] / m["geo"][0]["name"]
                t = pq.read_table(p)
                col = t.column("geometry").to_pylist()
                col[0] = shapely.to_wkb(shapely.transform(shapely.from_wkb(col[0]), lambda xy: xy + [1e-9, 0]))
                i = t.schema.get_field_index("geometry")
                pq.write_table(t.set_column(i, t.schema.field(i), pa.array(col, t.schema.field(i).type)), p)
                ok, c, _ = cg.reference1(ds, m, root, src)
                self.assertFalse(ok)
                self.assertEqual(c["geometry mismatches"], 1)


@unittest.skipUnless(HAVE_STACK, "numpy/pyarrow/shapely/pyogrio/scipy not installed")
class TestPathInputReference1(unittest.TestCase):
    """A GPKG_INPUT value with a "/" is a GeoJSON read as stored: EPSG:4326 and 2D, resolved under the run's root."""
    DS = "retail_territories"

    def geojson(self, path, z=False, crs=None):
        sq = lambda x: [[x, 30.0], [x, 30.1], [x + 0.1, 30.1], [x, 30.0]]
        feats = [{"type": "Feature", "properties": {"id": "a"},
                  "geometry": {"type": "Polygon", "coordinates": [sq(-95.0)]}},
                 {"type": "Feature", "properties": {"id": "b"},
                  "geometry": {"type": "MultiPolygon", "coordinates": [[[p + [5.0] if z else p for p in sq(-96.0)]]]}}]
        doc = {"type": "FeatureCollection", "features": feats}
        if crs:
            doc["crs"] = {"type": "name", "properties": {"name": crs}}
        Path(path).write_text(json.dumps(doc))

    def test_good_passes_and_non_4326_and_z_fail(self):
        import build_line_parquet as blp
        import check_geometry_parquet as cg
        for name, kw, want in (("good", {}, 0), ("z", {"z": True}, 1),
                               ("crs", {"crs": "urn:ogc:def:crs:EPSG::4269"}, 1)):
            with self.subTest(name), tempfile.TemporaryDirectory() as tmp:
                tmp = Path(tmp)
                (tmp / "data" / "build").mkdir(parents=True)
                (tmp / "input").mkdir()
                self.geojson(tmp / "input" / f"{self.DS}.geojsonl")
                (tmp / "input" / f"{self.DS}.geojsonl").write_text("".join(
                    json.dumps(f) + "\n" for f in json.loads(
                        (lambda p: (self.geojson(p), p.read_text())[1])(tmp / "g.geojson"))["features"]))
                with contextlib.redirect_stderr(io.StringIO()), mock.patch.object(blp.log, "info"):
                    blp.main(["--fixture", str(tmp), "--only", self.DS])
                root = tmp / "analysis"
                m = json.loads((root / "index.json").read_text())["datasets"][self.DS]
                src = tmp / "data" / "build" / "regions.geojson"
                self.geojson(src, **kw)
                with mock.patch.dict(cg.GPKG_INPUT, {self.DS: "data/build/regions.geojson"}):
                    self.assertEqual(cg.kept_input(self.DS, tmp / "data" / "build" / "world"), src)
                    ok, c, _ = cg.reference1(self.DS, m, root, src)
                self.assertEqual(c["input not EPSG:4326 2D"], want)
                self.assertEqual(ok, want == 0)


@unittest.skipUnless(HAVE_STACK, "numpy/pyarrow/shapely/pyogrio/scipy/PyYAML not installed")
class TestGeometryOracle(unittest.TestCase):
    """A fresh fixture build (builder over test_line_parquet's input), its kept
    inputs under build/world/ and the polygon archive under layers/."""

    @classmethod
    def setUpClass(cls):
        if not (shutil.which("tippecanoe") and shutil.which("tippecanoe-decode")):
            raise AssertionError("tippecanoe and tippecanoe-decode are needed (not a skip)")
        import build_line_parquet as blp
        from test_line_parquet import (LINES, SUB_POINT_FID, SUB_POLY_FID, _feature,
                                       write_polygon_input)
        cls.tmp = Path(tempfile.mkdtemp())
        inp = cls.tmp / "input"
        inp.mkdir()
        with open(inp / "transmission_world.geojsonl", "w") as f:
            for fid, kv, circ, coords in LINES:
                f.write(_feature({"fid": fid, "nominal_kv": kv, "circuits": circ}, coords) + "\n")
        ring = [[-0.001, -0.001], [0.001, -0.001], [0.001, 0.001], [-0.001, 0.001], [-0.001, -0.001]]
        (inp / "substation_polygons.geojsonl").write_text(
            _feature({"fid": SUB_POLY_FID}, [ring], "Polygon") + "\n")
        (inp / "substation_points.csv").write_text(f"fid,lon,lat\n{SUB_POINT_FID},0.030011,0.010559\n")
        (inp / "transmission_hifld.geojsonl").write_text(
            _feature({"ID": "99"}, [[[-120.000001, 35.5], [-120.1, 35.6]]], "MultiLineString") + "\n")
        write_polygon_input(inp / f"{SUBS_POLY}.geojsonl")
        with contextlib.redirect_stderr(io.StringIO()), mock.patch.object(blp.log, "info"):
            blp.main(["--fixture", str(cls.tmp)])
        world = cls.tmp / "build" / "world"
        write_kept(inp / f"{SUBS_POLY}.geojsonl", world / f"{SUBS_POLY}.geojsonl.gz")
        write_kept(inp / "transmission_world.geojsonl", world / "transmission_world.geojsonl.gz")
        build_polygon_archive(world / f"{SUBS_POLY}.geojsonl.gz", cls.tmp / "layers" / f"{SUBS_POLY}.pmtiles")
        subprocess.run(["tippecanoe", "-q", "-o", str(cls.tmp / "layers" / "osm_transmission_lines.pmtiles"),
                        "-z12", "-Z2", "--use-attribute-for-id=fid", "-Tfid:int", "--force",
                        str(inp / "transmission_world.geojsonl")], check=True)
        cls.root = cls.tmp / "analysis"
        cls.index = json.loads((cls.root / "index.json").read_text())["datasets"]

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp)

    def scratch(self):
        d = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, d)
        shutil.copytree(self.root, d / "analysis")
        return d / "analysis"

    def ref1(self, ds, root=None, src=None):
        import check_geometry_parquet as cg
        src = src or cg.kept_input(ds, self.tmp / "build" / "world")
        return cg.reference1(ds, self.index[ds], root or self.root, src)

    def ref2(self, root=None):
        import check_geometry_parquet as cg
        return cg.reference2(SUBS_POLY, self.index[SUBS_POLY], root or self.root,
                             self.tmp / "layers", MANIFEST, 1000, 0)

    def test_the_flags_are_tile_polygons_own(self):
        flags = tile_polygons_flags()
        for f in ("--minimum-zoom=9", "--maximum-zoom=12", "--no-tile-size-limit",
                  "--use-attribute-for-id=fid", "-Tfid:int"):
            self.assertIn(f, flags)

    def test_good_files_pass_both_references(self):
        ok, c, text = self.ref1(SUBS_POLY)
        self.assertTrue(ok, text)
        self.assertEqual((c["IDX rows"], c["geometry mismatches"], c["missing"]), (5, 0, 0))
        ok, c, text = self.ref1("osm_transmission_lines")
        self.assertTrue(ok, text)
        r = self.ref2()
        self.assertTrue(r["ok"], r["text"])
        self.assertIn("missing 0", r["text"])
        self.assertGreaterEqual(len(r["pieces"]), 6)   # 102 is cut in two
        self.assertLessEqual(r["geo_max"], r["tolerance"])

    def test_the_cli_passes_and_mutate_makes_six_catches(self):
        rc, out = run(["--root", str(self.root)])
        self.assertEqual(rc, 0, out)
        self.assertIn("hifld_transmission_lines: not checked here", out)
        rc, out = run(["--root", str(self.root), "--mutate"])
        self.assertEqual(rc, 0, out)
        self.assertEqual(out.count("  catch: "), 6, out)
        self.assertNotIn("MISSED", out)

    def test_one_grid_step_fails_reference_1_only(self):
        import pyarrow as pa
        import pyarrow.parquet as pq
        import shapely
        root = self.scratch()
        e = self.index[SUBS_POLY]["geo"][0]
        p = root / self.index[SUBS_POLY]["path"] / e["name"]
        t = pq.read_table(p)
        col = t.column("geometry").to_pylist()
        g = shapely.from_wkb(col[0])
        col[0] = shapely.to_wkb(shapely.transform(g, lambda xy: xy + [1e-6, 0]))
        i = t.schema.get_field_index("geometry")
        pq.write_table(t.set_column(i, t.schema.field(i), pa.array(col, t.schema.field(i).type)), p)
        ok, c, _ = self.ref1(SUBS_POLY, root)
        self.assertFalse(ok)
        self.assertEqual(c["geometry mismatches"], 1)
        self.assertTrue(self.ref2(root)["ok"])          # 1e-6° is under a z12 grid unit

    def test_ring_order_and_direction_do_not_matter(self):
        import gzip as gz
        src = self.tmp / "flipped.geojsonl.gz"
        with gz.open(self.tmp / "build" / "world" / f"{SUBS_POLY}.geojsonl.gz", "rt") as f, \
                gz.open(src, "wt") as g:
            for line in f:
                ft = json.loads(line)
                if ft["geometry"]["type"] == "Polygon":
                    ft["geometry"]["coordinates"] = [r[::-1] for r in ft["geometry"]["coordinates"]]
                g.write(json.dumps(ft) + "\n")
        ok, _, text = self.ref1(SUBS_POLY, src=src)
        self.assertTrue(ok, text)

    def test_ids_must_match_exactly_once(self):
        import pyarrow as pa
        import pyarrow.parquet as pq
        root = self.scratch()
        p = root / self.index[SUBS_POLY]["path"] / self.index[SUBS_POLY]["idx"]["name"]
        t = pq.read_table(p)
        pq.write_table(pa.concat_tables([t, t.slice(0, 1)]), p)     # one fid twice
        ok, c, _ = self.ref1(SUBS_POLY, root)
        self.assertFalse(ok)
        self.assertEqual(c["IDX dups"], 1)
        # a kept row the build lost
        src = self.tmp / "extra.geojsonl.gz"
        with gzip.open(self.tmp / "build" / "world" / f"{SUBS_POLY}.geojsonl.gz", "rt") as f, \
                gzip.open(src, "wt") as g:
            g.write(f.read())
            g.write(json.dumps({"type": "Feature", "properties": {"fid": 999},
                                "geometry": {"type": "Point", "coordinates": [0, 0]}}) + "\n")
        ok, c, _ = self.ref1(SUBS_POLY, src=src)
        self.assertEqual((ok, c["missing"]), (False, 1))

    def test_a_wrong_row_pointer_fails(self):
        import pyarrow as pa
        import pyarrow.parquet as pq
        root = self.scratch()
        p = root / self.index[SUBS_POLY]["path"] / self.index[SUBS_POLY]["idx"]["name"]
        t = pq.read_table(p)
        rows = t.column("row").to_pylist()
        rows[0], rows[1] = rows[1], rows[0]
        i = t.schema.get_field_index("row")
        pq.write_table(t.set_column(i, t.schema.field(i), pa.array(rows, t.schema.field(i).type)), p)
        ok, c, _ = self.ref1(SUBS_POLY, root)
        self.assertEqual((ok, c["pointer errors"]), (False, 2))

    def test_reference_1_imports_neither_the_builder_nor_tile_inputs(self):
        code = ("import sys; sys.path.insert(0, %r); import check_geometry_parquet as cg; "
                "import json; from pathlib import Path; r = Path(%r); "
                "m = json.loads((r / 'index.json').read_text())['datasets'][%r]; "
                "ok, _, _ = cg.reference1(%r, m, r, %r); "
                "print(ok, 'build_line_parquet' in sys.modules, 'tile_inputs' in sys.modules)"
                % (str(HERE), str(self.root), SUBS_POLY, SUBS_POLY,
                   str(self.tmp / "build" / "world" / f"{SUBS_POLY}.geojsonl.gz")))
        out = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, check=True)
        self.assertEqual(out.stdout.split(), ["True", "False", "False"])

    def plant_geo(self, root, edit):
        """Rewrite the polygon GEO part through edit(table) → table."""
        import pyarrow.parquet as pq
        e = self.index[SUBS_POLY]["geo"][-1]
        p = root / self.index[SUBS_POLY]["path"] / e["name"]
        pq.write_table(edit(pq.read_table(p)), p)

    def test_a_geo_row_no_idx_row_points_at_fails(self):
        import pyarrow as pa
        import shapely

        def dup(t):
            first = t.slice(0, 1).to_pydict()
            g = shapely.from_wkb(first["geometry"][0])
            first["geometry"] = [shapely.to_wkb(shapely.transform(g, lambda xy: xy + [0.01, 0]))]
            return pa.concat_tables([t, pa.table(first, schema=t.schema)])
        root = self.scratch()
        self.plant_geo(root, dup)
        ok, c, text = self.ref1(SUBS_POLY, root)
        self.assertFalse(ok, text)
        self.assertEqual((c["GEO rows"], c["GEO dups"], c["unpointed GEO rows"]), (6, 1, 1))

    def test_a_bbox_that_does_not_cover_its_geometry_fails(self):
        import pyarrow as pa

        def zero(t):
            bb = t.column("bbox").to_pylist()
            bb[0] = {k: 0.0 for k in bb[0]}
            i = t.schema.get_field_index("bbox")
            return t.set_column(i, t.schema.field(i), pa.array(bb, t.schema.field(i).type))
        root = self.scratch()
        self.plant_geo(root, zero)
        ok, c, text = self.ref1(SUBS_POLY, root)
        self.assertFalse(ok, text)
        self.assertEqual(c["bbox errors"], 1)

    def test_polygons_under_an_index_entry_without_geometry_fail(self):
        import check_geometry_parquet as cg
        m = {k: v for k, v in self.index[SUBS_POLY].items() if k != "geometry"}
        r = cg.reference2(SUBS_POLY, m, self.root, self.tmp / "layers", MANIFEST, 1000, 0)
        self.assertFalse(r["ok"], r["text"])
        self.assertIn("GEO holds polygon, index.json says line", r["text"])

    def test_mutate_copies_only_the_mutated_dataset(self):
        copied = []
        real = shutil.copytree
        with mock.patch("shutil.copytree", side_effect=lambda a, b, **k: copied.append(Path(a)) or real(a, b, **k)):
            rc, out = run(["--root", str(self.root), "--only", SUBS_POLY, "--mutate"])
        self.assertEqual(rc, 0, out)
        self.assertEqual(set(copied), {self.root / SUBS_POLY})

    def test_no_vertex_is_picked_when_no_move_would_show(self):
        import check_geometry_parquet as cg
        r2 = dict(self.ref2(), tolerance=1000.0)
        self.assertIsNone(cg.pick_vertex(r2, self.index[SUBS_POLY], self.root))

    def test_a_missing_polygon_kept_input_fails_without_only(self):
        root = self.scratch()            # no build/world beside it
        rc, out = run(["--root", str(root)])
        self.assertEqual(rc, 1, out)
        self.assertIn(f"{SUBS_POLY}: [FAIL] no kept input", out)

    def test_the_committed_fixture_passes(self):
        """The acceptance run: the committed fixture's kept input and archive."""
        rc, out = run(["--root", str(FIXTURES / "analysis")])
        self.assertEqual(rc, 0, out)
        self.assertIn(f"{SUBS_POLY} (polygon)", out)


if __name__ == "__main__":
    unittest.main()
