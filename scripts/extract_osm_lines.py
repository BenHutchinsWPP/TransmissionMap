#!/usr/bin/env python3
"""
extract_osm_lines.py — OSM PBF → Shapefile (power lines + pipelines).

Uses osmium tags-filter + ogr2ogr (both required). Writes intermediate
shapefiles to the build directory for later enrichment by enrich_osm_tags.py.

osmium-tool and gdal-bin are required (documented prerequisites, 20-50x faster
than a pure-Python parse, hence no fallback path).
"""

import argparse
import glob
import json
import logging
import os
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path

import yaml

from osm_common import SHARED_FILTER_TAGS

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-8s  %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("extract_osm_lines")


def _require_tools():
    missing = [t for t in ("osmium", "ogr2ogr") if shutil.which(t) is None]
    if missing:
        sys.stderr.write(
            "ERROR: required tool(s) missing: %s\n"
            "Install osmium-tool and gdal-bin (see `make install` / README).\n"
            % ", ".join(missing)
        )
        sys.exit(1)


def load_settings(path="settings.yaml"):
    with open(path) as f:
        return yaml.safe_load(f)


def find_pbf_files(input_dir):
    """Return input .osm.pbf files, preferring *_filtered.osm.pbf intermediates."""
    all_pbf = sorted(glob.glob(os.path.join(input_dir, "*.osm.pbf")))
    filtered = [
        f for f in all_pbf
        if re.search(r"_filtered(?!.*_filtered)", os.path.basename(f))
    ]
    if filtered:
        return filtered
    originals = [f for f in all_pbf if "_filtered" not in os.path.basename(f)]
    return originals if originals else all_pbf


# OSM tag key → OGR layer mapping for feature extraction
_OGR_TAG_LAYERS = {
    "power": {
        "line": ["lines"], "cable": ["lines"], "minor_line": ["lines"],
        "tower": ["points"], "pole": ["points"],
        "substation": ["points", "multipolygons"],
        "plant": ["points", "multipolygons"],
        "generator": ["points"],
        "transformer": ["points"], "switch": ["points"],
        "compensator": ["points"], "converter": ["points"],
        "insulator": ["points"], "terminal": ["points"],
        "catenary": ["points", "lines"],
    },
    "man_made": {
        "__default__": ["points"],
        "pipeline": ["points", "lines"],
        "petroleum_well": ["points"],
        "pumping_station": ["points"],
        "reservoir": ["points", "multipolygons"],
        "wastewater_plant": ["points"],
        "water_treatment_plant": ["points"],
        "water_tower": ["points"],
        "water_well": ["points"],
        "mast": ["points"],
    },
    "pipeline": {
        "__default__": ["lines"],
        "valve": ["points"], "substation": ["points"], "casing": ["points"],
    },
    "telecom": {"exchange": ["points"], "cable": ["lines"]},
}


def _guess_layers(key, values):
    if key in _OGR_TAG_LAYERS:
        for v in values:
            if v in _OGR_TAG_LAYERS[key]:
                return _OGR_TAG_LAYERS[key][v]
        if "__default__" in _OGR_TAG_LAYERS[key]:
            return _OGR_TAG_LAYERS[key]["__default__"]
    return ["points", "lines"]


def _run(cmd, desc=""):
    log.debug("  $ %s", " ".join(str(c) for c in cmd))
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        log.error("%s failed: %s", desc or cmd[0], r.stderr[:500])
        return False
    return True


# OGR's OSM driver promotes these tag keys to direct columns instead of other_tags.
_OGR_DIRECT_COLS = frozenset({
    "name", "ref", "address", "is_in", "place",
    "man_made", "highway", "waterway", "aerialway", "barrier", "railway",
})

# Extra WHERE conditions per feature to prevent cross-contamination between
# extractions whose tag filters would otherwise overlap.
_EXTRA_WHERE = {
    "pipeline_feature": "(man_made IS NULL OR man_made = '' OR man_made != 'pipeline')",
}


def _ogr_where_clause(key, vals):
    def esc(v):
        return v.replace("'", "\\'").replace('"', '\\"')

    def _ot(k, v):
        if v is None:
            return f"other_tags LIKE '%\"{esc(k)}\"=>\"%\"%'"
        return f"other_tags LIKE '%\"{esc(k)}\"=>\"{esc(v)}\"%'"

    def _dc(k, v):
        if v is None:
            return f"({k} IS NOT NULL AND {k} != '')"
        return f"{k} = '{esc(v)}'"

    direct = key in _OGR_DIRECT_COLS
    if vals is None:
        return f"({_dc(key, None)} OR {_ot(key, None)})" if direct else _ot(key, None)
    if isinstance(vals, list):
        if direct:
            parts = [f"({_dc(key, v)} OR {_ot(key, v)})" for v in vals]
        else:
            parts = [_ot(key, v) for v in vals]
        return " OR ".join(parts)
    return f"({_dc(key, vals)} OR {_ot(key, vals)})" if direct else _ot(key, vals)


