#!/usr/bin/env python3
"""build_line_parquet.py — exact feature geometry as GeoParquet, for the copy,
fault-locator and elevation-profile tools (docs/pipeline.md § Line geometry).

Twenty-one datasets (the DATASET table), each a directory under data/analysis/:

  osm_transmission_lines    the world OSM lines, all six kV classes in one set,
                            read from the merged input the tile build keeps
                            (data/build/world/transmission_world.geojsonl.gz), so
                            ids and 1e-6° coordinates are exactly the tiles'
  hifld_transmission_lines  data/build/transmission_hifld.gpkg, converted with
                            the tile build's own ogr2ogr options (precision 6)
  osm_substations_polygons  the world OSM substation polygons, from the merged
                            input the tile build keeps (via tile_inputs.py);
                            geometry "polygon": IDX (fid, row) and GEO only, no
                            CHAINS and no length_km
  osm_plants_polygons       the world OSM power-plant polygons, the same way
  osm_pipelines_lines       the world OSM pipelines, from the same kept merge;
                            geometry "line": IDX (fid, row, length_km) and GEO, no
                            CHAINS
  hifld_natgas_lines        data/build/hifld_natgas_lines.gpkg, converted with the
                            tile build's ogr2ogr options (precision 6); string
                            fids ("ng:<FID>", "hgl:<FID>"), IDX and GEO only
  retail_territories        data/build/retail_territories.gpkg, polygon geometry at the
  eia_ba                    GeoPackage's own precision (no tile rounding); string fids
  nerc_regions              from the tile manifest's `id_field` (`id`, `abbrev`, `sub_nm`);
  control_areas             IDX and GEO only
  crithab                   data/build/crithab.gpkg and padus.gpkg, polygon geometry as
  padus                     stored; integer fids from the tile manifest's `id_field`
                            (`entity_id`; PAD-US's content id `fid`, a normal column of
                            its GeoPackage); IDX and GEO only
  us_states                 data/build/us_states.gpkg, countries.gpkg,
  countries                 admin1_boundaries.gpkg and tribal_lands.gpkg, polygon
  admin1_boundaries         geometry as stored; string fids from the tile manifest's
  tribal_lands              `id_field` (`stusps`, `iso_a3`, `code`, `geoid`); IDX and
                            GEO only; countries and admin1_boundaries are CC BY 4.0
  us_zcta                   data/build/us_zcta.gpkg (`zcta5`) and data/build/
  county_boundaries         county_boundaries.geojson (`GEOID`, read by `path`), polygon
                            geometry as stored; zero-padded string fids, never coerced;
                            IDX and GEO only
  bia_tribal_lands          data/build/bia_tribal_lands.geojson (`LARID`) and
  boem_wind_leases          boem_wind_leases.geojson (`fid`, a content id), read by `path`,
                            polygon geometry as stored (invalid rings kept); string fids;
                            IDX and GEO only
  railroads                 data/raw/railroads/narn_rail_lines.geojson (`FRAARCID`, read by
                            `path`), line geometry as stored; int64 fids; IDX (with
                            length_km) and GEO only

Per dataset (geoparquet_common.py holds the layout rules):

  <ds>.idx.<sha8>.parquet       fid → row, length_km (+ chain, circuits for OSM
                                transmission lines; polygons: fid, row only), sorted by fid
  <ds>.geo.p<N>.<sha8>.parquet  fid, bbox, geometry (GeoParquet 1.1), Hilbert
                                order on the centroid, cut into ~64 MiB parts
  <ds>.chains.<sha8>.parquet    OSM transmission only: ways joined end to end through
                                degree-2 nodes of one voltage, in order, with
                                the substation at each chain end
  _manifest.json                bytes, sha256, footer length, rows, part row
                                offsets, build_id, provenance, geometry
                                ("line" | "polygon"; readers treat absent as "line")

and data/analysis/index.json, every dataset's manifest in one file. One Hilbert
permutation per run writes GEO, IDX `row` and CHAINS `row`, and every file
carries the run's `build_id` in its key-value metadata.

Usage:
  python scripts/build_line_parquet.py                          # every dataset
  python scripts/build_line_parquet.py --only hifld_transmission_lines
  python scripts/build_line_parquet.py --fixture DIR            # DIR/input → DIR/analysis
                                                                # (build_id and `built` pinned)
"""
import argparse
import csv
import json
import logging
import os
import subprocess
import sys
import tempfile
import time
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

import geoparquet_common as gc

logging.basicConfig(level=logging.INFO, format="%(asctime)s  %(levelname)-8s  %(message)s",
                    datefmt="%H:%M:%S")
log = logging.getLogger("line_parquet")

ROOT = Path(__file__).resolve().parent.parent
BUILD_DIR = ROOT / "data" / "build"
OUT_DIR = ROOT / "data" / "analysis"
REGION_CODES = ["na", "eu", "as", "sa", "af", "oc", "ca", "an"]   # build_global_tiles order

