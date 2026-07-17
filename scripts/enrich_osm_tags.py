#!/usr/bin/env python3
"""
enrich_osm_tags.py — Parse the OGR ``other_tags`` blob into dedicated columns.

Reads the intermediate shapefiles written by extract_osm_lines.py and writes
``*_processed.shp`` siblings with structured fields (voltage, operator, etc.).
Skips files whose ``_processed`` sibling already exists.

Lines:      nominal_kv, cables, circuits, frequency, location, operator, op_wikidata, line_type, wires, ref, const
Pipelines:  pipeline, facil_type, substance, operator, op_wikidata  (lines)
            pipeline, operator                                       (points)
"""

import re
import sys
import argparse
from pathlib import Path

import geopandas as gpd
import pandas as pd

# ---------------------------------------------------------------------------
# Field type constants (replaces osgeo.ogr constants)
# ---------------------------------------------------------------------------
OFTInteger   = 'int'
OFTString    = 'str'
OFTReal      = 'float'

# ---------------------------------------------------------------------------
# Regexes for other_tags kv pairs
# ---------------------------------------------------------------------------
T_CABLES   = re.compile(r'"cables"=>"(\d+)"')
T_CIRCUITS = re.compile(r'"circuits"=>"(\d+)"')
T_FREQ     = re.compile(r'"frequency"=>"([^"]+)"')
T_LOCATION = re.compile(r'"location"=>"([^"]+)"')
T_POWER    = re.compile(r'"power"=>"([^"]+)"')
T_LINETYPE = re.compile(r'"line"=>"([^"]+)"')
T_WIRES    = re.compile(r'"wires"=>"([^"]+)"')
T_REF      = re.compile(r'"ref"=>"([^"]+)"')
T_OP_WD    = re.compile(r'"operator:wikidata"=>"([^"]+)"')
T_CONSTR   = re.compile(r'"construction"=>"([^"]+)"')
T_OP       = re.compile(r'"operator"=>"([^"]+)"')
T_VOLTAGE  = re.compile(r'"voltage"=>"([^"]*)"')
T_PIPELINE = re.compile(r'"pipeline"=>"([^"]+)"')
T_SUBSTANCE= re.compile(r'"substance"=>"([^"]+)"')
T_SUBTYPE  = re.compile(r'"substation"=>"([^"]+)"')

# kV value embedded in a line name, e.g. "Beaver–Midway 500kV" or "345 KV Line"
T_KV_IN_NAME = re.compile(r'\b(\d{2,4})\s*[Kk][Vv]\b')


def _get(txt, pat):
    m = pat.search(txt or '')
    return m.group(1) if m else None


def _get_int(txt, pat):
    m = pat.search(txt or '')
    return int(m.group(1)) if m else None



_NUM = re.compile(r'\d+')


