"""Tests for fetch_route_inputs.py: the USA Structures zip-name parser. Stdlib only."""
import io
import json
import os
import sys
import tempfile
import zipfile
import unittest
from pathlib import Path
from unittest import mock

import fetch_route_inputs as f


class StructuresTests(unittest.TestCase):
    def test_state_of_zip_name(self):
        self.assertEqual(f.structures_state("VT_Structures_20260913.zip"), "VT")
        self.assertEqual(f.structures_state("Deliverable20250606TX.zip"), "TX")
        self.assertIsNone(f.structures_state("VT_Structures_metadata.xml"))
        self.assertIsNone(f.structures_state("Deliverable2025TX.zip"))

    def test_not_conus(self):
        self.assertEqual(set(f.NOT_CONUS), {"AK", "HI", "AS", "GU", "MP", "PR", "VI"})


class NfhlTests(unittest.TestCase):
    def fake_head(self, final, size="100"):
        r = mock.Mock()
        r.geturl.return_value = final
        r.headers = {"Content-Length": size, "Last-Modified": "Thu, 15 Oct 2026 00:00:00 GMT"}
        return r

    def test_pinned_edition_passes(self):
        with mock.patch.object(f.urllib.request, "urlopen", return_value=self.fake_head(
                "https://hazards.fema.gov/wa/loma/NFHL_Key_Layers_202610.gdb.zip")):
            url, size, lm = f.nfhl_resolve()
        self.assertEqual((url.rsplit("/", 1)[-1], size), ("NFHL_Key_Layers_202610.gdb.zip", 100))

    def test_other_edition_refused(self):
        with mock.patch.object(f.urllib.request, "urlopen", return_value=self.fake_head(
                "https://hazards.fema.gov/wa/loma/NFHL_Key_Layers_202611.gdb.zip")):
            with self.assertRaises(SystemExit) as e:
                f.nfhl_resolve()
        self.assertIn("202611", str(e.exception))

    def test_edition_override(self):
        with mock.patch.object(f.urllib.request, "urlopen", return_value=self.fake_head("https://x/NFHL_Key_Layers_202611.gdb.zip")):
            self.assertEqual(f.nfhl_resolve(edition="NFHL_Key_Layers_202611.gdb.zip")[1], 100)

    def test_chunked_download_assembles_and_resumes(self):
        data = bytes(range(256)) * 40  # 10,240 bytes, 4 chunks of 3,000
        calls = []

        def fake(req, timeout=0):
            a, b = (int(x) for x in req.headers["Range"].split("=")[1].split("-"))
            calls.append(a)
            r = mock.MagicMock()
            r.status = 206
            r.__enter__.return_value = r
            chunks = [data[a:b + 1], b""]
            r.read.side_effect = lambda n=0: chunks.pop(0)
            return r
        with tempfile.TemporaryDirectory() as d, mock.patch.object(f.urllib.request, "urlopen", fake):
            dest = Path(d) / "x.zip"
            f.fetch_chunked("http://u", dest, len(data), streams=2, chunk=3000)
            self.assertEqual(dest.read_bytes(), data)
            self.assertEqual(sorted(calls), [0, 3000, 6000, 9000])
            self.assertFalse(Path(str(dest) + ".part.done").exists())


def fake_stream(data, headers):
    r = mock.MagicMock()
    r.status = 200
    r.headers = headers
    r.__enter__.return_value = r
    buf = io.BytesIO(data)
    r.read.side_effect = lambda n=-1: buf.read(n)
    return r


