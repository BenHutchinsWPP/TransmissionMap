# EIA Balancing Authorities

Polygon boundaries of the 85 balancing authorities and connected-operator areas serving the US and adjacent interconnected Canadian and Mexican territories, with footprint area.

## Source

| | |
|---|---|
| **Provider** | U.S. Energy Information Administration (EIA) |
| **Item page** | [ArcGIS Online](https://www.arcgis.com/home/item.html?id=b1aa4dff71ca4e5aab1787a8a7568e33) |
| **Feature service** | https://services5.arcgis.com/bsqU0jSPAuI04L89/arcgis/rest/services/Balancing_Authorities/FeatureServer/0 (layer: `ctl_area_region`) |
| **License** | Public domain — US federal work, [17 U.S.C. § 105](https://www.law.cornell.edu/uscode/text/17/105). The ArcGIS item page carries no license statement, but the dataset is EIA's own, published through the [EIA Atlas](https://atlas.eia.gov/). |
| **Attribution** | "U.S. Energy Information Administration" |
| **Served** | `data/layers/eia_ba.geojson.gz` (~830 KB, gzipped GeoJSON, `simplify: 0.001`, `precision: 5`) — 85 features covering the US plus adjacent interconnected Canadian and Mexican balancing authorities (e.g. AESO, Alberta Electric System Operator). |
| **Built by** | `scripts/extract_eia_ba.py` → `data/build/eia_ba.gpkg` + `eia_ba.csv` |

## Download pack

Two polygon packs (GeoJSON and SHP formats), each holding geometry plus attributes:

- `eia-ba.zip` (GeoJSON) — `eia-ba.geojson` + `eia-ba.csv`
- `eia-ba-shp.zip` (SHP) — shapefile set (`.shp/.shx/.dbf/.prj/.cpg`) + `eia-ba.csv`

Both also include `eia-ba.txt` (this doc) and `disclaimer.txt`. The attribute CSV carries no
geometry — it's a tabular preview.

## Fields

| Field | % filled | Example values | Notes |
|---|---|---|---|
| `name` | 100% | `Alberta Electric System Operator`, `PJM Interconnection` | Balancing authority name |
| `abbrev` | 100% | `AESO`, `PJM`, `CISO` | Standard abbreviation |
| `area_sqmi` | 100% | `218558` (PJM), `135626` (CISO) | Polygon footprint area in square miles |
| `color` | 100% | `#2563eb`, `#f97316` | Per-area fill color from a 12-hue palette, assigned by greedy graph coloring so no two areas within ~65 km share one (10 of the 12 are used). Cartographic only, no semantic meaning |

## Caveats

- **Vintage unspecified.** The item page does not state a snapshot date, so treat the boundaries as approximate rather than current.
- **Net generation is not served.** The upstream service carries `NETGENMWH` / `NETGENRNG` columns, but they are an undated snapshot, so `scripts/extract_eia_ba.py` drops them. Pull them from the feature service directly if you need them.
- **Simplified geometry.** Boundaries are simplified for web display (`simplify: 0.001`) and are not survey-grade or regulatory boundaries. Coarser simplification collapses a small ring below four points and tears the fill, so 0.001 is the floor for this layer.
- **Upstream rings are repaired.** Twenty of the 85 source polygons carry self-intersections, nested shells or degenerate rings; `scripts/extract_eia_ba.py` runs `make_valid` and keeps the polygonal parts, otherwise the fills triangulate into fragments.
- **Boundary differences vs. HIFLD.** The HIFLD `control-areas` layer covers similar territory but is from a different vintage and generalization. The two datasets will not align exactly. Both are available on the map; refer to the companion [HIFLD Regions](hifld-regions.md) doc for HIFLD's coverage and methods.
