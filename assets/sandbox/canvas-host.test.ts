// @vitest-environment jsdom
// The canvas host trusts only its own frame (event.source) and, after the
// render, the run's nonce; every later message may be forged by the model's
// code, so categories, messages and downloads are checked; the frame's loads
// tell a navigation apart from the html path's document.close(); at most three
// frames live at once. jsdom loads nothing: each test plays the frame's part
// with MessageEvents whose source is the iframe's contentWindow. A template
// frame (opts.template) is shown on `drawn` and is the only one whose actions
// reach the page.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runCanvas, requestPng, disposeAllCanvases, liveCanvases, safeName, checkDownload,
  MAX_DOWNLOAD_BYTES, MAX_ACTIONS, guardCsv, type CanvasRequest, type CanvasOptions, type CanvasDownload,
  type TemplateAction, type FrameControl } from './canvas-host.js';

const HTML: CanvasRequest = { kind: 'html', payload: '<p>hi</p>' };
const VEGA: CanvasRequest = { kind: 'vega', payload: { mark: 'bar' } };

function start(req: CanvasRequest = HTML, opts: CanvasOptions = {}) {
  const box = document.createElement('div');
  document.body.append(box);
  const run = runCanvas(box, req, opts);
  const frame = run.handle.frame;
  const win = frame.contentWindow!;
  const posted = vi.spyOn(win, 'postMessage').mockImplementation(() => {});
  const from = (data: unknown, source: unknown = win) =>
    window.dispatchEvent(new MessageEvent('message', { data, source: source as Window }));
  const ready = () => { frame.dispatchEvent(new Event('load')); from({ type: 'ready' }); };
  const nonce = () => (posted.mock.calls[0][0] as { nonce: string }).nonce;
  let state: unknown = 'pending';
  void run.then(o => { state = o; });
  const settled = async () => { await Promise.resolve(); await Promise.resolve(); return state; };
  return { run, frame, win, posted, from, ready, nonce, settled, box };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { disposeAllCanvases(); vi.useRealTimers(); document.body.replaceChildren(); });

