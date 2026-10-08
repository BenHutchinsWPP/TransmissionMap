"""Build the upstream-schema moratoriums.csv from Moratorium Nation.

    python build.py [--work DIR] [--dataset DIR] [--build DIR]

Role: first step of rebuild.sh; the published moratoriums.csv comes later from sync.py.
Reads   WORK/upstream/ (Moratorium Nation clone), WORK/census/*.zip,
        WORK/inputs/upstream_as_of (YYYY-MM-DD, the pinned snapshot's date; falls back to UPSTREAM_AS_OF)
Writes  BUILD/moratoriums.csv
Dependencies: moratoriums/refresh/textnorm.py (norm, jn). TODAY is the pinned upstream
snapshot's date, read from inputs/upstream_as_of; bump it together with inputs/upstream.sha.
"""
import glob, json, re
from collections import defaultdict
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
U = f"{WORK}/upstream"
CENSUS = f"{WORK}/census"
UPSTREAM_AS_OF = "2026-10-03"  # the date of the first pin, used when inputs/upstream_as_of is absent
if os.path.exists(f"{IN}/upstream_as_of"):
    TODAY = pd.Timestamp(open(f"{IN}/upstream_as_of").read().strip())
else:
    TODAY = pd.Timestamp(UPSTREAM_AS_OF)
    print(f"inputs/upstream_as_of not found: using {UPSTREAM_AS_OF}")
os.makedirs(BUILD, exist_ok=True)

inv = pd.read_csv(f"{U}/data/moratorium_inventory.csv", dtype=str, keep_default_na=False)
dc = inv[inv.sectors.str.contains("data_center")].copy()
print("data-center rows:", len(dc), "of", len(inv))

# ---------- source URLs: (a) states/*.md, (b) work/answers evidence ----------
URL_RE = re.compile(r"https?://[^\s)>\]\"'`|]+")
md_urls = defaultdict(list)  # (state_name, norm jurisdiction) -> urls
for f in sorted(glob.glob(f"{U}/states/*.md")):
    txt = open(f).read()
    m = re.search(r"^# (.+?) local moratoria", txt, re.M)
    if not m:
        continue
    state = m.group(1)
    for block in re.split(r"^### ", txt, flags=re.M)[1:]:
        name = block.split("\n", 1)[0].strip()
        mid = re.search(r"\*\*Moratorium ID:\*\* `([^`]+)`", block)
        urls = [u.rstrip(".,;") for u in URL_RE.findall(block)]
        if urls:
            md_urls[(mid.group(1) if mid else None, state, norm(name))] += urls
md_by_id = {k[0]: v for k, v in md_urls.items() if k[0]}
md_by_name = {(k[1], k[2]): v for k, v in md_urls.items()}

PRI = {"primary": 0, "government": 0, "ordinance": 0, "minutes": 0, "agenda": 0, "official": 0, "news": 2, "tracker": 3}
def ev_urls(obj):
    out = []
    def walk(x):
        if isinstance(x, dict):
            if isinstance(x.get("url"), str) and x["url"].startswith("http"):
                st = str(x.get("source_type", ""))
                out.append((PRI.get(st.split("_")[0], 1), x["url"]))
            for v in x.values():
                walk(v)
        elif isinstance(x, list):
            for v in x:
                walk(v)
    walk(obj)
    return out

ans_by_id = defaultdict(list); ans_by_name = defaultdict(list); verified_on = defaultdict(str)
for f in sorted(glob.glob(f"{U}/work/answers/*/*.json")):
    try:
        d = json.load(open(f))
    except Exception:
        continue
    if not isinstance(d, dict):
        continue
    asof = str(d.get("researched_as_of", ""))[:10]
    for dec in d.get("decisions", []) or []:
        mid = dec.get("moratorium_id")
        if mid:
            ans_by_id[mid] += ev_urls(dec)
            if asof > verified_on[mid]:
                verified_on[mid] = asof
    for c in d.get("new_candidates", []) or []:
        k = (c.get("state", ""), norm(c.get("jurisdiction", "")))
        ans_by_name[k] += ev_urls(c)
        if asof > verified_on[k]:
            verified_on[k] = asof

