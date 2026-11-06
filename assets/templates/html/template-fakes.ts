// ─── Test support: a canvas frame in jsdom for the html templates ────────────
// Role: frame(code, payload, opts) runs kit.js and one template's script in a
//       jsdom window with a fake TM (vi.fn()s), fake maplibregl / d3 / deck
//       globals installed when the template asks TM.lib for them, a fetch that
//       fails (the template falls back to its blank style) and HTML sinks
//       that record any use. The fake Map records sources, layers, paint,
//       filters and handlers and fires events on request; the fake deck keeps
//       every layer it was given; the fake d3.sankey lays two columns out by
//       value (sources left, targets right). Used by the html templates' tests.
//
// Deps: vitest, jsdom, html/kit.js (read from disk).

import { vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the frame window and its globals are untyped script globals
export type Loose = any;
const { JSDOM } = createRequire(import.meta.url)('jsdom') as { JSDOM: new (html: string, opts: object) => { window: Loose } };

export const KIT = readFileSync(new URL('./kit.js', import.meta.url), 'utf8');
export const source = (name: string) => readFileSync(new URL(`./${name}`, import.meta.url), 'utf8');

type Handler = (e?: Loose) => void;

export class FakeMap {
  static last: FakeMap | null = null;
  opts: Loose;
  sources: Record<string, Loose> = {};
  layers: Loose[] = [];
  paint: Record<string, Record<string, unknown>> = {};
  filters: Record<string, unknown> = {};
  handlers: Record<string, Handler[]> = {};
  controls: Loose[] = [];
  hits: Loose[] = [];
  canvas: Loose;
  camera: Loose[] = [];
  bearing = 0;
  constructor(opts: Loose) {
    this.opts = opts;
    this.canvas = opts.container.ownerDocument.createElement('canvas');
    opts.container.appendChild(this.canvas);
    FakeMap.last = this;
  }
  on(ev: string, a: Handler | string, b?: Handler) { (this.handlers[ev] ??= []).push(typeof a === 'function' ? a : b!); return this; }
  once(ev: string, cb: Handler) {
    const wrap = (e?: Loose) => { this.handlers[ev] = this.handlers[ev].filter(h => h !== wrap); cb(e); };
    return this.on(ev, wrap);
  }
  fire(ev: string, e?: Loose) { for (const h of [...(this.handlers[ev] ?? [])]) h(e); }
  addSource(id: string, s: Loose) { this.sources[id] = s; }
  addLayer(l: Loose) { this.layers.push(l); this.paint[l.id] = { ...l.paint }; if (l.filter) this.filters[l.id] = l.filter; }
  setPaintProperty(id: string, k: string, v: unknown) { this.paint[id][k] = v; }
  setFilter(id: string, f: unknown) { this.filters[id] = f; }
  getSource(id: string) { return { setData: (d: unknown) => { this.sources[id] = { ...this.sources[id], data: d }; } }; }
  triggerRepaint() {}
  queryRenderedFeatures() { return this.hits; }
  addControl(c: Loose) { this.controls.push(c); c.onAdd?.(this); }
  getCanvas() { return this.canvas; }
  fitBounds(b: Loose) { this.camera.push({ fit: b }); }
  resize() {}
  getBounds() { return { getEast: () => -90, getWest: () => -100 }; }
  getCenter() { return { lat: 40, lng: -95 }; }
  getStyle() { return { layers: [] as Loose[] }; }
  project(ll: number[]) { return { x: ll[0] * 10, y: -ll[1] * 10 }; }
  getBearing() { return this.bearing; }
  getPitch() { return 0; }
  easeTo(o: Loose) { this.camera.push({ ease: o }); }
  jumpTo(o: Loose) { this.camera.push({ jump: o }); }
}

class FakeLayer {
  props: Loose;
  constructor(props: Loose) { this.props = props; }
}

export function fakeDeck() {
  const overlays: Loose[] = [];
  class MapboxOverlay {
    props: Loose;
    constructor(props: Loose) { this.props = props; overlays.push(this); }
    setProps(p: Loose) { Object.assign(this.props, p); }
  }
  return { overlays, deck: { MapboxOverlay, HexagonLayer: class extends FakeLayer {}, HeatmapLayer: class extends FakeLayer {} } };
}

/** A two-column stand-in for d3-sankey: sources at the left edge, targets at the right, stacked by value. */
function sankey() {
  let idOf = (n: Loose) => n.index, ext = [[0, 0], [1, 1]];
  const f: Loose = (g: Loose) => {
    const byId = new Map(g.nodes.map((n: Loose) => [idOf(n), n]));
    const links = g.links.map((l: Loose) => ({ ...l, source: byId.get(l.source), target: byId.get(l.target) }));
    for (const n of g.nodes as Loose[]) {
      const out = links.filter((l: Loose) => l.source === n), inn = links.filter((l: Loose) => l.target === n);
      n.value = Math.max(out.reduce((a: number, l: Loose) => a + l.value, 0), inn.reduce((a: number, l: Loose) => a + l.value, 0));
      n.isSource = out.length > 0;
    }
    const total = g.nodes.filter((n: Loose) => n.isSource).reduce((a: number, n: Loose) => a + n.value, 0) || 1;
    const ky = (ext[1][1] - ext[0][1]) / total;
    for (const side of [true, false]) {
      let y = ext[0][1];
      for (const n of g.nodes.filter((x: Loose) => x.isSource === side)) {
        Object.assign(n, side ? { x0: ext[0][0], x1: ext[0][0] + 10 } : { x0: ext[1][0] - 10, x1: ext[1][0] }, { y0: y, y1: y + n.value * ky });
        y = n.y1;
      }
    }
    const off = new Map<Loose, number>();
    for (const l of links) {
      l.width = l.value * ky;
      l.y0 = l.source.y0 + (off.get(l.source) ?? 0) + l.width / 2; off.set(l.source, (off.get(l.source) ?? 0) + l.width);
      l.y1 = l.target.y0 + (off.get(l.target) ?? 0) + l.width / 2; off.set(l.target, (off.get(l.target) ?? 0) + l.width);
    }
    return { nodes: g.nodes, links };
  };
  f.nodeId = (x: Loose) => { idOf = x; return f; };
  f.extent = (e: Loose) => { ext = e; return f; };
  for (const k of ['nodeWidth', 'nodePadding', 'nodeSort']) f[k] = () => f;
  return f;
}

const d3 = {
  max: (xs: Loose[], f: (x: Loose) => number) => xs.length ? Math.max(...xs.map(f)) : undefined,
  scaleLinear() {
    let d = [0, 1], r = [0, 1];
    const s = (v: number) => r[0] + ((v - d[0]) / (d[1] - d[0])) * (r[1] - r[0]);
    s.domain = (x: number[]) => { d = x; return s; };
    s.range = (x: number[]) => { r = x; return s; };
    return s;
  },
};

export interface FrameOpts { reducedMotion?: boolean; failLib?: boolean }

export function frame(code: string, input: unknown, opts: FrameOpts = {}) {
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { runScripts: 'outside-only' });
  const w = dom.window;
  const sink = vi.fn();
  for (const p of ['innerHTML', 'outerHTML']) Object.defineProperty(w.Element.prototype, p, { set: sink, get: () => '' });
  w.Element.prototype.insertAdjacentHTML = sink;
  if (opts.reducedMotion) w.matchMedia = (q: string) => ({ matches: q.includes('reduce') });
  const { deck, overlays } = fakeDeck();
  FakeMap.last = null;
  const TM = {
    drawn: vi.fn(), fail: vi.fn(), action: vi.fn(), download: vi.fn(),
    lib: vi.fn((name: string) => {
      if (opts.failLib) return Promise.reject(new Error(`${name} did not load`));
      if (name === 'maplibre-gl') w.maplibregl = { Map: FakeMap, NavigationControl: class {} };
      if (name === 'd3') w.d3 = { ...d3 };
      // d3-sankey extends the d3 global, so d3 must be in first.
      if (name === 'd3-sankey') { if (!w.d3) return Promise.reject(new Error('d3-sankey before d3')); w.d3.sankey = sankey; }
      if (name === 'deck.gl') w.deck = deck;
      return Promise.resolve({});
    }),
  };
  w.fetch = () => Promise.reject(new Error('offline'));
  w.TM = TM;
  w.TM_INPUT = input;
  w.eval(KIT);
  w.eval(code);
  return { w, doc: w.document, TM, sink, overlays, map: () => FakeMap.last! };
}

/** Lets the template's promise chain (libs → style → start) run. */
export async function settle() {
  for (let i = 0; i < 5; i++) await new Promise(r => setTimeout(r, 0));
}