describe('runCanvas', () => {
  it('frames canvas.html with sandbox exactly allow-scripts and no referrer', () => {
    const { frame } = start();
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
    expect(frame.getAttribute('referrerpolicy')).toBe('no-referrer');
    expect(frame.getAttribute('src')).toMatch(/canvas\.html$/);
  });

  it('sends the render on ready with a 32-hex nonce, then resolves on rendered', async () => {
    const c = start({ ...HTML, inputs: { a: 1 }, width: 300 });
    c.ready();
    const msg = c.posted.mock.calls[0][0] as Record<string, unknown>;
    expect(msg).toMatchObject({ type: 'render', kind: 'html', payload: '<p>hi</p>', inputs: { a: 1 }, width: 300 });
    expect(c.nonce()).toMatch(/^[0-9a-f]{32}$/);
    c.from({ type: 'rendered', nonce: c.nonce() });
    expect(await c.settled()).toEqual({ shown: true });
  });

  it('ignores messages from another source and with the wrong nonce', async () => {
    const c = start();
    c.from({ type: 'ready' }, window);
    expect(c.posted).not.toHaveBeenCalled();
    c.ready();
    c.from({ type: 'rendered', nonce: c.nonce() }, window);
    c.from({ type: 'rendered', nonce: 'f'.repeat(32) });
    c.from({ type: 'rendered' });
    expect(await c.settled()).toBe('pending');
    c.from({ type: 'rendered', nonce: c.nonce() });
    expect(await c.settled()).toEqual({ shown: true });
  });

  it('maps an unknown category to runtime and cuts the message to 300 chars', async () => {
    const c = start();
    c.ready();
    c.from({ type: 'error', nonce: c.nonce(), category: 'nonsense', message: 'x'.repeat(1000) });
    const o = await c.settled() as { error: string; message: string };
    expect(o.error).toBe('runtime');
    expect(o.message).toHaveLength(300);
  });

  it('keeps a known category; a non-string message is dropped; later errors go to onError', async () => {
    const onError = vi.fn();
    const c = start(HTML, { onError });
    c.ready();
    c.from({ type: 'error', nonce: c.nonce(), category: 'syntax', message: { evil: 1 } });
    expect(await c.settled()).toEqual({ error: 'syntax' });
    c.from({ type: 'error', nonce: c.nonce(), category: 'runtime', message: 'later' });
    c.from({ type: 'rendered', nonce: c.nonce() });
    expect(onError).toHaveBeenCalledWith({ error: 'runtime', message: 'later' });
    expect(await c.settled()).toEqual({ error: 'syntax' });
  });

  it('times out 10 s after the render and keeps the frame', async () => {
    const c = start();
    c.ready();
    vi.advanceTimersByTime(9_999);
    expect(await c.settled()).toBe('pending');
    vi.advanceTimersByTime(1);
    expect(await c.settled()).toEqual({ error: 'timeout' });
    expect(c.frame.isConnected).toBe(true);
  });

  it('is unavailable and removes the frame when no ready comes in 10 s', async () => {
    const c = start();
    vi.advanceTimersByTime(10_000);
    expect(await c.settled()).toEqual({ error: 'unavailable' });
    expect(c.frame.isConnected).toBe(false);
  });

  it('html: the load at document.close() is expected; a third load is a navigation', async () => {
    const onClosed = vi.fn();
    const c = start(HTML, { onClosed });
    c.ready();
    c.frame.dispatchEvent(new Event('load'));
    expect(c.frame.isConnected).toBe(true);
    c.from({ type: 'rendered', nonce: c.nonce() });
    c.frame.dispatchEvent(new Event('load'));
    expect(c.frame.isConnected).toBe(false);
    expect(onClosed).toHaveBeenCalledWith('navigated');
    expect(await c.settled()).toEqual({ shown: true });
  });

  it('vega: a second load is a navigation, and resolves runtime/navigated before rendered', async () => {
    const onClosed = vi.fn();
    const c = start(VEGA, { onClosed });
    c.ready();
    c.frame.dispatchEvent(new Event('load'));
    expect(c.frame.isConnected).toBe(false);
    expect(onClosed).toHaveBeenCalledWith('navigated');
    expect(await c.settled()).toEqual({ error: 'runtime', message: 'navigated' });
  });

  it('a second ready is a navigation', () => {
    const c = start();
    c.ready();
    c.from({ type: 'ready' });
    expect(c.frame.isConnected).toBe(false);
  });

  it('a fourth frame disposes the oldest', () => {
    const closed = vi.fn();
    const first = start(HTML, { onClosed: closed });
    start(); start();
    expect(liveCanvases()).toBe(3);
    start();
    expect(liveCanvases()).toBe(3);
    expect(first.frame.isConnected).toBe(false);
    expect(closed).toHaveBeenCalledWith('evicted');
  });

  it('an aborted signal disposes the frame before it has rendered', async () => {
    const ctl = new AbortController();
    const c = start(HTML, { signal: ctl.signal });
    c.ready();
    ctl.abort();
    expect(c.frame.isConnected).toBe(false);
    expect(await c.settled()).toEqual({ error: 'unavailable' });
  });

  it("a rendered frame survives the turn's Stop, and is still removed with the chat", async () => {
    const ctl = new AbortController();
    const c = start(VEGA, { signal: ctl.signal });
    c.ready();
    c.from({ type: 'rendered', nonce: c.nonce() });
    ctl.abort();
    expect(c.frame.isConnected).toBe(true);
    expect(await c.settled()).toEqual({ shown: true });
    disposeAllCanvases();
    expect(c.frame.isConnected).toBe(false);
  });

  it('a csp error never decides the outcome: it goes to onError and the frame still renders', async () => {
    const onError = vi.fn();
    const c = start(HTML, { onError });
    c.ready();
    c.from({ type: 'error', nonce: c.nonce(), category: 'csp', message: 'Blocked by the canvas policy (font-src): https://x.example/f.woff' });
    expect(await c.settled()).toBe('pending');
    expect(onError).toHaveBeenCalledWith({ error: 'runtime', message: 'Blocked by the canvas policy (font-src): https://x.example/f.woff' });
    c.from({ type: 'rendered', nonce: c.nonce() });
    expect(await c.settled()).toEqual({ shown: true });
  });
});