OSM = "osm_transmission_lines"
HIFLD = "hifld_transmission_lines"
SUBS_POLY = "osm_substations_polygons"
PLANTS_POLY = "osm_plants_polygons"
PIPES = "osm_pipelines_lines"
NATGAS = "hifld_natgas_lines"
RETAIL = "retail_territories"
EIA_BA = "eia_ba"
NERC = "nerc_regions"
CONTROL_AREAS = "control_areas"
CRITHAB = "crithab"
PADUS = "padus"
US_STATES = "us_states"
COUNTRIES = "countries"
ADMIN1 = "admin1_boundaries"
TRIBAL = "tribal_lands"
US_ZCTA = "us_zcta"
COUNTIES = "county_boundaries"
BIA = "bia_tribal_lands"
BOEM = "boem_wind_leases"
RAILROADS = "railroads"
FIXTURE_BUILD_ID = "fixture"
FIXTURE_BUILT = "1970-01-01T00:00:00Z"

# One row per dataset: geometry kind, the credit a copy carries, whether the
# input is OSM (replication date in the manifest), the fid type the tiles carry,
# whether CHAINS and `circuits` are written (OSM transmission only), and where the
# input comes from: "kept" (the tile build's kept merge), "gpkg" (a data/build
# GeoPackage; `id_field` is its tile id column; `exact` reads it as stored, with no
# tile-precision rounding; a row may name `path` instead of `file`: any OGR-readable
# file relative to the repo, `exact` only) or "special" (read by load_dataset).
OSM_CREDIT = "© OpenStreetMap contributors"
DATASET = {
    OSM: {"geometry": "line", "osm": True, "attribution": OSM_CREDIT,
          "fid_type": "int64", "chains": True, "input": "special"},
    HIFLD: {"geometry": "line", "osm": False, "attribution": "HIFLD (DHS/CISA), via source.coop",
            "fid_type": "string", "chains": False, "input": "gpkg",
            "file": "transmission_hifld", "id_field": "ID"},
    SUBS_POLY: {"geometry": "polygon", "osm": True, "attribution": OSM_CREDIT,
                "fid_type": "int64", "chains": False, "input": "kept"},
    PLANTS_POLY: {"geometry": "polygon", "osm": True, "attribution": OSM_CREDIT,
                  "fid_type": "int64", "chains": False, "input": "kept"},
    PIPES: {"geometry": "line", "osm": True, "attribution": OSM_CREDIT,
            "fid_type": "int64", "chains": False, "input": "kept"},
    NATGAS: {"geometry": "line", "osm": False, "attribution": "HIFLD (DHS/CISA), original data from EIA, via source.coop",
             "fid_type": "string", "chains": False, "input": "gpkg",
             "file": "hifld_natgas_lines", "id_field": "fid"},
    RETAIL: {"geometry": "polygon", "osm": False, "attribution": "HIFLD (DHS/CISA), via source.coop",
             "fid_type": "string", "chains": False, "input": "gpkg",
             "file": "retail_territories", "id_field": "id", "exact": True},
    EIA_BA: {"geometry": "polygon", "osm": False,
             "attribution": "U.S. Energy Information Administration (EIA)",
             "fid_type": "string", "chains": False, "input": "gpkg",
             "file": "eia_ba", "id_field": "abbrev", "exact": True},
    NERC: {"geometry": "polygon", "osm": False, "attribution": "HIFLD (DHS/CISA), via source.coop",
           "fid_type": "string", "chains": False, "input": "gpkg",
           "file": "nerc_regions", "id_field": "sub_nm", "exact": True},
    CONTROL_AREAS: {"geometry": "polygon", "osm": False, "attribution": "HIFLD (DHS/CISA), via source.coop",
                    "fid_type": "string", "chains": False, "input": "gpkg",
                    "file": "control_areas", "id_field": "id", "exact": True},
    CRITHAB: {"geometry": "polygon", "osm": False, "attribution": "US Fish & Wildlife Service — ECOS",
              "fid_type": "int64", "chains": False, "input": "gpkg",
              "file": "crithab", "id_field": "entity_id", "exact": True},
    PADUS: {"geometry": "polygon", "osm": False, "attribution": "USGS Gap Analysis Project",
            "fid_type": "int64", "chains": False, "input": "gpkg",
            "file": "padus", "id_field": "fid", "exact": True},
    US_STATES: {"geometry": "polygon", "osm": False,
                "attribution": "U.S. Census Bureau, TIGER/Line cartographic boundary files",
                "fid_type": "string", "chains": False, "input": "gpkg",
                "file": "us_states", "id_field": "stusps", "exact": True},
    COUNTRIES: {"geometry": "polygon", "osm": False,
                "attribution": "geoBoundaries (William & Mary geoLab), CC BY 4.0",
                "fid_type": "string", "chains": False, "input": "gpkg",
                "file": "countries", "id_field": "iso_a3", "exact": True},
    ADMIN1: {"geometry": "polygon", "osm": False,
             "attribution": "geoBoundaries (William & Mary geoLab), CC BY 4.0",
             "fid_type": "string", "chains": False, "input": "gpkg",
             "file": "admin1_boundaries", "id_field": "code", "exact": True},
    TRIBAL: {"geometry": "polygon", "osm": False, "attribution": "U.S. Census Bureau, TIGER/Line",
             "fid_type": "string", "chains": False, "input": "gpkg",
             "file": "tribal_lands", "id_field": "geoid", "exact": True},
    US_ZCTA: {"geometry": "polygon", "osm": False,
              "attribution": "U.S. Census Bureau, TIGER/Line cartographic boundary files",
              "fid_type": "string", "chains": False, "input": "gpkg",
              "file": "us_zcta", "id_field": "zcta5", "exact": True},
    COUNTIES: {"geometry": "polygon", "osm": False,
               "attribution": "U.S. Census Bureau, TIGER/Line cartographic boundary files",
               "fid_type": "string", "chains": False, "input": "gpkg",
               "path": "data/build/county_boundaries.geojson", "id_field": "GEOID", "exact": True},
    BIA: {"geometry": "polygon", "osm": False, "attribution": "Bureau of Indian Affairs (BIA)",
          "fid_type": "string", "chains": False, "input": "gpkg",
          "path": "data/build/bia_tribal_lands.geojson", "id_field": "LARID", "exact": True},
    BOEM: {"geometry": "polygon", "osm": False, "attribution": "Bureau of Ocean Energy Management (BOEM)",
           "fid_type": "string", "chains": False, "input": "gpkg",
           "path": "data/build/boem_wind_leases.geojson", "id_field": "fid", "exact": True},
    RAILROADS: {"geometry": "line", "osm": False,
                "attribution": "US DOT Bureau of Transportation Statistics (NTAD); rail geometry from the Federal Railroad Administration (FRA)",
                "fid_type": "int64", "chains": False, "input": "gpkg",
                "path": "data/raw/railroads/narn_rail_lines.geojson", "id_field": "FRAARCID", "exact": True},
}
# Datasets a fixture build skips when its input file is absent (the committed
# fixtures predate them).
def check_rows(rows):
    """Stop on a gpkg row that names both or neither of `file` and `path`, or a `path` row that is not `exact`."""
    for ds, row in rows.items():
        if row["input"] == "gpkg" and ("file" in row) == ("path" in row):
            raise SystemExit(f"{ds}: a gpkg dataset names exactly one of `file` and `path`")
        if "path" in row and (not str(row["path"]).count("/") or str(row["path"]).endswith(".gz")):
            raise SystemExit(f"{ds}: `path` is a repo-relative file with a directory, not .gz (got {row['path']!r})")
        if "path" in row and not row.get("exact"):
            raise SystemExit(f"{ds}: a `path` input is read as stored, so the row must be `exact`")


