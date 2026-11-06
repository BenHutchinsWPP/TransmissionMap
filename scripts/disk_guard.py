#!/usr/bin/env python3
"""Refuse a large write when the target filesystem would drop below a free-space floor.

Role: `require_free(path, need_bytes, floor)` raises SystemExit when free space
on the filesystem holding `path`, less `need_bytes`, would fall under `floor`.
A missing path is checked at its nearest existing parent. CLI:
`disk_guard.py PATH NEED_BYTES [--floor-gib N]` exits 0 when allowed, 1 when refused.
Dependencies: none (stdlib only; runs under `python3 -S`).
"""

import argparse
import os
import shutil
import sys

GIB = 2**30


def _existing_parent(path):
    p = os.path.abspath(path)
    while not os.path.exists(p):
        parent = os.path.dirname(p)
        if parent == p:
            break
        p = parent
    return p


def require_free(path, need_bytes, floor=10 * GIB):
    target = _existing_parent(path)
    free = shutil.disk_usage(target).free
    if free - need_bytes < floor:
        raise SystemExit(
            f"disk_guard: refused for {os.path.abspath(path)} (checked at {target}): "
            f"free {free / GIB:.2f} GiB, need {need_bytes / GIB:.2f} GiB, "
            f"floor {floor / GIB:.2f} GiB"
        )


def main(argv=None):
    ap = argparse.ArgumentParser(description="Check free disk space before a large write.")
    ap.add_argument("path")
    ap.add_argument("need_bytes", type=int)
    ap.add_argument("--floor-gib", type=float, default=10.0)
    args = ap.parse_args(argv)
    try:
        require_free(args.path, args.need_bytes, int(args.floor_gib * GIB))
    except SystemExit as e:
        print(e.code, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
