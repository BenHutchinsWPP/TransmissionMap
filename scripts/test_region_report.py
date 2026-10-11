"""Smoke tests for region_report.py — the region-tag coverage and size report.

The contract this guards: `|`-delimited lists and scalars count the same way
across every input format (.geojsonl, .geojson.gz, .gpkg); absent, blank,
`none` and malformed values are told apart and every share is over all
features; per-zoom tile sizes come out of PMTiles root and leaf directories;
the headroom estimate costs only blobs not already published, in whole KB; and
the report exits non-zero once an archive passes the per-file cap. Synthetic
files only — no data/, no network.
"""
import collections
import contextlib
import gzip
import io
import json
import sqlite3
import struct
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import region_report
from region_report import (
    blob_sha, classify, field_stats, iter_properties, iter_sampled, parse_archive_arg,
    parse_sample_arg, percentile, pmtiles_maxzoom, tile_sizes,
)

FEATURES = [
    {"states": "|TX|", "nerc": "TRE"},
    {"states": "|TX|NM|", "nerc": "none"},
    {"states": "|TX|NM|OK|", "nerc": "WECC"},
    {"states": "none", "nerc": ""},
]


def _varint(n):
    out = bytearray()
    while True:
        b = n & 0x7F
        n >>= 7
        out.append(b | (0x80 if n else 0))
        if not n:
            return bytes(out)


def _dir(entries):
    """Gzipped PMTiles directory; entries are (tile_id, run, length, offset)."""
    body = _varint(len(entries))
    last = 0
    for tid, *_ in entries:
        body += _varint(tid - last)
        last = tid
    body += b"".join(_varint(e[1]) for e in entries)
    body += b"".join(_varint(e[2]) for e in entries)
    body += b"".join(_varint(e[3] + 1) for e in entries)
    return gzip.compress(body)


def _decoder(text, rc=0):
    """Patch subprocess.Popen to a tippecanoe-decode that prints `text` and exits with `rc`."""
    proc = mock.Mock(stdout=io.StringIO(text))
    proc.wait.return_value = rc
    return mock.patch.object(region_report.subprocess, "Popen", return_value=proc)


def _pmtiles(path, root_entries, leaves=()):
    """Header + root directory + leaf directories, each pointed at by a root entry with run 0."""
    leaf = b""
    for entries in leaves:
        gz = _dir(entries)
        root_entries = root_entries + [(entries[0][0], 0, len(gz), len(leaf))]
        leaf += gz
    root = _dir(root_entries)
    head = bytearray(127)
    head[:7] = b"PMTiles"
    head[7] = 3
    struct.pack_into("<QQ", head, 8, 127, len(root))
    struct.pack_into("<QQ", head, 40, 127 + len(root), len(leaf))
    Path(path).write_bytes(bytes(head) + root + leaf)


class Classify(unittest.TestCase):
    def test_kinds(self):
        self.assertEqual(classify("|TX|NM|"), ("ok", ["TX", "NM"]))
        self.assertEqual(classify("USA1f"), ("ok", ["USA1f"]))
        self.assertEqual(classify("none"), ("none", []))
        self.assertEqual(classify("|none|"), ("none", []))
        self.assertEqual(classify(""), ("blank", []))
        self.assertEqual(classify(None), ("blank", []))
        for bad in ("|", "||", "|TX||NM|", "TX|NM", "|TX|none|", "|none|TX|", "|TX|none|NM|"):
            self.assertEqual(classify(bad), ("malformed", []), bad)

    def test_percentile_nearest_rank(self):
        c = collections.Counter({1: 98, 2: 1, 5: 1})
        self.assertEqual(percentile(c, 0.99), 2)
        self.assertEqual(percentile(c, 0.5), 1)
        self.assertEqual(percentile(collections.Counter(), 0.99), 0)
        # rank = ceil(0.95 × 10) = 10 → the 10th value; truncating would give the 9th.
        self.assertEqual(percentile(collections.Counter(range(1, 11)), 0.95), 10)


