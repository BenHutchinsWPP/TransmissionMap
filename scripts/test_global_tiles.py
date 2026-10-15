"""Smoke tests for build_global_tiles.py — the continental → planet-wide build.

The contract this guards: every OSM layer the frontend reads is built exactly
once, from one merged and deduped input; its name matches what
assets/constants.ts fetches; its columns match the tile manifest; and each
re-tiled archive carries the zoom range the frontend expects.
"""
import gzip
import json
import os
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import build_global_tiles
from build_global_tiles import (
    CONCAT_GEOJSON,
    CSV_OPEN_OPTIONS,
    REGION_CODES,
    GLOBAL_FIELDS,
    LINE_FIELDS,
    RETILE,
    TILE_POLYGONS,
    TRANSMISSION_BANDS,
    TRANSMISSION_BASE,
    TRANSMISSION_DROP_AFTER_TILING,
    TRANSMISSION_SELECT,
    TRANSMISSION_TIPPECANOE_FLAGS,
    NATIVE_ID_FLAGS,
    SEAM_KEY,
)
from region_join import REGION_FIELDS

MANIFEST = Path(__file__).resolve().parent / "tile_manifest.yaml"
RETILE_BY_BASE = {s["base"]: s for s in RETILE}


class TestGlobalTileConfig(unittest.TestCase):
    def test_all_eight_continents_joined(self):
        self.assertEqual(
            set(REGION_CODES), {"na", "eu", "as", "sa", "af", "oc", "ca", "an"}
        )
        # A fixed order, so a rebuild is reproducible: on a seam copy the first
        # continent in this order supplies the kept feature.
        self.assertEqual(REGION_CODES[0], "na")

    def test_every_osm_layer_is_built_exactly_once(self):
        names = ([s["base"] for s in RETILE] + [TRANSMISSION_BASE]
                 + [s["base"] for s in TILE_POLYGONS] + list(CONCAT_GEOJSON))
        self.assertEqual(len(names), len(set(names)), "a layer is built twice")
        self.assertEqual(
            set(names),
            {
                "osm_transmission_lines",
                "osm_substations_points",
                "osm_substations_polygons",
                "osm_generators",
                "osm_plants_points",
                "osm_plants_polygons",
                "osm_pipelines_lines",
                "osm_pipelines_points",
                "osm_datacenters",
            },
        )

    def test_retile_specs_read_real_continental_stems(self):
        # A stem nothing builds is a silent skip, and the world archive is
        # never refreshed. These are the stems process_continental_osm.py writes.
        stems = {(s["src_stem"], s["src_ext"]) for s in RETILE}
        self.assertEqual(stems, {("substation_osm", ".csv"), ("generator_osm", ".csv"),
                                 ("pipeline_routes", ".gpkg")})
        for spec in RETILE:
            self.assertLess(spec["min_zoom"], spec["max_zoom"], spec["base"])

    def test_retile_maxzooms_are_what_the_archives_advertise(self):
        # With no zoom cap, --extend-zooms-if-still-dropping lets an archive
        # advertise z14; each spec's max_zoom must be the archive's maxzoom.
        self.assertEqual({s["base"]: s["max_zoom"] for s in RETILE},
                         {"osm_substations_points": 13, "osm_generators": 13,
                          "osm_pipelines_lines": 11})
        for spec in RETILE:
            self.assertNotIn("--extend-zooms-if-still-dropping", spec["flags"], spec["base"])

    def test_generators_thin_only_past_a_2mb_tile(self):
        gen = RETILE_BY_BASE["osm_generators"]
        self.assertIn("--drop-densest-as-needed", gen["flags"])
        self.assertEqual(gen["max_tile_bytes"], 2000000)

    def test_substation_points_keep_every_point_from_continent_zoom(self):
        # Every substation is present from z4 up; below that a single tile holds
        # most of the substations on Earth.
        sub = RETILE_BY_BASE["osm_substations_points"]
        self.assertEqual(sub["min_zoom"], 4)
        self.assertIn("--no-tile-size-limit", sub["flags"])
        self.assertIn("--no-feature-limit", sub["flags"])

    def test_csv_merges_read_lon_lat(self):
        # ogr2ogr reads a CSV's geometry only from these open options.
        self.assertEqual(CSV_OPEN_OPTIONS,
                         ["-oo", "X_POSSIBLE_NAMES=lon", "-oo", "Y_POSSIBLE_NAMES=lat",
                          "-oo", "KEEP_GEOM_COLUMNS=NO"])
        calls = []

        def fake_ogr2ogr(cmd, desc, dry_run=False):
            calls.append(cmd)
            Path(cmd[3]).write_text("")

        with tempfile.TemporaryDirectory() as tmp, \
             mock.patch.object(build_global_tiles, "run_cmd", fake_ogr2ogr):
            for spec in RETILE:
                srcs = [Path(tmp) / f"{spec['src_stem']}_na{spec['src_ext']}"]
                build_global_tiles._merge_deduped(srcs, Path(tmp) / "out.geojsonl",
                                                  spec["select"])
        self.assertEqual(len(calls), len(RETILE))
        for spec, cmd in zip(RETILE, calls):
            has_opts = " ".join(CSV_OPEN_OPTIONS) in " ".join(cmd)
            self.assertEqual(has_opts, spec["src_ext"] == ".csv", spec["base"])

    def test_pipelines_fit_the_ceiling_with_ids(self):
        # A unique id per line limits coalescing; z11 with simplification kept
        # off maxzoom is what fits the 100 MiB ceiling (stable-ids plan D7).
        pipes = RETILE_BY_BASE["osm_pipelines_lines"]
        self.assertEqual(pipes["max_zoom"], 11)
        self.assertIn("--simplify-only-low-zooms", pipes["flags"])
        # The densest z4 tile (4/3/6) is ~508 KB; below 1 MB it is thinned.
        self.assertGreaterEqual(pipes["max_tile_bytes"], 1000000)

    def test_every_world_layer_carries_the_stable_id(self):
        # The seam dedupe and the native feature id both read `fid`; the bare
        # osm_id is shared by a node and a way of the same number.
        self.assertEqual(SEAM_KEY, "fid")
        for select in [s["select"] for s in RETILE + TILE_POLYGONS] + [TRANSMISSION_SELECT]:
            self.assertIn("fid", select)
            self.assertNotIn("osm_id", select)

    def test_vector_archives_use_fid_as_the_native_id(self):
        # tippecanoe skips a string id attribute unless -T casts it.
        self.assertEqual(NATIVE_ID_FLAGS, ["--use-attribute-for-id=fid", "-Tfid:int"])
        with mock.patch.object(Path, "exists", return_value=True), \
             self.assertLogs("global_tiles", "INFO") as cm:
            for spec in RETILE:
                build_global_tiles.retile(spec, dry_run=True)
            for spec in TILE_POLYGONS:
                build_global_tiles.tile_polygons(spec, dry_run=True)
            build_global_tiles.retile_transmission(dry_run=True)
        tippecanoe = [m for m in cm.output if "$ tippecanoe" in m]
        self.assertEqual(len(tippecanoe), len(RETILE) + len(TILE_POLYGONS) + 1)
        for line in tippecanoe:
            for flag in NATIVE_ID_FLAGS:
                self.assertIn(flag, line)

    def test_transmission_bands_tile_the_whole_voltage_range(self):
        # Contiguous and ascending, with an open bottom and an open top, so every
        # line lands in exactly one archive. `nominal_kv = -1` encodes unknown, so
        # the open bottom is what carries it — an unknown-voltage line is 18% of
        # the layer and silently vanishes if the bottom band starts at 0.
        cuts = []
        for band in TRANSMISSION_BANDS:
            f = band["filter"]
            if f[0] == "<":
                cuts.append(("bottom", f[2]))
            elif f[0] == ">=":
                cuts.append(("top", f[2]))
            else:
                self.assertEqual(f[0], "all")
                cuts.append((f[1][2], f[2][2]))
        self.assertEqual(cuts[0][0], "bottom", "bottom band must be open below")
        self.assertEqual(cuts[-1][0], "top", "top band must be open above")
        edges = [cuts[0][1]] + [hi for _, hi in cuts[1:-1]]
        self.assertEqual(edges, sorted(edges), "bands must ascend")
        self.assertEqual(len(edges), len(set(edges)), "bands must not overlap")
        # Each interior band starts where the previous one ended.
        for prev, band in zip(cuts, cuts[1:]):
            lo = band[0] if band[0] != "top" else band[1]
            self.assertEqual(lo, prev[1], f"gap or overlap at {lo}")

    def test_transmission_keeps_full_detail_at_maxzoom(self):
        # The simplification pass must stay off maxzoom: the 4096-unit tile grid
        # at zoom z is screen pixels at z+4, so a tolerance applied at z11 is
        # visible error at z15 where a line meets a substation bus.
        self.assertIn("--simplify-only-low-zooms", TRANSMISSION_TIPPECANOE_FLAGS)

    def test_transmission_tiles_carry_the_ladder_attribute(self):
        # `minz` drives the -j zoom ladder, so tippecanoe must emit it — a filter
        # over a dropped attribute matches nothing. It is dropped again only
        # after tiling, when the voltage bands are cut.
        self.assertIn("minz", TRANSMISSION_SELECT)
        self.assertIn("minz", TRANSMISSION_DROP_AFTER_TILING)

    def test_polygon_specs_carry_the_fields_the_frontend_styles_on(self):
        by_base = {s["base"]: s for s in TILE_POLYGONS}
        # voltageColorExpr("nominal_kv") paints the substation footprints.
        self.assertIn("nominal_kv", by_base["osm_substations_polygons"]["select"])
        # The feature id (from fid) drives the hover highlight.
        self.assertIn("fid", by_base["osm_substations_polygons"]["select"])
        self.assertIn("fid", by_base["osm_plants_polygons"]["select"])
        for spec in TILE_POLYGONS:
            self.assertLess(spec["min_zoom"], spec["max_zoom"])


