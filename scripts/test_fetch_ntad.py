"""Tests for the `ntad` step of scripts/fetch_route_inputs.py (stdlib only; ntad_get is mocked, no network)."""

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import fetch_route_inputs as F  # noqa: E402

URL = "http://fake/Layer/0"


class FakeLayer:
    """ArcGIS layer with maxRecordCount 2; `truncate_after` pages then returns nothing (mutation)."""

    def __init__(self, rows, truncate_after=None, count_lie=None):
        self.rows, self.truncate_after, self.count_lie = rows, truncate_after, count_lie
        self.pages = 0

    def __call__(self, url, **q):
        if q.get("f") == "json" and "where" not in q:
            return {"maxRecordCount": 2, "fields": [{"name": "OBJECTID", "type": "esriFieldTypeOID"}]}
        if q.get("returnCountOnly"):
            return {"count": self.count_lie if self.count_lie is not None else len(self.rows)}
        last = int(q["where"].rsplit(">", 1)[1])
        self.pages += 1
        if self.truncate_after is not None and self.pages > self.truncate_after:
            return {"features": []}
        got = [r for r in sorted(self.rows, key=lambda r: r["OBJECTID"]) if r["OBJECTID"] > last]
        return {"features": [{"attributes": r, "geometry": None} for r in got[: q["resultRecordCount"]]]}


def rows(n):
    return [{"OBJECTID": i + 1, "SITE_NO": f"{13050 + i}.", "EFF_DATE": "2026/10/29"} for i in range(n)]


class PagingTest(unittest.TestCase):
    def fetch(self, layer, d):
        with mock.patch.object(F, "ntad_get", layer):
            return F.ntad_fetch_layer(URL, Path(d) / "x.jsonl", False)

    def test_all_pages_and_string_ids(self):
        with tempfile.TemporaryDirectory() as d:
            layer = FakeLayer(rows(5))
            n, h = self.fetch(layer, d)
            self.assertEqual(n, 5)
            self.assertGreaterEqual(layer.pages, 3)  # 2 + 2 + 1 (+ the empty probe)
            got = F.ntad_read(Path(d) / "x.jsonl")
            self.assertEqual([a["SITE_NO"] for a in got], ["13050.", "13051.", "13052.", "13053.", "13054."])
            self.assertEqual(h, F.sha256(Path(d) / "x.jsonl"))

    def test_stop_after_first_page_is_caught(self):  # the planted mutation
        with tempfile.TemporaryDirectory() as d:
            with self.assertRaisesRegex(RuntimeError, "fetched 2 records, returnCountOnly 5"):
                self.fetch(FakeLayer(rows(5), truncate_after=1), d)

    def test_count_mismatch_is_caught(self):
        with tempfile.TemporaryDirectory() as d:
            with self.assertRaises(RuntimeError):
                self.fetch(FakeLayer(rows(5), count_lie=6), d)

    def test_resume_partial_with_torn_line(self):
        with tempfile.TemporaryDirectory() as d:
            part = Path(d) / "x.jsonl.part"
            good = [json.dumps({"attributes": r, "geometry": None}) for r in rows(5)[:3]]
            part.write_text("\n".join(good) + '\n{"attrib')
            n, _ = self.fetch(FakeLayer(rows(5)), d)
            self.assertEqual(n, 5)
            self.assertEqual([a["OBJECTID"] for a in F.ntad_read(Path(d) / "x.jsonl")], [1, 2, 3, 4, 5])
            self.assertFalse(part.exists())


class HttpRetryTest(unittest.TestCase):
    def test_bounded_retries_then_loud_failure(self):
        calls = []

        def boom(*a, **k):
            calls.append(1)
            raise OSError("down")

        with mock.patch("urllib.request.urlopen", boom), mock.patch.object(F, "NTAD_RETRY_SLEEP", 0):
            with self.assertRaisesRegex(RuntimeError, "failed after 4 attempts"):
                F.ntad_get(URL, f="json")
        self.assertEqual(len(calls), F.NTAD_TRIES)


