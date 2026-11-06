#!/usr/bin/env python3
"""Route optimizer: local GeoParquet copies for the "what does this route cross" report.

Role: writes data/route/report/<layer>[.pN].parquet plus manifest.json (per file: rows, MiB, row groups,
max row group MiB, columns). Layout: report columns only, lines/polygons simplified at 10 m in EPSG:5070 (Douglas-Peucker, no topology; invalid
results repaired), polygons over 5,000 vertices subdivided by recursive clip (PAD-US, critical habitat),
rows Hilbert-sorted on the 4326 centroid, variable row groups (polygons 20-150 rows and about 1 MiB;
lines/points about 2 MiB uncompressed), a float64 `bbox{xmin,ymin,xmax,ymax}` covering column, GeoParquet
1.1.0 metadata, ZSTD 9. A layer whose file would pass 95 MiB is cut into contiguous Hilbert parts.
Everything is filtered to CONUS: a feature is kept when it intersects the lower-48 + DC state union buffered 0.1 deg
(AK, HI, PR and the territories are excluded); features are not clipped to that mask. Named CONUS major roads
(motorway/trunk, primary) and rivers are re-exported from
<cache>/route-osm/conus_filtered.osm.pbf (an external disk; osmium tags-filter + export with
name, ref, bridge, tunnel). No water polygons. Writes only under data/route/report/ (intermediates under
<cache>/route-osm/report/).
Deps: numpy, pandas, shapely, pyogrio, pyproj, pyarrow (the repo venv); osmium CLI.

Usage: venv/bin/python scripts/build_route_report_data.py [--only name,name]
Run under systemd-run MemoryMax with TMPDIR/CPL_TMPDIR=tmp/build-tmp.
"""
import argparse
import json
import os
import subprocess
import sys
import time
from pathlib import Path

os.environ.setdefault("OGR_GEOJSON_MAX_OBJ_SIZE", "0")

import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402
import pyarrow as pa  # noqa: E402
import pyarrow.parquet as pq  # noqa: E402
import pyogrio  # noqa: E402
import shapely  # noqa: E402
from pyproj import Transformer  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
B = ROOT / "data/build"
OUT = ROOT / "data/route/report"
CACHE = Path(os.environ.get("ROUTE_CACHE") or ROOT / "data/raw/route-cache") / "route-osm"
WORK = CACHE / "report"
MIB = 2 ** 20
SIMPLIFY_M = 10.0
SUBDIV_VERTS = 5000
SPLIT_AT = 95 * MIB
POLY_ROWS = (20, 150)
POLY_TARGET, GEN_TARGET, HARD_MAX = 1 * MIB, 2 * MIB, int(3.5 * MIB)
NON_CONUS = {"02", "15", "60", "66", "69", "72", "78"}  # AK, HI, AS, GU, MP, PR, VI
t0 = time.time()
TO_P = Transformer.from_crs(4326, 5070, always_xy=True)
TO_G = Transformer.from_crs(5070, 4326, always_xy=True)


def log(*a):
    print(f"[{time.time() - t0:7.0f}s]", *a, flush=True)


# ---------- geometry helpers ----------
def hilbert(x, y, order=16):
    n = 1 << order
    ix = np.clip(((x + 180) / 360 * (n - 1)), 0, n - 1).astype(np.uint64)
    iy = np.clip(((y + 90) / 180 * (n - 1)), 0, n - 1).astype(np.uint64)
    d = np.zeros(len(ix), dtype=np.uint64)
    s = n >> 1
    while s > 0:
        rx = ((ix & np.uint64(s)) > 0).astype(np.uint64)
        ry = ((iy & np.uint64(s)) > 0).astype(np.uint64)
        d += np.uint64(s) * np.uint64(s) * ((np.uint64(3) * rx) ^ ry)
        m = ry == 0
        flip = m & (rx == 1)
        ix = np.where(flip, np.uint64(n - 1) - ix, ix)
        iy = np.where(flip, np.uint64(n - 1) - iy, iy)
        ix, iy = np.where(m, iy, ix), np.where(m, ix, iy)
        s >>= 1
    return d


