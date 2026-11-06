"""Immutable observation generations, aviation joins and unsimplified roof exports."""
import collections
import copy
import gzip
import hashlib
import importlib.util
import json
from pathlib import Path
import shutil
import tempfile
import unittest
from unittest.mock import patch

import build_route_screening as S
import route_grid as G

GIS = all(importlib.util.find_spec(p) is not None for p in ("pyogrio", "shapely", "pyproj", "pyarrow", "pandas", "numpy"))


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
        (p / "buildings.parquet").write_bytes(value.encode())
        (p / "aviation.json").write_text(json.dumps({"value": value}))
        return p

    def test_old_generations_remain_after_pointer_changes(self):
        with tempfile.TemporaryDirectory() as d:
            out = Path(d) / "output"
            first = S.activate_generation(self.stage(d, "first"), out, {"buildings": {}, "aviation": {}})
            second = S.activate_generation(self.stage(d, "second"), out, {"buildings": {}, "aviation": {}})
            self.assertNotEqual(first["generation"], second["generation"])
            self.assertEqual(json.loads((out / "manifest.json").read_text()), second)
            self.assertEqual((out / first["generation"] / "buildings.parquet").read_bytes(), b"first")
            self.assertEqual((out / second["generation"] / "buildings.parquet").read_bytes(), b"second")

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
            (stage / "buildings.parquet").write_bytes(b"first")
            (stage / "aviation.json").write_text(json.dumps({"value": "first"}))
            with self.assertRaisesRegex(ValueError, "corrupt"):
                S.activate_generation(stage, out, {})
            self.assertEqual((out / first["generation"] / "aviation.json").read_text(), "corrupt")


