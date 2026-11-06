#!/usr/bin/env python3
"""Route-optimizer input fetch.

Role: downloads the route-optimizer's raw inputs into one new dir per source
under data/raw/route/ (NLCD 2025, FAA airports + runways, Section 368
corridors, PoPWest Wind exclusion rasters -> GTiff) and re-extracts PAD-US
subsets from the on-disk gdb into data/build/route/inputs/. Idempotent: a file
already present with the expected size is skipped. Every output is built under a `.part`
name and renamed only when complete (download size = Content-Length, unzip dir, gpkg, tif, chunked file = every chunk). Logs url, size, sha256 and
vintage for each download.
Deps: venv python with rasterio; system gdal_translate / ogr2ogr / ogrinfo.
Run: TMPDIR=tmp/build-tmp venv/bin/python scripts/fetch_route_inputs.py
Steps named explicitly, not in the default run: grsg wsr trails npl nass (also logs
the B&V ROW-width table, step bvrow) easement (logs PAD-US/NCED terms; appends the Easement
layer to padus_gap_agency.gpkg only if they allow it).
More steps: flood nrhp mirta cbrs crithab_line mirror
(mirror = read-only report on the HIFLD mirror's facility, dam, FUDS and tower tables) mirta_measure
(MIRTA cells not already in the PAD-US DoD bit; heavy).
structures — FEMA/ORNL USA Structures state zips (CC BY 4.0, ~25 GB)
for the 48 CONUS states + DC into $STRUCTURES_DIR (default data/raw/route/usa_structures/), with
each zip's Last-Modified date in structures_zips.json (build_route_structures.py reads it).
nwi — USFWS National Wetlands Inventory state GeoPackage zips (public domain,
CONUS 48 + DC, ~60 GB) into $NWI_DIR (default an external disk, symlinked from data/raw/route/nwi), 2 downloads in parallel, resumable; prints one small state's layers, fields and WETLAND_TYPE counts.
rps — USFS Wildfire Risk to Communities "Risk to Potential Structures" (RDS-2020-0016-2) exported from the
IIPP ImageServer onto the routing grid (250 m, EPSG:5070) as data/raw/route/wrc/rps_250m.tif.
ntad — NTAD Aviation Facilities, Runways, Runway Ends (one EFF_DATE cycle) + ADDS IAPEXISTS into $NTAD_DIR
(default an external disk), manifest ntad_manifest.json.
nfhl — FEMA NFHL Key Layers GDB (one dated edition, pinned: the redirect target must be
$NFHL_EDITION, default NFHL_Key_Layers_202610.gdb.zip; ~19 GB) into $NFHL_DIR (default
an external disk), manifest nfhl_manifest.json (url, Last-Modified, size, sha256).
Heavy PAD-US steps: wrap in systemd-run --user --scope -p MemoryMax=16G.
"""
import csv, gzip, os, shutil, hashlib, json, re, subprocess, sys, tempfile, time, urllib.parse, urllib.request, zipfile
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data/raw/route"
ROUTE_CACHE = Path(os.environ.get("ROUTE_CACHE") or ROOT / "data/raw/route-cache")
INP = ROOT / "data/build/route/inputs"
PADUS = ROOT / "data/raw/padus/PADUS4_1Geodatabase.gdb"
WORLDPOP = ROOT / "data/raw/population/ppp_2020_1km_Aggregated.tif"
UA = {"User-Agent": "curl/8.5.0"}

NLCD_URL = "https://www.mrlc.gov/downloads/sciweb1/shared/mrlc/data-bundles/Annual_NLCD_LndCov_2025_CU_C1V2.zip"
S368_URL = "https://corridoreis.anl.gov/maps/data/Section368Corridors.zip"
ZEN = "https://zenodo.org/api/records/7460026"
POPWEST = "PoPWest_EnvExclusions_Rasters.gdb.zip"
FAA = "https://services6.arcgis.com/ssFJjBXIUyZDrSYZ/arcgis/rest/services"


def log(*a):
    print(*a, flush=True)


def sha256(p):
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for b in iter(lambda: f.read(1 << 20), b""):
            h.update(b)
    return h.hexdigest()


def download(url, dest, vintage):
    dest.parent.mkdir(parents=True, exist_ok=True)
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=120) as r:
        want = int(r.headers.get("Content-Length") or -1)
        if dest.exists() and dest.stat().st_size == want:
            log(f"skip {dest} ({want} bytes present)")
        else:
            tmp = dest.with_suffix(dest.suffix + ".part")
            with open(tmp, "wb") as f:
                while b := r.read(1 << 20):
                    f.write(b)
            if want >= 0 and tmp.stat().st_size != want:
                got = tmp.stat().st_size
                tmp.unlink()
                sys.exit(f"{dest.name}: received {got} bytes of Content-Length {want}")
            tmp.rename(dest)
    log(f"url={url} file={dest} size={dest.stat().st_size} sha256={sha256(dest)} vintage={vintage}")


def unzip(z, outdir):
    if outdir.exists() and any(outdir.iterdir()):
        log(f"skip unzip {outdir}")
        return
    stage = outdir.with_name(outdir.name + ".part")
    shutil.rmtree(stage, ignore_errors=True)
    stage.mkdir(parents=True)
    with zipfile.ZipFile(z) as zf:
        zf.extractall(stage)
    if outdir.exists():
        outdir.rmdir()
    stage.rename(outdir)


def run(cmd, **kw):
    log("$", " ".join(map(str, cmd)))
    return subprocess.run(cmd, check=True, text=True, **kw)


def describe_raster(p, hist=False):
    import rasterio
    with rasterio.open(p) as ds:
        log(f"{p}: crs={ds.crs.to_proj4() if ds.crs else None} size={ds.width}x{ds.height} "
            f"origin=({ds.transform.c},{ds.transform.f}) res=({ds.transform.a},{ds.transform.e}) "
            f"nodata={ds.nodata} dtype={ds.dtypes[0]}")
        if hist:
            import numpy as np
            vals, cnt = np.zeros(0), np.zeros(0)
            u = {}
            for _, w in ds.block_windows(1):
                v, c = np.unique(ds.read(1, window=w), return_counts=True)
                for a, b in zip(v.tolist(), c.tolist()):
                    u[a] = u.get(a, 0) + b
            log(f"  histogram: {dict(sorted(u.items()))}")


def nlcd():
    d = RAW / "nlcd"
    z = d / "Annual_NLCD_LndCov_2025_CU_C1V2.zip"
    download(NLCD_URL, z, "Annual NLCD Collection 1.2, 2025")
    unzip(z, d / "unzipped")
    for t in sorted((d / "unzipped").rglob("*.tif")):
        describe_raster(t)


def arcgis_pages(layer_url, where, out, page, oid="OBJECTID", vintage="live service, fetched"):
    if out.exists() and out.stat().st_size > 0:
        log(f"skip {out}")
        return json.loads(out.read_text())
    feats, off = [], 0
    while True:
        q = urllib.parse.urlencode({"where": where, "outFields": "*", "outSR": 4326, "f": "geojson",
                                    "orderByFields": oid, "resultOffset": off, "resultRecordCount": page})
        for _ in range(6):
            with urllib.request.urlopen(urllib.request.Request(f"{layer_url}/query?{q}", headers=UA), timeout=300) as r:
                g = json.load(r)
            if "error" not in g:
                break
            log(f"  server error {g['error'].get('code')} at offset {off}; retry in 65 s")
            time.sleep(65)
        else:
            raise RuntimeError(f"{layer_url}: {g['error']}")
        feats += g["features"]
        if not g["features"] or not (g.get("exceededTransferLimit") or g.get("properties", {}).get("exceededTransferLimit")):
            break
        off += page
    fc = {"type": "FeatureCollection", "features": feats}
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(fc))
    log(f"url={layer_url} file={out} features={len(feats)} size={out.stat().st_size} sha256={sha256(out)} vintage={vintage}")
    return fc