check_rows(DATASET)

FIXTURE_OPTIONAL = (PLANTS_POLY, PIPES, NATGAS, RETAIL, EIA_BA, NERC, CONTROL_AREAS, CRITHAB, PADUS,
                    US_STATES, COUNTRIES, ADMIN1, TRIBAL, US_ZCTA, COUNTIES, BIA, BOEM, RAILROADS)
DATASETS = tuple(DATASET)


# The ogr2ogr options build_tiles.py applies to a GeoPackage layer
# (tile_manifest.yaml `precision: 6`), so GEO holds the tiles' coordinates.
def ogr_options(ds):
    """The ogr2ogr options the tile build applies to a GeoPackage dataset (id column + precision 6)."""
    return ["-select", DATASET[ds]["id_field"], "-lco", "COORDINATE_PRECISION=6"]

# A chain end within this distance of an OSM substation point stops there and
# names it (an end inside a substation polygon always does).
SUB_POINT_M = 150.0
NEAR_BINS_M = (25, 50, 100, 150, 300, 500)
GEOMETRY_TYPES = {"line": {1: "LineString", 5: "MultiLineString"},   # shapely type ids
                  "polygon": {3: "Polygon", 6: "MultiPolygon"}}


# ── Chains (stdlib) ───────────────────────────────────────────────────────────

def chain_ways(a, b, kv, stop=frozenset(), order=None):
    """Join ways end to end into chains.

    `a[i]`/`b[i]` are the node ids at way i's first and last vertex, `kv[i]` its
    voltage, `stop` the nodes a chain may not pass (substations). A chain runs
    through a node only when exactly two way ends meet there, both ways carry
    the same voltage and the node is not in `stop`. Returns
    (chains, reasons): each chain a list of (way, rev) in order, `rev` true when
    the way's vertices run against the chain; `reasons` counts why chain ends
    stopped (substation, end, branch, voltage, loop).
    """
    n = len(a)
    deg = Counter(a)
    deg.update(b)
    at = defaultdict(list)
    for i in range(n):
        at[a[i]].append(i)
        at[b[i]].append(i)

    def across(node, way):
        """The way that continues `way` through `node`, or a stop reason."""
        if node in stop:
            return "substation"
        d = deg[node]
        if d == 1:
            return "end"
        if d > 2:
            return "branch"
        w1, w2 = at[node]
        nxt = w2 if w1 == way else w1
        if nxt == way:
            return "loop"
        if kv[nxt] != kv[way]:
            return "voltage"
        return nxt

    visited = [False] * n
    chains, reasons = [], Counter()
    for seed in (order if order is not None else range(n)):
        if visited[seed]:
            continue
        visited[seed] = True
        fwd, node, cur = [(seed, False)], b[seed], seed
        while True:
            nxt = across(node, cur)
            if isinstance(nxt, str) or visited[nxt]:
                reasons[nxt if isinstance(nxt, str) else "loop"] += 1
                break
            visited[nxt] = True
            rev = a[nxt] != node
            fwd.append((nxt, rev))
            node, cur = (a[nxt] if rev else b[nxt]), nxt
        back, node, cur = [], a[seed], seed
        while True:
            nxt = across(node, cur)
            if isinstance(nxt, str) or visited[nxt]:
                reasons[nxt if isinstance(nxt, str) else "loop"] += 1
                break
            visited[nxt] = True
            rev = b[nxt] != node
            back.append((nxt, rev))
            node, cur = (b[nxt] if rev else a[nxt]), nxt
        chains.append(back[::-1] + fwd)
    return chains, reasons


