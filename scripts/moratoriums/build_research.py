"""research_additions.csv: additions.csv with the 2026-10-07 re-verification applied, plus every research row.

    python build_research.py [--work DIR] [--dataset DIR] [--build DIR]

Reads   WORK/inputs/additions.csv, BUILD/moratoriums.csv (build.py: upstream rows, for corrections),
        WORK/census/*.zip, and from WORK/inputs/research/2026-10-07/ (then pass2/, then pass3/; a later pass wins on the same id):
          utilities.csv                 utility / state-agency pauses; an `eia_id` column is honoured
          bans_nj.csv, bans_other.csv,  bans.csv   permanent bans (and a few moratoria)
          sweep.csv, moratoriums.csv    new moratoria, plus kind=correction|extension|replacement of upstream rows
          reverify.csv                  fixes to our additions.csv rows (pass 1 only; encoded in FIX below)
          updates.csv                   file,id,field,old,new,...: patch any input row; field=DROP removes it
          eia_ids.csv                   id,eia_id,...: EIA-861 utility number per row id (pass3 only)
        then WORK/inputs/research/weekly/<YYYY-MM-DD>/ in date order (written by refresh/run.py), same files; its rows
        carry that folder's date as last_verified.
Writes  BUILD/research_additions.csv  additions.csv schema; sync.py reads it in place of additions.csv. Holds:
          - additions.csv rows, fixed and minus DROP;
          - upstream rows changed by research (id nm-<upstream_id>, upstream_id set, so sync.py swaps them in);
          - new research rows (level=state rows for state agencies).
        BUILD/qa_research.csv   rows not geocoded, duplicates dropped, upstream rows changed, weak sources.
Every research row is verify_flag=True (shown as "unconfirmed").

eia_id (EIA-861 utility number = HIFLD Retail Service Territory `ID`) lets build_layer.py draw a
utility row as its service territory. Precedence: the row's own eia_id column, then
pass3/eia_ids.csv, then EIA_ID below. A state-agency row with an eia_id (a commission order on
one utility's territory) becomes level=utility. A utility with an eia_id needs no UTILITY_HQ
point: without one it gets no coordinates and is drawn only as its territory.

AS_OF is frozen to the 2026-10-07 passes' `last_verified`; weekly rows carry their folder date.
A row that breaks an invariant (state of its point, duplicate id) is flagged in qa_research.csv and
dropped rather than aborting the run. Dependencies: moratoriums/refresh/textnorm.py (norm, jn).
"""
import glob, re
import pandas as pd, geopandas as gpd

import argparse, os, sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))  # scripts/, for moratoriums.refresh
from moratoriums.refresh.textnorm import norm, jn

_ap = argparse.ArgumentParser()
_ap.add_argument("--work", default=os.environ.get("DCM_WORK") or os.getcwd(), help="work dir (env DCM_WORK; default cwd)")
_ap.add_argument("--dataset", help="published outputs (default WORK/dataset)")
_ap.add_argument("--build", help="intermediates (default WORK/build)")
_args = _ap.parse_args()
WORK = os.path.abspath(_args.work)
DATASET = os.path.abspath(_args.dataset or f"{WORK}/dataset")
BUILD = os.path.abspath(_args.build or f"{WORK}/build")
IN = f"{WORK}/inputs"
CENSUS = f"{WORK}/census"
R = f"{IN}/research/2026-10-07"
os.makedirs(BUILD, exist_ok=True)
AS_OF = "2026-10-07"
COLS = ["id", "jurisdiction_name", "jurisdiction_level", "state", "county_fips", "place_geoid", "lat", "lon", "type", "scope",
        "status", "date_adopted", "date_expires", "duration_days", "extended", "summary", "source_urls", "upstream_id",
        "last_verified", "verify_flag", "status_inferred", "date_uncertainty", "expiry_source", "fips_method", "geo_qa",
        "eia_id"]

