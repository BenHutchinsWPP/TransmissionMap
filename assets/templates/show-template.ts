// ─── showTemplate: one page-owned template over one layer ────────────────────
// Role: the one path a template takes onto the screen, for the chat (the
//       showTemplate tool), the gallery and a restored chat card alike.
//         validateTemplateArgs(args)  the arguments checked and resolved, with
//                    no data read: own keys only; `template` a ready catalogue
//                    id; `layer` a layer whose field roles fit the template's
//                    signature; each field param of the role its slot takes (a
//                    refusal lists what the slot takes); `area` / `where`
//                    through the link validators. An area is refused where the
//                    template reads the view only (a tiled layer without a columns file).
//         showTemplate(args, host)    validate → dataset-query.ts shapeRows →
//                    the TemplatePayload (payload.ts), then host.render. Payload
//                    ≤ 8 MB of JSON (capPayload: features cut first, then rows,
//                    each cut `truncated` + named). A vega template's spec is
//                    built here by its catalogue builder; an html template is
//                    kit.js + its own repo script (`?raw`), with the payload as
//                    TM_INPUT: model text reaches it only as a checked param.
//                    RenderExtra.onAction is the frame's action handler
//                    (template-actions.ts); a vega template's signals bridge its
//                    selections to `where` actions. A point-in-region template
//                    paints the main map through county-overlay.ts (session
//                    only); its card flies to a region code, never selects it.
//                    The model gets only `summary`: the page's own figures,
//                    ≤ 1 KB; nearest numbers only, no names (chat trust model). A
//                    refusal is an argument's reason, shapeRows' reason or a
//                    bare frame category (nothing the frame said).
//         templatesFor(layerId)       the ready templates that fit a layer
//                    (catalogue.ts's, re-exported).
//         formChoices(def, layerId)   what a form may offer for each param on
//                    that layer, the same lists validateTemplateArgs accepts,
//                    for the Visualize pane (ui-templates.ts).
//         fieldLabel / measureLabel   a field's or a measure's words for a
//                    title, an axis or a form option.
//
// Deps: catalogue.ts (incl. templatesFor, queryableRoles), groups.ts (topGroups, NEUTRAL), payload.ts,
//       dataset-query.ts (shapeRows, shapeSlots), field-roles.ts (rolesOf),
//       template-signatures.ts (fit, slotFields), registry (layerById),
//       transmission.ts (OSM_TL_TIERS: the hidden tiers' names and kV ranges),
//       view-validate.ts (validateWhere, validateArea), area-filter.ts
//       (areaCondition), state.ts (area, where), facets.ts (facet), fuel.ts
//       (fuelFold), vega-spec.ts (rowsCsv), chart-spec.ts (humanise), src/units.ts (getUnits), i18n (t,
//       getLocale, getLocaleDef), agent/tools.ts (types only: DispatchOpts,
//       RenderExtra, TemplateRender), template-actions.ts (templateActions),
//       canvas-host.ts (types only: SignalAction), per-region.ts (classes, outlines),
//       vega/common.ts (binLabels, monthText: the bins' and months' words),
//       county-overlay.ts (paintCountyOverlay, clearCountyOverlay), ui/area-labels.ts
//       (loadAreaLabels, areaLabel), nearest.ts (nearest); html/kit.js and the templates' own
//       code on demand.

import { CATALOGUE, templateById, templatesFor, queryableRoles, TEMPLATE_IDS, type TemplateDef } from './catalogue.js';
import { topGroups, NEUTRAL } from './groups.js';
import { TEMPLATE_PAYLOAD_VERSION, type TemplatePayload, type TemplateParam } from './payload.js';
import { shapeRows, shapeSlots, hasColumns, type Outcome, type ShapeRow, type ShapeKey } from '../dataset-query.js';
import { rolesOf, aliasFields, type RoleField, type Roles } from '../../src/registry/field-roles.js';
import { fit, slotFields, type Slot } from '../../src/registry/template-signatures.js';
import { layerById } from '../../src/registry/index.js';
import { OSM_TL_TIERS } from '../../src/registry/transmission.js';
import { validateWhere, validateArea } from '../../src/registry/view-validate.js';
import { areaCondition, type AreaFilter } from '../../src/registry/area-filter.js';
import type { Condition } from '../../src/registry/condition-compile.js';
import { state } from '../state.js';
import { facet } from '../../src/colors/facets.js';
import { fuelFold } from '../../src/colors/fuel.js';
import { rowsCsv, type Row } from '../vega-spec.js';
import { getUnits } from '../../src/units.js';
import { humanise } from '../chart-spec.js';
import { t, getLocale, getLocaleDef } from '../../src/i18n/index.js';
import type { DispatchOpts, RenderExtra, TemplateRender } from '../agent/tools.js';
import type { SignalAction } from '../sandbox/canvas-host.js';
import { templateActions, conditionForBin } from './template-actions.js';
import { binLabels, monthText } from './vega/common.js';
import { classBreaks, classOf, classLabels, rampColours, regionFeatures, regionCentre } from './per-region.js';
import { paintCountyOverlay, clearCountyOverlay, type CountyLegend } from '../county-overlay.js';
import { loadAreaLabels, areaLabel } from '../ui/area-labels.js';
import { AREA_KINDS, type AreaKind } from '../../src/registry/area-filter.js';
import { nearest as nearestOf, type LonLat } from './nearest.js';

export const TEMPLATE_ARGS = ['template', 'layer', 'area', 'where', 'by', 'split', 'measure', 'time', 'top', 'buckets', 'title', 'mode', 'layer2', 'where2', 'within'] as const;
export const BUCKETS_MIN = 5, BUCKETS_MAX = 40;
export const TOP_MIN = 3, TOP_MAX = 30, TOP_DEFAULT = 10;
export const MAX_TITLE = 120;
/** `within` (km): the bounds, and the default (10 mi). */
export const WITHIN_MIN = 0.1, WITHIN_MAX = 500, WITHIN_DEFAULT = 16.1;
/** `layer2`'s default where the template takes one. */
const LAYER2_DEFAULT = 'hifld-substations';
export const MODES = ['additions', 'net'] as const;
export type TimelineMode = typeof MODES[number];
export const MAX_SUMMARY_BYTES = 1024;
/** nearest: a point this far from every target is counted apart (summary over500km, the frame's near.far note). */
const FAR_KM = 500;
/** The cap on a template's inputs (the payload as JSON): features, then rows, are cut past it. */
export const MAX_TEMPLATE_INPUT_BYTES = 8 * 1024 * 1024;
/** The canvas frame's cap on an html payload (sandbox/canvas-runner.js). */
export const MAX_TEMPLATE_HTML = 60_000;
/** A vega template's selections the runner bridges to `where` actions: the signal, which of the payload's
 *  fields it picks (by / split / a month-binned time / the bins), the datum field it reads and the one
 *  holding the row key (the same field: the value is the key). A signal the spec lacks is skipped. */
interface VegaPick { signal: string; of: 'by' | 'split' | 'time' | 'bins'; read: string; key: string }
export const VEGA_PICK: Record<string, readonly VegaPick[]> = {
  composition: [{ signal: 'pick', of: 'by', read: 'label', key: 'key' }],
  ranking: [{ signal: 'pick', of: 'by', read: 'label', key: 'key' }],
  timeline: [{ signal: 'leg', of: 'by', read: 'label', key: 'key' }, { signal: 'mon', of: 'time', read: 'mkey', key: 'mkey' }],
  'compare-regions': [{ signal: 'pick', of: 'by', read: 'label', key: 'key' }, { signal: 'reg', of: 'split', read: 'region', key: 'rkey' }],
  distribution: [{ signal: 'pick', of: 'bins', read: 'label', key: 'key' }],
};
/** The payload field a pick stands for, or none when the payload has no such pick (a year timeline's months, a bin with no filter). */
function pickField(p: TemplatePayload, of: VegaPick['of']): string | undefined {
  if (of === 'by') return p.roles.by[0]?.field;
  if (of === 'split') return p.roles.by[1]?.field;
  if (of === 'time') return p.roles.time?.bin === 'month' ? p.roles.time.field : undefined;
  return p.roles.bins?.filter ? p.roles.bins.field : undefined;
}
/** compare-regions: at most this many region panels. */
export const MAX_REGIONS = 6;
/** pies-per-region: at most this many pies (the regions with the largest totals). */
export const MAX_PIES = 250;
/** A timeline over a date field bins by month when ≥ 90 % of its dated features fall in its last this many years. */
export const MONTHS_UP_TO_YEARS = 6;
/** What a model may be told when the frame fails: a category only. */
const TOLD = ['syntax', 'runtime', 'timeout', 'too-large', 'unavailable', 'library', 'invalid-data'] as const;
const DERIVED_UNIT: Record<string, string> = { length_km: 'km', area_km2: 'km²' };

