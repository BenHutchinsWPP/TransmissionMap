#!/usr/bin/env python3
"""
region_report.py — Coverage and size report for the region tag fields.

Two halves, both over paths given on the command line:

  * Inputs (`--input`): tile-build inputs — GeoJSONSeq `.geojsonl`, `.gpkg`,
    `.csv` (region columns only), or a `.geojson`/`.geojson.gz` that ships as
    is. For every known region field (REGION_FIELDS) any feature carries,
    reports the shares of all features that are absent (key missing), blank,
    `none`, malformed, and carry more than one value, plus list length max/p99,
    distinct codes and strings, and the longest value (maxlen, the DBF limit).
    Every value is `|`-delimited, points included (`|TX|NM|`, `|TX|`); a
    feature in no region is the bare string `none`, and so is `|none|`.
  * Sampled tiles (`--sample-pmtiles PATH[:Z]`): the same table over the
    feature instances `tippecanoe-decode -z Z -Z Z` writes for one zoom (Z
    defaults to the archive's maxzoom), streamed, so what the tiles carry is
    measured rather than the build input.
  * Archives (`--archive PATH[=PUBLISHED]`): built `.pmtiles` or shipped
    `.geojson.gz`. Reports bytes and headroom to the per-file cap
    (build_global_tiles.CEILING_BYTES), per-zoom tile p50/p95/max for PMTiles
    (pmtiles_stats.entries — directories only, no tile payloads), and the
    delta against the blob at PUBLISHED (default: PATH itself) on the local
    `origin/data-static` ref, read with `git ls-tree -l` (no download).

Repository headroom is publish_data.sh's estimate over the set it would push:
every path `validate_build.py --list-expected` names, with each archive given
here substituted at its PUBLISHED path (or added, when that path isn't
listed). Files over the per-file cap are skipped, as drop_oversized does;
blobs are deduped by hash, and any blob already anywhere in the
`origin/data-static` tree costs nothing. The sum plus the current repository
size (`gh api repos/<slug> --jq .size`, or `--repo-kb`) is checked against
SIZE_CEILING_KB, read from publish_data.sh (or the environment, as that
script does).

Exit status is 1 when any archive is over the per-file cap, so the report can
gate a build; a missing or unreadable path exits 2 before any table prints.

    python3 scripts/region_report.py \\
        --input data/build/tx.geojsonl \\
        --archive data/layers/osm_transmission_lines_kv50.pmtiles

Dependencies: stdlib only (sqlite3 reads `.gpkg` attributes, csv reads `.csv`);
imports build_global_tiles (CEILING_BYTES) and pmtiles_stats (entries) from
this folder; `tippecanoe-decode` for `--sample-pmtiles`; runs validate_build.py
(needs PyYAML, as publish_data.sh does) for the publish set; `git` for the
published tree, `gh` (optional) for the repo size.
"""

import argparse
import collections
import csv
import gzip
import hashlib
import json
import math
import os
import re
import shutil
import sqlite3
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_global_tiles import CEILING_BYTES  # noqa: E402
from pmtiles_stats import entries  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
PUBLISHED_REF = "origin/data-static"
REGION_FIELDS = ("countries", "admin1", "states", "counties", "zcta", "ba", "nerc", "retail")
NONE = "none"
NONE_LIST = f"|{NONE}|"
LIST_RE = re.compile(r"^\|([^|\s]+\|)+$")
PMTILES_MAXZOOM_OFFSET = 101  # PMTiles v3 header: max zoom is one byte here