_conus = None


def conus_mask_geom():
    global _conus
    if _conus is None:
        s = pyogrio.read_dataframe(B / "us_states.gpkg").to_crs(4326)
        s = s[~s["geoid"].astype(str).str.zfill(2).isin(NON_CONUS)]
        assert len(s) == 49, len(s)  # 48 states + DC
        u = shapely.union_all(shapely.make_valid(s.geometry.values)).buffer(0.1).simplify(0.01)
        shapely.prepare(u)
        _conus = u
    return _conus


def kind_of(geoms):
    t = shapely.get_type_id(geoms[:1])[0]
    return "point" if t in (0, 4) else "line" if t in (1, 5) else "poly"


def simplify(geoms):
    out = np.empty(len(geoms), dtype=object)
    for i in range(0, len(geoms), 20000):
        g = geoms[i:i + 20000]
        p = shapely.transform(g, lambda a: np.column_stack(TO_P.transform(a[:, 0], a[:, 1])))
        s = shapely.simplify(p, SIMPLIFY_M, preserve_topology=False)
        bad = ~shapely.is_valid(s) & ~shapely.is_empty(s)
        if bad.any():
            s[bad] = shapely.make_valid(s[bad])
        r = shapely.transform(s, lambda a: np.column_stack(TO_G.transform(a[:, 0], a[:, 1])))
        bad = ~shapely.is_valid(r) & ~shapely.is_empty(r)  # reprojecting back can reintroduce a self-touch
        if bad.any():
            r[bad] = shapely.make_valid(r[bad])
        out[i:i + 20000] = r
    return out


def _polys_only(g):
    if g.geom_type in ("Polygon", "MultiPolygon") or g.is_empty:
        return g
    parts = [p for p in shapely.get_parts(g) if p.geom_type == "Polygon" and not p.is_empty]
    return shapely.multipolygons(parts) if len(parts) > 1 else parts[0] if parts else shapely.Polygon()


def subdivide(g, depth=0):
    if shapely.get_num_coordinates(g) <= SUBDIV_VERTS or depth > 12:
        return [g]
    x0, y0, x1, y1 = g.bounds
    if (x1 - x0) >= (y1 - y0):
        xm = (x0 + x1) / 2
        boxes = [(x0, y0, xm, y1), (xm, y0, x1, y1)]
    else:
        ym = (y0 + y1) / 2
        boxes = [(x0, y0, x1, ym), (x0, ym, x1, y1)]
    out = []
    for b in boxes:
        c = shapely.make_valid(shapely.clip_by_rect(g, *b))
        if c.is_empty:
            continue
        parts = [p for p in (c.geoms if hasattr(c, "geoms") else [c]) if p.geom_type == "Polygon" and not p.is_empty]
        if parts:
            out += subdivide(shapely.multipolygons(parts) if len(parts) > 1 else parts[0], depth + 1)
    return out


def prepare(df, geoms, cols):
    """clip to CONUS, simplify, subdivide polygons -> frame(cols + _wkb + bbox + _key) and the layer kind."""
    df = df.reset_index(drop=True)
    geoms = np.asarray(geoms, dtype=object)
    ok = ~shapely.is_empty(geoms) & ~pd.isna(geoms)
    ok &= shapely.intersects(geoms, conus_mask_geom())
    df, geoms = df[ok].reset_index(drop=True), geoms[ok]
    if not len(df):
        return None, None
    kind = kind_of(geoms)
    if kind != "point":
        geoms = simplify(geoms)
    if kind == "poly":
        geoms = np.array([_polys_only(g) for g in geoms], dtype=object)  # make_valid can return a GeometryCollection
        rows, gs = [], []
        for i, g in enumerate(geoms):
            for p in subdivide(g):
                rows.append(i)
                gs.append(p)
        df, geoms = df.iloc[rows].reset_index(drop=True), np.array(gs, dtype=object)
    keep = ~shapely.is_empty(geoms)
    df, geoms = df[keep].reset_index(drop=True), geoms[keep]
    f = df[cols].copy()
    b = shapely.bounds(geoms)
    c = shapely.centroid(geoms)
    f["_wkb"] = shapely.to_wkb(geoms)
    f["_xmin"], f["_ymin"], f["_xmax"], f["_ymax"] = b.T
    f["_key"] = hilbert(shapely.get_x(c), shapely.get_y(c))
    return f, kind