class AtomicOutputTests(unittest.TestCase):
    def test_download_short_body_is_not_kept(self):
        with tempfile.TemporaryDirectory() as d, mock.patch.object(
                f.urllib.request, "urlopen", return_value=fake_stream(b"abc", {"Content-Length": "10"})):
            dest = Path(d) / "x.zip"
            with self.assertRaises(SystemExit):
                f.download("http://u", dest, "v")
            self.assertFalse(dest.exists())
            self.assertFalse(Path(str(dest) + ".part").exists())

    def test_download_full_body_kept(self):
        with tempfile.TemporaryDirectory() as d, mock.patch.object(
                f.urllib.request, "urlopen", return_value=fake_stream(b"abcde", {"Content-Length": "5"})):
            dest = Path(d) / "x.zip"
            f.download("http://u", dest, "v")
            self.assertEqual(dest.read_bytes(), b"abcde")

    def test_unzip_interrupted_extract_is_redone(self):
        with tempfile.TemporaryDirectory() as d:
            z, out = Path(d) / "a.zip", Path(d) / "out"
            with zipfile.ZipFile(z, "w") as zf:
                zf.writestr("a.txt", "A")

            def half(self, path=None, *a, **k):
                (Path(path) / "partial.txt").write_text("half")
                raise KeyboardInterrupt
            with mock.patch.object(zipfile.ZipFile, "extractall", half):
                with self.assertRaises(KeyboardInterrupt):
                    f.unzip(z, out)
            f.unzip(z, out)
            self.assertEqual((out / "a.txt").read_text(), "A")
            self.assertFalse((out / "partial.txt").exists())
            self.assertFalse(Path(str(out) + ".part").exists())

    def padus_run(self, fail_on):
        calls = []

        def fake_run(cmd, **kw):
            calls.append(cmd)
            if cmd[0] == "ogr2ogr":
                Path(cmd[-3]).write_text("x")
                if len(calls) == fail_on:
                    raise ValueError("killed")
        return calls, fake_run

    def test_padus_killed_between_layers_leaves_no_gpkg(self):
        with tempfile.TemporaryDirectory() as d:
            calls, fake_run = self.padus_run(fail_on=2)
            with mock.patch.object(f, "INP", Path(d)), mock.patch.object(f, "run", fake_run):
                with self.assertRaises(ValueError):
                    f.padus()
            self.assertFalse((Path(d) / "padus_gap_agency.gpkg").exists())
            self.assertFalse((Path(d) / "padus_dod.gpkg").exists())

    def test_padus_easement_killed_keeps_base_gpkg_unchanged(self):
        with tempfile.TemporaryDirectory() as d:
            a = Path(d) / "padus_gap_agency.gpkg"
            a.write_text("base")
            calls, fake_run = self.padus_run(fail_on=1)
            no_layer = mock.Mock(returncode=1, stdout="")
            with mock.patch.dict(sys.modules, {"disk_guard": mock.Mock()}), \
                    mock.patch.object(f, "INP", Path(d)), mock.patch.object(f, "run", fake_run), \
                    mock.patch.object(f.subprocess, "run", return_value=no_layer):
                with self.assertRaises(ValueError):
                    f.padus(easement=True)
            self.assertEqual(a.read_text(), "base")

    def test_padus_easement_checks_disk_and_clears_stale_temp(self):
        with tempfile.TemporaryDirectory() as d:
            a = Path(d) / "padus_gap_agency.gpkg"
            a.write_bytes(b"base")
            stale = [Path(d) / ("padus_gap_agency.part.gpkg" + x) for x in ("", "-journal", "-wal", "-shm")]
            for p in stale:
                p.write_text("old")
            asked = []
            guard = mock.Mock(require_free=lambda p, n: asked.append(n))
            seen = []

            def fake_run(cmd, **kw):
                seen.append([p.exists() for p in stale])
                raise ValueError("killed")
            with mock.patch.dict(sys.modules, {"disk_guard": guard}), mock.patch.object(f, "INP", Path(d)), \
                    mock.patch.object(f, "run", fake_run), \
                    mock.patch.object(f.subprocess, "run", return_value=mock.Mock(returncode=1, stdout="")):
                with self.assertRaises(ValueError):
                    f.padus(easement=True)
            self.assertEqual(asked, [4])
            self.assertEqual(seen, [[True, False, False, False]])  # stale sidecars gone before the copy; the copy is the only .part.gpkg
            self.assertFalse(any(p.exists() for p in stale))

    def test_rps_writes_part_then_renames(self):
        try:
            import numpy as np, rasterio  # noqa: F401
        except ImportError:
            self.skipTest("needs the venv (numpy, rasterio)")
        with tempfile.TemporaryDirectory() as d:
            opened = []

            def spy(path, mode="r", *a, **k):
                opened.append((str(path), mode))
                raise ValueError("killed")
            g = __import__("route_grid")
            with mock.patch.object(f, "RAW", Path(d)), mock.patch.object(g, "ROWS", 1), mock.patch.object(g, "COLS", 1), \
                    mock.patch.object(f, "getjson", return_value={"href": "http://h", "width": 1, "height": 1,
                                                                  "extent": {"xmin": g.X0, "ymax": g.Y0}}), \
                    mock.patch.object(f.urllib.request, "urlopen"), \
                    mock.patch("rasterio.MemoryFile") as mf, mock.patch("rasterio.open", spy):
                mf.return_value.__enter__.return_value.open.return_value.__enter__.return_value = mock.Mock(
                    read=lambda i: np.zeros((1, 1)), nodata=None)
                with self.assertRaises(ValueError):
                    f.rps()
            self.assertTrue(opened[0][0].endswith("rps_250m.part.tif"))
            self.assertFalse((Path(d) / "wrc/rps_250m.tif").exists())

    def test_nwi_checks_disk_once_for_both_files(self):
        with tempfile.TemporaryDirectory() as d:
            (Path(d) / "AL_geopackage_wetlands.zip.part").write_bytes(b"a" * 40)
            asked = []
            guard = mock.Mock(require_free=lambda p, n: asked.append(n))
            head = mock.Mock(headers={"Content-Length": "100"})
            with mock.patch.dict(sys.modules, {"disk_guard": guard}), mock.patch.object(f, "nwi_dir", return_value=Path(d)), \
                    mock.patch.object(f, "RAW", Path(d)), mock.patch.object(f, "NWI_STATES", ("AL", "AZ")), \
                    mock.patch.object(f.urllib.request, "urlopen", return_value=head), \
                    mock.patch.object(f, "fetch_resumable", side_effect=lambda u, dest, guard=True: (_ for _ in ()).throw(SystemExit("stop"))):
                with self.assertRaises(SystemExit):
                    f.nwi()
            self.assertEqual(asked, [60 + 100])

    def test_popwest_translate_writes_part_then_renames(self):
        with tempfile.TemporaryDirectory() as d:
            raw = Path(d)
            (raw / "popwest/unzipped/x.gdb").mkdir(parents=True)
            seen = []

            def fake_run(cmd, **kw):
                seen.append(cmd[-1])
                Path(cmd[-1]).write_text("t")
                if len(seen) == 2:
                    raise ValueError("killed")
            rec = io.BytesIO(json.dumps({"files": [{"key": f.POPWEST, "links": {"self": "u"}}],
                                         "metadata": {"publication_date": "d"}}).encode())
            rec.__enter__ = lambda s: s
            rec.__exit__ = lambda s, *a: None
            with mock.patch.object(f, "RAW", raw), mock.patch.object(f, "run", fake_run), \
                    mock.patch.object(f, "download"), mock.patch.object(f, "unzip"), \
                    mock.patch.object(f, "describe_raster"), \
                    mock.patch.object(f.urllib.request, "urlopen", return_value=rec):
                with self.assertRaises(ValueError):
                    f.popwest()
            self.assertTrue(seen[0].endswith(".part.tif"))
            self.assertTrue((raw / "popwest/Category1_Wind_EE.tif").exists())
            self.assertFalse((raw / "popwest/Category2_Wind_EE.tif").exists())


