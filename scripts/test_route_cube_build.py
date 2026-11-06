"""Stdlib checks for transactional routing-cube assembly and source metadata."""
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import build_route_cube as cube
import route_grid as G

OTHER_METAS = ("bands", "flags", "slope", "restrict", "costbands", "bldg", "wetland")


def source_band_metas(root):
    """aviation / nfhl metas as their builders write them, and tif bytes."""
    codes = lambda table, nodata: {"0": nodata, **{str(k): v for k, v in table.items()}}
    metas = {
        "aviation": {"product": "FAA NTAD aviation facilities, runways, runway ends (+ ADDS IAPEXISTS)",
                     "ntad_eff_date": "2026/10/29", "ntad_fetched": "2026-11-03", "ntad_sha256": {"runways": "ab"},
                     "codes": codes(G.AVIATION_CODES, "nodata"), "method_text": "Part 77 surfaces"},
        "nfhl": {"product": "FEMA National Flood Hazard Layer, Key Layers", "credit": "FEMA National Flood Hazard Layer",
                 "licence": "US federal work", "codes": codes(G.NFHL_CODES, "nodata"), "rule": "area shares",
                 "edition_file": "NFHL_Key_Layers_202610.gdb.zip", "last_modified": "Thu, 15 Oct 2026 20:42:19 GMT",
                 "sha256": "2" * 64, "url": "https://hazards.fema.gov/x.zip"},
    }
    for name, meta in metas.items():
        (root / f"{name}.tif").write_bytes(f"{name} generation 1".encode())
        (root / f"{name}_meta.json").write_text(json.dumps(meta))
    return metas


