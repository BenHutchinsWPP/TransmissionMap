"""Tests for build_data_manifest.py: the present/absent coverage rule, row +
coverage counting over a small artifact, the missing-artifact null path, OSM
snapshot date selection, raw-file date, and that
hand-written provenance (UNKNOWN included) survives the merge into
data/layers/manifest.json.
"""
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

try:
    import yaml
except ImportError:  # the stdlib-only CI runners; `make test-pipeline` has it
    raise unittest.SkipTest("PyYAML is not installed")

from build_data_manifest import (
    build_manifest, is_present, main, osm_snapshot_date, raw_file_date,
    scan_source,
)


class TestIsPresent(unittest.TestCase):
    def test_present_values(self):
        for value in ["hello", "123", "-998", 5, 3.14, True, 0, "  x  "]:
            with self.subTest(value=value):
                self.assertTrue(is_present(value))

    def test_absent_none_and_nan(self):
        self.assertFalse(is_present(None))
        self.assertFalse(is_present(float("nan")))

    def test_absent_blank_strings(self):
        for value in ["", "   ", "\t"]:
            with self.subTest(value=value):
                self.assertFalse(is_present(value))

    def test_absent_word_sentinels_case_insensitive(self):
        for word in ["none", "None", "NONE", "null", "NULL", "nan", "NaN",
                     "na", "NA", "n/a", "N/A"]:
            with self.subTest(word=word):
                self.assertFalse(is_present(word))

    def test_absent_numeric_sentinels_as_numbers(self):
        self.assertFalse(is_present(-999))
        self.assertFalse(is_present(-9999))
        self.assertFalse(is_present(-999.0))
        self.assertFalse(is_present(-9999.0))

    def test_absent_numeric_sentinels_as_strings(self):
        # CSV cells arrive as strings even for numeric-sentinel fields.
        self.assertFalse(is_present("-999"))
        self.assertFalse(is_present("-9999"))
        self.assertFalse(is_present("-999.0"))


