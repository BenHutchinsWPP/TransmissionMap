// ─── Area filter: one region choice for the whole map ────────────────────────
// Role: the view's `area` ({kind, codes}: "only what is in Texas / ERCOT /
//       Bavaria"), and how it reaches each layer. Pure: no MapLibre, no state.
//         AreaKind / AreaFilter   the value; a kind is a region field name
//                                 (scripts/region_join.py REGION_FIELDS).
//         AREA_KIND_CODES         kind → its one-char code in the `af` param.
//         normalizeArea()         codes sorted and deduplicated, so equal
//                                 views give equal links.
//         areaCondition()         dataset + area → the Condition that dataset
//                                 filters by, 'all' (every feature is inside)
//                                 or {unfiltered: reason} (an i18n key).
//         areaFlag()              the panel-row note for a layer under an area
//                                 (an i18n key), or null.
//         ADMIN1_TO_STATE         a US admin-1 code → its state (the inverse of
//                                 STATE_TO_ADMIN1; also dataset-query.ts's
//                                 states alias on world layers).
//       A dataset filters by the area's own field when it carries it; a US state
//       reaches world layers through STATE_TO_ADMIN1, a US admin-1 code reaches
//       US layers through its inverse, and a country reaches US layers as 'all'
//       when it is USA. Anything else stays unfiltered, and its row says why.
//       assets/filters.ts compiles the Condition into the 4th part of
//       effectiveFilter(); view-validate.ts's validateArea() checks an untrusted
//       area against each kind's region FieldDef.
//
// Deps: field-schema.ts (FIELD_SCHEMA), region-codes.ts (STATE_TO_ADMIN1),
//       condition-compile.ts (Condition type), src/types.ts (LayerDef type).
// Consumed by: assets/filters.ts (areaExpr, setArea), assets/url-state-codec.ts
//       (`af`), view-validate.ts, assets/ui/panel-mirror.ts (the row flag),
//       assets/dataset-query.ts (areaCondition), assets/view-state.ts
//       (normalizeArea), assets/ui/ui-area.ts and assets/ui/area-labels.ts
//       (AREA_KINDS).

import { FIELD_SCHEMA } from './field-schema.js';
import { STATE_TO_ADMIN1 } from './region-codes.js';
import type { Condition } from './condition-compile.js';
import type { LayerDef } from '../types.js';

export type AreaKind = 'states' | 'counties' | 'ba' | 'nerc' | 'retail' | 'countries' | 'admin1';

export interface AreaFilter {
  kind: AreaKind;
  codes: string[];   // 1–MAX_LIST_VALUES codes of that kind, any-of
}

/** Kind → its code in the `af` param (`af=s.NM.TX`). */
export const AREA_KIND_CODES: Readonly<Record<AreaKind, string>> = {
  states: 's', counties: 'c', ba: 'b', nerc: 'n', retail: 'u', countries: 'k', admin1: 'a',
};
export const AREA_KINDS = Object.keys(AREA_KIND_CODES) as AreaKind[];

type AreaReason = 'area.reason.noField' | 'area.reason.usaLayer' | 'area.reason.linesNoRetail';
export type AreaResult = Condition | 'all' | { unfiltered: AreaReason };

export const normalizeArea = (a: AreaFilter): AreaFilter =>
  ({ kind: a.kind, codes: [...new Set(a.codes)].sort() });

/** A US admin-1 code → its USPS state code (STATE_TO_ADMIN1 inverted); no entry for any other admin-1. */
export const ADMIN1_TO_STATE: Readonly<Record<string, string>> =
  Object.fromEntries(Object.entries(STATE_TO_ADMIN1).map(([s, a]) => [a, s]));

const anyOf = (field: string, codes: string[]): Condition => ({ field, op: 'contains_any', value: codes });

/** How `area` reaches `dataset` (a FIELD_SCHEMA key, or undefined for a layer
 *  without one). */
export function areaCondition(dataset: string | undefined, area: AreaFilter): AreaResult {
  const schema = dataset && Object.hasOwn(FIELD_SCHEMA, dataset) ? FIELD_SCHEMA[dataset] : undefined;
  if (!schema || !Object.values(schema).some(d => d.list)) return { unfiltered: 'area.reason.noField' };
  const has = (f: string) => Object.hasOwn(schema, f);
  if (has(area.kind)) return anyOf(area.kind, area.codes);

  if (area.kind === 'states' && has('admin1')) {
    return anyOf('admin1', area.codes.map(c => Object.hasOwn(STATE_TO_ADMIN1, c) ? STATE_TO_ADMIN1[c] : c));
  }
  if (area.kind === 'admin1' && has('states')) {
    const states = area.codes.flatMap(c => c === 'none' ? ['none'] : Object.hasOwn(ADMIN1_TO_STATE, c) ? [ADMIN1_TO_STATE[c]] : []);
    return states.length ? anyOf('states', states) : { unfiltered: 'area.reason.usaLayer' };
  }
  if (area.kind === 'countries' && has('states')) {
    return area.codes.includes('USA') ? 'all' : { unfiltered: 'area.reason.usaLayer' };
  }
  if (area.kind === 'retail') return { unfiltered: 'area.reason.linesNoRetail' };
  return { unfiltered: 'area.reason.noField' };
}

// Rows without a `data` declaration that draw a raster (raster rows carry no note).
const RASTER_ROWS = new Set(['nexrad-radar', 'weather-live']);
// NERC regions EIA does not file plants under (its region list predates them).
const EIA_NERC_MISSING = new Set(['SPP', 'FRCC']);

/** The note a visible layer's panel row carries under `area`, as an i18n key,
 *  or null for none: why the area does not reach it (`area.reason.*`), that its
 *  clusters count every feature (`area.clustersUnfiltered`), or that EIA files
 *  the chosen NERC region's plants elsewhere (`area.nercVintage`). Raster rows
 *  never carry one. `mode` is the layer's display mode (state.genMode). */
export function areaFlag(
  layer: Pick<LayerDef, 'id' | 'dataset' | 'data'>, area: AreaFilter | null, mode?: string,
): string | null {
  if (!area || layer.data?.kind === 'raster' || RASTER_ROWS.has(layer.id)) return null;
  const r = areaCondition(layer.dataset, area);
  if (typeof r === 'object' && 'unfiltered' in r) return r.unfiltered;
  if (layer.id === 'osm-datacenters' && mode === 'clusters') return 'area.clustersUnfiltered';
  if (layer.dataset === 'eia_generators' && area.kind === 'nerc' && area.codes.some(c => EIA_NERC_MISSING.has(c))) {
    return 'area.nercVintage';
  }
  return null;
}