class CubePromotion(unittest.TestCase):
    def test_each_failed_swap_restores_both_destinations(self):
        for fail_at in range(1, 5):
            with self.subTest(fail_at=fail_at), tempfile.TemporaryDirectory() as temp:
                root = Path(temp)
                pairs = [(root / "new-cube", root / "cube"), (root / "new-fixtures", root / "fixtures")]
                for staged, target in pairs:
                    staged.mkdir(); target.mkdir()
                    (staged / "marker").write_text("new")
                    (target / "marker").write_text("old")
                calls = 0

                def replace(a, b):
                    nonlocal calls
                    calls += 1
                    if calls == fail_at:
                        raise OSError("injected swap failure")
                    a.rename(b)

                with self.assertRaisesRegex(OSError, "injected"):
                    cube.promote_directories(pairs, replace)
                for staged, target in pairs:
                    self.assertEqual((target / "marker").read_text(), "old")
                    self.assertEqual((staged / "marker").read_text(), "new")

    def test_success_keeps_previous_destinations(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            staged, target = root / "next", root / "cube"
            staged.mkdir(); target.mkdir()
            (staged / "marker").write_text("new")
            (target / "marker").write_text("old")
            backups = cube.promote_directories([(staged, target)])
            self.assertEqual((target / "marker").read_text(), "new")
            self.assertEqual((backups[0][1] / "marker").read_text(), "old")

    def test_assembly_failure_never_writes_into_current_targets(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            output, fixtures = root / "cube", root / "fixtures"
            for target in (output, fixtures):
                target.mkdir(); (target / "marker").write_text("old")
            stages = []

            def fail(_metadata):
                stages.extend([cube.OUT, cube.FIX])
                for stage in stages:
                    (stage / "partial").write_text("partial")
                raise RuntimeError("injected assembly failure")

            with patch.object(cube, "load_metadata", return_value={}), self.assertRaisesRegex(RuntimeError, "assembly"):
                cube.build_staged(output, fixtures, fail)
            for target in (output, fixtures):
                self.assertEqual((target / "marker").read_text(), "old")
                self.assertFalse((target / "partial").exists())
            for stage in stages:
                self.assertEqual((stage / "partial").read_text(), "partial")

    def test_overlapping_destinations_are_rejected_before_build(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            with self.assertRaisesRegex(ValueError, "separate"):
                cube.build_staged(root, root / "fixtures")


class BuildingMetadata(unittest.TestCase):
    def metadata(self, root):
        bands = {name: {"b": index, "source": "FEMA/ORNL USA Structures", "licence": "CC BY 4.0"}
                 for index, name in ((15, "built"), (16, "nonres"), (17, "bldgunk"))}
        files = {}
        for name in bands:
            data = name.encode()
            (root / f"{name}.tif").write_bytes(data)
            files[f"{name}.tif"] = hashlib.sha256(data).hexdigest()
        return {"bands": bands, "files": files, "coverage": {}, "checks": {},
                "built_at": "2026-10-31T00:00:00Z",
                "provenance": {"identity": {"source": "https://example.org/FeatureServer/0", "bounds": [1, 2, 3, 4],
                                            "fields": ["OBJECTID", "OCC_CLS"], "crs": 5070,
                                            "edit_state": {"lastEditDate": 123}},
                               "fetched_at": "2026-10-30T00:00:00Z", "sha256": "source-data-hash",
                               "object_ids": [10, 11, 12]}}

    def test_metadata_is_required_and_band_positions_checked(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            for n in OTHER_METAS:
                (root / f"{n}_meta.json").write_text("{}")
            source_band_metas(root)
            with patch.object(cube, "SRC", root):
                with self.assertRaises(FileNotFoundError):
                    cube.load_metadata()
                b = self.metadata(root)
                p = root / "buildings_meta.json"
                p.write_text(json.dumps(b))
                self.assertEqual(cube.load_metadata()["buildings"], b)
                b["bands"]["nonres"]["b"] = 15
                p.write_text(json.dumps(b))
                with self.assertRaisesRegex(ValueError, "nonres"):
                    cube.load_metadata()

    def test_missing_or_mixed_generation_is_refused_before_assembly(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            for n in OTHER_METAS:
                (root / f"{n}_meta.json").write_text("{}")
            source_band_metas(root)
            metadata = self.metadata(root)
            (root / "buildings_meta.json").write_text(json.dumps(metadata))
            with patch.object(cube, "SRC", root):
                (root / "nonres.tif").write_bytes(b"another generation")
                with self.assertRaisesRegex(ValueError, "hash mismatch: nonres.tif"):
                    cube.build_staged(root / "cube", root / "fixtures", lambda _: self.fail("assembly ran"))
                self.assertFalse((root / "cube").exists())
                (root / "nonres.tif").unlink()
                with self.assertRaises(FileNotFoundError):
                    cube.load_metadata()
                metadata["files"].pop("nonres.tif")
                (root / "buildings_meta.json").write_text(json.dumps(metadata))
                with self.assertRaisesRegex(ValueError, "all three"):
                    cube.load_metadata()

    def test_compact_provenance_retains_identity_and_dates_without_id_list(self):
        with tempfile.TemporaryDirectory() as temp:
            metadata = self.metadata(Path(temp))
            compact = cube.building_provenance(metadata)
            self.assertEqual(compact["built_at"], metadata["built_at"])
            self.assertEqual(compact["fetched_at"], metadata["provenance"]["fetched_at"])
            self.assertEqual(compact["identity"], metadata["provenance"]["identity"])
            self.assertEqual(compact["sha256"], metadata["provenance"]["sha256"])
            self.assertEqual(compact["object_id_count"], 3)
            self.assertNotIn("object_ids", compact)

    def test_national_provenance_retains_each_state_archive_and_feature_count(self):
        metadata = {"built_at": "2026-11-02", "provenance": {
            "identity": {"source": "FEMA/ORNL USA Structures state archives", "crs": 5070,
                         "archives": {"NV": {"sha256": "archive-hash", "deliverable": "20250913"}}},
            "sha256": "national-hash", "feature_count": 100}}
        compact = cube.building_provenance(metadata)
        self.assertEqual(compact["identity"], metadata["provenance"]["identity"])
        self.assertEqual(compact["feature_count"], 100)
        self.assertIsNone(compact["object_id_count"])


class SourceBandPins(unittest.TestCase):
    """aviation (b18) and nfhl (b19): code tables, credit and edition checked, tif bytes bound by sha256."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        for n in OTHER_METAS:
            (self.root / f"{n}_meta.json").write_text("{}")
        (self.root / "buildings_meta.json").write_text(json.dumps(BuildingMetadata.metadata(None, self.root)))
        self.metas = source_band_metas(self.root)
        self.src = patch.object(cube, "SRC", self.root)
        self.src.start()

    def tearDown(self):
        self.src.stop()
        self.temp.cleanup()

    def write(self, name):
        (self.root / f"{name}_meta.json").write_text(json.dumps(self.metas[name]))

    def test_records_band_index_edition_credit_and_tif_hash(self):
        bands = cube.load_metadata()["source_bands"]
        self.assertEqual({n: e["b"] for n, e in bands.items()}, {"aviation": 18, "nfhl": 19})
        for name in ("aviation", "nfhl"):
            self.assertEqual(bands[name]["sha256"], hashlib.sha256(f"{name} generation 1".encode()).hexdigest())
            self.assertEqual(bands[name]["codes"], self.metas[name]["codes"])
        self.assertEqual(bands["aviation"]["credit"], "FAA NTAD")
        self.assertEqual(bands["aviation"]["edition"]["ntad_eff_date"], "2026/10/29")
        self.assertEqual(bands["nfhl"]["credit"], "FEMA National Flood Hazard Layer")
        self.assertEqual(bands["nfhl"]["edition"]["edition_file"], "NFHL_Key_Layers_202610.gdb.zip")
        self.assertEqual(bands["nfhl"]["edition"]["sha256"], "2" * 64)

    def test_tif_not_matching_the_pinned_hash_is_refused_before_assembly(self):
        self.metas["nfhl"]["files"] = {"nfhl.tif": hashlib.sha256(b"nfhl generation 1").hexdigest()}
        self.write("nfhl")
        cube.load_metadata()
        (self.root / "nfhl.tif").write_bytes(b"nfhl generation 2")
        with self.assertRaisesRegex(ValueError, "nfhl generation hash mismatch: nfhl.tif"):
            cube.build_staged(self.root / "cube", self.root / "fixtures", lambda _: self.fail("assembly ran"))
        self.assertFalse((self.root / "cube").exists())

    def test_tif_changed_after_it_was_hashed_is_refused(self):
        metadata = cube.load_metadata()
        cube.verify_source_bands(metadata)
        (self.root / "aviation.tif").write_bytes(b"aviation generation 2")
        with self.assertRaisesRegex(ValueError, "aviation generation hash mismatch: aviation.tif changed"):
            cube.verify_source_bands(metadata)

    def test_code_drift_missing_credit_or_edition_is_refused(self):
        cases = [("aviation", "codes", {**self.metas["aviation"]["codes"], "7": "new class"}, "codes differ"),
                 ("nfhl", "codes", {"0": "nodata", "1": "x"}, "codes differ"),
                 ("aviation", "product", "Some other aviation data", "credit"),
                 ("aviation", "ntad_eff_date", None, "edition"),
                 ("nfhl", "credit", "FEMA", "credit"),
                 ("nfhl", "sha256", "abc", "edition")]
        for name, key, value, message in cases:
            with self.subTest(name=name, key=key):
                saved = self.metas[name][key]
                self.metas[name][key] = value
                self.write(name)
                with self.assertRaisesRegex(ValueError, message):
                    cube.load_metadata()
                self.metas[name][key] = saved
                self.write(name)
        cube.load_metadata()


if __name__ == "__main__":
    unittest.main()
