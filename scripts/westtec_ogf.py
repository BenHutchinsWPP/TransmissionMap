#!/usr/bin/env python3
"""WestTEC 10-Yr feature ids and the WestTEC → Our Grid Future crosswalk.

The WestTEC shapefiles carry no publisher key, so `westtec_fid()` derives one
from content: a short sha1 over the feature's dataset, scenario, name, voltage,
upgrade type and its line-part endpoints on a 0.01° grid (about 1 km), sorted
so a reversed line or reordered parts hash the same. A publisher edit to any of
those fields yields a new id.

The crosswalk is the reviewed table `scripts/westtec_ogf_crosswalk.csv`, one
row per WestTEC feature (plus one row per OGF WestTEC record with no WestTEC
feature). `extract_westtec.py` joins it into `ogf_ids` (`|R-0195|R-0494|`, the
region-tag form, so a `contains` filter on `|R-0195|` works) and fails when a
feature or an OGF "WestTEC 10 Yr Plan" record has no row. Only `confirmed`
and `auto` rows ship their ids; `review` and `none` rows ship none. Notes cite
RecordIDs, WestTEC names and OSM/HIFLD substations only: OGF's licence bars
redistributing its attributes, so no OGF project name goes in the table.

    venv/bin/python scripts/westtec_ogf.py seed

appends a row for every feature or OGF record the table lacks, pre-filled by
`propose()` (status `auto`, or `none` when nothing matches); existing rows are
kept as they are. Deps: extract_westtec.py, data/build/ogf_planned_transmission.gpkg.
"""
from __future__ import annotations

import csv
import hashlib
import sys
from pathlib import Path

CROSSWALK = Path(__file__).resolve().parent / "westtec_ogf_crosswalk.csv"
OGF_GPKG = Path("data/build/ogf_planned_transmission.gpkg")
COLUMNS = ["westtec_fid", "westtec_name", "scenario", "ogf_record_ids", "status", "note"]
STATUSES = {"auto", "review", "confirmed", "none"}
SHIP = {"auto", "confirmed"}

GRID_DP = 2          # endpoint grid: 0.01°
BUFFER_M = 500       # corridor half-width for the overlap fractions
MATCH_FRAC = 0.9     # either direction's covered share needed for a match
NEAR_M = 2000        # pairs further apart than this are never scored


def westtec_fid(dataset, scenario, name, voltage_kv, upgrade_type, geom) -> str:
    """Content id of one WestTEC feature (EPSG:4326 geometry)."""
    parts = geom.geoms if geom.geom_type == "MultiLineString" else [geom]
    ends = sorted({(round(p.coords[i][0], GRID_DP) + 0.0, round(p.coords[i][1], GRID_DP) + 0.0)
                   for p in parts for i in (0, -1)})
    key = "|".join([dataset, scenario, str(name).strip(), f"{float(voltage_kv):g}", str(upgrade_type),
                    ";".join(f"{x:.{GRID_DP}f},{y:.{GRID_DP}f}" for x, y in ends)])
    return hashlib.sha1(key.encode()).hexdigest()[:12]


def overlap(a, b, buffer_m=BUFFER_M) -> tuple[float, float]:
    """Share of a's length within buffer_m of b, and of b's within buffer_m of a
    (metric CRS)."""
    return (a.intersection(b.buffer(buffer_m)).length / a.length,
            b.intersection(a.buffer(buffer_m)).length / b.length)


def ogf_scenario(planproc: str) -> str | None:
    """'WestTEC 10 Yr Plan (SRA)' → 'SRA'; None for any other process."""
    if not planproc or not planproc.startswith("WestTEC") or "(" not in planproc:
        return None
    return planproc[planproc.index("(") + 1:planproc.rindex(")")]