def dedupe_urls(pairs, cap=8):
    seen, out = set(), []
    for _, u in sorted(pairs, key=lambda p: p[0]):
        u = u.rstrip(".,;")
        if u not in seen:
            seen.add(u); out.append(u)
    return out[:cap]

# ---------- normalisation ----------
LEVEL = {"County": "county", "Parish": "county", "City": "city", "Town": "town", "Township": "township",
         "Village": "village", "Tribal": "tribal", "Utility-authority": "utility"}
def level(r):
    if r.jurisdiction_type == "Other":
        if "Borough" in r.jurisdiction: return "town"
        return "county"  # Lexington-Fayette / Louisville Metro: consolidated city-county governments
    return LEVEL.get(r.jurisdiction_type, r.jurisdiction_type.lower())

STATUS = {"active": "active", "extended": "extended", "pending": "pending", "expired": "expired",
          "rescinded": "lifted", "replaced": "replaced"}

def mtype(r):
    lb = r.legal_basis.lower(); allt = " ".join([r.legal_basis, r.duration, r.outcome]).lower()
    if "executive order" in lb: return "executive order"
    if r.jurisdiction_type == "Utility-authority": return "interconnection pause"
    if r.duration_kind == "indefinite" and re.search(r"\bban\b|prohibit", allt):
        return "permanent ban"
    if "moratori" not in allt and re.search(r"pause|suspen", allt) and re.search(r"permit|licen", allt):
        return "permit pause"
    return "temporary moratorium"

def scope(r):
    secs = json.loads(r.sectors) if r.sectors.startswith("[") else [r.sectors]
    parts = ["+".join(s.replace("_", " ") for s in secs)]
    txt = " ".join([r.duration, r.legal_basis, r.affected_projects, r.outcome])
    mw = re.findall(r"(?:>|over|above|exceeding|at least|greater than)?\s*\d[\d,.]*\s?(?:MW|megawatts?)", txt, re.I)
    if mw: parts.append(mw[0].strip())
    sq = re.search(r"\d[\d,]*\s*(?:square feet|sq\.? ?ft)", txt, re.I)
    if sq: parts.append(">" + sq.group(0))
    if re.search(r"exempt|grandfather", txt, re.I): parts.append("exemptions noted")
    return "; ".join(parts)[:120]

def parse_date(s):
    try: return pd.Timestamp(s) if re.match(r"^\d{4}-\d{2}-\d{2}$", s) else None
    except Exception: return None

def clip(s, n=200):
    s = re.sub(r"\s+", " ", re.sub(r"\[VERIFY[^\]]*\]", "", s)).strip()
    return s if len(s) <= n else s[: n - 1].rsplit(" ", 1)[0] + "…"

rows = []
for r in dc.itertuples():
    adopted = parse_date(r.date_enacted_iso)
    end = parse_date(r.current_end_date_iso)
    exp_src = "upstream_end_date" if end is not None else ""
    if end is None and adopted is not None and r.duration_kind == "fixed_days" and r.duration_days:
        dd = float(r.duration_days)
        a = adopted if r.date_enacted_uncertainty == "exact" else (adopted + pd.offsets.MonthEnd(0) if r.date_enacted_uncertainty == "month_only" else None)
        if a is not None:
            end = a + pd.Timedelta(days=dd); exp_src = "computed_adopted_plus_duration"
    status = STATUS[r.enacted_status]
    extended = r.enacted_status == "extended" or bool(re.search(r"\bextended\b", r.current_status, re.I) and "not extended" not in r.current_status.lower())
    inferred = False
    if status in ("active", "extended") and end is not None and end < TODAY:
        # an extended row's computed date reflects only the original term; trust only the upstream end date there
        if not extended or exp_src == "upstream_end_date":
            status, inferred = "expired", True
    urls_md = md_by_id.get(r.moratorium_id) or md_by_name.get((r.state, norm(r.jurisdiction))) or []
    urls_ans = ans_by_id.get(r.moratorium_id, []) + ans_by_name.get((r.state, norm(r.jurisdiction)), [])
    urls = dedupe_urls([(0, u) for u in urls_md] + urls_ans)
    m = re.search(r"as of (\d{4}-\d{2}-\d{2})", r.current_status)
    lv = max(filter(None, [verified_on.get(r.moratorium_id, ""), verified_on.get((r.state, norm(r.jurisdiction)), ""), m.group(1) if m else ""]), default="")
    summ = r.outcome or r.current_status or r.duration
    rows.append(dict(
        id=f"nm-{r.moratorium_id}", jurisdiction_name=r.jurisdiction, jurisdiction_level=level(r),
        state=r.state_abbrev, county_fips="", place_geoid="", lat=round(float(r.latitude), 6), lon=round(float(r.longitude), 6),
        type=mtype(r), scope=scope(r), status=status,
        date_adopted=r.date_enacted_iso, date_expires=end.date().isoformat() if end is not None else "",
        duration_days=int(float(r.duration_days)) if r.duration_days else "", extended=extended,
        summary=clip(summ), source_urls="|".join(urls), upstream_id=r.moratorium_id, last_verified=lv,
        verify_flag=r.has_verify_tags == "True", status_inferred=inferred, expiry_source=exp_src,
        date_uncertainty=r.date_enacted_uncertainty,
    ))
