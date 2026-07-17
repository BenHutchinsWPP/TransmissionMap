#!/usr/bin/env python3
"""Live weather mosaic sourced from NOAA/NCEP GFS (0.25 deg, atmos pgrb2 files).

Emits, per variable, into the output DIRECTORY (-o):

  <var>.webp   baked-color display raster. Cropped to lon -170..-50, lat
               15..75, upsampled 4x (cubic; 0.25 deg native is blocky —
               smooth the image only, not the LUT), then warped to Web
               Mercator rows so the lon/lat-cornered image source registers.
  <var>.i16    flat Int16 grid of value x scale at NATIVE 0.25 deg on the
               cropped grid — the hover-readout LUT (see
               assets/raster-probes.ts). NoData = -32768.
  wind_uv.png  wind-only extra: native-res RGB PNG, u in R / v in G, linearly
               offset-encoded over [-40, +40] m/s (webgl-wind convention).
               The particle field consumed by assets/weather-particles.ts.
  meta.json    one shared sidecar: run_utc / step / valid_utc /
               generated_utc / feed_status / per-variable {width, height,
               bbox, scale, nodata, units} (wind also carries uv_min/uv_max),
               plus `steps`: the time-slider list [{step, valid_utc, suffix}]
               — suffix "" is the base "now" step above; non-base steps land
               in <var>_<step>h.webp / wind_uv_<step>h.png /
               <var>_<step>h.i16.gz (gzipped hover LUTs).

Seven variables ship: temp, wind, gust, rh, dewpoint, cloud, pressure. Some
are a single GRIB param (temp/gust/dewpoint/cloud/pressure); wind is derived
from two params (10u, 10v); rh is derived from two params (2t, 2d) via the
Magnus formula. RAW_SPECS fetches each underlying GRIB param exactly once —
2t is shared by temp and rh, 2d is shared by dewpoint and rh — then VARIABLES
combines the raw grids into the seven dropdown values. A later phase can add
more raw params / variables without touching the fetch/crop/bake mechanics.

Source: https://noaa-gfs-bdp-pds.s3.amazonaws.com/gfs.{YYYYMMDD}/{HH}/atmos/
gfs.t{HH}z.pgrb2.0p25.f{FFF} — NOAA/NCEP's public anonymous S3 mirror of the
operational GFS 0.25 deg run, no key required. License: US government work,
public domain; courtesy credit to NOAA/NCEP.

Runs 00/06/12/18 UTC, steps HOURLY f000..f120, each
step a separate file, published ~3.5-4.5 h after cycle time. Per-step index
`...f{FFF}.idx` is TEXT lines `n:offset:d=YYYYMMDDHH:PARAM:LEVEL:fcst
descriptor:` (no explicit length) -> a record's byte range is
[its offset, next line's offset - 1], and the last record in the file is an
open-ended range (`bytes=offset-`).

Run/step selection: walk cycles newest-first (18/12/06/00, previous day...).
Use the first cycle whose index for the hourly step nearest "now" returns
HTTP 200 and contains EVERY raw param (step 0 is valid — GFS publishes all
seven variables, including gust, at f000), so every variable comes from the
same model cycle; if no cycle qualifies, fall back to the newest cycle with
a fetchable index and degrade the missing params per-variable.

GRIB decode note verified in-script: ecCodes' `codes_get_values()` for this
grid, reshaped to (721, 1440), comes back with longitude running 0..359.75
ascending (GFS convention). The flat
array is rolled with `np.roll(values, 720, axis=1)` so column 0 becomes
longitude -180, THEN it lines up with lon = -180 + 0.25*i (i=0..1439) and
lat = 90 - 0.25*j (j=0..720) exactly as before; verified against three
reference cities below every run.

GRIB units verified live against the NOAA S3 mirror (see RAW_SPECS): 2t/2d =
K, 10u/10v/10fg = "m s**-1", tcc = "%" (percent, not a 0-1 fraction),
msl = Pa. Asserted, not assumed, on every decode.

Degrades per-variable: a raw param fetch failure marks that param "failed";
every variable depending on it is marked "failed" too and its prior output
files are left untouched, but variables whose deps all succeeded still
publish. Exits 0 either way — a dead upstream should not break the cron job.
"""
import argparse
import gzip
import io
import json
import sys
import threading
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path

