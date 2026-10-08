"""Build the map file from the tracked dataset.

    python build_layer.py [--work DIR] [--dataset DIR] [--build DIR] [--as-of YYYY-MM-DD]

Reads   DATASET/moratoriums.csv, DATASET/events.csv, WORK/census/cb_2023_us_county_500k.zip,
        WORK/inputs/territories/{retail,ba}.geojson.gz (build_territories.py: HIFLD retail
          territories, EIA BAs, already simplified), or territories.gpkg (unsimplified) if absent
Writes  DATASET/dc_moratoriums.geojson — one feature per jurisdiction, one
        feature per line (so git stores each sync as a small delta):
          kind=state    polygon  every state-level measure in that state
          kind=county   polygon  every county-level measure in that county
          kind=utility  polygon  every measure of one utility (by eia_id, joined to the HIFLD
                                 retail territory `ID`, clipped to the row's state), or of one
                                 grid operator (GRID below: its EIA balancing-authority polygon)
          kind=point    point    city/town/township/village/tribal, and a utility with no
                                 eia_id or none that matches a territory (water authorities)
        Each feature carries `items` (JSON list of its measures) and `history`
        (JSON list of its most recent events), which the popup renders.

Status is computed as of --as-of: an active/extended row whose date_expires has
passed is shown expired. `cls` is the feature's strongest class:
ban > active > pending > ended.
"""
import argparse, csv, datetime as dt, gzip, json, os
from collections import defaultdict
import geopandas as gpd
from shapely.ops import unary_union

RANK = {"ban": 3, "active": 2, "pending": 1, "ended": 0}
# A statewide row that pauses one grid operator's whole footprint -> (EIA BA code, label).
GRID = {"nm-state-tx-abbott-2026-08-03-data-center-audit-directive": ("ERCO", "ERCOT grid region")}


def read(p):
    with open(p, newline="") as f:
        return list(csv.DictReader(f))


def effective_status(r, as_of):
    s = r["status"]
    if s in ("active", "extended") and r["date_expires"] and r["date_expires"] < as_of:
        return "expired"
    return s