# ── Inputs ──────────────────────────────────────────────────────────────────
def iter_properties(path):
    """Yield each feature's properties dict (gpkg: one dict of region columns per row)."""
    p = str(path)
    if p.endswith(".gpkg"):
        con = sqlite3.connect(f"file:{p}?mode=ro", uri=True)
        try:
            for (table,) in con.execute(
                "SELECT table_name FROM gpkg_contents WHERE data_type = 'features'"
            ):
                cols = [r[1] for r in con.execute(f'PRAGMA table_info("{table}")')]
                fields = [c for c in cols if c in REGION_FIELDS]
                sel = ", ".join(f'"{c}"' for c in fields) or "1"
                for row in con.execute(f'SELECT {sel} FROM "{table}"'):
                    yield dict(zip(fields, row))
        finally:
            con.close()
        return
    if p.endswith(".csv"):
        with open(p, newline="", encoding="utf-8") as f:
            for row in csv.DictReader(f):
                yield {k: row[k] for k in REGION_FIELDS if k in row}
        return
    opener = gzip.open if p.endswith(".gz") else open
    with opener(p, "rt", encoding="utf-8") as f:
        if p.endswith(".geojsonl") or p.endswith(".geojsonl.gz"):
            for line in f:
                line = line.strip()  # also drops the GeoJSONSeq RS (\x1e)
                if line:
                    yield json.loads(line).get("properties") or {}
        else:
            for feat in json.load(f).get("features", []):
                yield feat.get("properties") or {}


def classify(value):
    """(kind, codes): kind is blank | none | malformed | ok.

    `none` is the bare string, or `|none|`; a list is `|a|b|` with no empty
    member and no `none` inside a longer list; anything else holding `|` is
    malformed; a scalar is one code.
    """
    s = "" if value is None else str(value).strip()
    if not s:
        return "blank", []
    if s in (NONE, NONE_LIST):
        return NONE, []
    if "|" not in s:
        return "ok", [s]
    if not LIST_RE.match(s):
        return "malformed", []
    codes = s.strip("|").split("|")
    return ("malformed", []) if NONE in codes else ("ok", codes)


def percentile(counter, q):
    """Nearest-rank percentile over a {value: count} Counter."""
    n = sum(counter.values())
    if not n:
        return 0
    rank = max(1, math.ceil(q * n))
    seen = 0
    for v in sorted(counter):
        seen += counter[v]
        if seen >= rank:
            return v
    return v


def field_stats(props_iter):
    """(total features, {field: counts}) — every share is over the total, absent included."""
    total = 0
    out = {}
    for props in props_iter:
        total += 1
        for field in REGION_FIELDS:
            if field not in props:
                continue
            s = out.setdefault(field, {"present": 0, "blank": 0, NONE: 0, "malformed": 0,
                                       "ok": 0, "multi": 0, "lengths": collections.Counter(),
                                       "codes": set(), "strings": set(), "maxlen": 0})
            s["present"] += 1
            s["maxlen"] = max(s["maxlen"], len(str(props[field] or "").strip()))
            kind, codes = classify(props[field])
            s[kind] += 1
            s["lengths"][len(codes)] += 1
            if len(codes) > 1:
                s["multi"] += 1
            if kind == "ok":
                s["codes"].update(codes)
                s["strings"].add(str(props[field]).strip())
    for s in out.values():
        s["absent"] = total - s["present"]
        s["lengths"][0] += s["absent"]
    return total, out


def print_inputs(paths):
    print("\n== Region fields per input (shares of all features) ==")
    print_table_head()
    for path in paths:
        total, stats = field_stats(iter_properties(path))
        print_table_rows(_short(path), total, stats)


def print_table_head():
    print(f"{'input':<44} {'field':<9} {'features':>9} {'absent%':>7} {'blank%':>7} {'none%':>7} "
          f"{'bad%':>6} {'multi%':>7} {'max':>4} {'p99':>4} {'codes':>7} {'strings':>8} {'maxlen':>6}")


def print_table_rows(label, total, stats):
    if not stats:
        print(f"{label:<44} (no region fields in {total} features)")
        return
    for field, s in stats.items():
        pct = lambda k: 100 * s[k] / total
        print(f"{label:<44} {field:<9} {total:>9} {pct('absent'):>7.2f} {pct('blank'):>7.2f} "
              f"{pct(NONE):>7.2f} {pct('malformed'):>6.2f} {pct('multi'):>7.2f} "
              f"{max(s['lengths']):>4} {percentile(s['lengths'], 0.99):>4} "
              f"{len(s['codes']):>7} {len(s['strings']):>8} {s['maxlen']:>6}")