def faa():
    d = RAW / "faa"
    a = arcgis_pages(f"{FAA}/US_Airport/FeatureServer/0", "TYPE_CODE='AD' AND PRIVATEUSE=0",
                     d / "airports_public.geojson", 1000)
    log(f"public airports: {len(a['features'])} (expect ~4998)")
    r = arcgis_pages(f"{FAA}/Runways/FeatureServer/0", "1=1", d / "runways.geojson", 1000)
    log(f"runways: {len(r['features'])}; join key: Runways.AIRPORT_ID <-> Airports.GLOBAL_ID (verify) / IDENT")
    ids = {f["properties"]["GLOBAL_ID"] for f in a["features"]}
    idents = {f["properties"]["IDENT"] for f in a["features"]}
    rid = [f["properties"]["AIRPORT_ID"] for f in r["features"]]
    log(f"  runways whose AIRPORT_ID in airports GLOBAL_ID: {sum(x in ids for x in rid)}; in IDENT: {sum(x in idents for x in rid)}")


def sec368():
    d = RAW / "sec368"
    z = d / "Section368Corridors.zip"
    download(S368_URL, z, "ANL Section 368 corridors (as served)")
    unzip(z, d / "unzipped")
    for p in sorted((d / "unzipped").rglob("*")):
        if p.suffix.lower() in (".shp", ".gdb", ".gpkg", ".geojson", ".kml"):
            run(["ogrinfo", "-so", "-al", str(p)], stdout=sys.stdout)


def popwest():
    d = RAW / "popwest"
    with urllib.request.urlopen(urllib.request.Request(ZEN, headers=UA), timeout=60) as r:
        rec = json.load(r)
    f = next(x for x in rec["files"] if x["key"] == POPWEST)
    z = d / POPWEST
    download(f["links"]["self"], z, f"Zenodo 7460026, {rec['metadata']['publication_date']}, CC BY 4.0")
    unzip(z, d / "unzipped")
    gdb = next((d / "unzipped").rglob("*.gdb"))
    for n in ("Category1_Wind_EE", "Category2_Wind_EE", "Category3_Wind_EE"):
        out = d / f"{n}.tif"
        if not out.exists():
            tmp = d / f"{n}.part.tif"
            tmp.unlink(missing_ok=True)
            run(["gdal_translate", "-of", "GTiff", "-co", "COMPRESS=DEFLATE", "-co", "TILED=YES",
                 f'OpenFileGDB:"{gdb}":{n}', str(tmp)])
            tmp.rename(out)
        describe_raster(out, hist=True)


def unlink_gpkg(p):
    """Removes a temp gpkg with its SQLite sidecars; a stale journal would be replayed onto a fresh copy."""
    for suffix in ("", "-journal", "-wal", "-shm"):
        Path(str(p) + suffix).unlink(missing_ok=True)


def padus(easement=False):
    INP.mkdir(parents=True, exist_ok=True)
    fields = "GAP_Sts,Mang_Name,Mang_Type,Des_Tp,Unit_Nm"
    a = INP / "padus_gap_agency.gpkg"
    if not a.exists():
        tmp = a.with_suffix(".part.gpkg")
        tmp.unlink(missing_ok=True)
        for i, lyr in enumerate(("PADUS4_1Fee", "PADUS4_1Designation")):
            cmd = ["ogr2ogr", "-f", "GPKG", "-t_srs", "EPSG:5070", "-select", fields,
                   "-nlt", "MULTIPOLYGON", "-nln", lyr, "-makevalid"]
            if i:
                cmd.append("-update")
            run(cmd + [str(tmp), str(PADUS), lyr])
        tmp.rename(a)
    if easement:
        lyr = "PADUS4_1Easement"
        have = subprocess.run(["ogrinfo", "-so", str(a), lyr], capture_output=True, text=True).returncode == 0 if a.exists() else False
        if have:
            log(f"skip {lyr}: already in {a}")
        else:
            tmp = a.with_suffix(".part.gpkg")  # a copy takes the append, so a killed run leaves `a` untouched
            sys.path.insert(0, str(Path(__file__).resolve().parent))
            import disk_guard
            disk_guard.require_free(INP, a.stat().st_size)
            unlink_gpkg(tmp)
            try:
                shutil.copyfile(a, tmp)
                run(["ogr2ogr", "-f", "GPKG", "-update", "-t_srs", "EPSG:5070", "-select", fields, "-nlt", "MULTIPOLYGON",
                     "-nln", lyr, "-makevalid", str(tmp), str(PADUS), lyr])
                tmp.replace(a)
            except BaseException:
                unlink_gpkg(tmp)
                raise
        n = subprocess.run(["ogrinfo", "-so", str(a), lyr], capture_output=True, text=True).stdout
        log(f"Easement feature count: {next((l for l in n.splitlines() if 'Feature Count' in l), n)}")
    b = INP / "padus_dod.gpkg"
    if not b.exists():
        tmp = b.with_suffix(".part.gpkg")
        tmp.unlink(missing_ok=True)
        run(["ogr2ogr", "-f", "GPKG", "-t_srs", "EPSG:5070", "-select", fields, "-nlt", "MULTIPOLYGON",
             "-nln", "padus_dod", "-makevalid", "-where", "Mang_Name='DOD'",
             str(tmp), str(PADUS), "PADUS4_1Proclamation"])
        tmp.rename(b)
    for p in (a, b):
        run(["ogrinfo", "-so", "-al", str(p)], stdout=sys.stdout)
        log(f"{p} size={p.stat().st_size} sha256={sha256(p)} vintage=PAD-US 4.1")


GRSG = "https://services1.arcgis.com/KbxwQRRfWyEYLgp4/arcgis/rest/services/BLM_Natl_WesternUS_GRSG_ROD_HabitatMgmtAreas_Feb_2026/FeatureServer"
WSR = "https://apps.fs.usda.gov/arcx/rest/services/EDW/EDW_WildScenicRiverSegments_01/MapServer/0"
NPL = "https://services.arcgis.com/cJ9YHowT8TU7DUyn/arcgis/rest/services/FAC_Superfund_Site_Boundaries_EPA_Public/FeatureServer/0"
NTS_WEBMAP = "https://www.arcgis.com/sharing/rest/content/items/c1704515e566472798e451a3e7cadde2/data?f=json"
NASS_URL = "https://www.nass.usda.gov/datasets/qs.census2022.txt.gz"
SB_PADUS = "https://www.sciencebase.gov/catalog/item/652d4fc5d34e44db0e2ee45e?format=json"
NCED_URLS = ("https://conservationeasement.us/faq/", "https://www.conservationeasement.us/",
             "https://www.conservationeasement.us/terms-of-use/")
NCED_TERMS_BASIS = (
    "conservationeasement.us FAQ/Downloads/About (fetched 2026-10-16): \"Due to lack of funding, as of January 2025, the "
    "National Conservation Easement Database is no longer being actively updated and supported. For the latest conservation "
    "easement spatial data ... please visit the USGS Protected Areas Database website\"; sensitive easements \"will not be "
    "shared with or displayed on PAD-US\". PAD-US (USGS) is the distributor of record, so its rights statement governs.")


def getjson(url):
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=120) as r:
        return json.load(r)


def fc_count(fc, label):
    log(f"{label}: {len(fc['features'])} features")


