#!/usr/bin/env python3
"""Builds data/layers/manifest.json — the machine-readable per-layer
provenance manifest the credits page renders from.

Merges hand-written provenance (scripts/data_manifest.yaml: label, source,
url, licence, source_id — some fields the literal string UNKNOWN) with facts
measured off each layer's tile-build input (scripts/tile_manifest.yaml
`src`): a row count, per-field coverage, and the source artifact's retrieval
date — plus the built artifact's size under data/layers/, when one exists.
`source_id` passes through unchanged; it names the src/registry/sources.ts
LAYER_SOURCES key the credits page groups this layer's entry under.

Row counts come from each layer's tile_manifest `src` — the file
ogr2ogr/tippecanoe actually consume — never from the built PMTiles/GeoJSON.
Tippecanoe dedupes, clips, and drops features per zoom, so a count decoded
from tiles is that zoom's surviving feature count, not the dataset's; the
emitted manifest's own `note` field says so for anyone reading the JSON
without this docstring.

Runs cleanly with no data/ present — a fresh dev box, or CI, where the
pipeline has never run. An entry whose `src` artifact is missing gets null
counts rather than failing the build; the script always exits 0.
"""
from __future__ import annotations

import argparse
import csv
import gzip
import json
import math
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterator, Optional

import yaml

REPO_ROOT = Path(__file__).resolve().parent.parent
DATA_MANIFEST = REPO_ROOT / "scripts" / "data_manifest.yaml"
TILE_MANIFEST = REPO_ROOT / "scripts" / "tile_manifest.yaml"
OUT_PATH = REPO_ROOT / "data" / "layers" / "manifest.json"

PROVENANCE_FIELDS = ("label", "source", "url", "licence", "source_id")

MANIFEST_NOTE = (
    "source_rows counts records in each layer's tile-build input "
    "(tile_manifest.yaml `src`) — the same rows ogr2ogr/tippecanoe consume — "
    "not the tiled output. Tippecanoe dedupes, clips, and drops features per "
    "zoom, so a count decoded from PMTiles reflects one zoom's survivors, not "
    "the dataset."
)

# Sentinel values a dataset uses in place of a real value — absent from every
# coverage count, not just a blank or a null.
_ABSENT_STRINGS = {"none", "null", "nan", "na", "n/a"}
_ABSENT_NUMBERS = {-999, -9999}


def is_present(value) -> bool:
    """True when `value` reads as real data for a coverage count.

    Absent: None/NaN, an empty or whitespace-only string, the
    case-insensitive strings none/null/nan/na/n-a (as a whole field, string or
    numeric-as-string), and the numeric sentinels -999/-9999 (as a number or
    as a string that parses to one). Every field this manifest counts is
    judged through this one helper, so a coverage number never counts a
    blank as present.
    """
    if value is None:
        return False
    if isinstance(value, float) and math.isnan(value):
        return False
    if isinstance(value, str):
        s = value.strip()
        if not s:
            return False
        if s.lower() in _ABSENT_STRINGS:
            return False
        try:
            numeric = float(s)
        except ValueError:
            return True
        return numeric not in _ABSENT_NUMBERS
    if isinstance(value, (int, float)):
        return value not in _ABSENT_NUMBERS
    return True


def _iter_csv_rows(path: Path) -> Iterator[dict]:
    with open(path, newline="", encoding="utf-8") as f:
        yield from csv.DictReader(f)


def _iter_geojson_rows(path: Path) -> Iterator[dict]:
    opener = gzip.open if path.name.endswith(".gz") else open
    with opener(path, "rt", encoding="utf-8") as f:
        doc = json.load(f)
    for feature in doc.get("features", []):
        yield feature.get("properties") or {}


def _iter_fiona_rows(path: Path) -> Iterator[dict]:
    import fiona  # already a pipeline dependency (requirements.txt); see geo_common.py

    with fiona.open(path) as src:
        for feature in src:
            yield dict(feature["properties"])


def rows_for_src(path: Path) -> Optional[Iterator[dict]]:
    """Row-property iterator for a tile-manifest `src` artifact.

    None when the extension has no reader that avoids adding a new
    dependency — csv via stdlib, geojson[.gz] via stdlib, gpkg/shp via fiona
    (already pulled in by the extract scripts).
    """
    if path.name.endswith(".geojson.gz") or path.suffix.lower() == ".geojson":
        return _iter_geojson_rows(path)
    if path.suffix.lower() == ".csv":
        return _iter_csv_rows(path)
    if path.suffix.lower() in (".gpkg", ".shp"):
        return _iter_fiona_rows(path)
    return None


