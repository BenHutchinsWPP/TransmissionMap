"""Merge the research CSVs into the tracked dataset and log what changed.

    python sync.py [--work DIR] [--dataset DIR] [--build DIR] [--as-of YYYY-MM-DD]

Reads   BUILD/moratoriums.csv (build.py: upstream-schema candidate rows) + BUILD/research_additions.csv
        + BUILD/state_actions.csv. research_additions.csv (build_research.py) is additions.csv with
        fixes plus the dated research batches; without it, WORK/inputs/additions.csv is read.
        DATASET/moratoriums.csv (the previous published state) and DATASET/events.csv.
Writes  DATASET/moratoriums.csv   current state, one row per instrument, sorted by id
        DATASET/events.csv        append-only change log (never rewritten)

DATASET is the checkout of the `data-moratoriums` branch (default WORK/dataset). BUILD/moratoriums.csv
and DATASET/moratoriums.csv are different files: the first is the input, the second the output.
With --as-of, an active/extended row whose full ISO date_expires is before the as-of date becomes
`expired`, logged as an `expired` event dated date_expires.
Re-running with unchanged inputs writes byte-identical files and no events, so
every commit on that branch is a real change. A new column is appended to FIELDS; rows
written before it read it as empty, so adding a quiet column logs no events.

Seeding (no dataset/moratoriums.csv yet): each record's known history (proposed,
adopted, extended, expired/lifted/replaced) becomes events with `recorded_at` =
the as-of date and note `seed`, so the feed has a past from day one.
"""
import argparse, csv, datetime as dt, os, re, sys


FIELDS = [
    "id", "level", "name", "state", "county_fips", "place_geoid", "lat", "lon",
    "type", "scope", "status", "date_adopted", "date_expires", "duration_days",
    "extended", "summary", "source_urls", "upstream_id", "verify", "date_uncertain",
    "last_verified", "eia_id",
]
EVENT_FIELDS = ["recorded_at", "id", "event", "event_date", "field", "old", "new", "note"]
# Changes to these alone are bookkeeping, not news: no event.
# eia_id only links a utility row to its service-territory polygon.
QUIET = {"source_urls", "summary", "last_verified", "verify", "scope", "upstream_id", "date_uncertain", "eia_id"}

TYPE_FROM_STATE = {
    "governor_directive": "executive order", "executive_order": "executive order",
}


def b(v):
    return "true" if str(v).strip().lower() in ("true", "1", "yes") else "false"


def coord(v):
    return f"{float(v):.5f}" if str(v).strip() else ""


def local_row(r):
    return {
        "id": r["id"], "level": r["jurisdiction_level"], "name": r["jurisdiction_name"],
        "state": r["state"], "county_fips": r["county_fips"], "place_geoid": r["place_geoid"],
        "lat": coord(r["lat"]), "lon": coord(r["lon"]), "type": r["type"], "scope": r["scope"],
        "status": r["status"], "date_adopted": r["date_adopted"], "date_expires": r["date_expires"],
        "duration_days": str(int(float(r["duration_days"]))) if r["duration_days"] else "",
        "extended": b(r["extended"]), "summary": r["summary"].strip(),
        "source_urls": r["source_urls"], "upstream_id": r["upstream_id"],
        "verify": b(r["verify_flag"]), "date_uncertain": "true" if r["date_uncertainty"] not in ("", "exact") else "false",
        "last_verified": r["last_verified"], "eia_id": r.get("eia_id", ""),
    }


def state_row(r):
    # Only measures that actually pause something; tax/tariff/reporting laws stay out.
    return {
        "id": r["id"], "level": "state", "name": r["instrument"], "state": r["state"],
        "county_fips": "", "place_geoid": "", "lat": "", "lon": "",
        "type": TYPE_FROM_STATE.get(r["instrument_type"], "permit pause"),
        "scope": r["pause_kind"], "status": "active",
        "date_adopted": r["date_effective"] or r["date_last_action"], "date_expires": "",
        "duration_days": "", "extended": "false",
        "summary": (r["summary"] + (f" Ends: {r['end_condition']}" if r["end_condition"] else "")).strip(),
        "source_urls": r["source_urls"], "upstream_id": r["upstream_id"],
        "verify": b(r["verify_flag"]), "date_uncertain": "false", "last_verified": "", "eia_id": "",
    }


def read(path):
    with open(path, newline="") as f:
        return list(csv.DictReader(f))


