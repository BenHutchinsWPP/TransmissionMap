"""Route-optimizer grid: the one definition of the 250 m EPSG:5070 grid and every band code table.

Role: pure arithmetic and constant tables, stdlib only (no numpy/rasterio, not even lazily;
producers convert `transform()` to rasterio.Affine themselves).
Dependents: producers `build_route_*.py` (take their transform and codes from here, so every
band lands on the same cells), assembler `build_route_cube.py` (asserts each band's
transform/shape equals this and writes `grid_json()` as grid.json), and the TS mirror
`assets/route/grid.ts`.
"""
import math

CRS = "EPSG:5070"
X0 = -2493045.0  # top-left corner; on the legacy-NLCD 30 m lattice
Y0 = 3310005.0
CELL = 250.0
COLS = 19343
ROWS = 12531
SUPER = 4096  # super-tile edge, cells (5 x 4 = 20 tiles)
BLOCK = 512  # internal tile/block edge, cells
NLCD_CELL = 30.0
WINDOW_UNIT_M = 750.0  # LCM(30, 250)

# ---- band code tables (0 = nodata everywhere; class codes start at 1) ----

PD_BANDS = {1: "landcover", 2: "slope", 3: "protect", 4: "agency",
            5: "wildfire", 6: "whpclass", 7: "flags", 8: "state",
            9: "desig", 10: "flags2", 11: "isoreg", 12: "landval",
            13: "bldg", 14: "wetland", 15: "built", 16: "nonres", 17: "bldgunk",
            18: "aviation", 19: "nfhl"}
OSM_BANDS = {1: "flags", 2: "maxkv", 3: "adj"}
GRID_VERSION = 8

# slope b2: code i (1..8) = mean 30 m slope in [edges[i-1], edges[i]) degrees; last bin closed.
SLOPE_EDGES = [0, 1, 2, 4, 8, 15, 25, 45, 90]
SLOPE_CODES = {i + 1: [SLOPE_EDGES[i], SLOPE_EDGES[i + 1]] for i in range(8)}

# protect b3: GAP int 1-4 (smallest non-zero) in bits 0-2, TNC cat int 1-3 in bits 4-5,
# bit 6 = cell outside the PoPWest study area (TNC value 127), bit 7 = NPS unit named Preserve
# (PAD-US Fee, centre rule, CONUS). Bit 3 is free.
PROTECT_BITS = {"gap_shift": 0, "gap_mask": 0b111, "tnc_shift": 4, "tnc_mask": 0b11,
                "outside_popwest_bit": 6, "nps_preserve_bit": 7}
# OGR SQL over PADUS4_1Fee (GPKG LIKE is case-insensitive); 25 features expected.
NPS_PRESERVE_WHERE = "Mang_Name = 'NPS' AND Unit_Nm LIKE '%Preserve%'"

# agency b4: stable integers; private/none = 1 so 0 stays nodata. Maps from PAD-US Mang_Name
# (federal/tribal by name, the rest by Mang_Type). Unlisted federal names -> 9.
AGENCY_CODES = {
    1: "private/none",
    2: "BLM",
    3: "USFS",
    4: "NPS",
    5: "FWS",
    6: "DOD",
    7: "DOE",
    8: "BOR",
    9: "other federal",
    10: "state",
    11: "local",
    12: "tribal",
    13: "NGO/other",
}
# PAD-US Mang_Name -> code. Anything federal not named here (NOAA, TVA, USACE, NRCS, ARS,
# OTHF, ...) is 9. State agencies are Mang_Type STAT (10), local government is Mang_Type
# LOC (CNTY/CITY/DIST/RWD, 11). NGO, PVT (private-protected), JNT (joint) and UNK
# (unknown) all map to 13: protected-by-someone but not a government manager.
AGENCY_BY_MANG_NAME = {
    "BLM": 2, "USFS": 3, "NPS": 4, "FWS": 5, "DOD": 6, "DOE": 7,
    "USBR": 8, "BOR": 8,
    "NOAA": 9, "TVA": 9, "USACE": 9, "NRCS": 9, "ARS": 9, "OTHF": 9,
    "CNTY": 11, "CITY": 11, "DIST": 11, "RWD": 11, "LOC": 11,
    "TRIB": 12,
    "NGO": 13, "PVT": 13, "JNT": 13, "UNK": 13,
}
AGENCY_BY_MANG_TYPE = {"STAT": 10, "LOC": 11, "TRIB": 12, "NGO": 13, "PVT": 13,
                       "JNT": 13, "UNK": 13}
