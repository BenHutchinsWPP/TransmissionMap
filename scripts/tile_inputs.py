"""tile_inputs.py — the rows tippecanoe read for a layer, as the build reads them.

Shared by stable_ids.py (--attrs) and the columns builder. Imports stdlib only;
build_global_tiles, build_tiles and the geo libraries load inside the functions.

A world layer reads its kept file, data/build/world/<base>.geojsonl.gz
(build_global_tiles.kept_path; transmission: TRANSMISSION_KEPT): the merged,
deduped, region-tagged input, exactly what tippecanoe read, so the rows carry
the region fields too. Without it (a build that predates the kept files) the
continental intermediates are read in build_global_tiles.py's dedupe order,
which has no region fields. A layer with a world spec takes it over its
tile_manifest.yaml entry (osm_substations_polygons and osm_plants_polygons are
`format: geojson` there and pmtiles in the registry).
"""
import gzip
import json
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def _open_text(path):
    return gzip.open(path, "rt", encoding="utf-8") if str(path).endswith(".gz") \
        else open(path, encoding="utf-8", newline="")


def world_spec(layer_id):
    """How build_global_tiles.py builds a world layer: (inputs, select, region
    fields the inputs lack) — or None for a layer build_tiles.py builds from its
    manifest `src`. The inputs are the kept tagged file when it exists (region
    fields then empty), else the continental inputs in dedupe order."""
    import build_global_tiles as g
    if layer_id == g.TRANSMISSION_BASE:
        kept, select, fallback = (g.TRANSMISSION_KEPT, g.TRANSMISSION_SELECT,
                                  [g.BUILD_DIR / f"{g.TRANSMISSION_SRC_STEM}_{c}.gpkg"
                                   for c in g.REGION_CODES])
        fields = g.LINE_FIELDS
    else:
        spec = next((s for s in [*g.RETILE, *g.TILE_POLYGONS] if s["base"] == layer_id), None)
        if spec is None:
            return None
        kept, select, fields = g.kept_path(layer_id), spec["select"], spec["fields"]
        fallback = (g._retile_inputs(spec) if spec in g.RETILE
                    else [g.BUILD_DIR / f"{spec['src']}_{c}.gpkg" for c in g.REGION_CODES])
    if kept.exists():
        return [kept], select, ()
    return fallback, select, fields


def input_rows(layer):
    """(inputs, ogr2ogr options, fields the tiles may carry beyond the input):
    the rows tippecanoe read for this layer, as the build reads them."""
    world = world_spec(layer["id"])
    if world:
        srcs, select, region_fields = world
        return ([p for p in srcs if p.exists()],
                lambda p: ([] if p.suffix in (".geojsonl", ".gz") else
                           [*(["-oo", "X_POSSIBLE_NAMES=lon", "-oo", "Y_POSSIBLE_NAMES=lat",
                               "-oo", "KEEP_GEOM_COLUMNS=NO"] if p.suffix == ".csv" else []),
                            "-select", ",".join(select)]),
                set(region_fields))
    import build_tiles as b
    src = ROOT / layer["src"]
    return ([src] if src.exists() else [],
            lambda p: [*b._src_opts(p), *b._common_opts(layer)], set())


def _row(ft, geometry):
    row = {**(ft.get("properties") or {}), "__id": ft.get("id")}
    if geometry:
        row["__geometry"] = ft.get("geometry")
    return row


def stream_rows(path, opts, geometry=False):
    """Each input row's properties (plus a feature `id`, as `__id`), streamed.
    geometry=True adds the GeoJSON geometry dict as `__geometry`."""
    if str(path).endswith((".geojsonl", ".geojsonl.gz")):
        with _open_text(path) as f:
            for ln in f:
                if ln.strip():
                    yield _row(json.loads(ln), geometry)
        return
    proc = subprocess.Popen(["ogr2ogr", "-f", "GeoJSONSeq", "/vsistdout/", str(path), *opts],
                            stdout=subprocess.PIPE, text=True, bufsize=1 << 20)
    try:
        for ln in proc.stdout:
            ln = ln.strip().lstrip("\x1e")
            if ln:
                yield _row(json.loads(ln), geometry)
    finally:
        proc.stdout.close()
        if proc.wait() != 0:
            raise RuntimeError(f"ogr2ogr {path} exited {proc.returncode}")