def chain_end_nodes(chain, a, b):
    """(start node, end node) of a chain in its own direction."""
    first, frev = chain[0]
    last, lrev = chain[-1]
    return (b[first] if frev else a[first]), (a[last] if lrev else b[last])


def percentile(sorted_vals, q):
    if not sorted_vals:
        return 0
    return sorted_vals[min(len(sorted_vals) - 1, int(q * (len(sorted_vals) - 1) + 0.5))]


# ── Inputs ────────────────────────────────────────────────────────────────────

class Inputs:
    """Where one run reads from: the real data/build/ files or a fixture dir."""

    def kept_input(self, ds):
        """The input files of a "kept" dataset: the fixture's, or the tile build's kept merge."""
        if self.fixture:
            return [self.fixture / "input" / f"{ds}.geojsonl"]
        import build_global_tiles
        return [build_global_tiles.kept_path(ds)]

    def gpkg_input(self, ds):
        """The input of a "gpkg" dataset: the fixture's GeoJSONSeq, or the tile build's GeoPackage."""
        if self.fixture:
            return self.fixture / "input" / ("transmission_hifld.geojsonl" if ds == HIFLD
                                             else f"{ds}.geojsonl")
        row = DATASET[ds]
        return BUILD_DIR.parent.parent / row["path"] if "path" in row else BUILD_DIR / f"{row['file']}.gpkg"

    def has_input(self, ds):
        kind = DATASET[ds]["input"]
        if kind == "kept":
            return any(p.exists() for p in self.kept_input(ds))
        return self.gpkg_input(ds).exists() if kind == "gpkg" else self.osm_lines.exists()

    def __init__(self, fixture=None):
        self.fixture = Path(fixture) if fixture else None
        base = self.fixture / "input" if fixture else None
        if base:
            self.osm_lines = _first_existing(base / "transmission_world.geojsonl.gz",
                                             base / "transmission_world.geojsonl")
            self.sub_points = [base / "substation_points.csv"]
            self.sub_polys = [base / "substation_polygons.geojsonl"]
            self.circuit_srcs = []
            self.out = self.fixture / "analysis"
        else:
            import build_global_tiles
            self.osm_lines = build_global_tiles.TRANSMISSION_KEPT
            self.sub_points = [BUILD_DIR / f"substation_osm_{c}.csv" for c in REGION_CODES]
            self.sub_polys = [BUILD_DIR / f"substation_polygons_{c}.gpkg" for c in REGION_CODES]
            self.circuit_srcs = [BUILD_DIR / f"transmission_lines_{c}.gpkg" for c in REGION_CODES]
            self.out = OUT_DIR


def _first_existing(*paths):
    for p in paths:
        if p.exists():
            return p
    return paths[-1]


def _vsi(path):
    return f"/vsigzip/{path}" if str(path).endswith(".gz") else str(path)


def require_wgs84_2d(path, ds):
    """Stop on an input that is not EPSG:4326 or holds Z coordinates."""
    import pyogrio
    info = pyogrio.read_info(str(path))
    if (info.get("crs") or "").upper() != "EPSG:4326":
        raise SystemExit(f"{ds}: {path} is {info.get('crs')}, not EPSG:4326")
    if "Z" in (info.get("geometry_type") or ""):
        raise SystemExit(f"{ds}: {path} has Z coordinates ({info['geometry_type']})")


def read_lines(path, id_field, columns):
    """(fids, {column: array}, shapely geometries) from an OGR-readable file."""
    import numpy as np
    import pyogrio
    import shapely
    meta, _, wkb, fields = pyogrio.raw.read(_vsi(path), columns=[id_field, *columns])
    cols = dict(zip(meta["fields"], fields))
    geoms = shapely.from_wkb(wkb)
    ok = ~(shapely.is_missing(geoms) | shapely.is_empty(geoms))
    if not ok.all():
        log.warning("  %d features without geometry dropped", int((~ok).sum()))
        geoms = geoms[ok]
        cols = {k: np.asarray(v)[ok] for k, v in cols.items()}
    return np.asarray(cols.pop(id_field)), cols, geoms


def read_circuits(srcs, fids):
    """OSM `circuits` per fid (−1 unknown), first continent wins like the merge."""
    import numpy as np
    import pyogrio
    out = np.full(len(fids), -1, dtype=np.int8)
    order = np.argsort(fids)
    sorted_fids = fids[order]
    filled = np.zeros(len(fids), dtype=bool)
    for src in srcs:
        if not src.exists():
            continue
        meta, _, _, fields = pyogrio.raw.read(str(src), columns=["fid", "circuits"],
                                              read_geometry=False)
        col = dict(zip(meta["fields"], fields))
        f = np.asarray(col["fid"]).astype(np.int64)
        c = np.asarray(col["circuits"], dtype=np.float64)
        c = np.where(np.isfinite(c), c, -1).astype(np.int64)
        pos = np.searchsorted(sorted_fids, f)
        pos = np.clip(pos, 0, len(sorted_fids) - 1)
        hit = sorted_fids[pos] == f
        idx = order[pos[hit]]
        new = ~filled[idx]
        out[idx[new]] = np.clip(c[hit][new], -1, 127).astype(np.int8)
        filled[idx[new]] = True
    return out


