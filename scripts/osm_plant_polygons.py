"""Site-relation extraction and polygon-hull generation for power=plant features.

Split out of extract_osm_plants.py to keep that module focused on the
node/polygon/dedup pipeline. Both functions are imported from there.
"""

import logging
import math
from pathlib import Path

import pandas as pd
import geopandas as gpd
import osmium
import shapely  # shapely.concave_hull() available in Shapely 2+
from shapely.geometry import Point, MultiPoint
from shapely.ops import transform as shp_transform
from pyproj import Transformer

from osm_common import parse_output_mw, normalise_plant_source

log = logging.getLogger("extract_osm_plants")


def extract_site_relation_plants(plant_pbf, skip_osm_ids):
    """
    Find power=plant relations whose type is NOT 'multipolygon' (e.g. type=site,
    type=power, or unset) — these are skipped by osmium export but are real
    plants (e.g. wind farms like Wild Horse Wind, OSM relation 14124841).

    Strategy (two passes over the plant-only PBF):
      Pass 1 — collect relation tags + member node IDs for non-multipolygon plants
      Pass 2 — collect lon/lat for those member nodes (available because we ran
               osmium tags-filter with --add-referenced)
    Returns a DataFrame with the same schema as the other extract functions.
    """

    class _RelationScanner(osmium.SimpleHandler):
        def __init__(self, skip_ids):
            super().__init__()
            self.skip_ids = skip_ids
            self.relations = {}   # osm_id → (tags_dict, [member_node_ids])

        def relation(self, r):
            tags = dict(r.tags)
            if tags.get("power") != "plant":
                return
            if tags.get("type") == "multipolygon":
                return   # already captured by osmium export
            if r.id in self.skip_ids:
                return
            member_node_ids = [m.ref for m in r.members if m.type == "n"]
            if member_node_ids:
                self.relations[r.id] = (tags, member_node_ids)

    log.info("Site-relation pass 1/2: scanning for non-multipolygon plant relations ...")
    scanner = _RelationScanner(skip_osm_ids)
    scanner.apply_file(str(plant_pbf))
    log.info("  Found %d non-polygon plant relations", len(scanner.relations))

    if not scanner.relations:
        return pd.DataFrame(), {}

    needed_nodes = set()
    for _tags, node_ids in scanner.relations.values():
        needed_nodes.update(node_ids)
    log.info("  Need coordinates for %d member nodes", len(needed_nodes))

    class _NodeCollector(osmium.SimpleHandler):
        def __init__(self, needed):
            super().__init__()
            self.needed = needed
            self.coords = {}   # node_id → (lon, lat)

        def node(self, n):
            if n.id in self.needed and n.location.valid():
                self.coords[n.id] = (round(n.location.lon, 6), round(n.location.lat, 6))

    log.info("Site-relation pass 2/2: collecting member-node coordinates ...")
    collector = _NodeCollector(needed_nodes)
    collector.apply_file(str(plant_pbf))
    log.info("  Located %d / %d member nodes", len(collector.coords), len(needed_nodes))

    rows = []
    no_coords = 0
    for rid, (tags, node_ids) in scanner.relations.items():
        coords = [collector.coords[nid] for nid in node_ids if nid in collector.coords]
        if not coords:
            no_coords += 1
            continue
        clon = round(sum(c[0] for c in coords) / len(coords), 6)
        clat = round(sum(c[1] for c in coords) / len(coords), 6)
        output_raw = tags.get("plant:output:electricity", "")
        rows.append({
            "lon":        clon,
            "lat":        clat,
            "osm_type":   "relation",
            "osm_id":     rid,
            "name":       tags.get("name", "").strip(),
            "source":     normalise_plant_source(tags.get("plant:source", "")),
            "output_mw":  parse_output_mw(output_raw),
            "operator":   tags.get("operator", "").strip(),
            "start_date": tags.get("start_date", "").strip(),
        })

    if no_coords:
        log.warning("  %d relations had no locatable member nodes — skipped", no_coords)
    log.info("  Site-relation plants captured: %d", len(rows))

    site_coord_dict = {}
    for rid, (_tags, node_ids) in scanner.relations.items():
        coords = [collector.coords[nid] for nid in node_ids if nid in collector.coords]
        if coords:
            site_coord_dict[rid] = coords

    return pd.DataFrame(rows), site_coord_dict


