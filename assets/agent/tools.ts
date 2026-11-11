// ─── Agent tools: the map API as model tool schemas, and their dispatcher ────
// Role: what the map chat offers a model, and the one gate its calls pass.
//         toolSchemas()          OpenAI-format `tools` (function name,
//                                description, JSON-schema parameters); the
//                                enums — layer ids, the queryable layers
//                                (the data tools take the id as a string, and
//                                dataset-query / validateWhere refuse any
//                                other layer; describe says queryable:false), filter
//                                ops, area kinds, basemaps — are read from the
//                                registry each call, so a new layer needs no
//                                edit here. Field names stay out: `describe`
//                                returns them per dataset, which keeps the
//                                prompt small.
//         dispatch(name, args, opts)  parses the model's JSON arguments,
//                                checks them against that tool's schema
//                                (checkArgs: own keys only, so `constructor`
//                                or `__proto__` is an unknown argument), and
//                                only then calls map-api.ts.
//                                Never throws; returns map-api's Outcome.
//                                A refusal naming an unknown layer, field,
//                                operator or value gets a "try:" hint (refusalHint)
//                                so the model's retry has something to go on.
//       A tool that sends model text off the page (fitTo with a place → the
//       Esri geocoder) runs only after opts.confirm(request) resolves true;
//       without a confirm callback it is refused. addService with a `url` is
//       the same: the card carries the full normalised URL, its host and a
//       "not on the vetted list" line, and the URL is approved for the
//       session only then; a `libraryId` add is not off-page.
//       runAnalysis takes `chart` (bar | pie | line, or a Vega-Lite spec without
//       data): it passes chart-spec.ts validateChart / vega-spec.ts
//       validateVegaLite, and the model sees only `chartOutcome`
//       ({chartShown} | {chartError, chartMessage?}), never the spec or rows
//       (loop.ts toolContent). No render callback → chartError 'unavailable'.
//       copyToMyData copies a queryable layer's features into My Data (map-api
//       copyToMyData). Not offPage: it asks inside the call above 50 features in
//       total for each ask (opts.copied); the model sees counts only (chat trust model).
//       showCanvas shows a model-written page in the canvas frame through
//       opts.render('html', …) (ui-chat.ts shows its code first). The model gets
//       {shown, partial?} or a refusal whose reason is a bare category, nothing
//       the frame computed or said, since its code may load third-party scripts
//       (chat trust model, Frames). Not an offPage confirm: its carve-out.
//       showTemplate shows a page-owned template (templates/show-template.ts,
//       which checks the loosely typed arguments) through opts.render. The model
//       gets the page's figures only, or a refusal whose reason may list valid
//       fields; never rows or frame text. No code chip, not offPage.
//       Loaded with the chat chunk, never the main bundle: nothing outside
//       assets/agent/ imports it.
//
// Deps: map-api.ts (every call), registry (LAYERS, layerById), field-schema.ts (FieldOp),
//       area-filter.ts (AREA_KINDS), region-codes.ts (STATE_TO_ADMIN1: the states hint on world layers),
//       condition-compile.ts (MAX_LIST_VALUES),
//       view-validate.ts (MAX_SELECTION_IDS), dataset-query.ts (QUERY_MAX_ROWS, capRows),
//       spatial-join.ts (limits), runAnalysis / layerRows (map-api.ts: registry layers only, allowed
//       fields, capped result; its code is shown to the visitor by ui-chat.ts first), services/service-spec.ts + service-hosts.ts (addService's schema and
//       its confirm card), chart-spec.ts (CHART_TYPES, validateChart),
//       vega-spec.ts (validateVegaLite, row injection, rowsCsv), i18n (t: layer titles),
//       sandbox/canvas-host.ts (types only: DispatchOpts.render, which ui-chat.ts supplies),
//       sandbox/sandbox-host.ts (MAX_INPUT_CHARS, MAX_INPUT_FEATURES), map-api.ts layerRows (showCanvas layers),
//       templates/catalogue.ts (ready ids), templates/show-template.ts (showTemplate).