def read_substations(points, polys):
    """(point fids, lon, lat), (polygon fids, polygons), first copy of a fid wins.

    The point layer also carries every substation way as its centroid, under
    the polygon's own fid, so each layer dedupes on its own.
    """
    import numpy as np
    import pyogrio
    import shapely
    seen = set()
    pf, px, py = [], [], []
    for src in points:
        if not src.exists():
            continue
        with open(src, newline="", encoding="utf-8") as f:
            for r in csv.DictReader(f):
                try:
                    fid, x, y = int(r["fid"]), float(r["lon"]), float(r["lat"])
                except (KeyError, TypeError, ValueError):
                    continue
                if fid in seen:
                    continue
                seen.add(fid)
                pf.append(fid)
                px.append(x)
                py.append(y)
    gf, gg, seen = [], [], set()
    for src in polys:
        if not src.exists():
            continue
        meta, _, wkb, fields = pyogrio.raw.read(str(src), columns=["fid"])
        for fid, g in zip(fields[0], shapely.from_wkb(wkb)):
            fid = int(fid)
            if g is None or fid in seen:
                continue
            seen.add(fid)
            gf.append(fid)
            gg.append(g)
    return ((np.array(pf, dtype=np.int64), np.array(px), np.array(py)),
            (np.array(gf, dtype=np.int64), np.array(gg, dtype=object)))


def _unit(lon, lat):
    import numpy as np
    lo, la = np.radians(lon), np.radians(lat)
    return np.c_[np.cos(la) * np.cos(lo), np.cos(la) * np.sin(lo), np.sin(la)]


def substation_at_nodes(nx, ny, subs, stats):
    """The substation fid at each node (−1 none): inside a polygon, else the
    nearest point within SUB_POINT_M. Fills `stats` with the hit counts."""
    import numpy as np
    import shapely
    (pf, px, py), (gf, gg) = subs
    out = np.full(len(nx), -1, dtype=np.int64)
    real = np.flatnonzero(np.isfinite(nx) & np.isfinite(ny))
    if len(gf):
        tree = shapely.STRtree(gg)
        node_i, poly_i = tree.query(shapely.points(nx[real], ny[real]), predicate="within")
        out[real[node_i]] = gf[poly_i]
    in_poly = out >= 0
    stats["nodes"] = int(len(real))
    stats["in_polygon"] = int(in_poly.sum())
    if len(pf):
        from scipy.spatial import cKDTree
        free = real[~in_poly[real]]
        dist, i = cKDTree(_unit(px, py)).query(_unit(nx[free], ny[free]))
        metres = 2 * gc.R_KM * 1000 * np.arcsin(np.clip(dist / 2, 0, 1))
        near = metres <= SUB_POINT_M
        out[free[near]] = pf[i[near]]
        stats["near_point"] = int(near.sum())
        stats["nearest_point_m_free_nodes"] = {f"<={m}": int((metres <= m).sum()) for m in NEAR_BINS_M}
    return out


# ── Build ─────────────────────────────────────────────────────────────────────

# The credit a copy of the geometry must carry (the ODbL asks for this wording):
# DATASET[ds]["attribution"].


def provenance(ds):
    """label, source, url, licence from data_manifest.yaml, plus the attribution."""
    out = {"attribution": DATASET[ds]["attribution"]}
    try:
        import yaml
    except ImportError:
        return out
    doc = yaml.safe_load((ROOT / "scripts" / "data_manifest.yaml").read_text())
    entry = (doc.get("layers") or {}).get(ds) or {}
    out.update({k: entry.get(k, "UNKNOWN") for k in ("label", "source", "url", "licence")})
    return out


def snapshot_date(ds, inputs):
    """The OSM replication date of the extracts; None for HIFLD (a frozen copy
    whose files carry no edition date) and for a fixture."""
    if DATASET[ds]["osm"] and not inputs.fixture:
        from build_data_manifest import osm_snapshot_date
        return osm_snapshot_date(ROOT)
    return None


