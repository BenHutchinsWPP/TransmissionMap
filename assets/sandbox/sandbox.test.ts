// @vitest-environment jsdom
// The analysis sandbox: the committed public/sandbox.html is what
// scripts/build_sandbox.mjs generates, its CSP is exactly the planned one, and
// sandbox-host.ts keeps to the protocol (source + nonce, caps, timeout).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
import path from 'node:path';
import { generate, stripKit, OUT } from '../../scripts/build_sandbox.mjs';
import * as kit from './geo-kit.js';

const html = readFileSync(OUT as string, 'utf8');

describe('public/sandbox.html', () => {
  it('is what build_sandbox.mjs generates (run npm run build:sandbox after editing runner.js or geo-kit.ts)', () => {
    expect(html).toBe(generate());
  });

  it('carries the exact CSP, hashing its one inline script, with no unsafe-eval', () => {
    const csp = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]*)">/)![1];
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
    expect(scripts).toHaveLength(1);
    expect(html.match(/<script/g)).toHaveLength(1);
    const hash = createHash('sha256').update(scripts[0][1], 'utf8').digest('base64');
    expect(csp).toBe(`default-src 'none'; script-src 'sha256-${hash}'; worker-src blob:`);
    expect(csp).not.toContain('unsafe-eval');
    expect(csp).not.toContain('unsafe-inline');
  });

  it('strips geo-kit.ts into a plain script whose functions match the module', () => {
    const js: string = stripKit(readFileSync(path.join(import.meta.dirname, 'geo-kit.ts'), 'utf8'));
    expect(js).not.toMatch(/^\s*(import|export)\b/m);
    const ctx: Record<string, unknown> = {};
    vm.runInNewContext(`${js}\nthis.out = { bbox, areaKm2, lengthKm, pointInGeometry };`, ctx);
    const out = ctx.out as typeof kit;
    const poly = { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]] };
    expect(out.bbox(poly)).toEqual(kit.bbox(poly));
    expect(out.areaKm2(poly)).toBe(kit.areaKm2(poly));
    expect(out.pointInGeometry([0.5, 0.5], poly)).toBe(true);
    expect(out.lengthKm({ type: 'LineString', coordinates: [[0, 0], [1, 1]] })).toBe(kit.lengthKm({ type: 'LineString', coordinates: [[0, 0], [1, 1]] }));
  });

  it('refuses an inline script that could end the <script> element', () => {
    expect(() => generate('export const x = 1;', 'var s = "</script>";')).toThrow();
  });
});

describe('runner.js origin guard', () => {
  const runner = readFileSync(path.join(import.meta.dirname, 'runner.js'), 'utf8');

  it('checks for an opaque origin and a parent before any listener, post or worker', () => {
    const guard = runner.indexOf("if (self.origin !== 'null' || window.parent === window) return;");
    expect(guard).toBeGreaterThan(-1);
    for (const tok of ['addEventListener(', 'postMessage(', 'new Worker(', 'probe();']) {
      expect(runner.indexOf(tok), tok).toBeGreaterThan(guard);
    }
  });

  /** Runs the runner (as the build inlines it) in a fake frame global; reports what it touched. */
  function boot(origin: string, framed: boolean) {
    const touched = { listeners: 0, posts: 0, workers: 0 };
    const parent = { postMessage: () => { touched.posts++; } };
    const ctx: Record<string, unknown> = {
      origin,
      addEventListener: () => { touched.listeners++; },
      postMessage: () => { touched.posts++; },
      setTimeout: () => 0, clearTimeout: () => {},
      Blob: class {},
      URL: { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} },
      Worker: class { constructor() { touched.workers++; } terminate() {} },
    };
    ctx.self = ctx; ctx.window = ctx;
    ctx.parent = framed ? parent : ctx;
    vm.runInNewContext(`const GEO_KIT = "";\n${runner}`, ctx);
    return touched;
  }

  it('stays inert with a real origin, framed or top-level', () => {
    expect(boot('https://app.example', true)).toEqual({ listeners: 0, posts: 0, workers: 0 });
    expect(boot('https://app.example', false)).toEqual({ listeners: 0, posts: 0, workers: 0 });
  });

  it('stays inert top-level even with an opaque origin', () => {
    expect(boot('null', false)).toEqual({ listeners: 0, posts: 0, workers: 0 });
  });

  it('starts when framed with an opaque origin (the guard is not always closed)', () => {
    const t = boot('null', true);
    expect(t.listeners).toBe(1);
    expect(t.workers).toBe(1);
  });
});