import * as api from '../map-api.js';
import { LAYERS, layerById } from '../../src/registry/index.js';
import { FIELD_SCHEMA, type FieldOp } from '../../src/registry/field-schema.js';
import { AREA_KINDS } from '../../src/registry/area-filter.js';
import { STATE_TO_ADMIN1 } from '../../src/registry/region-codes.js';
import { MAX_LIST_VALUES } from '../../src/registry/condition-compile.js';
import { MAX_SELECTION_IDS } from '../../src/registry/view-validate.js';
import { QUERY_MAX_ROWS, capRows } from '../dataset-query.js';
import { SERVICE_KINDS, MAX_SERVICE_URL, normaliseServiceUrl } from '../services/service-spec.js';
import { isVetted } from '../services/service-hosts.js';
import { MAX_LINE_VERTICES, MAX_CROSSING_LAYERS } from '../spatial-join.js';
import { CHART_TYPES, validateChart, type Chart, type ChartType } from '../chart-spec.js';
import { validateVegaLite, rowsFromValue, vegaWithData, vegaTitle, rowsCsv, type Row } from '../vega-spec.js';
import type { CanvasKind, CanvasOutcome, SignalAction, TemplateAction } from '../sandbox/canvas-host.js';
import { MAX_INPUT_CHARS, MAX_INPUT_FEATURES } from '../sandbox/sandbox-host.js';
import { t } from '../../src/i18n/index.js';
import { CATALOGUE } from '../templates/catalogue.js';
import { showTemplate } from '../templates/show-template.js';
import { planRouteFromChat, type ChatRouteRequest } from '../ui/route-panel-open.js';

// ─── A JSON-schema subset: what the tool schemas below use, and no more ──────

export interface Schema {
  type?: SchemaType | SchemaType[];
  description?: string;
  enum?: readonly unknown[];
  properties?: Record<string, Schema>;
  required?: string[];
  additionalProperties?: boolean | Schema;
  items?: Schema;
  minItems?: number;
  maxItems?: number;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
}
type SchemaType = 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null';

function typeOf(v: unknown): SchemaType | 'other' {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : Number.isFinite(v) ? 'number' : 'other';
  if (typeof v === 'object') return 'object';
  return typeof v === 'string' || typeof v === 'boolean' ? typeof v as SchemaType : 'other';
}

/** Why `v` does not fit `s` (with the path to the offending value), or null. */
export function checkArgs(v: unknown, s: Schema, path = 'args'): string | null {
  if (s.type) {
    const want = Array.isArray(s.type) ? s.type : [s.type];
    const got = typeOf(v);
    if (!want.includes(got as SchemaType) && !(got === 'integer' && want.includes('number'))) {
      return `${path} must be ${want.join(' or ')}`;
    }
  }
  if (s.enum && !s.enum.includes(v)) return `${path} must be one of ${s.enum.map(e => JSON.stringify(e)).join(', ')}`;
  if (typeof v === 'number') {
    if (s.minimum !== undefined && v < s.minimum) return `${path} must be ≥ ${s.minimum}`;
    if (s.maximum !== undefined && v > s.maximum) return `${path} must be ≤ ${s.maximum}`;
  }
  if (typeof v === 'string') {
    if (s.minLength !== undefined && v.length < s.minLength) return `${path} must be at least ${s.minLength} characters`;
    if (s.maxLength !== undefined && v.length > s.maxLength) return `${path} must be at most ${s.maxLength} characters`;
  }
  if (Array.isArray(v)) {
    if (s.minItems !== undefined && v.length < s.minItems) return `${path} needs at least ${s.minItems} items`;
    if (s.maxItems !== undefined && v.length > s.maxItems) return `${path} takes at most ${s.maxItems} items`;
    if (s.items) for (let i = 0; i < v.length; i++) {
      const e = checkArgs(v[i], s.items, `${path}[${i}]`);
      if (e) return e;
    }
  }
  if (typeOf(v) === 'object') {
    const o = v as Record<string, unknown>;
    for (const k of s.required ?? []) if (!Object.hasOwn(o, k)) return `${path}.${k} is required`;
    for (const [k, val] of Object.entries(o)) {
      const sub = (s.properties && Object.hasOwn(s.properties, k) ? s.properties[k] : undefined)
        ?? (typeof s.additionalProperties === 'object' ? s.additionalProperties : undefined);
      if (!sub) {
        if (s.additionalProperties === false || s.properties) return `${path}.${k} is not a known argument`;
        continue;
      }
      const e = checkArgs(val, sub, `${path}.${k}`);
      if (e) return e;
    }
  }
  return null;
}

// ─── The tools ────────────────────────────────────────────────────────────────

const OP_SET: Record<FieldOp, true> = {
  '=': true, '!=': true, '<': true, '<=': true, '>': true, '>=': true,
  in: true, not_in: true, contains: true, contains_any: true, has: true,
};
const OPS = Object.keys(OP_SET);

// An object of exactly these properties: checkArgs refuses any other key, so
// `additionalProperties: false` is left implied to keep the prompt short.
const obj = (properties: Record<string, Schema>, required: string[] = []): Schema =>
  ({ type: 'object', properties, ...(required.length && { required }) });