class TestSelectParity(unittest.TestCase):
    """The world build's columns and the tile manifest's select: must agree, or
    the world archive and a single-region build of the same id drift apart."""

    def test_world_selects_match_the_manifest(self):
        try:
            import yaml
        except ImportError:  # the stdlib-only CI runners; `make test-pipeline` has it
            self.skipTest("PyYAML is not installed")
        layers = yaml.safe_load(MANIFEST.read_text())["layers"]
        manifest = {e["id"]: e.get("select") for e in layers}
        world = {s["base"]: s["select"] for s in RETILE + TILE_POLYGONS}
        world[TRANSMISSION_BASE] = TRANSMISSION_SELECT
        for base, select in world.items():
            with self.subTest(base=base):
                self.assertIn(base, manifest)
                skip = set(REGION_FIELDS) | ({"minz"} if base == TRANSMISSION_BASE else set())
                self.assertEqual(set(select) - skip, set(manifest[base] or []) - skip)


@unittest.skipUnless(shutil.which("ogr2ogr"), "ogr2ogr is not installed")
class TestSeamDedupe(unittest.TestCase):
    """A seam copy is the same element from two extracts: same fid. It is kept
    once, from the first continent, with its id; node 2 and way 2 (fids 21 and
    22) are different elements and both kept."""

    def _merge(self, select):
        rows = {"na": "fid,osm_id,lon,lat,name\n11,1,10.5,50.25,A\n21,2,11,51,B\n",
                "eu": "fid,osm_id,lon,lat,name\n11,1,10.5,50.25,A-eu\n22,2,12,52,B2\n"}
        with tempfile.TemporaryDirectory() as tmp:
            srcs = []
            for code, text in rows.items():
                src = Path(tmp) / f"points_{code}.csv"
                src.write_text(text)
                srcs.append(src)
            out = Path(tmp) / "merged.geojsonl"
            with self.assertLogs("global_tiles", "INFO"):
                read, kept = build_global_tiles._merge_deduped(srcs, out, select)
            features = [json.loads(line) for line in out.read_text().splitlines()]
        return read, kept, features

    def test_seam_copy_kept_once_with_its_id(self):
        read, kept, features = self._merge(["fid", "name"])
        self.assertEqual((read, kept), (4, 3))
        self.assertEqual(sorted((f["properties"]["fid"], f["properties"]["name"])
                                for f in features), [(11, "A"), (21, "B"), (22, "B2")])
        self.assertTrue(all(f["geometry"]["type"] == "Point" for f in features))

    def test_merge_writes_only_select_columns_with_a_numeric_fid(self):
        # tippecanoe and region_join keep a number a number; a CSV hands fid
        # over as a string.
        _, _, features = self._merge(["fid", "name"])
        for f in features:
            self.assertEqual(list(f["properties"]), ["fid", "name"])
            self.assertIsInstance(f["properties"]["fid"], int)


