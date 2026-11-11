#!/usr/bin/env python3
"""Build the national aviation observations for drawn route reports.

Aviation: national NTAD facilities (closed ones kept, with status), runways and paired
runway ends from the fetch_route_inputs.py `ntad` step, with ADDS instrument-procedure flags.
Output: an immutable generation `<root>/<hex id>/` (aviation.json, generation.json) plus
`<root>/manifest.json` (version 2, `complete: true`) as the pointer; `--link` points
data/route/report/screening at the root.
Dependencies for a build: pyproj. Manifest, aviation and promotion checks run with the
standard library alone.
"""
import argparse
import collections
import datetime
import hashlib
import json
import math
import os
from pathlib import Path
import shutil
import time

import build_route_buildings as producer

ROOT = Path(__file__).resolve().parent.parent
CACHE = Path(os.environ.get("ROUTE_CACHE") or ROOT / "data/raw/route-cache")
NTAD_DIR = CACHE / "route-raw/ntad"
OUTPUT_ROOT = CACHE / "route-screening"
LINK = ROOT / "data/route/report/screening"
NTAD = "https://services.arcgis.com/xOi1kZaI0eWDREZv/arcgis/rest/services/"
ADDS = "https://services6.arcgis.com/ssFJjBXIUyZDrSYZ/arcgis/rest/services/"
AVIATION_SCOPE = "National NTAD aviation facilities and runways (closed facilities included, with status); instrument-procedure flag from FAA ADDS."


def log(*args):
    print(time.strftime("%H:%M:%S"), *args, flush=True)


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()


def sha256(path):
    return producer.sha256_file(path)


def guard_disks(root):
    """The external cache disk keeps 25 GB headroom for the build; / must keep 10 GB (temp files live on the cache disk)."""
    disk_guard.require_free(root, NEED_BYTES)
    disk_guard.require_free("/", 0, ROOT_FLOOR)


# ---------------------------------------------------------------- aviation
def finite(value, label):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ValueError(f"invalid {label}")
    return float(value)


def text(value, label):
    if not isinstance(value, str) or not value or len(value) > 300:
        raise ValueError(f"invalid {label}")
    return value


def read_ntad(ntad_dir):
    """The four saved layers, each checked against the fetch manifest's hash and count."""
    ntad_dir = Path(ntad_dir)
    manifest = json.loads((ntad_dir / "ntad_manifest.json").read_text())
    tables = {}
    for name, entry in manifest["layers"].items():
        path = ntad_dir / f"{name}.jsonl"
        if sha256(path) != entry["sha256"]:
            raise ValueError(f"{name}: file differs from the fetch manifest")
        rows = [json.loads(line)["attributes"] for line in path.read_text().splitlines() if line]
        if len(rows) != entry["count"] or entry["count"] != entry["returnCountOnly"]:
            raise ValueError(f"{name}: record count differs from the service count")
        tables[name] = rows
    return manifest, tables


def aviation_from_ntad(manifest, tables, project):
    """Join facilities, runways, paired ends and ADDS flags; project points to EPSG:5070."""
    facilities, runways, ends, adds = (tables[k] for k in ("facilities", "runways", "runway_ends", "adds_airports"))
    cycle = manifest["eff_date"]
    datetime.datetime.strptime(cycle, "%Y/%m/%d")
    if {r.get("EFF_DATE") for t in (facilities, runways, ends) for r in t} != {cycle}:
        raise ValueError("mixed aviation effective cycles")
    by_id = {}
    for f in facilities:
        if text(f.get("ARPT_ID"), "facility id") in by_id:
            raise ValueError("duplicate aviation facility id")
        by_id[f["ARPT_ID"]] = f
    iap = collections.defaultdict(list)
    for a in adds:
        iap[a.get("IDENT")].append(a.get("IAPEXISTS"))

    def xy(row, lon="LONG_DECIMAL", lat="LAT_DECIMAL"):
        x, y = finite(row.get(lon), lon), finite(row.get(lat), lat)
        if not -180 <= x <= 180 or not -90 <= y <= 90:
            raise ValueError("invalid aviation coordinates")
        p = project(x, y)
        return [round(finite(p[0], "projected x"), 1), round(finite(p[1], "projected y"), 1)]

    inventory = []
    for f in facilities:
        flags = iap.get(f["ARPT_ID"])
        inventory.append({"id": f["ARPT_ID"], "siteNo": text(f.get("SITE_NO"), "site number"),
                          "name": text(f.get("ARPT_NAME"), "facility name"), "state": f.get("STATE_CODE"),
                          "country": f.get("COUNTRY_CODE"), "type": text(f.get("SITE_TYPE_CODE"), "facility type"),
                          "use": f.get("FACILITY_USE_CODE"), "status": text(f.get("ARPT_STATUS"), "facility status"),
                          "point": xy(f), "iap": None if not flags else int(any(v == 1 for v in flags))})
    grouped = collections.defaultdict(list)
    for e in ends:
        grouped[(e.get("SITE_NO"), e.get("RWY_ID"))].append(e)
    seen, rows, stats = set(), [], collections.Counter()
    for r in runways:
        k = (text(r.get("SITE_NO"), "site number"), text(r.get("RWY_ID"), "runway id"))
        if k in seen:
            raise ValueError("duplicate aviation runway")
        seen.add(k)
        facility = by_id.get(r.get("ARPT_ID"))
        if facility is None or facility["SITE_NO"] != k[0]:
            raise ValueError("runway facility join failed")
        ids, pair = k[1].split("/"), grouped.get(k, [])
        if len(ids) != 2 or len(pair) != 2 or {e.get("RWY_END_ID") for e in pair} != set(ids):
            raise ValueError("unpaired runway identifiers")
        pair.sort(key=lambda e: ids.index(e["RWY_END_ID"]))
        coords = [xy(e) for e in pair]
        for i, e in enumerate(pair, 1):
            if any(abs(finite(r.get(f"{a}{i}_DECIMAL"), "runway coordinate") - finite(e.get(b), b)) > 1e-8
                   for a, b in (("LONG", "LONG_DECIMAL"), ("LAT", "LAT_DECIMAL"))):
                stats["runway_end_coordinate_mismatch"] += 1
        declared = finite(r.get("RWY_LEN"), "runway length") * .3048
        width = finite(r.get("RWY_WIDTH"), "runway width")
        if declared <= 0 or width <= 0:
            raise ValueError("invalid runway size")
        if abs(math.dist(*coords) / declared - 1) >= .015:
            stats["runway_length_differs_over_1_5_percent"] += 1
        rows.append({"siteNo": k[0], "airport": r["ARPT_ID"], "runway": k[1], "ends": coords, "endIds": ids,
                     "elevationsFt": [None if e.get("RWY_END_ELEV") is None else finite(e["RWY_END_ELEV"], "elevation") for e in pair],
                     "surveyDates": [e.get("RWY_END_ELEV_DATE") or None for e in pair],
                     "elevationSources": [e.get("RWY_END_ELEV_SOURCE") or None for e in pair],
                     "declaredLengthM": round(declared, 2), "widthFt": width})
    points = [f["point"] for f in inventory] + [p for r in rows for p in r["ends"]]
    bounds = [min(p[0] for p in points) - 10_000, min(p[1] for p in points) - 10_000,
              max(p[0] for p in points) + 10_000, max(p[1] for p in points) + 10_000]
    meta = {"file": "aviation.json", "bounds5070": bounds, "cycle": cycle, "scope": AVIATION_SCOPE,
            "source": NTAD, "adds": ADDS, "fetchedAt": text(manifest.get("fetched"), "fetch date"),
            "credit": "Federal Aviation Administration; U.S. Department of Transportation Bureau of Transportation Statistics",
            "license": "Public domain, US federal work; acknowledge FAA/BTS",
            "counts": {"facilities": len(inventory), "runways": len(rows), "runwayEndsOutsidePairedRunways": len(ends) - 2 * len(rows),
                       "facilitiesWithIapFlag": sum(f["iap"] is not None for f in inventory), **dict(stats)},
            "layers": {n: {"url": e["url"], "sha256": e["sha256"], "count": e["count"]} for n, e in manifest["layers"].items()}}
    return {"version": 2, "cycle": cycle, "facilities": inventory, "runways": rows}, meta


