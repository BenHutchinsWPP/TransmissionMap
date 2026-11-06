// ─── Template catalogue: the page-owned visualization templates ──────────────
// Role: one record per visualization archetype
//       (src/registry/template-signatures.ts; ids permanent; a breaking param change bumps `version`):
//         kind       'vega' (a Vega-Lite spec built by page code) | 'html' (a
//                    page-owned script run in the canvas frame after kit.js)
//         signature  the role slots and geometry it needs
//                    (src/registry/template-signatures.ts)
//         params     which shared params it reads and how: `by` fills the
//                    signature's first C / R / CR slot, `time` its T slot,
//                    `measure` an additive measure or a derived one (count,
//                    length_km, area_km2) — or, `binned`, the field its rows
//                    are binned by (distribution); entries with extra params also list
//                    `split` (a second grouping field), `layer2` (+ where2)
//                    and `within`; `required` ones have no default
//         geometry   the features it needs beside the rows ('none' | 'point' |
//                    'full'), as dataset-query.ts shapeRows takes them
//         source     loads the template's code only when it is shown: vega → a
//                    builder module ((payload) → spec), html → the script text
//                    (`?raw`, its own lazy chunk; never model text)
//         nameKey    its i18n name (`template.<id>`)
//         libs       names from src/registry/template-libs.json it loads
//         ready      false: the archetype is catalogued but not built yet, and
//                    show-template.ts refuses it as "not available yet"
//       templatesFor(layerId) the ready templates whose signature the layer's
//       roles fit (registry data only, so the layer panel's Visualize menu item
//       can ask it from the boot bundle).
//       Pure data and lazy loaders; read by show-template.ts, the chat's
//       snapshot check, the layer rows (templatesFor), the Visualize pane
//       (ui-templates.ts) and (later) local phrases and the eval.
//
// Deps: src/registry/template-signatures.ts (TEMPLATE_SIGNATURES, fit),
//       field-roles.ts (rolesOf), registry (LAYERS), payload.ts (types);
//       vega/*.ts and html/*.js loaded on demand.

import { TEMPLATE_SIGNATURES, fit, type Signature, type Slot } from '../../src/registry/template-signatures.js';
import { rolesOf, type Roles } from '../../src/registry/field-roles.js';
import { LAYERS } from '../../src/registry/index.js';
import type { TemplatePayload } from './payload.js';

export type TemplateKind = 'vega' | 'html';
export type VegaBuilder = (p: TemplatePayload) => Record<string, unknown>;
export type TemplateSource =
  | { kind: 'vega'; load: () => Promise<VegaBuilder> }
  | { kind: 'html'; load: () => Promise<string> };

export interface ParamSpec {
  /** The slot a field param fills (by, split, time); measure takes measures and derived ones. */
  slot?: Slot;
  required: boolean;
  /** measure only: the field the rows are binned by (dataset-query.ts shapeSlots().bins — levels,
   *  length / area and time fields too, never count) instead of an amount to sum. */
  binned?: true;
}

export interface TemplateDef {
  id: string;
  kind: TemplateKind;
  version: number;
  signature: Signature;
  /** `split`: a second grouping field (≠ by); `layer2` (+ `where2`): a second, GeoJSON point layer;
   *  `within`: a distance threshold in km. A template takes only the params it lists. */
  params: {
    by?: ParamSpec; split?: ParamSpec; measure?: ParamSpec; time?: ParamSpec; top?: ParamSpec; mode?: ParamSpec;
    layer2?: ParamSpec; within?: ParamSpec;
  };
  geometry: 'none' | 'point' | 'full';
  nameKey: string;
  libs: string[];
  ready: boolean;
  source?: TemplateSource;
}

const sig = (id: string): Signature => {
  const s = TEMPLATE_SIGNATURES.find(x => x.id === id);
  if (!s) throw new Error(`no signature for template "${id}"`);
  return s;
};

const BY_SLOTS: readonly Slot[] = ['C', 'R', 'CR'];

/** The params a signature implies: its first C / R / CR slot is `by`, a T slot `time`, an M / MT slot or none `measure`. */
function paramsOf(s: Signature): TemplateDef['params'] {
  const by = s.slots.find(x => BY_SLOTS.includes(x));
  const p: TemplateDef['params'] = { measure: { required: false }, top: { required: false } };
  if (by) p.by = { slot: by, required: true };
  if (s.slots.includes('T')) p.time = { slot: 'T', required: true };
  return p;
}

function entry(id: string, more: Partial<TemplateDef> = {}): TemplateDef {
  const signature = sig(id);
  return {
    id, kind: signature.renderer, version: 1, signature, params: paramsOf(signature),
    geometry: 'none', nameKey: `template.${id}`, libs: signature.renderer === 'vega' ? ['vega', 'vega-lite'] : [],
    ready: false, ...more,
  };
}