class ChunkedTests(unittest.TestCase):
    def test_incomplete_chunks_never_renamed(self):
        with tempfile.TemporaryDirectory() as d:
            dest = Path(d) / "x.zip"
            with mock.patch("concurrent.futures.ThreadPoolExecutor.map", return_value=iter(())):
                with self.assertRaises(SystemExit):
                    f.fetch_chunked("http://u", dest, 10_000, streams=2, chunk=3000)
            self.assertFalse(dest.exists())

    def test_missing_bytes_follow_done_chunks(self):
        with tempfile.TemporaryDirectory() as d:
            dest = Path(d) / "x.zip"
            self.assertEqual(f.chunked_missing(dest, 10_240, chunk=3000), 10_240)
            with open(str(dest) + ".part", "wb") as fh:
                fh.truncate(10_240)
            Path(str(dest) + ".part.done").write_text(json.dumps([0, 3]))
            self.assertEqual(f.chunked_missing(dest, 10_240, chunk=3000), 6000)
            Path(str(dest) + ".part.done").write_text(json.dumps([0, 1, 2, 3]))
            self.assertEqual(f.chunked_missing(dest, 10_240, chunk=3000), 0)

    def test_nfhl_guard_asks_for_missing_chunks_only(self):
        with tempfile.TemporaryDirectory() as d:
            dest = Path(d) / "NFHL_Key_Layers_202610.gdb.zip"
            with open(str(dest) + ".part", "wb") as fh:
                fh.truncate(1 << 30)
            Path(str(dest) + ".part.done").write_text(json.dumps([]))
            asked = []
            guard = mock.Mock(require_free=lambda p, n: asked.append(n))
            with mock.patch.dict(sys.modules, {"disk_guard": guard}), \
                    mock.patch.object(f, "nfhl_dir", return_value=Path(d)), \
                    mock.patch.object(f, "nfhl_resolve", return_value=("http://h/" + dest.name, 1 << 30, "lm")), \
                    mock.patch.object(f, "fetch_chunked", side_effect=RuntimeError("stop")):
                with self.assertRaises(RuntimeError):
                    f.nfhl()
            self.assertEqual(asked, [1 << 30])


