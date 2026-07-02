# Large Mines (MSHA, filtered) — Data Notes

**Source:** [MSHA Mine Data](../data-sources.md) · US public domain (US DOL)
Raw input: `data/raw/mines/Mines.txt` + `MinesProdQuarterly.txt` (from the two
MSHA zips; not committed)
Built by: `scripts/extract_mines.py` (`make mines`)
Final output: `data/layers/mines.geojson.gz` (~70 KB gz, ~2.3k points)

---

## Source

MSHA (Mine Safety and Health Administration) publishes every US mine under its
jurisdiction with status, commodity (SIC), operator, and lat/lon, plus a
quarterly Employment/Production dataset. Portal:
https://arlweb.msha.gov/opengovernmentdata/ogimsha.asp (`Mines.zip`,
`MinesProdQuarterly.zip`; pipe-delimited, latin-1).

Chosen over USGS MRDS (frozen 2011, weak coal/energy coverage) and USGS
mineplant (2003 snapshot). MSHA refreshes continuously.

## Processing

`extract_mines.py`:
1. Reads `MinesProdQuarterly.txt`, computes each mine's **peak** quarterly
   average employment (`AVG_EMPLOYEE_CNT`).
2. Reads `Mines.txt`, keeps mines with peak employment **≥ 50** (the size
   filter — drops gravel pits; tune with `-t`). ~2.3k kept.
3. Collapses `CURRENT_MINE_STATUS` to two buckets: `active` (Active,
   Intermittent, New Mine) / `retired` (everything else).
4. Categorizes `PRIMARY_SIC` into 8 commodity categories (keyword match; see
   `_CATEGORY_RULES`).
5. Writes a minimal GeoJSON FeatureCollection → gzipped (NO tippecanoe; owner
   rejected tiling — visible tile grid on zoom is jarring). Served lazy-loaded
   like other point layers (`LAZY_GEOJSON` in `assets/layers/layer-init.ts`).

## Frontend

- **One symbol layer** on one source: `mines-icons` (SVG icon per commodity
  category, z3+, overlap allowed; retired = dimmed). **Icon size scales with
  peak employment** (small/med/large buckets, same shape as `genIconSize`).
- Icons: `MINE_ICON_DEFS` / `loadMineIcons` in `assets/icons.ts`
  (ingot/nut/gear/battery/bolt/gem/bricks/pickaxe). Category logic:
  `src/colors/minerals.ts`.
- Two legend chip filters (commodity `k`, status `d`) — `applyMinesFilter` in
  `assets/filters.ts` combines them (AND). URL-persisted.
- Popup: `assets/popup-format.ts`; search: `assets/ui/ui-search.ts`.

## Fields kept

| Column | Notes |
|--------|-------|
| name | Mine name. Popup title + search. |
| status | `active` \| `retired`. |
| cat | Commodity category id (precious/base/ferroalloy/battery/energy/gem/industrial/other). |
| commodity | Human PRIMARY_SIC string. |
| operator | Current operator name. |
| employees | Peak quarterly avg employment (size signal). |
| state | State abbreviation. |

## Caveats

- **Filtered subset** (large mines only) — labeled "✂️ Filtered" in the panel,
  not the full MSHA dataset. Includes previously-large retired mines
  (deliberate: they mark brownfield / interconnection / pumped-storage sites).
- Commodity category is keyword-derived from SIC text — coarse but adequate.
