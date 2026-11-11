"""Immutable aviation observation generations and the aviation join."""
import collections
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import build_route_screening as S


def ntad_tables(runway_len=1000.):
    facility = {"SITE_NO": "001.", "ARPT_ID": "RNO", "ARPT_NAME": "Example", "SITE_TYPE_CODE": "A", "STATE_CODE": "NV", "COUNTRY_CODE": "US",
                "FACILITY_USE_CODE": "PU", "ARPT_STATUS": "CI", "LONG_DECIMAL": -120., "LAT_DECIMAL": 40., "EFF_DATE": "2026/10/29"}
    runway = {"SITE_NO": "001.", "ARPT_ID": "RNO", "RWY_ID": "09/27", "RWY_LEN": runway_len, "RWY_WIDTH": 100.,
              "LONG1_DECIMAL": -120., "LONG2_DECIMAL": -119.996952, "LAT1_DECIMAL": 40., "LAT2_DECIMAL": 40., "EFF_DATE": "2026/10/29"}
    ends = [{"SITE_NO": "001.", "ARPT_ID": "RNO", "RWY_ID": ident_, "RWY_END_ID": end, "LONG_DECIMAL": lon, "LAT_DECIMAL": 40.,
             "RWY_END_ELEV": 4000., "RWY_END_ELEV_DATE": "2014/10/08", "RWY_END_ELEV_SOURCE": "SURVEY", "EFF_DATE": "2026/10/29"}
            for ident_, end, lon in [("09/27", "09", -120.), ("09/27", "27", -119.996952), ("H1", "H1", -120.5)]]
    adds = [{"IDENT": "RNO", "IAPEXISTS": 1}, {"IDENT": "RNO", "IAPEXISTS": 0}]
    return {"facilities": [facility], "runways": [runway], "runway_ends": ends, "adds_airports": adds}


def ntad_manifest(tables):
    return {"eff_date": "2026/10/29", "fetched": "2026-11-03", "layers": {
        n: {"count": len(r), "returnCountOnly": len(r), "sha256": "0" * 64, "size": 1, "url": S.NTAD + n} for n, r in tables.items()}}


def project(lon, lat):
    return ((lon + 120) * 100_000, (lat - 40) * 100_000)


class AviationTests(unittest.TestCase):
    def test_national_join_keeps_closed_facilities_flags_and_projects(self):
        tables = ntad_tables()
        result, meta = S.aviation_from_ntad(ntad_manifest(tables), tables, project)
        self.assertEqual(result["facilities"][0]["status"], "CI")
        self.assertEqual(result["facilities"][0]["iap"], 1)
        self.assertEqual(result["runways"][0]["ends"][0], [0., 0.])
        self.assertAlmostEqual(result["runways"][0]["ends"][1][0], 304.8, places=1)
        self.assertEqual(meta["counts"]["runwayEndsOutsidePairedRunways"], 1)
        self.assertEqual(meta["cycle"], "2026/10/29")
        self.assertNotIn("Reno", meta["scope"])

    def test_bad_tables_rejected(self):
        for fault in ("duplicate", "cycle", "orphan", "unpaired", "nan", "site"):
            tables = copy.deepcopy(ntad_tables())
            if fault == "duplicate": tables["facilities"] *= 2
            if fault == "cycle": tables["runway_ends"][0]["EFF_DATE"] = "2026/10/01"
            if fault == "orphan": tables["runways"][0]["ARPT_ID"] = "XXX"
            if fault == "unpaired": tables["runway_ends"].pop(0)
            if fault == "nan": tables["facilities"][0]["LONG_DECIMAL"] = float("nan")
            if fault == "site": tables["runways"][0]["SITE_NO"] = "other."
            with self.subTest(fault=fault), self.assertRaises(ValueError):
                S.aviation_from_ntad(ntad_manifest(tables), tables, project)

    def test_length_disagreement_is_counted_not_fatal(self):
        tables = ntad_tables(runway_len=5000.)
        _, meta = S.aviation_from_ntad(ntad_manifest(tables), tables, project)
        self.assertEqual(meta["counts"]["runway_length_differs_over_1_5_percent"], 1)

    def test_read_ntad_checks_hash_and_count(self):
        with tempfile.TemporaryDirectory() as d:
            d = Path(d)
            write_ntad(d, ntad_tables())
            manifest, tables = S.read_ntad(d)
            self.assertEqual(len(tables["facilities"]), 1)
            (d / "facilities.jsonl").write_text("")
            with self.assertRaisesRegex(ValueError, "differs"):
                S.read_ntad(d)