class FieldStats(unittest.TestCase):
    def test_counts(self):
        total, s = field_stats(FEATURES)
        self.assertEqual(total, 4)
        self.assertEqual(set(s), {"states", "nerc"})
        st = s["states"]
        self.assertEqual((st["present"], st["absent"], st["none"], st["blank"], st["multi"]),
                         (4, 0, 1, 0, 2))
        self.assertEqual(max(st["lengths"]), 3)
        self.assertEqual(st["codes"], {"TX", "NM", "OK"})
        self.assertEqual(len(st["strings"]), 3)
        self.assertEqual(st["maxlen"], len("|TX|NM|OK|"))
        nerc = s["nerc"]
        self.assertEqual((nerc["none"], nerc["blank"], nerc["multi"]), (1, 1, 0))
        self.assertEqual(nerc["maxlen"], len("WECC"))

    def test_absent_key_counts_against_coverage(self):
        total, s = field_stats([{"states": "|TX|"}, {"name": "x"}, {"states": "||"}])
        self.assertEqual(total, 3)
        self.assertEqual((s["states"]["present"], s["states"]["absent"], s["states"]["malformed"]),
                         (2, 1, 1))
        self.assertEqual(sum(s["states"]["lengths"].values()), 3)

    def test_no_region_field(self):
        self.assertEqual(field_stats([{"name": "x"}]), (1, {}))