interface ToolDef {
  name: string;
  description: string;
  parameters: () => Schema;
  run: (a: Record<string, unknown>, o: DispatchOpts) => api.Outcome<unknown> | Promise<api.Outcome<unknown>>;
  /** What this call would send off the page, and to whom — asked of the visitor first. */
  offPage?: (a: Record<string, unknown>) => OffPageRequest | null;
}

export interface OffPageRequest { tool: string; host: string; text: string; note?: string }

function enums() {
  const layers = LAYERS.map(l => l.id);
  const layer: Schema = { enum: layers };
  const layerRef: Schema = { type: 'string', description: 'a layer id from listLayers' };
  const datasetRef: Schema = { type: 'string', description: 'a layer id listLayers marks queryable' };
  const condition = obj({
    field: { type: 'string' },
    op: { enum: OPS },
    value: { description: 'array for in, not_in, contains_any; none for has' },
  }, ['field', 'op']);
  const whereList: Schema = { type: 'array', items: condition, maxItems: 20 };
  const where: Schema = { ...whereList, description: 'all must hold; fields from describe' };
  const area: Schema = {
    ...obj({
      kind: { enum: AREA_KINDS },
      codes: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: MAX_LIST_VALUES },
    }, ['kind', 'codes']),
    type: ['object', 'null'],
  };
  const filters = { where: whereList, area, asDrawn: { type: 'boolean', description: 'only what the map filters pass' } } as Record<string, Schema>;
  return { layer, layerRef, datasetRef, where, area, filters };
}

const CHART: Schema = { type: ['string', 'object'], description: 'bar|pie|line, or a Vega-Lite spec without data' };

/** The `chart` argument: absent, one of CHART_TYPES, or a checked Vega-Lite spec. */
type ChartArg = { type: ChartType } | { vega: Record<string, unknown> } | null;
function chartArg(v: unknown): api.Outcome<ChartArg> {
  if (v === undefined) return { ok: true, result: null };
  if (typeof v === 'string') {
    return CHART_TYPES.includes(v as ChartType) ? { ok: true, result: { type: v as ChartType } }
      : { ok: false, reason: `args.chart must be one of ${CHART_TYPES.map(c => JSON.stringify(c)).join(', ')} or a Vega-Lite spec` };
  }
  const s = validateVegaLite(v);
  return s.ok ? { ok: true, result: { vega: s.result } } : { ok: false, reason: `the chart was not shown: ${s.reason}` };
}

/** What a model is told of a Vega chart: shown, or why not — never the spec or rows. */
export type ChartOutcome = { chartShown: true } | { chartError: 'invalid-spec' | 'unavailable' | 'timeout'; chartMessage?: string };
const MAX_CHART_MESSAGE = 300;

/** Show a Vega-Lite chart of `rows` through opts.render; the card's CSV is built here from the same rows. */
async function renderVega(o: DispatchOpts, spec: Record<string, unknown>, rows: Row[], title: string, layers: string[]): Promise<ChartOutcome> {
  if (!o.render) return { chartError: 'unavailable' };
  const r = await o.render('vega', title, vegaWithData(spec, rows), undefined, { csv: () => rowsCsv(rows, title, layers) }).catch(() => null);
  if (!r) return { chartError: 'unavailable' };
  if ('shown' in r) return { chartShown: true };
  if (r.error === 'invalid-spec') return { chartError: 'invalid-spec', ...(r.message && { chartMessage: r.message.slice(0, MAX_CHART_MESSAGE) }) };
  return { chartError: r.error === 'timeout' ? 'timeout' : 'unavailable' };
}

const layerTitle = (id: string) => { const l = layerById(id); return l ? t(l.titleKey) : id; };

const MAX_CANVAS_HTML = 60_000;
const MAX_CANVAS_LAYERS = 4;
/** What a canvas may tell the model: a category, never the frame's message. */
const CANVAS_TOLD = ['syntax', 'runtime', 'timeout', 'too-large', 'unavailable', 'library'] as const;

/** showCanvas: the layers' rows (map-api layerRows, the runAnalysis path) as
 *  TM_INPUT, then the page in the canvas frame. The result is {shown, partial?}
 *  or a refusal whose reason is a bare category — nothing the frame said. */
