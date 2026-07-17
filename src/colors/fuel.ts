// Generator icon expressions, fuel color expressions, and legend entries.
import type { ExpressionSpecification } from 'maplibre-gl';
import type { FuelEntry } from '../types.js';

// ─── Generator icon-image expressions ─────────────────────────────────────────
export const OSM_GEN_ICON: ExpressionSpecification = [
  "match", ["get", "source"],
  "solar",       "gen-solar",
  "wind",        "gen-wind",
  "hydro",       "gen-hydro",
  "nuclear",     "gen-nuclear",
  "coal",        "gen-coal",
  "gas",         "gen-gas",
  "oil",         "gen-oil",
  "battery",     "gen-storage",
  "geothermal",  "gen-geo",
  "biomass",     "gen-biomass",
  "biogas",      "gen-biomass",
  "waste",       "gen-biomass",
  "diesel",      "gen-diesel",
  "gen-other"
] as unknown as ExpressionSpecification;

export const EIA_GEN_ICON: ExpressionSpecification = [
  // Pumped storage is hydro by fuel (WAT) but is really storage; flag it first.
  "case", ["==", ["get", "prime_mover"], "PS"], "gen-pumped-storage",
  ["match", ["get", "energy_source"],
  "SUN",                          "gen-solar",
  "WND",                          "gen-wind",
  "WAT",                          "gen-hydro",
  "NUC",                          "gen-nuclear",
  ["BIT", "SUB", "LIG", "PC"],   "gen-coal",
  ["NG", "OG"],                   "gen-gas",
  ["DFO", "RFO", "KER"],         "gen-oil",
  ["MWH", "ES"],                  "gen-storage",
  "GEO",                          "gen-geo",
  ["WDS", "WDL", "MSW", "BLQ"],  "gen-biomass",
  "gen-other"
]] as unknown as ExpressionSpecification;

export function genIconSize(mwField: string): ExpressionSpecification {
  const mw = ["coalesce", ["to-number", ["get", mwField]], 0];
  function mwBucket(sm: number, md: number, lg: number) {
    return ["case",
      [">=", mw, 1000], lg,
      [">=", mw,  100], md,
      sm
    ];
  }
  return ["interpolate", ["linear"], ["zoom"],
    4,  mwBucket(0.65, 0.90, 1.15),
    8,  mwBucket(0.85, 1.15, 1.50),
    12, mwBucket(1.10, 1.40, 1.90)
  ] as unknown as ExpressionSpecification;
}

// ─── Fuel color expressions ────────────────────────────────────────────────────
export const OSM_GEN_COLOR: ExpressionSpecification = [
  "match", ["get", "source"],
  "wind",        "#3b82f6",
  "solar",       "#fbbf24",
  "hydro",       "#06b6d4",
  "nuclear",     "#a855f7",
  "coal",        "#92400e",
  "gas",         "#ef4444",
  "oil",         "#b45309",
  "battery",     "#10b981",
  "geothermal",  "#f97316",
  "biomass",     "#84cc16",
  "biogas",      "#84cc16",
  "waste",       "#84cc16",
  "diesel",      "#6b7280",
  "#d1d5db"
] as unknown as ExpressionSpecification;

// PIPELINE_LINE_COLOR lives in buckets.ts (derived from SUBSTANCE_BUCKETS).

// ─── Legend entries ────────────────────────────────────────────────────────────
export const FUEL_LEGEND: FuelEntry[] = [
  { id: "wind",    urlCode: "w", label: "Wind",    color: "#3b82f6", icon: "gen-wind",    osmBucket: "wind",       eiaBucket: "wind"    },
  { id: "solar",   urlCode: "s", label: "Solar",   color: "#fbbf24", icon: "gen-solar",   osmBucket: "solar",      eiaBucket: "solar"   },
  { id: "hydro",   urlCode: "h", label: "Hydro",   color: "#06b6d4", icon: "gen-hydro",   osmBucket: "hydro",      eiaBucket: "hydro"   },
  { id: "pumped_storage", urlCode: "p", label: "Pumped Storage", color: "#2563eb", icon: "gen-pumped-storage", osmBucket: "pumped_storage", eiaBucket: "pumped_storage" },
  { id: "nuclear", urlCode: "n", label: "Nuclear", color: "#a855f7", icon: "gen-nuclear", osmBucket: "nuclear",    eiaBucket: "nuclear" },
  { id: "coal",    urlCode: "c", label: "Coal",    color: "#92400e", icon: "gen-coal",    osmBucket: "coal",       eiaBucket: "coal"    },
  { id: "gas",     urlCode: "g", label: "Gas",     color: "#ef4444", icon: "gen-gas",     osmBucket: "gas",        eiaBucket: "gas"     },
  { id: "oil",     urlCode: "o", label: "Oil",     color: "#b45309", icon: "gen-oil",     osmBucket: "oil",        eiaBucket: "oil"     },
  { id: "storage", urlCode: "b", label: "Storage", color: "#10b981", icon: "gen-storage", osmBucket: "battery",    eiaBucket: "storage" },
  { id: "geo",     urlCode: "e", label: "Geo",     color: "#f97316", icon: "gen-geo",     osmBucket: "geothermal", eiaBucket: "geo"     },
  { id: "biomass", urlCode: "i", label: "Biomass", color: "#84cc16", icon: "gen-biomass", osmBucket: "biomass",    eiaBucket: "biomass" },
  { id: "other",   urlCode: "x", label: "Other",   color: "#d1d5db", icon: "gen-other",   osmBucket: "other",      eiaBucket: "other"   },
];