class NflTest(unittest.TestCase):
    fac = [{"ARPT_ID": "NFL", "SITE_NO": "13057."}]
    rwy = [{"SITE_NO": "13057."}] * 3
    end = [{"SITE_NO": "13057."}] * 6

    def test_ok(self):
        self.assertEqual(F.ntad_check_nfl(self.fac, self.rwy, self.end), (1, 3, 6))

    def test_missing_end_fails(self):
        with self.assertRaises(RuntimeError):
            F.ntad_check_nfl(self.fac, self.rwy, self.end[:5])

    def test_number_style_site_no_fails(self):
        with self.assertRaises(RuntimeError):
            F.ntad_check_nfl([{"ARPT_ID": "NFL", "SITE_NO": "13057"}], self.rwy, self.end)


class StepTest(unittest.TestCase):
    def run_step(self, d, cycles, extra=None):
        layers = {
            "NTAD_Aviation_Facilities": [{"OBJECTID": 1, "ARPT_ID": "NFL", "SITE_NO": "13057.", "EFF_DATE": "c1"}],
            "Runways_View": [{"OBJECTID": i, "SITE_NO": "13057.", "EFF_DATE": "c1"} for i in (1, 2, 3)],
            "Runway_Ends_Table": [{"OBJECTID": i, "SITE_NO": "13057.", "EFF_DATE": "c1"} for i in range(1, 7)],
            "US_Airport": [{"OBJECTID": 1, "IDENT": "NFL", "IAPEXISTS": 1}],
        }
        fakes = {k: FakeLayer(v) for k, v in layers.items()}

        def get(url, **q):
            if q.get("returnDistinctValues"):
                key = next(k for k in cycles if k in url)
                return {"features": [{"attributes": {"EFF_DATE": c}} for c in cycles[key]]}
            return fakes[next(k for k in fakes if k in url)](url, **q)

        env = {"NTAD_DIR": str(d)}
        with mock.patch.object(F, "ntad_get", get), mock.patch.dict(os.environ, env), \
                mock.patch.object(F, "log", lambda *a: None), \
                mock.patch("disk_guard.require_free") as guard:
            F.ntad()
        guard.assert_called_once()
        self.assertEqual(str(guard.call_args[0][0]), str(d))
        return fakes

    def test_full_run_then_idempotent(self):
        cyc = {"NTAD_Aviation_Facilities": ["c1"], "Runways_View": ["c1"], "Runway_Ends_Table": ["c1"]}
        with tempfile.TemporaryDirectory() as d:
            self.run_step(d, cyc)
            man = json.loads((Path(d) / "ntad_manifest.json").read_text())
            self.assertEqual(man["eff_date"], "c1")
            self.assertEqual(man["layers"]["runway_ends"]["count"], 6)
            self.assertEqual(man["layers"]["adds_airports"]["count"], 1)
            second = self.run_step(d, cyc)
            self.assertEqual(sum(f.pages for f in second.values()), 0)  # nothing re-fetched

    def test_mixed_cycle_refused(self):
        cyc = {"NTAD_Aviation_Facilities": ["c1"], "Runways_View": ["c1", "c0"], "Runway_Ends_Table": ["c1"]}
        with tempfile.TemporaryDirectory() as d:
            with self.assertRaises(SystemExit):
                self.run_step(d, cyc)
            self.assertFalse((Path(d) / "facilities.jsonl").exists())

    def test_cycle_change_against_existing_dir_refused(self):
        cyc = {"NTAD_Aviation_Facilities": ["c1"], "Runways_View": ["c1"], "Runway_Ends_Table": ["c1"]}
        with tempfile.TemporaryDirectory() as d:
            self.run_step(d, cyc)
            new = {k: ["c2"] for k in cyc}
            with self.assertRaises(SystemExit):
                self.run_step(d, new)


if __name__ == "__main__":
    unittest.main()