async function showCanvas(a: Record<string, unknown>, o: DispatchOpts): Promise<api.Outcome<unknown>> {
  const layers = (a.layers ?? []) as api.LayerInput[];
  let inputs: Record<string, GeoJSON.FeatureCollection> = {};
  let partial: string[] = [];
  if (layers.length) {
    const r = await api.layerRows(layers, MAX_CANVAS_LAYERS);
    if (!r.ok) return r;
    ({ fc: inputs, partial } = r.result);
    const n = Object.values(inputs).reduce((s, fc) => s + fc.features.length, 0);
    if (n > MAX_INPUT_FEATURES) return { ok: false, reason: `the layers have ${n} features, over ${MAX_INPUT_FEATURES}: lower limit or pass fewer layers` };
    if (JSON.stringify(inputs).length > MAX_INPUT_CHARS) return { ok: false, reason: `the layers are over ${MAX_INPUT_CHARS / 1048576} MB: pass fewer fields, a lower limit or fewer layers` };
  }
  if (!o.render) return { ok: false, reason: 'unavailable' };
  const r = await o.render('html', a.title as string, a.html, inputs, { partial: partial.map(layerTitle) }).catch(() => null);
  if (!r) return { ok: false, reason: 'unavailable' };
  if ('shown' in r) return { ok: true, result: { shown: true, ...(partial.length && { partial }) } };
  return { ok: false, reason: (CANVAS_TOLD as readonly string[]).includes(r.error) ? r.error : 'runtime' };
}

const READY_TEMPLATES = CATALOGUE.filter(d => d.ready).map(d => d.id);