class ResumableGuardTests(unittest.TestCase):
    def test_fetch_resumable_checks_disk_for_remaining_bytes(self):
        with tempfile.TemporaryDirectory() as d:
            dest = Path(d) / "x.zip"
            Path(str(dest) + ".part").write_bytes(b"a" * 40)
            asked = []
            guard = mock.Mock(require_free=lambda p, n: asked.append(n))
            head = mock.Mock(headers={"Content-Length": "100", "Last-Modified": "lm"})
            with mock.patch.dict(sys.modules, {"disk_guard": guard}), \
                    mock.patch.object(f.urllib.request, "urlopen", side_effect=[head, OSError("stop")] + [OSError("stop")] * 5), \
                    mock.patch.object(f.time, "sleep"):
                with self.assertRaises(SystemExit):
                    f.fetch_resumable("http://u", dest)
            self.assertEqual(asked, [60])

    def test_structures_goes_through_fetch_resumable(self):
        with tempfile.TemporaryDirectory() as d:
            page = io.BytesIO(b'{"u":"https://fema-femadata.s3.amazonaws.com/x/VT_Structures_20260913.zip",'
                              b'"v":"https://fema-femadata.s3.amazonaws.com/x/AK_Structures_20260913.zip"}')
            got = []
            with mock.patch.object(f, "structures_dir", return_value=Path(d)), \
                    mock.patch.object(f.urllib.request, "urlopen", return_value=page), \
                    mock.patch.object(f, "fetch_resumable", side_effect=lambda u, dest: (got.append(u) or (5, "lm"))):
                f.structures()
            self.assertEqual(len(got), 1)
            self.assertIn("VT", json.loads((Path(d) / "structures_zips.json").read_text()))


if __name__ == "__main__":
    unittest.main()
