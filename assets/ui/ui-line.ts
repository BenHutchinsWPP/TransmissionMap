// ─── Line tools: the drawer's Line tab (lazy chunk) ──────────────────────────
// Role: the fault locator (docs/line-tools.md) and the
//       elevation profile (line-profile.ts) for one
//       transmission line of a layer with line GeoParquet (LayerDef.data.analysis),
//       opened from the popup's "Line tools" button through line-open.ts.
//   openLineTools(req, from)   read the line's chain (lines/line-read.ts
//       chainGeometry + lookup), show it — ways, length, the ends A and B (HIFLD:
//       SUB_1 / SUB_2, placed at the ends by the HIFLD substations of those
//       names (lines/along.ts orientEnds), with a Swap; OSM: the chain end's substation linked to
//       openstreetmap.org, named from the substation archive (lines/osm-substation.ts) once that
//       answers, else by its OSM id; an end at no substation shows its coordinates), the circuits and
//       chain-end notes — and take a distance from A, from B or both (display
//       units, src/units.ts), an optional relay line length (the distance is
//       scaled by map length / relay length) and the ± uncertainty (default 2 %
//       of the line length). Locate walks the TRUE geometry (lines/along.ts): a
//       pin per distance with its coordinates (copy, zoom, add to My Data), the
//       uncertainty span drawn on the line, and the gap between two pins.
//   Refusals in words: the reader failed (never the tile geometry), the line is
//   in pieces more than 5 m apart (the pieces are drawn), a distance past the
//   far end. Scope: the whole chain (the default when it has more than one way)
//   or the clicked way only. Below the locator, the Profile section
//   (line-profile.ts profileSection) for the same scope and orientation, its fault
//   pins on the chart and its crosshair as the `lt-hover` marker on the map.
// Map: sources and layers prefixed `lt-`, added and removed (never
//   visibility-toggled); no pointer input. Session only: no URL write, no undo
//   step, not kept in tm-drawer — a reload drops the pins.
// Deps: overlay-layers.ts (setGeojson, removeOverlay), state.ts, state-bus.ts (on: lang:changed, units:changed), ui-table.ts
//       (openLine, linePanel, lineOpen, drawerPadding; closeLine runs onClose), lines/line-read.ts,
//       lines/along.ts, lines/osm-substation.ts, user-data/user-data.ts (addCopiedFeatures), line-profile.ts,
//       layers/layer-data.ts (loadSource: the HIFLD substations), layers/layer-source.ts,
//       src/registry (layerById), src/registry/osm-fid.ts (osmRef), src/units.ts,
//       i18n (t). Loaded by: line-open.ts (dynamic import).

import type { LayerSpecification } from 'maplibre-gl';
import { state } from '../state.js';
import { on } from '../state-bus.js';
import { openLine, linePanel, lineOpen, drawerPadding } from './ui-table.js';
import { chainGeometry, lookup, type Chain, type LineFailure } from '../lines/line-read.js';
import { assembleWays, faultPosition, orientEnds, pointAt, sliceAt, JOIN_TOL_M, type Assembled, type Pos } from '../lines/along.js';
import { loadSource } from '../layers/layer-data.js';
import { layerSourceId } from '../layers/layer-source.js';
import { addCopiedFeatures } from '../user-data/user-data.js';
import { profileSection, cancelProfile, type ProfileHost } from './line-profile.js';
import { layerById } from '../../src/registry/index.js';
import { osmRef } from '../../src/registry/osm-fid.js';
import { osmSubstationName } from '../lines/osm-substation.js';
import { getUnits, fmtDistance } from '../../src/units.js';
import { t } from '../../src/i18n/index.js';
import { setGeojson, removeOverlay } from './overlay-layers.js';
import './ui-line.css';

export interface LineRequest {
  layerId: string;
  fid: string | number;
  properties: Record<string, unknown>;
}

type End = 'A' | 'B';
interface EndInfo { label: string; named: boolean; open: boolean; inner: boolean; href?: string }
interface Pin { end: End; distM: number; at: Pos; alongM: number; lowM: number; highM: number; mapDistM: number }
interface Inputs { a: number | null; b: number | null; relay: number | null; pct: number }

