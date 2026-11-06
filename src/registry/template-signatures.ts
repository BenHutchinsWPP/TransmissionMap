// ─── Template signatures: what each visualization archetype needs ────────────
// Role: the visualization archetypes
//       as role signatures, and fit(), which says whether a layer's roles
//       (field-roles.ts rolesOf) can fill one. A template binds to the slots,
//       never to field names; the gallery's forms and the tool's refusal hints
//       list the fields slotFields() offers.
//         slots     one distinct field per slot:
//                     C   a category, or a field with a legend facet (kV class)
//                     R   a region list
//                     CR  either
//                     M   a measure
//                     MT  a measure or a time field
//                     T   a time field
//         geometry  the layer geometries the archetype draws (absent: any)
//         second    a second queryable layer it needs: a point layer or a
//                   polygon layer
//         regions   the region fields (names) its R slot takes: a layer with none of
//                   them does not fit (pies-per-region draws countries, states and
//                   admin-1 outlines only)
//         derived   length_km / area_km2 fill its M / MT slot too
//                   (distribution bins them); count never does
//       Derived measures fill no other slot: every layer has count, so a
//       measure is optional wherever the design says M?.
//
// Deps: field-roles.ts (types only). Pure data and one matcher.

import type { Geometry, RoleField, Roles } from './field-roles.js';

export type Slot = 'C' | 'R' | 'CR' | 'M' | 'MT' | 'T';

export interface Signature {
  id: string;
  renderer: 'vega' | 'html';
  slots: Slot[];
  geometry?: Geometry[];
  second?: 'point' | 'polygon';
  regions?: readonly string[];
  derived?: true;
}

export const TEMPLATE_SIGNATURES: Signature[] = [
  { id: 'composition',        renderer: 'vega', slots: ['C'] },
  { id: 'ranking',            renderer: 'vega', slots: ['CR'] },
  { id: 'distribution',       renderer: 'vega', slots: ['MT'], derived: true },
  { id: 'timeline',           renderer: 'vega', slots: ['T'] },
  { id: 'buildout-map',       renderer: 'html', slots: ['T'], geometry: ['point'] },
  { id: 'flow',               renderer: 'html', slots: ['C', 'CR'] },
  { id: 'hierarchy',          renderer: 'html', slots: ['CR', 'C'] },
  { id: 'density',            renderer: 'html', slots: [], geometry: ['point', 'polygon'] },
  { id: 'lines-by-class',     renderer: 'html', slots: ['C'], geometry: ['line'] },
  { id: 'scatter',            renderer: 'vega', slots: ['MT', 'MT'] },
  { id: 'compare-regions',    renderer: 'vega', slots: ['R', 'C'] },
  { id: 'points-per-polygon', renderer: 'html', slots: ['R'] },
  { id: 'pies-per-region',   renderer: 'html', slots: ['R', 'C'], regions: ['states', 'countries', 'admin1'] },
  { id: 'nearest',            renderer: 'html', slots: [], geometry: ['point'], second: 'point' },
  { id: 'crossings',          renderer: 'html', slots: [], geometry: ['line'], second: 'polygon' },
];

const isC = (f: RoleField) => f.role === 'category' || !!f.facet;
const SLOT_TEST: Record<Slot, (f: RoleField) => boolean> = {
  C: isC,
  R: f => f.role === 'region',
  CR: f => isC(f) || f.role === 'region',
  M: f => f.role === 'measure',
  MT: f => f.role === 'measure' || f.role === 'time',
  T: f => f.role === 'time',
};

/** The fields of `fields` that can fill `slot`. */
export function slotFields(slot: Slot, fields: readonly RoleField[]): RoleField[] {
  return fields.filter(SLOT_TEST[slot]);
}

// One distinct field per slot (backtracking over a handful of fields).
function fillSlots(slots: readonly Slot[], fields: readonly RoleField[], used = new Set<string>()): boolean {
  if (!slots.length) return true;
  for (const f of slotFields(slots[0], fields)) {
    if (used.has(f.name)) continue;
    used.add(f.name);
    if (fillSlots(slots.slice(1), fields, used)) return true;
    used.delete(f.name);
  }
  return false;
}

/** Whether `roles` fits `sig`: 'fits' with its readable fields, 'pending'
 *  only once its pending fields are readable, 'no' when the geometry or a
 *  slot can never be met. `others` are the other queryable layers' roles,
 *  for an archetype that needs a second layer. */
export function fit(sig: Signature, roles: Roles, others: readonly Roles[]): 'fits' | 'pending' | 'no' {
  if (sig.geometry && !sig.geometry.includes(roles.geometry)) return 'no';
  if (sig.second) {
    const ok = others.some(o => o.layerId !== roles.layerId && o.geometry === sig.second);
    if (!ok) return 'no';
  }
  const live = roles.fields.filter(f => f.role !== 'id' && f.role !== 'label');
  if (sig.regions && !live.some(f => f.role === 'region' && sig.regions!.includes(f.name))) return 'no';
  if (sig.derived) live.push(...roles.derived.filter(d => d !== 'count').map(name => ({ name, role: 'measure' as const })));
  if (fillSlots(sig.slots, live)) return 'fits';
  return fillSlots(sig.slots, [...live, ...roles.pending]) ? 'pending' : 'no';
}