AGENCY_OTHER_FEDERAL = 9
AGENCY_PRIVATE = 1

# whpclass b6: USFS WHP 2023 class
WHP_CLASSES = {1: "very low", 2: "low", 3: "moderate", 4: "high", 5: "very high",
               6: "non-burnable", 7: "water"}

# PD flags b7
PD_FLAGS = {0: "tribal", 1: "military (PAD-US DOD + DoD MIRTA act/semi/care)", 2: "public airfield <= 5 km", 3: "critical habitat",
            4: "Section 368 corridor", 5: "pop > 100/mi2",
            6: "state or local park, GAP 3-4",
            7: "tall structure or dam"}
# OSM flags b1
OSM_FLAGS = {0: "lake", 1: "river", 2: "line >= 230 kV", 3: "line 100-229 kV",
             4: "major road", 5: "rail", 6: "pipeline", 7: "military"}
# PD desig b9: designation bits
DESIG_BITS = {0: "WSA", 1: "NM/NCA", 2: "IRA", 3: "ACEC", 4: "WSR corridor",
              5: "NHT/NST", 6: "other special (RNA/SDA/NSBV/HCA/NRA)",
              7: "Wilderness (WA, State Wilderness) or National Park"}
# PD flags2 b10: all eight bits assigned
FLAGS2_BITS = {0: "sage-grouse PHMA/IHMA", 1: "GHMA", 2: "100-yr floodplain",
               3: "occupied facility", 4: "NRHP listed property", 5: "Superfund NPL",
               6: "CBRS unit", 7: "FUDS munitions response site"}

# OSM adj b3 (power lines only): v = line class + ADJ_COMPUTED_BIT so v != 0 on the grid.
# Line class 0 beyond 3 cells, 1 on a >= 230 kV line cell, 2 within 1 cell, 3 within 3 cells.
# Bits 5-6 hold the same class for 100-229 kV lines. Bit 2 is set on or within 1 cell of a
# >= 345 kV line cell, bit 3 of a >= 500 kV one (osm maxkv code >= 69 / >= 100). Bit 7 is
# reserved. Max value 16 + 3 + 4 + 8 + (3 << 5) = 127 fits uint8.
ADJ_COMPUTED_BIT = 16
ADJ_CLASS_MASK = 0b11
ADJ345_BIT = 2
ADJ500_BIT = 3
ADJ_KV_TIERS = {ADJ345_BIT: 345, ADJ500_BIT: 500}  # bit -> min kV of the line within 1 cell
ADJ_RESERVED_MASK = 0b10000000
ADJ100_SHIFT = 5
ADJ100_MASK = 0b11 << ADJ100_SHIFT
ADJ_CLASSES = {0: "beyond 3 cells", 1: "on line", 2: "within 1 cell", 3: "within 3 cells"}


ADJ_MAX = ADJ_COMPUTED_BIT | ADJ_CLASS_MASK | (1 << ADJ345_BIT) | (1 << ADJ500_BIT) | ADJ100_MASK
assert ADJ_MAX == 127 <= 255


def adj_encode(line_class, class_100=0, near345=False, near500=False):
    for c in (line_class, class_100):
        if c not in ADJ_CLASSES:
            raise ValueError(f"line class must be 0-3, got {c!r}")
    if near500 and not near345:
        raise ValueError("a cell beside a >= 500 kV line is beside a >= 345 kV line")
    if near345 and line_class not in (1, 2):
        raise ValueError("a cell beside a >= 345 kV line has >= 230 kV line class 1 or 2")
    return (ADJ_COMPUTED_BIT | line_class | (class_100 << ADJ100_SHIFT)
            | (near345 << ADJ345_BIT) | (near500 << ADJ500_BIT))