def candidate(build, inputs):
    rows = {}
    for r in read(f"{build}/moratoriums.csv"):
        rows[r["id"]] = local_row(r)
    # Additions win: some carry newer action on an upstream row (same upstream_id).
    by_upstream = {v["upstream_id"]: k for k, v in rows.items() if v["upstream_id"]}
    add = f"{build}/research_additions.csv"
    for r in read(add if os.path.exists(add) else f"{inputs}/additions.csv"):
        row = local_row(r)
        old = by_upstream.get(row["upstream_id"]) if row["upstream_id"] else None
        if old:
            row["id"] = old
        rows[row["id"]] = row
    for r in read(f"{build}/state_actions.csv"):
        if b(r["pause_like"]) == "true":
            rows[r["id"]] = state_row(r)
    return rows


def expire(rows, as_of):
    """Mark active/extended rows whose date_expires has passed as expired; returns their ids."""
    out = set()
    for rid, r in rows.items():
        d = r["date_expires"]
        if r["status"] in ("active", "extended") and re.fullmatch(r"\d{4}-\d{2}-\d{2}", d) and d < as_of:
            r["status"] = "expired"
            out.add(rid)
    return out


def seed_events(r, as_of):
    ev = lambda e, d="", **kw: {"recorded_at": as_of, "id": r["id"], "event": e,
                                "event_date": d, "field": "", "old": "", "new": "",
                                "note": "seed", **kw}
    out = []
    if r["status"] == "pending":
        return [ev("proposed")]
    out.append(ev("banned" if r["type"] == "permanent ban" else "adopted", r["date_adopted"]))
    if r["extended"] == "true":
        out.append(ev("extended", field="date_expires", new=r["date_expires"]))
    if r["status"] in ("expired", "lifted", "replaced"):
        out.append(ev(r["status"], r["date_expires"] if r["status"] == "expired" else ""))
    return out


def diff_events(old, new, as_of, expired=frozenset()):
    ev = lambda rid, e, d="", **kw: {"recorded_at": as_of, "id": rid, "event": e,
                                     "event_date": d, "field": "", "old": "", "new": "",
                                     "note": "", **kw}
    out = []
    for rid in sorted(new.keys() - old.keys()):
        r = new[rid]
        out.append(ev(rid, "added", r["date_adopted"], new=r["status"]))
    for rid in sorted(old.keys() - new.keys()):
        out.append(ev(rid, "removed", old=old[rid]["status"]))
    for rid in sorted(old.keys() & new.keys()):
        a, z = old[rid], new[rid]
        if a["status"] != z["status"]:
            e = {"pending>active": "adopted", "pending>extended": "adopted"}.get(
                f"{a['status']}>{z['status']}", z["status"] if z["status"] in
                ("expired", "lifted", "replaced", "extended") else "status")
            out.append(ev(rid, e, z["date_expires"] if rid in expired else "", field="status", old=a["status"], new=z["status"]))
        if a["date_expires"] != z["date_expires"] and z["status"] == a["status"]:
            later = z["date_expires"] > a["date_expires"]
            out.append(ev(rid, "extended" if later and a["date_expires"] else "corrected",
                          field="date_expires", old=a["date_expires"], new=z["date_expires"]))
        for k in FIELDS:
            if k in QUIET or k in ("status", "date_expires", "extended") or a.get(k, "") == z[k]:
                continue
            out.append(ev(rid, "corrected", field=k, old=a.get(k, ""), new=z[k]))
    return out


def write_csv(path, fields, rows, mode="w"):
    exists = os.path.exists(path) and mode == "a"
    with open(path, mode, newline="") as f:
        w = csv.DictWriter(f, fieldnames=fields, lineterminator="\n")
        if not exists:
            w.writeheader()
        w.writerows(rows)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--as-of", default=dt.datetime.now(dt.timezone.utc).date().isoformat())
    ap.add_argument("--work", default=os.environ.get("DCM_WORK") or os.getcwd())
    ap.add_argument("--dataset")
    ap.add_argument("--build")
    args = ap.parse_args()
    as_of = args.as_of
    work = os.path.abspath(args.work)
    OUT = os.path.abspath(args.dataset or f"{work}/dataset")
    build = os.path.abspath(args.build or f"{work}/build")
    os.makedirs(OUT, exist_ok=True)
    new = candidate(build, f"{work}/inputs")
    expired = expire(new, as_of)
    cur_path = f"{OUT}/moratoriums.csv"
    if os.path.exists(cur_path):
        old = {r["id"]: r for r in read(cur_path)}
        events = diff_events(old, new, as_of, expired)
    else:
        events = [e for r in sorted(new.values(), key=lambda r: r["id"]) for e in seed_events(r, as_of)]
    write_csv(cur_path, FIELDS, [new[k] for k in sorted(new)])
    if events:
        write_csv(f"{OUT}/events.csv", EVENT_FIELDS, events, mode="a")
    print(f"{len(new)} records, {len(events)} new events", file=sys.stderr)


if __name__ == "__main__":
    main()