interface Session {
  req: LineRequest;
  seq: number;
  status: 'loading' | 'failed' | 'ready';
  reason?: LineFailure;
  chain?: Chain;
  circuits: number;
  scope: 'chain' | 'way';
  flip: boolean;             // the line runs backwards from its stored order (HIFLD: so that end A is SUB_1)
  orient: 'pending' | 'matched' | 'unknown';   // HIFLD: whether SUB_1 / SUB_2 were placed by nearby substations
  inputs: Inputs;            // metres (distances), percent
  pins: Pin[];
  errors: string[];
  subNames: Map<number, string | null>;   // OSM: chain-end substation fid → name (null: none found)
}

const DEFAULT_PCT = 2;
const SOURCES = ['lt-line', 'lt-span', 'lt-pts', 'lt-hover'];
const LAYERS_ON_MAP = ['lt-hover', 'lt-pts-label', 'lt-pts', 'lt-span', 'lt-line', 'lt-line-casing'];
let s: Session | null = null;
let seq = 0;
const unitKey = () => `${getUnits().distance}|${getUnits().elevation}`;
let unitSeen = unitKey();

const unitM = () => getUnits().distance === 'mi' ? 1609.344 : 1000;
const unitName = () => getUnits().distance;

// ─── DOM helper (text only) ──────────────────────────────────────────────────
function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...kids: (Node | string | null | false)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v; else e.setAttribute(k, v);
  }
  for (const c of kids) if (c) e.append(c);
  return e;
}

// ─── Entry point ─────────────────────────────────────────────────────────────
export async function openLineTools(req: LineRequest, from?: HTMLElement | null): Promise<void> {
  subscribe();
  const my = ++seq;
  cancelProfile();
  clearMap();
  s = { req, seq: my, status: 'loading', circuits: -1, scope: 'chain', flip: false, orient: 'pending', pins: [], errors: [], subNames: new Map(),
    inputs: { a: null, b: null, relay: null, pct: DEFAULT_PCT } };
  openLine(onClose, from);
  render();
  const [chain, idx] = await Promise.all([chainGeometry(req.layerId, req.fid), lookup(req.layerId, req.fid)]);
  if (!s || s.seq !== my) return;
  if (!chain.ok) { s.status = 'failed'; s.reason = chain.reason; render(); return; }
  s.chain = chain.result;
  s.circuits = idx.ok ? idx.result.circuits : -1;
  s.scope = chain.result.ways.length > 1 ? 'chain' : 'way';
  s.status = 'ready';
  render();
  drawLine();
  zoomTo(current());
  if (isOsm()) nameOsmEnds(my); else await orientHifld(my);
}

/** HIFLD names its ends SUB_1 / SUB_2 but stores no direction: place them by
 *  the HIFLD substations of those names nearest each end (the substations
 *  file, ~1 MB, read once). */
async function orientHifld(my: number) {
  const p = s!.req.properties;
  let pts: GeoJSON.Feature[] = [];
  try {
    await loadSource('hifld-substations');
    pts = (state.sourcesData[layerSourceId('hifld-substations')] ?? []) as GeoJSON.Feature[];
  } catch { /* offline: the order stays unknown */ }
  if (!s || s.seq !== my) return;
  const geom = current();   // read now: a Swap while the substations loaded counts
  const key = (v: unknown) => String(v ?? '').trim().replace(/\s+/g, ' ').toUpperCase();   // the lines file is upper case, the substations title case
  const at = (name: unknown) => key(name) ? pts.filter(f => key(f.properties?.name) === key(name) && f.geometry?.type === 'Point')
    .map(f => (f.geometry as GeoJSON.Point).coordinates) : [];
  const o = geom?.ok ? orientEnds(geom.line[0], geom.line[geom.line.length - 1], at(p.SUB_1), at(p.SUB_2)) : null;
  s.orient = o ? 'matched' : 'unknown';
  if (o?.swap) { s.flip = !s.flip; s.pins = []; s.errors = []; }
  render();
  drawLine();
}

function onClose() {
  seq++;
  cancelProfile();
  s = null;
  clearMap();
}