# ---------- writer ----------
def chunk_bounds(sizes, kind):
    """Contiguous row-group boundaries by cumulative uncompressed bytes."""
    lo, hi = (POLY_ROWS if kind == "poly" else (20, 10 ** 9))
    target = POLY_TARGET if kind == "poly" else GEN_TARGET
    cuts, start, acc = [0], 0, 0
    for i, s in enumerate(sizes):
        n = i - start
        if n and (n >= hi or (acc + s > HARD_MAX and n >= 1) or (acc >= target and n >= lo)):
            cuts.append(i)
            start, acc = i, 0
        acc += s
    cuts.append(len(sizes))
    return cuts


def arrow_table(f, cols):
    arrays = {}
    for c in cols:
        s = f[c]
        if s.dtype == object:
            arrays[c] = pa.array([None if (v is None or (isinstance(v, float) and np.isnan(v))) else str(v) for v in s], type=pa.string())
        else:
            arrays[c] = pa.Array.from_pandas(s)
    arrays["bbox"] = pa.StructArray.from_arrays(
        [pa.array(f[k].to_numpy()) for k in ("_xmin", "_ymin", "_xmax", "_ymax")], names=["xmin", "ymin", "xmax", "ymax"])
    arrays["geometry"] = pa.array(f["_wkb"].to_numpy(), type=pa.binary())
    return pa.table(arrays)


def write_file(f, path, cols, kind):
    t = arrow_table(f, cols)
    gt = {"point": ["Point"], "line": ["LineString", "MultiLineString"], "poly": ["Polygon", "MultiPolygon"]}[kind]
    geo = {"version": "1.1.0", "primary_column": "geometry", "columns": {"geometry": {
        "encoding": "WKB", "geometry_types": gt,
        "bbox": [float(f["_xmin"].min()), float(f["_ymin"].min()), float(f["_xmax"].max()), float(f["_ymax"].max())],
        "covering": {"bbox": {k: ["bbox", k] for k in ("xmin", "ymin", "xmax", "ymax")}}}}}
    t = t.replace_schema_metadata({"geo": json.dumps(geo)})
    sizes = (f["_wkb"].map(len) + 16 + 8 * len(cols)).to_numpy()
    cuts = chunk_bounds(sizes, kind)
    with pq.ParquetWriter(path, t.schema, compression="zstd", compression_level=9,
                          write_statistics=True, write_page_index=True) as w:
        for a, b in zip(cuts[:-1], cuts[1:]):
            w.write_table(t.slice(a, b - a), row_group_size=b - a)


def stats(path):
    md = pq.ParquetFile(path).metadata
    rg = [md.row_group(i) for i in range(md.num_row_groups)]
    return {"rows": md.num_rows, "mib": round(os.path.getsize(path) / MIB, 2), "row_groups": len(rg),
            "max_rg_mib": round(max(r.total_byte_size for r in rg) / MIB, 2),
            "max_rg_compressed_mib": round(max(sum(r.column(j).total_compressed_size for j in range(r.num_columns)) for r in rg) / MIB, 2),
            "max_rg_rows": max(r.num_rows for r in rg), "min_rg_rows": min(r.num_rows for r in rg)}