def grsg():
    d = RAW / "grsg"
    meta = getjson(f"{GRSG}/0?f=json")
    log(f"GRSG layer index 0 of {[(l['id'], l['name']) for l in getjson(GRSG + '?f=json')['layers']]}; hub item e017fcce947f4451ae049aa07383932d; "
        f"fields={[f['name'] for f in meta['fields']]}")
    fc = arcgis_pages(f"{GRSG}/0", "1=1", d / "grsg_hma.geojson", 1,
                      vintage="BLM GRSG ROD HabitatMgmtAreas Feb 2026 (layer edit date "
                              f"{meta.get('editingInfo', {}).get('lastEditDate')})")
    fc_count(fc, "GRSG polygons")
    ac, n = defaultdict(float), Counter()
    for f in fc["features"]:
        p = f["properties"]
        k = (p.get("Habitat_Type"), p.get("EIS_HAB"), p.get("Source"))
        ac[k] += p.get("SUM_ACRES") or 0
        n[k] += 1
    log(f"GRSG distinct (Habitat_Type, EIS_HAB, Source) classes: {len(ac)}")
    for k in sorted(ac, key=lambda k: tuple(map(str, k))):
        log(f"  {k}: n={n[k]} acres={ac[k]:,.0f}")
    log(f"GRSG distinct Habitat_Type: {sorted({k[0] for k in ac}, key=str)}")


def wsr():
    d = RAW / "wsr"
    fc = arcgis_pages(WSR, "1=1", d / "wsr_lines.geojson", 100, oid="objectid",
                      vintage="NWSRS multi-agency (USFS EDW host of rivers.gov National Wild and Scenic River Line)")
    fc_count(fc, "WSR river lines")
    log(f"  distinct rivers: {len({f['properties'].get('river_id') for f in fc['features']})}; "
        f"agencies: {dict(Counter(f['properties'].get('agency') for f in fc['features']))}")


def trails():
    d = RAW / "trails"
    out = d / "nts_lines.geojson"
    if out.exists() and out.stat().st_size > 0:
        log(f"skip {out}")
        fc = json.loads(out.read_text())
    else:
        feats, fails, seen = [], [], set()
        for l in getjson(NTS_WEBMAP).get("operationalLayers", []):
            t, u = l.get("title") or "", l.get("url") or ""
            if not re.search(r"\b(NHT|NST)\b", t) or "NPS_Public_Trails" in u or u in seen:
                if t:
                    log(f"  not a trail line source, skipped: {t} ({u})")
                continue
            seen.add(u)
            try:
                g = arcgis_pages(u, "1=1", d / "parts" / (re.sub(r"\W+", "_", t) + ".geojson"), 500, oid=oid_field(u),
                                 vintage="NPS National Trails System web map c1704515e566472798e451a3e7cadde2")
            except Exception as e:
                fails.append(t)
                log(f"  FAILED {t} {u}: {e!r}")
                continue
            for f in g["features"]:
                if f.get("geometry"):
                    f["properties"] = {"trail": t, "src": u}
                    feats.append(f)
            log(f"  {t}: {len(g['features'])} features")
        if fails:
            raise RuntimeError(f"trails: {len(fails)} layer(s) failed, {out.name} not written: {fails}")
        fc = {"type": "FeatureCollection", "features": feats}
        out.write_text(json.dumps(fc))
    fc_count(fc, "NHT/NST lines")
    log(f"  file={out} size={out.stat().st_size} sha256={sha256(out)} vintage=NPS National Trails System web map as served; "
        f"trails={len({f['properties']['trail'] for f in fc['features']})}")


def oid_field(u):
    return next((f["name"] for f in getjson(f"{u}?f=json")["fields"] if f.get("type") == "esriFieldTypeOID"), "OBJECTID")


def npl():
    d = RAW / "npl"
    meta = getjson(f"{NPL}?f=json")
    fc = arcgis_pages(NPL, "1=1", d / "npl_boundaries.geojson", 500,
                      vintage=f"EPA NPL Superfund Site Boundaries (layer edit date {meta.get('editingInfo', {}).get('lastEditDate')})")
    fc_count(fc, "NPL site boundary polygons")
    log(f"  distinct EPA_ID: {len({f['properties'].get('EPA_ID') for f in fc['features']})}; "
        f"NPL_STATUS_CODE: {dict(Counter(f['properties'].get('NPL_STATUS_CODE') for f in fc['features']))}; "
        f"SITE_FEATURE_CLASS: {dict(Counter(f['properties'].get('SITE_FEATURE_CLASS') for f in fc['features']))}")


def nass():
    d = RAW / "nass"
    z = d / "qs.census2022.txt.gz"
    download(NASS_URL, z, "NASS Census of Agriculture 2022 (Quick Stats bulk, as served; no API key)")
    out = d / "county_land_value_2022.csv"
    want = "AG LAND, INCL BUILDINGS - ASSET VALUE, MEASURED IN $ / ACRE"
    rows = []
    with gzip.open(z, "rt", encoding="utf-8", errors="replace", newline="") as f:
        for r in csv.DictReader(f, delimiter="\t"):
            if r["AGG_LEVEL_DESC"] == "COUNTY" and r["SHORT_DESC"] == want and r["YEAR"] == "2022":
                rows.append((r["STATE_FIPS_CODE"] + r["COUNTY_CODE"], r["STATE_ALPHA"], r["COUNTY_NAME"], r["VALUE"].strip()))
    with open(out, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["geoid", "state", "county", "value_raw"])
        w.writerows(sorted(rows))
    sup = [r for r in rows if r[3] == "(D)"]
    other = Counter(r[3] for r in rows if not r[3].replace(",", "").replace(".", "").isdigit())
    log(f"NASS county rows (SHORT_DESC={want!r}, YEAR 2022): {len(rows)}; distinct geoid {len({r[0] for r in rows})}; "
        f"(D) suppressed: {len(sup)}; non-numeric values: {dict(other)}")
    log(f"  file={out} size={out.stat().st_size} sha256={sha256(out)} vintage=NASS Census of Agriculture 2022, $ per acre, nominal 2022$")
    log("  suppressed states: " + str(dict(Counter(r[1] for r in sup).most_common(12))))
    bvrow()


BV_ROW = ("B&V 2014 'Capital Costs for Transmission and Substations' (WECC), section 2.5.1 / Table 2-6 'Right of Way Widths by Voltage Class', "
          "report p. 2-7 (printed page number; section text starts p. 2-6). Public copy: https://efis.psc.mo.gov/Document/Display/24603. "
          "ROW ft: 230kV SC 125, 230kV DC 150, 345kV SC 175, 345kV DC 200, 500kV SC 200, 500kV DC 250, 500kV HVDC bipole 200, 600kV HVDC bipole 225; "
          "acres/mile 15.14, 18.17, 21.20, 24.23, 24.23, 30.29, 24.23, 27.27 (= ft x 5280 / 43560)")


def bvrow():
    log("B&V ROW widths: " + BV_ROW)