# ---------------------------------------------------------------------------
# Polygon centroid export — used for substation/plant relation multipolygons
# ---------------------------------------------------------------------------
from shapely.geometry import Point, mapping  # noqa: E402
from shapely import wkb  # noqa: E402
import numpy as np  # noqa: E402

try:
    import pyogrio.raw
    _PYOGRIO = True
except ImportError:
    import fiona
    from fiona.crs import CRS as _CRS
    _PYOGRIO = False


def _export_centroids(geojsonseq_path, out_shp, batch_size=5000,
                      keep_fields=None, tag_filter=None):
    """Stream-parse osmium-exported polygons and write centroids as a point SHP."""
    if not geojsonseq_path.exists() or geojsonseq_path.stat().st_size == 0:
        log.warning("  Empty or missing %s", geojsonseq_path)
        return

    def _matches_tag_filter(props):
        if not tag_filter:
            return True
        for key, vals in tag_filter.items():
            pv = props.get(key)
            if pv is None:
                continue
            if vals is None:
                return True
            if isinstance(vals, list):
                if pv in vals:
                    return True
            elif pv == vals:
                return True
        return False

    log.info("    Scanning property keys...")
    all_keys = set()
    total_features = 0
    with open(geojsonseq_path) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                feat = json.loads(line)
            except json.JSONDecodeError:
                continue
            props = feat.get("properties", {}) or {}
            if not _matches_tag_filter(props):
                continue
            all_keys.update(props.keys())
            total_features += 1

    if total_features == 0:
        log.warning("  No features in %s", geojsonseq_path)
        return

    all_keys.discard("id")
    if keep_fields is not None:
        all_keys = {k for k in all_keys if k in keep_fields}
    all_keys = sorted(all_keys)
    preferred = ["name", "operator", "voltage", "substation", "ref", "power"]
    fields = [k for k in preferred if k in all_keys] + \
             [k for k in all_keys if k not in preferred]
    fd_map = {k: k[:10] for k in fields}
    field_names = [fd_map[k] for k in fields] + ["nominal_kv"]

    if out_shp.exists():
        for ext in (".shp", ".shx", ".dbf", ".prj", ".cpg"):
            p = out_shp.with_suffix(ext)
            if p.exists():
                p.unlink()

    if _PYOGRIO:
        rows = []
        _pyogrio_first = True

        def _write_batch():
            nonlocal _pyogrio_first
            if not rows:
                return
            geoms_b = np.array([wkb.dumps(pt) for pt, _ in rows], dtype=object)
            field_data = [
                np.array(
                    [vals[name] for _, vals in rows],
                    dtype=np.int64 if name == "nominal_kv" else object,
                )
                for name in field_names
            ]
            pyogrio.raw.write(
                str(out_shp),
                geometry=geoms_b,
                field_data=field_data,
                fields=field_names,
                geometry_type="Point",
                crs="EPSG:4326",
                append=not _pyogrio_first,
            )
            _pyogrio_first = False
            rows.clear()
    else:
        dst_fiona = None
        schema = {
            "geometry": "Point",
            "properties": {
                name: "int" if name == "nominal_kv" else "str"
                for name in field_names
            },
        }

        def _write_batch():
            nonlocal dst_fiona
            if not rows:
                return
            if dst_fiona is None:
                dst_fiona = fiona.open(
                    str(out_shp), "w", driver="ESRI Shapefile",
                    schema=schema, crs=_CRS.from_epsg(4326),
                )
            for pt, vals in rows:
                dst_fiona.write({"geometry": mapping(pt), "properties": vals})
            rows.clear()

    log.info("    Extracting centroids from %d features...", total_features)
    rows = []
    centroid_count = 0
    with open(geojsonseq_path) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                feat = json.loads(line)
            except json.JSONDecodeError:
                continue
            props = feat.get("properties", {}) or {}
            if not _matches_tag_filter(props):
                continue
            geom = feat.get("geometry", {})
            if not geom or geom.get("type") not in ("MultiPolygon", "Polygon"):
                continue
            ring = (
                geom["coordinates"][0][0] if geom["type"] == "MultiPolygon"
                else geom["coordinates"][0]
            )
            if not ring:
                continue
            lons = [c[0] for c in ring]
            lats = [c[1] for c in ring]
            clon = sum(lons) / len(lons)
            clat = sum(lats) / len(lats)
            vals = {fd_map[k]: str(props.get(k, "") or "") for k in fields}
            v_str = str(props.get("voltage", ""))
            if v_str and v_str != "None":
                nums = [int(v) for v in re.findall(r"\d+", v_str) if v.isdigit()]
                kv = max(nums) // 1000 if nums else -1
            else:
                kv = -1
            vals["nominal_kv"] = int(kv)
            rows.append((Point(clon, clat), vals))
            centroid_count += 1
            if len(rows) >= batch_size:
                _write_batch()

    if not rows:
        log.warning("  No valid multipolygon centroids in %s", geojsonseq_path)
        return
    _write_batch()
    if not _PYOGRIO and dst_fiona is not None:
        dst_fiona.close()
    log.info("    -> %d points from %d features", centroid_count, total_features)