describe('downloads', () => {
  it('validates mime, size and count; forces the name and extension', () => {
    const got: CanvasDownload[] = [];
    const c = start(HTML, { onDownload: d => got.push(d) });
    c.ready();
    const dl = (o: Record<string, unknown>) => c.from({ type: 'download', nonce: c.nonce(), ...o });
    dl({ name: 'x.html', mime: 'text/html', data: '<script>' });
    dl({ name: 'big.csv', mime: 'text/csv', data: new ArrayBuffer(MAX_DOWNLOAD_BYTES + 1) });
    dl({ name: 'obj.json', mime: 'application/json', data: { a: 1 } });
    expect(got).toHaveLength(0);
    dl({ name: '../../evil.exe', mime: 'image/png', data: new ArrayBuffer(4) });
    dl({ name: 'rows', mime: 'text/csv;charset=utf-8', data: 'a,b' });
    dl({ name: 'a.svg', mime: 'image/svg+xml', data: '<svg/>' });
    dl({ name: 'm.glb', mime: 'model/gltf-binary', data: new ArrayBuffer(1) });
    dl({ name: 'n.txt', mime: 'text/plain', data: 'n' });
    dl({ name: 'sixth.txt', mime: 'text/plain', data: 'n' });
    expect(got.map(d => [d.name, d.mime])).toEqual([
      ['evil.png', 'image/png'], ['rows.csv', 'text/csv'],
      ['m.glb', 'model/gltf-binary'], ['n.txt', 'text/plain'], ['sixth.txt', 'text/plain'],
    ]);
  });

  it('guards formula cells in CSV downloads, quote-aware', () => {
    const input = ['a,b', '=1+1,"@x"', '"q ""=""",-5,+y', '\tz,ok,x=y'].join('\n');
    const want = ['a,b', "'=1+1,\"'@x\"", '"q ""=""",\'-5,\'+y', "'\tz,ok,x=y"].join('\n');
    expect(guardCsv(input)).toBe(want);
    const got: CanvasDownload[] = [];
    const c = start(HTML, { onDownload: d => got.push(d) });
    c.ready();
    c.from({ type: 'download', nonce: c.nonce(), name: 'r', mime: 'text/csv', data: '=cmd' });
    expect(got[0].data).toBe("'=cmd");
  });

  it('a download with the wrong nonce is ignored', () => {
    const onDownload = vi.fn();
    const c = start(HTML, { onDownload });
    c.ready();
    c.from({ type: 'download', nonce: '0'.repeat(32), name: 'a', mime: 'text/plain', data: 'x' });
    expect(onDownload).not.toHaveBeenCalled();
  });

  it('a requested vega PNG is marked requested and not counted', () => {
    const got: CanvasDownload[] = [];
    const c = start(VEGA, { onDownload: d => got.push(d) });
    c.ready();
    for (let i = 0; i < 7; i++) {
      expect(requestPng(c.run.handle)).toBe(true);
      c.from({ type: 'download', nonce: c.nonce(), name: 'chart.png', mime: 'image/png', data: new ArrayBuffer(8) });
    }
    expect(got).toHaveLength(7);
    expect(got.every(d => d.requested)).toBe(true);
    expect(c.posted.mock.calls.filter(([m]) => (m as { type: string }).type === 'png')).toHaveLength(7);
  });

  it("a template frame's download is requested only with activation AND the frame focused, once per focus, and always counted", () => {
    const active = { isActive: false };
    vi.stubGlobal('navigator', { ...navigator, userActivation: active });
    try {
      const got: CanvasDownload[] = [];
      const t = start(HTML, { template: true, onDownload: d => got.push(d) });
      t.ready();
      const dl = () => t.from({ type: 'download', nonce: t.nonce(), name: 'x', mime: 'text/csv', data: 'a' });
      // The visitor clicks into the frame: it takes focus and the page's window blurs.
      const clickIn = () => { t.frame.focus(); window.dispatchEvent(new Event('blur')); };
      const chat = document.createElement('input');
      document.body.append(chat);
      dl();                                   // no activation
      active.isActive = true;
      chat.focus();
      window.dispatchEvent(new Event('blur'));
      dl();                                   // page-wide activation (typing in the chat), frame not focused
      clickIn();
      expect(document.activeElement).toBe(t.frame);
      dl();                                   // the visitor's click in the frame: saved at once, focus leaves the frame
      expect(document.activeElement).not.toBe(t.frame);
      t.frame.focus();
      dl();                                   // focused again without a new blur into it (no fresh click): Save button
      clickIn();
      dl();                                   // a fresh click in the frame
      clickIn();
      dl();                                   // the sixth file: over MAX_DOWNLOADS, dropped
      expect(got.map(d => d.requested)).toEqual([false, false, true, false, true]);
      const model: CanvasDownload[] = [];
      const m = start(HTML, { onDownload: d => model.push(d) });
      m.ready();
      m.frame.focus();
      window.dispatchEvent(new Event('blur'));
      m.from({ type: 'download', nonce: m.nonce(), name: 'x', mime: 'text/csv', data: 'a' });
      expect(model.map(d => d.requested)).toEqual([false]);
    } finally { vi.unstubAllGlobals(); }
  });

  it('without the userActivation API a template download waits for Save', () => {
    vi.stubGlobal('navigator', { ...navigator, userActivation: undefined });
    try {
      const got: CanvasDownload[] = [];
      const t = start(HTML, { template: true, onDownload: d => got.push(d) });
      t.ready();
      t.from({ type: 'download', nonce: t.nonce(), name: 'x', mime: 'text/csv', data: 'a' });
      expect(got.map(d => d.requested)).toEqual([false]);
    } finally { vi.unstubAllGlobals(); }
  });

  it('requestPng refuses an html frame', () => {
    const c = start();
    c.ready();
    expect(requestPng(c.run.handle)).toBe(false);
  });

  it('safeName keeps [A-Za-z0-9 ._-], ≤ 80 chars, with the forced extension', () => {
    expect(safeName('My chart (2026).PNG', 'png')).toBe('My chart -2026.png');
    expect(safeName('../x', 'csv')).toBe('x.csv');
    expect(safeName('', 'json')).toBe('download.json');
    expect(safeName('a'.repeat(200), 'geojson')).toHaveLength(80);
    expect(safeName('名前.csv', 'csv')).toBe('download.csv');
  });

  it('checkDownload measures a string as UTF-8 bytes', () => {
    expect(checkDownload({ name: 'a', mime: 'text/plain', data: 'é'.repeat(MAX_DOWNLOAD_BYTES / 2 + 1) })).toBeNull();
    expect(checkDownload({ name: 'a', mime: 'text/plain', data: 'é' })).not.toBeNull();
  });
});