/** A voltage tier's name for the visitor, its range from the tier's own kV bounds. */
export function tierLabel(id: string): string {
  const kv = OSM_TL_TIERS.find(x => x.id === id)?.kv;
  if (id === 'unknown') return t('template.tier.unknown');
  if (!kv) return id;
  const n = (v: number) => v.toLocaleString(getLocale());
  const range = kv[0] <= 1 ? `< ${n(kv[1])} kV` : kv[1] === Infinity ? `≥ ${n(kv[0])} kV` : `${n(kv[0])}–${n(kv[1])} kV`;
  return t(`template.tier.${id}`, { range });
}

export type ShowTemplateArgs = Partial<Record<typeof TEMPLATE_ARGS[number], unknown>>;

export interface ResolvedArgs {
  def: TemplateDef;
  layer: string;
  roles: Roles;
  by?: string;
  /** A second grouping field (compare-regions, flow), ≠ by. */
  split?: string;
  measure: string;
  time?: string;
  top: number;
  /** distribution: about this many bins (BUCKETS_MIN–BUCKETS_MAX); absent = auto. */
  buckets?: number;
  title?: string;
  mode?: TimelineMode;
  area: AreaFilter | null;
  /** The conditions actually used ([] for none), resolved from the args or the layer's current ones. */
  where: Condition[];
  /** A second, GeoJSON point layer (nearest) and its conditions (resolved as `where`). */
  layer2?: string;
  where2?: Condition[];
  /** A distance threshold in km (nearest). */
  within?: number;
}

export interface ShowTemplateResult {
  shown: true;
  template: string;
  layer: string;
  scope: 'area' | 'view';
  complete: boolean;
  partial?: true;
  truncated?: string;
  tiersHidden?: string[];
  summary: TemplateSummary;
}

export interface TemplateSummary {
  measure: string;
  unit?: string;
  total: { count: number; sum?: number };
  groups?: number;
  top?: { key: string; value: number; share: number }[];
  /** A net timeline: groups (and their values) are additions + retirements. */
  rankedBy?: 'additions + retirements';
  /** points-per-polygon: a feature in several regions counts in each (shares are of each feature once). */
  overlap?: true;
  /** by states on a world layer: only features in a US state or territory were read; nearest beside a
   *  US-only layer2 (coverageArea): only the layer's US points were measured. */
  usOnly?: true;
  /** distribution: the binned values' own quantiles (n with a value, p10, median, p90; nearest rank). */
  stats?: { n: number; p10: number; median: number; p90: number };
  /** compare-regions: each panel's region, its value and its largest group's share of it. */
  regions?: { key: string; value: number; top?: { key: string; share: number } }[];
  /** pies-per-region: how many regions are drawn (`regions` lists the largest few). */
  regionCount?: number;
  /** flow: the three largest links (source group → target group), each with its share of all links. */
  links?: { from: string; to: string; value: number; share: number }[];
  /** nearest: numbers only, no feature names (chat trust model): points measured, the median and 90th-percentile
   *  distance in km, the threshold, and how many are within it and beyond it. */
  nearest?: { n: number; median_km: number; p90_km: number; within_km: number; within: number; share: number; beyond: number; noTarget?: number;
    /** Points over FAR_KM from every target: the second layer may not cover them (a world layer measured to a US one). */
    over500km?: number };
  /** buildout-map: the first and last year (or month) with a feature, and the one that added the most. */
  span?: { first: string | number; last: string | number; peak: string | number };
  scope: 'area' | 'view';
  complete: boolean;
}

/** What renders a template: the chat's card host, or the gallery's. */
export interface TemplateHost { render?: DispatchOpts['render'] }

// ─── Roles and fit ───────────────────────────────────────────────────────────
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
/** The fields a template may bind to: the readable ones that are not ids or labels, plus the states alias on a world layer. */
const live = (r: Roles) => [...r.fields.filter(f => f.role !== 'id' && f.role !== 'label'), ...aliasFields(r)];

export { templatesFor };

const fieldText = (f: RoleField) => `${f.name} (${[f.role, f.unit, f.facet && `legend ${f.facet}`].filter(Boolean).join(', ')})`;
const listOr = (xs: string[]) => xs.length ? xs.join(', ') : 'none on this layer';

/** The layer's retirement-year field when `time` is its opening year (a net timeline subtracts it). */
function retireField(roles: Roles, time?: string): string | undefined {
  if (!time || /retire/i.test(time)) return undefined;
  const ok = new Set(shapeSlots(roles.layerId)?.time);
  return roles.fields.find(f => f.role === 'time' && /retire/i.test(f.name) && ok.has(f.name))?.name;
}

/** The fields a field param can take on `roles`: its slot's fields that shapeRows can group or read. */
function choices(param: 'by' | 'split' | 'time', slot: Slot, roles: Roles, def?: TemplateDef): RoleField[] {
  const slots = shapeSlots(roles.layerId);
  const ok = new Set(param === 'time' ? slots?.time : slots?.by);
  // A signature that names its region fields (pies-per-region) offers no other region list as split.
  const kinds = param === 'split' ? def?.signature.regions : undefined;
  const fields = slotFields(slot, live(roles)).filter(f => ok.has(f.name) && (!kinds || kinds.includes(f.name)));
  if (param === 'time') return fields;
  const rank = (f: RoleField) => f.facet ? 0 : f.role === 'category' ? 1 : 2;
  return fields.map((f, i) => [f, i] as const).sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1]).map(x => x[0]);
}

/** What `measure` takes: amounts to sum (count, length / area, additive measures), or — on a template
 *  that bins it (distribution) — the fields shapeRows can bin (levels, length / area, years; never count). */
function measureChoices(roles: Roles, def?: TemplateDef): string[] {
  const slots = shapeSlots(roles.layerId);
  if (def?.params.measure?.binned) return slots?.bins ?? [];
  return slots?.measure ?? ['count'];
}

function defaultMeasure(roles: Roles, def?: TemplateDef): string | undefined {
  const m = measureChoices(roles, def);
  if (def?.params.measure?.binned) return m[0];
  return m.find(x => !roles.derived.includes(x as never))
    ?? (m.includes('length_km') ? 'length_km' : m.includes('area_km2') ? 'area_km2' : 'count');
}

const USA: AreaFilter = { kind: 'countries', codes: ['USA'] };
/** nearest: the Area a world layer (`countries` tags) reads beside a US-only `layer2` (one a USA Area
 *  reaches whole): the US, so points outside layer2's coverage are not measured to it. Null otherwise. */
export function coverageArea(layer: string, layer2: string): AreaFilter | null {
  const c = areaCondition(layerById(layer)?.dataset, USA);
  return areaCondition(layerById(layer2)?.dataset, USA) === 'all' && typeof c === 'object' && 'field' in c && c.field === 'countries' ? USA : null;
}

/** The layers `layer2` takes beside `layer`: queryable GeoJSON point layers (a tiled one is cut to the view). */
export function layer2Choices(layer: string): string[] {
  return queryableRoles().filter(r => r.geometry === 'point' && r.layerId !== layer && layerById(r.layerId)?.data?.kind === 'geojson').map(r => r.layerId);
}

export interface FormChoices {
  by: RoleField[];
  /** `split`'s fields (the form leaves out the one `by` holds). */
  split: RoleField[];
  time: RoleField[];
  /** `layer2`'s layers. */
  layer2: string[];
  measure: { name: string; unit?: string }[];
  /** Timeline's `net` mode has a retirement year to subtract (with the default time). */
  net: boolean;
  /** The template reads the current view and takes no area (a tiled layer without a columns file, or full geometry). */
  tiled: boolean;
}

/** Whether `def` on `layerId` reads the current view only: a tiled layer without a columns file, or a template that needs full geometry. */
export function viewOnly(layerId: string, def: TemplateDef): boolean {
  return layerById(layerId)!.data!.kind !== 'geojson' && !(hasColumns(layerId) && def.geometry !== 'full');
}

/** What a form may offer for `def`'s params on `layerId` (null when the layer has no roles). */
export function formChoices(def: TemplateDef, layerId: string): FormChoices | null {
  const roles = rolesOf(layerId);
  const entry = layerById(layerId);
  if (!roles || !entry?.data) return null;
  const by = def.params.by?.slot ? choices('by', def.params.by.slot, roles, def) : [];
  const split = def.params.split?.slot ? choices('split', def.params.split.slot, roles, def) : [];
  const time = def.params.time?.slot ? choices('time', def.params.time.slot, roles, def) : [];
  const unit = (m: string) => roles.fields.find(f => f.name === m)?.unit ?? DERIVED_UNIT[m];
  return {
    by, split, time, layer2: def.params.layer2 ? layer2Choices(layerId) : [],
    measure: (def.params.measure ? measureChoices(roles, def) : []).map(name => ({ name, ...(unit(name) && { unit: unit(name) }) })),
    net: !!def.params.mode && !!retireField(roles, time[0]?.name),
    tiled: viewOnly(layerId, def),
  };
}

const suggest = (layer: string) => {
  const fits = templatesFor(layer).map(d => d.id);
  return fits.length ? `templates that fit "${layer}": ${fits.join(', ')}` : `no ready template fits "${layer}" yet`;
};