let subscribed = false;
function subscribe() {
  if (subscribed) return;
  subscribed = true;
  on('lang:changed', () => { if (s) { render(); drawPoints(); } });
  on('units:changed', () => {
    const u = unitKey();
    if (u === unitSeen) return;
    unitSeen = u;
    if (s) { render(); drawPoints(); }
  });
}

// ─── The line in the chosen scope ────────────────────────────────────────────
function clickedWay(c: Chain) {
  const i = c.ways.findIndex(w => String(w.fid) === String(s!.req.fid));
  return i < 0 ? 0 : i;
}

/** The scope's geometry, from end A to end B. */
function current(): Assembled | null {
  const c = s?.chain;
  if (!c) return null;
  const a = assembleWays(s!.scope === 'chain' ? c.ways : [c.ways[clickedWay(c)]]);
  if (!s!.flip) return a;
  return a.ok ? { ...a, line: [...a.line].reverse() } : a;
}

const isOsm = () => s!.req.layerId.startsWith('osm-');
const fmtPos = (p: Pos) => `${p[1].toFixed(6)}, ${p[0].toFixed(6)}`;

function lineTitle(): string {
  const p = s!.req.properties;
  if (isOsm()) return String(p.name || t('popup.transmissionLine'));
  return p.SUB_1 && p.SUB_2 ? `${p.SUB_1} → ${p.SUB_2}` : t('popup.hifldTransmissionLine');
}

function lineKv(): string | null {
  const p = s!.req.properties, kv = isOsm() ? p.nominal_kv : p.VOLTAGE;
  return kv ? `${kv} kV` : null;
}

/** OSM: name the chain's end substations from the substation archive (lines/osm-substation.ts), then redraw. */
function nameOsmEnds(my: number) {
  const c = s!.chain!;
  const whole = assembleWays(c.ways);
  const line = whole.ok ? whole.line : null;
  for (const [sub, at] of [[c.startSub, line?.[0]], [c.endSub, line?.at(-1)]] as const) {
    if (sub == null || !at || s!.subNames.has(sub)) continue;
    void osmSubstationName(sub, at).then(name => {
      if (!s || s.seq !== my) return;
      s.subNames.set(sub, name);
      if (name) render();
    });
  }
}

function endInfo(end: End, line: Pos[] | null): EndInfo {
  const c = s!.chain!;
  const p = s!.req.properties;
  const at = line ? (end === 'A' ? line[0] : line[line.length - 1]) : null;
  const coords = at ? t('line.endAt', { coords: fmtPos(at) }) : '';
  if (!isOsm()) {
    const name = end === 'A' ? p.SUB_1 : p.SUB_2;
    return { label: name ? String(name) : coords, named: !!name, open: false, inner: false };
  }
  const i = clickedWay(c);
  const atChainEnd = s!.scope === 'chain' || (end === 'A' ? i === 0 : i === c.ways.length - 1);
  if (!atChainEnd) return { label: coords, named: false, open: false, inner: true };
  const sub = end === 'A' ? c.startSub : c.endSub;
  if (sub == null) return { label: coords, named: false, open: true, inner: false };
  const name = s!.subNames.get(sub) ?? null;
  const ref = osmRef(sub);
  return { label: name ?? (ref ? t('line.subOsm', { type: ref.type, id: String(ref.id) }) : coords), named: !!name, open: false, inner: false,
    ...(ref && { href: `https://www.openstreetmap.org/${ref.type}/${ref.id}` }) };
}

// ─── Rendering ───────────────────────────────────────────────────────────────
function render() {
  if (!s || !lineOpen()) return;
  const root = linePanel();
  const box = el('div', { class: 'lt' });
  const kv = lineKv();
  box.append(el('div', { class: 'lt-head' },
    el('h3', { class: 'lt-title' }, lineTitle()),
    kv && el('span', { class: 'lt-kv' }, kv),
    el('span', { class: 'lt-tool' }, t('line.faultLocator'))));

  if (s.status === 'loading') {
    box.append(el('p', { class: 'lt-status', role: 'status' }, t('line.loading')));
  } else if (s.status === 'failed') {
    box.append(el('p', { class: 'lt-refuse', role: 'alert' },
      t('line.locatorRefused', { reason: t(`line.reason.${s.reason}`) })));
  } else {
    const geom = current()!;
    box.append(el('div', { class: 'lt-grid' }, infoSection(geom), formSection(geom), resultsSection(geom)), profileSection(profileHost(geom)));
  }
  root.replaceChildren(box);
}