def easement():
    sb = getjson(SB_PADUS)
    log(f"PAD-US source: {sb['title']} (ScienceBase item 652d4fc5d34e44db0e2ee45e, last updated {sb['provenance']['lastUpdated']})")
    rights = sb.get("rights") or ""
    log(f"PAD-US rights (verbatim, {SB_PADUS}): {rights}")
    body = re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", sb.get("body") or "")).replace("&nbsp;", " ")
    i = body.find("easement submissions")
    log(f"PAD-US notes (verbatim): ...{body[max(0, i - 60):i + 60]}...")
    reached = 0
    for u in NCED_URLS:
        try:
            with urllib.request.urlopen(urllib.request.Request(u, headers={"User-Agent": "Mozilla/5.0"}), timeout=30) as r:
                t = r.read().decode("utf-8", "replace")
            reached += 1
            text = re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", t))
            i = text.find("no longer being actively updated")
            log(f"NCED page {u}: HTTP {r.status}, {len(t)} chars; discontinuation notice: "
                + (f"...{text[max(0, i - 120):i + 160]}..." if i >= 0 else "not found"))
        except Exception as e:
            log(f"NCED page {u}: UNREACHABLE ({e!r})")
    if not reached:
        log("NCED terms text: NOT OBTAINED from conservationeasement.us (every page unreachable this run)")
    log(f"NCED terms basis: {NCED_TERMS_BASIS}")
    ok = rights.startswith("Public Domain")
    log(f"fold decision: {'ALLOW (USGS PAD-US Public Domain rights statement; NCED discontinued, PAD-US distributes)' if ok else 'DENY'}")
    if ok:
        padus(easement=True)
    else:
        log("Easement: not fetched: terms")


# ---- named-step inputs ----
FLOOD_URL = "https://enviroatlas.epa.gov/download/Estimated_floodplain_CONUS.zip"
NRHP = "https://mapservices.nps.gov/arcgis/rest/services/cultural_resources/nrhp_locations/MapServer"
MIRTA = "https://services7.arcgis.com/n1YM8pTrFmm7L4hs/arcgis/rest/services/mirta/FeatureServer"
CBRS = "https://gis1.wim.usgs.gov/server/rest/services/CBRSMapper/CoastalBarrierResourcesSystem/MapServer/3"
CRITHAB_ZIP = ROOT / "_Archive/crithab_all_layers.zip"
MIRROR = Path(os.environ.get("HIFLD_MIRROR") or ROOT / "data/raw/hifld-mirror")
BROWSER_UA = {"User-Agent": "Mozilla/5.0"}
MAX_PAGES = 200
CONUS_LL = (-125.0, 24.0, -66.5, 50.0)  # lon/lat box for mirror counts only


def arcgis_get(url, **q):
    for _ in range(3):
        with urllib.request.urlopen(urllib.request.Request(f"{url}?{urllib.parse.urlencode(q)}", headers=BROWSER_UA),
                                    timeout=300) as r:
            j = json.load(r)
        if "error" not in j:
            return j
        log(f"  server error {j['error']}; retry in 10 s")
        time.sleep(10)
    raise RuntimeError(f"{url}: {j['error']}")


def arcgis_all(layer_url, out, vintage, page=None):
    """Whole layer -> GeoJSON (EPSG:4326) + .meta.json sidecar. Skips when the file holds the server's
    current count. Pages by resultOffset when the layer paginates, else by OBJECTID ranges; <= MAX_PAGES."""
    meta_p = out.with_suffix(".meta.json")
    meta = arcgis_get(layer_url, f="json")
    oid = next((f["name"] for f in meta["fields"] if f["type"] == "esriFieldTypeOID"), "OBJECTID")
    total = arcgis_get(layer_url + "/query", where="1=1", returnCountOnly="true", f="json")["count"]
    if out.exists() and meta_p.exists():
        old = json.loads(meta_p.read_text())
        if old.get("features") == total and old.get("sha256") == sha256(out):
            log(f"skip {out} ({total} features present)")
            return old
    paginates = meta.get("advancedQueryCapabilities", {}).get("supportsPagination")
    page = min(page or meta.get("maxRecordCount", 1000), meta.get("maxRecordCount", 1000))
    feats, off, last = [], 0, -1
    for _ in range(MAX_PAGES):
        q = dict(outFields="*", outSR=4326, f="geojson", orderByFields=oid)
        if paginates:
            q.update(where="1=1", resultOffset=off, resultRecordCount=page)
        else:
            q.update(where=f"{oid}>{last}", resultRecordCount=page)
        g = arcgis_get(layer_url + "/query", **q)
        if not g["features"]:
            break
        feats += g["features"]
        off += len(g["features"])
        if not paginates:
            last = max(f["properties"].get(oid, f.get("id", -1)) for f in g["features"])
        if len(feats) >= total:
            break
    else:
        raise RuntimeError(f"{layer_url}: more than {MAX_PAGES} pages")
    ids = [f["properties"].get(oid, f.get("id")) for f in feats]
    assert len(feats) == total and len(set(ids)) == len(ids), f"{layer_url}: got {len(feats)} (unique {len(set(ids))}), server count {total}"
    out.parent.mkdir(parents=True, exist_ok=True)
    tmp = out.with_suffix(".part")
    tmp.write_text(json.dumps({"type": "FeatureCollection", "features": feats}))
    tmp.rename(out)
    info = dict(url=layer_url, features=total, paginates=bool(paginates), maxRecordCount=meta.get("maxRecordCount"),
                fetched=time.strftime("%Y-%m-%d"), vintage=vintage, sha256=sha256(out), size=out.stat().st_size,
                layer_edit=meta.get("editingInfo", {}).get("dataLastEditDate"))
    meta_p.write_text(json.dumps(info, indent=1))
    log(f"url={layer_url} file={out} {info}")
    return info


def flood():
    d = RAW / "floodplain"
    z = d / "Estimated_floodplain_CONUS.zip"
    download(FLOOD_URL, z, "EPA EnviroAtlas Estimated floodplain CONUS (Woznicki et al. 2019, doi 10.1016/j.scitotenv.2018.07.353), CC0")
    unzip(z, d / "unzipped")
    for p in sorted((d / "unzipped").rglob("*")):
        log(f"  {p.relative_to(d)} {'dir' if p.is_dir() else p.stat().st_size}")
    src = next((p for p in (d / "unzipped").rglob("*") if p.suffix.lower() in (".tif", ".img", ".gdb")), None)
    if src:
        run(["gdalinfo", str(src)], stdout=sys.stdout)


def nrhp():
    d = RAW / "nrhp"
    for lyr, name in ((0, "nrhp_points"), (1, "nrhp_polygons")):
        arcgis_all(f"{NRHP}/{lyr}", d / f"{name}.geojson", "NPS NRHP locations, as served", page=2000)


def mirta():
    d = RAW / "mirta"
    info = arcgis_all(f"{MIRTA}/1", d / "mirta_boundaries.geojson", "DoD DISDI MIRTA 'DoD Sites - Boundary' (data.gov)", page=1000)
    fc = json.loads((d / "mirta_boundaries.geojson").read_text())
    fs = fc["features"]
    log(f"MIRTA rows={len(fs)} geometry={dict(Counter(f['geometry']['type'] if f['geometry'] else None for f in fs))}")
    for k in ("SITEOPERATIONALSTATUS", "SITEREPORTINGCOMPONENT", "FEATUREDESCRIPTION", "COUNTRYNAME"):
        log(f"  {k}: {dict(Counter(f['properties'].get(k) for f in fs).most_common(15))}")


def cbrs():
    d = RAW / "cbrs"
    arcgis_all(CBRS, d / "cbrs_units.geojson", "USFWS CBRS Units (CBRS Mapper service), public domain", page=1000)
    fs = json.loads((d / "cbrs_units.geojson").read_text())["features"]
    log(f"CBRS Units rows={len(fs)}; field Unit_Type values: {dict(Counter(f['properties'].get('Unit_Type') for f in fs))}; "
        f"geometry={dict(Counter(f['geometry']['type'] if f['geometry'] else None for f in fs))}")