def adj_decode(v):
    """(>= 230 kV class, 100-229 kV class) of an adj value; None where adj was not computed (0 = nodata).
    Bits ADJ345_BIT / ADJ500_BIT (on or beside a >= 345 / >= 500 kV line) are read as bits."""
    if not v & ADJ_COMPUTED_BIT:
        return None
    return (v & ADJ_CLASS_MASK, (v & ADJ100_MASK) >> ADJ100_SHIFT)


# PD isoreg b11: 0 = no BA. Codes are listed below; value = ISO name, not a reVX multiplier
# set name: a preset's `regions.sets` maps each ISO name to a set (Lopez 2025 s2.5), and is
# keyed by these names, never by code. "Southeast" is an ISO name here and also reVX's set name.
ISO_CODES = {1: "TEPPC", 2: "CAISO", 3: "MISO", 4: "SPP", 5: "ERCOT", 6: "PJM",
             7: "NYISO", 8: "ISONE", 9: "Southeast"}
ISO_RTO_CODES = frozenset(range(2, 9))  # codes 2-8 are RTO/ISOs; 1 and 9 are not


def iso_overlap_key(code, area):
    """Sort key for overlapping BAs: the smallest key wins (RTO before non-RTO, then smaller area)."""
    return (code not in ISO_RTO_CODES, area)


# EIA BA abbrev -> ISO name. WECC (incl. its Canadian/Mexican BAs and the WAPA BAs) is TEPPC;
# the other non-RTO eastern BAs and the non-CONUS ones (Alaska, Hawaii, Canada east) are Southeast.
_BA_ISO = {
    "CAISO": ["CISO"],
    "MISO": ["MISO"],
    "SPP": ["SWPP"],
    "ERCOT": ["ERCO"],
    "PJM": ["PJM", "EKPC", "OVEC"],
    "NYISO": ["NYIS"],
    "ISONE": ["ISNE"],
    "TEPPC": ["AESO", "AVA", "AVRN", "AZPS", "BANC", "BCHA", "BCTC", "BPAT", "CFE", "CHPD",
              "DEAA", "DOPD", "ELE", "GCPD", "GRID", "GRIF", "GRMA", "GWA", "HGMA", "IID",
              "IPCO", "LDWP", "MPCO", "NEVP", "PACE", "PACW", "PGE", "PNM", "POWX", "PSCO",
              "PSEI", "SCL", "SRP", "TEPC", "TIDC", "TPWR", "WACM", "WALC", "WAUW", "WWA"],
    "Southeast": ["AEC", "AECI", "AMPL", "CEA", "CPLE", "CPLW", "DUK", "EEI", "FMPP", "FPC",
                  "FPL", "GLHB", "GVL", "HEC", "HQT", "HST", "IESO", "JEA", "LGEE", "MHEB",
                  "NBSO", "NMISA", "NSB", "NSPI", "RC", "SC", "SCEG", "SEC", "SEPA", "SOCO",
                  "SPA", "SPC", "TAL", "TEC", "TVA", "YAD"],
}
BA_TO_ISO = {ba: iso for iso, bas in _BA_ISO.items() for ba in bas}
ISO_CODE_BY_NAME = {v: k for k, v in ISO_CODES.items()}

# landval b12: county ag $/ac. code = clamp(1 + round(16 log2(v/100)), 1, 255); 0 = no value.
LANDVAL_BASE = 100.0
LANDVAL_STEPS = 16  # codes per doubling (step 4.4 %)
LANDVAL_MAX_CODE = 255


def landval_encode(v):
    if v is None or not v > 0:
        return 0
    code = 1 + round(LANDVAL_STEPS * math.log2(v / LANDVAL_BASE))
    return max(1, min(LANDVAL_MAX_CODE, code))


def landval_decode(code):
    """$/ac of a landval code (code 255 = $6.01 M); None for 0 (no value)."""
    return LANDVAL_BASE * 2 ** ((code - 1) / LANDVAL_STEPS) if code else None