function infoSection(geom: Assembled): HTMLElement {
  const c = s!.chain!;
  const sec = el('section', { class: 'lt-info', 'aria-label': t('line.lineSection') });
  if (c.ways.length > 1) {
    const way = c.ways[clickedWay(c)];
    const wayLen = assembleWays([way]);
    const chainLen = assembleWays(c.ways);
    const radio = (v: 'chain' | 'way', label: string) => {
      const r = el('input', { type: 'radio', name: 'lt-scope', value: v });
      r.checked = s!.scope === v;
      r.addEventListener('change', () => { if (!s) return; s.scope = v; s.pins = []; s.errors = []; render(); drawLine(); zoomTo(current()); });
      return el('label', { class: 'lt-radio' }, r, ' ', label);
    };
    const len = (a: Assembled) => a.ok ? fmtDistance(a.lengthM) : t('line.inPieces');
    sec.append(el('fieldset', { class: 'lt-scope' },
      el('legend', {}, t('line.scope')),
      radio('chain', t('line.scopeChain', { n: c.ways.length, len: len(chainLen) })),
      radio('way', t('line.scopeWay', { len: len(wayLen) }))));
  }
  const line = geom.ok ? geom.line : null;
  const A = endInfo('A', line), B = endInfo('B', line);
  const dl = el('dl', { class: 'lt-facts' });
  const fact = (k: string, v: string | Node) => dl.append(el('dt', {}, k), el('dd', {}, v));
  const endVal = (e: EndInfo) => e.href ? el('a', { href: e.href, target: '_blank', rel: 'noopener' }, e.label) : e.label;
  if (geom.ok) fact(t('line.length'), fmtDistance(geom.lengthM));
  fact(t('line.ways'), String(s!.scope === 'chain' ? c.ways.length : 1));
  fact(t('line.endA'), endVal(A));
  fact(t('line.endB'), endVal(B));
  sec.append(dl);

  const notes = el('ul', { class: 'lt-notes' });
  const note = (txt: string, warn = false) => notes.append(el('li', warn ? { class: 'lt-warn' } : {}, txt));
  if (!geom.ok) note(t('line.disconnected', { n: geom.pieces.length, tol: String(JOIN_TOL_M) }), true);
  if (s!.circuits > 1) note(t('line.circuitsMany', { n: s!.circuits }), true);
  else if (s!.circuits < 0) note(t('line.circuitsUnknown'));
  for (const [end, info] of [['A', A], ['B', B]] as const) {
    if (info.open) note(t('line.endOpen', { end }), true);
    if (info.inner) note(t('line.endInner', { end }));
  }
  const p = s!.req.properties;
  if (isOsm()) note(t('line.chainNote'));
  else if (s!.orient === 'pending') note(t('line.hifldPending'));
  else if (s!.orient === 'matched') note(t('line.hifldMatched', { a: String(p.SUB_1 ?? '?'), b: String(p.SUB_2 ?? '?') }));
  else note(t('line.hifldEnds', { a: String(p.SUB_1 ?? '?'), b: String(p.SUB_2 ?? '?') }), true);
  sec.append(notes);
  if (!isOsm()) {
    const swap = el('button', { type: 'button', class: 'td-btn lt-swap' }, t('line.swap'));
    swap.addEventListener('click', () => { if (!s) return; s.flip = !s.flip; s.pins = []; s.errors = []; render(); drawLine(); });
    sec.append(el('div', { class: 'lt-actions' }, swap));
  }
  return sec;
}

function numInput(id: string, value: number | null, label: string, suffix: string, step = 'any'): HTMLElement {
  const i = el('input', { id, type: 'number', inputmode: 'decimal', min: '0', step, class: 'lt-num' });
  if (value !== null) i.value = String(+value.toFixed(4));
  return el('label', { class: 'lt-field', for: id }, el('span', { class: 'lt-field-label' }, label),
    el('span', { class: 'lt-field-in' }, i, el('span', { class: 'lt-unit' }, suffix)));
}

