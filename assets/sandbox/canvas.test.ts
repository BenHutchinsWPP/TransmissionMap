// The canvas frame: the committed public/canvas.html is what
// scripts/build_sandbox.mjs generates, its CSP is exactly the planned one (no
// hash or nonce, which would switch 'unsafe-inline' off), the tile hosts it may
// fetch are the page's own minus the data host, the geocoder and OpenRouter,
// canvas-runner.js stays inert outside an opaque, framed origin, the libs table
// (src/registry/template-libs.json) is well-formed and inlined, and the html
// path's TM API (drawn, fail, action, lib) posts what its header says, and the
// vega path's signal bridge forwards only well-formed, picked values.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { generateCanvas, canvasPolicy, libsTable, CANVAS_OUT, CANVAS_CDNS } from '../../scripts/build_sandbox.mjs';
import canvasHosts from '../../src/registry/canvas-hosts.json';
import templateLibs from '../../src/registry/template-libs.json';

const html = readFileSync(CANVAS_OUT as string, 'utf8');
const csp = () => html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]*)">/)![1];
const directives = () => new Map(csp().split('; ').map(d => {
  const [name, ...values] = d.split(' ');
  return [name, values] as const;
}));

afterEach(() => { vi.unstubAllEnvs(); });

describe('src/registry/canvas-hosts.json', () => {
  it('is the CSP_HOSTS tile hosts: not the data host, the geocoder, 3DEP elevation, OpenRouter or PUDL (a keyed build, as deployed)', async () => {
    vi.resetModules();
    vi.stubEnv('VITE_ESRI_API_KEY', 'test-key');
    const c = await import('../constants.js');
    const drop = new Set([...c.DATA_HOSTS.map(h => new URL(h).origin), new URL(c.GEOCODER_URL).origin, new URL(c.ELEVATION_3DEP_URL).origin, c.OPENROUTER_ORIGIN, new URL(c.PUDL_BASE_URL).origin]);
    expect(canvasHosts).toEqual(c.CSP_HOSTS.filter(h => !drop.has(h)));
  });
});

