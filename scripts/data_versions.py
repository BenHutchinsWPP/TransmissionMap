#!/usr/bin/env python3
"""data_versions.py — the ?v= table of the data host: src/registry/data-versions.json.

The table maps each fixed-name object's repo path (data/layers/…, data/analysis/…,
data/releases/…) to a token; assets/constants.ts appends ?v=<token> to those URLs, so a
changed object has a new URL. Written by scripts/publish_r2.sh only.

  publish   --files LIST --table PATH [--keep LIST] [--write]
            Rebuilds the table in full from the files in LIST (one repo path per line):
            token = first 10 hex of the file's sha256. Entries for paths in --keep (named
            by the manifests but absent locally, so still in the bucket) are carried over.
            Prints the entries that change; writes PATH only with --write.
  rollback  --files LIST --table PATH --stamp STAMP [--write]
            Gives each restored path in LIST the token r<STAMP> (a URL no edge has seen).

Output is sorted, indent 2, trailing newline. Stdlib only, plus `sha256_file` from geo_common.py.
"""
import argparse
import json
import os
import re
import sys
from pathlib import Path

from geo_common import sha256_file

IMMUTABLE = re.compile(r"\.[0-9a-f]{8}\.parquet$")
STAMP = re.compile(r"^\d{8}T\d{6}Z$")


def token(path: str) -> str:
    return sha256_file(path)[:10]


def read_list(path: str) -> list[str]:
    return [ln for ln in Path(path).read_text(encoding="utf-8").splitlines() if ln]


def load(path: str) -> dict[str, str]:
    p = Path(path)
    return json.loads(p.read_text(encoding="utf-8")) if p.exists() else {}


def render(table: dict[str, str]) -> str:
    return json.dumps(dict(sorted(table.items())), indent=2, ensure_ascii=False) + "\n"


def build_publish(old: dict[str, str], files: list[str], keep: list[str]) -> dict[str, str]:
    new = {f: token(f) for f in files if not IMMUTABLE.search(f)}
    for k in keep:
        if k in old and k not in new:
            new[k] = old[k]
    return new


def build_rollback(old: dict[str, str], files: list[str], stamp: str) -> dict[str, str]:
    new = dict(old)
    for f in files:
        if not IMMUTABLE.search(f):
            new[f] = "r" + stamp
    return new


def report(old: dict[str, str], new: dict[str, str], write: bool, table: str) -> None:
    changed = [k for k in sorted(new) if old.get(k) != new[k]]
    dropped = [k for k in sorted(old) if k not in new]
    for k in changed:
        print(f"  {k}: {old.get(k, '(new)')} -> {new[k]}")
    for k in dropped:
        print(f"  {k}: {old[k]} -> (dropped)")
    print(f"{table}: {len(changed)} changed, {len(dropped)} dropped, {len(new)} entries"
          + ("" if write else " (not written)"))
    if write:
        tmp = Path(table).with_suffix(".tmp")
        tmp.write_text(render(new), encoding="utf-8")
        os.replace(tmp, table)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("mode", choices=["publish", "rollback"])
    ap.add_argument("--files", required=True)
    ap.add_argument("--table", required=True)
    ap.add_argument("--keep")
    ap.add_argument("--stamp")
    ap.add_argument("--write", action="store_true")
    a = ap.parse_args()
    old = load(a.table)
    files = read_list(a.files)
    if a.mode == "publish":
        new = build_publish(old, files, read_list(a.keep) if a.keep else [])
    else:
        if not Path(a.table).exists():
            print(f"ERROR: {a.table} is missing; a rollback updates the committed table, so restore it first.", file=sys.stderr)
            return 2
        if not a.stamp or not STAMP.match(a.stamp):
            print("ERROR: rollback needs --stamp YYYYMMDDTHHMMSSZ.", file=sys.stderr)
            return 2
        new = build_rollback(old, files, a.stamp)
    report(old, new, a.write, a.table)
    return 0


if __name__ == "__main__":
    sys.exit(main())