const distLabel = (end: End, e: EndInfo) => e.named ? t('line.distFrom', { end, name: e.label }) : t('line.distFromEnd', { end });

function formSection(geom: Assembled): HTMLElement {
  const u = unitM(), un = unitName();
  const line = geom.ok ? geom.line : null;
  const A = endInfo('A', line), B = endInfo('B', line);
  const inp = s!.inputs;
  const toU = (m: number | null) => m === null ? null : m / u;
  const form = el('form', { class: 'lt-form', 'aria-label': t('line.formSection'), novalidate: '' },
    numInput('lt-da', toU(inp.a), distLabel('A', A), un),
    numInput('lt-db', toU(inp.b), distLabel('B', B), un),
    numInput('lt-relay', toU(inp.relay), t('line.relayLength'), un),
    numInput('lt-pct', inp.pct, t('line.uncertainty'), t('line.pctOfLength'), '0.1'),
    el('div', { class: 'lt-actions' },
      el('button', { type: 'submit', class: 'td-btn lt-locate' }, t('line.locate')),
      el('button', { type: 'button', class: 'td-btn lt-clear' }, t('line.clear')),
      el('button', { type: 'button', class: 'td-btn lt-zoom-line' }, t('line.zoomLine'))));
  const read = (id: string) => {
    const v = form.querySelector<HTMLInputElement>('#' + id)!.valueAsNumber;
    return Number.isFinite(v) ? v : null;
  };
  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    if (!s) return;
    const a = read('lt-da'), b = read('lt-db'), relay = read('lt-relay'), pct = read('lt-pct');
    s.inputs = { a: a === null ? null : a * u, b: b === null ? null : b * u, relay: relay === null ? null : relay * u, pct: pct ?? DEFAULT_PCT };
    locate();
    render();
    drawPoints();
    if (s.pins.length) zoomToPins();
    linePanel().querySelector<HTMLElement>('.lt-results')?.focus({ preventScroll: true });
  });
  form.querySelector('.lt-clear')!.addEventListener('click', () => {
    if (!s) return;
    s.inputs = { a: null, b: null, relay: null, pct: DEFAULT_PCT };
    s.pins = []; s.errors = [];
    render(); drawPoints();
  });
  form.querySelector('.lt-zoom-line')!.addEventListener('click', () => zoomTo(current()));
  return form;
}

function locate() {
  const geom = current();
  s!.pins = []; s!.errors = [];
  if (!geom?.ok) { s!.errors.push(t('line.cannotMeasure')); return; }
  const { a, b, relay, pct } = s!.inputs;
  if (a === null && b === null) { s!.errors.push(t('line.enterDistance')); return; }
  for (const [end, d] of [['A', a], ['B', b]] as const) {
    if (d === null) continue;
    const r = faultPosition({ lengthM: geom.lengthM, distM: d, from: end, pct, ...(relay !== null && { relayLengthM: relay }) });
    if (!r.ok) {
      s!.errors.push(r.reason === 'beyond'
        ? t('line.beyond', { d: fmtDistance(d), end, len: fmtDistance(relay ?? geom.lengthM) })
        : t('line.invalid'));
      continue;
    }
    s!.pins.push({ end, distM: d, at: pointAt(geom.line, r.alongM), ...r });
  }
}