ODBL = "ODbL 1.0, (c) OpenStreetMap contributors"
PD = "public domain (US federal work, 17 U.S.C. 105)"
SOURCES = {
    "transmission_osm_us": ("OpenStreetMap power lines, data/build/transmission_lines.gpkg", ODBL),
    "transmission_hifld": ("HIFLD electric power transmission lines (frozen copy)", PD),
    "substations_hifld": ("HIFLD electric substations (frozen copy)", PD),
    "substations_osm_points": ("OpenStreetMap substations (points)", ODBL),
    "substations_osm_polygons": ("OpenStreetMap substations (polygons)", ODBL),
    "generators_eia": ("EIA-860 generators", PD),
    "generators_osm": ("OpenStreetMap generators (points)", ODBL),
    "plants_osm_polygons": ("OpenStreetMap power plants (polygons)", ODBL),
    "pipelines_hifld_natgas": ("HIFLD natural gas pipelines (frozen copy)", PD),
    "pipelines_osm": ("OpenStreetMap pipelines", ODBL),
    "pipelines_eia_crude": ("EIA crude oil pipelines", PD),
    "pipelines_eia_product": ("EIA petroleum product pipelines", PD),
    "railroads": ("BTS / FRA North American Rail Network (NARN)", PD),
    "tribal_tiger": ("Census TIGER/Line AIANNH", PD),
    "tribal_bia": ("BIA Land Area Representations", PD),
    "crithab": ("USFWS critical habitat", PD),
    "airports": ("FAA ADDS airports", PD),
    "counties": ("Census TIGER/Line counties", PD),
    "padus_conus": ("USGS PAD-US 4.1", PD),
    "roads_motorway_trunk": ("OpenStreetMap highways (motorway, trunk)", ODBL),
    "roads_primary": ("OpenStreetMap highways (primary)", ODBL),
    "rivers": ("OpenStreetMap waterway=river", ODBL),
    "wsr": ("rivers.gov National Wild and Scenic River lines (USFS EDW copy)", PD),
    "nht_nst": ("NPS National Trails System NHT/NST lines", PD),
}


def drop_files(name, manifest):
    """Remove a layer's files and their manifest entries."""
    for old in list(OUT.glob(f"{name}.parquet")) + list(OUT.glob(f"{name}.p*.parquet")):
        old.unlink()
    for k in [k for k in manifest if k == f"{name}.parquet" or (k.startswith(f"{name}.p") and k.endswith(".parquet") and k[len(name) + 2:-8].isdigit())]:
        del manifest[k]


def assert_valid(path):
    g = shapely.from_wkb(pq.read_table(path, columns=["geometry"])["geometry"].to_numpy(zero_copy_only=False))
    bad = int((~shapely.is_valid(g)).sum())
    assert bad == 0, f"{path.name}: {bad} invalid geometries"


def emit(name, f, cols, kind, manifest):
    f = f.sort_values("_key", kind="stable").reset_index(drop=True)
    drop_files(name, manifest)
    p = OUT / f"{name}.parquet"
    write_file(f, p, cols, kind)
    size = p.stat().st_size
    files = [p]
    if size > SPLIT_AT:
        p.unlink()
        n = int(np.ceil(size / (80 * MIB)))
        w = f["_wkb"].map(len).cumsum().to_numpy()
        edges = [int(np.searchsorted(w, w[-1] * k / n)) for k in range(1, n)]
        cuts = [0] + edges + [len(f)]
        files = []
        for k, (a, b) in enumerate(zip(cuts[:-1], cuts[1:]), 1):
            q = OUT / f"{name}.p{k}.parquet"
            write_file(f.iloc[a:b].reset_index(drop=True), q, cols, kind)
            files.append(q)
    for q in files:
        s = stats(q)
        assert s["mib"] < 100, (q, s)
        assert s["max_rg_mib"] <= 4.0, (q, s)
        assert_valid(q)
        src, lic = SOURCES[name]
        manifest[q.name] = {**s, "columns": cols, "kind": kind, "source": src, "licence": lic}
        log(f"FILE {q.name}: rows {s['rows']:,}  {s['mib']} MiB  row groups {s['row_groups']}  "
            f"max row group {s['max_rg_mib']} MiB uncompressed / {s['max_rg_compressed_mib']} MiB compressed  "
            f"rows/group {s['min_rg_rows']}-{s['max_rg_rows']}")


