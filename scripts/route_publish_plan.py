#!/usr/bin/env python3
"""The route data set `publish_r2.sh --only route` uploads: selection, ROUTE_ID, key map.

Run from the repo root (publish_r2.sh does). Read-only.

  route_publish_plan.py --pinned               print ROUTE_ID pinned in assets/constants.ts (nothing if none)
  route_publish_plan.py --print-id             print the computed ROUTE_ID
  route_publish_plan.py --out DIR [--verify-sha] [--no-final]
                                               write the upload sets to DIR, print the plan

DIR gets sets.tsv (phase, name, src_root, dest_rel, listfile, content type; dest_rel is relative to the
bucket root) plus one list file per set (names relative to src_root) and stage/LICENSE.txt.
Exit 1 on any refusal (stray file, missing file, size or sha mismatch). A ROUTE_ID that
differs from constants.ts is reported in the plan's last lines and by `status` in
id.txt (`id|pinned|status`, status "ok", "mismatch" or "unpinned"); the caller decides.

The screening generation is aviation only: a pointer with any other family is refused.

ROUTE_ID = first 12 hex of sha256 over grid.json, the uploaded screening pointer, then the sorted
"<key>\\t<size>\\n" of every selected file (keys relative to data/route/<ROUTE_ID>/).
"""
import hashlib
import json
import os
import re
import shutil
import sys
from pathlib import Path

CUBE = Path("data/route/250m")
REPORT = Path("data/route/report")
CONSTRAINTS = Path("data/route/constraints")
LICENCE_SRC = Path("scripts/route_data_LICENSE.txt")
CONSTANTS = Path("assets/constants.ts")
REPORT_READ = Path("assets/route/report-read.ts")
CONCERNS = Path("scripts/route_constraints.json")
CONSTRAINTS_SKIPPED_OK = {"manifest.json"}  # listed, never uploaded


def report_files():
    """The parquets assets/route/report-read.ts reads (its FILES table)."""
    src = REPORT_READ.read_text(encoding="utf-8")
    i = src.index("const FILES")
    blk = src[i:src.index("];", i)]
    return re.findall(r"file:\s*'([^']+)'", blk)


def pinned_id():
    if not CONSTANTS.is_file():
        return None
    m = re.search(r"""\bROUTE_ID\s*(?::\s*string\s*)?=\s*["']([0-9a-f]{12})["']""",
                  CONSTANTS.read_text(encoding="utf-8"))
    return m.group(1) if m else None


def listdir(d):
    return sorted(p.name for p in d.iterdir()) if d.is_dir() else []


def sha256(p):
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for b in iter(lambda: f.read(1 << 20), b""):
            h.update(b)
    return h.hexdigest()