describe('template frames', () => {
  const TPL = { template: true } as const;

  it('an html template resolves on drawn, not on rendered', async () => {
    const c = start(HTML, TPL);
    c.ready();
    expect(c.run.handle.template).toBe(true);
    c.from({ type: 'rendered', nonce: c.nonce() });
    expect(await c.settled()).toBe('pending');
    c.from({ type: 'drawn', nonce: '0'.repeat(32) });
    expect(await c.settled()).toBe('pending');
    c.from({ type: 'drawn', nonce: c.nonce() });
    expect(await c.settled()).toEqual({ shown: true });
  });

  it('an html template times out 15 s after the render without drawn, and keeps the frame', async () => {
    const c = start(HTML, TPL);
    c.ready();
    vi.advanceTimersByTime(14_999);
    expect(await c.settled()).toBe('pending');
    vi.advanceTimersByTime(1);
    expect(await c.settled()).toEqual({ error: 'timeout' });
    expect(c.frame.isConnected).toBe(true);
  });

  it('a drawn template survives the turn\'s Stop', async () => {
    const ctl = new AbortController();
    const c = start(HTML, { ...TPL, signal: ctl.signal });
    c.ready();
    c.from({ type: 'drawn', nonce: c.nonce() });
    ctl.abort();
    expect(c.frame.isConnected).toBe(true);
  });

  it('a vega template still resolves on rendered', async () => {
    const c = start(VEGA, TPL);
    c.ready();
    c.from({ type: 'rendered', nonce: c.nonce() });
    expect(await c.settled()).toEqual({ shown: true });
  });

  it('a free-form frame ignores drawn and resolves on rendered', async () => {
    const c = start();
    c.ready();
    expect(c.run.handle.template).toBe(false);
    c.from({ type: 'drawn', nonce: c.nonce() });
    expect(await c.settled()).toBe('pending');
    c.from({ type: 'rendered', nonce: c.nonce() });
    expect(await c.settled()).toEqual({ shown: true });
  });

  it('TM.fail categories: library and invalid-data settle a template; invalid-data reads runtime elsewhere', async () => {
    const t = start(HTML, TPL);
    t.ready();
    t.from({ type: 'error', nonce: t.nonce(), category: 'invalid-data', message: 'no rows' });
    expect(await t.settled()).toEqual({ error: 'invalid-data', message: 'no rows' });
    const u = start(HTML, TPL);
    u.ready();
    u.from({ type: 'error', nonce: u.nonce(), category: 'library', message: 'Could not load d3' });
    expect(await u.settled()).toEqual({ error: 'library', message: 'Could not load d3' });
    const f = start();
    f.ready();
    f.from({ type: 'error', nonce: f.nonce(), category: 'invalid-data' });
    expect(await f.settled()).toEqual({ error: 'runtime' });
  });

  it('actions reach onAction only from a template frame, after the source and nonce checks, kind checked', () => {
    const got: TemplateAction[] = [];
    const freeForm = start(HTML, { onAction: a => got.push(a) });
    freeForm.ready();
    freeForm.from({ type: 'action', nonce: freeForm.nonce(), kind: 'select', payload: { ids: [1] } });
    expect(got).toEqual([]);

    const c = start(HTML, { ...TPL, onAction: a => got.push(a) });
    c.ready();
    c.from({ type: 'action', nonce: c.nonce(), kind: 'select', payload: { ids: [1] } }, window);
    c.from({ type: 'action', nonce: '0'.repeat(32), kind: 'select', payload: { ids: [1] } });
    c.from({ type: 'action', nonce: c.nonce(), kind: 'navigate', payload: {} });
    expect(got).toEqual([]);
    c.from({ type: 'action', nonce: c.nonce(), kind: 'select', payload: { ids: [1] } });
    c.from({ type: 'action', nonce: c.nonce(), kind: 'fly', payload: { center: [-100, 40] } });
    expect(got).toEqual([{ kind: 'select', payload: { ids: [1] } }, { kind: 'fly', payload: { center: [-100, 40] } }]);
  });

  it('an action\'s release() moves keyboard focus from the frame back to the page', () => {
    let ctl: FrameControl | undefined;
    const c = start(HTML, { ...TPL, onAction: (_a, f) => { ctl = f; } });
    c.ready();
    c.from({ type: 'action', nonce: c.nonce(), kind: 'where', payload: { field: 'x', bin: 'y' } });
    const frame = c.frame;
    frame.focus();
    expect(document.activeElement).toBe(frame);
    ctl!.release();
    expect(document.activeElement).not.toBe(frame);
    const other = document.createElement('button');
    document.body.append(other);
    other.focus();
    ctl!.release();                       // focus elsewhere stays where it is
    expect(document.activeElement).toBe(other);
  });

  it(`at most ${MAX_ACTIONS} actions per frame`, () => {
    const onAction = vi.fn();
    const c = start(HTML, { ...TPL, onAction });
    c.ready();
    for (let i = 0; i < MAX_ACTIONS + 10; i++) c.from({ type: 'action', nonce: c.nonce(), kind: 'table', payload: null });
    expect(onAction).toHaveBeenCalledTimes(MAX_ACTIONS);
  });

  it('sends the signal bridge (render `actions`) to a vega template frame only', () => {
    const signals = [{ signal: 'pick', kind: 'where' as const, layer: 'eia-generators', field: 'energy_source', read: 'label' }];
    const sent = (req: CanvasRequest, opts: CanvasOptions) => {
      const c = start(req, opts);
      c.ready();
      return c.posted.mock.calls[0][0] as Record<string, unknown>;
    };
    expect(sent(VEGA, { ...TPL, signals }).actions).toEqual(signals);
    expect(sent(VEGA, { signals })).not.toHaveProperty('actions');
    expect(sent(HTML, { ...TPL, signals })).not.toHaveProperty('actions');
    expect(sent(VEGA, { ...TPL, signals: [] })).not.toHaveProperty('actions');
  });
});