# ---- hand decisions (same as build_submission.py) ----
DROP = {
    "additions": {"add-ky-georgetown-2026": "city resolution supporting Scott County's moratorium, not its own instrument"},
    "research": {"add-ca-fresno-2026": "bans_other row; sweep files Fresno as a proposed 10-year moratorium",
                 "add-tx-ercot-2026": "already in state_actions.csv as nm-state-tx-abbott-2026-08-03-data-center-audit-directive"},
}
FIX = {  # reverify.csv changes_vs_ours, applied to additions.csv rows; source URLs are merged for every reverify row
    "add-co-mesa-2026": dict(date_adopted="2026-09-29", date_expires="2027-09-29", scope="data center; >=1 MW; unincorporated county; exemptions noted"),
    "add-pa-olyphant-2026": dict(date_adopted="2026-04-14", date_expires="2026-10-11", date_uncertainty="range", scope="data center; curative amendment period"),
    "add-in-zionsville-2026": dict(status="pending", date_expires="", duration_days="", expiry_source="", scope="data center+solar+wind+battery storage; all applications"),
    "add-co-thornton-2026": dict(date_uncertainty="exact", scope="data center; >50,000 sq ft; incl. expansions"),
    "add-ca-dixon-2026": dict(scope="data center+battery storage; >=5,000 sq ft or 2 MW; land-use applications"),
    "add-co-commerce-2026": dict(scope="data center; development plans and zoning applications"),
    "add-me-bangor-2026-ext": dict(date_expires="2027-03-27", scope="data center+crypto mining"),
}
TYPE = {"service pause": "interconnection pause", "load cap": "interconnection pause"}  # keep the popup's type vocabulary closed
KNOWN_TYPES = {"temporary moratorium", "permanent ban", "permit pause", "executive order", "interconnection pause"}
LEVEL = {"borough": "town", "state_agency": "state"}
MCD_TOWN = {"CT", "ME", "MA", "NH", "NY", "RI", "VT", "WI"}  # states where a "town" is a county subdivision
UTILITY_HQ = {  # research id without year -> HQ city (state comes from the row), county to disambiguate
    "add-wa-douglaspud": ("East Wenatchee", "Douglas"), "add-wa-chelanpud": ("Wenatchee", "Chelan"),
    "add-wa-grantpud": ("Ephrata", "Grant"), "add-wa-franklinpud": ("Pasco", "Franklin"),
    "add-wa-okanoganpud": ("Okanogan", "Okanogan"), "add-wa-masonpud3": ("Shelton", "Mason"),
    "add-ny-massenaelectric": ("Massena", "St. Lawrence"), "add-ny-plattsburgh": ("Plattsburgh", "Clinton"),
    "add-va-dominion": ("Richmond", ""), "add-oh-aepohio": ("Columbus", "Franklin"), "add-az-aps": ("Phoenix", "Maricopa"),
    "add-ga-marietta-blw": ("Marietta", "Cobb"), "add-mt-flatheadelectric": ("Kalispell", "Flathead"),
    "add-wa-lewispud": ("Chehalis", "Lewis"),
}
EIA_ID = {  # research id without year -> EIA-861 utility number, checked against HIFLD Retail Service Territories
    "add-az-aps": "803",                # ARIZONA PUBLIC SERVICE CO
    "add-de-psc-delmarva": "5027",      # DELMARVA POWER (DE)
    "add-ga-marietta-blw": "11646",     # CITY OF MARIETTA - (GA)
    "add-mt-flatheadelectric": "6395",  # FLATHEAD ELECTRIC COOP INC
    "add-ny-massenaelectric": "11811",  # TOWN OF MASSENA - (NY)
    "add-ny-plattsburgh": "15145",      # CITY OF PLATTSBURGH - (NY)
    "add-oh-aepohio": "14006",          # OHIO POWER CO (AEP)
    "add-va-dominion": "19876",         # VIRGINIA ELECTRIC & POWER CO
    "add-wa-chelanpud": "3413",         # PUD NO 1 OF CHELAN COUNTY
    "add-wa-douglaspud": "5326",        # PUD NO 1 OF DOUGLAS COUNTY
    "add-wa-franklinpud": "6716",       # PUD NO 1 OF FRANKLIN COUNTY
    "add-wa-grantpud": "14624",         # PUD NO 2 OF GRANT COUNTY
    "add-wa-lewispud": "10944",         # PUD NO 1 OF LEWIS COUNTY
    "add-wa-masonpud3": "15419",        # PUD NO 3 OF MASON COUNTY
    "add-wa-okanoganpud": "14055",      # PUD NO 1 OF OKANOGAN COUNTY
}
ALIAS = {"Peapack-Gladstone": "Peapack and Gladstone"}  # research name -> Census NAME
TRIBAL_PT = {"Cheyenne and Arapaho Tribes": (35.6153, -97.9919)}  # Concho OK seat; not a Census place
TRIBAL_SEAT = {  # tribal government seat; the row is placed at that Census place
    "Sault Ste. Marie Tribe of Chippewa Indians": ("Sault Ste. Marie", "Chippewa"),
    "Seminole Nation of Oklahoma": ("Wewoka", "Seminole"),
}