// ─── Arguments ───────────────────────────────────────────────────────────────
/** The arguments checked and resolved against the catalogue, the layer's
 *  roles and the view (defaults); no data is read. */
export function validateTemplateArgs(args: unknown): Outcome<ResolvedArgs> {
  const no = (reason: string): Outcome<ResolvedArgs> => ({ ok: false, reason });
  if (!isObj(args)) return no('arguments must be an object');
  const extra = Object.keys(args).filter(k => !(TEMPLATE_ARGS as readonly string[]).includes(k));
  if (extra.length) return no(`unknown argument "${extra[0]}": showTemplate takes ${TEMPLATE_ARGS.join(', ')}`);
  const a = args as ShowTemplateArgs;

  if (typeof a.layer !== 'string') return no('layer must be a layer id');
  const layer = a.layer;
  const roles = rolesOf(layer);
  if (!roles) {
    const ok = queryableRoles().map(r => r.layerId);
    return no(`"${layer}" takes no template: templates read ${listOr(ok)}`);
  }
  if (typeof a.template !== 'string') return no(`template must be one of ${TEMPLATE_IDS.join(', ')}`);
  const def = templateById(a.template);
  if (!def) return no(`unknown template "${a.template}": templates are ${TEMPLATE_IDS.join(', ')}; ${suggest(layer)}`);
  if (!def.ready || !def.source) return no(`"${def.id}" is not available yet; ${suggest(layer)}`);
  const fits = fit(def.signature, roles, queryableRoles());
  if (fits !== 'fits') {
    const need = def.signature.geometry && !def.signature.geometry.includes(roles.geometry)
      ? `it draws ${def.signature.geometry.join(' or ')} layers and "${layer}" is a ${roles.geometry} layer`
      : `"${layer}" has no field for its ${def.signature.slots.join(' + ')} slots`;
    return no(`"${def.id}" does not fit "${layer}": ${need}; ${suggest(layer)}`);
  }

  // by / split / time: a field of the role the slot takes.
  const field = (param: 'by' | 'split' | 'time', fallback?: (cs: RoleField[]) => RoleField | undefined, not?: string): Outcome<string | undefined> => {
    const spec = def.params[param];
    const v = a[param];
    if (!spec?.slot) {
      return v === undefined ? { ok: true, result: undefined } : { ok: false, reason: takesNo(def, param, layer) };
    }
    const cs = choices(param, spec.slot, roles, def).filter(f => f.name !== not);
    const takes = `${param} takes ${listOr(cs.map(fieldText))}`;
    if (v === undefined) {
      // An optional time (ranking's race), or an optional by beside a binned measure (distribution's stack), is off unless asked for.
      const off = !spec.required && (param === 'time' || (param === 'by' && !!def.params.measure?.binned));
      if (cs.length && !off) return { ok: true, result: (fallback?.(cs) ?? cs[0]).name };
      return spec.required ? { ok: false, reason: `"${layer}" has no field for ${def.id}'s ${param}; ${suggest(layer)}` } : { ok: true, result: undefined };
    }
    if (typeof v !== 'string') return { ok: false, reason: `${param} must be a field name: ${takes}` };
    if (v === not) return { ok: false, reason: `split must be another field than by ("${v}"): ${takes}` };
    if (!cs.some(f => f.name === v)) {
      const r = roles.fields.find(f => f.name === v);
      const what = r ? `"${v}" is a ${r.role} on "${layer}"` : `"${layer}" has no field "${v}"`;
      return { ok: false, reason: `${what}, which ${def.id} cannot use as ${param}: ${takes}` };
    }
    return { ok: true, result: v };
  };
  const by = field('by');
  if (!by.ok) return by;
  const time = field('time');
  if (!time.ok) return time;
  if (a.where2 !== undefined && !def.params.layer2) return no(takesNo(def, 'where2', layer));
  if (a.within !== undefined && !def.params.within) return no(takesNo(def, 'within', layer));

  const binned = !!def.params.measure?.binned;
  // A template that lists no measure (nearest) counts, and takes none.
  if (!def.params.measure && a.measure !== undefined) return no(takesNo(def, 'measure', layer));
  if (!def.params.top && a.top !== undefined) return no(takesNo(def, 'top', layer));
  let measure = def.params.measure ? defaultMeasure(roles, def) : 'count';
  if (a.measure !== undefined) {
    const ms = measureChoices(roles, def);
    if (typeof a.measure !== 'string' || !ms.includes(a.measure)) {
      const r = typeof a.measure === 'string' ? roles.fields.find(f => f.name === a.measure) : undefined;
      const hint = !binned && r?.additive === false ? ` ("${a.measure}" is a level, not an amount: use it as by instead)` : '';
      return no(`measure ${JSON.stringify(a.measure)} cannot be ${binned ? 'binned' : 'summed'} on "${layer}"${hint}: measure takes ${listOr(ms)}`);
    }
    measure = a.measure;
  }
  if (measure === undefined) return no(`"${layer}" has no field for ${def.id}'s measure; ${suggest(layer)}`);
  if (binned && measure === by.result) return no(`by must be another field than the binned measure ("${measure}")`);

  let top = TOP_DEFAULT;
  if (a.top !== undefined) {
    if (!Number.isInteger(a.top) || (a.top as number) < TOP_MIN || (a.top as number) > TOP_MAX) return no(`top must be a whole number from ${TOP_MIN} to ${TOP_MAX}`);
    top = a.top as number;
  }

  let buckets: number | undefined;
  if (a.buckets !== undefined) {
    if (!def.params.measure?.binned) return no(takesNo(def, 'buckets', layer));
    if (!Number.isInteger(a.buckets) || (a.buckets as number) < BUCKETS_MIN || (a.buckets as number) > BUCKETS_MAX) return no(`buckets must be a whole number from ${BUCKETS_MIN} to ${BUCKETS_MAX}`);
    buckets = a.buckets as number;
  }

  let mode: TimelineMode | undefined;
  if (def.params.mode) {
    const v = a.mode ?? 'additions';
    if (!(MODES as readonly unknown[]).includes(v)) return no(`mode must be one of ${MODES.join(', ')}`);
    if (v === 'net' && !retireField(roles, time.result)) return no(`"${layer}" has no retirement year, so mode "net" has nothing to subtract: leave mode out`);
    mode = v as TimelineMode;
  } else if (a.mode !== undefined) return no(takesNo(def, 'mode', layer));

  let title: string | undefined;
  if (a.title !== undefined) {
    // eslint-disable-next-line no-control-regex
    if (typeof a.title !== 'string' || !a.title.trim() || a.title.length > MAX_TITLE || /[\u0000-\u001f]/.test(a.title)) {
      return no(`title must be one line of 1 to ${MAX_TITLE} characters`);
    }
    title = a.title.trim();
  }

  const tiled = viewOnly(layer, def);
  let area: AreaFilter | null = null;
  if (a.area !== undefined && a.area !== null) {
    if (tiled) return no(`"${layer}" is a tiled layer: ${def.id} covers the current view only, so leave out area and frame the region on the map`);
    const err = validateArea(a.area);
    if (err) return no(err);
    area = a.area as AreaFilter;
  } else if (a.area === undefined && !tiled && state.area) {
    const cond = areaCondition(layerById(layer)!.dataset!, state.area);
    if (cond === 'all' || !('unfiltered' in cond)) area = state.area;
  }

  const where = whereOf(layer, a.where);
  if (typeof where === 'string') return no(where);

  // split: a second grouping field, ≠ by; by default the Area's own field when it takes it, else states
  // (the alias on a world layer too), else the first region field.
  const areaField = area && areaFieldOf(layerById(layer)!.dataset!, area);
  const split = field('split', cs => cs.find(f => f.name === area?.kind) ?? cs.find(f => f.name === areaField) ?? cs.find(f => f.name === 'states') ?? cs.find(f => f.role === 'region'), by.result);
  if (!split.ok) return split;

  // layer2 (+ where2): a queryable GeoJSON point layer other than `layer`.
  let second: { layer2: string; where2: Condition[] } | undefined;
  if (def.params.layer2) {
    const ok2 = layer2Choices(layer);
    const takes = `layer2 takes ${listOr(ok2)}`;
    const v = a.layer2 ?? (ok2.includes(LAYER2_DEFAULT) ? LAYER2_DEFAULT : ok2[0]);
    if (v === undefined) return no(`no layer can be "${def.id}"'s layer2 beside "${layer}"`);
    if (typeof v !== 'string') return no(`layer2 must be a layer id: ${takes}`);
    if (!ok2.includes(v)) {
      const r2 = rolesOf(v);
      const why = v === layer ? 'layer2 must be another layer than layer'
        : !r2 ? `"${v}" takes no template`
        : r2.geometry !== 'point' ? `"${v}" is a ${r2.geometry} layer and layer2 takes point layers`
        : `"${v}" is a tiled layer: it covers the current view only, so distances to it would stop at the loaded tiles`;
      return no(`${why}: ${takes}`);
    }
    const where2 = whereOf(v, a.where2);
    if (typeof where2 === 'string') return no(`where2: ${where2}`);
    second = { layer2: v, where2 };
    // A world layer measured to a US-only one reads the US unless an area was given (null: the whole layer).
    if (area === null && a.area === undefined && !tiled) area = coverageArea(layer, v);
  } else if (a.layer2 !== undefined) return no(takesNo(def, 'layer2', layer));

  let within: number | undefined;
  if (def.params.within) {
    const v = a.within ?? WITHIN_DEFAULT;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < WITHIN_MIN || v > WITHIN_MAX) return no(`within must be a distance in km from ${WITHIN_MIN} to ${WITHIN_MAX}`);
    within = v;
  }

  return { ok: true, result: {
    def, layer, roles, ...(by.result && { by: by.result }), ...(split.result && { split: split.result }), measure, ...(time.result && { time: time.result }),
    top, ...(buckets && { buckets }), ...(title && { title }), ...(mode && { mode }), area, where, ...second, ...(within !== undefined && { within }),
  } };
}