function resultsSection(geom: Assembled): HTMLElement {
  const sec = el('section', { class: 'lt-results', 'aria-live': 'polite', tabindex: '-1', 'aria-label': t('line.resultsSection') });
  for (const e of s!.errors) sec.append(el('p', { class: 'lt-refuse' }, e));
  if (!s!.pins.length) {
    if (!s!.errors.length) sec.append(el('p', { class: 'lt-hint' }, t('line.hint')));
    return sec;
  }
  const { relay, pct } = s!.inputs;
  if (relay !== null && geom.ok) sec.append(el('p', { class: 'lt-hint' }, t('line.scaled', { map: fmtDistance(geom.lengthM), relay: fmtDistance(relay) })));
  for (const p of s!.pins) {
    const coords = fmtPos(p.at);
    const fromA = (m: number) => fmtDistance(m);
    const card = el('div', { class: 'lt-pin' },
      el('div', { class: 'lt-pin-head' }, t('line.pinHead', { d: fmtDistance(p.distM), end: p.end })),
      el('div', { class: 'lt-coords' }, el('span', { class: 'lt-coords-k' }, t('line.latLon')), ' ', el('code', {}, coords)),
      el('div', { class: 'lt-along' }, t('line.alongBoth', { a: fromA(p.alongM), b: fromA(geom.ok ? geom.lengthM - p.alongM : 0) })),
      el('div', { class: 'lt-span-txt' }, t('line.span', { pct: String(pct), low: fromA(p.lowM), high: fromA(p.highM) })));
    const copy = el('button', { type: 'button', class: 'td-btn' }, t('line.copyCoords'));
    copy.addEventListener('click', () => {
      void navigator.clipboard?.writeText(coords).then(() => { copy.textContent = t('line.copiedCoords'); },
        () => { const sel = getSelection(); const code = card.querySelector('code'); if (sel && code) sel.selectAllChildren(code); });
    });
    const zoom = el('button', { type: 'button', class: 'td-btn' }, t('line.zoomPin'));
    zoom.addEventListener('click', () => zoomToPins([p]));
    const add = el('button', { type: 'button', class: 'td-btn' }, t('line.addPin'));
    add.addEventListener('click', () => { addPin(p); add.disabled = true; add.textContent = t('line.pinAdded'); }, { once: true });
    card.append(el('div', { class: 'lt-pin-actions' }, copy, zoom, add));
    sec.append(card);
  }
  if (s!.pins.length === 2) {
    const [x, y] = s!.pins;
    sec.append(el('p', { class: 'lt-gap' }, t('line.gap', { d: fmtDistance(Math.abs(x.alongM - y.alongM)) })));
  }
  return sec;
}

function profileHost(geom: Assembled): ProfileHost {
  return {
    key: `${s!.req.layerId}|${s!.req.fid}|${s!.scope}`,
    line: geom.ok ? geom.line : null,
    pins: s!.pins.map(p => ({ alongM: p.alongM, label: t('line.pinLabel', { d: fmtDistance(p.distM), end: p.end }) })),
    title: lineTitle(),
    lineCredit: layerById(s!.req.layerId)?.data?.credit,
    onHover: setHover,
  };
}

function addPin(p: Pin) {
  const ds = layerById(s!.req.layerId);
  addCopiedFeatures([{
    type: 'Feature',
    geometry: { type: 'Point', coordinates: p.at },
    properties: {
      name: t('line.pinName', { d: fmtDistance(p.distM), end: p.end }),
      line: lineTitle(),
      from_end: p.end,
      distance: fmtDistance(p.distM),
      uncertainty: t('line.span', { pct: String(s!.inputs.pct), low: fmtDistance(p.lowM), high: fmtDistance(p.highM) }),
      source: ds?.label ?? s!.req.layerId,
    },
  }]);
}

// ─── Map ─────────────────────────────────────────────────────────────────────
function addLayer(spec: LayerSpecification) {
  if (state.map && !state.map.getLayer(spec.id)) state.map.addLayer(spec);
}

function clearMap() {
  removeOverlay(LAYERS_ON_MAP, SOURCES);
}

const fc = (features: GeoJSON.Feature[]): GeoJSON.FeatureCollection => ({ type: 'FeatureCollection', features });