def crithab_line():
    lyr = f"/vsizip/{CRITHAB_ZIP}/CRITHAB_LINE.shp"
    run(["ogrinfo", "-so", lyr, "CRITHAB_LINE"], stdout=sys.stdout)
    import pyogrio
    df = pyogrio.read_dataframe(lyr, read_geometry=False)
    log(f"CRITHAB_LINE rows={len(df)} status: {dict(Counter(df['status']))}; listing_st: {dict(Counter(df['listing_st']))}")


MIRROR_TABLES = {  # name -> (path under MIRROR, columns the plan reads)
    "public_schools": ("public-schools/public-schools/public-schools.parquet", ["STATUS", "TYPE"]),
    "private_schools": ("private-schools/private-schools/private-schools.parquet", ["STATUS", "TYPE"]),
    "hospitals": ("hospitals/hospitals/hospitals.parquet", ["STATUS", "TYPE"]),
    "child_care": ("child-care-centers/childcarecenters/childcarecenters.parquet", ["STATUS", "TYPE"]),
    "nursing_homes": ("nursing-homes/nursing-homes/nursing-homes.parquet", ["STATUS", "TYPE"]),
    "nid": ("national-inventory-of-dams-nid/national-inventory-of-dams/national-inventory-of-dams.parquet",
            ["HAZARD_POTENTIAL", "NID_HEIGHT", "OPERATIONAL_STATUS"]),
    "fuds_mrs": ("formerly-used-defense-sites-fuds-public-munitions-response-sites-mrs/fuds-munitions-response-site/"
                 "fuds-munitions-response-site.parquet", ["PROJECTSTATUS"]),
    "asr": ("antenna-structure-registration-asr/asr/asr.parquet", ["Strucht", "StatusCode"]),
}


def mirror():
    import pyarrow.dataset as ds
    import pyarrow.parquet as pq
    for name, (rel, cols) in MIRROR_TABLES.items():
        p = MIRROR / rel
        parts = sorted(p.glob("*.parquet")) if p.is_dir() else [p]
        dset = ds.dataset(p)
        flat = "properties" in dset.schema.names  # child care nests its columns
        t = dset.to_table(columns=["bbox"] + (["properties"] if flat else cols))
        if flat:
            props = t.column("properties").combine_chunks()
            col = {c: props.field(c).to_pylist() for c in cols}
        else:
            col = {c: t.column(c).to_pylist() for c in cols}
        bb = t.column("bbox").to_pylist()
        inside = sum(CONUS_LL[0] <= (b["xmin"] + b["xmax"]) / 2 <= CONUS_LL[2] and CONUS_LL[1] <= (b["ymin"] + b["ymax"]) / 2 <= CONUS_LL[3]
                     for b in bb)
        geo = json.loads(pq.read_metadata(parts[0]).metadata.get(b"geo", b"{}")).get("columns", {}).get("geometry", {}).get("geometry_types")
        log(f"== {name}: {p}\n  parts={len(parts)} rows={t.num_rows} geometry_types={geo} in CONUS box={inside} outside={t.num_rows - inside}")
        for c in cols:
            v = col[c]
            if c in ("NID_HEIGHT", "Strucht"):
                nz = [x for x in v if x is not None]
                log(f"  {c}: non-null={len(nz)} min={min(nz)} max={max(nz)} >= {25 if c == 'NID_HEIGHT' else 61}: {sum(x >= (25 if c == 'NID_HEIGHT' else 61) for x in nz)}")
            else:
                log(f"  {c}: {dict(Counter(v).most_common(30))}")


def mirta_measure():
    """MIRTA (centre rule, act/semi) cells the PAD-US DoD bit lacks, as a share of that bit's cells."""
    import numpy as np, pyogrio
    from rasterio.features import rasterize
    from rasterio.transform import Affine
    sys.path.insert(0, str(ROOT / "scripts"))
    import route_grid as G
    aff, shape = Affine.from_gdal(*G.transform()), (G.ROWS, G.COLS)
    bbox = (-130.0, 21.0, -60.0, 52.0)

    def burn(gdf, touched):
        gdf = gdf[gdf.geometry.notna() & ~gdf.geometry.is_empty].to_crs(G.CRS)
        gdf = gdf.assign(geometry=gdf.geometry.make_valid())
        a = np.zeros(shape, np.uint8)
        rasterize(((g, 1) for g in gdf.geometry), out=a, transform=aff, all_touched=touched)
        return a
    pad = pyogrio.read_dataframe(INP / "padus_dod.gpkg", bbox=tuple(__import__("rasterio").warp.transform_bounds("EPSG:4326", "EPSG:5070", *bbox)))
    mi = pyogrio.read_dataframe(RAW / "mirta/mirta_boundaries.geojson", bbox=bbox)
    st = mi["SITEOPERATIONALSTATUS"].fillna("").str.lower()
    log(f"MIRTA in bbox {len(mi)}; status kept (act/semi) {int(st.isin(['act', 'semi']).sum())}, dropped {Counter(st[~st.isin(['act', 'semi'])])}")
    m = burn(mi[st.isin(["act", "semi"])], False)
    for label, touched in (("PAD-US DoD all-touched (as built into pd flags bit 1)", True), ("PAD-US DoD centre rule", False)):
        p = burn(pad, touched)
        extra = int(((m == 1) & (p == 0)).sum())
        log(f"{label}: padus cells={int(p.sum())} mirta cells={int(m.sum())} mirta-not-in-padus={extra} = {100 * extra / p.sum():.1f}% of padus")


STRUCT_HUB = "https://www.arcgis.com/sharing/rest/content/items/8388995e228e4e30a882686ac3ab256e/data?f=json"
NOT_CONUS = ("AK", "HI", "AS", "GU", "MP", "PR", "VI")


def structures_state(name):
    """Postal code of a USA Structures zip name: 'VT_Structures_20260913.zip' or 'Deliverable20250606TX.zip'."""
    m = re.search(r"^([A-Z]{2})_Structures_\d{8}\.zip$|^Deliverable\d{8}([A-Z]{2})\.zip$", name)
    return (m.group(1) or m.group(2)) if m else None


def structures_dir():
    import os
    return Path(os.environ.get("STRUCTURES_DIR") or RAW / "usa_structures")


def structures():
    """USA Structures: the hub page lists one zip per state; keep CONUS + DC. Resumable: a zip
    already at its Content-Length is skipped, a partial one restarts from its .part byte offset."""
    d = structures_dir()
    d.mkdir(parents=True, exist_ok=True)
    page = urllib.request.urlopen(urllib.request.Request(STRUCT_HUB, headers=UA), timeout=120).read().decode()
    urls = sorted(set(re.findall(r'https://fema-femadata[^"\\ )]+\.zip', page)))
    log(f"hub lists {len(urls)} zips")
    meta = {}
    for u in urls:
        name = u.rsplit("/", 1)[1]
        st = structures_state(name)
        assert st, name
        if st in NOT_CONUS:
            continue
        dest = d / name
        want, lm = fetch_resumable(u, dest)
        log(f"url={u} file={dest} size={want} last_modified={lm}")
        meta[st] = {"url": u, "zip": name, "bytes": want, "last_modified": lm,
                    "deliverable": re.search(r"(\d{8})", name).group(1)}
    (d / "structures_zips.json").write_text(json.dumps(meta, indent=1, sort_keys=True) + "\n")
    log(f"{len(meta)} CONUS zips, {sum(m['bytes'] for m in meta.values()) / 1e9:.2f} GB -> {d}")


NWI_URL = "https://documentst.ecosphere.fws.gov/wetlands/data/State-Downloads/{st}_geopackage_wetlands.zip"
NWI_STATES = ("AL AZ AR CA CO CT DE DC FL GA ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND "
              "OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY").split()