/** A param the template does not take and, for split / layer2 (+ where2, within) / mode, the ready templates
 *  fitting `layer` that take it ("…takes no split; split is for flow, compare-regions"), so a model can switch
 *  templates in one step. */
function takesNo(def: TemplateDef, param: keyof TemplateDef['params'] | 'where2' | 'buckets', layer: string): string {
  const p = param === 'where2' ? 'layer2' : param;
  const fits = new Set(templatesFor(layer).map(d => d.id));
  // by, measure and top fit most templates: only the specialised params name their templates.
  const others = ['split', 'layer2', 'within', 'mode', 'buckets'].includes(p) ? CATALOGUE.filter(d => d.ready && (p === 'buckets' ? d.params.measure?.binned : d.params[p as keyof TemplateDef['params']]) && fits.has(d.id)).map(d => d.id) : [];
  return `"${def.id}" takes no ${param}${others.length ? `; ${param} is for ${others.join(', ')}` : ''}`;
}

/** `v` checked as `layer`'s conditions (the link's validator), or the layer's current ones when absent; a string says why not. */
function whereOf(layer: string, v: unknown): Condition[] | string {
  if (v === undefined) return [...(state.where[layer] ?? [])];
  return validateWhere(layer, v) ?? v as Condition[];
}

const sameArea = (a: AreaFilter, b: AreaFilter) => a.kind === b.kind && a.codes.join() === b.codes.join();

/** The field an Area filters `dataset` by (its own kind, or admin1 for states on a world layer), if a condition. */
function areaFieldOf(dataset: string, area: AreaFilter): string | undefined {
  const c = areaCondition(dataset, area);
  return typeof c === 'object' && 'field' in c ? c.field : undefined;
}

/** The params a card keeps to show the same template again (validateTemplateArgs takes them back):
 *  `area` always (null = the whole layer) and the `where` actually used ([] = none), so a
 *  Re-run or a restore reads the same features whatever the view's Area and conditions are by then. */
export function renderParams(r: ResolvedArgs): Record<string, unknown> {
  return {
    ...(r.by && { by: r.by }), ...(r.split && { split: r.split }), ...(r.def.params.measure && { measure: r.measure }), ...(r.time && { time: r.time }),
    ...(r.def.params.top && { top: r.top }), ...(r.buckets && { buckets: r.buckets }),
    ...(r.title && { title: r.title }), ...(r.mode && { mode: r.mode }), area: r.area, where: r.where,
    ...(r.layer2 && { layer2: r.layer2, where2: r.where2 ?? [] }), ...(r.within !== undefined && { within: r.within }),
  };
}

// ─── Colours, labels, credit ─────────────────────────────────────────────────
interface Fold { key: (k: ShapeKey) => ShapeKey; colour: Record<string, string>; label: Record<string, string> }

const bucketLabel = (b: { label: string }) => {
  const key = (b as { labelKey?: string }).labelKey;
  return key ? t(key) : b.label;
};

/** A facet-linked field's fold of row keys into the legend's buckets, with their colours and labels; null for any other field. */
function foldOf(f: RoleField): Fold | null {
  if (!f.facet) return null;
  let rec;
  try { rec = facet(f.facet); } catch { return null; }
  const colour: Record<string, string> = {}, label: Record<string, string> = {};
  for (const b of rec.buckets) { colour[b.id] = b.color; label[b.id] = bucketLabel(b); }
  const fuel = f.facet === 'fuel' ? fuelFold(f.name) : null;
  if (fuel) return { key: k => k === null ? null : fuel(k).id, colour, label };
  // kV: shapeRows already bins the value into a bucket id.
  if (f.facet === 'kv') return { key: k => k, colour, label };
  const byValue = new Map<string, string>();
  for (const b of rec.buckets) for (const v of b.values ?? []) if (!byValue.has(v)) byValue.set(v, b.id);
  if (!byValue.size) return { key: k => k, colour, label };
  const other = rec.buckets.find(b => b.id === 'other' && !b.values?.length)?.id;
  return { key: k => k === null ? null : byValue.get(String(k)) ?? other ?? k, colour, label };
}

/** The rows with each facet field's keys folded into buckets (rows that meet are summed). */
function foldRows(rows: readonly ShapeRow[], folds: [string, Fold][], keyFields: string[]): ShapeRow[] {
  if (!folds.length) return [...rows];
  const out = new Map<string, ShapeRow>();
  for (const r of rows) {
    const row: ShapeRow = { ...r };
    for (const [field, f] of folds) row[field] = f.key(r[field] ?? null);
    const k = JSON.stringify(keyFields.map(x => row[x] ?? null));
    const seen = out.get(k);
    if (!seen) { out.set(k, row); continue; }
    seen.count += row.count;
    if (row.sum !== undefined) seen.sum = (seen.sum ?? 0) + row.sum;
  }
  return [...out.values()];
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©' };
/** A registry credit (HTML) as plain text. */
export function creditText(html: string): string {
  return html.replace(/<[^>]*>/g, '')
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (m, e: string) => e[0] === '#'
      ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1)))
      : ENTITIES[e.toLowerCase()] ?? m)
    .replace(/\s+/g, ' ').trim();
}

const cap = (x: string) => x.charAt(0).toLocaleUpperCase(getLocale()) + x.slice(1);
const layerTitle = (id: string) => { const l = layerById(id); return l ? t(l.titleKey) : id; };

export function measureLabel(measure: string, unit?: string): string {
  if (measure === 'count') return cap(t('chart.count'));
  if (measure === 'length_km') return t('template.lengthKm');
  if (measure === 'area_km2') return t('template.areaKm2');
  const h = humanise(measure);
  return unit && !h.includes(`(${unit})`) && !h.toLowerCase().endsWith(unit.toLowerCase()) ? `${h} (${unit})` : h;
}

/** A field's name for a title or axis: its legend's title when it has a facet ("Fuel Type"), else the words of its name. */
export function fieldLabel(f: Pick<RoleField, 'name' | 'facet'>): string {
  if (f.facet) {
    try {
      const rec = facet(f.facet);
      const k = t(rec.titleKey);
      return k !== rec.titleKey ? k : rec.title;
    } catch { /* an unknown facet: the name's words */ }
  }
  return humanise(f.name);
}

/** The page's own figures for the model: total, group count and the top 3 groups with their share, ≤ 1 KB.
 *  Groups rank as the chart ranks them (topGroups): on a net timeline by additions + retirements,
 *  which `rankedBy` then says, with each value that sum. */
