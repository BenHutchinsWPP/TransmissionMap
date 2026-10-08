"""Utility and grid-operator service areas, for drawing utility-level measures as polygons.

    PYTHONPATH=<dir with pyarrow> python build_territories.py [--work DIR] [--root REPO]
    python build_territories.py [--work DIR] --from-gpkg PATH

Reads   REPO/data/raw/hifld/regions/retail-service-territories.parquet  HIFLD Retail Service
            Territories; `ID` is the EIA-861 utility number (needs pyarrow to read)
        REPO/data/raw/eia-ba/balancing_authorities.geojson  EIA balancing authorities
        REPO is --root (default: the checkout this script lives in)
        or, with --from-gpkg, a territories.gpkg this script wrote earlier (no pyarrow needed)
Writes  WORK/inputs/territories/retail.geojson.gz  eia_id + polygon, every HIFLD territory,
          simplified at 0.003°, sorted by eia_id
        WORK/inputs/territories/ba.geojson.gz      ba_code + polygon, every EIA balancing
          authority, simplified at 0.01°, sorted by ba_code
          Both EPSG:4326, coordinates rounded to 4 decimals, byte-deterministic (gzip mtime 0),
          and already simplified the way build_layer.py draws them, so it does not simplify again.
        WORK/inputs/territories/territories.gpkg  (raw-source runs only) the same two layers
          unsimplified, with names: retail (eia_id, name, state), ba (ba_code, name)

An input to build_layer.py, like census/: run it again only when the HIFLD or EIA
source is refreshed. rebuild.sh does not run it.
"""
import argparse, gzip, json, os
import geopandas as gpd
import shapely

# Tolerance in degrees per layer: what build_layer.py used when it simplified at draw time.
TOL = {"retail": ("eia_id", 0.003), "ba": ("ba_code", 0.01)}


def rnd(c):
    if isinstance(c, (list, tuple)):
        return [rnd(x) for x in c]
    return round(c, 4)


def polygonal(g):
    """Valid polygonal geometry on the 4-decimal grid: snapping to the grid, rather than rounding
    afterwards, keeps every polygon valid, so build_layer.py can clip it as it is."""
    g = shapely.make_valid(g)
    if g.geom_type == "GeometryCollection":
        g = shapely.union_all([p for p in g.geoms if p.geom_type in ("Polygon", "MultiPolygon")])
    return shapely.set_precision(g, 1e-4)


def write_gz(gdf, layer, path):
    key, tol = TOL[layer]
    gdf = gdf.sort_values(key)
    geoms = [polygonal(g) for g in gdf.geometry.simplify(tol, preserve_topology=True)]
    lines = []
    for k, g in zip(gdf[key], geoms):
        gi = g.__geo_interface__
        lines.append(json.dumps({"type": "Feature", "properties": {key: k},
                                 "geometry": {"type": gi["type"], "coordinates": rnd(gi["coordinates"])}},
                                separators=(",", ":")))
    body = '{"type":"FeatureCollection","features":[\n' + ",\n".join(lines) + "\n]}\n"
    with open(path, "wb") as raw, gzip.GzipFile(filename="", mode="wb", fileobj=raw, mtime=0) as f:
        f.write(body.encode())
    print(f"{len(gdf)} {layer} -> {path} ({os.path.getsize(path):,} bytes)")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--work", default=os.environ.get("DCM_WORK") or os.getcwd())
    ap.add_argument("--dataset")  # accepted for a uniform CLI; unused
    ap.add_argument("--build")  # accepted for a uniform CLI; unused
    ap.add_argument("--root", default=os.path.abspath(f"{os.path.dirname(os.path.abspath(__file__))}/../.."))
    ap.add_argument("--from-gpkg", help="derive the .geojson.gz files from an existing territories.gpkg")
    args = ap.parse_args()
    OUT = f"{os.path.abspath(args.work)}/inputs/territories"
    os.makedirs(OUT, exist_ok=True)
    if args.from_gpkg:
        r = gpd.read_file(args.from_gpkg, layer="retail")
        b = gpd.read_file(args.from_gpkg, layer="ba")
    else:
        ROOT = args.root
        r = gpd.read_parquet(f"{ROOT}/data/raw/hifld/regions/retail-service-territories.parquet")
        r = r.set_crs(4326) if r.crs is None else r.to_crs(4326)
        r = gpd.GeoDataFrame({"eia_id": r.ID.astype(str), "name": r.NAME, "state": r.STATE},
                             geometry=r.geometry.make_valid(), crs=4326)
        b = gpd.read_file(f"{ROOT}/data/raw/eia-ba/balancing_authorities.geojson").to_crs(4326)
        b = gpd.GeoDataFrame({"ba_code": b.BA_Abbrev, "name": b.BAL_AUTH},
                             geometry=b.geometry.make_valid(), crs=4326)
        gpkg = f"{OUT}/territories.gpkg"
        if os.path.exists(gpkg):
            os.remove(gpkg)
        r.sort_values("eia_id").to_file(gpkg, layer="retail", driver="GPKG")
        b.sort_values("ba_code").to_file(gpkg, layer="ba", driver="GPKG")
        print(f"{len(r)} retail territories, {len(b)} balancing authorities -> {gpkg}")
    assert r.eia_id.is_unique and b.ba_code.is_unique
    write_gz(r, "retail", f"{OUT}/retail.geojson.gz")
    write_gz(b, "ba", f"{OUT}/ba.geojson.gz")


if __name__ == "__main__":
    main()