import eccodes
import numpy as np
from PIL import Image
from scipy import ndimage

sys.path.insert(0, str(Path(__file__).parent))
from geo_common import write_json_atomic  # noqa: E402

# ─── Upstream ──────────────────────────────────────────────────────────────
GFS_BASE = "https://noaa-gfs-bdp-pds.s3.amazonaws.com"
CYCLE_HOURS = (0, 6, 12, 18)
STEP_INTERVAL_H = 1
MAX_STEP_H = 120
BACK_HOURS = 6      # time-slider range baked before the base "now" step
FORWARD_HOURS = 24  # …and beyond it (all steps come from the same model run)
MAX_CYCLES_BACK = 16  # ~4 days; the newest published cycle wins almost always

# ─── Output grid ───────────────────────────────────────────────────────────
# Native GFS grid, global 0.25 deg, 1440x721.
NATIVE_W, NATIVE_H = 1440, 721
LON = -180.0 + 0.25 * np.arange(NATIVE_W)   # ascending, -180..179.75
LAT = 90.0 - 0.25 * np.arange(NATIVE_H)     # descending, 90..-90

# Crop: US + Canada + margin.
CROP_WEST, CROP_EAST, CROP_SOUTH, CROP_NORTH = -170.0, -50.0, 15.0, 75.0
UPSAMPLE = 4  # display-raster cubic upsample factor; LUT stays native res

LUT_NODATA = -32768
UV_MIN, UV_MAX = -40.0, 40.0  # wind_uv.png offset-encoding range, m/s

# ─── Color ramps ─────────────────────────────────────────────────────────────
# Every ramp below MUST stay identical (value-for-value) to its mirror in
# src/colors/ramps.ts — the bake and the legend gradient are the same scale.
TEMP_RAMP = [
    (-30, (37, 52, 148)),
    (-20, (44, 127, 184)),
    (-10, (65, 182, 196)),
    (0,   (161, 218, 180)),
    (10,  (255, 255, 178)),
    (20,  (254, 204, 92)),
    (30,  (253, 141, 60)),
    (40,  (227, 26, 28)),
    (45,  (128, 0, 38)),
]

# Wind & gust share this ramp — 0..30 m/s, matching Ventusky's wind scale:
# dark gray (calm) -> deep purple -> dark blue -> blue -> blue-green -> green
# -> yellow -> orange -> red. Stops anchored at 5-mph steps in m/s.
WIND_RAMP = [
    (0,    (70, 72, 80)),
    (2.2,  (90, 55, 135)),
    (4.5,  (55, 65, 165)),
    (6.7,  (65, 120, 200)),
    (8.9,  (70, 175, 170)),
    (11.2, (85, 185, 90)),
    (13.4, (170, 200, 70)),
    (15.6, (230, 215, 70)),
    (17.9, (240, 165, 50)),
    (22.4, (235, 90, 55)),
    (26.8, (210, 55, 100)),
    (30,   (170, 35, 105)),
]

# Relative humidity — 0..100 %, dry brown/tan -> humid deep blue-green.
RH_RAMP = [
    (0,   (140, 81, 10)),
    (25,  (191, 129, 45)),
    (50,  (223, 194, 125)),
    (75,  (128, 205, 193)),
    (100, (1, 102, 94)),
]

# Cloud cover — 0..100 %, clear sky blue -> overcast light gray/white.
CLOUD_RAMP = [
    (0,   (135, 206, 235)),
    (25,  (173, 216, 230)),
    (50,  (200, 200, 205)),
    (75,  (220, 220, 220)),
    (100, (245, 245, 245)),
]

# Mean sea level pressure — 960..1050 mb, low deep purple/blue -> high warm orange.
PRESSURE_RAMP = [
    (960,  (84, 39, 143)),
    (983,  (69, 117, 180)),
    (1005, (255, 255, 191)),
    (1028, (253, 174, 97)),
    (1050, (241, 105, 19)),
]