const TOOLS: ToolDef[] = [
  {
    name: 'listLayers', description: 'Every map layer: id, title, group, on, queryable.',
    parameters: () => obj({}), run: () => api.listLayers(),
  },
  {
    name: 'setLayerVisible', description: 'Switch a map layer on or off.',
    parameters: () => obj({ layerId: enums().layer, on: { type: 'boolean' } }, ['layerId', 'on']),
    run: a => api.setLayerVisible(a.layerId as string, a.on as boolean),
  },
  {
    name: 'setWhere', description: "Filter a layer by field conditions (replaces them; [] clears).",
    parameters: () => obj({ layerId: enums().datasetRef, conditions: enums().where }, ['layerId', 'conditions']),
    run: a => api.setWhere(a.layerId as string, a.conditions as never),
  },
  {
    name: 'setArea', description: 'Filter every layer to a region (null clears the area).',
    parameters: () => obj({
      area: { ...enums().area, description: 'codes: USPS states (TX), 5-digit county GEOIDs, EIA BA codes, NERC regions, ISO3 countries' },
    }, ['area']),
    run: a => api.setArea(a.area as never),
  },
  {
    name: 'setStyle', description: "Change a layer's opacity, size (multiplier) or colour (#rrggbb).",
    parameters: () => obj({
      layerId: enums().layerRef,
      opacity: { type: 'number', minimum: 0, maximum: 1 },
      size: { type: 'number', minimum: 0.25, maximum: 4 },
      color: { type: 'string', maxLength: 32 },
    }, ['layerId']),
    run: ({ layerId, ...style }) => api.setStyle(layerId as string, style),
  },
  {
    name: 'clearStyle', description: "Remove a layer's style changes (every layer's without layerId).",
    parameters: () => obj({ layerId: enums().layerRef }),
    run: a => api.clearStyle(a.layerId as string | undefined),
  },
  {
    name: 'setBasemap', description: 'Change the basemap.',
    parameters: () => obj({ basemap: { enum: api.BASEMAPS } }, ['basemap']),
    run: a => api.setBasemap(a.basemap as string),
  },
  {
    name: 'setCamera', description: 'Move the camera: center [lng, lat], zoom, bearing, pitch.',
    parameters: () => obj({
      center: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 },
      zoom: { type: 'number', minimum: 0, maximum: 22 },
      bearing: { type: 'number', minimum: -360, maximum: 360 },
      pitch: { type: 'number', minimum: 0, maximum: 85 },
    }),
    run: a => api.setCamera(a),
  },
  {
    name: 'fitTo', description: 'Fit the map to a bbox [w, s, e, n] or a place name (asks the visitor).',
    parameters: () => obj({
      bbox: { type: 'array', items: { type: 'number' }, minItems: 4, maxItems: 4 },
      place: { type: 'string', minLength: 2, maxLength: 120 },
    }),
    run: a => api.fitTo(a),
    offPage: a => (typeof a.place === 'string' ? { tool: 'fitTo', host: 'geocode-api.arcgis.com', text: a.place } : null),
  },
  {
    name: 'describe', description: "A queryable layer's fields, operators, domains, row count, credit. Call before filtering.",
    parameters: () => obj({ layerId: enums().datasetRef }, ['layerId']),
    run: a => api.describe(a.layerId as string),
  },
  {
    name: 'query', description: "Rows of a queryable layer (a capped summary; showTable shows the visitor all).",
    parameters: () => obj({
      layerId: enums().datasetRef, ...enums().filters,
      fields: { type: 'array', items: { type: 'string' }, maxItems: 30 },
      orderBy: obj({ field: { type: 'string' }, desc: { type: 'boolean' } }, ['field']),
      limit: { type: 'integer', minimum: 1, maximum: QUERY_MAX_ROWS },
    }, ['layerId']),
    run: ({ layerId, ...opts }) => api.query(layerId as string, opts),
  },
  {
    name: 'count', description: 'How many features of a queryable layer match.',
    parameters: () => obj({ layerId: enums().datasetRef, ...enums().filters }, ['layerId']),
    run: ({ layerId, ...opts }) => api.count(layerId as string, opts),
  },
  {
    name: 'aggregate', description: 'Count per group of a field, plus sums of number fields.',
    parameters: () => obj({
      layerId: enums().datasetRef, ...enums().filters,
      groupBy: { type: 'string' },
      sum: { type: 'array', items: { type: 'string' }, maxItems: 5 },
    }, ['layerId', 'groupBy']),
    run: ({ layerId, ...opts }) => api.aggregate(layerId as string, opts as never),
  },
  {
    name: 'setSelection', description: 'Select features by id: isolate draws only them, keep adds them past the filters. null clears.',
    parameters: () => obj({
      selection: {
        ...obj({
          mode: { enum: ['isolate', 'keep'] },
          ids: { type: 'object', additionalProperties: { type: 'array', items: { type: ['string', 'integer'] }, maxItems: MAX_SELECTION_IDS } },
        }, ['mode', 'ids']),
        type: ['object', 'null'],
        description: 'ids: layer id → feature ids',
      },
    }, ['selection']),
    run: a => api.setSelection(a.selection as never),
  },
  {
    name: 'showTable', description: "Show the visitor a queryable layer's rows in the table.",
    parameters: () => obj({
      layerId: enums().datasetRef, ...enums().filters,
      ids: { type: 'array', items: { type: ['string', 'integer'] }, maxItems: MAX_SELECTION_IDS },
    }, ['layerId']),
    run: a => api.showTable(a as never),
  },
  {
    name: 'copyToMyData', description: "Copy a queryable layer's features (as showTable picks them) into My Data.",
    parameters: () => obj({
      layerId: { type: 'string' },
      ids: { type: 'array', maxItems: MAX_SELECTION_IDS },
      where: { type: 'array', items: { type: 'object' }, maxItems: 20 },
      area: { type: ['object', 'null'] },
    }, ['layerId']),
    run: async (a, o) => {
      const r = await api.copyToMyData(a as never, {
        confirmAbove: Math.max(0, COPY_CONFIRM_ABOVE - (o.copied?.n ?? 0)),
        confirm: o.confirm && ((_n, name) => o.confirm!({ tool: 'copyToMyData', host: '', text: name })),
      });
      if (r.ok && r.result.outcome === 'copied' && o.copied) o.copied.n += r.result.n;
      return r;
    },
  },
  {
    name: 'joinPoints', description: 'Count a layer\'s points in each polygon of another layer. Check complete, precision.',
    parameters: () => obj({
      points: enums().datasetRef, polygons: enums().datasetRef,
      where: { type: 'array', items: { type: 'object' }, maxItems: 20, description: 'conditions on points, as in query' },
    }, ['points', 'polygons']),
    run: async a => capJoin(await api.joinPoints(a as never)),
  },
  {
    name: 'crossings', description: 'Polygons a GeoJSON LineString crosses or starts in. Check complete, precision.',
    parameters: () => obj({
      geometry: obj({
        type: { enum: ['LineString'] },
        coordinates: { type: 'array', items: { type: 'array', items: { type: 'number' } }, maxItems: MAX_LINE_VERTICES },
      }, ['type', 'coordinates']),
      polygons: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: MAX_CROSSING_LAYERS },
    }, ['geometry', 'polygons']),
    run: async a => capJoin(await api.crossings(a as never)),
  },
  {
    name: 'runAnalysis', description: 'Run JavaScript in a no-network sandbox; the visitor sees the code. input[layerId] is a FeatureCollection; return JSON. Helpers: areaKm2, lengthKm, bbox. chart bar|pie|line: return {title, categories, series:[{name,values}]}; Vega-Lite: return flat rows.',
    parameters: () => obj({
      code: { type: 'string', maxLength: 20_000 },
      inputs: {
        type: 'array', minItems: 1, maxItems: 3,
        items: obj({
          layer: { type: 'string' },
          where: enums().filters.where,
          fields: { type: 'array', items: { type: 'string' }, maxItems: 30 },
          limit: { type: 'integer', minimum: 1, maximum: QUERY_MAX_ROWS },
        }, ['layer']),
      },
      chart: CHART,
    }, ['code', 'inputs']),
    run: async (a, o) => {
      const want = chartArg(a.chart);
      if (!want.ok) return want;
      const r = await api.runAnalysis(a.code as string, a.inputs as never, { signal: o.signal });
      const capped = capAnalysis(r);
      if (!r.ok || !capped.ok || !want.result) return capped;
      const v = r.result.value;
      if ('vega' in want.result) {
        const rows = rowsFromValue(v);
        const layers = r.result.inputs.map(i => i.layer);
        const chartOutcome: ChartOutcome = rows
          ? await renderVega(o, want.result.vega, rows, vegaTitle(want.result.vega) ?? layers.map(layerTitle).join(', '), layers)
          : { chartError: 'invalid-spec', chartMessage: 'return an array of flat objects' };
        return { ok: true, result: { ...(capped.result as object), chartOutcome } };
      }
      const c = validateChart(v && typeof v === 'object' && !Array.isArray(v) ? { ...v, type: want.result.type } : v);
      if (!c.ok) return { ok: false, reason: `the chart was not shown: ${c.reason}` };
      const chart: Chart = { ...c.result, layers: r.result.inputs.map(i => i.layer), complete: r.result.complete };
      return { ok: true, result: { ...(capped.result as object), chart } };
    },
  },
  {
    name: 'showCanvas', description: 'Draw a custom view (HTML+JS) in a sandboxed frame. Data: window.TM_INPUT[layerId] = GeoJSON FeatureCollection. Returns shown or an error category only.',
    parameters: () => obj({
      title: { type: 'string', maxLength: 120 },
      html: { type: 'string', maxLength: MAX_CANVAS_HTML },
      layers: {
        type: 'array', maxItems: MAX_CANVAS_LAYERS,
        items: obj({
          layer: { type: 'string' },
          fields: { type: 'array', items: { type: 'string' }, maxItems: 30 },
          limit: { type: 'integer', minimum: 1, maximum: QUERY_MAX_ROWS },
        }, ['layer']),
      },
    }, ['title', 'html']),
    run: showCanvas,
  },
  {
    name: 'showTemplate', description: "Show a standard chart or map of a layer. Omit params for defaults; a refusal lists valid fields. Returns shown and the page's final figures, or a reason.",
    parameters: () => {
      const e = enums();
      return obj({
        template: { enum: READY_TEMPLATES },
        layer: e.datasetRef,
        area: e.area,
        where: e.filters.where,
        by: { type: 'string', description: 'field to group by' },
        split: { type: 'string', description: 'second field' },
        measure: { type: 'string' },
        time: { type: 'string' },
        top: { type: 'integer', minimum: 3, maximum: 30 },
        buckets: { type: 'integer', minimum: 5, maximum: 40, description: 'distribution: about this many bins' },
        mode: { enum: ['additions', 'net'], description: 'timeline: net adds retirements' },
        title: { type: 'string', maxLength: 120 },
        layer2: { type: 'string', description: 'nearest: a GeoJSON point layer' },
        where2: { type: 'array', items: { type: 'object' } },
        within: { type: 'number', description: 'km' },
      }, ['template', 'layer']);
    },
    run: async (a, o) => (o.render ? showTemplate(a, { render: o.render }) : { ok: false, reason: 'unavailable' }),
  },
  {
    name: 'addService', description: 'Add a GIS service: libraryId (curated) or url (https; the visitor is asked first).',
    parameters: () => obj({
      libraryId: { type: 'string', maxLength: 64 },
      url: { type: 'string', maxLength: MAX_SERVICE_URL },
      kind: { enum: SERVICE_KINDS },
      layer: { type: 'string', maxLength: 200 },
      title: { type: 'string', maxLength: 200 },
      color: { type: 'string', maxLength: 9 },
      opacity: { type: 'number', minimum: 0, maximum: 1 },
      draw: { enum: ['fill', 'line', 'circle'] },
    }),
    run: a => api.addService(a, { confirmed: typeof a.url === 'string' }),
    offPage: a => {
      if (typeof a.url !== 'string') return null;
      const n = normaliseServiceUrl(a.url, a.kind as never);
      const url = n.ok ? n.result.url : a.url;
      let host = '';
      try { host = new URL(url).hostname; } catch { /* the call is refused by the validators */ }
      return { tool: 'addService', host, text: url, ...(!isVetted(url, a.kind as never) && { note: 'not on the vetted list' }) };
    },
  },
  {
    name: 'removeService', description: 'Remove a linked service by id (from listServices).',
    parameters: () => obj({ id: { type: 'string', maxLength: 32 } }, ['id']), run: a => api.removeService(a.id as string),
  },
  { name: 'listServices', description: 'Linked services.', parameters: () => obj({}), run: () => api.listServices() },
  { name: 'undo', description: 'Undo the last change to the view.', parameters: () => obj({}), run: () => api.undo() },
  { name: 'redo', description: 'Redo the last undone change.', parameters: () => obj({}), run: () => api.redo() },
  { name: 'reset', description: 'Reset layers, filters and basemap (undoable).', parameters: () => obj({}), run: () => api.reset() },
  {
    name: 'planRoute', description: 'Plan a line route; ends: substation name or [lng, lat]; none = current.',
    parameters: () => {
      const end: Schema = { type: ['string', 'array'], items: { type: 'number' }, minItems: 2, maxItems: 2 };
      return obj({ from: end, to: end, lineType: { type: 'string' }, alternatives: { type: 'integer', minimum: 0, maximum: 2 } });
    },
    run: (a, o) => {
      if ((a.from === undefined) !== (a.to === undefined)) return { ok: false, reason: 'give both from and to, or neither' };
      return planRouteFromChat(a as ChatRouteRequest, o.signal);
    },
  },
  { name: 'shareLink', description: 'The link to the current view.', parameters: () => obj({}), run: () => api.shareLink() },
];

