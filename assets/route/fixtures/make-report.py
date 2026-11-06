"""Writes the mini route-report GeoParquet files assets/route/report-read.ts reads (run:
venv/bin/python assets/route/fixtures/make-report.py; needs pyarrow, shapely, pyproj).

report/*.parquet mimic data/route/report/ (scripts/build_route_report_data.py): the same file names, column
names and arrow types per file; a `bbox` struct {xmin,ymin,xmax,ymax} float64 (GeoParquet 1.1 covering); `geometry`
as ISO WKB binary (LineString / MultiLineString, EPSG:4326 lng/lat); the `geo` key-value metadata (version 1.1.0,
primary_column, encoding WKB, geometry_types, bbox, covering); ZSTD; statistics, column index and offset index on.
Each file has one row group per group below ("A", "B" where it has scene-B features, "far"), so row-group bbox
statistics differ and a reader can skip groups. report/manifest.json carries the real manifest's per-file shape.
Consumers: assets/route/report-read.test.ts (scene A), assets/route/route.test.ts (scene B).

Scene A (unit scene). Route R_A runs due east 20 km in EPSG:5070 (metres):
  start (-100.0, 40.0) lng/lat = (-338390.5876, 1894100.1400), end = (-318390.5876, 1894100.1400). "along" = metres east of the start, "offset" = metres north.
  Every crossing feature is a ~2 km line perpendicular to R_A (offset -1000..+1000) unless noted, so no crossing is
  within 300 m of its own line's end.
  I-99 (ref "I 99", motorway, roads_motorway_trunk)  two ways at along 1,000 and 1,030
  unnamed primary roads (roads_primary)               along 2,000 and 2,050
  "Mud River" (rivers)                                one LineString crossing at 3,000, 3,400, 3,800
  BNSF (railroads, NET 'M')                           four ways at 4,000 / 4,010 / 4,020 / 4,030
  UP (railroads) NET 'A' at 4,500 and NET 'R' at 4,600 -- filtered by the reader
  OSM 345 kV at 5,000; HIFLD 345 kV IN SERVICE copy at 5,120
  OSM 115 kV (osm_id 1150) parallel at offset +100 from along 7,000 to 12,000, four ways of 1,250 m sharing
    endpoints exactly, weaving +-100 m so it crosses R_A 6 times (at 7,500 / 8,200 / 8,800 / 9,500 / 10,200 / 11,400)
  OSM 230 kV at 9,000 (during the parallel stretch)
  OSM gas pipeline "Gulf Gas" at 13,000; HIFLD natgas copy at 13,080; OSM water pipeline at 13,500
  HIFLD INACTIVE 345 kV at 14,000; OSM nominal_kv 1000 at 14,500
  OSM busbar way (230 kV) at 15,000; OSM 'busbarq' way (230 kV) at 15,100
  OSM 230 kV at 150 (a MultiLineString of two touching parts)
  OSM 230 kV at 16,000; HIFLD copy (VOLTAGE -999999, VOLT_CLASS 220-287) at 16,100
  OSM 138 kV with a null fid (osm_id 1380) at 17,000
  "far" group: the same kinds of features 300 km north of the route, one row group per file.

Scene B (inside the mini cube of make-cube.py: EPSG:5070 origin X0=-1,000,000, Y0=2,000,000 top-left, 250 m cells,
90 x 60; cell (c, r) centre = (X0+(c+.5)*250, Y0-(r+.5)*250)); defined in 5070, then converted to lng/lat:
  OSM 345 kV (osm_id 3450)   E-W along row 38, cell centres col 0 .. 39 (west of the wall only)
  OSM river "Cube Creek"     E-W along row 38, col 41 .. 89, a MultiLineString of two touching parts (east only)
  OSM motorway "Cube Road"   E-W along row 45, col 0 .. 89 (crosses the wall column)
  A route from (20, 20) to (60, 20) through the wall gap (rows 55-57) crosses the line an odd number of times,
  the river an odd number, the road an even number >= 2. (The line stops at col 39, just west of the wall, so a
  route that passes close to the wall may go round its end. The 300 m endpoint rule is about the route's first and
  last vertex, not a line's end.)
"""
import json
import os
import shapely
import pyarrow as pa
import pyarrow.parquet as pq
from pyproj import Transformer
from shapely.geometry import LineString, MultiLineString

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "report")
TO5070 = Transformer.from_crs(4326, 5070, always_xy=True)
TO4326 = Transformer.from_crs(5070, 4326, always_xy=True)