# ─── Raw GRIB params ─────────────────────────────────────────────────────────
# One entry per underlying GRIB record. Fetched at most once per run even
# when more than one dropdown variable depends on it (2t: temp+rh; 2d:
# dewpoint+rh). `param`/`level` are the exact idx PARAM/LEVEL fields
# (`n:offset:d=YYYYMMDDHH:PARAM:LEVEL:fcst descriptor:`) used to locate the
# record. `expected_units` is a tuple of acceptable GRIB `units` strings —
# asserted, and `to_si` branches on the actual string when more than one is
# legal.
RAW_SPECS = {
    "2t": {
        "param": "TMP", "level": "2 m above ground", "expected_units": ("K",),
        "to_si": lambda v, u: v - 273.15, "si_units": "degC",
    },
    "2d": {
        "param": "DPT", "level": "2 m above ground", "expected_units": ("K",),
        "to_si": lambda v, u: v - 273.15, "si_units": "degC",
    },
    "10u": {
        "param": "UGRD", "level": "10 m above ground", "expected_units": ("m s**-1",),
        "to_si": lambda v, u: v, "si_units": "m/s",
    },
    "10v": {
        "param": "VGRD", "level": "10 m above ground", "expected_units": ("m s**-1",),
        "to_si": lambda v, u: v, "si_units": "m/s",
    },
    "10fg": {
        "param": "GUST", "level": "surface", "expected_units": ("m s**-1",),
        "to_si": lambda v, u: v, "si_units": "m/s",
    },
    "tcc": {
        "param": "TCDC", "level": "entire atmosphere", "expected_units": ("%",),
        "to_si": lambda v, u: v, "si_units": "%",
    },
    "msl": {
        "param": "PRMSL", "level": "mean sea level", "expected_units": ("Pa",),
        "to_si": lambda v, u: v / 100.0, "si_units": "mb",
    },
}


def _rh_from_t_td(t_degc, td_degc):
    """Magnus formula, T/Td in degC -> relative humidity in % (0-100)."""
    def es(tc):
        return np.exp(17.625 * tc / (243.04 + tc))
    rh = 100.0 * es(td_degc) / es(t_degc)
    return np.clip(rh, 0.0, 100.0)


def _wind_speed(u, v):
    return np.hypot(u, v)


# ─── Variable table (data, not code) ────────────────────────────────────────
# One entry per dropdown variable, in dropdown order. `deps` are RAW_SPECS
# keys; `combine` assembles the variable's SI-unit grid from the already-
# fetched+cropped raw grids (dict keyed by raw param name).
VARIABLES = {
    "temp": {
        "deps": ["2t"], "combine": lambda d: d["2t"],
        "si_units": "degC", "scale": 10, "ramp": TEMP_RAMP,
    },
    "wind": {
        "deps": ["10u", "10v"], "combine": lambda d: _wind_speed(d["10u"], d["10v"]),
        "si_units": "m/s", "scale": 10, "ramp": WIND_RAMP,
    },
    "gust": {
        "deps": ["10fg"], "combine": lambda d: d["10fg"],
        "si_units": "m/s", "scale": 10, "ramp": WIND_RAMP,
    },
    "rh": {
        "deps": ["2t", "2d"], "combine": lambda d: _rh_from_t_td(d["2t"], d["2d"]),
        "si_units": "%", "scale": 10, "ramp": RH_RAMP,
    },
    "dewpoint": {
        "deps": ["2d"], "combine": lambda d: d["2d"],
        "si_units": "degC", "scale": 10, "ramp": TEMP_RAMP,
    },
    "cloud": {
        "deps": ["tcc"], "combine": lambda d: d["tcc"],
        "si_units": "%", "scale": 10, "ramp": CLOUD_RAMP,
    },
    "pressure": {
        "deps": ["msl"], "combine": lambda d: d["msl"],
        "si_units": "mb", "scale": 10, "ramp": PRESSURE_RAMP,
    },
}

# Sanity-check cities: (name, lat, lon) — printed every run so a Kelvin leak
# (~280-310) or an all-zero grid is obvious at a glance, not just in CI logs.
CHECK_CITIES = [
    ("Reno NV", 39.50, -119.77),
    ("Denver CO", 39.74, -104.99),
    ("Toronto ON", 43.65, -79.38),
]


