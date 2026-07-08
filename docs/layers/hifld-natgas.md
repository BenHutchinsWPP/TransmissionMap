# HIFLD Natural Gas & Petroleum Infrastructure

HIFLD natural gas and petroleum pipeline lines and facility points (US).

## Source

| | |
|---|---|
| **Provider** | DHS / CISA — Homeland Infrastructure Foundation-Level Data (HIFLD); original data: EIA / DHS CISA |
| **Origin** | Oak Ridge NL (ORNL), Los Alamos NL (LANL), Idaho NL (INL), NGA |
| **License** | Public domain — US federal work, [17 U.S.C. § 105](https://www.law.cornell.edu/uscode/text/17/105) |
| **Attribution** | "HIFLD / DHS CISA" |
| **Download origin** | [SeerAI HIFLD Archive](https://source.coop/repositories/seerai/hifld/description/) (source.coop), GeoParquet — **manually placed** at `data/raw/hifld/natgas/` |
| **Served** | `data/layers/hifld_natgas_lines.pmtiles` (lines) · `data/layers/hifld_natgas_points.geojson.gz` (points) |
| **Built by** | `scripts/extract_hifld_natgas.py` |

> The HIFLD Open portal closed September 16, 2025; datasets have been archived by SeerAI on source.coop.

## Download pack

Two separate packs (one per map layer):

- **Lines** — `hifld-natgas-lines.zip` (GeoJSON) / `hifld-natgas-lines-shp.zip` (SHP): geometry + `hifld-natgas-lines.csv`
- **Points** (`hifld-natgas-points.zip`) — CSV only: `hifld-natgas-points.csv`

Every zip also includes `hifld-natgas.txt` (this doc) + `disclaimer.txt`.

---

## Pipeline Lines

**~33,200 features** (2 source parquets merged, MultiLineString exploded)

| `pipe_type` | Count |
|---|---:|
| Interstate | ~18,000 |
| Intrastate | ~14,900 |
| HGL | ~130 |
| Gathering | ~70 |

**Output fields:** `pipe_type`, `operator`, `name` (HGL only)

**Source files:**
- `natural-gas-interstate-and-intrastate-pipelines.parquet` — ~33,000 rows; `TYPEPIPE` → `pipe_type`, `Operator` → `operator`
- `hydrocarbon-gas-liquid-pipelines.parquet` — ~130 rows; `pipe_type` hardcoded "HGL", `Opername` → `operator`, `Pipename` → `name`

---

## Facility Points

**~3,600 points** (9 source parquets merged, dismantled/abandoned records removed)

> **Split into two layers by commodity** (one shared `hifld-natgas-points` source,
> base-filtered on `fac_type`): **HIFLD Gas Facilities** (processing, storage, LNG,
> trading hubs, border crossings, peak shaving — ~1,337) and **Petroleum Terminals
> & SPR** (`pol_terminal` + `spr` — ~2,265). Both sit in the **Fuel Delivery**
> panel group. The "Facility type" legend filter spans both.

**Output schema:** `fac_type`, `name`, `operator`, `state`, `status`, `detail`, `lat`, `lon`

| `fac_type` | Count | Color | Min zoom |
|---|---:|---|---:|
| `pol_terminal` | ~2,300 | `#94a3b8` slate | 7 |
| `processing` | ~480 | `#f97316` orange | 6 |
| `underground` | ~410 | `#8b5cf6` purple | 5 |
| `lng_storage` | ~270 | `#0ea5e9` sky blue | 7 |
| `peak_shaving` | ~90 | `#84cc16` lime | 7 |
| `border_cross` | ~50 | `#ec4899` pink | 5 |
| `trading_hub` | ~30 | `#fbbf24` yellow | 4 |
| `lng_terminal` | 9 | `#06b6d4` cyan | 3 |
| `spr` | 4 | `#ef4444` red | 3 |

**`detail` field format per type:**
- `lng_terminal` — function string (e.g. "Export", "Import/Export")
- `trading_hub` — none (name only)
- `spr` — capacity MMbbl + cavern count
- `underground` — `{Field_Type} — {work_cap:,} Mcf working cap`
- `processing` — `{Cap_MMcfd} MMcfd capacity`
- `pol_terminal` — `{TYPE} — {COMMODITY} ({CAPACITY:,} bbl)`
- `lng_storage` — facility type string
- `peak_shaving` — facility type string
- `border_cross` — `{FrmCountry} → {ToCountry} ({Vol_MMcfd} MMcfd)`

## Caveats

- Dismantled and abandoned facility records are dropped, so the points layer reflects only
  in-service / proposed infrastructure.
- Gathering lines are sparse (~70 features) — pipeline coverage is strongest for inter/intra-state
  transmission, not local distribution or gathering.
- US coverage only.
