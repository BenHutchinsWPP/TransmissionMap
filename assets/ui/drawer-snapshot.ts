// ─── The drawer's tab snapshot: shape and caps (pure) ────────────────────────
// Role: what ui-table.ts keeps of the bottom drawer in sessionStorage
//       `tm-drawer` (session-snapshot.ts) so a reload of this tab brings it
//       back: which panes were open (Ask, the table — the Route tab is never
//       kept), the pane in view, the height share and the collapsed state, and
//       the table's request, sort, group-by / sum field, bar filter, shown
//       columns (in screen order, so a dragged order comes back), checked row ids (≤ MAX_SELECTION_IDS, else none), active row id
//       and scroll offset; and, when the Visualize pane was open, its layer and
//       its template cards ({templateId, layer, params, title} — never code or
//       data). This snapshot owns the layout, whether Ask was open
//       included; tm-chat (ui-chat.ts) holds only the conversation.
//         parseDrawerSnapshot(d)  untrusted data → DrawerSnapshot or null. A wrong
//                    version or a bad frame is null; a bad table request (a layer
//                    not in the registry, `where` / Area / ids failing the
//                    link's validators) drops the table part; a bad optional
//                    field falls back to the table's default (undefined); a
//                    bad Visualize part drops that part, a bad card that card.
//       Shape only: whether a field belongs to the layer (describe()) and
//       whether the layer is queryable now are checked at restore time by
//       ui-table.ts, and a card's params by ui-templates.ts
//       (validateTemplateArgs).
// Deps: src/registry/index.ts (layerById), view-validate.ts (validateWhere,
//       validateArea, selectionIdsError, MAX_SELECTION_IDS); types only from
//       condition-compile.ts, area-filter.ts, feature-id.ts.

import { layerById } from '../../src/registry/index.js';
import { validateWhere, validateArea, selectionIdsError, MAX_SELECTION_IDS } from '../../src/registry/view-validate.js';
import type { Condition } from '../../src/registry/condition-compile.js';
import type { AreaFilter } from '../../src/registry/area-filter.js';
import type { FeatureId } from '../feature-id.js';

export const DRAWER_SNAPSHOT = 'tm-drawer';
export const DRAWER_SNAPSHOT_VERSION = 1;
const MAX_FIELDS = 300;
const MAX_SCROLL = 10_000_000;
const FIELD = /^[A-Za-z0-9_.:-]{1,64}$/;

export interface TableSnapshot {
  req: { layerId: string; where?: Condition[]; area?: AreaFilter | null; asDrawn?: boolean; ids?: FeatureId[] };
  sort?: { field: string; desc: boolean } | null;   // undefined = the table's default
  groupBy?: string;                                  // '' = no grouping
  sumField?: string;                                 // '' = count
  barFilter: string | null;
  shown: string[];
  checked: FeatureId[];
  active: FeatureId | null;
  scrollTop: number;
}

export interface VizCard {
  templateId: string;
  layer: string;
  params: Record<string, unknown>;
  title: string;
}

export interface VizSnapshot {
  layer: string | null;  // the layer picked in the pane
  cards: VizCard[];      // newest first
}

export const MAX_VIZ_CARDS = 6;
/** A card's param keys: show-template.ts TEMPLATE_ARGS without template and layer (show-template.test.ts holds them equal). */
export const VIZ_PARAMS = ['by', 'split', 'measure', 'time', 'top', 'buckets', 'title', 'mode', 'area', 'where', 'layer2', 'where2', 'within'];
const MAX_PARAMS_CHARS = 20_000;