def scan_source(
    path: Path, fields: Optional[list[str]]
) -> tuple[Optional[int], Optional[dict[str, int]], bool]:
    """Row count + per-field coverage for one `src` artifact.

    Returns (source_rows, coverage, supported). `coverage` is None when
    `fields` is falsy (no `select:` to count). `supported` is False only when
    `rows_for_src` has no reader for this extension — the caller nulls the
    entry instead of guessing.
    """
    rows = rows_for_src(path)
    if rows is None:
        return None, None, False
    counts = {f: 0 for f in (fields or [])}
    n = 0
    for row in rows:
        n += 1
        for f in counts:
            if is_present(row.get(f)):
                counts[f] += 1
    return n, (counts if fields else None), True


def built_artifact_bytes(layer_id: str, tile_format: str, repo_root: Path) -> Optional[int]:
    """Size of the built data/layers/ artifact for this id, or None if absent."""
    ext = "pmtiles" if tile_format == "pmtiles" else "geojson.gz"
    built = repo_root / "data" / "layers" / f"{layer_id}.{ext}"
    return built.stat().st_size if built.exists() else None


def build_layer_entry(tile_entry: dict, provenance: dict, repo_root: Path) -> tuple[dict, str]:
    """One `layers` value for the output manifest, plus a status tag
    ("ok" | "missing" | "unsupported:<ext>") for the run summary."""
    entry: dict = {f: provenance.get(f, "UNKNOWN") for f in PROVENANCE_FIELDS}
    has_select = "select" in tile_entry
    src_path = repo_root / tile_entry["src"]

    def _null_facts(status: str) -> tuple[dict, str]:
        entry["source_rows"] = None
        if has_select:
            entry["coverage"] = None
        entry["retrieved"] = None
        entry["bytes"] = None
        return entry, status

    if not src_path.exists():
        return _null_facts("missing")

    n, coverage, supported = scan_source(src_path, tile_entry.get("select"))
    if not supported:
        return _null_facts(f"unsupported:{src_path.suffix}")

    entry["source_rows"] = n
    if has_select:
        entry["coverage"] = coverage
    mtime = src_path.stat().st_mtime
    entry["retrieved"] = datetime.fromtimestamp(mtime, tz=timezone.utc).date().isoformat()
    entry["bytes"] = built_artifact_bytes(tile_entry["id"], tile_entry.get("format", ""), repo_root)
    return entry, "ok"


def load_yaml(path: Path) -> dict:
    with open(path) as f:
        return yaml.safe_load(f) or {}


def build_manifest(
    data_manifest_path: Path, tile_manifest_path: Path, repo_root: Path
) -> tuple[dict, dict[str, int]]:
    """Returns (manifest_dict, status_counts) — status_counts keys "ok",
    "missing", "unsupported"."""
    provenance_by_id = load_yaml(data_manifest_path).get("layers") or {}
    tile_layers = load_yaml(tile_manifest_path).get("layers") or []

    layers_out: dict[str, dict] = {}
    summary = {"ok": 0, "missing": 0, "unsupported": 0}
    for tile_entry in tile_layers:
        layer_id = tile_entry["id"]
        entry, status = build_layer_entry(
            tile_entry, provenance_by_id.get(layer_id) or {}, repo_root
        )
        layers_out[layer_id] = entry
        summary["ok" if status == "ok" else "missing" if status == "missing" else "unsupported"] += 1

    manifest = {
        "generated_utc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "note": MANIFEST_NOTE,
        "layers": layers_out,
    }
    return manifest, summary


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Build data/layers/manifest.json: hand-written provenance from "
            "scripts/data_manifest.yaml merged with row/coverage/retrieval "
            "facts measured off each layer's scripts/tile_manifest.yaml "
            "`src` artifact. Safe to run with no data/ present — missing "
            "artifacts get null facts, not a build failure."
        )
    )
    parser.add_argument(
        "--data-manifest", type=Path, default=DATA_MANIFEST,
        help="hand-written provenance YAML (default: %(default)s)",
    )
    parser.add_argument(
        "--tile-manifest", type=Path, default=TILE_MANIFEST,
        help="tile-build manifest YAML (default: %(default)s)",
    )
    parser.add_argument(
        "--repo-root", type=Path, default=REPO_ROOT,
        help="base directory `src`/output paths resolve against (default: %(default)s)",
    )
    parser.add_argument(
        "--out", type=Path, default=OUT_PATH,
        help="output path for the generated manifest (default: %(default)s)",
    )
    args = parser.parse_args(argv)

    manifest, summary = build_manifest(args.data_manifest, args.tile_manifest, args.repo_root)

    args.out.parent.mkdir(parents=True, exist_ok=True)
    with open(args.out, "w") as f:
        json.dump(manifest, f, indent=2)
        f.write("\n")

    total = sum(summary.values())
    null_count = summary["missing"] + summary["unsupported"]
    print(
        f"data manifest: {summary['ok']}/{total} layers with real counts, "
        f"{null_count} null ({summary['missing']} missing src artifact, "
        f"{summary['unsupported']} unsupported src format) -> {args.out}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