df = pd.DataFrame(rows)

# ---------- spatial joins ----------
PIN_GEOID = {  # county subdivision GEOIDs for rows whose name matches several Census polygons
    "nm-ny-town-of-highland-2026": "3610534473",  # Town of Highland, Sullivan County (not the Highland CDP in Ulster)
    "nm-mi-big-rapids-charter-township-2026": "2610708320",  # Big Rapids charter township, Mecosta County
}

def spatial(df):
    df = df.copy()
    cty = gpd.read_file(f"zip://{CENSUS}/cb_2023_us_county_500k.zip")[["GEOID", "NAME", "NAMELSAD", "STUSPS", "geometry"]].to_crs(4326)
    pl = gpd.read_file(f"zip://{CENSUS}/cb_2023_us_place_500k.zip")[["GEOID", "NAME", "LSAD", "STUSPS", "geometry"]].to_crs(4326)
    cs = gpd.read_file(f"zip://{CENSUS}/cb_2023_us_cousub_500k.zip")[["GEOID", "NAME", "STUSPS", "geometry"]].to_crs(4326)
    for g in (pl, cs):
        g["key"] = g.NAME.map(jn); g["cfips"] = g.GEOID.str[:5]
    pl["rank"] = (pl.LSAD == "57").astype(int)  # CDPs last
    def pts():
        return gpd.GeoDataFrame(df[["lat", "lon"]], geometry=gpd.points_from_xy(df.lon, df.lat), crs="EPSG:4326")
    def join(g, cols):
        j = gpd.sjoin(pts(), g[cols + ["geometry"]], how="left", predicate="within")
        return j[~j.index.duplicated()]
    jp = join(pl, ["GEOID", "key"]); jc = join(cs, ["GEOID", "key", "cfips"]); jk = join(cty, ["GEOID"])
    df["geo_qa"] = ""
    cty_key = {(r.STUSPS, norm(r.NAME)): r.GEOID for r in cty.itertuples()}
    for i, r in df.iterrows():
        k = jn(r.jurisdiction_name); lvl = r.jurisdiction_level
        if r.id in PIN_GEOID:  # name alone is ambiguous; the county comes from the row's own text
            g = PIN_GEOID[r.id]; c = cs[cs.GEOID == g]
            inside = jc.at[i, "GEOID"] == g
            if not inside:
                p = c.geometry.iloc[0].representative_point()
                df.at[i, "lat"], df.at[i, "lon"] = round(p.y, 6), round(p.x, 6)
            df.at[i, "place_geoid"] = g; df.at[i, "geo_qa"] = "ok" if inside else "relocated_to_named_place"; continue
        m = re.search(r"\(([^)]*?) County\)", r.jurisdiction_name)
        want = cty_key.get((r.state, norm(m.group(1)))) if m else None  # "(X County)" in the name pins the county
        if lvl in ("city", "town", "village"):
            if jp.at[i, "key"] == k:
                df.at[i, "place_geoid"] = jp.at[i, "GEOID"]; df.at[i, "geo_qa"] = "ok"; continue
            c = pl[(pl.STUSPS == r.state) & (pl.key == k)].sort_values("rank")
            if want: c = c[c.intersects(cty.set_index("GEOID").geometry[want].buffer(-0.001))]
            c = c[c["rank"] == c["rank"].min()] if len(c) else c
            if len(c) == 1:
                p = c.geometry.iloc[0].representative_point()
                df.at[i, "lat"], df.at[i, "lon"] = round(p.y, 6), round(p.x, 6)
                df.at[i, "place_geoid"] = c.GEOID.iloc[0]; df.at[i, "geo_qa"] = "relocated_to_named_place"; continue
        if lvl in ("township", "town"):
            if jc.at[i, "key"] == k:
                df.at[i, "place_geoid"] = jc.at[i, "GEOID"]; df.at[i, "geo_qa"] = "ok"; continue
            c = cs[(cs.STUSPS == r.state) & (cs.key == k)]
            if want: c = c[c.cfips == want]
            same = c[c.cfips == jk.at[i, "GEOID"]]
            if len(same) == 1:  # point sits in the right county but outside the township polygon
                df.at[i, "place_geoid"] = same.GEOID.iloc[0]; df.at[i, "geo_qa"] = "ok_county"; continue
            if len(c) == 1:
                p = c.geometry.iloc[0].representative_point()
                df.at[i, "lat"], df.at[i, "lon"] = round(p.y, 6), round(p.x, 6)
                df.at[i, "place_geoid"] = c.GEOID.iloc[0]; df.at[i, "geo_qa"] = "relocated_to_named_place"; continue
        if lvl in ("city", "town", "village", "township"):
            df.at[i, "geo_qa"] = "place_unmatched"
    j = join(cty.rename(columns={"GEOID": "j_fips", "NAME": "j_cname", "STUSPS": "j_st"}), ["j_fips", "j_cname", "j_st"])
    df["county_fips"] = j.j_fips.fillna(""); df["joined_county"] = j.j_cname.fillna(""); df["joined_state"] = j.j_st.fillna("")
    return df, cty