def cls(r, status):
    if r["type"] == "permanent ban" and status in ("active", "extended"):
        return "ban"
    if status in ("active", "extended"):
        return "active"
    if status == "pending":
        return "pending"
    return "ended"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--as-of", default=dt.datetime.now(dt.timezone.utc).date().isoformat())
    ap.add_argument("--work", default=os.environ.get("DCM_WORK") or os.getcwd())
    ap.add_argument("--dataset")
    ap.add_argument("--build")  # accepted for a uniform CLI; this step has no intermediates
    args = ap.parse_args()
    as_of = args.as_of
    work = os.path.abspath(args.work)
    D = os.path.abspath(args.dataset or f"{work}/dataset")

    rows = read(f"{D}/moratoriums.csv")
    events = defaultdict(list)
    for e in read(f"{D}/events.csv"):
        events[e["id"]].append(e)

    T = f"{work}/inputs/territories"
    want = sorted({r["eia_id"] for r in rows if r["level"] == "utility" and r["eia_id"]})
    # Pre-simplified territories are drawn as they are; the gpkg is simplified here at the same tolerances.
    presimplified = os.path.exists(f"{T}/retail.geojson.gz") and os.path.exists(f"{T}/ba.geojson.gz")
    if presimplified:
        print(f"territories: {T}/{{retail,ba}}.geojson.gz (pre-simplified)")

        def gz(name, key):
            with gzip.open(f"{T}/{name}.geojson.gz", "rt") as f:
                g = gpd.GeoDataFrame.from_features(json.load(f)["features"], crs=4326)
            return g.set_index(key)
        retail, ba = gz("retail", "eia_id"), gz("ba", "ba_code")
        retail = retail[retail.index.isin(want)]
    else:
        print(f"territories: {T}/territories.gpkg (no .geojson.gz; simplifying here)")
        gpkg = f"{T}/territories.gpkg"
        retail = gpd.read_file(gpkg, layer="retail", where="eia_id IN (%s)" % ",".join(f"'{e}'" for e in want)
                               ).set_index("eia_id") if want else gpd.GeoDataFrame()
        ba = gpd.read_file(gpkg, layer="ba").set_index("ba_code")
    simplify = (lambda g, tol: g) if presimplified else (lambda g, tol: g.simplify(tol, preserve_topology=True))

    groups = defaultdict(list)
    for r in rows:
        if r["id"] in GRID:
            key = ("utility", "ba:" + GRID[r["id"]][0])
        elif r["level"] == "utility" and r["eia_id"] in retail.index:
            key = ("utility", r["eia_id"])
        elif r["level"] == "utility" and r["eia_id"]:
            print(f"WARNING {r['id']}: eia_id {r['eia_id']} has no HIFLD territory;",
                  "drawn as a point" if r["lat"] else "no point either, left off the map")
            if not r["lat"]:
                continue
            key = ("point", f"{r['state']}|{r['name']}|{r['lat']}|{r['lon']}")
        elif r["level"] == "state":
            key = ("state", r["state"])
        elif r["level"] == "county":
            key = ("county", r["county_fips"])
        elif r["place_geoid"] and r["level"] != "utility":  # one feature per Census place, however each row spells it
            key = ("point", f"{r['state']}|{r['place_geoid']}")
        else:
            key = ("point", f"{r['state']}|{r['name']}|{r['lat']}|{r['lon']}")
        groups[key].append(r)
    for rs in groups.values():  # name and locate a shared feature from its upstream row
        rs.sort(key=lambda r: not r["id"].startswith("nm-"))

    cty = gpd.read_file(f"zip://{work}/census/cb_2023_us_county_500k.zip")[
        ["GEOID", "NAMELSAD", "STUSPS", "STATE_NAME", "geometry"]].to_crs(4326)
    county_geom = cty.set_index("GEOID")
    wanted_states = {k[1] for k in groups if k[0] == "state"}
    states = (cty[cty.STUSPS.isin(wanted_states)].dissolve(by="STUSPS", aggfunc="first")
              .geometry.simplify(0.01, preserve_topology=True))
    util_states = {rs[0]["state"] for k, rs in groups.items() if k[0] == "utility"}
    outline = cty[cty.STUSPS.isin(util_states)].dissolve(by="STUSPS").geometry
    counties = county_geom.loc[[k[1] for k in groups if k[0] == "county"]]
    counties = counties.assign(geometry=counties.geometry.simplify(0.003, preserve_topology=True))

    def geom(kind, key, rs):
        if kind == "state":
            return states.loc[key].__geo_interface__
        if kind == "county":
            return counties.loc[key].geometry.__geo_interface__
        if kind == "utility" and key.startswith("ba:"):  # state-sized, so simplified like a state
            return simplify(ba.loc[key[3:]].geometry, 0.01).__geo_interface__
        if kind == "utility":  # the part in the row's state: a commission order stops at the state line
            g = retail.loc[key].geometry.intersection(outline.loc[rs[0]["state"]])
            if g.geom_type == "GeometryCollection":  # drop the slivers of shared boundary
                g = unary_union([p for p in g.geoms if p.geom_type in ("Polygon", "MultiPolygon")])
            return simplify(g, 0.003).__geo_interface__
        return {"type": "Point", "coordinates": [float(rs[0]["lon"]), float(rs[0]["lat"])]}

    def rnd(g):
        # 4 decimals ≈ 11 m: far finer than the simplification, and keeps the file small.
        if isinstance(g, (list, tuple)):
            return [rnd(x) for x in g]
        return round(g, 4)

    feats = []
    for (kind, key), rs in sorted(groups.items()):
        items, hist, best, last = [], [], "ended", ""
        for r in sorted(rs, key=lambda r: (r["date_adopted"] or "9999", r["id"]), reverse=True):
            st = effective_status(r, as_of)
            c = cls(r, st)
            best = max(best, c, key=RANK.get)
            items.append({k: v for k, v in {
                "name": r["name"], "type": r["type"], "status": st, "cls": c,
                "adopted": r["date_adopted"], "expires": r["date_expires"],
                "scope": r["scope"], "summary": r["summary"],
                "src": r["source_urls"].split("|")[:3] if r["source_urls"] else [],
                "verify": r["verify"] == "true" or None, "level": r["level"],
            }.items() if v})
            for e in events[r["id"]]:
                # A seeded event without a real-world date stays undated: the seed
                # day is when we started tracking, not when it happened.
                d = e["event_date"] or ("" if e["note"] == "seed" else e["recorded_at"])
                last = max(last, d)
                hist.append({"date": d, "event": e["event"], "name": r["name"],
                             **({"new": e["new"]} if e["new"] else {})})
        hist.sort(key=lambda h: h["date"] or "0", reverse=True)
        r0 = rs[0]
        if kind == "state":
            name = county_geom[county_geom.STUSPS == key].STATE_NAME.iloc[0]
        elif kind == "county":
            name = f"{county_geom.loc[key].NAMELSAD}, {county_geom.loc[key].STUSPS}"
        elif r0["id"] in GRID:
            name = f"{GRID[r0['id']][1]}, {r0['state']}"
        else:
            name = f"{r0['name']}, {r0['state']}"
        g = geom(kind, key, rs)
        g = {"type": g["type"], "coordinates": rnd(g["coordinates"])}
        feats.append({"type": "Feature", "geometry": g, "properties": {
            "kind": kind, "name": name, "state": r0["state"], "level": r0["level"],
            "cls": best, "n": len(rs), "last_event": last,
            "items": json.dumps(items, separators=(",", ":")),
            "history": json.dumps(hist[:8], separators=(",", ":")),
        }})

    with open(f"{D}/dc_moratoriums.geojson", "w") as f:
        f.write('{"type":"FeatureCollection","generated_utc":"%s","features":[\n' % as_of)
        f.write(",\n".join(json.dumps(x, separators=(",", ":")) for x in feats))
        f.write("\n]}\n")
    by = defaultdict(int)
    for x in feats:
        by[(x["properties"]["kind"], x["properties"]["cls"])] += 1
    print(len(feats), "features;", dict(sorted(by.items())))


if __name__ == "__main__":
    main()