def build(verify_sha=False):
    """→ (entries, skipped, problems, grid, pointer_bytes). An entry is a dict: key (relative to the route
    prefix), src (real path), root, name (relative to root), size, family, final."""
    problems, skipped, entries = [], [], []

    def add(family, key, root, name, final=False):
        p = root / name
        if not p.is_file():
            problems.append(f"missing: {p}")
            return None
        e = dict(family=family, key=key, root=root, name=name, size=p.stat().st_size, final=final)
        entries.append(e)
        return e

    # cube: grid.json patterns
    try:
        grid = json.loads((CUBE / "grid.json").read_text(encoding="utf-8"))
        want = {"grid.json"}
        for fk in ("pd_files", "osm_files"):
            pat = grid[fk]["pattern"]
            for c, r in grid["super_tiles_present"]:
                want.add(pat.format(col=c, row=r))
    except (OSError, KeyError, ValueError) as ex:
        problems.append(f"{CUBE}/grid.json unreadable or incomplete: {ex!r}")
        grid, want = None, set()
    try:
        gtext = (CUBE / "grid.json").read_text(encoding="utf-8")
        if re.search(r"/mnt/|/home/", gtext):
            problems.append(f"{CUBE}/grid.json holds a local path (/mnt/ or /home/)")
    except OSError:
        pass
    have = set(listdir(CUBE))
    for n in sorted(have - want):
        problems.append(f"unexpected file in {CUBE}: {n}")
    for n in sorted(want):
        add("cube", "250m/" + n, CUBE, n, final=(n == "grid.json"))

    # report: the parquets the app reads
    try:
        names = report_files()
        if not names:
            raise ValueError("no FILES found")
    except (OSError, ValueError) as ex:
        problems.append(f"{REPORT_READ} FILES unreadable: {ex!r}")
        names = []
    for f in names:
        add("report", f"report/{f}.parquet", REPORT, f"{f}.parquet")
    rep_have = set(listdir(REPORT)) - {"screening"} - {f"{f}.parquet" for f in names}
    skipped += [f"{REPORT}/{n}" for n in sorted(rep_have)]

    # constraints: one archive per concern
    try:
        ids = [c["id"] for c in json.loads(CONCERNS.read_text(encoding="utf-8"))["concerns"]]
    except (OSError, KeyError, ValueError) as ex:
        problems.append(f"{CONCERNS} unreadable: {ex!r}")
        ids = []
    cwant = {f"{i}.pmtiles" for i in ids}
    for n in sorted(set(listdir(CONSTRAINTS)) - cwant):
        if n in CONSTRAINTS_SKIPPED_OK:
            skipped.append(f"{CONSTRAINTS}/{n}")
        else:
            problems.append(f"unexpected file in {CONSTRAINTS}: {n}")
    for n in sorted(cwant):
        add("constraints", f"constraints/{n}", CONSTRAINTS, n)

    # screening: the pointer's generation, through the symlink, by real path
    S = REPORT / "screening"
    pointer_bytes = b""
    try:
        R = Path(os.path.realpath(S))
        pointer_bytes = (R / "manifest.json").read_bytes()
        ptr = json.loads(pointer_bytes)
        gen = ptr["generation"]
        if not re.fullmatch(r"[0-9a-f]+", gen):
            raise ValueError(f"generation {gen!r}")
        if "buildings" in ptr:
            raise ValueError("the screening pointer names building files; rebuild it aviation only (make route-screening)")
        hosted = {ptr["aviation"]["file"], "generation.json"}
        for n in sorted(hosted):
            if "/" in n or "\\" in n or ".." in n or not n:
                raise ValueError(f"pointer file name {n!r}")
        G = R / gen
        ghave = set(listdir(G))
        for n in sorted(ghave - hosted):
            problems.append(f"unexpected file in screening generation {gen}: {n}")
        for n in sorted(hosted):
            add("screening", f"report/screening/{gen}/{n}", G, n)
        av_sha = ptr["aviation"].get("sha256")
        av = G / ptr["aviation"]["file"]
        if verify_sha and av_sha and av.is_file() and sha256(av) != av_sha:
            problems.append(f"sha256 differs from manifest: {av.name}")
        e = add("pointer", "report/screening/manifest.json", R, "manifest.json", final=True)
        if e:
            e["size"] = len(pointer_bytes)
        skipped += [f"{R}/{n}" for n in listdir(R) if n not in ("manifest.json", gen)]
    except (OSError, KeyError, ValueError, TypeError) as ex:
        problems.append(f"screening pointer unreadable or incomplete: {ex!r}")

    # licence notice
    add("licence", "LICENSE.txt", LICENCE_SRC.parent, LICENCE_SRC.name, final=True)
    return entries, skipped, problems, grid, pointer_bytes


def route_id(entries, grid_bytes, pointer_bytes):
    h = hashlib.sha256()
    h.update(grid_bytes)
    h.update(pointer_bytes)
    for e in sorted(entries, key=lambda e: e["key"]):
        h.update(f"{e['key']}\t{e['size']}\n".encode())
    return h.hexdigest()[:12]