class TestScanSourceCsv(unittest.TestCase):
    def test_coverage_over_csv_with_blanks(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "rows.csv"
            path.write_text(
                "name,operator\n"
                "Plant A,Utility X\n"
                "Plant B,\n"
                "Plant C,UNKNOWN\n"
                "Plant D,none\n"
                "Plant E,Utility Y\n"
            )
            n, coverage, supported = scan_source(path, ["name", "operator"])
            self.assertTrue(supported)
            self.assertEqual(n, 5)
            # blank and "none" are absent; the literal "UNKNOWN" is a real
            # (if uninformative) value, not one of the absence sentinels.
            self.assertEqual(coverage, {"name": 5, "operator": 3})

    def test_no_fields_yields_row_count_and_no_coverage(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "rows.csv"
            path.write_text("name\nA\nB\nC\n")
            n, coverage, supported = scan_source(path, None)
            self.assertTrue(supported)
            self.assertEqual(n, 3)
            self.assertIsNone(coverage)

    def test_unsupported_extension_is_not_supported(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "rows.tif"
            path.write_text("not really a raster")
            n, coverage, supported = scan_source(path, ["x"])
            self.assertFalse(supported)
            self.assertIsNone(n)
            self.assertIsNone(coverage)


class TestBuildManifestMissingArtifact(unittest.TestCase):
    def test_missing_src_yields_nulls_and_exit_zero(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            data_manifest = root / "data_manifest.yaml"
            tile_manifest = root / "tile_manifest.yaml"
            data_manifest.write_text(yaml.dump({
                "layers": {
                    "ghost_layer": {
                        "label": "Ghost Layer",
                        "source": "Nobody",
                        "url": "https://example.com",
                        "licence": "UNKNOWN",
                    }
                }
            }))
            tile_manifest.write_text(yaml.dump({
                "layers": [
                    {
                        "id": "ghost_layer",
                        "src": "data/build/does_not_exist.csv",
                        "format": "geojson",
                        "select": ["name"],
                    }
                ]
            }))

            manifest, summary = build_manifest(data_manifest, tile_manifest, root)

            self.assertEqual(summary, {"ok": 0, "missing": 1, "unsupported": 0})
            entry = manifest["layers"]["ghost_layer"]
            self.assertIsNone(entry["source_rows"])
            self.assertIsNone(entry["coverage"])
            self.assertIsNone(entry["data_as_of"])
            self.assertIsNone(entry["bytes"])
            # data_manifest.yaml's fixture entry above names no source_id —
            # same UNKNOWN default as the other provenance fields.
            self.assertEqual(entry["source_id"], "UNKNOWN")

            out_path = root / "out" / "manifest.json"
            exit_code = main([
                "--data-manifest", str(data_manifest),
                "--tile-manifest", str(tile_manifest),
                "--repo-root", str(root),
                "--out", str(out_path),
            ])
            self.assertEqual(exit_code, 0)
            self.assertTrue(out_path.exists())
            written = json.loads(out_path.read_text())
            self.assertIsNone(written["layers"]["ghost_layer"]["source_rows"])


class TestEditionPassThrough(unittest.TestCase):
    def test_edition_present_passes_through_and_absent_adds_no_key(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "data" / "build").mkdir(parents=True)
            (root / "data" / "build" / "widgets.csv").write_text("name\nA\n")
            (root / "data" / "build" / "gadgets.csv").write_text("name\nB\n")

            data_manifest = root / "data_manifest.yaml"
            tile_manifest = root / "tile_manifest.yaml"
            base = {"label": "L", "source": "S", "url": "U",
                    "licence": "UNKNOWN", "source_id": "x"}
            data_manifest.write_text(yaml.dump({
                "layers": {
                    "widgets": dict(base, edition="cb_2025_us_county_500k"),
                    "gadgets": dict(base),
                }
            }))
            tile_manifest.write_text(yaml.dump({
                "layers": [
                    {"id": "widgets", "src": "data/build/widgets.csv",
                     "format": "geojson", "select": ["name"]},
                    {"id": "gadgets", "src": "data/build/gadgets.csv",
                     "format": "geojson", "select": ["name"]},
                ]
            }))

            manifest, _ = build_manifest(data_manifest, tile_manifest, root)

            self.assertEqual(manifest["layers"]["widgets"]["edition"],
                             "cb_2025_us_county_500k")
            self.assertNotIn("edition", manifest["layers"]["gadgets"])


class TestBuildManifestMerge(unittest.TestCase):
    def test_provenance_fields_including_unknown_survive(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "data" / "build").mkdir(parents=True)
            src = root / "data" / "build" / "widgets.csv"
            src.write_text("name,operator\nWidget A,Acme\nWidget B,\n")

            data_manifest = root / "data_manifest.yaml"
            tile_manifest = root / "tile_manifest.yaml"
            data_manifest.write_text(yaml.dump({
                "layers": {
                    "widgets": {
                        "label": "Widgets",
                        "source": "Acme Survey",
                        "url": "UNKNOWN",
                        "licence": "UNKNOWN",
                        "source_id": "acme-widgets",
                    }
                }
            }))
            tile_manifest.write_text(yaml.dump({
                "layers": [
                    {
                        "id": "widgets",
                        "src": "data/build/widgets.csv",
                        "format": "geojson",
                        "select": ["name", "operator"],
                    }
                ]
            }))

            manifest, summary = build_manifest(data_manifest, tile_manifest, root)

            self.assertEqual(summary["ok"], 1)
            entry = manifest["layers"]["widgets"]
            self.assertEqual(entry["label"], "Widgets")
            self.assertEqual(entry["source"], "Acme Survey")
            self.assertEqual(entry["url"], "UNKNOWN")
            self.assertEqual(entry["licence"], "UNKNOWN")
            # source_id passes through unchanged, same as the other
            # hand-written provenance fields — this is the LAYER_SOURCES key
            # assets/ui/ui-credits.ts groups this layer's credit under.
            self.assertEqual(entry["source_id"], "acme-widgets")
            self.assertEqual(entry["source_rows"], 2)
            self.assertEqual(entry["coverage"], {"name": 2, "operator": 1})
            self.assertIsNone(entry["data_as_of"])
            # No built data/layers/widgets.geojson.gz in this fixture.
            self.assertIsNone(entry["bytes"])

    def test_bytes_reads_built_artifact_size_when_present(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "data" / "build").mkdir(parents=True)
            (root / "data" / "layers").mkdir(parents=True)
            src = root / "data" / "build" / "widgets.csv"
            src.write_text("name\nWidget A\n")
            built = root / "data" / "layers" / "widgets.geojson.gz"
            built.write_bytes(b"\x1f\x8b\x00\x00")

            data_manifest = root / "data_manifest.yaml"
            tile_manifest = root / "tile_manifest.yaml"
            data_manifest.write_text(yaml.dump({"layers": {"widgets": {
                "label": "Widgets", "source": "UNKNOWN", "url": "UNKNOWN", "licence": "UNKNOWN",
            }}}))
            tile_manifest.write_text(yaml.dump({"layers": [{
                "id": "widgets", "src": "data/build/widgets.csv", "format": "geojson",
            }]}))

            manifest, _ = build_manifest(data_manifest, tile_manifest, root)
            entry = manifest["layers"]["widgets"]
            self.assertEqual(entry["bytes"], built.stat().st_size)
            self.assertNotIn("coverage", entry)  # no `select:` on this entry


class TestOsmSnapshotDate(unittest.TestCase):
    """OSM snapshot date: oldest of the continental PBF timestamps."""

    def _make_pbf_dir(self, root, names_and_timestamps):
        """Create dummy PBF files and set up mock osmium responses."""
        osm_dir = root / "data" / "raw" / "osm"
        osm_dir.mkdir(parents=True)
        for name, _ in names_and_timestamps:
            (osm_dir / name).write_bytes(b"\x00")
        return {
            str(osm_dir / name): ts
            for name, ts in names_and_timestamps
        }

    @patch("build_data_manifest.shutil.which", return_value="/usr/bin/osmium")
    @patch("build_data_manifest.subprocess.run")
    def test_oldest_of_eight(self, mock_run, _mock_which):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            pbfs = [
                ("africa-latest.osm.pbf", "2026-07-12T20:21:42Z"),
                ("asia-latest.osm.pbf", "2026-07-10T20:21:42Z"),
                ("europe-latest.osm.pbf", "2026-07-14T20:21:42Z"),
            ]
            ts_map = self._make_pbf_dir(root, pbfs)

            def side_effect(*args, **kwargs):
                pbf_path = args[0][-1]
                ts = ts_map.get(pbf_path, "")
                return type("R", (), {"stdout": ts + "\n", "returncode": 0})()

            mock_run.side_effect = side_effect
            result = osm_snapshot_date(root)
            self.assertEqual(result, "2026-07-10")

    @patch("build_data_manifest.shutil.which", return_value=None)
    def test_osmium_missing_returns_none(self, _mock_which):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            self.assertIsNone(osm_snapshot_date(root))

    @patch("build_data_manifest.shutil.which", return_value="/usr/bin/osmium")
    def test_no_pbfs_returns_none(self, _mock_which):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "data" / "raw" / "osm").mkdir(parents=True)
            self.assertIsNone(osm_snapshot_date(root))

    @patch("build_data_manifest.shutil.which", return_value="/usr/bin/osmium")
    @patch("build_data_manifest.subprocess.run")
    def test_missing_header_returns_none(self, mock_run, _mock_which):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            pbfs = [
                ("africa-latest.osm.pbf", "2026-07-12T20:21:42Z"),
                ("asia-latest.osm.pbf", ""),  # missing header
            ]
            ts_map = self._make_pbf_dir(root, pbfs)

            def side_effect(*args, **kwargs):
                pbf_path = args[0][-1]
                ts = ts_map.get(pbf_path, "")
                return type("R", (), {"stdout": ts, "returncode": 0})()

            mock_run.side_effect = side_effect
            self.assertIsNone(osm_snapshot_date(root))


class TestRawFileDate(unittest.TestCase):
    """raw_file_date: newest mtime among matching files."""

    def test_newest_mtime_of_glob(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            raw_dir = root / "data" / "raw" / "stuff"
            raw_dir.mkdir(parents=True)
            older = raw_dir / "a.csv"
            newer = raw_dir / "b.csv"
            older.write_text("old")
            newer.write_text("new")
            # Ensure different mtimes.
            os.utime(older, (1_000_000, 1_000_000))
            os.utime(newer, (2_000_000, 2_000_000))
            result = raw_file_date("data/raw/stuff/*.csv", root)
            self.assertIsNotNone(result)
            self.assertIsInstance(result, str)
            self.assertEqual(len(result), 10)  # YYYY-MM-DD

    def test_no_match_returns_none(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            self.assertIsNone(raw_file_date("data/raw/nothing/*.csv", root))


class TestOsmDataAsOf(unittest.TestCase):
    """OSM layers get data_as_of from the PBF snapshot; non-OSM without raw: null."""

    @patch("build_data_manifest.osm_snapshot_date", return_value="2026-07-10")
    def test_osm_layer_gets_osm_date(self, _mock_osm):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "data" / "build").mkdir(parents=True)
            src = root / "data" / "build" / "plant_osm.csv"
            src.write_text("osm_id,name\n1,A\n")

            data_manifest = root / "data_manifest.yaml"
            tile_manifest = root / "tile_manifest.yaml"
            data_manifest.write_text(yaml.dump({"layers": {
                "osm_plants_points": {
                    "label": "OSM Plants", "source": "OSM", "url": "UNKNOWN",
                    "licence": "ODbL", "source_id": "osm",
                }
            }}))
            tile_manifest.write_text(yaml.dump({"layers": [{
                "id": "osm_plants_points",
                "src": "data/build/plant_osm.csv",
                "format": "geojson",
                "select": ["osm_id", "name"],
            }]}))
            manifest, _ = build_manifest(data_manifest, tile_manifest, root)
            entry = manifest["layers"]["osm_plants_points"]
            self.assertEqual(entry["data_as_of"], "2026-07-10")

    @patch("build_data_manifest.osm_snapshot_date", return_value="2026-07-10")
    def test_non_osm_without_raw_gets_null(self, _mock_osm):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "data" / "build").mkdir(parents=True)
            src = root / "data" / "build" / "eia.csv"
            src.write_text("name\nA\n")

            data_manifest = root / "data_manifest.yaml"
            tile_manifest = root / "tile_manifest.yaml"
            data_manifest.write_text(yaml.dump({"layers": {
                "eia_generators": {
                    "label": "EIA", "source": "EIA", "url": "UNKNOWN",
                    "licence": "PD", "source_id": "eia",
                }
            }}))
            tile_manifest.write_text(yaml.dump({"layers": [{
                "id": "eia_generators",
                "src": "data/build/eia.csv",
                "format": "geojson",
            }]}))
            manifest, _ = build_manifest(data_manifest, tile_manifest, root)
            entry = manifest["layers"]["eia_generators"]
            self.assertIsNone(entry["data_as_of"])

    @patch("build_data_manifest.osm_snapshot_date", return_value="2026-07-10")
    def test_non_osm_with_raw_gets_raw_date(self, _mock_osm):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "data" / "build").mkdir(parents=True)
            src = root / "data" / "build" / "eia.csv"
            src.write_text("name\nA\n")

            raw_dir = root / "data" / "raw" / "eia"
            raw_dir.mkdir(parents=True)
            raw_file = raw_dir / "workbook.xlsx"
            raw_file.write_text("fake")
            os.utime(raw_file, (1_700_000_000, 1_700_000_000))

            data_manifest = root / "data_manifest.yaml"
            tile_manifest = root / "tile_manifest.yaml"
            data_manifest.write_text(yaml.dump({"layers": {
                "eia_generators": {
                    "label": "EIA", "source": "EIA", "url": "UNKNOWN",
                    "licence": "PD", "source_id": "eia",
                    "raw": "data/raw/eia/workbook.xlsx",
                }
            }}))
            tile_manifest.write_text(yaml.dump({"layers": [{
                "id": "eia_generators",
                "src": "data/build/eia.csv",
                "format": "geojson",
            }]}))
            manifest, _ = build_manifest(data_manifest, tile_manifest, root)
            entry = manifest["layers"]["eia_generators"]
            self.assertIsNotNone(entry["data_as_of"])
            self.assertEqual(len(entry["data_as_of"]), 10)  # YYYY-MM-DD


if __name__ == "__main__":
    unittest.main()