class TestConcatDedupe(unittest.TestCase):
    def setUp(self):
        patch = mock.patch("region_join.tag_features", side_effect=lambda f, *a, **k: f)
        self.tag = patch.start()
        self.addCleanup(patch.stop)

    def test_concat_tags_global_after_dedupe(self):
        base = "osm_datacenters"
        feat = {"type": "Feature", "properties": {"fid": 11},
                "geometry": {"type": "Point", "coordinates": [0, 0]}}
        with tempfile.TemporaryDirectory() as tmp:
            for code in ("na", "eu"):
                with gzip.open(Path(tmp) / f"{base}_{code}.geojson.gz", "wt") as f:
                    json.dump({"type": "FeatureCollection", "features": [feat]}, f)
            with mock.patch.object(build_global_tiles, "LAYERS_DIR", Path(tmp)), \
                 self.assertLogs("global_tiles", "INFO"):
                build_global_tiles.concat_geojson(base)
        (features, scope, label), _ = self.tag.call_args
        self.assertEqual((len(features), scope, label), (1, "global", base))

    def test_concat_drops_seam_copies(self):
        def fc(*feats):
            return {"type": "FeatureCollection", "features": [
                {"type": "Feature", "properties": {"fid": fid, "name": name},
                 "geometry": {"type": "Point", "coordinates": [0, 0]}} for fid, name in feats]}
        base = "osm_datacenters"
        with tempfile.TemporaryDirectory() as tmp:
            # Node 1 on the seam; way 2 and node 2 are different elements. The
            # continental GeoJSON comes from a CSV, so fid may arrive a string.
            for code, data in (("na", fc(("11", "n1"), ("22", "w2"))),
                               ("eu", fc((11, "n1-eu"), ("21", "n2")))):
                with gzip.open(Path(tmp) / f"{base}_{code}.geojson.gz", "wt") as f:
                    json.dump(data, f)
            with mock.patch.object(build_global_tiles, "LAYERS_DIR", Path(tmp)), \
                 self.assertLogs("global_tiles", "INFO"):
                build_global_tiles.concat_geojson(base)
            with gzip.open(Path(tmp) / f"{base}.geojson.gz", "rt") as f:
                got = json.load(f)["features"]
        self.assertEqual(sorted((f["properties"]["fid"], f["properties"]["name"]) for f in got),
                         [(11, "n1"), (21, "n2"), (22, "w2")])

    def test_missing_key_column_warns(self):
        base = "osm_datacenters"
        feats = [{"type": "Feature", "properties": {"osm_id": 1},
                  "geometry": {"type": "Point", "coordinates": [0, 0]}}]
        with tempfile.TemporaryDirectory() as tmp:
            with gzip.open(Path(tmp) / f"{base}_na.geojson.gz", "wt") as f:
                json.dump({"type": "FeatureCollection", "features": feats}, f)
            with mock.patch.object(build_global_tiles, "LAYERS_DIR", Path(tmp)), \
                 self.assertLogs("global_tiles", "WARNING") as cm:
                build_global_tiles.concat_geojson(base)
        self.assertTrue(any("lack a dedupe key" in m for m in cm.output))