/** A join result cut to what a model may see (the rows are all it can lose). */
function capJoin(o: api.Outcome<{ rows: unknown[] }>): api.Outcome<unknown> {
  if (!o.ok) return o;
  const { rows, ...head } = o.result;
  return { ok: true, result: capRows(head, rows as Record<string, unknown>[]) };
}

const ANALYSIS_VALUE_BYTES = 12 * 1024;

/** An analysis result cut to what a model may see: an array of objects as
 *  capRows (≤ 50 rows, 8 KB), anything else as JSON ≤ 12 KB or dropped. */
function capAnalysis(o: api.Outcome<api.AnalysisResult>): api.Outcome<unknown> {
  if (!o.ok) return o;
  const { value, ...head } = o.result;
  if (Array.isArray(value) && value.every(v => v && typeof v === 'object' && !Array.isArray(v))) {
    return { ok: true, result: capRows(head, value as Record<string, unknown>[]) };
  }
  const json = JSON.stringify(value ?? null);
  return { ok: true, result: new TextEncoder().encode(json).length > ANALYSIS_VALUE_BYTES
    ? { ...head, truncated: true, note: 'the value was over 12 KB and is not shown: return a smaller summary' }
    : { ...head, value: value ?? null } };
}

const BY_NAME = new Map(TOOLS.map(t => [t.name, t]));
export const TOOL_NAMES: readonly string[] = TOOLS.map(t => t.name);