# bldg b13: residential structures (FEMA/ORNL USA Structures) per cell. code = 1 + min(n, 254) on
# CONUS land, 0 = nodata (state 0); so code 1 = no home, 255 = 254 or more.
BLDG_OFFSET = 1
BLDG_CAP = 254


def bldg_encode(n):
    return BLDG_OFFSET + min(int(n), BLDG_CAP)


# wetland b14: NWI wetland share of the cell. code = 1 + round(100 * share) on CONUS land, 0 = nodata
# (state 0); so code 1 = none, 101 = fully covered.
WETLAND_OFFSET = 1
WETLAND_SCALE = 100
WETLAND_TYPES = ("Freshwater Emergent Wetland", "Freshwater Forested/Shrub Wetland", "Estuarine and Marine Wetland")


def wetland_encode(share):
    return WETLAND_OFFSET + round(WETLAND_SCALE * max(0.0, min(1.0, share)))


# Observed footprint shares: 0 unobserved, 1 no returned footprint, 2..101 upper percent bounds.
NONRESIDENTIAL_CLASSES = ("Commercial", "Industrial", "Agriculture", "Assembly", "Education", "Government", "Utility and Misc")


def footprint_encode(share, observed=True):
    if not observed:
        return 0
    if not math.isfinite(share) or share < 0:
        raise ValueError("footprint share must be finite and nonnegative")
    return 1 + math.ceil(100 * min(1.0, share))


# aviation b18 (FAA NTAD + Part 77 surfaces, build_route_aviation.py): worst class of the cell.
AVIATION_CODES = {
    1: "evaluated: outside the notice extent, no surface below 61 m AGL",
    2: "77.9(b) notice extent: lowest surface >= 61 m AGL, or none",
    3: "lowest surface AGL [46, 61) m",
    4: "lowest surface AGL [30, 46) m",
    5: "lowest surface AGL < 30 m",
    6: "primary surface (primary / clear zone)",
}
# nfhl b19 (FEMA NFHL Key Layers, build_route_nfhl.py): area shares of the cell.
NFHL_CODES = {
    1: "observed none: effective panels cover >= 50 % of the cell, SFHA < 50 %",
    2: "SFHA: panels >= 50 % and SFHA (SFHA_TF = 'T') >= 50 % of the cell's area",
    3: "no effective panel: panels < 50 % of the cell (whatever SFHA says)",
}

OSM_MAXKV_DIV = 5  # b2 = kV / 5, capped
OSM_MAXKV_CAP = 255


def transform():
    """GDAL-style geotransform (x0, dx, 0, y0, 0, -dy)."""
    return (X0, CELL, 0.0, Y0, 0.0, -CELL)


def cell_of(x, y):
    """(col, row) of the cell containing EPSG:5070 point (x, y); may lie outside the grid."""
    return (math.floor((x - X0) / CELL), math.floor((Y0 - y) / CELL))


def xy_of(col, row, center=True):
    """EPSG:5070 (x, y) of a cell's centre, or its top-left corner."""
    k = 0.5 if center else 0.0
    return (X0 + (col + k) * CELL, Y0 - (row + k) * CELL)