# ── Sampled tiles ───────────────────────────────────────────────────────────
def parse_sample_arg(arg):
    """PATH[:Z]: split at the last `:`, unless the whole argument is an existing file."""
    if not Path(arg).exists() and ":" in arg:
        local, zoom = arg.rsplit(":", 1)
        if zoom.isdigit():
            return local, int(zoom)
    return arg, None


def _is_pmtiles(path):
    with open(path, "rb") as f:
        return f.read(7) == b"PMTiles"


def pmtiles_maxzoom(path):
    """The maxzoom byte of a PMTiles v3 header."""
    with open(path, "rb") as f:
        head = f.read(PMTILES_MAXZOOM_OFFSET + 1)
    return head[PMTILES_MAXZOOM_OFFSET]


def iter_sampled(path, zoom):
    """Yield each Feature's properties that tippecanoe-decode writes for one zoom.

    The decoder pretty-prints one JSON object per line for each feature, with
    the FeatureCollection and metadata lines around them; only lines that parse
    as a Feature are kept.
    """
    proc = subprocess.Popen(["tippecanoe-decode", "-z", str(zoom), "-Z", str(zoom), str(path)],
                            stdout=subprocess.PIPE, text=True, encoding="utf-8")
    for line in proc.stdout:
        line = line.strip().lstrip("\x1e").rstrip(",")
        if not line.startswith("{"):
            continue
        try:
            obj = json.loads(line)
        except ValueError:
            continue
        if obj.get("type") == "Feature":
            yield obj.get("properties") or {}
    if proc.wait() != 0:
        raise SystemExit(f"tippecanoe-decode failed on {path} at z{zoom}")


def print_samples(args):
    print("\n== Region fields over decoded tile features (shares of feature instances) ==")
    print_table_head()
    for arg in args:
        path, zoom = parse_sample_arg(arg)
        zoom = pmtiles_maxzoom(path) if zoom is None else zoom
        total, stats = field_stats(iter_sampled(path, zoom))
        print_table_rows(f"{_short(path)} z{zoom}", total, stats)


# ── Archives ────────────────────────────────────────────────────────────────
def tile_sizes(path):
    """{zoom: Counter(tile byte length → tile count)}."""
    by_zoom = collections.defaultdict(collections.Counter)
    for z, length, run in entries(path):
        by_zoom[z][length] += run
    return by_zoom


def _git(*args):
    r = subprocess.run(["git", *args], cwd=ROOT, capture_output=True, text=True)
    return r.stdout.strip() if r.returncode == 0 else None


def blob_sha(path):
    """The sha git would store `path` under (`git hash-object`), streamed."""
    h = hashlib.sha1(b"blob %d\0" % Path(path).stat().st_size)
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def published_blob(published):
    """(sha, bytes) of the file PUBLISHED on origin/data-static, or None if no file is there."""
    out = _git("ls-tree", "-l", PUBLISHED_REF, "--", published)
    if not out:
        return None
    _mode, kind, sha, size = out.splitlines()[0].split("\t")[0].split()
    return (sha, int(size)) if kind == "blob" else None


def published_shas():
    """Every blob sha anywhere in the origin/data-static tree."""
    out = _git("ls-tree", "-r", PUBLISHED_REF)
    if out is None:
        print(f"WARNING: {PUBLISHED_REF} not found — every file counts as new (git fetch origin data-static)")
    return {line.split()[2] for line in (out or "").splitlines()}


def listed_layers():
    """Paths publish_data.sh pushes (`validate_build.py --list-expected`), or None after printing why."""
    r = subprocess.run([sys.executable, str(ROOT / "scripts" / "validate_build.py"), "--list-expected"],
                       cwd=ROOT, capture_output=True, text=True)
    if r.returncode != 0:
        print("validate_build.py --list-expected failed:\n" + r.stderr.strip())
        return None
    return r.stdout.split()