df, cty = spatial(df)
df["fips_method"] = df.county_fips.map(lambda x: "point_in_polygon" if x else "")
name_lookup = {(r.STUSPS, norm(r.NAME)): (r.GEOID, r.NAME) for r in cty.itertuples()}
mism = 0
for i, r in df[df.jurisdiction_level == "county"].iterrows():
    base = re.sub(r"\(.*?\)|Fiscal Court|Unincorporated", "", r.jurisdiction_name).strip()
    cands = {norm(base)} | {norm(p) for p in base.split("-")}
    if r.jurisdiction_name == "Louisville Metro": cands = {norm("Jefferson")}
    n = next((c for c in cands if (r.state, c) in name_lookup), norm(base))
    if norm(r.joined_county) not in cands or r.joined_state != r.state:
        hit = name_lookup.get((r.state, n))
        mism += 1
        if hit:
            df.at[i, "county_fips"] = hit[0]; df.at[i, "fips_method"] = "name_match_override"

# ---------- outputs ----------
COLS = ["id", "jurisdiction_name", "jurisdiction_level", "state", "county_fips", "place_geoid", "lat", "lon", "type", "scope",
        "status", "date_adopted", "date_expires", "duration_days", "extended", "summary", "source_urls", "upstream_id",
        "last_verified", "verify_flag", "status_inferred", "date_uncertainty", "expiry_source", "fips_method", "geo_qa"]
df[COLS].sort_values(["state", "jurisdiction_name", "date_adopted"]).to_csv(f"{BUILD}/moratoriums.csv", index=False)

print(len(df), "rows;", "status:", df.status.value_counts().to_dict())
print("county fips joined:", (df.fips_method != "").sum(), "| name-match overrides:", (df.fips_method == "name_match_override").sum(),
      "| county name mismatches:", mism)