def activate_generation(stage, output, manifest, replace=os.replace):
    """Publish immutable files before the atomic pointer; previous readers retain their generation."""
    stage, output = Path(stage), Path(output)
    files = {"aviation.json": sha256(stage / "aviation.json")}
    bound = {**manifest, "files": files}
    generation = hashlib.sha256(canonical(bound)).hexdigest()[:32]
    value = {**bound, "version": 2, "generation": generation}
    producer.atomic_json(stage / "generation.json", value)
    output.mkdir(parents=True, exist_ok=True)
    target = output / generation
    if target.exists():
        if any(not (target / n).is_file() or sha256(target / n) != digest for n, digest in files.items()):
            raise ValueError("existing immutable generation is corrupt")
        if json.loads((target / "generation.json").read_text()) != value:
            raise ValueError("existing immutable generation metadata differs")
    else:
        replace(stage, target)
    producer.atomic_json(output / "manifest.json", value)
    return value


def link_report_dir(root, link=LINK):
    """Point `link` at the generation root, keeping any regional files already there beside it."""
    root, link = Path(root), Path(link)
    if link.is_symlink():
        if link.resolve() == root.resolve():
            return
        raise ValueError("the report link points elsewhere")
    if link.is_dir():
        moves = [(p, root / ("manifest.regional-v1.json" if p.name == "manifest.json" else p.name)) for p in link.iterdir()]
        if any(t.exists() for _, t in moves):
            raise ValueError("a regional file would overwrite a national one")
        for p, t in moves:
            shutil.move(str(p), t)
        link.rmdir()
    link.parent.mkdir(parents=True, exist_ok=True)
    link.symlink_to(root)


def build(ntad_dir, root):
    from pyproj import Transformer

    root = Path(root)
    root.mkdir(parents=True, exist_ok=True)
    ntad_manifest, tables = read_ntad(ntad_dir)
    aircraft, aviation_meta = aviation_from_ntad(ntad_manifest, tables, Transformer.from_crs(4326, 5070, always_xy=True).transform)
    stage = root / f".stage-{hashlib.sha256(canonical(ntad_manifest)).hexdigest()[:16]}"
    stage.mkdir(exist_ok=True)
    producer.atomic_json(stage / "aviation.json", aircraft)
    aviation_meta["sha256"] = sha256(stage / "aviation.json")
    result = activate_generation(stage, root, {"complete": True, "aviation": aviation_meta})
    log(f"Generation {result['generation']}: {len(aircraft['facilities'])} facilities, {len(aircraft['runways'])} runways")
    return result


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--ntad-dir", type=Path, default=Path(os.environ.get("NTAD_DIR", NTAD_DIR)))
    p.add_argument("--output-dir", type=Path, default=OUTPUT_ROOT)
    p.add_argument("--link", action="store_true", help="point data/route/report/screening at the output dir")
    args = p.parse_args()
    build(args.ntad_dir, args.output_dir)
    if args.link:
        link_report_dir(args.output_dir)


if __name__ == "__main__":
    main()