S, LS, I32, I64, F64 = pa.string(), pa.large_string(), pa.int32(), pa.int64(), pa.float64()
OSM_ROAD = dict(fid=I64, osm_id=I64, name=LS, ref=LS, bridge=LS, tunnel=LS, highway=LS, waterway=S)
SCHEMAS = {
    "roads_motorway_trunk": OSM_ROAD,
    "roads_primary": OSM_ROAD,
    "rivers": {**OSM_ROAD, "highway": S, "waterway": LS},
    "railroads": dict(OBJECTID=I32, RROWNER1=LS, RROWNER2=LS, TRKRGHTS1=LS, DIVISION=LS, SUBDIV=LS, BRANCH=LS,
                      PASSNGR=LS, STRACNET=LS, TRACKS=F64, NET=LS, STATEAB=LS),
    "pipelines_osm": dict(fid=I64, osm_id=LS, name=LS, substance=LS, operator=LS),
    "pipelines_hifld_natgas": dict(fid=LS, pipe_type=LS, operator=LS, name=LS, states=LS),
    "transmission_osm_us": dict(fid=I64, osm_id=I64, name=LS, operator=LS, nominal_kv=I32, line_type=LS, ref=LS,
                                is_dc=I32, is_undergrnd=I32),
    "transmission_hifld": dict(ID=LS, OWNER=LS, VOLTAGE=LS, VOLT_CLASS=LS, TYPE=LS, STATUS=LS, SUB_1=LS, SUB_2=LS,
                               states=LS),
}
META = {  # kind, source, licence: the real manifest's strings
    "roads_motorway_trunk": ("OpenStreetMap highways (motorway, trunk)", "odbl"),
    "roads_primary": ("OpenStreetMap highways (primary)", "odbl"),
    "rivers": ("OpenStreetMap waterway=river", "odbl"),
    "railroads": ("BTS / FRA North American Rail Network (NARN)", "pd"),
    "pipelines_osm": ("OpenStreetMap pipelines", "odbl"),
    "pipelines_hifld_natgas": ("HIFLD natural gas pipelines (frozen copy)", "pd"),
    "transmission_osm_us": ("OpenStreetMap power lines, data/build/transmission_lines.gpkg", "odbl"),
    "transmission_hifld": ("HIFLD electric power transmission lines (frozen copy)", "pd"),
}
LICENCE = {"odbl": "ODbL 1.0, (c) OpenStreetMap contributors",
           "pd": "public domain (US federal work, 17 U.S.C. 105)"}
GROUPS = ["A", "B", "far"]
rows = {name: {g: [] for g in GROUPS} for name in SCHEMAS}
_osm = [100]


class Frame:
    """Metric helper: pt(along, offset) = metres east / north of an EPSG:5070 origin."""

    def __init__(self, x0, y0):
        self.x0, self.y0 = x0, y0

    def pt(self, a, o):
        return (self.x0 + a, self.y0 + o)

    def cross(self, a, half=1000.0, o0=None):
        """A perpendicular crossing at along `a`: one part, 3 vertices."""
        return [[self.pt(a, -half), self.pt(a, 0.0), self.pt(a, half)]]

    def line(self, *pts):
        return [[self.pt(a, o) for a, o in pts]]


def add(file, group, parts, /, **attrs):
    """One feature: `parts` = list of 5070 point lists (1 = LineString, 2+ = MultiLineString)."""
    ll = [[TO4326.transform(x, y) for x, y in p] for p in parts]
    g = LineString(ll[0]) if len(ll) == 1 else MultiLineString(ll)
    rows[file][group].append((g, attrs))


def osm(file, group, parts, /, fid=True, **attrs):
    """An OSM way: fid = osm_id*10 + 2 (way), osm_id from a counter unless given."""
    oid = attrs.pop("osm_id", None)
    if oid is None:
        _osm[0] += 1
        oid = _osm[0]
    if file == "pipelines_osm":
        attrs["osm_id"] = str(oid)
    else:
        attrs["osm_id"] = oid
    attrs["fid"] = oid * 10 + 2 if fid else None
    add(file, group, parts, **attrs)