# ---------- loaders: return (df, geoms) ----------
def gp(path, layer=None, **kw):
    g = pyogrio.read_dataframe(path, layer=layer, **kw)
    geoms = g.geometry.to_numpy()
    return pd.DataFrame(g.drop(columns=g.geometry.name)), geoms


def csvpts(path):
    d = pd.read_csv(path, low_memory=False, dtype=str)
    for c in ("lon", "lat"):
        d[c] = pd.to_numeric(d[c], errors="coerce")
    d = d.dropna(subset=["lon", "lat"]).reset_index(drop=True)
    return d, shapely.points(d["lon"].to_numpy(), d["lat"].to_numpy())


def num_cols(d, cols):
    for c in cols:
        if c in d:
            d[c] = pd.to_numeric(d[c], errors="coerce")
    return d


NOTES = {}


def load_osm_tl_us():
    d, g = gp(B / "transmission_lines.gpkg")
    na = pyogrio.read_dataframe(B / "transmission_lines_na.gpkg", read_geometry=False, columns=["osm_id", "fid"])
    m = dict(zip(na["osm_id"].astype(str), na["fid"]))
    d["fid"] = pd.to_numeric(d["osm_id"].astype(str).map(m), errors="coerce").astype("Int64")
    d["osm_id"] = pd.to_numeric(d["osm_id"], errors="coerce").astype("Int64")
    miss = int(d["fid"].isna().sum())
    NOTES["transmission_osm_us"] = (f"transmission_lines.gpkg has osm_id but no fid; fid taken from transmission_lines_na.gpkg "
                                    f"(osm_id x 10 + type digit) for {len(d) - miss} of {len(d)} rows, {miss} rows keep osm_id only (fid null)")
    log(NOTES["transmission_osm_us"])
    return d, g