def load_dataset(ds, inputs, scratch):
    """(fids, kv or None, circuits or None, geoms) for one dataset."""
    import numpy as np
    if DATASET[ds]["input"] == "kept":
        srcs = [p for p in inputs.kept_input(ds) if p.exists()]
        if not srcs:
            raise SystemExit(f"{ds}: no input — run `make global-tiles LAYER={ds}` (it keeps the merged input)")
        read = [read_lines(p, "fid", []) for p in srcs]
        return (np.concatenate([r[0] for r in read]).astype(np.int64), None, None,
                np.concatenate([r[2] for r in read]))
    if ds == OSM:
        if not inputs.osm_lines.exists():
            raise SystemExit(f"{inputs.osm_lines} missing — run `make global-tiles "
                             "LAYER=osm_transmission_lines` (it keeps the merged input)")
        newer = [p.name for p in inputs.circuit_srcs
                 if p.exists() and p.stat().st_mtime > inputs.osm_lines.stat().st_mtime]
        if newer:
            log.warning("  continental inputs newer than the kept merge: %s — the tiles and these "
                        "files may disagree until `make global-tiles` reruns", ", ".join(newer))
        cols = ["nominal_kv"] + (["circuits"] if inputs.fixture else [])
        fids, extra, geoms = read_lines(inputs.osm_lines, "fid", cols)
        fids = fids.astype(np.int64)
        kv = np.asarray(extra["nominal_kv"]).astype(np.float64)
        if inputs.fixture:
            circuits = np.clip(np.asarray(extra["circuits"]).astype(np.int64), -1, 127).astype(np.int8)
        else:
            circuits = read_circuits(inputs.circuit_srcs, fids)
        return fids, kv, circuits, geoms
    src = inputs.gpkg_input(ds)
    if not src.exists():
        raise SystemExit(f"{src} missing — {ds} reads the tile build's GeoPackage; build that layer's data first")
    if DATASET[ds].get("exact"):
        require_wgs84_2d(src, ds)
    if src.suffix == ".gpkg" and not DATASET[ds].get("exact"):
        seq = Path(scratch) / f"{ds}.geojsonl"
        subprocess.run(["ogr2ogr", "-f", "GeoJSONSeq", str(seq), str(src), *ogr_options(ds)],
                       check=True)
        src = seq
    import shapely
    fids, _, geoms = read_lines(src, DATASET[ds]["id_field"], [])
    if DATASET[ds].get("exact") and shapely.has_z(geoms).any():
        raise SystemExit(f"{ds}: {src} has Z coordinates")
    return (fids.astype(np.int64) if DATASET[ds]["fid_type"] == "int64" else fids.astype(str)), None, None, geoms


def write_geo(table, gtypes, out_dir, ds, build_id, scratch):
    """Write GEO as parts cut on row-group boundaries; returns manifest entries."""
    import numpy as np
    trial = Path(scratch) / f"{ds}.geo.trial.parquet"
    rows = gc.geo_group_rows(table)
    starts = np.concatenate([[0], np.cumsum(rows)]).tolist()
    gc.write_parquet(table, trial, gc.GEO_PRESET, group_rows=rows)
    parts = gc.plan_parts(gc.row_group_bytes(trial))
    trial.unlink()
    entries = []
    for n, (g0, g1) in enumerate(parts):
        lo, hi = starts[g0], starts[g1]
        part = table.slice(lo, hi - lo)
        bb = part.column("bbox").combine_chunks()
        bounds = [float(np.min(bb.field("xmin"))), float(np.min(bb.field("ymin"))),
                  float(np.max(bb.field("xmax"))), float(np.max(bb.field("ymax")))]
        meta = {"geo": json.dumps(gc.geo_metadata(gtypes, bounds)), "build_id": build_id,
                "dataset": ds, "part": str(n), "row_offset": str(lo)}
        tmp = out_dir / f".{ds}.geo.p{n}.parquet"
        gc.write_parquet(part, tmp, gc.GEO_PRESET, metadata=meta, group_rows=rows[g0:g1])
        path, digest = gc.content_name(tmp, f"{ds}.geo.p{n}")
        if path.stat().st_size > gc.PART_HARD_BYTES:
            raise SystemExit(f"{path.name} is {path.stat().st_size} bytes, over the 95 MiB stop")
        entries.append(gc.file_entry(path, "geo", hi - lo, digest, part=n, row_offset=lo))
        log.info("  ✓ %s  rows %d–%d  %.1f MiB", path.name, lo, hi - 1, path.stat().st_size / 2**20)
    return entries


