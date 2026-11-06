#!/usr/bin/env python3
"""toolchain.py — the tippecanoe the tile builds need, checked by version.

tippecanoe 2.55.0 is the floor: from that release on, every feature keeps its
own attribute strings through the tile build (upstream #239), which the
attribute gate (`stable_ids.py --attrs`) holds the archives to. Every build
calls `tippecanoe` by name, so the copy first on PATH is the one checked here
and the one that runs.

Stdlib only. `make check` runs it; build_tiles.py, build_global_tiles.py and
process_continental_osm.py call `require_tippecanoe()` before they tile.

Usage:
  python3 scripts/toolchain.py      # prints the version found; exit 1 below the floor
"""
import re
import shutil
import subprocess
import sys

MIN_TIPPECANOE = (2, 55, 0)

VERSION_RE = re.compile(r"tippecanoe v?(\d+)\.(\d+)\.(\d+)")


def parse_version(text):
    """`tippecanoe v2.79.0` → (2, 79, 0); None when the text names no version."""
    m = VERSION_RE.search(text or "")
    return tuple(int(g) for g in m.groups()) if m else None


def tippecanoe_version():
    """(path, version) of the tippecanoe on PATH; (None, None) when there is none."""
    path = shutil.which("tippecanoe")
    if not path:
        return None, None
    proc = subprocess.run([path, "--version"], capture_output=True, text=True)
    return path, parse_version(proc.stdout + proc.stderr)


def tippecanoe_problem():
    """Why the tippecanoe on PATH cannot build the tiles, or None when it can."""
    path, version = tippecanoe_version()
    floor = ".".join(map(str, MIN_TIPPECANOE))
    if not path:
        return f"tippecanoe not found on PATH (need ≥ {floor})"
    if version is None:
        return f"{path}: could not read a version from `tippecanoe --version` (need ≥ {floor})"
    if version < MIN_TIPPECANOE:
        return f"{path} is v{'.'.join(map(str, version))}; the tile builds need ≥ {floor}"
    return None


def require_tippecanoe():
    if problem := tippecanoe_problem():
        sys.exit(f"ERROR: {problem}. See docs/pipeline.md prerequisites.")


def main():
    path, version = tippecanoe_version()
    if problem := tippecanoe_problem():
        print(f"  ✗ {problem}")
        return 1
    print(f"  ✓ tippecanoe v{'.'.join(map(str, version))} ({path}; ≥ "
          f"{'.'.join(map(str, MIN_TIPPECANOE))})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