# name -> (loader, cols); loader returns (df, geoms)
LAYERS = {
    "transmission_osm_us": (load_osm_tl_us, ["fid", "osm_id", "name", "operator", "nominal_kv", "line_type", "ref", "is_dc", "is_undergrnd"]),
    "transmission_hifld": (lambda: gp(B / "transmission_hifld.gpkg"), ["ID", "OWNER", "VOLTAGE", "VOLT_CLASS", "TYPE", "STATUS", "SUB_1", "SUB_2", "states"]),
    "substations_hifld": (lambda: csvpts(B / "substation_hifld.csv"), ["hifld_id", "name", "max_kv", "min_kv", "states"]),
    "substations_osm_points": (lambda: csvpts(B / "substation_osm_na.csv"), ["fid", "osm_id", "name", "operator", "nominal_kv", "sub_type"]),
    "substations_osm_polygons": (lambda: gp(B / "substation_polygons_na.gpkg"), ["fid", "osm_id", "name", "operator", "nominal_kv", "sub_type"]),
    "generators_eia": (lambda: csvpts(B / "generator_eia.csv"), ["fid", "plant_code", "plant_name", "technology", "energy_source", "nameplate_mw", "state", "status", "gen_status", "utility_name"]),
    "generators_osm": (lambda: csvpts(B / "generator_osm_na.csv"), ["fid", "osm_id", "name", "source", "gen_method", "output_mw", "operator"]),
    "plants_osm_polygons": (lambda: gp(B / "plant_polygons_na.gpkg"), ["fid", "osm_id", "name", "source", "output_mw", "operator"]),
    "pipelines_hifld_natgas": (lambda: gp(B / "hifld_natgas_lines.gpkg"), ["fid", "pipe_type", "operator", "name", "states"]),
    "pipelines_osm": (lambda: gp(B / "pipeline_routes_na.gpkg"), ["fid", "osm_id", "name", "substance", "operator"]),
    "pipelines_eia_crude": (lambda: gp(B / "eia_crude_pipelines.geojson"), ["name", "operator"]),
    "pipelines_eia_product": (lambda: gp(B / "eia_product_pipelines.geojson"), ["name", "operator"]),
    "railroads": (lambda: gp(ROOT / "data/raw/railroads/narn_rail_lines.geojson"),
                  ["OBJECTID", "RROWNER1", "RROWNER2", "TRKRGHTS1", "DIVISION", "SUBDIV", "BRANCH", "PASSNGR", "STRACNET", "TRACKS", "NET", "STATEAB"]),
    "tribal_tiger": (lambda: gp(B / "tribal_lands.gpkg"), ["name", "area_type", "recognized", "geoid"]),
    "tribal_bia": (lambda: gp(B / "bia_tribal_lands.geojson"), ["LARNAME", "AGENCY"]),
    "crithab": (lambda: gp(B / "crithab.gpkg"), ["comname", "sciname", "status", "unitname", "subunitnam"]),
    "airports": (lambda: gp(ROOT / "data/raw/route/faa/airports_public.geojson"),
                 ["IDENT", "NAME", "ICAO_ID", "TYPE_CODE", "SERVCITY", "STATE", "OPERSTATUS", "PRIVATEUSE"]),
    "wsr": (lambda: gp(ROOT / "data/raw/route/wsr/wsr_lines.geojson"), ["wsr_river_name", "agency"]),
    "nht_nst": (lambda: gp(ROOT / "data/raw/route/trails/nts_lines.geojson"), ["trail"]),
    "counties": (lambda: gp(B / "county_boundaries.geojson"), ["GEOID", "NAME", "STUSPS"]),
}
PADUS_COLS = ["name", "desig", "mng_agency", "mng_type", "own_agency", "gap", "state"]


def do_layer(name, manifest):
    load, cols = LAYERS[name]
    d, g = load()
    cols = [c for c in cols if c in d.columns]
    f, kind = prepare(d, g, cols)
    del d, g
    if f is None:
        log(f"{name}: no rows in CONUS")
        drop_files(name, manifest)
        return
    log(f"{name}: {len(f):,} rows after CONUS clip, simplify, subdivide ({kind})")
    emit(name, f, cols, kind, manifest)


def do_padus(manifest):
    path = B / "padus.gpkg"
    n = pyogrio.read_info(path)["features"]
    frames, kind = [], None
    for s in range(0, n, 10000):
        d = pyogrio.read_dataframe(path, skip_features=s, max_features=10000)
        g = d.geometry.to_numpy()
        f, k = prepare(pd.DataFrame(d.drop(columns=d.geometry.name)), g, PADUS_COLS)
        if f is not None:
            frames.append(f)
            kind = k
        log(f"padus_conus: {min(s + 10000, n)}/{n}")
    f = pd.concat(frames, ignore_index=True)
    log(f"padus_conus: {len(f):,} pieces after CONUS clip, simplify, subdivide to <= {SUBDIV_VERTS} vertices")
    emit("padus_conus", f, PADUS_COLS, kind, manifest)


# ---------- roads and rivers from the CONUS OSM extract ----------
def sh(cmd):
    log("$", " ".join(str(c) for c in cmd))
    subprocess.run([str(c) for c in cmd], check=True)


RR_TAGS = ["name", "ref", "bridge", "tunnel", "highway", "waterway"]


