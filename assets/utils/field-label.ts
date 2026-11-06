// ─── Field labels ─────────────────────────────────────────────────────────────
// humanise(field): snake_case → "Words", a trailing unit token as "(MW)".
// Boot-safe (imports nothing): panel-mirror.ts labels the layer-row filter chip
// with it; chart-spec.ts re-exports it for charts and templates/show-template.ts.

const UNIT_TOKENS: Record<string, string> = { mw: 'MW', kv: 'kV', mwh: 'MWh', km: 'km', pct: '%' };

/** Fields whose snake_case words would not read well. */
const FIELD_WORDS: Record<string, string> = {
  im3_sqft: 'Floor area (sq ft)', ba: 'Balancing authority', ba_code: 'Balancing authority', nerc: 'NERC region',
  op_year: 'Operating year', retirement_year: 'Retirement year', id: 'ID', fid: 'ID', sub_type: 'Substation type',
  gen_status: 'Generator status', prime_mover: 'Prime mover', addr_state: 'State', addr_city: 'City',
};
/** Acronyms inside a longer field name. */
const ACRONYMS: Record<string, string> = { eia: 'EIA', osm: 'OSM', hifld: 'HIFLD', us: 'US', id: 'ID', nerc: 'NERC' };

/** snake_case → "Words", a trailing unit token as "(MW)". */
export function humanise(field: string): string {
  if (FIELD_WORDS[field]) return FIELD_WORDS[field];
  const parts = field.split('_').filter(Boolean);
  const unit = parts.length > 1 ? UNIT_TOKENS[parts[parts.length - 1].toLowerCase()] : undefined;
  if (unit) parts.pop();
  const words = parts.map(w => ACRONYMS[w.toLowerCase()] ?? w).join(' ');
  return (words.charAt(0).toUpperCase() + words.slice(1) + (unit ? ` (${unit})` : '')) || field;
}
