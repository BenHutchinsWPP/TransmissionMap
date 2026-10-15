"""Shared helpers for the OSM extract scripts (substations, generators, plants,
data centers, lines and pipelines), including `osm_fid`, the stable feature id
every OSM intermediate and world layer carries."""

import glob
import logging
import os
import re
import shutil
import subprocess
import sys

log = logging.getLogger(__name__)


def _run(cmd, desc="", check=True):
    log.debug("  $ %s", " ".join(str(c) for c in cmd))
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        msg = f"{desc or cmd[0]} failed:\n{r.stderr[:600]}"
        if check:
            log.error(msg)
            sys.exit(1)
        log.warning(msg)
        return False
    return True


def _has(tool):
    return shutil.which(tool) is not None


# Tags every OSM extract script needs, unioned into the ONE osmium tags-filter
# pass run by extract_osm_lines.py. Its filtered intermediate then serves
# substations/generators/plants/datacenters too (via find_pbf need_tags below),
# so the multi-GB continental pbf is scanned once per pipeline run, not five times.
# Adding a new extract script? Add its tags here AND pass them as need_tags.
SHARED_FILTER_TAGS = [
    "power=substation",
    "power=generator",
    "power=plant",
    "telecom=data_center",
    "telecom=data_centre",
    "building=data_center",
    "building=data_centre",
]


# Stable feature id. OSM numbers nodes, ways and relations separately, so node
# 123 and way 123 are different features; `fid` packs the type into the last
# decimal digit: fid = osm_id * 10 + digit (1 node, 2 way, 3 relation). The
# digit keeps it readable (4535892832 is way 453589283) and the largest id
# (~1.4e11) stays far below 2**53, so it is exact in JavaScript and in
# tippecanoe's integer feature ids. Built in the extracts, so data/build/
# carries it; build_global_tiles.py dedupes the seam copies on it.
OSM_TYPE_DIGIT = {"node": 1, "way": 2, "relation": 3}
_DIGIT_TYPE = {d: t for t, d in OSM_TYPE_DIGIT.items()}

# GeoPackage reserves `fid` for its own primary key, so an intermediate that
# carries the `fid` column names its primary key `ogc_fid` instead:
# `gdf.to_file(path, driver="GPKG", layer_options=GPKG_FID_OPTIONS)`.
GPKG_FID_OPTIONS = {"FID": "ogc_fid"}


def osm_fid(osm_id, osm_type):
    """The stable feature id of one OSM element: osm_id * 10 + type digit."""
    return int(osm_id) * 10 + OSM_TYPE_DIGIT[osm_type]


def osm_ref(fid):
    """Decode a fid back to (osm_type, osm_id)."""
    fid = int(fid)
    return _DIGIT_TYPE[fid % 10], fid // 10


def add_fid(df):
    """Set a nullable-integer `fid` column from a frame's `osm_id` and `osm_type`."""
    import pandas as pd
    ids = pd.to_numeric(df["osm_id"], errors="coerce").astype("Int64")
    df["fid"] = ids * 10 + df["osm_type"].map(OSM_TYPE_DIGIT).astype("Int64")
    return df


def find_pbf(input_dir, need_tags=None, build_dir="data/build"):
    """Return the first non-nested PBF in input_dir (prefers a single _filtered file).

    With ``need_tags``, first look in build_dir for a filtered intermediate
    (written by extract_osm_lines.py) whose ``.filters`` sidecar proves it was
    filtered with every needed tag and that is no older than the raw pbf —
    otherwise fall back to the full pbf. The sidecar check is what makes reuse
    safe: a filtered file built with different tags silently drops features.
    """
    all_pbf = sorted(glob.glob(os.path.join(input_dir, "*.osm.pbf")))
    originals = [f for f in all_pbf if "_filtered" not in os.path.basename(f)]
    if need_tags:
        newest_src = max((os.path.getmtime(f) for f in originals), default=0)
        for f in sorted(glob.glob(os.path.join(build_dir, "*_filtered.osm.pbf"))):
            sidecar = f + ".filters"
            if not os.path.exists(sidecar):
                continue
            with open(sidecar) as fh:
                have = set(fh.read().split())
            if set(need_tags) <= have and os.path.getmtime(f) >= newest_src:
                log.info("Reusing shared filtered pbf: %s", f)
                return f
    single_filtered = [f for f in all_pbf
                       if re.search(r'_filtered(?!.*_filtered)', os.path.basename(f))]
    if single_filtered:
        return single_filtered[0]
    if originals:
        return originals[0]
    return all_pbf[0] if all_pbf else None


def parse_output_mw(val):
    """Parse OSM ``*:output:electricity`` strings → float MW (or None)."""
    if not val or str(val).strip().lower() in ("", "yes", "no"):
        return None
    val = str(val).strip()
    m = re.match(r"([\d,.]+)\s*(MW|kW|GW|W)?", val, re.IGNORECASE)
    if not m:
        return None
    try:
        n = float(m.group(1).replace(",", ""))
    except ValueError:
        return None
    unit = (m.group(2) or "MW").upper()
    if unit == "GW":
        return n * 1000
    if unit == "KW":
        return n / 1000
    if unit == "W":
        return n / 1_000_000
    return n


def normalise_plant_source(raw):
    """Map OSM ``plant:source`` values → canonical fuel strings matching the
    OSM ``source`` (generator) convention. Picks the dominant fuel for
    semicolon-separated multi-fuel plants."""
    raw = (raw or "").strip().lower().split(";")[0].strip()
    mapping = {
        "wind":        "wind",
        "solar":       "solar",
        "hydro":       "hydro",
        "water":       "hydro",
        "nuclear":     "nuclear",
        "coal":        "coal",
        "gas":         "gas",
        "natural_gas": "gas",
        "oil":         "oil",
        "petroleum":   "oil",
        "diesel":      "oil",
        "geothermal":  "geothermal",
        "biomass":     "biomass",
        "biofuel":     "biomass",
        "waste":       "biomass",
        "storage":     "battery",
        "battery":     "battery",
    }
    return mapping.get(raw, raw)