export function toolSchemas() {
  return TOOLS.map(t => ({ type: 'function' as const, function: { name: t.name, description: t.description, parameters: t.parameters() } }));
}

export const COPY_CONFIRM_ABOVE = 50;

export interface DispatchOpts {
  /** Features copied to My Data by earlier model calls in this ask (loop.ts makes one per ask): the 50 is a running total. */
  copied?: { n: number };
  /** Asked before a call sends model text off the page; the call runs only on true. */
  confirm?: (req: OffPageRequest) => Promise<boolean>;
  /** The chat's Stop: aborts a running analysis. */
  signal?: AbortSignal;
  /** Shows a canvas page ('html') or a Vega-Lite chart ('vega') in the chat and
   *  resolves with the frame's outcome (≤ ~20 s after it starts: 10 s for ready, 10 s for the render). Its `message`
   *  is for the visitor: the calling tool decides what the model sees. No
   *  callback (tests, dev console) → the tool answers 'unavailable'. */
  render?: (kind: CanvasKind, title: string, payload: unknown, inputs?: unknown, extra?: RenderExtra) => Promise<CanvasOutcome>;
}

export interface RenderExtra {
  /** A vega chart's CSV, built from the injected rows. */
  csv?: () => string;
  /** Titles of the canvas layers read only in part (the card says so). */
  partial?: string[];
  /** A vega template's injected rows and their headings, for the card's Table toggle. */
  table?: { columns: [string, string][]; rows: readonly Record<string, unknown>[] };
  /** A page-owned template (assets/templates/show-template.ts): the card is
   *  labelled as the app's own, the frame tagged as a template frame, and the
   *  chat keeps {templateId, layer, params} — never code — for a reload. */
  template?: TemplateRender;
  /** A template frame's actions, validated and applied by the page (templates/template-actions.ts). */
  onAction?: (a: TemplateAction) => void;
  /** A vega template's signal bridge: the selections the runner forwards as actions. */
  signals?: SignalAction[];
  /** The county overlay this card painted on the main map (county-overlay.ts token): the card
   *  offers Clear map colours while it is the current one, and its × clears it. */
  overlay?: number;
}

