// Voltage color expression — shared by lines, substation points + polygons.
// Applied to: voltage_kv (lines), nominal_kv (OSM subs), max_kv (HIFLD subs).
// Null → treated as 0 → lavender fallback via nullColor.
import type { ExpressionSpecification } from 'maplibre-gl';
export function voltageColorExpr(field: string, nullColor: string): ExpressionSpecification {
  const kv = ["to-number", ["get", field], 0];
  return [
    "case",
    [">=", kv, 550], "#f97316",  // ≥550 kV  bold orange
    [">=", kv, 500], "#ef4444",  // 500-549  red
    [">=", kv, 300], "#22c55e",  // 300-499  green
    [">=", kv, 200], "#3b82f6",  // 200-299  blue
    [">=", kv, 100], "#ec4899",  // 100-199  pink
    [">=", kv,   1], "#eab308",  // 1-99     yellow
    nullColor || "#f5f0e8"       // 0/null   warm white/cream
  ] as unknown as ExpressionSpecification;
}
