import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { ESLint } from 'eslint';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the frame window and Kit are untyped script globals
type Loose = any;
const { JSDOM } = createRequire(import.meta.url)('jsdom') as { JSDOM: new (html: string, opts: object) => { window: Loose } };

const KIT = readFileSync(new URL('./kit.js', import.meta.url), 'utf8');

function payload(over: Record<string, unknown> = {}) {
  return {
    v: 1, template: 'composition', params: { title: 'from params' }, scope: 'view',
    rows: [
      { fuel: 'gas', count: 3, sum: 1200.5 },
      { fuel: '=HYPERLINK("x")', count: 1, sum: -4 },
      { fuel: 'wind, onshore', count: 2, sum: 10 },
    ],
    roles: { by: [{ field: 'fuel', role: 'category' }], measure: { name: 'capacity_mw', unit: 'MW' } },
    colours: { fuel: { gas: '#ff0000', bad: 'red' } },
    labels: { title: 'Capacity by fuel', scopeView: 'Current view', partial: 'Partial data', tiersHidden: 'Hidden tiers:', 'tier.lv': 'Low voltage (< 50 kV)', table: 'Table', unavailable: 'Library failed', locale: 'en-US', measure: 'Capacity' },
    credit: 'EIA-860', units: {}, complete: false, truncated: true, truncation: 'rows cut at 50,000',
    tiersHidden: ['lv', 'mv'], theme: 'light', ...over,
  };
}

function frame(input: unknown, lib: (n: string) => Promise<unknown> = () => Promise.resolve({})) {
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { runScripts: 'outside-only' });
  const w = dom.window;
  const TM = { drawn: vi.fn(), fail: vi.fn(), action: vi.fn(), download: vi.fn(), lib: vi.fn(lib) };
  const sink = vi.fn();
  for (const p of ['innerHTML', 'outerHTML']) Object.defineProperty(w.Element.prototype, p, { set: sink, get: () => '' });
  w.Element.prototype.insertAdjacentHTML = sink;
  w.TM = TM;
  w.TM_INPUT = input;
  w.eval(KIT);
  return { w, Kit: w.Kit, TM, sink, doc: w.document };
}

