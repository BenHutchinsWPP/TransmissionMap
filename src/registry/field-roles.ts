// ─── Field roles: what each queryable layer's fields mean ────────────────────
// Role: lets a visualization template bind to roles ("a category", "a measure
//       in MW", "a year") instead of field names. FIELD_SCHEMA carries the
//       role of every schema field (role, unit, additive, time); this file
//       holds, per queryable registry layer, what a schema entry has no place
//       for:
//         geometry  point | line | polygon — which derived measures exist
//                   (count always; length_km for lines; area_km2 for polygons);
//         label     the field naming one feature (a display field, or the id
//                   column when the layer has no name);
//         display   the role of each assets/dataset-query.ts DISPLAY_FIELDS
//                   name that is not a schema field (category or label);
//         facets    field → legend facet (src/colors/facets.ts) whose bucket
//                   colours and labels a chart of that field uses;
//         pending   fields in the served data that no schema or display entry
//                   lets a row read yet, with the role they would take: what
//                   docs/templates-coverage.md counts as "needs fields".
//       rolesOf(layerId) merges both into one list in allowedFields() order.
//       aliasFields(roles) the fields a template may group by beyond those:
//       `states` on a world layer, from its US admin-1 tags.
//       field-roles.test.ts holds the annotations to DISPLAY_FIELDS, FACETS and
//       the registry, and writes docs/templates-coverage.md.
//
// Deps: field-schema.ts (FIELD_SCHEMA, FieldRole), index.ts (layerById).
//       Pure data and lookups; no MapLibre, no state.

import { FIELD_SCHEMA, type FieldRole } from './field-schema.js';
import { layerById } from './index.js';

export type Geometry = 'point' | 'line' | 'polygon';
export type DerivedMeasure = 'count' | 'length_km' | 'area_km2';

interface PendingField { role: FieldRole; unit?: string; facet?: string }

interface LayerRoles {
  geometry: Geometry;
  label: string;
  display: Record<string, 'category' | 'label'>;
  facets?: Record<string, string>;
  pending?: Record<string, PendingField>;
}

const KV = { facets: { nominal_kv: 'kv' } };
const OSM_NAMED = { name: 'label', operator: 'category' } as const;
const FUEL = { source: 'fuel' };

// Every registry layer with a `dataset` needs an entry (field-roles.test.ts).
export const FIELD_ROLES: Record<string, LayerRoles> = {
  'eia-generators': {
    geometry: 'point', label: 'plant_name',
    display: { plant_name: 'label', technology: 'category', state: 'category', ba_code: 'category', utility_name: 'category' },
    facets: { energy_source: 'fuel', sector_name: 'sector' },
  },
  'osm-plants-points': { geometry: 'point', label: 'name', display: OSM_NAMED, facets: FUEL },
  'osm-plants-polygons': { geometry: 'polygon', label: 'name', display: OSM_NAMED, facets: FUEL },
  'osm-generators': { geometry: 'point', label: 'name', display: OSM_NAMED, facets: FUEL },
  'osm-substations-points': { geometry: 'point', label: 'name', display: { ...OSM_NAMED, sub_type: 'category' }, ...KV },
  'osm-substations-polygons': { geometry: 'polygon', label: 'name', display: { ...OSM_NAMED, sub_type: 'category' }, ...KV },
  'hifld-substations': { geometry: 'point', label: 'name', display: { name: 'label' }, facets: { max_kv: 'kv' } },
  'osm-transmission-lines': { geometry: 'line', label: 'name', display: OSM_NAMED, ...KV },
  'hifld-transmission-lines': { geometry: 'line', label: 'ID', display: { OWNER: 'category' }, facets: { VOLTAGE: 'kv' } },
  'ogf-planned-transmission': {
    geometry: 'line', label: 'Project',
    display: { Project: 'label', Owner: 'category', FromSub: 'category', ToSub: 'category', StatesFull: 'category' },
    facets: { Status: 'ogfStatus', Work: 'ogfWork', Region: 'ogfRegion' },
  },
  'westtec-10yr': {
    geometry: 'line', label: 'name', display: { name: 'label' },
    facets: { scenario: 'westtecScenario', dataset: 'westtecDataset' },
  },
  'osm-pipelines-lines': { geometry: 'line', label: 'name', display: OSM_NAMED, facets: { substance: 'substance' } },
  'osm-pipelines-points': {
    geometry: 'point', label: 'fid', display: { pipeline: 'category', operator: 'category' },
    facets: { pipeline: 'pipeline' },
  },
  'hifld-natgas-lines': {
    geometry: 'line', label: 'name', display: OSM_NAMED, facets: { pipe_type: 'natgasLine' },
  },
  'railroads': { geometry: 'line', label: 'RROWNER1', display: {} },
  'hifld-natgas-points': {
    geometry: 'point', label: 'name', display: { ...OSM_NAMED, state: 'category' }, facets: { fac_type: 'natgasPts' },
  },
  'nrel-hydrothermal-points': {
    geometry: 'point', label: 'name', display: { name: 'label', state: 'category', county: 'category' },
  },
  'mines': {
    geometry: 'point', label: 'name',
    display: { name: 'label', commodity: 'category', operator: 'category', state: 'category' },
    facets: { cat: 'mines', status: 'minesStatus' },
  },
  'osm-datacenters': {
    geometry: 'point', label: 'name',
    display: { ...OSM_NAMED, addr_city: 'category', addr_state: 'category' },
  },
  'nerc-regions': {
    geometry: 'polygon', label: 'sub_nm', display: { region: 'category', sub_nm: 'label', state: 'category' },
    facets: { code: 'nerc' },
  },
  'control-areas': { geometry: 'polygon', label: 'name', display: { name: 'label', state: 'category' } },
  'us-counties': { geometry: 'polygon', label: 'NAME', display: { NAME: 'label' } },
  'us-zcta': { geometry: 'polygon', label: 'zcta5', display: {} },
  'bia-tribal-lands': { geometry: 'polygon', label: 'LARNAME', display: { LARNAME: 'label' } },
  'wecc-paths': { geometry: 'point', label: 'name', display: { name: 'label' } },
  'boem-wind-leases': { geometry: 'polygon', label: 'lease', display: { lease: 'label', project: 'category' } },
  'us-states': { geometry: 'polygon', label: 'name', display: {} },
  'countries': { geometry: 'polygon', label: 'name', display: {} },
  'admin1': { geometry: 'polygon', label: 'name', display: { name: 'label' } },
  'tribal-lands': { geometry: 'polygon', label: 'name', display: { name: 'label' }, facets: { area_type: 'tribal' } },
  'eia-ba': { geometry: 'polygon', label: 'name', display: { name: 'label' } },
  'retail-territories': {
    geometry: 'polygon', label: 'name', display: { name: 'label', state: 'category' }, facets: { type: 'retail' },
  },
  'padus': { geometry: 'polygon', label: 'name', display: { name: 'label' }, facets: { desig: 'padus' } },
  'crithab': {
    geometry: 'polygon', label: 'comname', display: { comname: 'label', sciname: 'category' },
    facets: { listing_st: 'crithab' },
  },
  'dc-moratoriums': {
    // Points (towns, cities) and polygons (states, counties, utility areas) in
    // one file, two thirds points: a jurisdiction is read at its centre.
    geometry: 'point', label: 'name', display: { name: 'label' }, facets: { cls: 'dcm' },
  },
};