def main(argv):
    if "--pinned" in argv:
        p = pinned_id()
        if p:
            print(p)
        return 0
    verify = "--verify-sha" in argv
    no_final = "--no-final" in argv
    out = Path(argv[argv.index("--out") + 1]) if "--out" in argv else None
    entries, skipped, problems, grid, pointer_bytes = build(verify)
    if problems:
        for p in problems:
            print("ERROR:", p, file=sys.stderr)
        print(f"ERROR: {len(problems)} problem(s); nothing planned.", file=sys.stderr)
        return 1
    rid = route_id(entries, (CUBE / "grid.json").read_bytes(), pointer_bytes)
    if "--print-id" in argv:
        print(rid)
        return 0
    if out is None:
        print("ERROR: --out DIR required", file=sys.stderr)
        return 2

    pinned = pinned_id()
    status = "unpinned" if pinned is None else ("ok" if pinned == rid else "mismatch")
    prefix = f"data/route/{rid}"
    out.mkdir(parents=True, exist_ok=True)
    stage = out / "stage"
    stage.mkdir(exist_ok=True)
    for e in entries:
        if e["family"] == "licence":
            shutil.copyfile(e["root"] / e["name"], stage / "LICENSE.txt")
            e["root"], e["name"] = stage, "LICENSE.txt"
        elif e["family"] == "pointer":
            (stage / "manifest.json").write_bytes(pointer_bytes)
            e["root"], e["name"] = stage, "manifest.json"

    # a set = (phase, src root, dest dir): files of one family share a root and a dest dir
    sets = {}
    for e in entries:
        if e["final"] and no_final:
            continue
        dest_dir = prefix + "/" + (e["key"].rsplit("/", 1)[0] if "/" in e["key"] else "")
        dest_dir = dest_dir.rstrip("/")
        phase = "2-final" if e["final"] else "1-bulk"
        sets.setdefault((phase, str(e["root"]), dest_dir), []).append(e)

    def order(item):  # bulk first; in the final group the screening pointer, the notice, then grid.json
        (phase, root, dest), es = item
        rank = 2 if any(e["key"] == "250m/grid.json" for e in es) else 1 if any(e["family"] == "licence" for e in es) else 0
        return (phase, rank, root, dest)

    rows = []
    for i, ((phase, root, dest), es) in enumerate(sorted(sets.items(), key=order), 1):
        lf = out / f"set-{i}.list"
        lf.write_text("".join(e["name"] + "\n" for e in sorted(es, key=lambda e: e["name"])), encoding="utf-8")
        ctype = "text/plain; charset=utf-8" if es[0]["family"] == "licence" else "application/octet-stream"
        rows.append("\t".join([phase, f"set-{i}", root, dest, str(lf), ctype]))
    (out / "sets.tsv").write_text("\n".join(rows) + "\n", encoding="utf-8")
    (out / "id.txt").write_text(f"{rid}|{pinned or ''}|{status}\n", encoding="utf-8")
    (out / "keys.txt").write_text(
        "".join(f"{prefix}/{e['key']}\t{e['size']}\t{'final' if e['final'] else 'bulk'}\n"
                for e in sorted(entries, key=lambda e: e["key"]) if not (e["final"] and no_final)),
        encoding="utf-8")

    GiB = 1 << 30
    fam = {}
    for e in entries:
        f = fam.setdefault(e["family"], [0, 0])
        f[0] += 1
        f[1] += e["size"]
    print(f"Route set under {prefix}/ (immutable)")
    for name in ("cube", "report", "constraints", "screening", "pointer", "licence"):
        n, b = fam.get(name, (0, 0))
        print(f"  {name:12s} {n:3d} files  {b:>16,d} bytes")
    tot = sum(e["size"] for e in entries)
    print(f"  total        {len(entries):3d} files  {tot:>16,d} bytes ({tot / GiB:.2f} GiB)")
    print("Final group (uploaded last, left out by --no-final):")
    for e in entries:
        if e["final"]:
            print(f"  {prefix}/{e['key']}  {e['size']}")
    print(f"Skipped, never uploaded ({len(skipped)}):")
    for s in skipped:
        print(f"  {s}")
    print(f"ROUTE_ID computed: {rid}")
    print(f"ROUTE_ID pinned in {CONSTANTS}: {pinned or '(none)'}  [{status}]")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