NWI_SAMPLE = "DE"
RPS_URL = "https://imagery.geoplatform.gov/iipp/rest/services/Fire_Aviation/USFS_EDW_RMRS_WRC_RiskToPotentialStructures/ImageServer"


def fetch_resumable(u, dest, guard=True):
    """Download u to dest, resuming a .part file by byte range; skip when dest has the Content-Length.
    Refuses (disk_guard) when the bytes still to fetch would leave the disk under its free-space floor;
    guard=False leaves that check to a caller that has made one for a whole batch."""
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    import disk_guard
    head = urllib.request.urlopen(urllib.request.Request(u, headers=UA, method="HEAD"), timeout=120)
    want, lm = int(head.headers["Content-Length"]), head.headers.get("Last-Modified")
    tmp = dest.with_suffix(dest.suffix + ".part")
    if guard and not (dest.exists() and dest.stat().st_size == want):
        disk_guard.require_free(dest.parent, max(want - (tmp.stat().st_size if tmp.exists() else 0), 0))
    for attempt in range(5):
        if dest.exists() and dest.stat().st_size == want:
            break
        have = tmp.stat().st_size if tmp.exists() else 0
        req = urllib.request.Request(u, headers={**UA, "Range": f"bytes={have}-"} if have else UA)
        try:
            with urllib.request.urlopen(req, timeout=120) as r, open(tmp, "ab" if have and r.status == 206 else "wb") as f:
                while b := r.read(1 << 22):
                    f.write(b)
            if tmp.stat().st_size == want:
                tmp.rename(dest)
        except OSError as e:
            log(f"  {dest.name}: attempt {attempt + 1} stopped ({e}); resuming")
            time.sleep(10)
    if not (dest.exists() and dest.stat().st_size == want):
        sys.exit(f"{dest.name}: download incomplete")
    return want, lm


def nwi_dir():
    import os
    return Path(os.environ.get("NWI_DIR") or RAW / "nwi")


def nwi():
    from concurrent.futures import ThreadPoolExecutor
    d = nwi_dir()
    d.mkdir(parents=True, exist_ok=True)
    link = RAW / "nwi"
    if not link.exists() and d.resolve() != link.resolve():
        link.symlink_to(d)

    def dest_of(st):
        return d / f"{st}_geopackage_wetlands.zip"

    def remaining(st):
        want = int(urllib.request.urlopen(urllib.request.Request(NWI_URL.format(st=st), headers=UA, method="HEAD"),
                                          timeout=120).headers["Content-Length"])
        dest, part = dest_of(st), dest_of(st).with_suffix(".zip.part")
        return 0 if dest.exists() and dest.stat().st_size == want else max(want - (part.stat().st_size if part.exists() else 0), 0)
    # one check for every zip still to fetch: the two workers would otherwise each pass against the same free space
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    import disk_guard
    disk_guard.require_free(d, sum(remaining(st) for st in NWI_STATES))

    def one(st):
        u = NWI_URL.format(st=st)
        size, lm = fetch_resumable(u, dest_of(st), guard=False)
        log(f"url={u} size={size} last_modified={lm}")
        return st, {"url": u, "bytes": size, "last_modified": lm}
    with ThreadPoolExecutor(2) as ex:
        meta = dict(ex.map(one, NWI_STATES))
    (d / "nwi_zips.json").write_text(json.dumps(meta, indent=1, sort_keys=True) + "\n")
    log(f"{len(meta)} zips, {sum(m['bytes'] for m in meta.values()) / 1e9:.2f} GB -> {d}")
    import pyogrio
    # /vsizip/ makes a gpkg attribute scan take minutes; unzipping one state takes seconds
    tmpd = Path(tempfile.mkdtemp(prefix="nwi-"))
    with zipfile.ZipFile(d / f"{NWI_SAMPLE}_geopackage_wetlands.zip") as zf:
        names = [n for n in zf.namelist() if n.endswith(".gpkg")]
        log(f"{NWI_SAMPLE} members: {names}")
        zf.extract(names[0], tmpd)
    src = str(tmpd / names[0])
    layers = pyogrio.list_layers(src)
    log(f"layers: {layers.tolist()}")
    for name in layers[:, 0]:
        info = pyogrio.read_info(src, layer=name)
        log(f"  {name}: features={info['features']} geometry={info['geometry_type']} fields={list(info['fields'])}")
    big = max(layers[:, 0], key=lambda n: pyogrio.read_info(src, layer=n)["features"])
    df = pyogrio.read_dataframe(src, layer=big, columns=["WETLAND_TYPE"], read_geometry=False)
    log(f"WETLAND_TYPE counts in {big}:")
    for k, v in df["WETLAND_TYPE"].value_counts(dropna=False).items():
        log(f"  {k!r}: {v}")
    shutil.rmtree(tmpd)


def rps():
    """Risk to Potential Structures on the routing grid. The ImageServer serves 30 m U16 values
    ('altered from the original raster', visualisation service); each chunk is exported with the
    server's bilinear resampling onto the 250 m lattice and mosaicked."""
    import numpy as np, rasterio
    from rasterio.transform import from_origin
    sys.path.insert(0, str(ROOT / "scripts"))
    import route_grid as g
    out = RAW / "wrc/rps_250m.tif"
    out.parent.mkdir(parents=True, exist_ok=True)
    if out.exists():
        log(f"skip {out}")
    else:
        step = 4000
        arr = np.full((g.ROWS, g.COLS), np.nan, dtype="float32")
        for r0 in range(0, g.ROWS, step):
            for c0 in range(0, g.COLS, step):
                h, w = min(step, g.ROWS - r0), min(step, g.COLS - c0)
                x0, y1 = g.X0 + c0 * g.CELL, g.Y0 - r0 * g.CELL
                q = urllib.parse.urlencode(dict(
                    bbox=f"{x0},{y1 - h * g.CELL},{x0 + w * g.CELL},{y1}", bboxSR=5070, imageSR=5070, size=f"{w},{h}",
                    format="tiff", pixelType="F32", interpolation="RSP_BilinearInterpolation", noData=65535, f="json"))
                meta = getjson(f"{RPS_URL}/exportImage?{q}")
                if "href" not in meta:
                    sys.exit(f"exportImage refused: {meta}")
                assert (meta["width"], meta["height"]) == (w, h) and abs(meta["extent"]["xmin"] - x0) < 1e-6 and abs(meta["extent"]["ymax"] - y1) < 1e-6, meta
                tif = urllib.request.urlopen(urllib.request.Request(meta["href"], headers=UA), timeout=300).read()
                with rasterio.MemoryFile(tif) as mf, mf.open() as ds:
                    a = ds.read(1).astype("float32")
                    if ds.nodata is not None:
                        a[a == ds.nodata] = np.nan
                arr[r0:r0 + h, c0:c0 + w] = a
                log(f"  chunk r{r0} c{c0} {w}x{h} ok")
        tmp = out.with_suffix(".part.tif")
        with rasterio.open(tmp, "w", driver="GTiff", width=g.COLS, height=g.ROWS, count=1, dtype="float32", crs=g.CRS,
                           transform=from_origin(g.X0, g.Y0, g.CELL, g.CELL), nodata=np.nan, compress="deflate", tiled=True) as ds:
            ds.write(arr, 1)
        tmp.replace(out)
        log(f"url={RPS_URL} file={out} size={out.stat().st_size} sha256={sha256(out)} vintage=RDS-2020-0016-2 (2024 version), bilinear, fetched {time.strftime('%Y-%m-%d')}")
    describe_raster(out)
    with rasterio.open(out) as ds:
        a = ds.read(1)
    v = a[np.isfinite(a)]
    log(f"valid={v.size} nodata/NaN={a.size - v.size} zero={int((v == 0).sum())} min={v.min()} max={v.max()} mean={v.mean():.3f}")
    log("percentiles 1/5/25/50/75/90/95/99/99.9: " + " ".join(f"{x:.2f}" for x in np.percentile(v, [1, 5, 25, 50, 75, 90, 95, 99, 99.9])))


