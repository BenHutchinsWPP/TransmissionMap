// Mine commodity categories + status buckets for the MSHA Large Mines layer.
// The extract script (scripts/extract_mines.py) pre-computes each mine's `cat`
// (commodity category) and `status` (active|retired), so matching here is a
// simple property equality — no runtime code-list parsing.
// Used by: assets/filters.ts (applyMinesFilter), assets/ui/ui-legends.ts
//          (LEGEND_FILTERS chips), assets/layers/map-layers-mines.ts (colors).
import type { BucketDef } from '../types.js';
import type { ExpressionSpecification } from 'maplibre-gl';

// Commodity category buckets. `id` matches the `cat` property in the data and
// the emoji icon name (mine-<id>) in assets/icons.ts.
export const MINES_COMMODITY_BUCKETS: BucketDef[] = [
  { id: "precious",   label: "Precious (Au, Ag, PGE)", color: "#d4af37", urlCode: "p", icon: "mine-precious" },
  { id: "base",       label: "Base metals (Cu, Pb, Zn, Ni, Sn)", color: "#b87333", urlCode: "b", icon: "mine-base" },
  { id: "ferroalloy", label: "Iron & ferroalloy (Fe, Mn, Cr, Mo, W, Ti)", color: "#708090", urlCode: "f", icon: "mine-ferroalloy" },
  { id: "battery",    label: "Battery & critical (Li, REE, graphite…)", color: "#22c55e", urlCode: "c", icon: "mine-battery" },
  { id: "energy",     label: "Energy (coal, U, oil, gas)", color: "#ef4444", urlCode: "e", icon: "mine-energy" },
  { id: "gem",        label: "Gemstones", color: "#a855f7", urlCode: "g", icon: "mine-gem" },
  { id: "industrial", label: "Industrial & construction", color: "#9ca3af", urlCode: "i", icon: "mine-industrial" },
  { id: "other",      label: "Other", color: "#6b7280", urlCode: "o", icon: "mine-other" },
];

// Status buckets — the extract collapses MSHA statuses to two.
export const MINES_STATUS_BUCKETS: BucketDef[] = [
  { id: "active",  label: "Active", color: "#16a34a", urlCode: "1" },
  { id: "retired", label: "Retired / idled", color: "#d97706", urlCode: "2" },
];

// Exact match on the `cat` / `status` fields — bucket id IS the field value.
export const MINES_COMMODITY_MAP: Record<string, string[]> = Object.fromEntries(
  MINES_COMMODITY_BUCKETS.map(b => [b.id, [b.id]]));
export const MINES_STATUS_MAP: Record<string, string[]> = Object.fromEntries(
  MINES_STATUS_BUCKETS.map(b => [b.id, [b.id]]));

// Icon name per category — see MINE_ICON_DEFS in assets/icons.ts.
export function minesIconExpr(): ExpressionSpecification {
  return ["concat", "mine-", ["coalesce", ["get", "cat"], "other"]] as unknown as ExpressionSpecification;
}