def hid(n):
    return f"H{n:05d}"


def scene_a(f, group, far=False):
    """Scene A features in frame `f`; `far` adds a reduced set (no ids that tests count on)."""
    osm("roads_motorway_trunk", group, f.cross(1000), name="I-99", ref="I 99", highway="motorway")
    if far:
        osm("roads_primary", group, f.cross(2000), highway="primary")
        osm("rivers", group, f.line((2900, -300), (3100, 300), (3500, -300)), name="Far River", waterway="river")
        add("railroads", group, f.cross(4000), OBJECTID=9001, RROWNER1="BNSF", NET="M", TRACKS=1.0, STATEAB="SD")
        osm("pipelines_osm", group, f.cross(5000), name="Far Gas", substance="gas")
        add("pipelines_hifld_natgas", group, f.cross(5080), fid="F1", pipe_type="Interstate", operator="Far Gas")
        osm("transmission_osm_us", group, f.cross(6000), nominal_kv=345, line_type="")
        add("transmission_hifld", group, f.cross(7000), ID="F1", VOLTAGE="345", VOLT_CLASS="345", STATUS="IN SERVICE")
        return
    osm("roads_motorway_trunk", group, f.cross(1030), name="I-99", ref="I 99", highway="motorway")
    osm("roads_primary", group, f.cross(2000), highway="primary")
    osm("roads_primary", group, f.cross(2050), highway="primary")
    osm("rivers", group, f.line((2900, -300), (3100, 300), (3300, 300), (3500, -300), (3700, -300), (3900, 300)),
        name="Mud River", waterway="river")
    for i, a in enumerate((4000, 4010, 4020, 4030)):
        add("railroads", group, f.cross(a), OBJECTID=100 + i, RROWNER1="BNSF", TRACKS=1.0, NET="M", STATEAB="NE")
    add("railroads", group, f.cross(4500), OBJECTID=200, RROWNER1="UP", TRACKS=1.0, NET="A", STATEAB="NE")
    add("railroads", group, f.cross(4600), OBJECTID=201, RROWNER1="UP", TRACKS=1.0, NET="R", STATEAB="NE")
    osm("transmission_osm_us", group, f.cross(5000), nominal_kv=345, line_type="", operator="Test Power")
    add("transmission_hifld", group, f.cross(5120), ID=hid(1), OWNER="Test Power", VOLTAGE="345", VOLT_CLASS="345",
        TYPE="AC; OVERHEAD", STATUS="IN SERVICE", states="|NE|")
    # 115 kV beside the route: weaves +-100 m, split into four ways at exact shared vertices
    weave = [(7000, 100), (7400, 100), (7600, -100), (8100, -100), (8300, 100), (8700, 100), (8900, -100),
             (9400, -100), (9600, 100), (10100, 100), (10300, -100), (10900, -100), (11300, -100), (11500, 100),
             (12000, 100)]
    cuts = [7000, 8250, 9500, 10750, 12000]

    def off(a):
        for (a0, o0), (a1, o1) in zip(weave, weave[1:]):
            if a0 <= a <= a1:
                return o0 + (o1 - o0) * (a - a0) / (a1 - a0)

    for k in range(4):
        lo, hi = cuts[k], cuts[k + 1]
        inner = [p for p in weave if lo < p[0] < hi]
        osm("transmission_osm_us", group, f.line((lo, off(lo)), *inner, (hi, off(hi))), osm_id=1150 + k,
            nominal_kv=115, line_type="", operator="Test Power")
    osm("transmission_osm_us", group, f.cross(9000), nominal_kv=230, line_type="")
    osm("pipelines_osm", group, f.cross(13000), name="Gulf Gas", substance="gas", operator="Gulf Gas Co")
    add("pipelines_hifld_natgas", group, f.cross(13080), fid="P1", pipe_type="Interstate", operator="Gulf Gas Co",
        name="Gulf Gas", states="|NE|")
    osm("pipelines_osm", group, f.cross(13500), name="City Water", substance="water")
    add("transmission_hifld", group, f.cross(14000), ID=hid(2), VOLTAGE="345", VOLT_CLASS="345", STATUS="INACTIVE")
    osm("transmission_osm_us", group, f.cross(14500), nominal_kv=1000, line_type="")
    osm("transmission_osm_us", group, f.cross(15000), nominal_kv=230, line_type="busbar")
    osm("transmission_osm_us", group, f.cross(15100), nominal_kv=230, line_type="busbarq")
    osm("transmission_osm_us", group, [f.cross(150, 1000)[0][:2], f.cross(150, 1000)[0][1:]], nominal_kv=230,
        line_type="")
    osm("transmission_osm_us", group, f.cross(16000), nominal_kv=230, line_type="")
    add("transmission_hifld", group, f.cross(16100), ID=hid(3), VOLTAGE="-999999", VOLT_CLASS="220-287",
        STATUS="IN SERVICE", states="|NE|")
    osm("transmission_osm_us", group, f.cross(17000), fid=False, osm_id=1380, nominal_kv=138, line_type="")