def new_object_bytes(paths, on_branch):
    """Bytes of distinct blobs among `paths` not already in `on_branch` (over-cap files skipped)."""
    new = {}
    for p in paths:
        p = Path(p)
        if not p.is_file() or p.stat().st_size > CEILING_BYTES:
            continue
        sha = blob_sha(p)
        if sha not in on_branch:
            new[sha] = p.stat().st_size
    return sum(new.values())


def parse_archive_arg(arg):
    """PATH[=PUBLISHED]: split at the last `=`, unless the whole argument is an existing file."""
    local, published = arg, ""
    if not Path(arg).exists() and "=" in arg:
        local, published = arg.rsplit("=", 1)
    if not published:
        p = Path(local).resolve()
        try:
            published = str(p.relative_to(ROOT))
        except ValueError:
            published = local
    return local, published


def size_ceiling_kb():
    """SIZE_CEILING_KB as publish_data.sh resolves it: environment, else its default."""
    if os.environ.get("SIZE_CEILING_KB"):
        return int(os.environ["SIZE_CEILING_KB"])
    text = (ROOT / "scripts" / "publish_data.sh").read_text()
    return int(re.search(r'SIZE_CEILING_KB:-(\d+)', text).group(1))


def repo_kb():
    """Current repository size in KB the way publish_data.sh reads it, or None."""
    url = _git("config", "--get", "remote.origin.url") or ""
    slug = re.sub(r"\.git$", "", re.sub(r".*github\.com[:/]", "", url))
    try:
        r = subprocess.run(["gh", "api", f"repos/{slug}", "--jq", ".size"],
                           capture_output=True, text=True, timeout=30)
    except (OSError, subprocess.TimeoutExpired):
        return None
    return int(r.stdout) if r.returncode == 0 and r.stdout.strip().isdigit() else None


def report_archives(args_list, current_kb=None):
    """Print the archive tables and the headroom estimate; return the count over the cap."""
    over = 0
    substitutes = {}
    zoom_tables = []
    ref = _git("rev-parse", "--short", PUBLISHED_REF) or "missing"
    print(f"\n== Archives (cap {CEILING_BYTES / 2**20:.0f} MiB; published = local {PUBLISHED_REF} @ {ref}) ==")
    print(f"{'archive':<44} {'bytes':>12} {'MiB':>7} {'cap room MiB':>12} {'published':>12} {'delta':>16}")
    for arg in args_list:
        local, published = parse_archive_arg(arg)
        substitutes[published] = local
        size = Path(local).stat().st_size
        if size > CEILING_BYTES:
            over += 1
        blob = published_blob(published)
        if blob is None:
            pub, delta = "-", "not published"
        else:
            sha, pub_size = blob
            pub = str(pub_size)
            if blob_sha(local) == sha:
                delta = "unchanged"
            elif pub_size:
                delta = f"{size - pub_size:+d} ({100 * (size - pub_size) / pub_size:+.2f}%)"
            else:
                delta = f"{size:+d} (from 0 B)"
        flag = "  OVER CAP" if size > CEILING_BYTES else ""
        print(f"{_short(local):<44} {size:>12} {size / 2**20:>7.1f} "
              f"{(CEILING_BYTES - size) / 2**20:>12.1f} {pub:>12} {delta:>16}{flag}")
        if local.endswith(".pmtiles"):
            zoom_tables.append((local, tile_sizes(local)))

    for local, by_zoom in zoom_tables:
        print(f"\n-- tile bytes per zoom: {_short(local)} --")
        print(f"{'z':>3} {'tiles':>9} {'p50':>8} {'p95':>8} {'max':>8}")
        for z in sorted(by_zoom):
            c = by_zoom[z]
            print(f"{z:>3} {sum(c.values()):>9} {percentile(c, 0.5):>8} "
                  f"{percentile(c, 0.95):>8} {max(c):>8}")

    print("\n== Repository headroom (publish_data.sh estimate) ==")
    listed = listed_layers()
    if listed is None:
        print("publish set: unknown")
        return over
    files = {p: ROOT / p for p in listed}
    added = sum(p not in files for p in substitutes)
    files.update(substitutes)
    added_kb = new_object_bytes(files.values(), published_shas()) // 1024
    ceiling = size_ceiling_kb()
    print(f"publish set: {len(listed)} listed paths, {len(substitutes) - added} substituted, {added} added")
    print(f"new objects (not on {PUBLISHED_REF}): {added_kb} KB ({added_kb / 2**20:.2f} GB)")
    print(f"ceiling SIZE_CEILING_KB: {ceiling} KB ({ceiling / 2**20:.2f} GB)")
    if current_kb is None:
        print("repo size: unknown — pass --repo-kb N (gh api repos/<slug> --jq .size)")
    else:
        projected = current_kb + added_kb
        verdict = "fits" if projected <= ceiling else "OVER the publish ceiling"
        print(f"repo {current_kb} KB + new {added_kb} KB = {projected} KB ({projected / 2**20:.2f} GB): {verdict}")
    return over