def build_dataset(ds, inputs, build_id):
    import numpy as np
    import pyarrow as pa
    import shapely
    t0 = time.time()
    out_dir = inputs.out / ds
    out_dir.mkdir(parents=True, exist_ok=True)
    scratch_root = BUILD_DIR if not inputs.fixture else inputs.fixture
    scratch_root.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="line-parquet-", dir=scratch_root) as scratch:
        log.info("=== %s ===", ds)
        fids, kv, circuits, geoms = load_dataset(ds, inputs, scratch)
        n = len(fids)
        if len(np.unique(fids)) != n:
            raise SystemExit(f"{ds}: duplicate fids in the input")
        polygon = DATASET[ds]["geometry"] == "polygon"
        nverts = int(shapely.get_num_coordinates(geoms).sum())
        lengths = None if polygon else gc.line_lengths_km(geoms)
        if polygon:
            log.info("  %d polygons, %d vertices", n, nverts)
        else:
            log.info("  %d lines, %d vertices, %.0f km", n, nverts, lengths.sum())

        cen = shapely.centroid(geoms)
        perm = np.argsort(gc.hilbert_key(shapely.get_x(cen), shapely.get_y(cen)), kind="stable")
        row_of = np.empty(n, dtype=np.int64)
        row_of[perm] = np.arange(n, dtype=np.int64)

        types = GEOMETRY_TYPES[DATASET[ds]["geometry"]]
        found = np.unique(shapely.get_type_id(geoms)).tolist()
        if any(t not in types for t in found):
            raise SystemExit(f"{ds}: geometry type ids {found} are not all {sorted(types.values())}")
        gtypes = [types[t] for t in found]
        fid_arr = pa.array(fids)
        geo = pa.table({"fid": fid_arr.take(pa.array(perm)),
                        "bbox": gc.bbox_array(shapely.bounds(geoms)[perm]),
                        "geometry": pa.array(shapely.to_wkb(geoms[perm]), pa.binary())})
        geo_entries = write_geo(geo, gtypes, out_dir, ds, build_id, scratch)
        del geo

        chain_of = None
        chains_entry, chain_stats = None, {}
        if DATASET[ds]["chains"]:
            chain_of, chains_entry, chain_stats = write_chains(
                out_dir, ds, build_id, fids, kv, geoms, lengths, row_of, perm, inputs)

        cols = {"fid": fid_arr, "row": pa.array(row_of)}
        if not polygon:
            cols["length_km"] = pa.array(lengths.astype(np.float32))
        if DATASET[ds]["chains"]:
            cols["chain"] = pa.array(chain_of)
            cols["circuits"] = pa.array(circuits)
        idx = pa.table(cols)
        idx = idx.take(pa.array(np.argsort(fids, kind="stable")))
        tmp = out_dir / f".{ds}.idx.parquet"
        gc.write_parquet(idx, tmp, gc.IDX_PRESET, metadata={"build_id": build_id, "dataset": ds},
                         sort_columns=["fid"])
        path, digest = gc.content_name(tmp, f"{ds}.idx")
        idx_entry = gc.file_entry(path, "idx", n, digest)
        log.info("  ✓ %s  %.1f MiB", path.name, path.stat().st_size / 2**20)

    manifest = {
        "dataset": ds, "build_id": build_id,
        "built": FIXTURE_BUILT if inputs.fixture else
                 datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "geometry": DATASET[ds]["geometry"],
        "snapshot": snapshot_date(ds, inputs), **provenance(ds),
        "rows": n, "vertices": nverts,
        **({} if polygon else {"total_km": round(float(lengths.sum()), 1)}),
        "fid_type": DATASET[ds]["fid_type"],
        "coordinate_grid_deg": None if DATASET[ds].get("exact") else 1e-6,
        **({} if polygon else {"length": "sphere R=6371.0088 km, haversine per part"}),
        "idx": {**idx_entry, "columns": list(cols)},
        "geo": geo_entries,
        "chains": chains_entry,
    }
    if chain_stats:
        manifest["chain_stats"] = chain_stats
    gc.write_json(out_dir / "_manifest.json", manifest)
    keep = {idx_entry["name"], "_manifest.json", *(e["name"] for e in geo_entries)}
    if chains_entry:
        keep.add(chains_entry["name"])
    for old in out_dir.iterdir():
        if old.name not in keep:
            old.unlink()
            log.info("  removed %s from an earlier build", old.name)
    total = sum(e["bytes"] for e in [idx_entry, *geo_entries, *([chains_entry] if chains_entry else [])])
    log.info("  %s total %.1f MiB in %.0f s", ds, total / 2**20, time.time() - t0)
    return manifest


