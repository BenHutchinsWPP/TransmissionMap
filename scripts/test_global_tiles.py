"""Smoke tests for build_global_tiles.py — the continental → planet-wide join.

The contract this guards: every OSM layer the frontend reads is built exactly
once — as one world archive, or as the eight continental archives the frontend
opens directly — its name matches what assets/constants.ts fetches, the
substation zoom floor stays where the frontend expects it, and nothing is
published over the 100 MiB ceiling without a cap that brings it under.
"""
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import build_global_tiles
from build_global_tiles import (
    CONCAT_GEOJSON,
    DROP_ATTRS,
    JOIN_PMTILES,
    MAX_ZOOM_CAP,
    MIN_ZOOM_FLOOR,
    REGION_CODES,
    TILE_POLYGONS,
    TRANSMISSION_BANDS,
    TRANSMISSION_BASE,
    TRANSMISSION_DROP_AFTER_TILING,
    TRANSMISSION_SELECT,
    TRANSMISSION_TIPPECANOE_FLAGS,
)


class TestGlobalTileConfig(unittest.TestCase):
    def test_all_eight_continents_joined(self):
        self.assertEqual(
            set(REGION_CODES), {"na", "eu", "as", "sa", "af", "oc", "ca", "an"}
        )
        # A fixed order, so a rebuild is reproducible. It does not resolve the
        # Geofabrik overlaps — tile-join concatenates a shared tile's features
        # rather than picking a winner. See build_global_tiles.py REGION_CODES.
        self.assertEqual(REGION_CODES[0], "na")

    def test_every_osm_layer_is_built_exactly_once(self):
        names = (JOIN_PMTILES + [TRANSMISSION_BASE]
                 + [s["base"] for s in TILE_POLYGONS] + CONCAT_GEOJSON)
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

    def test_substation_points_start_at_continent_zoom(self):
        # Points are never dropped or coalesced; the global archive only trims
        # the globe-view zooms, where every substation on Earth lands in one
        # tile. z4 is roughly one continent in view.
        self.assertEqual(MIN_ZOOM_FLOOR["osm_substations_points"], 4)

    def test_only_point_layers_get_a_zoom_floor(self):
        self.assertTrue(set(MIN_ZOOM_FLOOR) <= set(JOIN_PMTILES))

    def test_transmission_is_retiled_not_joined(self):
        # Transmission is the one layer re-tiled from the continental
        # GeoPackages rather than joined tile-for-tile. Joining it would keep the
        # Geofabrik duplicates (tile-join concatenates a shared tile's features)
        # and could not split it by voltage.
        self.assertNotIn(TRANSMISSION_BASE, JOIN_PMTILES)

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

    def test_zoom_caps_name_a_real_artifact(self):
        # A cap keyed to a stem nothing builds is a silent no-op, and the
        # oversized archive ships anyway. A joined layer must be capped on the
        # world stem, never one continent: a joined maxzoom above what some
        # region carries leaves that region blank instead of overzooming.
        self.assertTrue(set(MAX_ZOOM_CAP) <= set(JOIN_PMTILES),
                        set(MAX_ZOOM_CAP) - set(JOIN_PMTILES))

    def test_dropped_attributes_belong_to_a_built_layer(self):
        self.assertTrue(set(DROP_ATTRS) <= set(JOIN_PMTILES))

    def test_polygon_specs_carry_the_fields_the_frontend_styles_on(self):
        by_base = {s["base"]: s for s in TILE_POLYGONS}
        # voltageColorExpr("nominal_kv") paints the substation footprints.
        self.assertIn("nominal_kv", by_base["osm_substations_polygons"]["select"])
        # hoverField: "osm_id" drives the click-highlight (src/registry/transmission.ts).
        self.assertIn("osm_id", by_base["osm_substations_polygons"]["select"])
        self.assertIn("osm_id", by_base["osm_plants_polygons"]["select"])
        for spec in TILE_POLYGONS:
            self.assertLess(spec["min_zoom"], spec["max_zoom"])


if __name__ == "__main__":
    unittest.main()


class TestStalenessCheck(unittest.TestCase):
    """A world artifact older than a continental input is a silent publish of
    stale data — the frontend cannot tell it from a rendering fault."""

    def _layer_dir(self, world_age: int, input_age: int) -> str:
        tmp = tempfile.mkdtemp()
        base = JOIN_PMTILES[0]
        world = Path(tmp) / f"{base}.pmtiles"
        world.write_bytes(b"world")
        os.utime(world, (world_age, world_age))
        for code in REGION_CODES:
            src = Path(tmp) / f"{base}_{code}.pmtiles"
            src.write_bytes(b"continent")
            os.utime(src, (input_age, input_age))
        return tmp

    def _stale_bases(self, world_age: int, input_age: int):
        tmp = self._layer_dir(world_age, input_age)
        with mock.patch.object(build_global_tiles, "LAYERS_DIR", Path(tmp)), \
             mock.patch.object(build_global_tiles, "BUILD_DIR", Path(tmp)):
            return [line.split(" — ")[0] for line in build_global_tiles.stale_layers()]

    def test_world_artifact_behind_its_inputs_is_reported(self):
        self.assertIn(JOIN_PMTILES[0], self._stale_bases(1_000_000, 2_000_000))

    def test_world_artifact_ahead_of_its_inputs_is_clean(self):
        self.assertNotIn(JOIN_PMTILES[0], self._stale_bases(2_000_000, 1_000_000))

    def test_missing_artifacts_are_not_reported_as_stale(self):
        with tempfile.TemporaryDirectory() as tmp:
            with mock.patch.object(build_global_tiles, "LAYERS_DIR", Path(tmp)), \
                 mock.patch.object(build_global_tiles, "BUILD_DIR", Path(tmp)):
                self.assertEqual(build_global_tiles.stale_layers(), [])

    def test_every_built_layer_is_covered_by_the_check(self):
        covered = {label for label, _, _ in build_global_tiles._build_plan()}
        expected = set(JOIN_PMTILES + [TRANSMISSION_BASE]
                       + [s["base"] for s in TILE_POLYGONS] + CONCAT_GEOJSON)
        self.assertEqual(covered, expected)