NTAD = "https://services.arcgis.com/xOi1kZaI0eWDREZv/arcgis/rest/services"
NTAD_LAYERS = {  # file stem -> (layer url, geometry wanted)
    "facilities": (f"{NTAD}/NTAD_Aviation_Facilities/FeatureServer/0", True),
    "runways": (f"{NTAD}/Runways_View/FeatureServer/0", True),
    "runway_ends": (f"{NTAD}/Runway_Ends_Table/FeatureServer/1", False),
}
ADDS_AIRPORT = f"{FAA}/US_Airport/FeatureServer/0"
ADDS_FIELDS = "GLOBAL_ID,IDENT,ICAO_ID,TYPE_CODE,OPERSTATUS,PRIVATEUSE,MIL_CODE,IAPEXISTS"
NTAD_TRIES = 4
NTAD_RETRY_SLEEP = 5
NTAD_MAX_PAGES = 1000


def ntad_dir():
    import os
    return Path(os.environ.get("NTAD_DIR") or ROUTE_CACHE / "route-raw/ntad")


def ntad_get(url, **q):
    """One ArcGIS GET -> dict; HTTP/network/server errors retried NTAD_TRIES times, then raised."""
    last = None
    for i in range(NTAD_TRIES):
        try:
            req = urllib.request.Request(f"{url}?{urllib.parse.urlencode(q)}", headers=BROWSER_UA)
            with urllib.request.urlopen(req, timeout=120) as r:
                j = json.load(r)
            if "error" not in j:
                return j
            last = j["error"]
        except Exception as e:  # urllib.error.URLError, HTTPError, timeouts, bad JSON
            last = repr(e)
        log(f"  ntad_get attempt {i + 1}/{NTAD_TRIES} failed: {last}")
        if i < NTAD_TRIES - 1:
            time.sleep(NTAD_RETRY_SLEEP)
    raise RuntimeError(f"{url}: failed after {NTAD_TRIES} attempts: {last}")


def ntad_cycles(layer_url):
    j = ntad_get(layer_url + "/query", where="1=1", outFields="EFF_DATE", returnDistinctValues="true",
                 returnGeometry="false", f="json")
    return sorted({f["attributes"]["EFF_DATE"] for f in j["features"]})


def ntad_fetch_layer(layer_url, out, geometry, fields="*", where="1=1", page=None):
    """Whole layer -> JSONL (one {attributes, geometry} per line, outSR 4326) at `out`. Pages by OBJECTID
    ranges (ordered), resumes a `.part` file, checks the count against returnCountOnly. Returns (count, sha256)."""
    meta = ntad_get(layer_url, f="json")
    oid = next(f["name"] for f in meta["fields"] if f["type"] == "esriFieldTypeOID")
    total = ntad_get(layer_url + "/query", where=where, returnCountOnly="true", f="json")["count"]
    page = min(page or meta["maxRecordCount"], meta["maxRecordCount"])
    part = out.with_suffix(out.suffix + ".part")
    n, last = 0, -1
    if part.exists():  # resume: keep the complete lines, drop a torn final one
        keep = []
        for line in part.read_text().split("\n"):
            try:
                keep.append((json.loads(line)["attributes"][oid], line))
            except (ValueError, KeyError):
                break
        part.write_text("".join(line + "\n" for _, line in keep))
        n, last = len(keep), max((o for o, _ in keep), default=-1)
        log(f"  resume {part.name}: {n} records, last {oid}={last}")
    with open(part, "a") as f:
        for _ in range(NTAD_MAX_PAGES):
            g = ntad_get(layer_url + "/query", where=f"({where}) AND {oid}>{last}", outFields=fields if fields == "*" else f"{oid},{fields}",
                         returnGeometry="true" if geometry else "false", outSR=4326, orderByFields=oid,
                         resultRecordCount=page, f="json")
            feats = g["features"]
            if not feats:
                break
            for ft in feats:
                f.write(json.dumps({"attributes": ft["attributes"], "geometry": ft.get("geometry")},
                                   separators=(",", ":")) + "\n")
            n += len(feats)
            last = max(ft["attributes"][oid] for ft in feats)
            f.flush()
        else:
            raise RuntimeError(f"{layer_url}: more than {NTAD_MAX_PAGES} pages")
    if n != total:
        raise RuntimeError(f"{layer_url}: fetched {n} records, returnCountOnly {total}")
    ids = [json.loads(line)["attributes"][oid] for line in part.read_text().splitlines()]
    if len(set(ids)) != n:
        raise RuntimeError(f"{layer_url}: duplicate {oid} values")
    part.rename(out)
    return n, sha256(out)


def ntad_read(p):
    return [json.loads(line)["attributes"] for line in p.read_text().splitlines()]


def ntad_check_nfl(facilities, runways, ends):
    """NAS Fallon (NFL, SITE_NO '13057.'): 1 facility, 3 runways, 6 ends; ids stay strings."""
    site = [a for a in facilities if a.get("ARPT_ID") == "NFL"]
    sn = site[0]["SITE_NO"] if site else None
    got = (len(site), sum(a["SITE_NO"] == "13057." for a in runways), sum(a["SITE_NO"] == "13057." for a in ends))
    if sn != "13057." or got != (1, 3, 6):
        raise RuntimeError(f"NFL check failed: SITE_NO={sn!r} (facility, runways, ends)={got}, want '13057.' (1, 3, 6)")
    return got


def ntad():
    """NTAD Aviation Facilities, Runways and Runway Ends for one EFF_DATE cycle, plus ADDS IAPEXISTS per
    airport, into $NTAD_DIR with ntad_manifest.json (cycle, per-file count + sha256). Re-run skips complete files."""
    import os
    import disk_guard
    d = ntad_dir()
    disk_guard.require_free(d, int(0.1 * 2**30))
    d.mkdir(parents=True, exist_ok=True)
    man_p = d / "ntad_manifest.json"
    man = json.loads(man_p.read_text()) if man_p.exists() else {"layers": {}}
    cycles = {k: ntad_cycles(u) for k, (u, _) in NTAD_LAYERS.items()}
    log(f"EFF_DATE per layer: {cycles}")
    pin = os.environ.get("NTAD_EFF_DATE") or (cycles["facilities"][0] if len(cycles["facilities"]) == 1 else None)
    if pin is None or any(c != [pin] for c in cycles.values()):
        sys.exit(f"ntad: mixed or unpinned cycles {cycles} (pin {pin!r}); refusing. Retry later or set NTAD_EFF_DATE")
    if man.get("eff_date") not in (None, pin):
        sys.exit(f"ntad: {d} holds cycle {man['eff_date']}, server is {pin}; use a new NTAD_DIR")
    man.update(eff_date=pin, fetched=time.strftime("%Y-%m-%d"))
    jobs = [(k, u, g, "*", "1=1") for k, (u, g) in NTAD_LAYERS.items()]
    jobs.append(("adds_airports", ADDS_AIRPORT, False, ADDS_FIELDS, "1=1"))
    for k, u, geom, fields, where in jobs:
        out = d / f"{k}.jsonl"
        total = ntad_get(u + "/query", where=where, returnCountOnly="true", f="json")["count"]
        old = man["layers"].get(k)
        if out.exists() and old and old["count"] == total and old["sha256"] == sha256(out):
            log(f"skip {out} ({total} records present)")
            continue
        n, h = ntad_fetch_layer(u, out, geom, fields, where)
        man["layers"][k] = dict(url=u, count=n, returnCountOnly=total, sha256=h, size=out.stat().st_size)
        man_p.write_text(json.dumps(man, indent=1, sort_keys=True) + "\n")
        log(f"url={u} file={out} count={n} returnCountOnly={total} size={out.stat().st_size} sha256={h}")
    recs = {k: ntad_read(d / f"{k}.jsonl") for k in NTAD_LAYERS}
    for k, rows in recs.items():
        bad = {a["EFF_DATE"] for a in rows} - {pin}
        if bad:
            sys.exit(f"ntad: {k} holds EFF_DATE {sorted(bad)} besides {pin}; mixed cycle")
    log(f"NFL check (facility, runways, ends) = {ntad_check_nfl(recs['facilities'], recs['runways'], recs['runway_ends'])}")
    log(f"EFF_DATE {pin}; total bytes {sum(v['size'] for v in man['layers'].values())} -> {d}")


