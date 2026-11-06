// Datasets that ship a columns-only Parquet (data/analysis/columns/, built by scripts/build_columns_parquet.py); dataset-query answers them for the whole dataset. Pure data, imports nothing.
export const COLUMNS_DATASETS = [
  "osm_transmission_lines",
  "hifld_transmission_lines",
  "osm_pipelines_lines",
  "hifld_natgas_lines",
  "osm_substations_points",
  "osm_substations_polygons",
  "osm_plants_polygons",
  "osm_generators",
  "retail_territories",
  "padus",
  "crithab",
] as const;