def http_get(url, headers=None, timeout=120):
    req = urllib.request.Request(url, headers=headers or {})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


# ─── Run/step selection ──────────────────────────────────────────────────────
def cycles_newest_first(now, max_back):
    cyc_hour = max(h for h in CYCLE_HOURS if h <= now.hour)
    cycle = now.replace(hour=cyc_hour, minute=0, second=0, microsecond=0)
    all_cycles = []
    c = cycle
    while len(all_cycles) < max_back:
        all_cycles.append(c)
        idx = CYCLE_HOURS.index(c.hour)
        if idx == 0:
            c = (c - timedelta(days=1)).replace(hour=CYCLE_HOURS[-1])
        else:
            c = c.replace(hour=CYCLE_HOURS[idx - 1])
    return all_cycles


def nearest_step(cycle, now):
    diff_h = (now - cycle).total_seconds() / 3600.0
    step = int(round(diff_h / STEP_INTERVAL_H)) * STEP_INTERVAL_H
    step = max(step, 0)
    step = min(step, MAX_STEP_H)
    return step


def base_url(cycle, step):
    yyyymmdd = cycle.strftime("%Y%m%d")
    hh = cycle.strftime("%H")
    fff = f"{step:03d}"
    return f"{GFS_BASE}/gfs.{yyyymmdd}/{hh}/atmos/gfs.t{hh}z.pgrb2.0p25.f{fff}"


def parse_idx(text):
    """Parse a GFS `.idx` text file into records with byte ranges.

    Each line is `n:offset:d=YYYYMMDDHH:PARAM:LEVEL:fcst descriptor:` — no
    explicit length, so a record's end offset is the next line's offset - 1;
    the last record in the file is open-ended (`bytes=offset-`)."""
    lines = [ln for ln in text.splitlines() if ln.strip()]
    recs = []
    for ln in lines:
        parts = ln.split(":")
        recs.append({"offset": int(parts[1]), "param": parts[3], "level": parts[4]})
    for i, rec in enumerate(recs):
        rec["end"] = recs[i + 1]["offset"] - 1 if i + 1 < len(recs) else None
    return recs


def fetch_index(cycle, step):
    url = base_url(cycle, step) + ".idx"
    raw = http_get(url, timeout=30).decode()
    return parse_idx(raw)


def find_record(records, param, level):
    for rec in records:
        if rec.get("param") == param and rec.get("level") == level:
            return rec
    return None


def select_cycle(now):
    """Walk cycles newest-first; the first whose index for the step nearest
    "now" fetches and contains every RAW_SPECS param wins, so every variable
    comes from the same model cycle. If no cycle has all params (e.g. mid-
    publication), fall back to the newest cycle with a fetchable index and
    let the missing params degrade per-variable.
    -> (cycle, step, records) or (None, None, None)."""
    needed = [(RAW_SPECS[p]["param"], RAW_SPECS[p]["level"]) for p in RAW_SPECS]
    fallback = None
    for cycle in cycles_newest_first(now, MAX_CYCLES_BACK):
        step = nearest_step(cycle, now)
        try:
            records = fetch_index(cycle, step)
        except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError) as e:
            print(f"  {cycle:%Y-%m-%d %HZ} step f{step:03d}: no index ({e})")
            continue
        missing = [p for p, lv in needed if find_record(records, p, lv) is None]
        if not missing:
            print(f"  using {cycle:%Y-%m-%d %HZ} step f{step:03d}")
            return cycle, step, records
        print(f"  {cycle:%Y-%m-%d %HZ} step f{step:03d}: missing {missing}")
        if fallback is None:
            fallback = (cycle, step, records)
    if fallback is not None:
        cycle, step, _ = fallback
        print(f"  no cycle has every param; falling back to "
              f"{cycle:%Y-%m-%d %HZ} step f{step:03d}")
        return fallback
    return None, None, None


# ─── GRIB fetch + decode ──────────────────────────────────────────────────────
# ecCodes' C library is not guaranteed thread-safe; phase 3 fetches steps from
# a thread pool, so the decode section is serialized (the HTTP fetch and the
# numpy/PIL bake work run concurrently).
_ECCODES_LOCK = threading.Lock()