function drawLine() {
  const geom = current();
  if (!geom) return;
  const parts = geom.ok ? [geom.line] : geom.pieces;
  setGeojson('lt-line', fc([{ type: 'Feature', properties: {}, geometry: { type: 'MultiLineString', coordinates: parts } }]));
  addLayer({ id: 'lt-line-casing', type: 'line', source: 'lt-line', layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#0f172a', 'line-width': 7, 'line-opacity': 0.35 } });
  addLayer({ id: 'lt-line', type: 'line', source: 'lt-line', layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#facc15', 'line-width': 3 } });
  drawPoints();
}

function drawPoints() {
  if (!s || !state.map || !state.map.getSource('lt-line')) return;
  const geom = current();
  const spans: GeoJSON.Feature[] = [], pts: GeoJSON.Feature[] = [];
  if (geom?.ok) {
    const l = geom.line;
    pts.push({ type: 'Feature', properties: { kind: 'end', label: 'A' }, geometry: { type: 'Point', coordinates: l[0] } },
      { type: 'Feature', properties: { kind: 'end', label: 'B' }, geometry: { type: 'Point', coordinates: l[l.length - 1] } });
    for (const p of s.pins) {
      spans.push({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: sliceAt(l, p.lowM, p.highM) } });
      pts.push({ type: 'Feature', properties: { kind: 'pin', label: t('line.pinLabel', { d: fmtDistance(p.distM), end: p.end }) },
        geometry: { type: 'Point', coordinates: p.at } });
    }
  }
  setGeojson('lt-span', fc(spans));
  setGeojson('lt-pts', fc(pts));
  addLayer({ id: 'lt-span', type: 'line', source: 'lt-span', layout: { 'line-cap': 'butt', 'line-join': 'round' },
    paint: { 'line-color': '#dc2626', 'line-width': 8, 'line-opacity': 0.8 } });
  addLayer({ id: 'lt-pts', type: 'circle', source: 'lt-pts',
    paint: {
      'circle-radius': ['match', ['get', 'kind'], 'pin', 6, 9],
      'circle-color': ['match', ['get', 'kind'], 'pin', '#dc2626', '#ffffff'],
      'circle-stroke-color': ['match', ['get', 'kind'], 'pin', '#ffffff', '#0f172a'],
      'circle-stroke-width': 2,
    } });
  addLayer({ id: 'lt-pts-label', type: 'symbol', source: 'lt-pts',
    layout: {
      'text-field': ['get', 'label'], 'text-font': ['Noto Sans Regular'],
      'text-size': ['match', ['get', 'kind'], 'pin', 12, 11],
      'text-offset': ['match', ['get', 'kind'], 'pin', ['literal', [0, -1.3]], ['literal', [0, 0]]],
      'text-anchor': ['match', ['get', 'kind'], 'pin', 'bottom', 'center'],
      'text-allow-overlap': true,
    },
    paint: { 'text-color': '#0f172a', 'text-halo-color': '#ffffff', 'text-halo-width': ['match', ['get', 'kind'], 'pin', 1.5, 0] } });
}

/** The profile's crosshair on the map: one marker, or none. */
function setHover(pos: Pos | null) {
  if (!s || !state.map?.getSource('lt-line')) return;
  setGeojson('lt-hover', fc(pos ? [{ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: pos } }] : []));
  addLayer({ id: 'lt-hover', type: 'circle', source: 'lt-hover',
    paint: { 'circle-radius': 6, 'circle-color': '#2563eb', 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2 } });
}

/** drawerPadding, also clear of the legend cards: beside them on a desktop, above them on a phone (most of its width). */
function fitPadding() {
  const pad = drawerPadding(), box = state.map?.getContainer(), lc = document.getElementById('legendContainer');
  if (!box || !lc || lc.hidden || lc.classList.contains('legends-off') || !lc.offsetHeight) return pad;
  const b = box.getBoundingClientRect(), r = lc.getBoundingClientRect();
  if (box.clientWidth > 640) return { ...pad, left: Math.min(Math.max(pad.left, r.right - b.left + 12), box.clientWidth * 0.3) };
  return { ...pad, bottom: Math.min(Math.max(pad.bottom, b.bottom - r.top + 8), Math.max(40, box.clientHeight - pad.top - 140)) };
}

function fit(coords: Pos[], maxZoom: number) {
  const map = state.map;
  if (!map || !coords.length) return;
  let w = Infinity, so = Infinity, e = -Infinity, n = -Infinity;
  for (const c of coords) { w = Math.min(w, c[0]); e = Math.max(e, c[0]); so = Math.min(so, c[1]); n = Math.max(n, c[1]); }
  map.fitBounds([[w, so], [e, n]], { padding: fitPadding(), maxZoom, duration: 600 });
}

function zoomTo(geom: Assembled | null) {
  if (!geom) return;
  fit(geom.ok ? geom.line : geom.pieces.flat(), 13);
}

function zoomToPins(pins = s?.pins ?? []) {
  const geom = current();
  if (!geom?.ok || !pins.length) return;
  fit(pins.flatMap(p => sliceAt(geom.line, p.lowM, p.highM)), 14);
}