def build_plant_polygons(poly_df, geom_dict, site_df, site_coord_dict, out_shp):
    """
    Generate polygon geometries for power=plant features → ESRI Shapefile.

    Two sources are merged:
      1. Polygon/multipolygon plant ways + relations — actual OSM area geometry
         captured from the osmium GeoJSON-Seq export.
      2. Site-type plant relations (type=site, type=power, or unset) — concave
         hull of their member-node point cloud, buffered 10 m (EPSG:3857).

    The site hull approach mirrors OpenInfraMap:
      PostGIS: ST_Buffer(ST_ConcaveHull(ST_Collect(nodes), 0.95), 10)
      Shapely: concave_hull(multipoint, ratio=0.05).buffer(10)  [after projecting to 3857]

    Degenerate cases:
      1 node  → 500 m circular buffer (facility location, footprint unknown)
      2 nodes → convex hull + 100 m buffer
      3+ nodes → concave hull (ratio=0.95) + 10 m buffer
    """
    to_3857 = Transformer.from_crs("EPSG:4326", "EPSG:3857", always_xy=True).transform
    to_4326 = Transformer.from_crs("EPSG:3857", "EPSG:4326", always_xy=True).transform

    records = []

    poly_geom_count = 0
    skipped_no_geom = 0
    for _, row in poly_df.iterrows():
        oid = row.get("osm_id")
        geom = geom_dict.get(str(oid)) if oid is not None else None
        if geom is None:
            skipped_no_geom += 1
            continue
        records.append({
            "osm_id":     oid,
            "name":       row.get("name") or "",
            "source":     row.get("source") or "",
            "output_mw":  row.get("output_mw"),
            "operator":   row.get("operator") or "",
            "start_date": row.get("start_date") or "",
            "geometry":   geom,
        })
        poly_geom_count += 1
    log.info("  Polygon/multipolygon plant shapes: %d  (no geom: %d)",
             poly_geom_count, skipped_no_geom)

    site_attrs = {}
    if not site_df.empty:
        for _, row in site_df.iterrows():
            oid = row.get("osm_id")
            if oid is not None:
                try:
                    site_attrs[int(oid)] = row
                except (ValueError, TypeError):
                    site_attrs[oid] = row

    site_hull_count = 0
    site_skip_count = 0

    for rid, coords in site_coord_dict.items():
        if not coords:
            site_skip_count += 1
            continue

        try:
            rid_int = int(rid)
        except (ValueError, TypeError):
            rid_int = rid
        attrs = site_attrs.get(rid_int, {})

        def _a(key, default=""):
            v = attrs.get(key)
            if v is None or (isinstance(v, float) and math.isnan(v)):
                return default
            return v

        try:
            if len(coords) == 1:
                lon, lat = coords[0]
                geom_3857 = shp_transform(to_3857, Point(lon, lat)).buffer(500)
            elif len(coords) == 2:
                mp_3857 = shp_transform(to_3857, MultiPoint([(c[0], c[1]) for c in coords]))
                geom_3857 = mp_3857.convex_hull.buffer(100)
            else:
                mp = MultiPoint([(c[0], c[1]) for c in coords])
                mp_3857 = shp_transform(to_3857, mp)
                try:
                    hull = shapely.concave_hull(mp_3857, ratio=0.95)
                except AttributeError:
                    hull = mp_3857.convex_hull  # Shapely < 2.0 fallback
                geom_3857 = hull.buffer(10)

            geom_4326 = shp_transform(to_4326, geom_3857)
            records.append({
                "osm_id":     rid,
                "name":       _a("name"),
                "source":     _a("source"),
                "output_mw":  attrs.get("output_mw"),
                "operator":   _a("operator"),
                "start_date": _a("start_date"),
                "geometry":   geom_4326,
            })
            site_hull_count += 1
        except Exception as exc:
            log.warning("  Hull failed for relation %s (%d nodes): %s", rid, len(coords), exc)
            site_skip_count += 1

    log.info("  Site-relation hulls: %d  (skipped: %d)", site_hull_count, site_skip_count)

    if not records:
        log.warning("No plant polygon features generated — skipping shapefile write.")
        return

    gdf = gpd.GeoDataFrame(records, crs="EPSG:4326")
    out_path = Path(out_shp).with_suffix(".gpkg")
    out_path.parent.mkdir(parents=True, exist_ok=True)
    for f in out_path.parent.glob(out_path.stem + ".*"):
        f.unlink()
    gdf.to_file(str(out_path), driver="GPKG")

    log.info("")
    log.info("  ✓ Plant polygons: %d features → %s", len(gdf), out_path)
    if "source" in gdf.columns:
        log.info("  Source breakdown:")
        for src, cnt in gdf["source"].value_counts().head(8).items():
            log.info("    %-20s %d", src, cnt)