export interface DrawerSnapshot {
  v: number;
  ask: boolean;
  table: TableSnapshot | null;
  viz?: VizSnapshot;
  pane: 'ask' | 'table' | 'viz';
  frac: number;          // the drawer's share of the map container; 0 = the layout's default
  collapsed: boolean;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const field = (v: unknown): v is string => typeof v === 'string' && FIELD.test(v);
const optField = (v: unknown) => v === '' || field(v) ? v : undefined;

function parseReq(v: unknown): TableSnapshot['req'] | null {
  if (!isObj(v) || typeof v.layerId !== 'string' || !layerById(v.layerId)) return null;
  const layerId = v.layerId;
  const req: TableSnapshot['req'] = { layerId };
  if (v.where !== undefined) { if (validateWhere(layerId, v.where)) return null; req.where = v.where as Condition[]; }
  if (v.area !== undefined && v.area !== null) { if (validateArea(v.area)) return null; req.area = v.area as AreaFilter; }
  else if (v.area === null) req.area = null;
  if (v.asDrawn !== undefined) { if (typeof v.asDrawn !== 'boolean') return null; req.asDrawn = v.asDrawn; }
  if (v.ids !== undefined) {
    if (!Array.isArray(v.ids) || v.ids.length > MAX_SELECTION_IDS || selectionIdsError(layerId, v.ids)) return null;
    req.ids = v.ids as FeatureId[];
  }
  return req;
}

function parseTable(v: unknown): TableSnapshot | null {
  if (!isObj(v)) return null;
  const req = parseReq(v.req);
  if (!req) return null;
  const id = req.layerId;
  const sort = v.sort === null ? null
    : isObj(v.sort) && field(v.sort.field) && typeof v.sort.desc === 'boolean' ? { field: v.sort.field, desc: v.sort.desc } : undefined;
  const shown = Array.isArray(v.shown) && v.shown.length <= MAX_FIELDS ? v.shown.filter(field) : [];
  const checked = Array.isArray(v.checked) && v.checked.length && v.checked.length <= MAX_SELECTION_IDS
    && !selectionIdsError(id, v.checked) ? v.checked as FeatureId[] : [];
  const active = v.active !== null && v.active !== undefined && !selectionIdsError(id, [v.active]) ? v.active as FeatureId : null;
  return {
    req,
    ...(sort !== undefined && { sort }),
    ...(optField(v.groupBy) !== undefined && { groupBy: v.groupBy as string }),
    ...(optField(v.sumField) !== undefined && { sumField: v.sumField as string }),
    barFilter: typeof v.barFilter === 'string' && v.barFilter.length <= 200 ? v.barFilter : null,
    shown,
    checked,
    active,
    scrollTop: typeof v.scrollTop === 'number' && v.scrollTop >= 0 && v.scrollTop <= MAX_SCROLL ? v.scrollTop : 0,
  };
}

const layerId = (v: unknown): v is string => typeof v === 'string' && v.length <= 100 && !!layerById(v);

function parseCard(v: unknown): VizCard | null {
  if (!isObj(v) || typeof v.templateId !== 'string' || !/^[a-z][a-z-]{0,63}$/.test(v.templateId) || !layerId(v.layer)
    || typeof v.title !== 'string' || !v.title || v.title.length > 200 || !isObj(v.params)) return null;
  const params = v.params;
  if (!Object.keys(params).every(k => VIZ_PARAMS.includes(k))) return null;
  try { if (JSON.stringify(params).length > MAX_PARAMS_CHARS) return null; } catch { return null; }
  return { templateId: v.templateId, layer: v.layer, params, title: v.title };
}

function parseViz(v: unknown): VizSnapshot | null {
  if (!isObj(v) || !Array.isArray(v.cards)) return null;
  const cards = v.cards.slice(0, 50).map(parseCard).filter((c): c is VizCard => !!c).slice(0, MAX_VIZ_CARDS);
  return { layer: layerId(v.layer) ? v.layer : null, cards };
}

/** A tm-drawer snapshot as data the drawer may rebuild from, or null. */
export function parseDrawerSnapshot(d: unknown): DrawerSnapshot | null {
  if (!isObj(d) || d.v !== DRAWER_SNAPSHOT_VERSION) return null;
  const table = d.table === undefined || d.table === null ? null : parseTable(d.table);
  const ask = d.ask === true;
  const viz = d.viz === undefined || d.viz === null ? null : parseViz(d.viz);
  if (!ask && !table && !viz) return null;
  const pane = d.pane === 'ask' && ask ? 'ask' : d.pane === 'viz' && viz ? 'viz' : table ? 'table' : ask ? 'ask' : 'viz';
  return {
    v: DRAWER_SNAPSHOT_VERSION, ask, table, ...(viz && { viz }), pane,
    frac: typeof d.frac === 'number' && d.frac > 0 && d.frac < 1 ? d.frac : 0,
    collapsed: d.collapsed === true,
  };
}