def clip(s, n=200):
    s = re.sub(r"\s+", " ", s).strip()
    return s if len(s) <= n else s[: n - 1].rsplit(" ", 1)[0] + "…"


def first_url(x):
    return x.split("|")[0].strip()


def urls(*xs):
    out = []
    for x in xs:
        for u in x.split("|"):
            u = u.strip()
            if u and u not in out:
                out.append(u)
    return "|".join(out[:8])


def days(d):
    m = re.fullmatch(r"(\d+) (day|month|year)s?", d.strip())
    if not m:
        return ""
    n, u = int(m.group(1)), m.group(2)
    return str(n if u == "day" else n * 365 if u == "year" else n // 12 * 365 if n % 12 == 0 else n * 30)


def rd(p):
    return pd.read_csv(p, dtype=str, keep_default_na=False)


qa = []
def flag(rid, issue, detail=""):
    qa.append(dict(id=rid, issue=issue, detail=detail))


# ---- load inputs ----
add = rd(f"{IN}/additions.csv")
up = rd(f"{BUILD}/moratoriums.csv").set_index("upstream_id", drop=False)
frames = []
WEEKLY = sorted(glob.glob(f"{IN}/research/weekly/[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]"))
PASSES = (R, f"{R}/pass2", f"{R}/pass3", *WEEKLY)
for d in PASSES:
    checked = os.path.basename(d) if d in WEEKLY else AS_OF
    for f in ("utilities.csv", "bans_nj.csv", "bans_other.csv", "bans.csv", "sweep.csv", "moratoriums.csv"):
        if os.path.exists(f"{d}/{f}"):
            frames.append(rd(f"{d}/{f}").rename(columns={"service_area_counties": "county"})
                          .assign(_file=os.path.relpath(f"{d}/{f}", R), checked_on=checked))
res = pd.concat(frames, ignore_index=True).fillna("")
for c in ("kind", "upstream_id", "eia_id"):
    if c not in res:
        res[c] = ""
res["kind"] = res.kind.replace("", "new")
res = res.drop_duplicates("id", keep="last")  # the later pass wins
p3 = f"{R}/pass3/eia_ids.csv"
EIA_P3 = dict(rd(p3)[["id", "eia_id"]].values) if os.path.exists(p3) else {}


def eia(rid, own=""):
    return (own or EIA_P3.get(rid) or EIA_ID.get(rid.rsplit("-", 1)[0], "")).strip()

# reverify fixes -> additions
rev = rd(f"{R}/reverify.csv").set_index("id")
add = add[~add.id.isin(DROP["additions"])].copy()
for i, r in add.iterrows():
    if r.id in rev.index:
        add.at[i, "source_urls"] = urls(rev.at[r.id, "source_urls"], r.source_urls)
        add.at[i, "last_verified"] = AS_OF
    for k, v in FIX.get(r.id, {}).items():
        add.at[i, k] = v
res = res[~res.id.isin(DROP["research"])]
for rid, why in {**DROP["additions"], **DROP["research"]}.items():
    flag(rid, "dropped", why)

# updates.csv patches (pass2 on): any additions or research row, by id
for d in PASSES:
    if not os.path.exists(f"{d}/updates.csv"):
        continue
    for u in rd(f"{d}/updates.csv").itertuples():
        hit = next(((n, df) for n, df in (("add", add), ("res", res)) if (df.id == u.id).any()), None)
        if hit is None:
            flag(u.id, "update_unmatched", f"{u.file} {u.field}"); continue
        n, df = hit
        if u.field == "DROP":
            df = df[df.id != u.id]
        elif u.field not in df:
            flag(u.id, "update_bad_field", u.field); continue
        else:
            m = df.id == u.id
            new = u.new
            if new.startswith("append "):  # "append <url>|<url>": add to the existing list
                new = urls(df.loc[m, u.field].iloc[0], new.removeprefix("append "))
            elif u.old and u.old != "(existing)" and df.loc[m, u.field].iloc[0] != u.old:
                flag(u.id, "update_old_mismatch", f"{u.field}: have {df.loc[m, u.field].iloc[0]!r}, update says {u.old!r}")
            df.loc[m, u.field] = new
        if n == "add":
            add = df
        else:
            res = df

# ---- census ----
cty = gpd.read_file(f"zip://{CENSUS}/cb_2023_us_county_500k.zip")[["GEOID", "NAME", "STUSPS", "geometry"]].to_crs(4326)
pl = gpd.read_file(f"zip://{CENSUS}/cb_2023_us_place_500k.zip")[["GEOID", "NAME", "NAMELSAD", "LSAD", "STUSPS", "geometry"]].to_crs(4326)
cs = gpd.read_file(f"zip://{CENSUS}/cb_2023_us_cousub_500k.zip")[["GEOID", "NAME", "NAMELSAD", "STUSPS", "geometry"]].to_crs(4326)
for g in (cty, pl, cs):
    g["key"] = g.NAME.map(jn)
pl["rank"] = (pl.LSAD == "57").astype(int)  # CDPs last
cs["rank"] = 0
cty_geom = cty.set_index("GEOID").geometry


def county_fips(st, names):
    return [g for n in names.split(";") if n.strip() for g in cty[(cty.STUSPS == st) & (cty.key == jn(n.strip()))].GEOID]


def find_place(name, st, lvl, county, word=""):
    """Census place/cousub named `name` in `st` -> (geoid, point) or (None, reason).
    `word` (township, borough, city...) breaks ties between same-named polygons, e.g. Andover township vs borough."""
    name = ALIAS.get(name, name)
    order = [cs, pl] if lvl == "township" or (lvl == "town" and st in MCD_TOWN) else [pl, cs]
    want = county_fips(st, county)
    for g in order:
        c = g[(g.STUSPS == st) & (g.key == jn(name))]
        if want and len(c) > 1:
            c = c[c.intersects(cty_geom[want].union_all().buffer(-0.001))]
        c = c[c["rank"] == c["rank"].min()] if len(c) else c
        if word and len(c) > 1:
            c = c[c.NAMELSAD.str.lower().str.endswith(" " + word)]
        if len(want) == 1 and len(c) > 1 and (c.GEOID.str[:5] == want[0]).all():  # a township split in pieces within one county: take the main piece
            c = c.loc[[c.to_crs(5070).area.idxmax()]]
        if len(c) == 1:
            return c.GEOID.iloc[0], c.geometry.iloc[0].representative_point()
        if len(c) > 1:
            return None, f"{len(c)} Census polygons named {name!r}; county hint {county!r} did not settle it"
    return None, f"no Census place or county subdivision named {name!r} in {st}"


def geocode(r, lvl):
    """-> dict(lat, lon, place_geoid, geo_qa) or None (flagged)."""
    if lvl == "state":
        return dict(lat="", lon="", place_geoid="", geo_qa="state")
    if lvl == "county":
        g = county_fips(r.state, r.jurisdiction_name)
        if len(g) != 1:
            flag(r.id, "not_geocoded", f"{len(g)} counties named {r.jurisdiction_name!r} in {r.state}"); return None
        p = cty_geom[g[0]].representative_point()
        return dict(lat=round(p.y, 6), lon=round(p.x, 6), place_geoid="", geo_qa="named_polygon")
    if lvl == "tribal" and r.jurisdiction_name in TRIBAL_PT:
        lat, lon = TRIBAL_PT[r.jurisdiction_name]
        return dict(lat=lat, lon=lon, place_geoid="", geo_qa="tribal_seat")
    if lvl == "tribal":
        if r.jurisdiction_name not in TRIBAL_SEAT:
            flag(r.id, "not_geocoded", "tribal row with no seat in TRIBAL_SEAT"); return None
        (name, county), kind, keep = TRIBAL_SEAT[r.jurisdiction_name], "tribal_seat", False
    elif lvl == "utility":
        key = r.id.rsplit("-", 1)[0]
        if key not in UTILITY_HQ and eia(r.id, r.eia_id):
            return dict(lat="", lon="", place_geoid="", geo_qa="utility_territory")
        if key not in UTILITY_HQ:
            flag(r.id, "not_geocoded", "utility with no HQ city in UTILITY_HQ"); return None
        (name, county), kind, keep = UTILITY_HQ[key], "utility_hq", False
    else:
        name, county, kind, keep = r.jurisdiction_name, r.county, "named_polygon", True
    geoid, p = find_place(name, r.state, "city" if not keep else lvl, county, r.jurisdiction_level if keep else "")
    if geoid is None:
        flag(r.id, "not_geocoded", p); return None
    return dict(lat=round(p.y, 6), lon=round(p.x, 6), place_geoid=geoid if keep else "", geo_qa=kind)


def unc(r):
    d = r.date_adopted
    u = {10: "exact", 7: "month_only", 4: "year_only"}.get(len(d), "")
    if d and re.search(r"~|approx|placeholder|inferred|unconfirmed|unclear|VERIFY", r.notes + " " + r.duration, re.I):
        u = "range"
    return u


def research_row(r, lvl):
    t = TYPE.get(r.type, r.type)
    if t not in KNOWN_TYPES:
        flag(r.id, "type_mapped", f"{r.type!r} -> temporary moratorium"); t = "temporary moratorium"
    st = r.status
    return dict(id=r.id, jurisdiction_name=r.jurisdiction_name, jurisdiction_level=lvl, state=r.state, county_fips="",
                type=t, scope=clip(r.sectors.replace("_", " "), 120), status=st, date_adopted=r.date_adopted,
                date_expires=r.date_expires, duration_days=days(r.duration), extended=st == "extended",
                summary=clip(r.summary), source_urls=urls(r.source_urls), upstream_id="", last_verified=r.checked_on,
                verify_flag=True, status_inferred=False, date_uncertainty=unc(r),
                expiry_source="source" if r.date_expires else "", fips_method="point_in_polygon", eia_id=eia(r.id, r.eia_id))


# ---- upstream rows changed by research ----
taken = set(add.upstream_id) - {""}  # upstream rows our additions already supersede
over = {}  # upstream_id -> changed upstream row


def upstream_row(uid, rid):
    if uid in taken:
        flag(rid, "upstream_conflict", f"{uid} is already superseded by an additions.csv row; research change not applied"); return None
    if uid not in up.index:
        flag(rid, "upstream_not_in_layer", f"{uid} is not a data-center row in moratoriums.csv; nothing to update"); return None
    if uid not in over:
        over[uid] = up.loc[uid].to_dict()
    return over[uid]


new_rows = []
for r in res.itertuples():
    if r.kind != "new":
        o = upstream_row(r.upstream_id, r.id)
        if o is None:
            continue
        before = (o["status"], o["date_adopted"], o["date_expires"])
        if r.kind == "replacement":  # the old row keeps its own summary and sources; the new row carries the new ones
            o.update(source_urls=urls(o["source_urls"], first_url(r.source_urls)), verify_flag=True, last_verified=r.checked_on)
        else:
            o.update(summary=clip(r.summary), source_urls=urls(r.source_urls, o["source_urls"]), verify_flag=True, last_verified=r.checked_on)
        if r.kind == "correction":
            o["status"], o["extended"] = r.status, r.status == "extended" or o["extended"] == "True"
            if r.date_adopted:
                o["date_adopted"], o["date_uncertainty"] = r.date_adopted, unc(r)
            if r.date_expires:
                o["date_expires"], o["expiry_source"] = r.date_expires, "source"
            if days(r.duration) and not o["duration_days"]:
                o["duration_days"] = days(r.duration)
        elif r.kind == "extension" and r.status == "extended":
            o["status"], o["extended"] = "extended", True
            if r.date_expires:
                o["date_expires"], o["expiry_source"] = r.date_expires, "source"
        elif r.kind == "replacement":
            if o["status"] in ("active", "extended", "pending"):
                o["status"] = "replaced"
            new = r._replace(status="active" if r.status == "replaced" else r.status)
            new_rows.append((new, "replacement"))
        flag(f"nm-{r.upstream_id}", f"upstream_{r.kind}", f"{before} -> {(o['status'], o['date_adopted'], o['date_expires'])} from {r.id}")
        continue
    new_rows.append((r, ""))

# a research ban that replaced an upstream moratorium marks that row replaced
REPL = re.compile(r"upstream_moratorium_id=(\S+?) \([^)]*replaced[^)]*\)|[Ss]upersedes [^(]*\(upstream (\S+?)\)")
for r in res.itertuples():
    m = REPL.search(r.notes)
    if m and r.type == "permanent ban" and r.status == "active":
        uid = m.group(1) or m.group(2)
        o = upstream_row(uid, r.id)
        if o is not None and o["status"] in ("active", "extended", "pending"):
            flag(f"nm-{uid}", "upstream_replaced_by_ban", f"{o['status']} -> replaced by {r.id}")
            o["status"] = "replaced"

# ---- new research rows: geocode, county by point-in-polygon, then dedupe ----
existing = pd.concat([up.reset_index(drop=True), add], ignore_index=True)
ids = set(existing.id) | set(DROP["additions"])  # a dropped id is not reused for a different instrument
rows, src = [], res.set_index("id")
for r, why in new_rows:
    lvl = LEVEL.get(r.jurisdiction_level, r.jurisdiction_level)
    g = geocode(r, lvl)
    if g is not None:
        row = {**research_row(r, lvl), **g}
        if row["id"] in ids:  # e.g. Georgetown KY: the dropped additions row and the bans_other row share an id
            row["id"] += "-ban" if row["type"] == "permanent ban" else "-b"
        ids.add(row["id"])
        rows.append((row, r, why))
new = pd.DataFrame([x[0] for x in rows])
pts = new[new.lat != ""]
j = gpd.sjoin(gpd.GeoDataFrame(pts, geometry=gpd.points_from_xy(pts.lon.astype(float), pts.lat.astype(float)), crs=4326),
              cty[["GEOID", "NAME", "STUSPS", "geometry"]], how="left", predicate="within")
j = j[~j.index.duplicated()]
new.loc[pts.index, "county_fips"] = j.GEOID.fillna("")
DROPPED = set(pts.index[(j.STUSPS != pts.state).to_numpy()])  # point fell outside the row's state
for i in sorted(DROPPED):
    flag(new.at[i, "id"], "state_mismatch_dropped", f"row state {new.at[i, 'state']}, point in {j.at[i, 'STUSPS']}")
for i in pts.index:
    if i in DROPPED:
        continue
    r = rows[i][1]
    want = county_fips(r.state, r.county)
    if new.at[i, "geo_qa"] == "named_polygon" and want and new.at[i, "county_fips"] not in want:
        flag(r.id, "county_hint_mismatch", f"county column {r.county!r}, point in {j.at[i, 'NAME']}")


def dkey(name, st, t, lvl, fips):  # same jurisdiction = same state, name, county, and county-vs-municipal-vs-utility level
    return (st, jn(name), t, fips, lvl == "county", lvl == "utility")


seen = {}
for e in existing.itertuples():
    seen.setdefault(dkey(e.jurisdiction_name, e.state, e.type, e.jurisdiction_level, e.county_fips), []).append((e.id, e.date_adopted))
keep = []
for i, (row, r, why) in enumerate(rows):
    if i in DROPPED:
        continue
    k = dkey(r.jurisdiction_name, r.state, row["type"], row["jurisdiction_level"], new.at[i, "county_fips"])
    dup = [x for x, d in seen.get(k, []) if not (d and r.date_adopted and d[:4] != r.date_adopted[:4])]
    if dup and why != "replacement":
        flag(r.id, "duplicate_dropped", f"same state+name+type+county as {', '.join(dup)}"); continue
    if dup:
        flag(r.id, "duplicate_kept", f"replacement of {', '.join(dup)}")
    seen.setdefault(k, []).append((row["id"], r.date_adopted))
    keep.append(i)
    if r.source_quality == "snippet_only":
        flag(row["id"], "weak_source", "snippet_only")
    if re.search(r"UNCERTAIN|VERIFY", r.notes):
        flag(row["id"], "uncertain", clip(r.notes, 160))
new = new.loc[keep]

for rid, e in EIA_P3.items():  # an upstream utility row named in eia_ids.csv
    if rid.startswith("nm-") and rid[3:] in up.index:
        o = upstream_row(rid[3:], rid)
        if o is not None:
            o["eia_id"] = e

ov = pd.DataFrame(list(over.values())).assign(id=lambda d: "nm-" + d.upstream_id) if over else pd.DataFrame(columns=COLS)
allr = pd.concat([add.astype(str), ov.astype(str), new.astype(str)], ignore_index=True).reindex(columns=COLS).fillna("")
for rid in sorted(set(allr[allr.id.duplicated()].id)):
    flag(rid, "duplicate_id_dropped", "same id from several sources; first kept")
allr = allr.drop_duplicates("id", keep="first")
m = (allr.eia_id == "") & (allr.jurisdiction_level == "utility")
allr.loc[m, "eia_id"] = allr.loc[m, "id"].map(eia)
m = (allr.eia_id != "") & (allr.jurisdiction_level == "state")
allr.loc[m, ["jurisdiction_level", "geo_qa"]] = ["utility", "utility_territory"]
for rid in allr[(allr.jurisdiction_level == "utility") & (allr.eia_id == "")].id:
    flag(rid, "no_eia_id", "utility row drawn as a point")
allr.sort_values("id").to_csv(f"{BUILD}/research_additions.csv", index=False)
pd.DataFrame(qa, columns=["id", "issue", "detail"]).sort_values(["issue", "id"]).to_csv(f"{BUILD}/qa_research.csv", index=False)

print("research rows:", len(res), "| new rows written:", len(new), new.type.value_counts().to_dict(), new.jurisdiction_level.value_counts().to_dict())
print("upstream rows changed:", len(over), "| additions rows:", len(add), "| total:", len(allr))
print("qa:", pd.Series([q["issue"] for q in qa]).value_counts().to_dict())