def write_chains(out_dir, ds, build_id, fids, kv, geoms, lengths, row_of, perm, inputs):
    """CHAINS for OSM; returns (chain id per line, manifest entry, stats)."""
    import numpy as np
    import pyarrow as pa
    import shapely
    t0 = time.time()
    n = len(fids)
    single = shapely.get_type_id(geoms) == 1     # LineString; anything else stays alone
    first = shapely.get_point(geoms, 0)
    last = shapely.get_point(geoms, -1)
    ends = np.c_[shapely.get_x(first), shapely.get_y(first), shapely.get_x(last), shapely.get_y(last)]
    ends = np.where(single[:, None], ends, np.nan)
    keys = np.rint(np.r_[ends[:, :2], ends[:, 2:]] * 1e6)
    ok = np.isfinite(keys).all(axis=1)
    keys = np.where(ok[:, None], keys, 0).astype(np.int64)
    packed = (keys[:, 0] + (1 << 29)) << 30 | (keys[:, 1] + (1 << 29))
    uniq, node = np.unique(packed, return_inverse=True)
    node = node.ravel()
    # A non-LineString gets two private nodes, so it never joins a chain.
    priv = np.flatnonzero(~ok)
    node[priv] = len(uniq) + np.arange(len(priv))
    a, b = node[:n], node[n:]

    nodes_xy = np.r_[ends[:, :2], ends[:, 2:]]
    nx = np.full(len(uniq), np.nan)
    ny = np.full(len(uniq), np.nan)
    nx[node[ok]] = nodes_xy[ok, 0]
    ny[node[ok]] = nodes_xy[ok, 1]
    sub_stats = {}
    subs = read_substations(inputs.sub_points, inputs.sub_polys)
    log.info("  substations: %d points, %d polygons", len(subs[0][0]), len(subs[1][0]))
    sub_at = substation_at_nodes(nx, ny, subs, sub_stats)
    stop = set(np.flatnonzero(sub_at >= 0).tolist())

    kv_list = np.where(np.isfinite(kv), kv, -1).tolist()
    chains, reasons = chain_ways(a.tolist(), b.tolist(), kv_list, stop, order=perm.tolist())
    a_l, b_l = a.tolist(), b.tolist()

    def sub_fid(nd):
        return int(sub_at[nd]) if nd < len(sub_at) and sub_at[nd] >= 0 else None

    chain_of = np.full(n, -1, dtype=np.int64)
    rows = {k: [] for k in ("chain", "seq", "fid", "row", "rev", "length_km", "start_sub", "end_sub")}
    sizes, at_sub, cid = [], 0, 0
    for ch in chains:
        sizes.append(len(ch))
        s_node, e_node = chain_end_nodes(ch, a_l, b_l)
        s_sub, e_sub = sub_fid(s_node), sub_fid(e_node)
        at_sub += (s_sub is not None) + (e_sub is not None)
        if len(ch) == 1 and s_sub is None and e_sub is None:
            continue       # nothing CHAINS would add to IDX
        for seq, (w, rev) in enumerate(ch):
            ws, we = (b_l[w], a_l[w]) if rev else (a_l[w], b_l[w])
            rows["chain"].append(cid)
            rows["seq"].append(seq)
            rows["fid"].append(int(fids[w]))
            rows["row"].append(int(row_of[w]))
            rows["rev"].append(bool(rev))
            rows["length_km"].append(float(lengths[w]))
            rows["start_sub"].append(sub_fid(ws))
            rows["end_sub"].append(sub_fid(we))
            chain_of[w] = cid
        cid += 1
    sizes.sort()
    multi = sum(s for s in sizes if s > 1)
    stats = {
        "chains": len(sizes), "multi_way_chains": sum(1 for s in sizes if s > 1),
        "ways_in_multi_way_chains": multi, "share_ways_in_multi_way_chains": round(multi / n, 4) if n else 0,
        "ways_per_chain": {"p50": percentile(sizes, .5), "p90": percentile(sizes, .9),
                           "p99": percentile(sizes, .99), "max": sizes[-1] if sizes else 0},
        "end_reasons": dict(reasons), "chain_ends_at_substation": at_sub,
        "chains_written": cid, "substation_nodes": sub_stats,
    }
    log.info("  chains: %s", json.dumps(stats))
    table = pa.table({
        "chain": pa.array(rows["chain"], pa.int64()), "seq": pa.array(rows["seq"], pa.int32()),
        "fid": pa.array(rows["fid"], pa.int64()), "row": pa.array(rows["row"], pa.int64()),
        "rev": pa.array(rows["rev"], pa.bool_()),
        "length_km": pa.array(rows["length_km"], pa.float32()),
        "start_sub": pa.array(rows["start_sub"], pa.int64()),
        "end_sub": pa.array(rows["end_sub"], pa.int64()),
    })
    tmp = out_dir / f".{ds}.chains.parquet"
    gc.write_parquet(table, tmp, gc.CHAINS_PRESET, metadata={"build_id": build_id, "dataset": ds},
                     sort_columns=["chain", "seq"])
    path, digest = gc.content_name(tmp, f"{ds}.chains")
    log.info("  ✓ %s  %d rows  %.1f MiB  (%.0f s)", path.name, table.num_rows,
             path.stat().st_size / 2**20, time.time() - t0)
    return chain_of, gc.file_entry(path, "chains", table.num_rows, digest,
                                   columns=table.column_names), stats


def load_index(out):
    """data/analysis/index.json as a dict (a fresh one when absent). One that
    does not parse is refused rather than reset, which would drop the sections
    the other builder wrote."""
    path = out / "index.json"
    if not path.exists():
        return {"version": 1, "datasets": {}}
    try:
        index = json.loads(path.read_text())
    except ValueError as err:
        raise SystemExit(f"{path} does not parse ({err}) — fix or remove it; not overwriting")
    if not isinstance(index, dict):
        raise SystemExit(f"{path} is not a JSON object — fix or remove it; not overwriting")
    index.setdefault("datasets", {})
    return index


def write_index(out, manifests):
    """data/analysis/index.json: every dataset's manifest, paths relative to it.
    Other top-level keys (`columns`) are kept."""
    path = out / "index.json"
    index = load_index(out)
    for m in manifests:
        index["datasets"][m["dataset"]] = {"path": f"{m['dataset']}/", **m}
    index["datasets"] = {k: index["datasets"][k] for k in sorted(index["datasets"])}
    gc.write_json(path, index)
    return index


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0],
                                 formatter_class=argparse.RawDescriptionHelpFormatter, epilog=__doc__)
    ap.add_argument("--only", action="append", choices=DATASETS, help="build one dataset (repeatable)")
    ap.add_argument("--fixture", help="read DIR/input, write DIR/analysis (tests)")
    args = ap.parse_args(argv)
    inputs = Inputs(args.fixture)
    load_index(inputs.out)      # refuse an unparseable index.json before the long build
    build_id = FIXTURE_BUILD_ID if args.fixture else \
        datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ") + "-" + os.urandom(3).hex()
    log.info("build_id %s → %s", build_id, inputs.out)
    todo = args.only or [ds for ds in DATASETS
                         if not (args.fixture and ds in FIXTURE_OPTIONAL and not inputs.has_input(ds))]
    for ds in todo:
        write_index(inputs.out, [build_dataset(ds, inputs, build_id)])
    log.info("✓ %s", inputs.out / "index.json")
    return 0


if __name__ == "__main__":
    sys.exit(main())