class TestTagRegions(unittest.TestCase):
    def test_fields_follow_the_asset_kind(self):
        # Lines carry no retail; every other asset carries the full global set.
        self.assertEqual(LINE_FIELDS, ("countries", "admin1", "counties", "ba", "nerc"))
        for spec in RETILE + TILE_POLYGONS:
            expect = LINE_FIELDS if spec["base"] == "osm_pipelines_lines" else GLOBAL_FIELDS
            self.assertEqual(spec["fields"], expect, spec["base"])
        self.assertNotIn("retail", LINE_FIELDS)

    def test_concat_passes_the_global_fields(self):
        base = "osm_datacenters"
        with tempfile.TemporaryDirectory() as tmp, \
             mock.patch("region_join.tag_features", side_effect=lambda f, *a, **k: f) as tag:
            with gzip.open(Path(tmp) / f"{base}_na.geojson.gz", "wt") as f:
                json.dump({"type": "FeatureCollection", "features": [
                    {"type": "Feature", "properties": {"fid": 11},
                     "geometry": {"type": "Point", "coordinates": [0, 0]}}]}, f)
            with mock.patch.object(build_global_tiles, "LAYERS_DIR", Path(tmp)), \
                 self.assertLogs("global_tiles", "INFO"):
                build_global_tiles.concat_geojson(base)
        self.assertEqual(tag.call_args.kwargs["fields"], GLOBAL_FIELDS)

    def test_tags_the_merged_seq_in_place_with_global_scope(self):
        with mock.patch("region_join.tag_file") as tag:
            build_global_tiles._tag_regions(Path("merged.geojsonl"), ("countries",))
        tag.assert_called_once_with(Path("merged.geojsonl"), "global", fields=("countries",))