def fetch_grib_values(cycle, step, rec, expected_units, to_si):
    url = base_url(cycle, step)
    start = rec["offset"]
    range_hdr = f"bytes={start}-{rec['end']}" if rec["end"] is not None else f"bytes={start}-"
    raw = http_get(url, headers={"Range": range_hdr})
    print(f"  fetched {len(raw) / 1e6:.1f} MB GRIB record")
    with _ECCODES_LOCK:
        gid = eccodes.codes_new_from_message(raw)
        try:
            units = eccodes.codes_get(gid, "units")
            short_name = eccodes.codes_get(gid, "shortName")
            ni = eccodes.codes_get(gid, "Ni")
            nj = eccodes.codes_get(gid, "Nj")
            print(f"  shortName={short_name} units={units} grid={ni}x{nj}")
            assert units in expected_units, (
                f"expected GRIB units one of {expected_units!r}, got {units!r} — "
                "upstream units changed, conversion below is now wrong"
            )
            assert (ni, nj) == (NATIVE_W, NATIVE_H), f"unexpected grid size {ni}x{nj}"
            raw_values = eccodes.codes_get_values(gid).reshape(NATIVE_H, NATIVE_W)
            # GFS longitudes run 0..359.75 ascending; roll so column 0 becomes
            # longitude -180, matching the LON/LAT arrays below (see docstring).
            raw_values = np.roll(raw_values, NATIVE_W // 2, axis=1)
        finally:
            eccodes.codes_release(gid)
    return to_si(raw_values, units)


# ─── Crop / upsample / bake ───────────────────────────────────────────────────
def crop_indices():
    lon_mask = (LON >= CROP_WEST) & (LON <= CROP_EAST)
    lat_mask = (LAT >= CROP_SOUTH) & (LAT <= CROP_NORTH)
    return np.where(lat_mask)[0], np.where(lon_mask)[0]


def crop(values):
    lat_idx, lon_idx = crop_indices()
    return values[np.ix_(lat_idx, lon_idx)], LAT[lat_idx], LON[lon_idx]


def colorize(vals, ramp):
    xs = np.array([s[0] for s in ramp], dtype="float32")
    cols = np.array([s[1] for s in ramp], dtype="float32")
    valid = np.isfinite(vals)
    v = np.clip(np.where(valid, vals, xs[0]), xs[0], xs[-1])
    rgba = np.zeros((*vals.shape, 4), dtype="uint8")
    for ch in range(3):
        rgba[..., ch] = np.interp(v, xs, cols[:, ch]).round().astype("uint8")
    rgba[..., 3] = np.where(valid, 255, 0).astype("uint8")
    return rgba


def to_web_mercator_rows(rgba, lat_top, lat_bot):
    """Resample rows from equirectangular (linear in latitude) to Web Mercator
    (linear in Mercator-y). The .webp is placed by lon/lat corners in a
    MapLibre image source, which stretches it linearly in EPSG:3857 — an
    unwarped plate-carree image drifts N-S, worst toward the poles."""
    H, W = rgba.shape[:2]
    merc = lambda lat: np.log(np.tan(np.pi / 4 + np.radians(lat) / 2))
    y = np.linspace(merc(lat_top), merc(lat_bot), H)
    lat = np.degrees(2 * np.arctan(np.exp(y)) - np.pi / 2)
    src_row = (lat_top - lat) / (lat_top - lat_bot) * (H - 1)
    rows = np.repeat(src_row[:, None], W, axis=1)
    cols = np.repeat(np.arange(W)[None, :], H, axis=0)
    out = np.empty_like(rgba)
    for ch in range(rgba.shape[2]):
        out[..., ch] = ndimage.map_coordinates(rgba[..., ch], [rows, cols],
                                                order=1, mode="nearest")
    return out


def bake_image(vals_native, ramp, path, quality=85):
    """Upsample the value grid (cubic), colorize, then warp to Web Mercator —
    smooths the image, never the LUT."""
    upsampled = ndimage.zoom(vals_native, UPSAMPLE, order=3)
    rgba = to_web_mercator_rows(colorize(upsampled, ramp), CROP_NORTH, CROP_SOUTH)
    buf = io.BytesIO()
    Image.fromarray(rgba, "RGBA").save(buf, "WEBP", quality=quality)
    tmp = path.with_suffix(".webp.tmp")
    tmp.write_bytes(buf.getvalue())
    tmp.replace(path)
    h, w = upsampled.shape
    print(f"Wrote {path}  {w}x{h}  {path.stat().st_size / 1024:.0f} KB")


def write_lut(vals_native, scale, path):
    """Int16 hover grid. A path ending .i16.gz is gzip-compressed (used for
    the per-step LUTs — smooth fields shrink ~4x, and the frontend
    decompresses via DecompressionStream)."""
    lut = np.where(np.isfinite(vals_native),
                   np.round(np.nan_to_num(vals_native) * scale), LUT_NODATA)
    lut = lut.astype("int16")
    raw = lut.tobytes()
    if path.name.endswith(".gz"):
        raw = gzip.compress(raw, 6)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_bytes(raw)
    tmp.replace(path)
    h, w = vals_native.shape
    print(f"Wrote {path}  {w}x{h}  {path.stat().st_size / 1024:.0f} KB")


def bake_wind_uv(u_native, v_native, path):
    """Native-res RGB(A) PNG for the particle field: u -> R, v -> G, linearly
    offset-encoded over [UV_MIN, UV_MAX] m/s (webgl-wind convention). B is
    unused; alpha is 255 where both components are finite, else 0."""
    valid = np.isfinite(u_native) & np.isfinite(v_native)

    def enc(x):
        x = np.clip(np.nan_to_num(x), UV_MIN, UV_MAX)
        return np.round((x - UV_MIN) / (UV_MAX - UV_MIN) * 255.0).astype("uint8")

    rgba = np.zeros((*u_native.shape, 4), dtype="uint8")
    rgba[..., 0] = enc(u_native)
    rgba[..., 1] = enc(v_native)
    rgba[..., 2] = 0
    rgba[..., 3] = np.where(valid, 255, 0).astype("uint8")
    buf = io.BytesIO()
    Image.fromarray(rgba, "RGBA").save(buf, "PNG")
    tmp = path.with_suffix(".png.tmp")
    tmp.write_bytes(buf.getvalue())
    tmp.replace(path)
    h, w = u_native.shape
    print(f"Wrote {path}  {w}x{h}  {path.stat().st_size / 1024:.0f} KB "
          f"(encoding {UV_MIN}..{UV_MAX} m/s)")


def sample_lut(vals_native, lat_arr, lon_arr, lat, lon):
    i = int(np.argmin(np.abs(lat_arr - lat)))
    j = int(np.argmin(np.abs(lon_arr - lon)))
    return float(vals_native[i, j])


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                  formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("-o", "--output", default="data/layers/weather_live",
                     help="Output DIRECTORY for <var>.{webp,i16}, wind_uv.png and meta.json")
    args = ap.parse_args()
    outdir = Path(args.output)
    outdir.mkdir(parents=True, exist_ok=True)

    meta_path = outdir / "meta.json"
    prev_meta = {}
    if meta_path.exists():
        try:
            prev_meta = json.loads(meta_path.read_text())
        except (json.JSONDecodeError, OSError):
            prev_meta = {}

    now = datetime.now(timezone.utc)
    status = dict(prev_meta.get("feed_status", {}))
    vars_meta = dict(prev_meta.get("vars", {}))
    run_utc = prev_meta.get("run_utc")
    step = prev_meta.get("step")
    valid_utc = prev_meta.get("valid_utc")

    # ── Phase 1: pick ONE cycle/step, then fetch + crop every raw param ──────
    # A single select_cycle() call fixes the model cycle for every variable —
    # params must never mix cycles (a temp/dewpoint pair from different runs
    # would corrupt the RH derivation) and the meta stamps below describe all
    # of them.
    raw_cropped = {}     # param -> (cropped SI grid, lat_arr, lon_arr)
    raw_failed = set()
    needed_params = sorted({p for spec in VARIABLES.values() for p in spec["deps"]})
    print("Selecting cycle…")
    base_cycle, step_h, records = select_cycle(now)
    for param in needed_params:
        spec = RAW_SPECS[param]
        rec = find_record(records, spec["param"], spec["level"]) if records else None
        if rec is None:
            print(f"  {param} FAILED: no record in selected cycle", file=sys.stderr)
            raw_failed.add(param)
            continue
        print(f"Fetching {param}…")
        try:
            values_si = fetch_grib_values(base_cycle, step_h, rec, spec["expected_units"], spec["to_si"])
            cropped, lat_arr, lon_arr = crop(values_si)
            print(f"  {param}: {np.nanmin(cropped):.2f}..{np.nanmax(cropped):.2f} {spec['si_units']}")
            raw_cropped[param] = (cropped, lat_arr, lon_arr)
        except Exception as e:                          # noqa: BLE001 — degrade, don't crash
            print(f"  {param} FAILED: {e}", file=sys.stderr)
            raw_failed.add(param)
    if raw_cropped:
        # Stamp the run only when something was actually fetched from it; on a
        # total failure the previous meta's stamps survive, like its files.
        run_utc = base_cycle.strftime("%Y-%m-%dT%H:%M:%SZ")
        step = step_h
        valid_utc = (base_cycle + timedelta(hours=step_h)).strftime("%Y-%m-%dT%H:%M:%SZ")
    else:
        base_cycle = None

    # ── Phase 2: combine raw grids into the seven dropdown variables ─────────
    computed = {}  # var -> (cropped SI grid, lat_arr, lon_arr) — for the city summary below
    for name, spec in VARIABLES.items():
        missing = [p for p in spec["deps"] if p in raw_failed]
        if missing:
            print(f"{name}: skipped, missing raw param(s) {missing}", file=sys.stderr)
            status[name] = "failed"
            continue
        try:
            grids = {p: raw_cropped[p][0] for p in spec["deps"]}
            _, lat_arr, lon_arr = raw_cropped[spec["deps"][0]]
            cropped = spec["combine"](grids)

            print(f"  {name}: {np.nanmin(cropped):.1f}..{np.nanmax(cropped):.1f} {spec['si_units']}")
            for city, lat, lon in CHECK_CITIES:
                v = sample_lut(cropped, lat_arr, lon_arr, lat, lon)
                print(f"    {city}: {v:.1f} {spec['si_units']}")

            bake_image(cropped, spec["ramp"], outdir / f"{name}.webp")
            write_lut(cropped, spec["scale"], outdir / f"{name}.i16")

            h, w = cropped.shape
            var_meta = {
                "width": w, "height": h,
                "bbox": [CROP_WEST, CROP_SOUTH, CROP_EAST, CROP_NORTH],
                "scale": spec["scale"], "nodata": LUT_NODATA,
                "units": spec["si_units"],
            }
            if name == "wind":
                u, _, _ = raw_cropped["10u"]
                v_, _, _ = raw_cropped["10v"]
                bake_wind_uv(u, v_, outdir / "wind_uv.png")
                var_meta["uv_min"] = UV_MIN
                var_meta["uv_max"] = UV_MAX
            vars_meta[name] = var_meta
            status[name] = "ok"
            computed[name] = (cropped, lat_arr, lon_arr)
        except Exception as e:                          # noqa: BLE001 — degrade, don't crash
            print(f"  {name} FAILED: {e}", file=sys.stderr)
            status[name] = "failed"

    # ── City summary + cross-variable sanity check ────────────────────────────
    if computed:
        print("\nCity summary:")
        for city, lat, lon in CHECK_CITIES:
            row = {}
            for name in VARIABLES:
                if name not in computed:
                    continue
                cropped, lat_arr, lon_arr = computed[name]
                row[name] = sample_lut(cropped, lat_arr, lon_arr, lat, lon)
            print(f"  {city}: " + ", ".join(f"{k}={v:.1f}" for k, v in row.items()))
            if "gust" in row and "wind" in row and row["gust"] < row["wind"] - 0.5:
                print(f"    NOTE: gust ({row['gust']:.1f}) < wind ({row['wind']:.1f}) at {city}")
            if "dewpoint" in row and "temp" in row and row["dewpoint"] > row["temp"] + 0.5:
                print(f"    NOTE: dewpoint ({row['dewpoint']:.1f}) > temp ({row['temp']:.1f}) at {city}")

    # ── Phase 3: extra steps for the time slider ──────────────────────────────
    # Same cycle as the base step, -BACK_HOURS..+FORWARD_HOURS (the recent past
    # comes from the same run's earlier steps). Per step: display webp at
    # quality=70 (many hourly bakes, so non-base steps trade a little quality
    # for size), a gzipped .i16.gz hover LUT, and wind_uv png; no per-city
    # checks. A failed step is dropped from `steps` (the slider just gets
    # shorter); the base step keeps its "" suffix so every existing consumer
    # is untouched. If the base bake failed entirely, the previous run's steps
    # list is preserved alongside its files, same as every other meta field.
    steps_list = prev_meta.get("steps") or []
    if computed and base_cycle is not None:
        ok_vars = [n for n in VARIABLES if status.get(n) == "ok"]

        def bake_step(s):
            """One non-base step: fetch its index + params, bake every ok var."""
            records_s = fetch_index(base_cycle, s)
            raws = {}
            for param in needed_params:
                spec = RAW_SPECS[param]
                rec = find_record(records_s, spec["param"], spec["level"])
                if rec is None:
                    raise RuntimeError(f"no {spec['param']}:{spec['level']} record at f{s:03d}")
                values_si = fetch_grib_values(base_cycle, s, rec,
                                              spec["expected_units"], spec["to_si"])
                raws[param], _, _ = crop(values_si)
            suffix = f"_{s}h"
            for name in ok_vars:
                spec = VARIABLES[name]
                cropped = spec["combine"]({p: raws[p] for p in spec["deps"]})
                bake_image(cropped, spec["ramp"], outdir / f"{name}{suffix}.webp", quality=70)
                write_lut(cropped, spec["scale"], outdir / f"{name}{suffix}.i16.gz")
                if name == "wind":
                    bake_wind_uv(raws["10u"], raws["10v"], outdir / f"wind_uv{suffix}.png")
            valid_s = (base_cycle + timedelta(hours=s)).strftime("%Y-%m-%dT%H:%M:%SZ")
            return {"step": s, "valid_utc": valid_s, "suffix": suffix}

        wanted = [s for s in range(max(step - BACK_HOURS, 0),
                                   min(step + FORWARD_HOURS, MAX_STEP_H) + 1, STEP_INTERVAL_H)
                  if s != step]
        steps_list = [{"step": step, "valid_utc": valid_utc, "suffix": ""}]
        # The work is dominated by S3 range GETs, so steps run on a thread
        # pool; each step writes its own files and the eccodes decode is
        # serialized by _ECCODES_LOCK.
        with ThreadPoolExecutor(max_workers=6) as pool:
            futures = {pool.submit(bake_step, s): s for s in wanted}
            for fut, s in futures.items():
                try:
                    steps_list.append(fut.result())
                    print(f"  step f{s:03d}: baked {len(ok_vars)} variables")
                except Exception as e:                  # noqa: BLE001 — degrade, don't crash
                    print(f"  step f{s:03d} FAILED: {e}", file=sys.stderr)
        steps_list.sort(key=lambda x: x["step"])

        # Forward-step filenames carry the absolute step hour, which shifts
        # every run — delete orphans from previous runs so the output dir
        # (and the data branch) doesn't accumulate dead files.
        live = {f"{n}{s['suffix']}" for n in VARIABLES for s in steps_list} \
             | {f"wind_uv{s['suffix']}" for s in steps_list}
        for f in (list(outdir.glob("*_*h.webp")) + list(outdir.glob("wind_uv_*h.png"))
                  + list(outdir.glob("*_*h.i16.gz"))):
            stem = f.name.removesuffix(".i16.gz") if f.name.endswith(".i16.gz") else f.stem
            if stem not in live:
                f.unlink()
                print(f"  removed orphan {f.name}")

    meta = {
        "run_utc": run_utc,
        "step": step,
        "valid_utc": valid_utc,
        "generated_utc": now.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "feed_status": status,
        "vars": vars_meta,
        "steps": steps_list,
    }
    write_json_atomic(meta, meta_path, indent=1)
    print(f"\nWrote {meta_path}  feed_status={status}")


if __name__ == "__main__":
    main()