export interface TemplateRender {
  kind: 'template';
  templateId: string;
  layer: string;
  /** The resolved, validated params (by, measure, time, top, title, area, where). */
  params: Record<string, unknown>;
}

// ─── Refusal hints ───────────────────────────────────────────────────────────
const HINT_MAX = 600;
const list = (xs: readonly string[]) => {
  let out = '';
  for (const [i, x] of xs.entries()) {
    const next = out ? `${out}, ${x}` : x;
    if (next.length > HINT_MAX) return `${out}, … (${xs.length - i} more)`;
    out = next;
  }
  return out;
};

/** Layer ids nearest to `bad`: shared words first, then shared prefix. */
function nearestLayers(bad: string): string[] {
  const words = bad.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const prefix = (id: string) => { let i = 0; while (i < id.length && id[i] === bad[i]) i++; return i; };
  const score = (id: string) => words.filter(w => id.includes(w)).length * 10 + prefix(id);
  return LAYERS.map(l => l.id).sort((a, b) => score(b) - score(a)).slice(0, 5);
}

/** What would work instead, read from the refusal a validator returned; '' when it names nothing to suggest. */
export function refusalHint(reason: string): string {
  let m = /"([^"]+)" is not a (?:layer id|known layer)|unknown layer "([^"]+)"/.exec(reason);
  if (m) return `try: ${nearestLayers(m[1] ?? m[2]).join(', ')} (listLayers gives every id)`;
  if (/has no field schema, so it takes no query/.test(reason)) return 'for points per region, try: showTemplate points-per-polygon with by states, counties or nerc';
  m = /"([^"]+)" is not a declared field of "([^"]+)"|"([^"]+)" is not a field of "([^"]+)"/.exec(reason);
  if (m) {
    const ds = m[2] ?? LAYERS.find(l => l.id === m![4])?.dataset;
    const schema = ds && Object.hasOwn(FIELD_SCHEMA, ds) ? FIELD_SCHEMA[ds] : undefined;
    // A world layer has no states field: its US states are admin-1 codes.
    if ((m[1] ?? m[3]) === 'states' && schema && Object.hasOwn(schema, 'admin1') && !Object.hasOwn(schema, 'states')) {
      return `US states are admin1 codes on this layer, e.g. {"field":"admin1","op":"contains_any","value":["${STATE_TO_ADMIN1.TX}"]} for TX, "${STATE_TO_ADMIN1.CA}" for CA; templates take by "states"`;
    }
    const fields = schema ? Object.keys(schema) : [];
    return fields.length ? `fields: ${list(fields)}` : '';
  }
  m = /is not available on "([^".]+)\.([^"]+)"/.exec(reason);
  if (m) {
    const def = FIELD_SCHEMA[m[1]]?.[m[2]];
    return def ? `operators: ${def.ops.join(', ')}` : '';
  }
  m = /outside the declared domain of "([^".]+)\.([^"]+)"/.exec(reason);
  if (m) {
    const def = FIELD_SCHEMA[m[1]]?.[m[2]];
    if (def?.values) return `values: ${list(def.values)}`;
    if (def?.pattern) return `values match ${def.pattern}`;
  }
  return '';
}

/** Run tool `name` with the model's arguments (a JSON string or an object). */
export async function dispatch(name: string, rawArgs: unknown, opts: DispatchOpts = {}): Promise<api.Outcome<unknown>> {
  const r = await run(name, rawArgs, opts);
  if (r.ok) return r;
  const hint = refusalHint(r.reason);
  return hint ? { ...r, reason: `${r.reason}; ${hint}` } : r;
}

async function run(name: string, rawArgs: unknown, opts: DispatchOpts): Promise<api.Outcome<unknown>> {
  const tool = BY_NAME.get(name);
  if (!tool) return { ok: false, reason: `unknown tool "${name}"` };
  let args: unknown = rawArgs ?? {};
  if (typeof args === 'string') {
    try { args = args.trim() ? JSON.parse(args) : {}; } catch { return { ok: false, reason: 'arguments are not valid JSON' }; }
  }
  const err = checkArgs(args, tool.parameters());
  if (err) return { ok: false, reason: err };
  const a = args as Record<string, unknown>;
  const off = tool.offPage?.(a);
  if (off && !(await opts.confirm?.(off).catch(() => false))) {
    return { ok: false, reason: off.tool === 'addService'
      ? `the visitor did not allow adding "${off.text}"`
      : `the visitor did not allow sending "${off.text}" to ${off.host}` };
  }
  try {
    return await tool.run(a, opts);
  } catch (e) {
    return { ok: false, reason: `${name} failed: ${(e as Error).message}` };
  }
}