def fast_convert(pbf_files, settings, enabled_features, output_dir, all_na=False):
    """osmium tags-filter → osmium extract → ogr2ogr per feature."""
    tag_map = settings.get("tag_map", {})
    bb = settings.get("bounding_box", {})

    for pbf_path in pbf_files:
        pbf_path = Path(pbf_path)
        stem = pbf_path.stem
        log.info("=== %s ===", stem)

        os_filters = []
        for feat in enabled_features:
            rules = tag_map.get(feat, {})
            for key, vals in rules.items():
                if vals is None:
                    os_filters.append(f"{key}=*")
                elif isinstance(vals, list):
                    for v in vals:
                        os_filters.append(f"{key}={v}")
                else:
                    os_filters.append(f"{key}={vals}")
        if not os_filters:
            log.warning("  No filters for %s, skipping", stem)
            continue
        # Union in the tags the other extract scripts need, so this single
        # tags-filter pass produces an intermediate they can all reuse
        # (see SHARED_FILTER_TAGS / find_pbf in osm_common.py).
        os_filters = sorted(set(os_filters) | set(SHARED_FILTER_TAGS))

        if stem.endswith("_filtered"):
            work_pbf = pbf_path
            filtered = pbf_path
            log.info("  Input is already filtered, skipping tags-filter")
        else:
            filtered = Path(output_dir) / f"{stem}_filtered.osm.pbf"
            sidecar = Path(str(filtered) + ".filters")
            # Reuse only if fresh AND built with the same tag set — a stale
            # sidecar means the filtered pbf is missing tags someone added.
            if (filtered.exists()
                    and filtered.stat().st_mtime >= pbf_path.stat().st_mtime
                    and sidecar.exists()
                    and sorted(sidecar.read_text().split()) == os_filters):
                log.info("  Filtered file exists (%s), skipping tags-filter", filtered.name)
            else:
                cmd = ["osmium", "tags-filter", str(pbf_path)] + os_filters \
                    + ["-o", str(filtered), "--overwrite"]
                log.info("  osmium tags-filter (%d patterns) ...", len(os_filters))
                if not _run(cmd, "osmium tags-filter"):
                    log.error("  osmium tags-filter failed for %s", stem)
                    sys.exit(1)
                sidecar.write_text("\n".join(os_filters) + "\n")
            work_pbf = filtered

        if not all_na and bb and bb.get("min_lon") is not None:
            clipped = Path(output_dir) / f"_{stem}_clipped.osm.pbf"
            bbox = f"{bb['min_lon']},{bb['min_lat']},{bb['max_lon']},{bb['max_lat']}"
            cmd = ["osmium", "extract", "-b", bbox, str(filtered),
                   "-o", str(clipped), "--overwrite"]
            log.info("  osmium extract (bbox) ...")
            if _run(cmd, "osmium extract"):
                filtered.unlink(missing_ok=True)
                work_pbf = clipped
            else:
                log.info("  Clip skipped, using filtered file")

        polygon_features = ["power_substation"]
        for feat in enabled_features:
            rules = tag_map.get(feat, {})
            for key, vals in rules.items():
                vals_list = [vals] if not isinstance(vals, list) else vals
                layers = _guess_layers(key, vals_list)
                if "multipolygons" in layers and feat not in polygon_features:
                    polygon_features.append(feat)

        # Limit DBF schema width — full OSM property set blows past shapefile limits.
        _polygon_keep_fields = {
            "power_substation": {"name", "voltage", "substation", "operator", "ref"},
        }

        for feat in polygon_features:
            if feat not in enabled_features:
                continue
            log.info("  osmium export (%s) ...", feat)
            out_geojsonseq = Path(output_dir) / f"_{feat}_exported.geojsonseq"
            cmd = [
                "osmium", "export", "-f", "geojsonseq",
                str(work_pbf),
                "--geometry-types=polygon,multipolygon",
                "-o", str(out_geojsonseq),
                "--overwrite",
            ]
            if not _run(cmd, f"osmium export {feat}"):
                log.warning("  osmium export failed for %s, using ogr2ogr only", feat)
                continue
            out_point_shp = Path(output_dir) / f"{feat}_poly_centroids.shp"
            _export_centroids(
                out_geojsonseq, out_point_shp,
                settings.get("batch_size", 5000),
                keep_fields=_polygon_keep_fields.get(feat),
                tag_filter=tag_map.get(feat),
            )
            out_geojsonseq.unlink(missing_ok=True)

        for feat in enabled_features:
            rules = tag_map.get(feat, {})
            if not rules:
                log.warning("  No tag_map for '%s', skipping", feat)
                continue
            safe = feat.replace(" ", "_").replace("-", "_")
            for key, vals in rules.items():
                vals_list = [vals] if not isinstance(vals, list) else vals
                if vals is None:
                    where = _ogr_where_clause(key, None)
                    layers = ["points", "lines"]
                else:
                    where = _ogr_where_clause(key, vals_list)
                    layers = _guess_layers(key, vals_list)
                extra = _EXTRA_WHERE.get(feat)
                sql_where = f"({where}) AND {extra}" if extra else where
                for layer in layers:
                    out = Path(output_dir) / f"{safe}_{layer}.shp"
                    local_osmconf = Path(__file__).parent.parent / "osmconf.ini"
                    osmconf_args = (
                        ["--config", "OSM_CONFIG_FILE", str(local_osmconf)]
                        if local_osmconf.exists() else []
                    )
                    cmd = [
                        "ogr2ogr", "-f", "ESRI Shapefile",
                        "-lco", "ENCODING=UTF-8", "-overwrite",
                        *osmconf_args,
                        str(out), str(work_pbf), layer,
                        "-sql", f'SELECT * FROM "{layer}" WHERE {sql_where}',
                    ]
                    _run(cmd, f"ogr2ogr {safe}/{layer}")

        if work_pbf != filtered:
            work_pbf.unlink(missing_ok=True)
        log.info("  Done: %s", stem)


