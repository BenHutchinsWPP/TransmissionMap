# Tribal Lands (BIA AIAN-LAR)

American Indian and Alaska Native Land Area Representation (AIAN-LAR) from the Bureau of Indian Affairs (BIA).

## Source

| | |
|---|---|
| **Provider** | [Bureau of Indian Affairs (BIA)](https://onemap-bia-geospatial.hub.arcgis.com/) |
| **Dataset** | AIAN-LAR (American Indian and Alaska Native Land Area Representation) |
| **Download** | [FeatureServer layer 0](https://biamaps.geoplatform.gov/server/rest/services/DivLTR/BIA_AIAN_National_LAR/FeatureServer/0) — query with `f=geojson`. Same server also answers as `biamaps.doi.gov`. Services Directory HTML is disabled; use `?f=pjson` or the AGOL item |
| **ArcGIS item** | [`e21128c26386412ca682accf7a57361a`](https://www.arcgis.com/home/item.html?id=e21128c26386412ca682accf7a57361a) — AGOL registration of the MapServer twin of the same service |
| **Browse** | [BIA Tract Viewer](https://biamaps.geoplatform.gov/biatracts/) — official BIA web map with AIAN-LAR as a selectable layer |
| **License** | Public domain |
| **Attribution** | "Bureau of Indian Affairs - Branch of Geospatial Support" |
| **Served** | `data/layers/bia_tribal_lands.geojson.gz` — lazy GeoJSON (full geometry; features copyable in the UI) |
| **Built by** | `extract_bia_tribal.py` → `data/build/bia_tribal_lands.{geojson,shp}` |
| **Raw input** | `data/raw/bia/bia_aian_national_lar.geojson` |

> This dataset is provided as an alternative or complement to the Census TIGER Tribal lands layer. It is the authoritative federal mapping standard used by the BIA.

## Download pack

`bia-tribal-lands.zip` — `bia-tribal-lands.geojson` · `bia-tribal-lands.csv` · `bia-tribal-lands.md` · `disclaimer.txt`
`bia-tribal-lands-shp.zip` — `bia-tribal-lands.shp` · `bia-tribal-lands.csv` · `bia-tribal-lands.md` · `disclaimer.txt`

## Processing

- **Selected:** all AIAN-LAR areas
- **Row filter:** none
- **Reprojected:** to EPSG:4326
- **Columns trimmed:** kept `LARNAME`, `AGENCY`

## Fields

| Field | Description |
|---|---|
| `LARNAME` | Name of the land area representation |
| `AGENCY` | BIA Agency responsible for the area |

## Caveats

- **Schema drift:** our raw pull (335 features) kept `LARNAME` + `AGENCY`. The live
  service (verified 2026-07-09, still 335 features) no longer has `AGENCY` — fields are
  now `LARNAME, LARID, CLASSIFICATION, GISACRES, REGION`. A re-pull will silently drop
  `AGENCY` from the extract; update the columns above and any popup usage if refreshing.
- **Boundary for illustrative purposes. Does not constitute legal jurisdiction or land title.**
- Do not use for land-tenure, jurisdiction, or sovereignty determinations without direct Tribal consultation.