def do_roads_rivers(manifest):
    WORK.mkdir(parents=True, exist_ok=True)
    pbf, seq, cfg = WORK / "major.osm.pbf", WORK / "major_named.geojsonseq", WORK / "major.json"
    if not seq.exists():
        cfg.write_text(json.dumps({"include_tags": RR_TAGS}))
        sh(["osmium", "tags-filter", CACHE / "conus_filtered.osm.pbf", "w/highway=motorway,trunk,primary", "w/waterway=river",
            "-o", pbf, "--overwrite"])
        part = seq.with_name(seq.name + ".part")
        sh(["osmium", "export", pbf, "-f", "geojsonseq", "-c", cfg, "-u", "type_id", "-o", part, "--overwrite",
            "--geometry-types=linestring"])
        part.rename(seq)
        pbf.unlink()
    classes = {"roads_motorway_trunk": ("highway", ("motorway", "trunk")), "roads_primary": ("highway", ("primary",)),
               "rivers": ("waterway", ("river",))}
    acc = {k: [] for k in classes}
    rows = {k: [] for k in classes}
    geoms = {k: [] for k in classes}

    def flush(k):
        if geoms[k]:
            d = pd.DataFrame(rows[k])
            f, kind = prepare(d, np.array(geoms[k], dtype=object), ["fid", "osm_id", "name", "ref", "bridge", "tunnel", "highway", "waterway"])
            if f is not None:
                acc[k].append(f)
            rows[k].clear()
            geoms[k].clear()

    n = 0
    with open(seq, "rb") as fh:
        for line in fh:
            line = line.strip(b"\x1e\n ")
            if not line:
                continue
            o = json.loads(line)
            p = o["properties"]
            for k, (tag, vals) in classes.items():
                if p.get(tag) in vals:
                    oid = int(str(o["id"])[1:])
                    rows[k].append({"fid": oid * 10 + 2, "osm_id": oid, **{t: p.get(t) for t in RR_TAGS}})
                    geoms[k].append(shapely.from_geojson(json.dumps(o["geometry"])))
                    if len(geoms[k]) >= 100000:
                        flush(k)
                    break
            n += 1
    for k in classes:
        flush(k)
        f = pd.concat(acc[k], ignore_index=True)
        named = f["name"].notna() & (f["name"].astype(str) != "")
        refd = f["ref"].notna() & (f["ref"].astype(str) != "")
        log(f"{k}: {len(f):,} rows; with name {int(named.sum()):,} ({100 * named.mean():.1f} %), with ref {int(refd.sum()):,} "
            f"({100 * refd.mean():.1f} %), name or ref {int((named | refd).sum()):,} ({100 * (named | refd).mean():.1f} %); "
            f"bridge set {int(f['bridge'].notna().sum()):,}, tunnel set {int(f['tunnel'].notna().sum()):,}")
        manifest.setdefault("_named_share", {})[k] = {"rows": len(f), "named_pct": round(100 * named.mean(), 1),
                                                     "named_or_ref_pct": round(100 * (named | refd).mean(), 1)}
        emit(k, f, ["fid", "osm_id", "name", "ref", "bridge", "tunnel", "highway", "waterway"], "line", manifest)
        del f
        acc[k].clear()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", default="")
    only = [x for x in ap.parse_args().only.split(",") if x]
    OUT.mkdir(parents=True, exist_ok=True)
    mp = OUT / "manifest.json"
    manifest = json.loads(mp.read_text()) if mp.exists() else {}
    names = list(LAYERS) + ["padus_conus", "roads_rivers"]
    for k in [k for k in manifest if k.endswith(".parquet") and not (OUT / k).exists()]:
        del manifest[k]
    for name in only or names:
        if name == "padus_conus":
            do_padus(manifest)
        elif name == "roads_rivers":
            do_roads_rivers(manifest)
        else:
            do_layer(name, manifest)
        manifest["_notes"] = NOTES
        mp.write_text(json.dumps(manifest, indent=1))
    log("all files:")
    for p in sorted(OUT.glob("*.parquet")):
        s = manifest.get(p.name)
        if s:
            log(f"  {p.name}: {s['rows']:,} rows, {s['mib']} MiB, {s['row_groups']} groups, max group {s['max_rg_mib']} MiB")
            assert s["mib"] < 100 and s["max_rg_mib"] <= 4.0
    log("done")


if __name__ == "__main__":
    main()
