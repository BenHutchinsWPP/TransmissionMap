"""Tests for build_data_manifest.py: the present/absent coverage rule, row +
coverage counting over a small artifact, the missing-artifact null path, and
that hand-written provenance (UNKNOWN included) survives the merge into
data/layers/manifest.json.
"""
import json
import math
import tempfile
import unittest
from pathlib import Path

import yaml

from build_data_manifest import build_manifest, is_present, main, scan_source


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
            self.assertIsNone(entry["retrieved"])
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
            self.assertIsNotNone(entry["retrieved"])
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


if __name__ == "__main__":
    unittest.main()
