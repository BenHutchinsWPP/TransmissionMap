// FUEL_LEGEND is the one fuel table: each fuel's legend row, its OSM `source`
// values and its EIA `energy_source` codes. The generator icon and colour match
// expressions and the OSM/EIA filter value maps are all derived from it, so a
// value with an icon is always a value the fuel filter classes.
// Deps: src/types.ts (FuelEntry). Consumers: src/colors/buckets.ts (fuel
// buckets), src/colors/facets.ts (the fuel facet), src/registry/field-schema.ts
// (value domains), assets/filters.ts, assets/layers/map-layers-{osm,eia}.ts.
import type { ExpressionSpecification } from 'maplibre-gl';
import type { FuelEntry } from '../types.js';

// ─── The fuel table ─────────────────────────────────────────────────────────
// Pumped storage has no OSM value and no EIA code of its own: EIA files it as
// WAT with prime_mover "PS" (see EIA_GEN_ICON and assets/filters.ts). "Other"
// lists nothing — it is every value no other fuel claims.
// OSM `diesel` is oil-fired generation (the pipeline's plant:source normaliser
// maps it to oil too), so it filters as Oil while keeping its own icon/colour.
export const FUEL_LEGEND: FuelEntry[] = [
  { id: "wind",    urlCode: "w", label: "Wind",    color: "#3b82f6", icon: "gen-wind",    osmBucket: "wind",       eiaBucket: "wind",
    osmValues: ["wind"],        eiaCodes: ["WND"] },
  { id: "solar",   urlCode: "s", label: "Solar",   color: "#fbbf24", icon: "gen-solar",   osmBucket: "solar",      eiaBucket: "solar",
    osmValues: ["solar"],       eiaCodes: ["SUN"] },
  { id: "hydro",   urlCode: "h", label: "Hydro",   color: "#06b6d4", icon: "gen-hydro",   osmBucket: "hydro",      eiaBucket: "hydro",
    osmValues: ["hydro"],       eiaCodes: ["WAT"] },
  { id: "pumped_storage", urlCode: "p", label: "Pumped Storage", color: "#2563eb", icon: "gen-pumped-storage", osmBucket: "pumped_storage", eiaBucket: "pumped_storage",
    osmValues: [],              eiaCodes: [] },
  { id: "nuclear", urlCode: "n", label: "Nuclear", color: "#a855f7", icon: "gen-nuclear", osmBucket: "nuclear",    eiaBucket: "nuclear",
    osmValues: ["nuclear"],     eiaCodes: ["NUC"] },
  { id: "coal",    urlCode: "c", label: "Coal",    color: "#92400e", icon: "gen-coal",    osmBucket: "coal",       eiaBucket: "coal",
    osmValues: ["coal"],        eiaCodes: ["BIT", "SUB", "LIG", "PC"] },
  { id: "gas",     urlCode: "g", label: "Gas",     color: "#ef4444", icon: "gen-gas",     osmBucket: "gas",        eiaBucket: "gas",
    osmValues: ["gas"],         eiaCodes: ["NG", "OG"] },
  { id: "oil",     urlCode: "o", label: "Oil",     color: "#b45309", icon: "gen-oil",     osmBucket: "oil",        eiaBucket: "oil",
    osmValues: ["oil", "diesel"], eiaCodes: ["DFO", "RFO", "KER"],
    osmStyle: { diesel: { icon: "gen-diesel", color: "#6b7280" } } },
  { id: "storage", urlCode: "b", label: "Storage", color: "#10b981", icon: "gen-storage", osmBucket: "battery",    eiaBucket: "storage",
    osmValues: ["battery"],     eiaCodes: ["MWH", "ES"] },
  { id: "geo",     urlCode: "e", label: "Geo",     color: "#f97316", icon: "gen-geo",     osmBucket: "geothermal", eiaBucket: "geo",
    osmValues: ["geothermal"],  eiaCodes: ["GEO"] },
  { id: "biomass", urlCode: "i", label: "Biomass", color: "#84cc16", icon: "gen-biomass", osmBucket: "biomass",    eiaBucket: "biomass",
    osmValues: ["biomass", "biogas", "waste"], eiaCodes: ["WDS", "WDL", "MSW", "BLQ"] },
  { id: "other",   urlCode: "x", label: "Other",   color: "#d1d5db", icon: "gen-other",   osmBucket: "other",      eiaBucket: "other",
    osmValues: [],              eiaCodes: [] },
];

const fuel = (id: string) => FUEL_LEGEND.find(f => f.id === id)!;
const OTHER = fuel("other");

// ─── Filter value maps (bucket id → feature values) ─────────────────────────
export const OSM_FUEL_MAP: Record<string, string[]> = Object.fromEntries(
  FUEL_LEGEND.filter(f => f.osmValues.length).map(f => [f.osmBucket, f.osmValues]));
export const EIA_FUEL_MAP: Record<string, string[]> = Object.fromEntries(
  FUEL_LEGEND.filter(f => f.eiaCodes.length).map(f => [f.eiaBucket, f.eiaCodes]));

// ─── Generator icon-image and colour expressions ────────────────────────────
function osmMatch(key: "icon" | "color"): ExpressionSpecification {
  const expr: unknown[] = ["match", ["get", "source"]];
  for (const f of FUEL_LEGEND) {
    const plain = f.osmValues.filter(v => !f.osmStyle?.[v]);
    if (plain.length) expr.push(plain.length === 1 ? plain[0] : plain, f[key]);
    for (const [v, style] of Object.entries(f.osmStyle ?? {})) expr.push(v, style[key]);
  }
  expr.push(OTHER[key]);
  return expr as unknown as ExpressionSpecification;
}

export const OSM_GEN_ICON = osmMatch("icon");
export const OSM_GEN_COLOR = osmMatch("color");

// Pumped storage is hydro by fuel (WAT) but is really storage; flag it first.
export const EIA_GEN_ICON: ExpressionSpecification = [
  "case", ["==", ["get", "prime_mover"], "PS"], fuel("pumped_storage").icon,
  ["match", ["get", "energy_source"],
    ...FUEL_LEGEND.filter(f => f.eiaCodes.length)
      .flatMap(f => [f.eiaCodes.length === 1 ? f.eiaCodes[0] : f.eiaCodes, f.icon]),
    OTHER.icon,
  ],
] as unknown as ExpressionSpecification;

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

// PIPELINE_LINE_COLOR lives in buckets.ts (derived from SUBSTANCE_BUCKETS).