def scene_b():
    X0, Y0, C = -1_000_000.0, 2_000_000.0, 250.0

    def cell(c, r):
        return (X0 + (c + .5) * C, Y0 - (r + .5) * C)

    osm("transmission_osm_us", "B", [[cell(0, 38), cell(20, 38), cell(39, 38)]], osm_id=3450, nominal_kv=345,
        line_type="")
    osm("rivers", "B", [[cell(41, 38), cell(65, 38)], [cell(65, 38), cell(89, 38)]], name="Cube Creek",
        waterway="river")
    osm("roads_motorway_trunk", "B", [[cell(0, 45), cell(45, 45), cell(89, 45)]], name="Cube Road",
        highway="motorway")


def table(name, group):
    schema = SCHEMAS[name]
    cols = {k: [] for k in schema}
    bbox = []
    for g, a in rows[name][group]:
        for k in schema:
            cols[k].append(a.get(k))
        b = g.bounds
        bbox.append(dict(xmin=b[0], ymin=b[1], xmax=b[2], ymax=b[3]))
    arrs = {k: pa.array(v, type=schema[k]) for k, v in cols.items()}
    arrs["bbox"] = pa.array(bbox, type=pa.struct([(n, F64) for n in ("xmin", "ymin", "xmax", "ymax")]))
    arrs["geometry"] = pa.array([shapely.to_wkb(g) for g, _ in rows[name][group]], type=pa.binary())
    return pa.table(arrs)


def main():
    a = Frame(*TO5070.transform(-100.0, 40.0))
    far = Frame(a.x0, a.y0 + 300_000)
    scene_a(a, "A")
    scene_a(far, "far", far=True)
    scene_b()
    os.makedirs(OUT, exist_ok=True)
    manifest = {}
    for name in SCHEMAS:
        tabs = [table(name, g) for g in GROUPS if rows[name][g]]
        allg = [g for grp in GROUPS for g, _ in rows[name][grp]]
        b = shapely.MultiLineString([p for g in allg for p in (g.geoms if g.geom_type == "MultiLineString" else [g])]).bounds
        geo = {"version": "1.1.0", "primary_column": "geometry", "columns": {"geometry": {
            "encoding": "WKB", "geometry_types": sorted({g.geom_type for g in allg}), "bbox": list(b),
            "covering": {"bbox": {k: ["bbox", k] for k in ("xmin", "ymin", "xmax", "ymax")}}}}}
        schema = tabs[0].schema.with_metadata({"geo": json.dumps(geo)})
        path = os.path.join(OUT, name + ".parquet")
        with pq.ParquetWriter(path, schema, compression="zstd", write_statistics=True, write_page_index=True) as w:
            for t in tabs:
                w.write_table(t.cast(schema), row_group_size=1_000_000)
        manifest[name + ".parquet"] = dict(
            rows=sum(len(t) for t in tabs), mib=round(os.path.getsize(path) / 2**20, 2), row_groups=len(tabs),
            columns=list(SCHEMAS[name]), kind="line", source=META[name][0], licence=LICENCE[META[name][1]])
    with open(os.path.join(OUT, "manifest.json"), "w") as fh:
        json.dump(manifest, fh, indent=1)
        fh.write("\n")
    print("A start", a.pt(0, 0), "end", a.pt(20000, 0))


main()