def _best_kv(vs):
    """Highest nominal kV in an OSM `voltage` value, or None.

    OSM voltage is always in volts but is written many ways: a plain int
    ("500000"), a ';'-separated list of the circuits on the way
    ("115000;12000"), a range ("14400-24900"), a list with junk tokens
    ("138000;?", "115000;unknown"), or pure junk ("low", "?").  Pull every
    integer out, take the largest, convert volts→kV.  Sub-kV values (480, 240,
    120 — LV service drops) floor to 0 and are reported as unknown rather than
    being mistaken for 480/240/120 kV transmission.

    >>> [_best_kv(v) for v in ('500000', '115000;12000', '14400-24900')]
    [500, 115, 24]
    >>> [_best_kv(v) for v in ('138000;?', 'low', '', None, '480')]
    [138, None, None, None, None]
    """
    kvs = [int(n) // 1000 for n in _NUM.findall(str(vs or ''))]
    kvs = [k for k in kvs if k > 0]
    return max(kvs) if kvs else None


# ---------------------------------------------------------------------------
# Layer processing
# ---------------------------------------------------------------------------

def _process_layer(shp_path, path_out, fdefs, keep_src_fields=None, post_hook=None):
    """Read shp_path, add extra fields from fdefs, write path_out + .csv.

    fdefs: [(name, type_const, parser_fn)]
    keep_src_fields: optional frozenset of lowercase field names to carry forward.
    """
    gdf = gpd.read_file(str(shp_path))
    col_lower = {c.lower(): c for c in gdf.columns}

    # Skip if source already has the first output field (already processed)
    first_out = fdefs[0][0][:10].lower()   # shapefile truncates to 10 chars
    if first_out in col_lower:
        print(f"  [skip] already processed: {path_out.name}")
        return

    # Filter source fields if requested
    if keep_src_fields is not None:
        wanted_lower = set(keep_src_fields) | {'geometry'}
        if 'other_tags' in col_lower:
            wanted_lower.add('other_tags')
        gdf = gdf[[c for c in gdf.columns
                   if c.lower() in wanted_lower or c == 'geometry']]
        col_lower = {c.lower(): c for c in gdf.columns}

    # Detect format: direct property keys (osmium export) vs other_tags (ogr2ogr)
    has_direct_kv = 'voltage' in col_lower

    # Build other_tags series (empty strings when column absent)
    ot_col = col_lower.get('other_tags')
    ot = gdf[ot_col].fillna('') if ot_col else pd.Series([''] * len(gdf), index=gdf.index)

    # Add derived fields
    for name, ftype, parser in fdefs:
        nl = name.lower()
        if has_direct_kv:
            dc = col_lower.get(nl)
            if dc and nl != 'nominal_kv':
                v = gdf[dc]
                if ftype == OFTInteger:
                    gdf[name] = pd.to_numeric(v, errors='coerce').fillna(-1).astype('int32')
                elif ftype == OFTReal:
                    gdf[name] = pd.to_numeric(v, errors='coerce').astype(float)
                else:
                    gdf[name] = v.fillna('').astype(str)
                continue
            if nl == 'nominal_kv':
                vc = col_lower.get('voltage')
                if vc:
                    gdf[name] = gdf[vc].apply(
                        lambda v: _best_kv(v) or -1).astype('int32')
                    continue

        # Parse from other_tags blob
        vals = ot.apply(parser)
        if ftype == OFTInteger:
            gdf[name] = vals.apply(lambda v: v if v is not None else -1).astype('int32')
        elif ftype == OFTReal:
            gdf[name] = pd.to_numeric(vals, errors='coerce').astype(float)
        else:
            gdf[name] = vals.fillna('').astype(str)

    # Compute label points before writing (geometry still intact).
    # representative_point() = a point guaranteed on the feature; unlike centroid
    # it emits no geographic-CRS warning and never falls outside concave shapes.
    ctr = gdf.geometry.representative_point()
    valid_geom = ~(gdf.geometry.is_empty | gdf.geometry.isna())

    # Drop other_tags — already parsed into new fields, no need to carry it forward
    if ot_col and ot_col in gdf.columns:
        gdf = gdf.drop(columns=[ot_col])

    # Apply any layer-specific post-processing (e.g. kv_range for power lines)
    if post_hook is not None:
        gdf = post_hook(gdf)

    # Write GeoPackage (single file, no 10-char column limit unlike Shapefile).
    out_path = path_out.with_suffix('.gpkg')
    # Delete any existing output first (old .shp sidecars + stale .gpkg)
    for f in path_out.parent.glob(path_out.stem + '.*'):
        f.unlink()
    gdf.to_file(str(out_path), driver='GPKG')

    # Write CSV (lon/lat + non-geometry, non-other_tags fields)
    csv_path = path_out.with_suffix('.csv')
    skip_cols = {'geometry'}
    if ot_col:
        skip_cols.add(ot_col)
    csv_cols = [c for c in gdf.columns if c not in skip_cols]

    out_df = gdf[csv_cols].copy()
    lon_series = ctr.x.where(valid_geom).round(6)
    lat_series = ctr.y.where(valid_geom).round(6)
    out_df.insert(0, 'lat', lat_series)
    out_df.insert(0, 'lon', lon_series)
    out_df.to_csv(str(csv_path), index=False)

    print(f"    {len(gdf)} features -> {csv_path.name}")


# ---------------------------------------------------------------------------
# Field definitions (names <= 10 chars for shapefile compat)
# ---------------------------------------------------------------------------
line_fdefs = [
    ("nominal_kv",  OFTInteger,   lambda o: _best_kv(_get(o, T_VOLTAGE)) or -1),
    ("cables",      OFTInteger,   lambda o: _get_int(o, T_CABLES) or -1),
    ("circuits",    OFTInteger,   lambda o: _get_int(o, T_CIRCUITS) or -1),
    ("frequency",   OFTString,  lambda o: _get(o, T_FREQ) or ''),
    ("location",    OFTString,  lambda o: _get(o, T_LOCATION) or ''),
    ("power",       OFTString,  lambda o: _get(o, T_POWER) or ''),
    ("operator",    OFTString,  lambda o: _get(o, T_OP) or ''),
    ("op_wikidata", OFTString,  lambda o: _get(o, T_OP_WD) or ''),
    ("line_type",   OFTString,  lambda o: _get(o, T_LINETYPE) or ''),
    ("wires",       OFTString,  lambda o: _get(o, T_WIRES) or ''),
    ("ref",         OFTString,  lambda o: _get(o, T_REF) or ''),
    ("const",       OFTString,  lambda o: _get(o, T_CONSTR) or ''),
]

# Pipeline facility areas (pipeline=substation, pipeline=aqueduct, pipeline=siphon, etc.)
pipeline_line_fdefs = [
    ("pipeline",    OFTString, lambda o: _get(o, T_PIPELINE) or ''),
    ("facil_type",  OFTString, lambda o: _get(o, T_SUBTYPE) or ''),
    ("substance",   OFTString, lambda o: _get(o, T_SUBSTANCE) or ''),
    ("operator",    OFTString, lambda o: _get(o, T_OP) or ''),
    ("op_wikidata", OFTString, lambda o: _get(o, T_OP_WD) or ''),
]

# Pipeline feature points (valves, pig launchers, delivery points, etc.)
pipeline_pt_fdefs = [
    ("pipeline",    OFTString, lambda o: _get(o, T_PIPELINE) or ''),
    ("operator",    OFTString, lambda o: _get(o, T_OP) or ''),
]

PIPELINE_LINE_FIELDS = frozenset({'osm_id', 'name'})
PIPELINE_PT_FIELDS   = frozenset({'osm_id'})          # 'name' excluded: almost always empty

# Fuel allowlist: only pipelines carrying a fuel that feeds a generator are kept.
# Grouped by generator fuel type; keep in sync with SUBSTANCE_BUCKETS in
# src/colors/buckets.ts. Everything not listed (water, industrial gas,
# petrochemical feedstock, junk tags) is dropped. Matched case-insensitively.
_FUEL_SUBSTANCES = frozenset([
    # natural gas
    "gas", "natural_gas", "cng", "methane", "lng",
    "landfill_gas", "coke_gas", "syngas", "fcc_gas",
    # crude / oil
    "oil", "crude_oil", "petroleum", "condensate",
    # refined products & NGL
    "fuel", "ngl", "lpg", "propane", "butane", "isobutane", "n-butane",
    "liquid_butane", "pentane", "isopentane", "y-grade", "ethane", "naphtha",
    "gasoline", "diesel", "jet_fuel", "kerosene", "hvl", "natural_gasoline",
    "gasoil",
    # hydrogen
    "hydrogen", "liquid_hydrogen",
    # coal
    "coal",
])

def _is_fuel(val: str) -> bool:
    """True if any substance token is a known generator fuel. Handles compound
    OSM values like 'gas;water' (kept — carries fuel). Case-insensitive."""
    toks = [t.strip().lower() for t in re.split(r'[;,]', val or '') if t.strip()]
    return any(t in _FUEL_SUBSTANCES for t in toks)


def _drop_nonfuel(gdf: 'gpd.GeoDataFrame') -> 'gpd.GeoDataFrame':
    """Keep untagged pipelines + any carrying a generator fuel; drop the rest."""
    if 'substance' not in gdf.columns:
        return gdf
    before = len(gdf)
    s = gdf['substance'].fillna('')
    keep = (s.str.strip() == '') | s.map(_is_fuel)
    gdf = gdf[keep].copy()
    dropped = before - len(gdf)
    if dropped:
        print(f"    dropped {dropped} non-fuel pipeline rows")
    return gdf


def _fill_kv_from_name(gdf: 'gpd.GeoDataFrame') -> 'gpd.GeoDataFrame':
    """Backfill nominal_kv from the name field when a kV value appears in the string.

    Matches patterns like: "500kV", "345 kV", "230KV", "Beaver-Midway 500kV Line".
    Only fills rows where nominal_kv is unknown (≤ 0).  Safe to call on any GDF —
    silently no-ops if either column is absent.
    """
    if 'nominal_kv' not in gdf.columns:
        return gdf
    # Find name column (case-insensitive in case the SHP has 'Name' or 'NAME')
    name_col = next((c for c in gdf.columns if c.lower() == 'name'), None)
    if name_col is None:
        return gdf

    kv = pd.to_numeric(gdf['nominal_kv'], errors='coerce')
    unknown = kv <= 0
    if not unknown.any():
        return gdf

    def _extract(name):
        if not name or pd.isna(name) or str(name).strip() in ('', 'nan', 'None'):
            return None
        m = T_KV_IN_NAME.search(str(name))
        if not m:
            return None
        v = int(m.group(1))
        return v if 1 <= v <= 2000 else None

    derived = gdf.loc[unknown, name_col].apply(_extract)
    filled = derived.dropna()
    if filled.empty:
        return gdf

    gdf = gdf.copy()
    gdf.loc[filled.index, 'nominal_kv'] = filled.astype('int32')
    print(f"    kV-from-name: filled {len(filled)} row(s) "
          f"(e.g. {filled.iloc[0]:.0f} kV)")
    return gdf


# HVDC in the line's own name, for ways that never got a frequency tag
# (electrode lines, Finney–Lamar, Highgate).  Deliberately narrow: a bare "DC"
# would match "DC Water" and every "Neptune Sub" in Florida.
_HVDC_NAME = re.compile(r'\bHVDC\b|\bDC\s+Intertie\b|\bbi-?pole\b', re.I)


def _add_is_dc(gdf):
    """Flag HVDC ways.  frequency=0 is the canonical OSM marker (the standard
    also allows a ';'-list like "60;0" for towers carrying both AC and DC
    circuits — those count).  A stated non-zero frequency is authoritative AC;
    only when frequency is absent do we fall back to the name.
    """
    freq = gdf['frequency'].fillna('').astype(str) if 'frequency' in gdf.columns \
        else pd.Series([''] * len(gdf), index=gdf.index)
    parts = freq.str.split(';')

    def _num(p):
        try:
            return float(p.strip())
        except ValueError:
            return -1.0

    def _has_zero(ps):
        return any(_num(p) == 0 for p in ps)

    def _has_ac(ps):
        return any(_num(p) > 0 for p in ps)

    has_dc_freq = parts.apply(_has_zero)
    has_ac_freq = parts.apply(_has_ac)
    name = gdf['name'].fillna('').astype(str) if 'name' in gdf.columns \
        else pd.Series([''] * len(gdf), index=gdf.index)
    name_dc = name.str.contains(_HVDC_NAME)

    gdf['is_dc'] = (has_dc_freq | (~has_ac_freq & name_dc)).astype('int32')
    print(f"    is_dc: {int(gdf['is_dc'].sum())} DC way(s) "
          f"({int(has_dc_freq.sum())} by frequency, "
          f"{int((~has_dc_freq & gdf['is_dc'].astype(bool)).sum())} by name)")
    return gdf


def _add_kv_range(gdf):
    """Add kv_range bucket column derived from nominal_kv for transmission line styling.

    Buckets use left-closed intervals [low, high):
      0-50    gray    (distribution)
      50-100  black
      100-200 orange
      200-300 blue
      300-400 green
      400-500 (colour TBD)
      500-600 red     (common US high-voltage)
      600+    (colour TBD — 765 kV EHV lines)
      unknown — nominal_kv absent, zero, or -1
    """
    if 'nominal_kv' not in gdf.columns:
        return gdf

    kv = pd.to_numeric(gdf['nominal_kv'], errors='coerce')
    kv_pos = kv.where(kv > 0)          # mask -1 / 0 / NaN → treated as unknown

    cats = pd.cut(
        kv_pos,
        bins=[0, 50, 100, 200, 300, 400, 500, 600, float('inf')],
        labels=['0-50', '50-100', '100-200', '200-300',
                '300-400', '400-500', '500-600', '600+'],
        right=False,                    # [left, right) — 500 kV lands in '500-600'
    )
    gdf['kv_range'] = cats.cat.add_categories('unknown').fillna('unknown').astype(str)
    return gdf


def find_shps(d, pattern, skip="_processed"):
    out = []
    for f in sorted(Path(d).glob(pattern)):
        if skip not in f.stem:
            out.append(f)
    return out


def main():
    ap = argparse.ArgumentParser(
        description="Enrich OSM SHPs: parse other_tags into typed columns")
    ap.add_argument("dir", nargs="?", default="data/build")
    args = ap.parse_args()
    d = Path(args.dir)
    if not d.is_dir():
        print(f"ERROR: {d} not found")
        sys.exit(1)

    # Process the layers extract_osm_lines.py produces for final outputs:
    #   - power_line   → transmission_lines.shp
    #   - pipeline     → pipeline_routes.shp
    #   - pipeline_feature → pipeline_points.csv
    def _line_post_hook(gdf):
        """Fill kV from name, bucket into kv_range, derive is_undergrnd/is_dc."""
        gdf = _fill_kv_from_name(gdf)
        gdf = _add_kv_range(gdf)
        gdf = _add_is_dc(gdf)
        gdf["is_undergrnd"] = (
            (gdf["power"] == "cable")
            | gdf["location"].isin(["underground", "underwater"])
        ).astype("int32")
        gdf = gdf.drop(columns=["power"])
        return gdf

    jobs = [
        ("Power lines",       "power_line*lines.shp",          line_fdefs,          None,                 _line_post_hook),
        ("Pipeline routes",   "pipeline_lines.shp",            pipeline_line_fdefs, PIPELINE_LINE_FIELDS, _drop_nonfuel),
        ("Pipeline features", "pipeline_feature_lines.shp",    pipeline_line_fdefs, PIPELINE_LINE_FIELDS, None),
        ("Pipeline feat pts", "pipeline_feature_points.shp",   pipeline_pt_fdefs,   PIPELINE_PT_FIELDS,   None),
    ]

    for label, pat, fdefs, keep_src, post_hook in jobs:
        files = find_shps(d, pat)
        if not files:
            print(f"  [{label}] no matching files")
            continue
        for shp in files:
            out = shp.parent / f"{shp.stem}_processed{shp.suffix}"
            print(f"  [{label}] {shp.name} -> {out.name}")
            try:
                _process_layer(shp, out, fdefs, keep_src, post_hook=post_hook)
            except Exception as e:
                print(f"    ERROR: {e}")

    print("Done.")


if __name__ == "__main__":
    main()