describe('kit.js', () => {
  it('names no HTML sink in its source', () => {
    expect(KIT).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function/);
  });

  it('defines one frozen Kit', () => {
    const { Kit } = frame(payload());
    expect(Object.isFrozen(Kit)).toBe(true);
    expect(Object.keys(Kit).sort()).toEqual(['action', 'colour', 'csv', 'downloadPng', 'drawn', 'fmt', 'input', 'libs', 'menu', 'mount', 'reducedMotion', 'registerExport'].sort());
  });

  it('refuses a payload that is not v1', () => {
    const { Kit, TM } = frame({ v: 2, rows: [] });
    expect(Kit.input()).toBeNull();
    expect(Kit.mount()).toBeNull();
    expect(TM.fail).toHaveBeenCalledWith('invalid-data', expect.any(String));
  });

  it('mounts header, banner, body, footer and the table with text only', () => {
    const { Kit, doc, sink } = frame(payload());
    const m = Kit.mount();
    expect(Kit.mount()).toBe(m);
    expect(doc.querySelector('style')!.textContent).toContain('.kit{');
    expect(doc.querySelector('h1')!.textContent).toBe('Capacity by fuel');
    const banner = doc.querySelector('.kit-banner')!;
    expect(banner.getAttribute('role')).toBe('note');
    expect(banner.textContent).toContain('Current view');
    expect(banner.textContent).toContain('Hidden tiers: Low voltage (< 50 kV), mv');
    expect(banner.textContent).toContain('Partial data');
    expect(banner.textContent).toContain('rows cut at 50,000');
    expect(m.body.className).toBe('kit-body');
    expect(doc.querySelector('footer')!.textContent).toBe('EIA-860 · composition');
    expect(doc.documentElement.lang).toBe('en-US');

    const box = doc.querySelector('.kit-table-box') as HTMLElement;
    expect(box.hidden).toBe(true);
    (doc.querySelector('.kit-btn') as HTMLButtonElement).click();
    expect(box.hidden).toBe(false);
    expect([...doc.querySelectorAll('th')].map(t => t.textContent)).toEqual(['fuel', 'count', 'Capacity (MW)']);
    expect(doc.querySelectorAll('tbody tr')).toHaveLength(3);
    expect(doc.querySelectorAll('tbody tr')[1].firstElementChild!.textContent).toBe('=HYPERLINK("x")');
    expect(doc.querySelectorAll('tbody td')[2].textContent).toBe('1,201');
    expect(sink).not.toHaveBeenCalled();
  });

  it('falls back to the params title and hides an empty banner', () => {
    const p = payload({ labels: {}, complete: true, truncated: false, tiersHidden: undefined, scope: 'area' });
    const { Kit, doc } = frame(p);
    Kit.mount();
    expect(doc.querySelector('h1')!.textContent).toBe('from params');
    expect((doc.querySelector('.kit-banner') as HTMLElement).hidden).toBe(true);
  });

  it('writes a guarded CSV with a BOM and downloads it', () => {
    const { Kit, TM, doc } = frame(payload());
    const text: string = Kit.csv();
    expect(text.startsWith('﻿')).toBe(true);
    const lines = text.slice(1).split('\r\n');
    expect(lines[0]).toBe('fuel,count,Capacity (MW)');
    expect(lines[1]).toBe('gas,3,1200.5');
    expect(lines[2]).toBe(`"'=HYPERLINK(""x"")",1,-4`);
    expect(lines[3]).toBe('"wind, onshore",2,10');
    expect(lines[4]).toBe('EIA-860');
    for (const c of ['+1', '-x', '@a', '\tt']) expect(Kit.csv([{ a: c, count: 1 }]).split('\r\n')[1].replace(/^"|"$/g, '').startsWith("'")).toBe(true);
    Kit.mount();
    (doc.querySelectorAll('.kit-dl-menu .kit-btn')[0] as HTMLButtonElement).click();
    expect(TM.download).toHaveBeenCalledWith('composition.csv', 'text/csv;charset=utf-8', text);
  });

  it('does not repeat a unit the measure label already carries', () => {
    const p = payload({ labels: { title: 't', measure: 'Length (km)', locale: 'en-US' }, roles: { by: [], measure: { name: 'length_km', unit: 'km' } } });
    const { Kit } = frame(p);
    expect(Kit.csv().slice(1).split('\r\n')[0]).toBe('fuel,count,Length (km)');
  });

  it('shows PNG only once an export element is registered, and downloads a canvas as PNG', async () => {
    const { Kit, TM, doc } = frame(payload());
    Kit.mount();
    const png = doc.querySelectorAll('.kit-dl-menu .kit-btn')[1] as HTMLButtonElement;
    expect(png.hidden).toBe(true);
    expect(() => Kit.registerExport(doc.createElement('div'))).toThrow(/canvas or svg/);
    const c = doc.createElement('canvas');
    const bytes = new Uint8Array([137, 80, 78, 71]).buffer;
    (c as Loose).toBlob = (cb: (b: unknown) => void) => cb({ arrayBuffer: () => Promise.resolve(bytes) });
    Kit.registerExport(c);
    expect(png.hidden).toBe(false);
    await Kit.downloadPng();
    expect(TM.download).toHaveBeenCalledWith('composition.png', 'image/png', bytes);
  });

  it('waits for beforeExport, then draws the element registered by then', async () => {
    const { Kit, TM, doc } = frame(payload());
    Kit.mount();
    const canvasOf = (n: number) => {
      const c = doc.createElement('canvas');
      (c as Loose).toBlob = (cb: (b: unknown) => void) => cb({ arrayBuffer: () => Promise.resolve(new Uint8Array([n]).buffer) });
      return c;
    };
    let release!: () => void;
    const fresh = canvasOf(2);
    Kit.registerExport(canvasOf(1), { beforeExport: () => new Promise<void>(r => { release = () => { Kit.registerExport(fresh); r(); }; }) });
    const done = Kit.downloadPng();
    await Promise.resolve();
    expect(TM.download).not.toHaveBeenCalled();
    release();
    await done;
    expect(new Uint8Array(TM.download.mock.calls[0][2] as ArrayBuffer)[0]).toBe(2);
  });

  it('a hook that throws or never settles does not block the PNG for long', async () => {
    vi.useFakeTimers();
    try {
      const { Kit, TM, doc } = frame(payload());
      const c = doc.createElement('canvas');
      (c as Loose).toBlob = (cb: (b: unknown) => void) => cb({ arrayBuffer: () => Promise.resolve(new ArrayBuffer(1)) });
      Kit.registerExport(c, { beforeExport: () => { throw new Error('x'); } });
      await Kit.downloadPng();
      expect(TM.download).toHaveBeenCalledTimes(1);
      Kit.registerExport(c, { beforeExport: () => new Promise(() => {}) });
      const p = Kit.downloadPng();
      await vi.advanceTimersByTimeAsync(5000);
      await p;
      expect(TM.download).toHaveBeenCalledTimes(2);
    } finally { vi.useRealTimers(); }
  });

  it('mount({rows}) puts those rows in the table and the CSV', () => {
    const { Kit, TM, doc } = frame(payload());
    Kit.mount({ rows: [{ name: 'a', longitude: 1, latitude: 2 }, { name: 'b', longitude: 3, latitude: 4 }] });
    (doc.querySelector('.kit-btn') as HTMLButtonElement).click();
    expect([...doc.querySelectorAll('th')].map(t => t.textContent)).toEqual(['name', 'longitude', 'latitude']);
    expect(doc.querySelectorAll('tbody tr')).toHaveLength(2);
    (doc.querySelectorAll('.kit-dl-menu .kit-btn')[0] as HTMLButtonElement).click();
    expect((TM.download.mock.calls[0][2] as string).slice(1).split('\r\n')[1]).toBe('a,1,2');
  });

  it('on a library failure: TM.fail, the fallback text and the table', async () => {
    const { Kit, TM, doc } = frame(payload(), () => Promise.reject(new Error('SRI mismatch for d3')));
    const m = Kit.mount();
    m.body.appendChild(doc.createElement('svg'));
    const settled = vi.fn();
    Kit.libs('d3', 'd3-sankey').then(settled, settled);
    await new Promise(r => setTimeout(r, 0));
    expect(TM.lib).toHaveBeenCalledWith('d3');
    expect(TM.fail).toHaveBeenCalledWith('library', 'SRI mismatch for d3');
    expect(m.body.textContent).toBe('Library failed');
    expect((doc.querySelector('.kit-table-box') as HTMLElement).hidden).toBe(false);
    expect(settled).not.toHaveBeenCalled();
  });

  it('resolves libs to what TM.lib gave', async () => {
    const { Kit } = frame(payload(), n => Promise.resolve(n.toUpperCase()));
    expect(await Kit.libs('d3', 'plot')).toEqual(['D3', 'PLOT']);
  });

  it('calls TM.drawn once and passes actions through', () => {
    const { Kit, TM } = frame(payload());
    Kit.drawn(); Kit.drawn();
    expect(TM.drawn).toHaveBeenCalledTimes(1);
    Kit.action('fly', { bbox: [0, 0, 1, 1] });
    expect(TM.action).toHaveBeenCalledWith('fly', { bbox: [0, 0, 1, 1] });
  });

  it('menu(): text-only buttons that run their item and close; Escape or a press elsewhere closes it', () => {
    const { Kit, doc, sink, w } = frame(payload());
    Kit.mount();
    const run = vi.fn();
    Kit.menu(10, 10, [{ label: '<b>Show</b>', run }, { label: 'bad' }]);
    const items = [...doc.querySelectorAll('.kit-menu button')] as Loose[];
    expect(items.map(b => b.textContent)).toEqual(['<b>Show</b>']);
    expect(doc.activeElement).toBe(items[0]);
    items[0].click();
    expect(run).toHaveBeenCalledOnce();
    expect(doc.querySelector('.kit-menu')).toBeNull();
    Kit.menu(10, 10, [{ label: 'x', run }]);
    doc.querySelector('.kit-menu').dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(doc.querySelector('.kit-menu')).toBeNull();
    Kit.menu(10, 10, [{ label: 'x', run }]);
    doc.body.dispatchEvent(new w.Event('pointerdown', { bubbles: true }));
    expect(doc.querySelector('.kit-menu')).toBeNull();
    expect(sink).not.toHaveBeenCalled();
  });

  it('menu(): arrow keys, Home and End move between the buttons; Escape returns focus to the opener', () => {
    const { Kit, doc, w } = frame(payload());
    Kit.mount();
    const opener = doc.createElement('button');
    doc.body.append(opener);
    opener.focus();
    Kit.menu(10, 10, ['a', 'b', 'c'].map(label => ({ label, run: () => {} })));
    const items = [...doc.querySelectorAll('.kit-menu button')] as Loose[];
    const key = (k: string) => doc.activeElement.dispatchEvent(new w.KeyboardEvent('keydown', { key: k, bubbles: true }));
    expect(doc.activeElement).toBe(items[0]);
    key('ArrowDown'); expect(doc.activeElement).toBe(items[1]);
    key('End'); expect(doc.activeElement).toBe(items[2]);
    key('ArrowDown'); expect(doc.activeElement).toBe(items[0]);
    key('ArrowUp'); expect(doc.activeElement).toBe(items[2]);
    key('Home'); expect(doc.activeElement).toBe(items[0]);
    key('Escape');
    expect(doc.querySelector('.kit-menu')).toBeNull();
    expect(doc.activeElement).toBe(opener);
  });

  it('action(): adds kb:true to an object payload after a key press, not after a pointer press', () => {
    const { Kit, TM, doc, w } = frame(payload());
    doc.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    Kit.action('select', { ids: [1] });
    expect(TM.action).toHaveBeenLastCalledWith('select', { ids: [1], kb: true });
    doc.dispatchEvent(new w.Event('pointerdown', { bubbles: true }));
    Kit.action('select', { ids: [1] });
    expect(TM.action).toHaveBeenLastCalledWith('select', { ids: [1] });
  });

  it('takes legend colours, else a stable neutral palette; formats numbers', () => {
    const { Kit } = frame(payload());
    expect(Kit.colour('fuel', 'gas')).toBe('#ff0000');
    const a = Kit.colour('fuel', 'bad');
    expect(a).toMatch(/^#[0-9a-f]{6}$/);
    expect(Kit.colour('fuel', 'bad')).toBe(a);
    expect(Kit.colour('fuel', 'other')).not.toBe(a);
    expect(Kit.fmt(1234567.89, 'MW')).toBe('1,234,568 MW');
    expect(Kit.fmt(3.14159)).toBe('3.14');
    expect(Kit.fmt(NaN)).toBe('–');
  });
});