def _short(path):
    p = Path(path).resolve()
    try:
        return str(p.relative_to(ROOT))
    except ValueError:
        return str(path)


def check_paths(inputs, archives, samples=()):
    """One-line reason the first unusable path can't be read, or None."""
    if samples and not shutil.which("tippecanoe-decode"):
        return "tippecanoe-decode is not on PATH (needed by --sample-pmtiles)"
    sample_paths = [parse_sample_arg(a)[0] for a in samples]
    for path in [*inputs, *(parse_archive_arg(a)[0] for a in archives), *sample_paths]:
        if not Path(path).is_file():
            return f"{path}: no such file"
        if str(path).endswith(".gpkg"):
            try:
                con = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
                con.execute("SELECT 1 FROM gpkg_contents LIMIT 1")
                con.close()
            except sqlite3.Error as e:
                return f"{path}: not a GeoPackage ({e})"
    for path in sample_paths:
        if not _is_pmtiles(path):
            return f"{path}: not a PMTiles archive"
    return None


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0].strip())
    ap.add_argument("--input", nargs="+", action="extend", default=[], metavar="PATH",
                    help=".geojsonl / .gpkg / .geojson[.gz] tile input")
    ap.add_argument("--archive", nargs="+", action="extend", default=[], metavar="PATH[=PUBLISHED]",
                    help=f".pmtiles / .geojson.gz archive; PUBLISHED is the path it replaces on "
                         f"{PUBLISHED_REF}. Split at the last '='; an argument that is an existing "
                         f"file is taken whole")
    ap.add_argument("--sample-pmtiles", nargs="+", action="extend", default=[], metavar="PATH[:Z]",
                    help="PMTiles archive whose features tippecanoe-decode writes at zoom Z "
                         "(default: the archive's maxzoom); split at the last ':'")
    ap.add_argument("--repo-kb", type=int, help="current repo size in KB (default: ask gh)")
    a = ap.parse_args(argv)
    if not (a.input or a.archive or a.sample_pmtiles):
        ap.error("give at least one --input, --sample-pmtiles or --archive")
    problem = check_paths(a.input, a.archive, a.sample_pmtiles)
    if problem:
        print(f"region_report: {problem}", file=sys.stderr)
        return 2
    if a.input:
        print_inputs(a.input)
    if a.sample_pmtiles:
        print_samples(a.sample_pmtiles)
    over = 0
    if a.archive:
        over = report_archives(a.archive, a.repo_kb if a.repo_kb is not None else repo_kb())
        print(f"\n{over} archive(s) over the per-file cap.")
    return 1 if over else 0


if __name__ == "__main__":
    sys.exit(main())