NFHL_URL = "https://gis.fema.gov/NFHL/NFHL_Key_Layers.gdb.zip"
NFHL_EDITION = "NFHL_Key_Layers_202610.gdb.zip"


def nfhl_dir():
    import os
    return Path(os.environ.get("NFHL_DIR") or ROUTE_CACHE / "route-raw/nfhl")


def nfhl_resolve(url=NFHL_URL, edition=None):
    """Follow the redirect without downloading; refuse an edition other than the pinned one. -> (final url, size, last-modified)."""
    import os
    edition = edition or os.environ.get("NFHL_EDITION") or NFHL_EDITION
    head = urllib.request.urlopen(urllib.request.Request(url, headers=UA, method="HEAD"), timeout=120)
    final = head.geturl()
    name = final.split("?")[0].rsplit("/", 1)[-1]
    if name != edition:
        sys.exit(f"nfhl: server edition is {name}, pinned {edition}; set NFHL_EDITION to accept it")
    return final, int(head.headers["Content-Length"]), head.headers.get("Last-Modified")


def chunk_span(i, want, chunk):
    """Inclusive byte range [a, b] of chunk i of a `want`-byte file."""
    return i * chunk, min((i + 1) * chunk, want) - 1


def chunked_missing(dest, want, chunk=128 << 20):
    """Bytes fetch_chunked still has to download for dest: all of `want` without a .part, else the chunks not in .part.done."""
    part = dest.with_suffix(dest.suffix + ".part")
    done_p = dest.with_suffix(dest.suffix + ".part.done")
    n = -(-want // chunk)
    done = set(json.loads(done_p.read_text())) if done_p.exists() and part.exists() else set()
    return sum(b - a + 1 for a, b in (chunk_span(i, want, chunk) for i in range(n) if i not in done))


def fetch_chunked(u, dest, want, streams=8, chunk=128 << 20):
    """Parallel ranged download of u (size `want`) into dest: `streams` connections, `chunk`-byte ranges, resumable
    through dest.part + dest.part.done (finished chunk indices); each chunk is retried 5 times."""
    from concurrent.futures import ThreadPoolExecutor
    import threading
    part = dest.with_suffix(dest.suffix + ".part")
    done_p = dest.with_suffix(dest.suffix + ".part.done")
    n = -(-want // chunk)
    done = set(json.loads(done_p.read_text())) if done_p.exists() and part.exists() else set()
    if not part.exists():
        with open(part, "wb") as f:
            f.truncate(want)
    lock = threading.Lock()

    def one(i):
        a, b = chunk_span(i, want, chunk)
        for attempt in range(5):
            try:
                req = urllib.request.Request(u, headers={**UA, "Range": f"bytes={a}-{b}"})
                with urllib.request.urlopen(req, timeout=120) as r:
                    if r.status != 206:
                        sys.exit(f"{dest.name}: server ignored the Range header (HTTP {r.status})")
                    pos = a
                    with open(part, "r+b") as f:
                        while blk := r.read(1 << 20):
                            f.seek(pos)
                            f.write(blk)
                            pos += len(blk)
                if pos != b + 1:
                    raise OSError(f"short chunk {i}: {pos - a} of {b + 1 - a}")
                with lock:
                    done.add(i)
                    done_p.write_text(json.dumps(sorted(done)))
                    log(f"  chunk {i + 1}/{n} done ({len(done)} complete)")
                return
            except OSError as e:
                log(f"  chunk {i} attempt {attempt + 1} stopped ({e})")
                time.sleep(10)
        sys.exit(f"{dest.name}: chunk {i} failed")
    with ThreadPoolExecutor(streams) as ex:
        list(ex.map(one, [i for i in range(n) if i not in done]))
    if done != set(range(n)):
        sys.exit(f"{dest.name}: {n - len(done)} of {n} chunks incomplete")
    if part.stat().st_size != want:
        sys.exit(f"{dest.name}: size {part.stat().st_size} != {want}")
    part.rename(dest)
    done_p.unlink(missing_ok=True)


def nfhl():
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    import disk_guard
    d = nfhl_dir()
    d.mkdir(parents=True, exist_ok=True)
    final, want, lm = nfhl_resolve()
    dest = d / final.split("?")[0].rsplit("/", 1)[-1]
    complete = dest.exists() and dest.stat().st_size == want
    disk_guard.require_free(d, 0 if complete else chunked_missing(dest, want))
    if not complete:
        fetch_chunked(final, dest, want)
    size, lm2 = dest.stat().st_size, lm
    if size != want:
        sys.exit(f"nfhl: size {size} != Content-Length {want}")
    man_p = d / "nfhl_manifest.json"
    man = json.loads(man_p.read_text()) if man_p.exists() else {}
    if man.get("file") == dest.name and man.get("size") == size and man.get("sha256"):
        h = man["sha256"]
    else:
        h = sha256(dest)
    man = dict(url=final, requested=NFHL_URL, file=dest.name, size=size, last_modified=lm2 or lm, sha256=h,
               fetched=time.strftime("%Y-%m-%d"))
    man_p.write_text(json.dumps(man, indent=1, sort_keys=True) + "\n")
    log(f"url={final} size={size} last_modified={man['last_modified']} sha256={h} -> {dest}")


def worldpop():
    log(f"WorldPop raw 1 km counts (from build_population_density.sh): {WORLDPOP}")
    describe_raster(WORLDPOP)
    log("units: people per ~1 km cell (ppp_2020_1km_Aggregated, 2020 count)")


if __name__ == "__main__":
    steps = dict(nlcd=nlcd, faa=faa, sec368=sec368, popwest=popwest, padus=padus, worldpop=worldpop,
                 grsg=grsg, wsr=wsr, trails=trails, npl=npl, nass=nass, bvrow=bvrow, easement=easement,
                 flood=flood, nrhp=nrhp, mirta=mirta, cbrs=cbrs, crithab_line=crithab_line, mirror=mirror, mirta_measure=mirta_measure,
                 structures=structures, nwi=nwi, rps=rps, ntad=ntad, nfhl=nfhl)
    for n in (sys.argv[1:] or [k for k in steps if k not in ("grsg", "wsr", "trails", "npl", "nass", "bvrow", "easement", "flood", "nrhp", "mirta", "cbrs", "crithab_line", "mirror", "mirta_measure", "structures", "nwi", "rps", "ntad", "nfhl")]):
        log(f"=== {n}")
        steps[n]()