class TestStalenessCheck(unittest.TestCase):
    """A world artifact older than a continental input is a silent publish of
    stale data — the frontend cannot tell it from a rendering fault."""

    def _layer_dir(self, world_age: int, input_age: int) -> str:
        tmp = tempfile.mkdtemp()
        spec = RETILE[0]
        world = Path(tmp) / f"{spec['base']}.pmtiles"
        world.write_bytes(b"world")
        os.utime(world, (world_age, world_age))
        for code in REGION_CODES:
            src = Path(tmp) / f"{spec['src_stem']}_{code}{spec['src_ext']}"
            src.write_bytes(b"continent")
            os.utime(src, (input_age, input_age))
        return tmp

    def _stale_bases(self, world_age: int, input_age: int):
        tmp = self._layer_dir(world_age, input_age)
        with mock.patch.object(build_global_tiles, "LAYERS_DIR", Path(tmp)), \
             mock.patch.object(build_global_tiles, "BUILD_DIR", Path(tmp)):
            return [line.split(" — ")[0] for line in build_global_tiles.stale_layers()]

    def test_world_artifact_behind_its_inputs_is_reported(self):
        self.assertIn(RETILE[0]["base"], self._stale_bases(1_000_000, 2_000_000))

    def test_world_artifact_ahead_of_its_inputs_is_clean(self):
        self.assertNotIn(RETILE[0]["base"], self._stale_bases(2_000_000, 1_000_000))

    def test_missing_artifacts_are_not_reported_as_stale(self):
        with tempfile.TemporaryDirectory() as tmp:
            with mock.patch.object(build_global_tiles, "LAYERS_DIR", Path(tmp)), \
                 mock.patch.object(build_global_tiles, "BUILD_DIR", Path(tmp)):
                self.assertEqual(build_global_tiles.stale_layers(), [])

    def test_every_built_layer_is_covered_by_the_check(self):
        covered = {label for label, _, _ in build_global_tiles._build_plan()}
        expected = set([s["base"] for s in RETILE] + [TRANSMISSION_BASE]
                       + [s["base"] for s in TILE_POLYGONS] + list(CONCAT_GEOJSON))
        self.assertEqual(covered, expected)


if __name__ == "__main__":
    unittest.main()