@unittest.skipUnless(GIS, "GeoParquet build dependencies not installed")
class BuildingTests(unittest.TestCase):
    TILES = {"16384_5440.wkb.gz": [(0, 0), (1, 1), (2, 2), (0, 3)], "16448_5440.wkb.gz": [(1, 0), (2, 1)]}

    def make_cache(self, root, st="RI", features=5):
        import shapely
        d = Path(root) / f"{st}-abc"
        d.mkdir()
        files = {}
        for name, recs in self.TILES.items():
            c, r = (int(x) for x in name.split(".")[0].split("_"))
            x0, y0 = G.X0 + c * G.CELL, G.Y0 - r * G.CELL
            with gzip.open(d / name, "wb") as f:
                for group, k in recs:
                    wkb = shapely.to_wkb(shapely.box(x0 + 100 + 40 * k, y0 - 500, x0 + 120 + 40 * k, y0 - 480))
                    f.write(S.RECORD.pack(group, len(wkb)) + wkb)
            files[name] = hashlib.sha256((d / name).read_bytes()).hexdigest()
        (d / "manifest.json").write_text(json.dumps({"identity": {"archive": {}}, "features": features, "image_years": {"2022": 3, "2019": 2}, "files": files}))
        return d

    def test_state_file_ids_classes_statistics_and_counts(self):
        import pyarrow.parquet as pq
        with tempfile.TemporaryDirectory() as t:
            work = Path(t) / "work"; work.mkdir(); stage = Path(t) / "stage"; stage.mkdir()
            self.make_cache(work)
            info = S.build_state("RI", work, stage, rows_options=(4,))
            table = pq.read_table(stage / "RI.parquet")
            self.assertEqual(table.num_rows, 6)
            self.assertEqual(info["rows"], 6)
            self.assertEqual((info["features"], info["pieces"]), (5, 1))
            self.assertEqual(info["imageryYears"], [2019, 2022])
            ids = table["id"].to_pylist()
            self.assertEqual(len(set(ids)), 6)
            self.assertTrue(all(i.startswith("RI:16") for i in ids))
            self.assertEqual(sorted(i.split(":")[2] for i in ids if ":16384_5440:" in i), ["0", "1", "2", "3"])
            self.assertEqual(collections.Counter(table["class"].to_pylist()), {"Residential": 2, "Nonresidential": 2, "Unknown": 2})
            self.assertEqual(table["image_date"].null_count, 6)
            md = pq.ParquetFile(stage / "RI.parquet").metadata
            self.assertEqual([md.row_group(i).num_rows for i in range(md.num_row_groups)], [4, 2])
            stats = {md.row_group(0).column(j).path_in_schema: md.row_group(0).column(j).is_stats_set for j in range(md.num_columns)}
            self.assertEqual([k for k, v in stats.items() if v], S.BBOX)
            self.assertEqual(info["row_group_rows"], 4)
            b = info["bounds5070"]
            self.assertEqual((b[2] - b[0], b[3] - b[1]), (128 * 250, 64 * 250))

    def test_oversize_state_is_rewritten_at_smaller_groups_then_refused(self):
        with tempfile.TemporaryDirectory() as t:
            work = Path(t) / "work"; work.mkdir(); stage = Path(t) / "stage"; stage.mkdir()
            self.make_cache(work)
            real = S.parquet_report
            calls = []
            def fake(path):
                r = real(path); calls.append(1)
                return {**r, "footer_bytes": S.MAX_FOOTER + 1} if len(calls) < 3 else r
            with patch.object(S, "parquet_report", fake):
                info = S.build_state("RI", work, stage, rows_options=(4, 2, 1))
            self.assertEqual(info["row_group_rows"], 1)
            with tempfile.TemporaryDirectory() as t2:
                stage2 = Path(t2); calls.clear()
                with patch.object(S, "parquet_report", lambda p: {**real(p), "max_row_group_bytes": S.MAX_ROW_GROUP + 1}), self.assertRaises(ValueError):
                    S.build_state("RI", work, stage2, rows_options=(4, 2))
                self.assertFalse((stage2 / "RI.parquet").exists())

    def test_changed_tile_is_refused_and_finished_state_is_not_redone(self):
        with tempfile.TemporaryDirectory() as t:
            work = Path(t) / "work"; work.mkdir(); stage = Path(t) / "stage"; stage.mkdir()
            d = self.make_cache(work)
            S.build_state("RI", work, stage, rows_options=(4,))
            with patch.object(S, "write_state", side_effect=AssertionError("redone")):
                self.assertEqual(S.build_state("RI", work, stage, rows_options=(4,))["rows"], 6)
            with gzip.open(d / "16448_5440.wkb.gz", "wb") as f:
                f.write(b"")
            (stage.with_name(stage.name + ".meta") / "RI.json").unlink()
            with self.assertRaisesRegex(ValueError, "differs"):
                S.build_state("RI", work, stage, rows_options=(4,))

    def test_planted_duplicate_ids_are_caught(self):
        import pyarrow as pa
        import pyarrow.parquet as pq
        with tempfile.TemporaryDirectory() as t:
            work = Path(t) / "work"; work.mkdir(); stage = Path(t) / "stage"; stage.mkdir()
            self.make_cache(work)
            info = S.build_state("RI", work, stage, rows_options=(4,))
            files = [{"name": "RI.parquet", "state": "RI", "rows": 6}]
            S.verify_ids(stage, files)
            shutil.copy(stage / "RI.parquet", stage / "NV.parquet")
            with self.assertRaisesRegex(ValueError, "outside its state"):
                S.verify_ids(stage, files + [{"name": "NV.parquet", "state": "NV", "rows": 6}])
            with self.assertRaisesRegex(ValueError, "same state"):
                S.verify_ids(stage, files + [{"name": "NV.parquet", "state": "RI", "rows": 6}])
            table = pq.read_table(stage / "RI.parquet")
            ids = table["id"].to_pylist(); ids[1] = ids[0]
            pq.write_table(table.set_column(0, "id", pa.array(ids)), stage / "RI.parquet")
            with self.assertRaisesRegex(ValueError, "duplicate id"):
                S.verify_ids(stage, files)

    def test_build_end_to_end_makes_an_immutable_hex_generation(self):
        with tempfile.TemporaryDirectory() as t:
            t = Path(t)
            work = t / "work"; work.mkdir(); ntad = t / "ntad"; ntad.mkdir(); root = t / "out"
            self.make_cache(work, "RI", 5); self.make_cache(work, "DC", 5)
            write_ntad(ntad, ntad_tables())
            with patch.object(S, "guard_disks"):
                value = S.build(work, ntad, root, ["RI", "DC"], rows_options=(4,))
            self.assertRegex(value["generation"], r"^[a-f0-9]{32}$")
            self.assertEqual(value["version"], 2)
            self.assertEqual(value["id_kind"], "piece")
            self.assertFalse(value["complete"])
            self.assertEqual(value["buildings"]["rows"], 12)
            self.assertEqual(value["buildings"]["rows"], value["buildings"]["features"] + value["buildings"]["pieces"])
            gen = root / value["generation"]
            self.assertEqual(sorted(p.name for p in gen.iterdir()), ["DC.parquet", "RI.parquet", "aviation.json", "generation.json"])
            self.assertEqual(json.loads((root / "manifest.json").read_text()), value)
            self.assertEqual(json.loads((gen / "aviation.json").read_text())["version"], 2)

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