def write_ntad(d, tables):
    layers = {}
    for name, rows in tables.items():
        path = d / f"{name}.jsonl"
        path.write_text("".join(json.dumps({"attributes": r}) + "\n" for r in rows))
        layers[name] = {"count": len(rows), "returnCountOnly": len(rows), "sha256": hashlib.sha256(path.read_bytes()).hexdigest(), "size": 1, "url": S.NTAD + name}
    (d / "ntad_manifest.json").write_text(json.dumps({"eff_date": "2026/10/29", "fetched": "2026-11-03", "layers": layers}))


class PromotionTests(unittest.TestCase):
    def stage(self, folder, value):
        p = Path(folder) / value
        p.mkdir()
        (p / "aviation.json").write_text(json.dumps({"value": value}))
        return p

    def test_old_generations_remain_after_pointer_changes(self):
        with tempfile.TemporaryDirectory() as d:
            out = Path(d) / "output"
            first = S.activate_generation(self.stage(d, "first"), out, {"aviation": {}})
            second = S.activate_generation(self.stage(d, "second"), out, {"aviation": {}})
            self.assertNotEqual(first["generation"], second["generation"])
            self.assertEqual(json.loads((out / "manifest.json").read_text()), second)
            self.assertEqual((out / first["generation"] / "aviation.json").read_text(), '{"value": "first"}')
            self.assertEqual((out / second["generation"] / "aviation.json").read_text(), '{"value": "second"}')

    def test_failed_pointer_leaves_old_manifest_and_generation_intact(self):
        with tempfile.TemporaryDirectory() as d:
            out = Path(d) / "output"
            first = S.activate_generation(self.stage(d, "first"), out, {})
            original = S.producer.atomic_json
            def write(path, value):
                if Path(path) == out / "manifest.json": raise OSError("injected pointer failure")
                return original(path, value)
            with patch.object(S.producer, "atomic_json", side_effect=write), self.assertRaises(OSError):
                S.activate_generation(self.stage(d, "next"), out, {})
            self.assertEqual(json.loads((out / "manifest.json").read_text()), first)
            self.assertTrue((out / first["generation"] / "aviation.json").is_file())

    def test_corrupt_existing_generation_is_not_overwritten(self):
        with tempfile.TemporaryDirectory() as d:
            out = Path(d) / "output"
            first = S.activate_generation(self.stage(d, "first"), out, {})
            (out / first["generation"] / "aviation.json").write_text("corrupt")
            stage = self.stage(d, "second")
            (stage / "aviation.json").write_text(json.dumps({"value": "first"}))
            with self.assertRaisesRegex(ValueError, "corrupt"):
                S.activate_generation(stage, out, {})
            self.assertEqual((out / first["generation"] / "aviation.json").read_text(), "corrupt")



class BuildTests(unittest.TestCase):
    @unittest.skipUnless(importlib.util.find_spec("pyproj"), "pyproj not installed")
    def test_build_makes_an_immutable_aviation_only_generation(self):
        with tempfile.TemporaryDirectory() as t:
            t = Path(t); ntad = t / "ntad"; ntad.mkdir(); root = t / "out"
            write_ntad(ntad, ntad_tables())
            value = S.build(ntad, root)
            self.assertRegex(value["generation"], r"^[a-f0-9]{32}$")
            self.assertEqual(value["version"], 2)
            self.assertIs(value["complete"], True)
            self.assertNotIn("buildings", value)
            gen = root / value["generation"]
            self.assertEqual(sorted(p.name for p in gen.iterdir()), ["aviation.json", "generation.json"])
            self.assertEqual(json.loads((root / "manifest.json").read_text()), value)
            self.assertEqual(json.loads((gen / "aviation.json").read_text())["version"], 2)
            self.assertEqual(value["aviation"]["sha256"], hashlib.sha256((gen / "aviation.json").read_bytes()).hexdigest())
            self.assertEqual(S.build(ntad, root)["generation"], value["generation"])

    def test_link_keeps_regional_files(self):
        with tempfile.TemporaryDirectory() as t:
            t = Path(t); root = t / "root"; root.mkdir(); link = t / "report/screening"
            (link / "47e5").mkdir(parents=True); (link / "manifest.json").write_text("{}")
            S.link_report_dir(root, link)
            self.assertTrue(link.is_symlink())
            self.assertTrue((root / "47e5").is_dir())
            self.assertTrue((root / "manifest.regional-v1.json").is_file())
            S.link_report_dir(root, link)


if __name__ == "__main__":
    unittest.main()