def propose(westtec, ogf) -> dict[str, list[tuple[str, float, float]]]:
    """fid → [(RecordID, fw, fo)] for each OGF WestTEC record the rule matches:
    same scenario, the WestTEC voltage within MinVolt..MaxVolt, and at least
    MATCH_FRAC of either line within BUFFER_M of the other. Both frames in a
    metric CRS; westtec carries fid/scenario/voltage_kv, ogf the raw columns."""
    out: dict[str, list[tuple[str, float, float]]] = {}
    for w in westtec.itertuples():
        hits = []
        for o in ogf.itertuples():
            if (ogf_scenario(o.PlanProc) != w.scenario
                    or not (o.MinVolt <= w.voltage_kv <= o.MaxVolt)
                    or w.geometry.distance(o.geometry) > NEAR_M):
                continue
            fw, fo = overlap(w.geometry, o.geometry)
            if max(fw, fo) >= MATCH_FRAC:
                hits.append((o.RecordID, round(fw, 2), round(fo, 2)))
        out[w.fid] = sorted(hits)
    return out


def read_table(path=CROSSWALK) -> list[dict]:
    with open(path, newline="", encoding="utf-8") as f:
        rows = list(csv.DictReader(f))
    for r in rows:
        if r["status"] not in STATUSES:
            raise ValueError(f"{path}: unknown status {r['status']!r} for {r['westtec_fid'] or r['ogf_record_ids']}")
    return rows


def write_table(rows, path=CROSSWALK) -> None:
    with open(path, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, COLUMNS, lineterminator="\n")
        w.writeheader()
        w.writerows(rows)


def record_ids(cell: str) -> list[str]:
    return [x for x in cell.split("|") if x]


def ogf_ids(rows) -> dict[str, str | None]:
    """fid → '|R-1|R-2|' for confirmed/auto rows, None for review/none rows."""
    out = {}
    for r in rows:
        if r["westtec_fid"]:
            ids = record_ids(r["ogf_record_ids"])
            out[r["westtec_fid"]] = "|" + "|".join(ids) + "|" if ids and r["status"] in SHIP else None
    return out


def uncovered(rows, fids, ogf_records) -> tuple[list[str], list[str], list[str]]:
    """(features with no row, OGF WestTEC records no row names, rows whose fid
    no longer exists)."""
    have = {r["westtec_fid"] for r in rows if r["westtec_fid"]}
    named = {i for r in rows for i in record_ids(r["ogf_record_ids"])}
    return (sorted(set(fids) - have), sorted(set(ogf_records) - named), sorted(have - set(fids)))


def load_ogf_westtec(path=OGF_GPKG):
    import geopandas as gpd
    ogf = gpd.read_file(path)
    return ogf[ogf["PlanProc"].fillna("").str.startswith("WestTEC")]


def seed() -> None:
    from extract_westtec import build
    westtec = build(join=False)
    ogf = load_ogf_westtec()
    rows = read_table() if CROSSWALK.exists() else []
    missing, unnamed, stale = uncovered(rows, westtec["fid"], ogf["RecordID"])
    hits = propose(westtec[westtec["fid"].isin(missing)].to_crs(5070), ogf.to_crs(5070))
    for w in westtec[westtec["fid"].isin(missing)].itertuples():
        ids = [h[0] for h in hits[w.fid]]
        rows.append({"westtec_fid": w.fid, "westtec_name": w.name, "scenario": w.scenario,
                     "ogf_record_ids": "|".join(ids), "status": "auto" if ids else "none",
                     "note": "; ".join(f"{i} fw={fw} fo={fo}" for i, fw, fo in hits[w.fid])})
    named = {i for r in rows for i in record_ids(r["ogf_record_ids"])}
    for o in ogf[ogf["RecordID"].isin(unnamed) & ~ogf["RecordID"].isin(named)].itertuples():
        rows.append({"westtec_fid": "", "westtec_name": "", "scenario": ogf_scenario(o.PlanProc),
                     "ogf_record_ids": o.RecordID, "status": "none",
                     "note": f"no WestTEC feature: a {o.MaxVolt:g} kV record"})
    write_table(rows)
    print(f"{CROSSWALK.name}: {len(missing)} feature rows and {len(unnamed)} OGF rows added; "
          f"{len(stale)} rows name a fid no longer in the data: {stale}")


if __name__ == "__main__":
    if sys.argv[1:] != ["seed"]:
        sys.exit(__doc__)
    import os
    os.chdir(Path(__file__).resolve().parent.parent)
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    seed()