def super_tiles(bbox_xy=None):
    """[(scol, srow, col_off, row_off, width, height)] covering the grid, row-major.

    bbox_xy = (xmin, ymin, xmax, ymax) in EPSG:5070 keeps only tiles it touches.
    """
    out = []
    for srow in range((ROWS + SUPER - 1) // SUPER):
        for scol in range((COLS + SUPER - 1) // SUPER):
            c0, r0 = scol * SUPER, srow * SUPER
            w, h = min(SUPER, COLS - c0), min(SUPER, ROWS - r0)
            if bbox_xy is not None:
                xmin, ymin, xmax, ymax = bbox_xy
                tx0, ty1 = xy_of(c0, r0, center=False)
                tx1, ty0 = xy_of(c0 + w, r0 + h, center=False)
                if xmax < tx0 or xmin > tx1 or ymax < ty0 or ymin > ty1:
                    continue
            out.append((scol, srow, c0, r0, w, h))
    return out


def windows(window_m=30000):
    """Yield (col_off, row_off, width, height, (x0, y0, x1, y1)) over the grid, row-major.

    Windows are window_m on a side (edge windows are clipped), window_m a multiple of 750 m
    so 30 m -> 250 m aggregation has no fractional seams. The bounds are the 30 m window in
    metres (xmin, ymin, xmax, ymax), rounded outward to the 30 m lattice at the grid edge.
    """
    if window_m <= 0 or window_m % WINDOW_UNIT_M:
        raise ValueError(f"window_m must be a positive multiple of {WINDOW_UNIT_M:g} m")
    n = int(window_m // CELL)
    for row_off in range(0, ROWS, n):
        h = min(n, ROWS - row_off)
        for col_off in range(0, COLS, n):
            w = min(n, COLS - col_off)
            xa, yb = xy_of(col_off, row_off, center=False)
            xb, ya = xy_of(col_off + w, row_off + h, center=False)
            xb = X0 + math.ceil((xb - X0) / NLCD_CELL) * NLCD_CELL
            ya = Y0 - math.ceil((Y0 - ya) / NLCD_CELL) * NLCD_CELL
            yield (col_off, row_off, w, h, (xa, ya, xb, yb))


def grid_json(extra=None):
    """grid.json content: grid geometry + every code table, merged with `extra`."""
    out = {
        "version": GRID_VERSION,
        "crs": CRS,
        "origin": [X0, Y0],
        "cell": CELL,
        "cols": COLS,
        "rows": ROWS,
        "super": SUPER,
        "block": BLOCK,
        "pd_bands": {str(k): v for k, v in PD_BANDS.items()},
        "osm_bands": {str(k): v for k, v in OSM_BANDS.items()},
        "slope_bins": {str(k): v for k, v in SLOPE_CODES.items()},
        "protect_bits": dict(PROTECT_BITS),
        "agency": {str(k): v for k, v in AGENCY_CODES.items()},
        "whp_classes": {str(k): v for k, v in WHP_CLASSES.items()},
        "pd_flags": {str(k): v for k, v in PD_FLAGS.items()},
        "osm_flags": {str(k): v for k, v in OSM_FLAGS.items()},
        "osm_maxkv": {"div": OSM_MAXKV_DIV, "cap": OSM_MAXKV_CAP},
        "desig_bits": {str(k): v for k, v in DESIG_BITS.items()},
        "flags2_bits": {str(k): v for k, v in FLAGS2_BITS.items()},
        "adj": {"computed_bit": ADJ_COMPUTED_BIT, "class_mask": ADJ_CLASS_MASK,
                "reserved_mask": ADJ_RESERVED_MASK,
                "kv_tier_bits": {str(b): kv for b, kv in ADJ_KV_TIERS.items()},
                "class_100_shift": ADJ100_SHIFT, "class_100_mask": ADJ100_MASK,
                "classes": {str(k): v for k, v in ADJ_CLASSES.items()}},
        "isoreg": {"codes": {str(k): v for k, v in ISO_CODES.items()},
                   "rto": sorted(ISO_RTO_CODES), "ba_to_iso": dict(BA_TO_ISO)},
        "landval": {"base": LANDVAL_BASE, "steps": LANDVAL_STEPS, "max_code": LANDVAL_MAX_CODE},
        "bldg": {"offset": BLDG_OFFSET, "cap": BLDG_CAP, "occ_cls": "Residential"},
        "wetland": {"offset": WETLAND_OFFSET, "scale": WETLAND_SCALE, "types": list(WETLAND_TYPES)},
        "building_footprints": {"offset": 1, "scale": 100, "rounding": "ceil", "unobserved": 0,
                                "nonresidential_classes": list(NONRESIDENTIAL_CLASSES)},
        "aviation": {str(k): v for k, v in AVIATION_CODES.items()},
        "nfhl": {str(k): v for k, v in NFHL_CODES.items()},
    }
    out.update(extra or {})
    return out