def main(settings_path="settings.yaml", input_dir=None, output_dir=None,
         features=None, all_na=False):
    _require_tools()
    d = Path(__file__).resolve().parent.parent
    os.chdir(d)
    sp = Path(settings_path)
    if not sp.exists():
        log.error("settings not found: %s", sp)
        sys.exit(1)
    s = load_settings(str(sp))
    tm = s.get("tag_map", {})
    if input_dir is None:
        input_dir = s.get("input_dir", "data/raw/osm")
    if output_dir is None:
        output_dir = s.get("output_dir", "data/build")
    enabled = features or s.get("features", list(tm.keys()))

    log.info("OSM → SHP extraction")
    log.info("  Input:   %s", input_dir)
    log.info("  Output:  %s", output_dir)

    pbfs = find_pbf_files(input_dir)
    if not pbfs:
        log.error("No .osm.pbf files in %s", input_dir)
        sys.exit(1)
    log.info("  Files:   %d", len(pbfs))
    for f in pbfs:
        log.info("    %s  (%.1f GB)", Path(f).name, os.path.getsize(f) / 1e9)

    Path(output_dir).mkdir(parents=True, exist_ok=True)
    t0 = time.time()
    fast_convert(pbfs, s, enabled, output_dir, all_na=all_na)
    log.info("")
    log.info("Output (%d files):", len(list(Path(output_dir).glob("*.shp"))))
    for f in sorted(Path(output_dir).glob("*.shp")):
        log.info("  %s  (%.0f KB)", f.name, f.stat().st_size / 1024)
    log.info("Done  [%.1f s]", time.time() - t0)


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="OSM PBF → Shapefiles (FAST mode only)")
    ap.add_argument("--settings", "-s", default="settings.yaml")
    ap.add_argument("--input-dir", "-i")
    ap.add_argument("--output-dir", "-o")
    ap.add_argument("--verbose", "-v", action="store_true")
    ap.add_argument("--debug", "-d", action="store_true")
    ap.add_argument("--features", "-f", nargs="*",
                    help="e.g. -f power_line pipeline")
    ap.add_argument("--all-na", action="store_true",
                    help="Skip bbox clip — export entire input.")
    a = ap.parse_args()
    if a.debug:
        log.setLevel(logging.DEBUG)
    main(settings_path=a.settings, input_dir=a.input_dir,
         output_dir=a.output_dir, features=a.features, all_na=a.all_na)