describe('public/canvas.html', () => {
  it('is what build_sandbox.mjs generates (run npm run build:sandbox after editing canvas-runner.js or canvas-hosts.json)', () => {
    expect(html).toBe(generateCanvas());
  });

  it('puts the CSP first in <head>, before anything that could fetch', () => {
    expect(html).toMatch(/^<!doctype html>\n<html lang="en">\n<head>\n<meta http-equiv="Content-Security-Policy" /);
  });

  it('carries the exact planned CSP', () => {
    const cdns = 'https://cdnjs.cloudflare.com https://cdn.jsdelivr.net https://unpkg.com';
    const fetchable = `${cdns} ${canvasHosts.join(' ')}`;
    expect(csp()).toBe(canvasPolicy(canvasHosts));
    expect(csp()).toBe([
      "default-src 'none'",
      `script-src 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' blob: ${cdns}`,
      `worker-src blob: ${cdns}`,
      `style-src 'unsafe-inline' ${cdns} https://fonts.googleapis.com`,
      `font-src data: ${cdns} https://fonts.gstatic.com`,
      `img-src data: blob: ${fetchable}`,
      `connect-src ${fetchable}`,
      "media-src 'none'", "frame-src 'none'", "object-src 'none'", "base-uri 'none'", "form-action 'none'",
    ].join('; '));
  });

  it('has no hash or nonce, and closes every channel the plan names', () => {
    expect(csp()).not.toMatch(/'(sha256|sha384|sha512|nonce)-/);
    const d = directives();
    for (const name of ['default-src', 'form-action', 'base-uri', 'frame-src', 'object-src', 'media-src']) {
      expect(d.get(name), name).toEqual(["'none'"]);
    }
    for (const values of d.values()) for (const v of values) expect(v).not.toMatch(/^http:|^https:$|\*/);
  });

  it('never lets the canvas reach the data host, the geocoder or OpenRouter', () => {
    for (const host of ['raw.githubusercontent.com', 'geocode-api.arcgis.com', 'openrouter.ai']) expect(csp()).not.toContain(host);
  });

  it('has one inline script, ASCII only, with every pinned library of template-libs.json and its SRI', () => {
    expect(html.match(/<script/g)).toHaveLength(1);
    expect([...html].every(ch => ch.charCodeAt(0) < 128)).toBe(true);
    expect(templateLibs.map(l => l.name)).toEqual(expect.arrayContaining(
      ['vega', 'vega-lite', 'vega-interpreter', 'd3', 'd3-sankey', 'plot', 'maplibre-gl', 'maplibre-gl.css', 'deck.gl', 'turf']));
    for (const lib of templateLibs) {
      expect(lib.url).toMatch(new RegExp(`^https://cdn\\.jsdelivr\\.net/npm/(@[a-z0-9-]+/)?[a-z0-9.-]+@${lib.version}/`));
      expect(lib.url).not.toContain('+esm');
      expect(lib.integrity).toMatch(/^sha384-[A-Za-z0-9+/]{64}$/);
      expect(html).toContain(JSON.stringify(lib.url));
      expect(html).toContain(JSON.stringify(lib.integrity));
    }
    expect(templateLibs.find(l => l.name === 'maplibre-gl')!.version).toBe('5.24.0');
    expect(CANVAS_CDNS.every(c => csp().includes(c))).toBe(true);
  });

  it('refuses a malformed libs table', () => {
    const ok = templateLibs.map(l => ({ ...l }));
    expect(() => libsTable(ok)).not.toThrow();
    const bad = (f: (l: Record<string, unknown>[]) => void) => { const t = ok.map(l => ({ ...l })) as Record<string, unknown>[]; f(t); return () => libsTable(t); };
    expect(bad(t => { t.push({ ...t[3] }); })).toThrow(/unique/);
    expect(bad(t => { t[3].integrity = 'sha256-abc'; })).toThrow(/integrity/);
    expect(bad(t => { t[3].url = 'https://cdn.jsdelivr.net/npm/d3@7.9.0/+esm'; })).toThrow(/url/);
    expect(bad(t => { t[3].url = 'https://cdn.jsdelivr.net/npm/d3@7.8.5/dist/d3.min.js'; })).toThrow(/url/);
    expect(bad(t => { t[3].url = 'https://unpkg.com/d3@7.9.0/dist/d3.min.js'; })).toThrow(/url/);
    expect(bad(t => { t[3].kind = 'style'; })).toThrow(/url/);
    expect(bad(t => { t[3].kind = 'wasm'; })).toThrow(/kind/);
    expect(bad(t => { t[3].extra = 1; })).toThrow(/exactly/);
    expect(bad(t => { t[3].version = '7'; })).toThrow(/version/);
    expect(bad(t => { t.splice(0, 1); })).toThrow(/vega/);
    expect(() => libsTable({})).toThrow(/array/);
  });

  it('refuses a runner without exactly one LIBS placeholder, or one that could end the <script>', () => {
    expect(() => generateCanvas('(function () {})();', [])).toThrow();
    expect(() => generateCanvas('var L = /*@LIBS@*/null; var s = "</script>";', [])).toThrow();
  });
});

describe('canvas-runner.js origin guard', () => {
  const runner = readFileSync(path.join(import.meta.dirname, 'canvas-runner.js'), 'utf8');
  const code = runner.replace(/^\s*\/\/.*$/gm, '').trim();

  it('checks for an opaque origin and a parent before any listener or post', () => {
    const guard = code.indexOf("if (self.origin !== 'null' || window.parent === window) return;");
    expect(guard).toBeGreaterThan(-1);
    for (const tok of ['addEventListener(', 'postMessage(', 'document.open(']) {
      expect(code.indexOf(tok), tok).toBeGreaterThan(guard);
    }
  });

  it('is one IIFE: no top-level name for written code to collide with', () => {
    expect(code.startsWith('(function () {')).toBe(true);
    expect(code.endsWith('})();')).toBe(true);
  });

  /** Runs the runner (as the build inlines it) in a fake frame global; reports what it touched. */
  function boot(origin: string, framed: boolean) {
    const touched = { listeners: 0, posts: [] as unknown[] };
    const parent = { postMessage: (m: unknown) => { touched.posts.push(m); } };
    const ctx: Record<string, unknown> = {
      origin,
      addEventListener: () => { touched.listeners++; },
      postMessage: (m: unknown) => { touched.posts.push(m); },
    };
    ctx.self = ctx; ctx.window = ctx;
    ctx.parent = framed ? parent : ctx;
    vm.runInNewContext(runner.replace('/*@LIBS@*/null', JSON.stringify(libsTable())), ctx);
    return touched;
  }

  it('stays inert with a real origin, framed or top-level', () => {
    expect(boot('https://app.example', true)).toEqual({ listeners: 0, posts: [] });
    expect(boot('https://app.example', false)).toEqual({ listeners: 0, posts: [] });
  });

  it('stays inert top-level even with an opaque origin', () => {
    expect(boot('null', false)).toEqual({ listeners: 0, posts: [] });
  });

  it('listens and says ready when framed with an opaque origin', () => {
    expect(boot('null', true)).toEqual({ listeners: 1, posts: [{ type: 'ready' }] });
  });
});

describe('canvas-runner.js html API (TM.drawn / fail / action / lib)', () => {
  const runner = readFileSync(path.join(import.meta.dirname, 'canvas-runner.js'), 'utf8');
  const NONCE = 'n'.repeat(32);
  const libs = libsTable() as Record<string, { url: string; integrity: string; kind: string }>;
  type El = { tagName: string; src?: string; href?: string; rel?: string; integrity?: string; crossOrigin?: string;
    onload?: () => void; onerror?: () => void };
  type Listener = { type: string; fn: (e: unknown) => void; capture: boolean };

  /** A fake opaque, framed window: renders `payload` as kind html, returns what the runner set and posted. */
  function render(payload = '<p>hi</p>') {
    const posts: Record<string, unknown>[] = [];
    const winL: Listener[] = [], docL: Listener[] = [], appended: El[] = [];
    const parent = { postMessage: (m: Record<string, unknown>) => { posts.push(m); } };
    const document = {
      readyState: 'loading',
      open() { winL.length = 0; docL.length = 0; },
      write() {}, close() {},
      head: { appendChild: (el: El) => { appended.push(el); } },
      createElement: (tag: string): El => ({ tagName: tag.toUpperCase() }),
      addEventListener: (type: string, fn: (e: unknown) => void, capture = false) => { docL.push({ type, fn, capture }); },
    };
    const ctx: Record<string, unknown> = {
      origin: 'null', parent, document, setTimeout,
      addEventListener: (type: string, fn: (e: unknown) => void, capture = false) => { winL.push({ type, fn, capture }); },
    };
    ctx.self = ctx; ctx.window = ctx;
    vm.runInNewContext(runner.replace('/*@LIBS@*/null', JSON.stringify(libs)), ctx);
    const onMessage = winL.find(l => l.type === 'message')!.fn;
    onMessage({ source: parent, data: { type: 'render', nonce: NONCE, kind: 'html', payload, inputs: { v: 1 } } });
    const TM = ctx.TM as {
      drawn(): void; fail(c: unknown, m?: unknown): void; action(k: unknown, p?: unknown): void; lib(n: string): Promise<unknown>;
    };
    const elementError = (target: unknown) => docL.find(l => l.type === 'error' && l.capture)!.fn({ target });
    const of = (type: string) => posts.filter(p => p.type === type);
    return { ctx, TM, posts, of, appended, elementError };
  }

  it('sets a frozen TM with download, drawn, fail, action and lib, and the frozen TM_INPUT', () => {
    const { ctx, TM } = render();
    expect(Object.keys(TM).sort()).toEqual(['action', 'download', 'drawn', 'fail', 'lib']);
    expect(Object.isFrozen(TM)).toBe(true);
    expect(Object.isFrozen(ctx.TM_INPUT)).toBe(true);
  });

  it('TM.drawn() posts drawn with the nonce, once', () => {
    const { TM, of } = render();
    TM.drawn(); TM.drawn();
    expect(of('drawn')).toEqual([{ type: 'drawn', nonce: NONCE }]);
  });

  it('TM.fail() posts library / unavailable / runtime / invalid-data; any other category is runtime; message ≤ 300', () => {
    const { TM, of } = render();
    TM.fail('library', 'no d3');
    TM.fail('unavailable', 'no frame');
    TM.fail('invalid-data');
    TM.fail('csp', 'x'.repeat(500));
    TM.fail({ toString: () => 'unavailable' }, 'y');
    expect(of('error')).toEqual([
      { type: 'error', nonce: NONCE, category: 'library', message: 'no d3' },
      { type: 'error', nonce: NONCE, category: 'unavailable', message: 'no frame' },
      { type: 'error', nonce: NONCE, category: 'invalid-data', message: '' },
      { type: 'error', nonce: NONCE, category: 'runtime', message: 'x'.repeat(300) },
      { type: 'error', nonce: NONCE, category: 'runtime', message: 'y' },
    ]);
  });

  it('TM.action() forwards a plain-JSON copy for the four kinds and throws on anything else', () => {
    const { TM, of } = render();
    const payload = { ids: [1, 2], at: new Date(0), skip: () => 1 };
    TM.action('select', payload);
    TM.action('table');
    const sent = of('action');
    expect(sent).toEqual([
      { type: 'action', nonce: NONCE, kind: 'select', payload: { ids: [1, 2], at: '1970-01-01T00:00:00.000Z' } },
      { type: 'action', nonce: NONCE, kind: 'table', payload: null },
    ]);
    expect(sent[0].payload).not.toBe(payload);
    expect(() => TM.action('navigate', {})).toThrow(/kind/);
    expect(() => TM.action('toString', {})).toThrow(/kind/);
    expect(() => TM.action('fly', () => 1)).toThrow(/JSON/);
    const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
    expect(() => TM.action('fly', cyclic)).toThrow();
    expect(() => TM.action('where', { s: 'x'.repeat(65_536) })).toThrow(/65,536/);
    expect(() => TM.action('where', 'x'.repeat(65_534))).not.toThrow();
    expect(of('action')).toHaveLength(3);
  });

  it('TM.lib() loads a script with its integrity and crossorigin, once, and resolves on load', async () => {
    const { TM, appended } = render();
    const p = TM.lib('d3');
    expect(TM.lib('d3')).toBe(p);
    expect(appended).toHaveLength(1);
    expect(appended[0]).toMatchObject({ tagName: 'SCRIPT', src: libs.d3.url, integrity: libs.d3.integrity, crossOrigin: 'anonymous' });
    appended[0].onload!();
    await expect(p).resolves.toBeUndefined();
  });

  it('TM.lib() loads a style as <link rel=stylesheet> with its integrity', async () => {
    const { TM, appended } = render();
    const p = TM.lib('maplibre-gl.css');
    expect(appended[0]).toMatchObject({ tagName: 'LINK', rel: 'stylesheet', href: libs['maplibre-gl.css'].url,
      integrity: libs['maplibre-gl.css'].integrity, crossOrigin: 'anonymous' });
    appended[0].onload!();
    await expect(p).resolves.toBeUndefined();
  });

  it('TM.lib() rejects an unknown name and a failed load (network or SRI), without a second error post', async () => {
    const { TM, appended, of, elementError } = render();
    await expect(TM.lib('lodash')).rejects.toThrow(/Unknown library/);
    await expect(TM.lib('__proto__')).rejects.toThrow(/Unknown library/);
    const p = TM.lib('turf');
    appended[0].onerror!();
    elementError(appended[0]);
    await expect(p).rejects.toThrow(/turf/);
    expect(of('error')).toEqual([]);
  });

  it("vega-interpreter through TM.lib() rejects until vega is loaded", async () => {
    const { TM } = render();
    await expect(TM.lib('vega-interpreter')).rejects.toThrow(/needs vega/);
  });

  it("a page's own library tag that fails is reported as library; other tags are not", () => {
    const { of, elementError } = render();
    elementError({ tagName: 'SCRIPT', src: libs.d3.url });
    elementError({ tagName: 'LINK', href: libs['maplibre-gl.css'].url });
    elementError({ tagName: 'SCRIPT', src: 'https://unpkg.com/three@0.170.0/build/three.module.js' });
    elementError({ tagName: 'IMG', src: libs.d3.url });
    expect(of('error').map(e => [e.category, e.message])).toEqual([
      ['library', `Could not load d3 (${libs.d3.url})`],
      ['library', `Could not load maplibre-gl.css (${libs['maplibre-gl.css'].url})`],
    ]);
  });
});

describe('canvas-runner.js vega signal bridge (render `actions`)', () => {
  const runner = readFileSync(path.join(import.meta.dirname, 'canvas-runner.js'), 'utf8');
  const NONCE = 'v'.repeat(32);
  type Fn = (name: string, value: unknown) => void;

  /** A fake opaque, framed window with fake vega libraries: renders a vega spec with `actions`. */
  async function vegaFrame(actions: unknown) {
    const posts: Record<string, unknown>[] = [];
    const listeners: Record<string, Fn> = {};
    const asked: string[] = [];
    const view = {
      runAsync: () => Promise.resolve(),
      addSignalListener(name: string, fn: Fn) {
        asked.push(name);
        if (name === 'missing') throw new Error('Unrecognized signal name: "missing"');
        listeners[name] = fn;
      },
    };
    const libs = { ...(libsTable() as Record<string, { url: string; integrity: string; kind: string }>) };
    libs['vega-interpreter'] = { url: 'data:text/javascript,export const expressionInterpreter = {};', integrity: 'sha384-x', kind: 'module' };
    const winL: { type: string; fn: (e: unknown) => void }[] = [];
    const parent = { postMessage: (m: Record<string, unknown>) => { posts.push(m); } };
    const ctx: Record<string, unknown> = {
      origin: 'null', parent, setTimeout, clearTimeout, Promise, innerWidth: 400, innerHeight: 300,
      URL: { createObjectURL: () => 'blob:null/1' }, Blob: class {},
      addEventListener: (type: string, fn: (e: unknown) => void) => { winL.push({ type, fn }); },
    };
    ctx.document = {
      createElement: (tag: string) => ({ tagName: tag.toUpperCase(), style: {} }),
      body: { appendChild: () => {} },
      documentElement: { style: {} },
      head: {
        appendChild: (el: { tagName: string; src?: string; onload?: () => void }) => {
          if (el.tagName !== 'SCRIPT' || !el.src) return;
          if (el.src === libs.vega.url) ctx.vega = { DisallowedObjectProperties: new Set(), parse: () => ({}), View: function () { return view; } };
          if (el.src === libs['vega-lite'].url) ctx.vegaLite = { compile: () => ({ spec: {} }) };
          queueMicrotask(() => el.onload?.());
        },
      },
    };
    ctx.self = ctx; ctx.window = ctx;
    vm.runInNewContext(runner.replace('/*@LIBS@*/null', JSON.stringify(libs)), ctx,
      { importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER } as vm.RunningCodeOptions);
    const onMessage = winL.find(l => l.type === 'message')!.fn;
    onMessage({ source: parent, data: { type: 'render', nonce: NONCE, kind: 'vega', payload: { mark: 'bar', data: { values: [] } }, actions } });
    for (let i = 0; i < 20 && !posts.some(p => p.type === 'rendered' || p.type === 'error'); i++) await new Promise(r => setTimeout(r, 5));
    return { posts, listeners, asked, actions: () => posts.filter(p => p.type === 'action'), send: (m: Record<string, unknown>) => onMessage({ source: parent, data: m }) };
  }

  const PICK = { signal: 'pick', kind: 'where', layer: 'eia-generators', field: 'energy_source', read: 'label' };
  const wait = (ms: number) => new Promise(r => setTimeout(r, ms));

  it('forwards a newly picked value 250 ms after the last change, with the nonce; an emptied selection posts nothing', async () => {
    const f = await vegaFrame([PICK]);
    expect(f.posts.map(p => p.type)).toEqual(['ready', 'rendered']);
    f.listeners.pick('pick', { label: ['Coal'] });
    f.listeners.pick('pick', { label: ['Coal', 'Gas'] });
    await wait(300);
    expect(f.actions()).toEqual([{ type: 'action', nonce: NONCE, kind: 'where', payload: { layer: 'eia-generators', field: 'energy_source', bin: 'Gas' } }]);
    f.listeners.pick('pick', { label: ['Wind'] });
    f.listeners.pick('pick', {});
    f.listeners.pick('pick', { label: [{ evil: 1 }] });
    f.listeners.pick('pick', { label: 'x'.repeat(201) });
    f.listeners.pick('pick', null);
    await wait(300);
    expect(f.actions()).toHaveLength(1);
    f.listeners.pick('pick', { label: 7 });
    await wait(300);
    expect(f.actions()[1].payload).toEqual({ layer: 'eia-generators', field: 'energy_source', bin: 7 });
    // The group already picked, clicked again: nothing; emptied, then picked again: posted.
    f.listeners.pick('pick', { label: [7] });
    await wait(300);
    expect(f.actions()).toHaveLength(2);
    f.listeners.pick('pick', {});
    f.listeners.pick('pick', { label: [7] });
    await wait(300);
    expect(f.actions()).toHaveLength(3);
  });

  it('actions-reset (matching nonce only) forgets the last value so the same group can be applied again', async () => {
    const f = await vegaFrame([PICK]);
    f.listeners.pick('pick', { label: ['Gas'] });
    await wait(300);
    expect(f.actions()).toHaveLength(1);
    f.listeners.pick('pick', { label: ['Gas'] });
    await wait(300);
    expect(f.actions()).toHaveLength(1);
    f.send({ type: 'actions-reset', nonce: 'x'.repeat(32) });      // another nonce: ignored
    f.listeners.pick('pick', { label: ['Gas'] });
    await wait(300);
    expect(f.actions()).toHaveLength(1);
    f.send({ type: 'actions-reset', nonce: NONCE });
    f.listeners.pick('pick', { label: ['Gas'] });
    await wait(300);
    expect(f.actions()).toHaveLength(2);
  });

  it('a multi-select posts only a newly ADDED value: toggling the last one off posts nothing', async () => {
    const f = await vegaFrame([PICK]);
    f.listeners.pick('pick', { label: ['Coal'] });
    await wait(300);
    f.listeners.pick('pick', { label: ['Coal', 'Gas'] });
    await wait(300);
    expect(f.actions().map(a => (a.payload as { bin: string }).bin)).toEqual(['Coal', 'Gas']);
    f.listeners.pick('pick', { label: ['Coal'] });        // Gas shift-clicked off: Coal was not newly picked
    await wait(300);
    expect(f.actions()).toHaveLength(2);
    f.listeners.pick('pick', { label: ['Coal', 'Wind'] });
    await wait(300);
    expect(f.actions()[2].payload).toMatchObject({ bin: 'Wind' });
  });

  it('reads the first 8 entries, drops the malformed ones, and skips a signal the chart lacks', async () => {
    const f = await vegaFrame([
      { ...PICK, signal: 'bad name' }, { ...PICK, kind: 'navigate' }, { ...PICK, read: undefined }, { ...PICK, layer: 'x'.repeat(65) },
      { ...PICK, signal: 'missing' }, PICK, ...Array.from({ length: 8 }, (_, i) => ({ ...PICK, signal: `s${i}` })),
    ]);
    expect(f.asked).toEqual(['missing', 'pick', 's0', 's1']);
    expect(f.posts.some(p => p.type === 'rendered')).toBe(true);
  });

  it('adds no listener without actions', async () => {
    const f = await vegaFrame(undefined);
    expect(f.asked).toEqual([]);
    expect(f.posts.some(p => p.type === 'rendered')).toBe(true);
  });
});