export interface RoleField {
  name: string;
  role: FieldRole;
  unit?: string;
  additive?: false;
  time?: 'year' | 'date';
  facet?: string;
}

export interface Roles {
  layerId: string;
  geometry: Geometry;
  label: string;
  fields: RoleField[];
  derived: DerivedMeasure[];
  pending: RoleField[];
}

/** The US `states` a world layer (admin1 tags, no states field) is grouped by, read from its US
 *  admin-1 codes (area-filter.ts ADMIN1_TO_STATE; dataset-query.ts shapeRows): [] on any other layer. */
export function aliasFields(roles: Roles): RoleField[] {
  const has = (n: string) => roles.fields.some(f => f.name === n);
  return has('admin1') && !has('states') ? [{ name: 'states', role: 'region' }] : [];
}

const DERIVED: Record<Geometry, DerivedMeasure[]> = {
  point: ['count'], line: ['count', 'length_km'], polygon: ['count', 'area_km2'],
};

/** The roles of `layerId`'s readable fields (schema fields, then display
 *  fields, then the id column when it is a property), its geometry, label and
 *  derived measures; null for a layer with no FIELD_ROLES entry or schema. */
export function rolesOf(layerId: string): Roles | null {
  const r = Object.hasOwn(FIELD_ROLES, layerId) ? FIELD_ROLES[layerId] : undefined;
  const entry = layerById(layerId);
  const schema = entry?.dataset && Object.hasOwn(FIELD_SCHEMA, entry.dataset) ? FIELD_SCHEMA[entry.dataset] : undefined;
  if (!r || !schema || !entry?.data?.id) return null;
  const facet = (name: string) => r.facets?.[name];
  const fields: RoleField[] = Object.entries(schema).map(([name, d]) => ({
    name, role: d.role ?? (d.list ? 'region' : d.type === 'number' ? 'measure' : 'category'),
    ...(d.unit && { unit: d.unit }), ...(d.additive === false && { additive: false as const }),
    ...(d.time && { time: d.time }), ...(facet(name) && { facet: facet(name) }),
  }));
  for (const [name, role] of Object.entries(r.display)) {
    if (!Object.hasOwn(schema, name)) fields.push({ name, role, ...(facet(name) && { facet: facet(name) }) });
  }
  const id = entry.data.id;
  if (!id.native && !fields.some(f => f.name === id.field)) fields.push({ name: id.field, role: 'id' });
  const pending = Object.entries(r.pending ?? {}).map(([name, p]) => ({ name, ...p }));
  return { layerId, geometry: r.geometry, label: r.label, fields, derived: DERIVED[r.geometry], pending };
}