describe('template lint block', () => {
  const lint = (code: string) =>
    new ESLint({ cwd: new URL('../../..', import.meta.url).pathname })
      .lintText(code, { filePath: 'assets/templates/html/fixture.js' })
      .then(r => r[0].messages.filter(m => m.severity === 2).map(m => m.ruleId));

  it('fails a template that puts params into innerHTML (or other sinks)', async () => {
    expect(await lint("var m = Kit.mount(); m.body.innerHTML = TM_INPUT.params.title;\n")).toContain('no-restricted-properties');
    expect(await lint("document.body.insertAdjacentHTML('beforeend', 'x');\n")).toContain('no-restricted-properties');
    expect(await lint("document.write('x');\n")).toContain('no-restricted-properties');
    expect(await lint("new Function('return 1')();\n")).toEqual(expect.arrayContaining(['no-new-func']));
    expect(await lint("eval('1');\n")).toContain('no-eval');
  }, 30_000);

  it('passes a text-only template using the frame globals', async () => {
    expect(await lint("var m = Kit.mount(); var p = document.createElement('p'); p.textContent = TM_INPUT.params.title; m.body.appendChild(p); Kit.libs('d3').then(function () { d3.select(m.body); Kit.drawn(); });\n")).toEqual([]);
  }, 30_000);
});
