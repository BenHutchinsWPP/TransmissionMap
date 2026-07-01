# HIFLD Substations

HIFLD electric substations (US, ≥69 kV).

## Source

| | |
|---|---|
| **Provider** | DHS / CISA — Homeland Infrastructure Foundation-Level Data (HIFLD) |
| **Origin** | Oak Ridge NL (ORNL), Los Alamos NL (LANL), Idaho NL (INL), NGA |
| **License** | Public domain — US federal work, [17 U.S.C. § 105](https://www.law.cornell.edu/uscode/text/17/105) |
| **Attribution** | "HIFLD / DHS CISA" |
| **Download origin** | ArcGIS Online item [`ef04dc82…`](https://www.arcgis.com/home/item.html?id=ef04dc8231c9491e804a008e5faa7d3a) → FeatureServer |
| **Acquired** | 2026-05-28 |
| **Served** | `data/layers/hifld_substations.geojson.gz` — gzipped GeoJSON |
| **Built by** | `extract_hifld_substations.py` → `data/build/substation_hifld.csv` |

> The HIFLD Open portal closed September 16, 2025. This layer is sourced from the live
> HIFLD FeatureServer, with the ArcGIS item metadata and ANL GEM as corroborating references.

## Download pack

`hifld-substations.zip` — `hifld-substations.geojson` · `hifld-substations.csv` · `hifld-substations.md` · `disclaimer.txt`

## Processing

- **Source rows:** ~78,000 raw records
- **Row filter:** `TAP` / `DEADEND` / `RISER` / pure-numeric placeholder names are
  **stripped** → ~55,000 output rows
- **Computed:** `kv_range` bucket from `max_kv`; centroid lon/lat in the CSV
- **Display filter:** ~70% carry HIFLD's `UNKNOWN######` placeholder name and are filtered
  out for display
- **Columns kept:** `hifld_id`, `name`, `max_kv`, `min_kv`, `kv_range`

## Fields

_Fill rates approximate, from the 2026-05-28 HIFLD FeatureServer acquisition._

| Field | % filled | Example values |
|---|---:|---|
| `hifld_id` | 100% | `303622` |
| `name` | ~30% | "Canadaville", "Barton", "White Rapids Hy" — 70% carry the `UNKNOWN######` placeholder |
| `max_kv` | ~73% | 128.0, 161.0, 230.0, 500.0 |
| `min_kv` | ~62% | 38.0, 128.0, 161.0 |
| `kv_range` | 100% | `100-200` (22k), `unknown` (15k), `50-100` (12k), `200-300` (3.9k), `300-400` (1.5k), `0-50` (611), `500-600` (461), `600+` (36) |

## Caveats

- Validation dates run through June 2021.
- Sourced from the live HIFLD FeatureServer, corroborated by the ArcGIS item metadata
  and ANL GEM.