// >>> ADD-TEMPLATE: catalogue — a new archetype needs its signature first.
export const CATALOGUE: readonly TemplateDef[] = [
  entry('composition', {
    ready: true,
    source: { kind: 'vega', load: async () => (await import('./vega/composition.js')).build },
  }),
  entry('ranking', {
    ready: true,
    // `time` is optional: given, the bars race through the years (a slider).
    params: { by: { slot: 'CR', required: true }, time: { slot: 'T', required: false }, measure: { required: false }, top: { required: false } },
    source: { kind: 'vega', load: async () => (await import('./vega/ranking.js')).build },
  }),
  // `measure` is the binned field; a histogram of its values, optionally stacked by `by`.
  entry('distribution', {
    ready: true,
    params: { by: { slot: 'C', required: false }, measure: { required: false, binned: true }, top: { required: false } },
    source: { kind: 'vega', load: async () => (await import('./vega/distribution.js')).build },
  }),
  entry('timeline', {
    ready: true,
    // `by` is optional: without it one series; with it a stack of its groups.
    // `mode`: additions (default) or net, which also draws the retirement year's units below zero.
    params: { by: { slot: 'C', required: false }, time: { slot: 'T', required: true }, measure: { required: false }, top: { required: false }, mode: { required: false } },
    source: { kind: 'vega', load: async () => (await import('./vega/timeline.js')).build },
  }),
  // Points appearing by year (or month), coloured by an optional `by`, sized by the measure; plays and scrubs.
  entry('buildout-map', {
    ready: true, geometry: 'point', libs: ['maplibre-gl', 'maplibre-gl.css'],
    params: { by: { slot: 'C', required: false }, time: { slot: 'T', required: true }, measure: { required: false } },
    source: { kind: 'html', load: async () => (await import('./html/buildout-map.js?raw')).default },
  }),
  // A sankey: `by` the source side, `split` the target side, each kept to its `top` groups + Other.
  entry('flow', {
    ready: true, libs: ['d3', 'd3-sankey'],
    params: { by: { slot: 'C', required: true }, split: { slot: 'CR', required: true }, measure: { required: false }, top: { required: false } },
    source: { kind: 'html', load: async () => (await import('./html/flow.js?raw')).default },
  }),
  entry('hierarchy'),
  entry('density', {
    ready: true, geometry: 'point', libs: ['maplibre-gl', 'maplibre-gl.css', 'deck.gl'],
    source: { kind: 'html', load: async () => (await import('./html/density.js?raw')).default },
  }),
  entry('lines-by-class', {
    ready: true, geometry: 'full', libs: ['maplibre-gl', 'maplibre-gl.css', 'd3'],
    source: { kind: 'html', load: async () => (await import('./html/lines-by-class.js?raw')).default },
  }),
  entry('scatter'),
  // One panel per `split` region (≤ 6: the Area's, a where's, else the largest), bars by `by`.
  entry('compare-regions', {
    ready: true,
    params: { by: { slot: 'C', required: true }, split: { slot: 'R', required: true }, measure: { required: false }, top: { required: false } },
    source: { kind: 'vega', load: async () => (await import('./vega/compare-regions.js')).build },
  }),
  // Per region tag (no spatial join): by counties the main map is painted (county-overlay.ts) and the
  // frame lists the counties; by states / NERC / BA / countries / admin-1 the frame draws their outlines
  // (per-region.ts, from the app's own GeoJSON boundaries); by retail the list alone.
  entry('points-per-polygon', {
    ready: true, libs: ['maplibre-gl', 'maplibre-gl.css'],
    source: { kind: 'html', load: async () => (await import('./html/points-per-polygon.js?raw')).default },
  }),
  // One pie per region (`split`: states, countries or admin-1) on a map, its slices the `by` groups (top + Other),
  // its area the region's total (page half: per-region.ts regionCentre, regionFeatures).
  entry('pies-per-region', {
    ready: true, libs: ['maplibre-gl', 'maplibre-gl.css'],
    params: { by: { slot: 'C', required: true }, split: { slot: 'R', required: true }, measure: { required: false }, top: { required: false } },
    source: { kind: 'html', load: async () => (await import('./html/pies-per-region.js?raw')).default },
  }),
  // Each point's distance to the nearest feature of `layer2` (a GeoJSON point layer), `within` km the threshold.
  // ready: false: not offered in the gallery or the chat.
  entry('nearest', {
    ready: false, geometry: 'point', libs: ['maplibre-gl', 'maplibre-gl.css'],
    params: { by: { slot: 'C', required: false }, layer2: { required: false }, within: { required: false } },
    source: { kind: 'html', load: async () => (await import('./html/nearest.js?raw')).default },
  }),
  entry('crossings', { geometry: 'full' }),
];

const BY_ID = new Map(CATALOGUE.map(t => [t.id, t]));
export const TEMPLATE_IDS: readonly string[] = CATALOGUE.map(t => t.id);

export const templateById = (id: string): TemplateDef | undefined => BY_ID.get(id);

let allRoles: Roles[] | null = null;
/** Every queryable layer's roles (an archetype needing a second layer looks among them). */
export const queryableRoles = (): Roles[] => (allRoles ??= LAYERS.flatMap(l => { const r = rolesOf(l.id); return r ? [r] : []; }));

/** The ready templates whose signature `layerId`'s roles fit. */
export function templatesFor(layerId: string): TemplateDef[] {
  const roles = rolesOf(layerId);
  if (!roles) return [];
  return CATALOGUE.filter(d => d.ready && fit(d.signature, roles, queryableRoles()) === 'fits');
}