type Host = typeof import('./sandbox-host.js');

describe('sandbox-host', () => {
  let host: Host;
  beforeEach(async () => {
    vi.resetModules();
    document.body.innerHTML = '';
    host = await import('./sandbox-host.js');
  });
  afterEach(() => { vi.useRealTimers(); });

  const frames = () => [...document.querySelectorAll('iframe')];
  const frameWin = () => frames()[0].contentWindow!;
  const send = (data: unknown, source: Window | null = frameWin()) =>
    window.dispatchEvent(new MessageEvent('message', { data, source }));
  const tick = () => new Promise(r => setTimeout(r, 0));

  /** Starts a run, answers the ready ping and returns what the frame was sent. */
  async function start(code = 'return 1+1', inputs: unknown = {}) {
    const p = host.runInSandbox(code, inputs);
    await tick();
    const post = vi.spyOn(frameWin(), 'postMessage');
    send({ type: 'ready', worker: true });
    await tick(); await tick();
    expect(post).toHaveBeenCalledTimes(1);
    const msg = post.mock.calls[0][0] as { id: number; nonce: string; code: string; inputs: string };
    return { p, msg };
  }

  it('adds one hidden frame with sandbox="allow-scripts" exactly, from /sandbox.html', async () => {
    const { msg } = await start();
    expect(frames()).toHaveLength(1);
    const f = frames()[0];
    expect(f.getAttribute('sandbox')).toBe('allow-scripts');
    expect(f.getAttribute('src')).toBe('/sandbox.html');
    expect(f.hidden).toBe(true);
    expect(msg.code).toBe('return 1+1');
    expect(msg.inputs).toBe('{}');
    expect(msg.nonce).toMatch(/^[0-9a-f]{32}$/);
    send({ type: 'result', id: msg.id, nonce: msg.nonce, ok: true, value: 2, ms: 3 });
  });

  it('resolves only on the matching nonce, id and source', async () => {
    const { p, msg } = await start();
    let settled = false;
    p.then(() => { settled = true; });
    send({ type: 'result', id: msg.id, nonce: 'f'.repeat(32), ok: true, value: 'forged' });
    send({ type: 'result', id: msg.id + 1, nonce: msg.nonce, ok: true, value: 'forged' });
    send({ type: 'result', id: msg.id, nonce: msg.nonce, ok: true, value: 'forged' }, window);
    await tick();
    expect(settled).toBe(false);
    send({ type: 'result', id: msg.id, nonce: msg.nonce, ok: true, value: 2, ms: 5 });
    expect(await p).toEqual({ ok: true, result: { value: 2, ms: 5 } });
  });

  it('passes a runner error through as a refusal', async () => {
    const { p, msg } = await start('throw 1');
    send({ type: 'result', id: msg.id, nonce: msg.nonce, ok: false, error: 'Uncaught 1', ms: 1 });
    expect(await p).toEqual({ ok: false, reason: 'Uncaught 1' });
  });

  it('gives a new nonce per run and runs one at a time', async () => {
    const { p, msg } = await start();
    const post = vi.spyOn(frameWin(), 'postMessage');
    post.mockClear();
    const p2 = host.runInSandbox('return 3', []);
    await tick();
    expect(post).not.toHaveBeenCalled();
    send({ type: 'result', id: msg.id, nonce: msg.nonce, ok: true, value: 2 });
    await p; await tick(); await tick();
    expect(post).toHaveBeenCalledTimes(1);
    const msg2 = post.mock.calls[0][0] as { id: number; nonce: string };
    expect(msg2.nonce).not.toBe(msg.nonce);
    send({ type: 'result', id: msg2.id, nonce: msg2.nonce, ok: true, value: 3 });
    expect((await p2).ok).toBe(true);
  });

  it('removes the frame after 12 s without a reply, and the next run makes a new one', async () => {
    vi.useFakeTimers();
    const p = host.runInSandbox('while(true){}', {});
    await vi.advanceTimersByTimeAsync(0);
    const first = frames()[0];
    send({ type: 'ready', worker: true });
    await vi.advanceTimersByTimeAsync(host.BACKSTOP_MS - 1);
    expect(frames()).toEqual([first]);
    await vi.advanceTimersByTimeAsync(1);
    const r = await p;
    expect(r.ok).toBe(false);
    expect(frames()).toHaveLength(0);
    host.runInSandbox('return 1', {});
    await vi.advanceTimersByTimeAsync(0);
    expect(frames()).toHaveLength(1);
    expect(frames()[0]).not.toBe(first);
  });

  it("says analysis isn't available when the frame has no worker, and keeps saying so", async () => {
    const p = host.runInSandbox('return 1', {});
    await tick();
    send({ type: 'ready', worker: false });
    expect(await p).toEqual({ ok: false, reason: host.UNAVAILABLE });
    expect(frames()).toHaveLength(0);
    expect(await host.runInSandbox('return 1', {})).toEqual({ ok: false, reason: host.UNAVAILABLE });
    expect(frames()).toHaveLength(0);
  });

  it('ignores a ready ping from another source', async () => {
    vi.useFakeTimers();
    const p = host.runInSandbox('return 1', {});
    await vi.advanceTimersByTimeAsync(0);
    send({ type: 'ready', worker: true }, window);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await p).toEqual({ ok: false, reason: host.UNAVAILABLE });
  });

  it('resets the frame when it navigates after its ready ping', async () => {
    const { p } = await start();
    frames()[0].dispatchEvent(new Event('load'));
    frames()[0].dispatchEvent(new Event('load'));
    expect(await p).toEqual({ ok: false, reason: 'The analysis frame was reset' });
    expect(frames()).toHaveLength(0);
  });

  it('stops on abort and drops the frame', async () => {
    const ac = new AbortController();
    const p = host.runInSandbox('while(true){}', {}, { signal: ac.signal });
    await tick();
    send({ type: 'ready', worker: true });
    await tick(); await tick();
    ac.abort();
    expect(await p).toEqual({ ok: false, reason: 'Stopped.' });
    expect(frames()).toHaveLength(0);
  });

  it('refuses oversize or non-JSON inputs and oversize code before making a frame', async () => {
    const big = 'x'.repeat(host.MAX_INPUT_CHARS);
    expect((await host.runInSandbox('return 1', { big })).ok).toBe(false);
    const fc = { type: 'FeatureCollection', features: Array.from({ length: host.MAX_INPUT_FEATURES + 1 }, () => ({})) };
    const r = await host.runInSandbox('return 1', { a: fc });
    expect(r.ok === false && r.reason).toMatch(/50001 features/);
    expect((await host.runInSandbox('return 1', { n: 1n })).ok).toBe(false);
    const cyc: Record<string, unknown> = {}; cyc.self = cyc;
    expect((await host.runInSandbox('return 1', cyc)).ok).toBe(false);
    expect((await host.runInSandbox('x'.repeat(host.MAX_CODE_CHARS + 1), {})).ok).toBe(false);
    expect(frames()).toHaveLength(0);
  });

  it('counts features across collections, arrays and objects', () => {
    expect(host.countFeatures({ a: { type: 'FeatureCollection', features: [1, 2] }, b: [1, 2, 3], c: 'x' })).toBe(5);
    expect(host.countFeatures(null)).toBe(0);
  });
});