class PrintInputs(unittest.TestCase):
    def test_shares_are_over_all_features(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "a.geojsonl"
            rows = [{"states": "none"}, {"states": "|TX|NM|"}, {}, {}]
            p.write_text("".join(json.dumps({"properties": r}) + "\n" for r in rows))
            out = io.StringIO()
            with contextlib.redirect_stdout(out):
                region_report.print_inputs([str(p)])
        cols = out.getvalue().splitlines()[-1].split()
        # features absent% blank% none% bad% multi%
        self.assertEqual(cols[2:8], ["4", "50.00", "0.00", "25.00", "0.00", "25.00"])


class Inputs(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def _feats(self):
        return [{"type": "Feature", "properties": p, "geometry": None} for p in FEATURES]

    def test_geojsonseq(self):
        p = self.dir / "a.geojsonl"
        p.write_text("".join("\x1e" + json.dumps(f) + "\n" for f in self._feats()))
        self.assertEqual(list(iter_properties(p)), FEATURES)

    def test_geojson_gz(self):
        p = self.dir / "a.geojson.gz"
        with gzip.open(p, "wt") as f:
            json.dump({"type": "FeatureCollection", "features": self._feats()}, f)
        self.assertEqual(list(iter_properties(p)), FEATURES)

    def test_csv_reads_region_columns_only(self):
        p = self.dir / "a.csv"
        with open(p, "w", newline="", encoding="utf-8") as f:
            f.write("name,states,nerc\n")
            for row in FEATURES:
                f.write(f"x,{row['states']},{row['nerc']}\n")
        self.assertEqual(list(iter_properties(p)), FEATURES)

    def test_gpkg_reads_region_columns_only(self):
        p = self.dir / "a.gpkg"
        con = sqlite3.connect(p)
        con.execute("CREATE TABLE gpkg_contents (table_name TEXT, data_type TEXT)")
        con.execute("INSERT INTO gpkg_contents VALUES ('tx', 'features')")
        con.execute("CREATE TABLE tx (fid INTEGER, geom BLOB, name TEXT, states TEXT, nerc TEXT)")
        con.executemany("INSERT INTO tx VALUES (1, NULL, 'x', ?, ?)",
                        [(f["states"], f["nerc"]) for f in FEATURES])
        con.commit()
        con.close()
        self.assertEqual(list(iter_properties(p)), FEATURES)


class Archives(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.pm = self.dir / "t.pmtiles"
        # tile ids: 0 = z0; 1..4 = z1; 5.. = z2. A run of 2 is two tiles of one length.
        # Two leaves, the second at a non-zero offset into the leaf section.
        _pmtiles(self.pm, [(0, 1, 500, 0)],
                 leaves=[[(1, 2, 100, 0), (3, 1, 300, 100)], [(5, 1, 50, 400)]])
        self.size = self.pm.stat().st_size

    def tearDown(self):
        self.tmp.cleanup()

    def test_tile_sizes_walk_leaf_directories(self):
        z = tile_sizes(self.pm)
        self.assertEqual(dict(z[0]), {500: 1})
        self.assertEqual(dict(z[1]), {100: 2, 300: 1})
        self.assertEqual(dict(z[2]), {50: 1})

    def _run(self, cap=10**9, on_branch=(), repo_kb=0, ceiling_kb=10**6, blob=None, extra=(),
             listed=(), archive=None):
        out = io.StringIO()
        with mock.patch.object(region_report, "CEILING_BYTES", cap), \
             mock.patch.object(region_report, "published_blob", return_value=blob), \
             mock.patch.object(region_report, "listed_layers", return_value=list(listed)), \
             mock.patch.object(region_report, "published_shas", return_value=set(on_branch)), \
             mock.patch.dict("os.environ", {"SIZE_CEILING_KB": str(ceiling_kb)}), \
             contextlib.redirect_stdout(out):
            code = region_report.main(["--archive", archive or str(self.pm), *map(str, extra),
                                       "--repo-kb", str(repo_kb)])
        return code, out.getvalue()

    def test_archive_at_cap_passes(self):
        code, out = self._run(cap=self.size)
        self.assertEqual(code, 0)
        self.assertNotIn("OVER CAP", out)

    def test_archive_one_byte_over_cap_fails(self):
        self.pm.write_bytes(self.pm.read_bytes().ljust(3000, b"\0"))
        code, out = self._run(cap=3000 - 1)
        self.assertEqual(code, 1)
        self.assertIn("OVER CAP", out)
        self.assertIn("new objects (not on origin/data-static): 0 KB", out)

    def test_headroom_counts_unpublished_blob_once_in_whole_kb(self):
        self.pm.write_bytes(self.pm.read_bytes().ljust(3000, b"\0"))
        twin = self.dir / "twin.pmtiles"
        twin.write_bytes(self.pm.read_bytes())
        _, out = self._run(extra=[twin])
        self.assertIn("2 added", out)
        self.assertIn("new objects (not on origin/data-static): 2 KB", out)

    def test_headroom_substitutes_archive_for_listed_path(self):
        self.pm.write_bytes(self.pm.read_bytes().ljust(3000, b"\0"))
        listed = self.dir / "listed.pmtiles"
        listed.write_bytes(b"x" * 5000)
        missing = self.dir / "missing.pmtiles"
        _, out = self._run(listed=[str(listed), str(missing)])
        self.assertIn("2 listed paths, 0 substituted, 1 added", out)
        self.assertIn("new objects (not on origin/data-static): 7 KB", out)  # 8000 B
        _, out = self._run(listed=[str(listed), str(missing)], archive=f"{self.pm}={listed}")
        self.assertIn("2 listed paths, 1 substituted, 0 added", out)
        self.assertIn("new objects (not on origin/data-static): 2 KB", out)

    def test_headroom_skips_published_blob(self):
        _, out = self._run(on_branch={blob_sha(self.pm)})
        self.assertIn("new objects (not on origin/data-static): 0 KB", out)

    def test_headroom_ceiling_is_inclusive(self):
        self.pm.write_bytes(self.pm.read_bytes().ljust(2048, b"\0"))
        _, out = self._run(repo_kb=8, ceiling_kb=10)
        self.assertIn("= 10 KB", out)
        self.assertIn("fits", out)
        _, out = self._run(repo_kb=9, ceiling_kb=10)
        self.assertIn("OVER the publish ceiling", out)

    def test_delta_against_published_blob(self):
        _, out = self._run(blob=(blob_sha(self.pm), self.size))
        self.assertIn("unchanged", out)
        _, out = self._run(blob=("0" * 40, self.size - 10))
        self.assertIn("+10 (", out)
        _, out = self._run(blob=("0" * 40, 0))
        self.assertIn("(from 0 B)", out)

    def test_published_path_that_is_a_directory(self):
        with mock.patch.object(region_report, "_git", return_value="040000 tree abc -\tdata/layers"):
            self.assertIsNone(region_report.published_blob("data/layers"))
        with mock.patch.object(region_report, "_git", return_value="100644 blob abc 42\tdata/x"):
            self.assertEqual(region_report.published_blob("data/x"), ("abc", 42))

    def test_ceiling_env_overrides_publish_script_default(self):
        with mock.patch.dict("os.environ", {"SIZE_CEILING_KB": "123"}):
            self.assertEqual(region_report.size_ceiling_kb(), 123)
        with mock.patch.dict("os.environ", {"SIZE_CEILING_KB": ""}):
            self.assertGreater(region_report.size_ceiling_kb(), 0)

    def test_blob_sha_matches_git(self):
        empty = self.dir / "empty"
        empty.write_bytes(b"")
        self.assertEqual(blob_sha(empty), "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391")

    def test_unusable_path_exits_before_any_table(self):
        not_gpkg = self.dir / "x.gpkg"
        sqlite3.connect(not_gpkg).execute("CREATE TABLE t (a)").connection.close()
        not_pmtiles = self.dir / "x.bin"
        not_pmtiles.write_bytes(b"x" * 200)
        for argv in (["--input", str(self.dir / "nope.geojsonl")],
                     ["--archive", str(self.dir / "nope.pmtiles")],
                     ["--input", str(not_gpkg)],
                     ["--sample-pmtiles", str(not_pmtiles)]):
            out, err = io.StringIO(), io.StringIO()
            with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
                self.assertEqual(region_report.main(argv), 2)
            self.assertEqual(out.getvalue(), "")
            self.assertEqual(len(err.getvalue().strip().splitlines()), 1)

    def test_sample_arg_split(self):
        self.assertEqual(parse_sample_arg("a/b.pmtiles:7"), ("a/b.pmtiles", 7))
        self.assertEqual(parse_sample_arg("a/b.pmtiles"), ("a/b.pmtiles", None))
        odd = self.dir / "c:9.pmtiles"
        odd.write_bytes(b"")
        self.assertEqual(parse_sample_arg(str(odd)), (str(odd), None))

    def test_maxzoom_from_header(self):
        self.assertEqual(pmtiles_maxzoom(self.pm), 0)
        data = bytearray(self.pm.read_bytes())
        data[101] = 9
        self.pm.write_bytes(bytes(data))
        self.assertEqual(pmtiles_maxzoom(self.pm), 9)

    def test_sampler_reads_features_from_decoder_output(self):
        feats = [
            {"type": "Feature", "properties": {"states": "none", "nerc": "WECC"},
             "geometry": {"type": "Point", "coordinates": [-99.9, 29.9]}},
            {"type": "Feature", "properties": {"states": "|TX|NM|", "nerc": "none", "n": "a"},
             "geometry": {"type": "LineString", "coordinates": [[-100, 30], [-99, 31]]}},
        ]
        text = ('{ "type": "FeatureCollection", "properties": { "zoom": 2, "x": 0, "y": 1 }, '
                '"features": [\n'
                '{ "type": "FeatureCollection", "properties": { "layer": "s" }, "features": [\n'
                + ",\n".join(json.dumps(f) for f in feats) + "\n] }\n] }\n")
        with _decoder(text) as popen:
            got = list(iter_sampled(self.pm, 2))
        self.assertEqual(got, [f["properties"] for f in feats])
        popen.assert_called_once()
        self.assertEqual(popen.call_args.args[0],
                         ["tippecanoe-decode", "-z", "2", "-Z", "2", str(self.pm)])

    def test_sampler_fails_on_decoder_error(self):
        with _decoder("", rc=1), self.assertRaises(SystemExit):
            list(iter_sampled(self.pm, 0))

    def test_sample_table_at_maxzoom_by_default(self):
        out = io.StringIO()
        with _decoder('{ "type": "Feature", "properties": { "states": "|TX|" } }\n'), \
             mock.patch.object(region_report.shutil, "which", return_value="/usr/bin/x"), \
             contextlib.redirect_stdout(out):
            self.assertEqual(region_report.main(["--sample-pmtiles", str(self.pm)]), 0)
        rows = out.getvalue().splitlines()
        self.assertIn("maxlen", rows[2])
        row = rows[-1].split()
        self.assertEqual(row[1], "z0")                       # zoom after the archive path
        self.assertEqual(row[2:4], ["states", "1"])          # field, feature instances
        self.assertEqual(row[-1], str(len("|TX|")))          # maxlen

    def test_archive_arg_split(self):
        self.assertEqual(parse_archive_arg("x/a.pmtiles=data/layers/b.pmtiles"),
                         ("x/a.pmtiles", "data/layers/b.pmtiles"))
        odd = self.dir / "a=b.pmtiles"
        odd.write_bytes(b"")
        self.assertEqual(parse_archive_arg(str(odd))[0], str(odd))


if __name__ == "__main__":
    unittest.main()