export function summarise(p: TemplatePayload, total: { count: number; sum?: number }, measure: string, unit?: string, usOnly?: boolean): TemplateSummary {
  const net = p.rows.some(x => x.side === 'retire');
  const base: TemplateSummary = { measure, ...(unit && { unit }), ...(net && { rankedBy: 'additions + retirements' as const }), total, ...(usOnly && { usOnly: true as const }), scope: p.scope, complete: p.complete };
  const round = (n: number) => Math.round(n * 100) / 100;
  const fits = (x: TemplateSummary) => new TextEncoder().encode(JSON.stringify(x)).length <= MAX_SUMMARY_BYTES;
  if (p.template === 'nearest') {
    const d = p.rows.map(x => x.d_km).filter((v): v is number => typeof v === 'number').sort((a, b) => a - b);
    const within = typeof p.params.within === 'number' ? p.params.within : WITHIN_DEFAULT;
    const q = (f: number) => d.length ? round(d[Math.min(d.length - 1, Math.max(0, Math.ceil(f * d.length) - 1))]) : 0;
    const inside = d.filter(v => v <= within).length;
    const noTarget = p.rows.length - d.length, far = d.filter(v => v > FAR_KM).length;
    return { ...base, nearest: {
      n: d.length, median_km: q(0.5), p90_km: q(0.9), within_km: within, within: inside,
      share: d.length ? round(inside / d.length) : 0, beyond: d.length - inside, ...(noTarget > 0 && { noTarget }), ...(far > 0 && { over500km: far }),
    } };
  }
  if (p.roles.bins) {
    const st = p.roles.bins.stats;
    return { ...base, ...(st && { stats: { n: st.n, p10: round(st.p10), median: round(st.median), p90: round(st.p90) } }) };
  }
  if (p.template === 'buildout-map' && p.roles.time) {
    const tf = p.roles.time.field, per = new Map<string | number, number>();
    for (const x of p.rows) { const k = x[tf]; if (k !== null && k !== undefined) per.set(k, (per.get(k) ?? 0) + (x.sum ?? x.count)); }
    const ks = [...per.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    if (ks.length) base.span = { first: ks[0], last: ks[ks.length - 1], peak: [...per].sort((a, b) => b[1] - a[1])[0][0] };
  }
  const by = p.roles.by[0]?.field;
  if (!by) return base;
  const to = p.template === 'flow' ? p.roles.by[1]?.field : undefined;
  if (to) {
    // The largest links, each named by its two groups' labels, with its share of all links.
    const name = (f: string, k: ShapeKey | undefined) => (k === null || k === undefined ? p.labels.none ?? 'none' : p.labels[`value.${f}.${k}`] ?? String(k)).slice(0, 60);
    const all = p.rows.reduce((n, x) => n + (x.sum ?? x.count), 0) || 1;
    const links = [...p.rows].sort((a, b) => (b.sum ?? b.count) - (a.sum ?? a.count)).slice(0, 3)
      .map(x => ({ from: name(by, x[by]), to: name(to, x[to]), value: round(x.sum ?? x.count), share: round((x.sum ?? x.count) / all) }));
    return { ...base, groups: new Set(p.rows.map(x => x[by])).size, links };
  }
  const pies = p.template === 'pies-per-region';
  const split = p.template === 'compare-regions' || pies ? p.roles.by[1]?.field : undefined;
  if (split) {
    // Per region: its value and its largest group's share, regions largest first.
    const all = topGroups(p, by, Number.MAX_SAFE_INTEGER);
    const nameOf = new Map(all.map(g => [g.key, g.label]));
    const per = new Map<string, Map<string, number>>();
    for (const x of p.rows) {
      const rk = String(x[split]);
      const m = per.get(rk) ?? new Map<string, number>();
      const g = nameOf.get(x[by] ?? null) ?? String(x[by]);
      m.set(g, (m.get(g) ?? 0) + (x.sum ?? x.count));
      per.set(rk, m);
    }
    let regions = [...per].map(([rk, m]) => {
      const value = [...m.values()].reduce((a, b) => a + b, 0);
      const [gk, gv] = [...m].sort((a, b) => b[1] - a[1])[0];
      return { key: (p.labels[`value.${split}.${rk}`] ?? rk).slice(0, 60), value: round(value), ...(value > 0 && { top: { key: gk.slice(0, 60), share: round(gv / value) } }) };
    }).sort((a, b) => b.value - a.value);
    // Pies: the five largest regions and the three largest groups, so a world of regions fits in 1 KB.
    const regionCount = regions.length;
    const topAll = pies ? all.filter(g => !g.other).slice(0, 3).map(g => ({ key: g.label.slice(0, 60), value: round(g.value), share: round(g.value / (all.reduce((n, x) => n + x.value, 0) || 1)) })) : [];
    if (pies) regions = regions.slice(0, 5);
    let out: TemplateSummary = { ...base, groups: all.length, ...(pies && { regionCount, top: topAll }), regions };
    while (!fits(out) && regions.length) { regions = regions.slice(0, -1).map(x => ({ ...x, key: x.key.slice(0, 20), ...(x.top && { top: { ...x.top, key: x.top.key.slice(0, 20) } }) })); out = { ...out, regions }; }
    return out;
  }
  const groups = topGroups(p, by, Number.MAX_SAFE_INTEGER);
  // Per region: shares of the total with each feature once (payload.totalOnce), not of the overlapping region sums.
  const once = p.totalOnce && (p.roles.measure.name === 'count' ? p.totalOnce.count : p.totalOnce.sum);
  const all = once || groups.reduce((s, g) => s + g.value, 0) || 1;
  let top = groups.slice(0, 3).map(g => ({ key: g.label.slice(0, 60), value: round(g.value), share: round(g.value / all) }));
  if (p.labels['ppp.overlap']) base.overlap = true;
  let s: TemplateSummary = { ...base, groups: groups.length, top };
  while (new TextEncoder().encode(JSON.stringify(s)).length > MAX_SUMMARY_BYTES && top.length) {
    top = top.slice(0, -1).map(x => ({ ...x, key: x.key.slice(0, 20) }));
    s = { ...base, groups: groups.length, top };
  }
  return s;
}

// ─── Payload ─────────────────────────────────────────────────────────────────
interface Overlay { colours: Record<string, string>; legend: () => CountyLegend }

/** points-per-polygon: region names as labels, each region's colour by its quantile class (the
 *  same in the frame and on the map), class rows as colours.class / value.class.<i>; by counties the
 *  overlay the main map paints, by any other region its simplified boundaries for the frame. */
async function perRegion(field: string, rows: readonly ShapeRow[], measure: string, titleOf: () => string, overlap: boolean,
  labels: Record<string, string>, colours: Record<string, Record<string, string>>): Promise<{ features?: GeoJSON.Feature[]; overlay?: Overlay }> {
  const values = new Map<string, number>();
  for (const x of rows) {
    const k = x[field];
    if (k === null || k === undefined || k === 'none') continue;
    values.set(String(k), (values.get(String(k)) ?? 0) + (x.sum ?? x.count));
  }
  const table = await loadAreaLabels();
  for (const k of values.keys()) labels[`value.${field}.${k}`] = areaLabel(table, field as AreaKind, k);
  labels[`value.${field}.none`] = t('template.overlay.outside');
  // Nothing to rank or colour: no classes, no overlay, a neutral line in the card.
  if (!values.size) { labels['ppp.noValues'] = t('template.overlay.noValues'); return {}; }
  if (overlap) labels['ppp.overlap'] = t('template.overlay.overlap');
  const vs = [...values.values()];
  const breaks = classBreaks(vs);
  const ramp = rampColours(breaks.length);
  const whole = measure === 'count' || vs.every(Number.isInteger);
  const min = Math.min(...vs);
  const ranges = classLabels(breaks, min, whole, getLocale());
  colours[field] = Object.fromEntries([...values].map(([k, v]) => [k, ramp[classOf(v, breaks)]]));
  colours.class = Object.fromEntries(ramp.map((c, i) => [String(i), c]));
  ranges.forEach((x, i) => { labels[`value.class.${i}`] = x; });
  if (field === 'counties') {
    labels['ppp.onMap'] = t('template.overlay.onMap');
    // A function, so the legend card follows a language change (county-overlay.ts calls it again).
    const legend = (): CountyLegend => {
      const rs = classLabels(breaks, min, whole, getLocale());
      return {
        title: titleOf(), classes: ramp.map((colour, i) => ({ colour, label: rs[i] })),
        note: [t('template.overlay.unshaded'), ...(overlap ? [t('template.overlay.overlap')] : [])].join(' '),
      };
    };
    return { overlay: { colours: colours[field], legend } };
  }
  const features = await regionFeatures(field, new Set(values.keys()));
  if (!features?.length) { labels['ppp.noMap'] = t('template.overlay.noMap'); return {}; }
  return { features };
}

async function buildPayload(r: ResolvedArgs): Promise<Outcome<{ payload: TemplatePayload; total: { count: number; sum?: number }; unit?: string; tiersHidden?: string[]; overlay?: Overlay; usOnly?: true }>> {
  // A binned measure (distribution): rows per bin of it, each summing it when it is an amount, else counting.
  const binned = r.def.params.measure?.binned;
  const amount = binned ? (measureChoices(r.roles).includes(r.measure) ? r.measure : 'count') : r.measure;
  const retireAt = r.mode === 'net' && r.time ? retireField(r.roles, r.time) : undefined;
  const shape = (bin: 'year' | 'month') => shapeRows(r.layer, {
    ...(r.area && { area: r.area }), ...(r.where.length > 0 && { where: r.where }),
    by: [r.by, r.split].filter((x): x is string => !!x), measure: amount,
    ...(r.time && { time: { field: r.time, bin } }),
    ...(binned && { bins: { field: r.measure, ...(r.buckets && { buckets: r.buckets }) } }),
    geometry: r.def.geometry,
  });
  let shaped = await shape('year');
  if (!shaped.ok) return shaped;
  // A timeline over a date field whose dated features fall ≥ 90 % within its last MONTHS_UP_TO_YEARS years: read
  // again by month (the timeline draws those years' months and counts the older ones apart; no net mode: its
  // retirement years are years).
  if ((r.def.id === 'timeline' || r.def.id === 'buildout-map') && r.time && !retireAt && live(r.roles).find(f => f.name === r.time)?.time === 'date' && monthly(shaped.result.rows, r.time)) {
    shaped = await shape('month');
    if (!shaped.ok) return shaped;
  }
  const s = shaped.result;
  let shapedRows = s.rows;
  let truncated = s.truncated, truncation = s.truncation, complete = s.complete;
  const retire = retireAt;
  if (retire && r.time) {
    // Retirements: the same shape on the retirement year, keyed by the opening year's field and marked, so the timeline draws them below zero.
    const second = await shapeRows(r.layer, {
      ...(r.area && { area: r.area }), ...(r.where.length > 0 && { where: r.where }),
      by: r.by ? [r.by] : [], measure: r.measure, time: { field: retire, bin: 'year' as const }, geometry: 'none',
    });
    if (!second.ok) return second;
    const q = second.result;
    shapedRows = [
      ...s.rows.map(x => ({ ...x, side: 'add' })),
      ...q.rows.filter(x => x[retire] !== null && x[retire] !== undefined)
        .map(x => { const row: ShapeRow = { ...x, [r.time!]: x[retire], side: 'retire' }; delete row[retire]; return row; }),
    ];
    if (q.truncated) { truncated = true; truncation = [truncation, q.truncation].filter(Boolean).join('; '); }
    complete = complete && q.complete;
  }
  const byFields = s.by.map(name => live(r.roles).find(f => f.name === name)!);
  const folds = byFields.flatMap(f => { const fo = foldOf(f); return fo ? [[f.name, fo] as [string, Fold]] : []; });
  const rows = foldRows(shapedRows, folds, [...s.by, ...(s.time ? [s.time] : []), ...(retire ? ['side'] : []), ...(s.bins ? ['bin'] : [])]);
  let features = s.features && folds.length
    ? s.features.map(f => ({ ...f, properties: Object.fromEntries(Object.entries(f.properties ?? {}).map(([k, v]) => {
      const fo = folds.find(x => x[0] === k)?.[1];
      return [k, fo && (typeof v === 'string' || typeof v === 'number' || v === null) ? fo.key(v) : v];
    })) }))
    : s.features;
  // Points to 1 m (5 decimals): the frame needs no more, and the payload stays well within its cap.
  if (features && r.def.geometry === 'point') features = features.map(roundPoint);

  const colours: Record<string, Record<string, string>> = {};
  const labels: Record<string, string> = {};
  for (const f of byFields) {
    const fo = folds.find(x => x[0] === f.name)?.[1];
    const present = new Set(rows.map(x => x[f.name]).filter((k): k is string | number => k !== null && k !== undefined).map(String));
    if (fo) {
      colours[f.name] = Object.fromEntries(Object.entries(fo.colour).filter(([k]) => present.has(k)));
      for (const k of present) if (fo.label[k]) labels[`value.${f.name}.${k}`] = fo.label[k];
    } else {
      const ranked = topGroups({ rows, labels: {}, colours: {} }, f.name, NEUTRAL.length).filter(g => g.key !== null && !g.other);
      colours[f.name] = Object.fromEntries(ranked.map((g, i) => [String(g.key), NEUTRAL[i]]));
    }
  }

  // compare-regions: the regions the panels show — the Area's own codes, else a `where` on the split
  // field, else the largest — at most MAX_REGIONS; the rows are cut to them, and the regions named.
  let panelRows = rows;
  if (r.def.id === 'compare-regions' && r.split) {
    const sp = r.split;
    const totals = new Map<string, number>();
    for (const x of rows) { const k = x[sp]; if (k !== null && k !== undefined && k !== 'none') totals.set(String(k), (totals.get(String(k)) ?? 0) + (x.sum ?? x.count)); }
    const asked = r.area && (r.area.kind === sp || areaFieldOf(layerById(r.layer)!.dataset!, r.area) === sp) ? r.area.codes.map(String)
      : r.where.find(c => c.field === sp && (c.op === 'contains_any' || c.op === 'in' || c.op === '='))?.value;
    const named = (Array.isArray(asked) ? asked : asked !== undefined ? [asked] : []).map(String).filter(k => totals.has(k));
    const ranked = (named.length ? named : [...totals.keys()]).sort((a, b) => totals.get(b)! - totals.get(a)!);
    const keep = new Set(ranked.slice(0, MAX_REGIONS));
    if (ranked.length > MAX_REGIONS) labels['cmp.more'] = t('template.cmp.more', { n: MAX_REGIONS, total: ranked.length });
    if (s.scope === 'view') labels['cmp.view'] = t('template.cmp.view');
    panelRows = rows.filter(x => keep.has(String(x[sp])));
    // A feature tagged with several of the panels' regions counts in each.
    if (rows.reduce((n, x) => n + x.count, 0) > s.totals.count) labels['cmp.overlap'] = t('template.overlay.overlap');
    if ((AREA_KINDS as readonly string[]).includes(sp)) {
      const table = await loadAreaLabels();
      for (const k of keep) labels[`value.${sp}.${k}`] ??= areaLabel(table, sp as AreaKind, k);
    }
  }
  // pies-per-region: a pie for each of the MAX_PIES largest regions (the Area's, a where's or the whole layer's),
  // the rows cut to them, the regions named and their outlines and centres sent (the frame draws no region it has no outline for).
  let centres: Record<string, [number, number]> | undefined;
  let pieNote = false;
  if (r.def.id === 'pies-per-region' && r.split) {
    const sp = r.split;
    const totals = new Map<string, number>();
    for (const x of rows) { const k = x[sp]; if (k !== null && k !== undefined && k !== 'none') totals.set(String(k), (totals.get(String(k)) ?? 0) + Math.abs(x.sum ?? x.count)); }
    const ranked = [...totals.keys()].sort((a, b) => totals.get(b)! - totals.get(a)!);
    const keep = new Set(ranked.slice(0, MAX_PIES));
    if (ranked.length > MAX_PIES) labels['pie.more'] = t('template.cmp.more', { n: MAX_PIES, total: ranked.length });
    panelRows = rows.filter(x => { const k = x[sp]; return k !== null && k !== undefined && keep.has(String(k)); });
    const table = await loadAreaLabels();
    for (const k of keep) labels[`value.${sp}.${k}`] = areaLabel(table, sp as AreaKind, k);
    if (rows.reduce((n, x) => n + x.count, 0) > s.totals.count) labels['pie.overlap'] = t('template.overlay.overlap');
    const outlines = await regionFeatures(sp, keep);
    if (!outlines?.length) labels['pie.noMap'] = t('template.overlay.noMap');
    else {
      features = outlines;
      centres = {};
      for (const f of outlines) { const c = regionCentre(f.geometry); if (c && typeof f.id === 'string') centres[f.id] = c; }
    }
    pieNote = true;
  }
  // flow: each region side's names, and the overlap note when a feature sits in several regions of a list.
  if (r.def.id === 'flow') {
    const kinds = byFields.filter(f => (AREA_KINDS as readonly string[]).includes(f.name));
    const table = kinds.length ? await loadAreaLabels() : null;
    for (const f of kinds) {
      for (const k of new Set(rows.map(x => x[f.name]).filter(k => k !== null && k !== undefined && k !== 'none').map(String))) {
        labels[`value.${f.name}.${k}`] ??= areaLabel(table!, f.name as AreaKind, k);
      }
    }
    if (rows.reduce((n, x) => n + x.count, 0) > s.totals.count) labels['flow.overlap'] = t('template.overlay.overlap');
    Object.assign(labels, { 'flow.hint': t('template.flow.hint'), 'flow.only': t('template.flow.only'), noData: t('template.noData'), smaller: t('template.smaller') });
  }
  // nearest: each point's distance to the nearest feature of layer2 (read whole: GeoJSON only), rows per
  // point {d_km, to}, rows[i] belonging to features[i]; `second` holds only the targets some point is nearest to, each once, without ids.
  let second: TemplatePayload['second'];
  let coverage: string | undefined, usOnly = !!s.usOnly;
  if (r.def.id === 'nearest' && r.layer2) {
    const q = await shapeRows(r.layer2, { ...(r.where2?.length && { where: r.where2 }), geometry: 'point', complete: true });
    if (!q.ok) return { ok: false, reason: `layer2 "${r.layer2}": ${q.reason}` };
    const targets = q.result.features ?? [];
    if (!targets.length) return { ok: false, reason: `layer2 "${r.layer2}" has no features${r.where2?.length ? ' that match where2' : ''} to measure to` };
    const xy = (f: GeoJSON.Feature): LonLat => f.geometry?.type === 'Point' ? [f.geometry.coordinates[0], f.geometry.coordinates[1]] : [NaN, NaN];
    const pts = features ?? [];
    const near = nearestOf(pts.map(xy), targets.map(xy));
    const used = new Map<number, number>(), kept: GeoJSON.Feature[] = [];
    panelRows = pts.map((_, i) => {
      const k = near.to[i];
      // A target is never an action's id, so it travels without one.
      if (k >= 0 && !used.has(k)) { used.set(k, kept.length); kept.push({ type: 'Feature', geometry: roundPoint(targets[k]).geometry, properties: targets[k].properties }); }
      return { d_km: Number.isFinite(near.km[i]) ? Math.round(near.km[i] * 100) / 100 : null, to: k >= 0 ? used.get(k)! : null, count: 1 };
    });
    second = { layer: r.layer2, credit: creditText(layerById(r.layer2)!.data!.credit), features: kept };
    const unit = getUnits().distance;
    Object.assign(labels, {
      'near.layer2': layerTitle(r.layer2), 'field.distance': t('template.near.distance', { unit }), 'field.nearest': t('template.near.nearest', { layer: layerTitle(r.layer2) }),
      'near.within': t('template.near.within'), 'near.beyond': t('template.near.beyond'), 'near.threshold': t('template.near.threshold'),
      'near.selectBeyond': t('template.near.selectBeyond'), 'near.tooMany': t('template.near.tooMany'), 'near.ecdf': t('template.near.ecdf'),
      'near.median': t('template.near.median'), 'near.none': t('template.near.none'), 'near.fly2': t('template.near.fly2'), 'field.id': t('template.near.id'),
      'near.far': t('template.near.far', { layer: layerTitle(r.layer2) }),
    });
    const cov = coverageArea(r.layer, r.layer2);
    if (cov && r.area && sameArea(r.area, cov)) { coverage = t('template.near.usOnly', { layer: layerTitle(r.layer2) }); usOnly = true; }
  }
  if (pieNote) Object.assign(labels, { 'pie.size': t('template.pies.size'), 'pie.only': t('template.flow.only'), noData: t('template.noData') });
  if (r.def.id === 'buildout-map') {
    Object.assign(labels, {
      'bo.play': t('template.bo.play'), 'bo.pause': t('template.bo.pause'), 'bo.total': t('template.bo.total'), 'bo.added': t('template.bo.added'),
      undated: t(s.timeBin === 'month' || live(r.roles).find(f => f.name === r.time)?.time === 'date' ? 'template.undatedDate' : 'template.undated'),
    });
  }
  const mLabel = measureLabel(s.measure, s.unit);
  const binUnit = s.bins && (r.roles.fields.find(f => f.name === s.bins!.field)?.unit ?? DERIVED_UNIT[s.bins.field]);
  const binLabel = s.bins ? measureLabel(s.bins.field, binUnit) : '';
  // A timeline reads "… by <year field>"; its groups are the legend's. A function, so the county legend can say it again in a new language.
  const titleOf = () => {
    if (r.title) return r.title;
    const layerName = layerTitle(r.layer), value = measureLabel(s.measure, s.unit);
    if (r.def.id === 'distribution') return t('template.titleDist', { layer: layerName, value: binLabel });
    if (r.def.id === 'nearest' && r.layer2) return t('template.titleNear', { layer: layerName, layer2: layerTitle(r.layer2) });
    if (r.def.id === 'buildout-map') return t('template.titleNoBy', { layer: layerName, template: t(r.def.nameKey) });
    if (r.def.id === 'pies-per-region' && byFields[1]) return t('template.titlePies', { layer: layerName, value, field: fieldLabel(byFields[0]), region: fieldLabel(byFields[1]) });
    if (r.def.id === 'flow' && byFields[1]) return t('template.titleFlow', { layer: layerName, value, from: fieldLabel(byFields[0]), to: fieldLabel(byFields[1]) });
    const titleField = r.def.id === 'timeline' && r.time ? humanise(r.time) : byFields[0] ? fieldLabel(byFields[0]) : '';
    return titleField ? t('chart.title', { layer: layerName, value, field: titleField }) : t('template.titleNoBy', { layer: layerName, template: t(r.def.nameKey) });
  };
  const title = titleOf();
  const locale = getLocale();
  for (const f of byFields) labels[`field.${f.name}`] = fieldLabel(f);
  if (s.time) labels[`field.${s.time}`] = humanise(s.time);
  if (s.measure !== 'count') labels[`field.${s.measure}`] = mLabel;
  if (s.bins) {
    labels[`field.${s.bins.field}`] = binLabel;
    // Each bin's and month's words, for the action's toast and the card's table.
    binLabels(s.bins.edges, locale).forEach((x, i) => { const v = binUnit ? `${x} ${binUnit}` : x; labels[`value.${s.bins!.field}.${i}`] = v; labels[`value.bin.${i}`] = v; });
  }
  if (s.time && s.timeBin === 'month') {
    for (const k of new Set(rows.map(x => x[s.time!]).filter((v): v is string => typeof v === 'string'))) labels[`value.${s.time}.${k}`] = monthText(k, locale);
  }
  for (const id of s.tiersHidden ?? []) labels[`tier.${id}`] = tierLabel(id);
  if (features) {
    Object.assign(labels, { 'field.longitude': t('template.longitude'), 'field.latitude': t('template.latitude') });
    for (const k of Object.keys(features[0]?.properties ?? {})) labels[`field.${k}`] ??= humanise(k);
  }
  if (retire) Object.assign(labels, { 'field.side': t('template.side'), 'value.side.add': t('template.modeAdded'), 'value.side.retire': t('template.modeRetired') });
  Object.assign(labels, {
    title, summary: title, locale, dir: getLocaleDef(locale).dir,
    scopeView: t('template.scopeView'), scopeArea: coverage ?? t(r.area ? 'template.scopeArea' : 'template.scopeAll'),
    partial: t('chart.partial'), truncated: t('template.truncated'), tiersHidden: t('template.tiersHidden'),
    table: t('template.table'), download: t('template.download'), csv: t('chart.csv'), png: t('chart.png'),
    unavailable: t('template.unavailable'), measure: mLabel, count: cap(t('chart.count')), other: t('chart.other'),
    none: t('template.none'),
    'density.hex': t('template.density.hex'), 'density.heat': t('template.density.heat'), 'density.orbit': t('template.density.orbit'),
    'density.low': t('template.density.low'), 'density.high': t('template.density.high'), 'density.largest': t('template.density.largest'),
    'act.where': t('template.act.where'), 'act.select': t('template.act.select'), 'act.fly': t('template.act.fly'), 'act.table': t('template.act.table'), 'density.top': t('template.density.top'),
  });
  let overlay: Overlay | undefined;
  let totalOnce: { count: number; sum?: number } | undefined;
  if (pieNote) totalOnce = s.totals;
  if (r.def.id === 'points-per-polygon' && byFields[0]?.role === 'region') {
    // A region list counts a feature under each of its codes: more tagged counts than features is an overlap.
    totalOnce = s.totals;
    const overlap = s.rows.reduce((n, x) => n + x.count, 0) > s.totals.count;
    const pr = await perRegion(byFields[0].name, rows, s.measure, titleOf, overlap, labels, colours);
    if (pr.features) features = pr.features;
    overlay = pr.overlay;
  }
  labels.summary = second ? title : summaryText({ rows: panelRows, labels, colours, roles: { by: byFields.map(f => ({ field: f.name, role: f.role })) } }, title);

  const params: Record<string, TemplateParam> = {
    ...(r.by && { by: r.by }), ...(r.split && { split: r.split }), measure: r.measure, ...(r.time && { time: r.time }), ...(r.def.params.top && { top: r.top }), ...(r.buckets && { buckets: r.buckets }),
    ...(r.title && { title: r.title }), ...(r.mode && { mode: r.mode }), ...(r.layer2 && { layer2: r.layer2 }), ...(r.within !== undefined && { within: r.within }),
  };
  const payload: TemplatePayload = {
    v: TEMPLATE_PAYLOAD_VERSION, template: r.def.id, params, scope: s.scope, rows: panelRows,
    ...(features && { features }), ...(centres && { centres }), ...(second && { second }), ...(totalOnce && { totalOnce }),
    roles: {
      by: byFields.map(f => ({ field: f.name, role: f.role })),
      measure: { name: s.measure, ...((s.unit ?? DERIVED_UNIT[s.measure]) && { unit: s.unit ?? DERIVED_UNIT[s.measure] }) },
      ...(s.time && { time: { field: s.time, bin: s.timeBin ?? 'year' } }),
      ...(s.bins && { bins: {
        field: s.bins.field, scale: s.bins.scale, edges: s.bins.edges, ...(s.bins.stats && { stats: s.bins.stats }),
        filter: binFilters(r.layer, s.bins.field, s.bins.edges),
      } }),
    },
    colours, labels, credit: [creditText(layerById(r.layer)!.data!.credit), ...(second ? [second.credit] : [])].join(' · '), units: { ...getUnits() },
    complete, truncated, ...(truncation && { truncation }),
    ...(s.tiersHidden && { tiersHidden: s.tiersHidden }), theme: 'light',
  };
  return { ok: true, result: { payload: capPayload(payload), total: s.totals, ...(s.unit && { unit: s.unit }), ...(s.tiersHidden && { tiersHidden: s.tiersHidden }), ...(overlay && { overlay }), ...(usOnly && { usOnly: true }) } };
}

const round5 = (v: number) => Math.round(v * 1e5) / 1e5;
/** A point feature with its coordinates to 5 decimals (≈ 1 m); any other geometry as it is. */
function roundPoint(f: GeoJSON.Feature): GeoJSON.Feature {
  const g = f.geometry;
  return g?.type === 'Point' ? { ...f, geometry: { type: 'Point', coordinates: [round5(g.coordinates[0]), round5(g.coordinates[1])] } } : f;
}

/** Whether year rows of `time` are recent enough to read by month: ≥ 90 % of the dated features in the last MONTHS_UP_TO_YEARS years. */
export function monthly(rows: readonly ShapeRow[], time: string): boolean {
  const dated = rows.filter(x => typeof x[time] === 'number');
  if (!dated.length) return false;
  const last = Math.max(...dated.map(x => x[time] as number));
  const all = dated.reduce((n, x) => n + x.count, 0);
  const recent = dated.filter(x => (x[time] as number) > last - MONTHS_UP_TO_YEARS).reduce((n, x) => n + x.count, 0);
  return recent >= 0.9 * all;
}

/** Whether a bin of `field` takes a map filter (a number field of the layer's schema; not length / area or a year in text). */
function binFilters(layer: string, field: string, edges: readonly number[]): boolean {
  return edges.length >= 2 && conditionForBin(layer, field, 0, { lo: edges[0], hi: edges[1] }).ok;
}

const jsonBytes = (v: unknown) => new TextEncoder().encode(JSON.stringify(v)).length;

/** The longest prefix length n of `list` with `size(n)` ≤ max (0 when none fits), from a proportional guess down. */
function fitCount(list: readonly unknown[], max: number, size: (n: number) => number): number {
  const all = size(list.length), none = size(0);
  if (all <= max) return list.length;
  let n = Math.floor(list.length * Math.max(0, max - none) / Math.max(1, all - none));
  while (n > 0 && size(n) > max) n = Math.floor(n * 0.9);
  return n;
}

/** `p` within `max` bytes of JSON: its features cut first, then its rows, each cut
 *  marked `truncated` and named in `truncation` (never silent). */
export function capPayload(p: TemplatePayload, max = MAX_TEMPLATE_INPUT_BYTES): TemplatePayload {
  if (jsonBytes(p) <= max) return p;
  const mb = `${Math.round(max / 1048576 * 10) / 10} MB`;
  const notes: string[] = [];
  let out = p;
  if (p.features?.length) {
    const n = fitCount(p.features, max, k => jsonBytes({ ...out, features: p.features!.slice(0, k) }));
    out = { ...out, features: p.features.slice(0, n) };
    notes.push(`features cut to ${n.toLocaleString('en')} of ${p.features.length.toLocaleString('en')} to stay within ${mb}`);
  }
  if (jsonBytes(out) > max && p.rows.length) {
    const n = fitCount(p.rows, max, k => jsonBytes({ ...out, rows: p.rows.slice(0, k) }));
    out = { ...out, rows: p.rows.slice(0, n) };
    notes.push(`rows cut to ${n.toLocaleString('en')} of ${p.rows.length.toLocaleString('en')} to stay within ${mb}`);
  }
  return { ...out, truncated: true, truncation: [p.truncation, ...notes].filter(Boolean).join('; ') };
}

/** The accessible one-line summary: the title and the top three groups. */
function summaryText(p: Pick<TemplatePayload, 'rows' | 'labels' | 'colours'> & { roles: Pick<TemplatePayload['roles'], 'by'> }, title: string): string {
  const by = p.roles.by[0]?.field;
  if (!by) return title;
  const top = topGroups(p, by, 3).filter(g => !g.other).map(g => `${g.label} ${Math.round(g.value).toLocaleString(p.labels.locale)}`);
  return top.length ? `${title}: ${top.join(', ')}` : title;
}

/** The rows a vega template injected, as the card's Table shows them: group values by
 *  their legend labels, headings as kit.js's (the field label, Count, the measure). */
export function tableOf(p: TemplatePayload, rows: Row[]): NonNullable<RenderExtra['table']> {
  const keys = [...new Set(rows.flatMap(x => Object.keys(x)))];
  const order = [...keys.filter(k => k !== 'count' && k !== 'sum'), ...keys.filter(k => k === 'count'), ...keys.filter(k => k === 'sum')];
  const unit = p.roles.measure.unit;
  const heading = (k: string) => k === 'count' ? p.labels.count ?? k
    : k === 'sum' ? (unit && !(p.labels.measure ?? '').includes(`(${unit})`) ? `${p.labels.measure} (${unit})` : p.labels.measure ?? k)
    : p.labels[`field.${k}`] ?? humanise(k);
  return {
    columns: order.map(k => [k, heading(k)]),
    rows: rows.map(x => Object.fromEntries(order.map(k => [k, typeof x[k] === 'string' || typeof x[k] === 'number' ? p.labels[`value.${k}.${x[k]}`] ?? x[k] : x[k]]))),
  };
}

/** A vega template's group labels → the row keys they stand for (null: "Other" or none), from its data. */
export function groupKeys(spec: Record<string, unknown>, read = 'label', keyField = 'key'): Map<string, string | number | null> {
  const out = new Map<string, string | number | null>();
  const values = (spec.data as { values?: unknown } | undefined)?.values;
  for (const v of Array.isArray(values) ? values : []) {
    const d = (v ?? {}) as Record<string, unknown>;
    const label = d[read], key = d[keyField];
    if (typeof label === 'string' && !out.has(label)) out.set(label, typeof key === 'string' || typeof key === 'number' ? key : null);
  }
  return out;
}

/** kit.js and a template's script as one page for the frame. */
export function templateHtml(kit: string, source: string): string {
  if (/<\/script/i.test(kit) || /<\/script/i.test(source)) throw new Error('a template script may not contain </script');
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><script>${kit}\n</script><script>${source}\n</script></body></html>`;
}

// ─── Show ────────────────────────────────────────────────────────────────────
export async function showTemplate(args: unknown, host: TemplateHost): Promise<Outcome<ShowTemplateResult>> {
  const v = validateTemplateArgs(args);
  if (!v.ok) return v;
  const r = v.result;
  const built = await buildPayload(r);
  if (!built.ok) return built;
  const { payload, total, unit, tiersHidden, overlay, usOnly } = built.result;
  if (!host.render) return { ok: false, reason: 'unavailable' };
  // Per county: the main map is painted (session only, one at a time) and the card owns it.
  const token = overlay ? paintCountyOverlay(overlay.colours, overlay.legend) : undefined;

  const template: TemplateRender = { kind: 'template', templateId: r.def.id, layer: r.layer, params: renderParams(r) };
  const act = { templateId: r.def.id, layer: r.layer, payload, where: r.where, ...((r.def.id === 'points-per-polygon' || r.def.id === 'pies-per-region') && { regions: true }) };
  const partial = payload.complete && !payload.truncated ? [] : [layerTitle(r.layer)];
  const title = payload.labels.title;
  const src = r.def.source!;
  let outcome;
  try {
    if (src.kind === 'vega') {
      const spec = (await src.load())(payload);
      const rows = payload.rows.map(x => Object.fromEntries(Object.entries(x).filter(([, val]) => val !== undefined)) as Row);
      const signals: SignalAction[] = [];
      const labels = new Map<string, Map<string, string | number | null>>();
      for (const pk of VEGA_PICK[r.def.id] ?? []) {
        const field = pickField(payload, pk.of);
        if (!field) continue;
        signals.push({ signal: pk.signal, kind: 'where', layer: r.layer, field, read: pk.read });
        if (pk.read !== pk.key) labels.set(field, groupKeys(spec, pk.read, pk.key));
      }
      const onAction = templateActions({ ...act, labels });
      outcome = await host.render('vega', title, spec, undefined, { csv: () => rowsCsv(rows, title, [r.layer]), table: tableOf(payload, rows), partial, template, onAction, signals });
    } else {
      const [kit, code] = await Promise.all([import('./html/kit.js?raw').then(m => m.default), src.load()]);
      const html = templateHtml(kit, code);
      if (html.length > MAX_TEMPLATE_HTML) { if (token !== undefined) clearCountyOverlay(token, { restore: true }); return { ok: false, reason: 'too-large' }; }
      outcome = await host.render('html', title, html, payload, { partial, template, onAction: templateActions(act), ...(token !== undefined && { overlay: token }) });
    }
  } catch {
    if (token !== undefined) clearCountyOverlay(token, { restore: true });
    return { ok: false, reason: 'unavailable' };
  }
  if ('error' in outcome) {
    if (token !== undefined) clearCountyOverlay(token, { restore: true });
    return { ok: false, reason: (TOLD as readonly string[]).includes(outcome.error) ? outcome.error : 'runtime' };
  }
  return { ok: true, result: {
    shown: true, template: r.def.id, layer: r.layer, scope: payload.scope, complete: payload.complete,
    ...(!payload.complete && { partial: true as const }),
    ...(payload.truncated && { truncated: payload.truncation ?? 'rows were cut' }),
    ...(tiersHidden && { tiersHidden }),
    summary: summarise(payload, total, r.measure, unit ?? DERIVED_UNIT[r.measure] ?? r.roles.fields.find(f => f.name === r.measure)?.unit, usOnly),
  } };
}

