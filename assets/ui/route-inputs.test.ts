// @vitest-environment jsdom
// Tests for the route input column: substation combobox, line type following the
// preset, pick mode (tap snaps, Alt-tap raw, Esc stops), pin drag re-snap, the
// Find button's gating and the error line.
// Deps: route-inputs.js, substation-index.js (reset per test), map-input.js / layer-data.js / maplibre-gl (mocked),
//       test-drawer-env.js, state.js, tool-mode.js, i18n (t).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const input = vi.hoisted(() => ({
  tap: new Set<(e: unknown) => void>(),
  hover: new Set<(e: unknown) => void>(),
}));
vi.mock('../map-input.js', () => ({
  onMapTap: (f: (e: unknown) => void) => { input.tap.add(f); return () => input.tap.delete(f); },
  onMapHover: (f: (e: unknown) => void) => { input.hover.add(f); return () => input.hover.delete(f); },
}));
vi.mock('maplibre-gl', async () => {
  const Marker = (await import('./test-drawer-env.js')).mockMarker();
  return { Marker, default: { Marker } };
});
const load = vi.hoisted(() => ({ fail: false, calls: 0 }));
vi.mock('../layers/layer-data.js', async () => {
  const { state } = await import('../state.js');
  const { layerSourceId } = await import('../layers/layer-source.js');
  return {
    loadSource: async () => {
      load.calls++;
      if (load.fail) throw new Error('offline');
      state.sourcesData[layerSourceId('hifld-substations')] = SUBS;
    },
  };
});

const SUBS = vi.hoisted(() => {
  const sub = (id: string, name: string, kv: string, lng: number, lat: number, st: string, ba: string) =>
    ({ type: 'Feature', geometry: { type: 'Point', coordinates: [lng, lat] }, properties: { hifld_id: id, name, max_kv: kv, states: `|${st}|`, ba: `|${ba}|` } });
  return [
    sub('1', 'McNary', '500.0', -119.30, 45.94, 'OR', 'BPAT'),
    sub('2', 'Hemingway', '500.0', -116.80, 43.20, 'ID', 'IPCO'),
    sub('3', 'Hemlock', '230.0', -122.00, 40.60, 'CA', 'CISO'),
    sub('4', 'UNKNOWN12', '', -118.00, 44.00, 'OR', 'BPAT'),
  ];
});

import { mountInputs } from './route-inputs.js';
import { createCustomPresetStore } from '../route/custom-presets.js';
import { installDrawerEnv, resetDrawerEnv } from './test-drawer-env.js';
import { _resetSubstationIndex } from './substation-index.js';
import { state } from '../state.js';
import { toolHooks } from '../tool-mode.js';
import { t } from '../../src/i18n/index.js';
import { Marker } from 'maplibre-gl';
import type { RouteSession } from './route-tabs/types.js';

type MockM = { lngLat: [number, number]; emit(n: string): void; el: HTMLElement };
const markers = () => (Marker as unknown as { instances: MockM[] }).instances;

function newSession(): RouteSession {
  return {
    inputs: { a: null, b: null, lineType: 'ac500', presetId: 'tm-default', patch: null },
    status: { kind: 'idle' }, result: null, resultInputs: null, previous: null,
    altsSolving: false, altsError: null, tab: 'summary', colour: 'cost', threshold: 0.05,
    showSurface: false, dollars: 'y2025', liveTuning: false,
    crossingKinds: ['river', 'road', 'rail'], altStretch: 0.2, highlight: [],
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ptr = (lng: number, lat: number, altKey = false) => ({ lngLat: { lng, lat }, point: { x: 10, y: 20 }, originalEvent: { altKey } });

let el: HTMLElement;
let session: RouteSession;
type Fn = ReturnType<typeof vi.fn<() => void>>;
let cb: { onFind: Fn; onChange: Fn; onEditMethod: Fn };
let dcz: { disable: Fn; enable: Fn };
let handle: ReturnType<typeof mountInputs>;

beforeEach(() => {
  document.body.innerHTML = '';
  _resetSubstationIndex();
  installDrawerEnv();
  dcz = { disable: vi.fn<() => void>(), enable: vi.fn<() => void>() };
  (state.map as unknown as { doubleClickZoom: typeof dcz }).doubleClickZoom = dcz;
  state.routePick = false;
  state.sourcesData = {};
  load.fail = false;
  load.calls = 0;
  markers().length = 0;
  input.tap.clear();
  input.hover.clear();
  el = document.createElement('div');
  document.body.append(el);
  session = newSession();
  cb = { onFind: vi.fn<() => void>(), onChange: vi.fn<() => void>(), onEditMethod: vi.fn<() => void>() };
  handle = mountInputs(el, session, cb);
});
afterEach(() => { handle.destroy(); resetDrawerEnv(); });

const combo = (end: 'A' | 'B') => el.querySelectorAll<HTMLInputElement>('[role=combobox]')[end === 'A' ? 0 : 1];
const tap = (e: unknown) => [...input.tap].forEach((f) => f(e));
const key = (target: EventTarget, k: string) => {
  const ev = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true });
  target.dispatchEvent(ev);
  return ev;
};

describe('route inputs', () => {
  it('typing in A opens the listbox; Enter fills A', async () => {
    const a = combo('A');
    expect(a.getAttribute('aria-controls')).toBeTruthy();
    a.focus();
    a.value = 'mcn';
    a.dispatchEvent(new Event('input'));
    await wait(150);
    const list = document.getElementById(a.getAttribute('aria-controls')!)!;
    expect(list.hidden).toBe(false);
    expect(a.getAttribute('aria-expanded')).toBe('true');
    const opts = list.querySelectorAll('[role=option]');
    expect(opts.length).toBe(1);
    expect(opts[0].textContent).toContain('McNary');
    expect(opts[0].textContent).toContain('OR · BPAT');
    key(a, 'Enter');
    expect(session.inputs.a?.hit?.name).toBe('McNary');
    expect(session.inputs.a?.lngLat).toEqual([-119.30, 45.94]);
    expect(cb.onChange).toHaveBeenCalled();
    expect(markers().length).toBe(1);
    expect(el.textContent).toContain('McNary');
  });

  it('a failed substation load shows no matches (not Loading) and fetches once; substationIndex() retries', async () => {
    handle.destroy();
    load.fail = true;
    handle = mountInputs(el, session, cb);
    const a = combo('A');
    a.focus();
    a.value = 'mcn';
    a.dispatchEvent(new Event('input'));
    await wait(150);
    const list = document.getElementById(a.getAttribute('aria-controls')!)!;
    expect(list.textContent).toContain(t('route.in.noMatch'));
    expect(list.textContent).not.toContain(t('route.in.loading'));
    const calls = load.calls;
    a.value = 'mcna';
    a.dispatchEvent(new Event('input'));
    await wait(150);
    expect(load.calls).toBe(calls);
    const refused = await handle.substationIndex();
    expect(refused.ok).toBe(false);
    expect(load.calls).toBe(calls + 1);
    load.fail = false;
    const o = await handle.substationIndex();
    expect(o.ok && o.result.subs.length).toBe(4);
  });

  it('the line type follows a preset change', () => {
    const labels = () => [...el.querySelectorAll('[role=radio]')].map((b) => b.textContent);
    expect(labels()).toEqual(['500 AC', '345 AC', '230 AC', '161 AC', '138 AC', '115 AC', '69 AC', '500 DC']);
    el.querySelector<HTMLButtonElement>('[role=radio][data-id=ac345]')!.click();
    expect(session.inputs.lineType).toBe('ac345');
    const sel = el.querySelector('select')!;
    sel.value = 'pnas-wu2023';
    sel.dispatchEvent(new Event('change'));
    expect(session.inputs.presetId).toBe('pnas-wu2023');
    expect(session.inputs.lineType).toBe('ac500');
    expect(labels()).toEqual(['500 AC', '500 DC']);
    el.querySelector<HTMLButtonElement>('[role=radio][data-id=dc500]')!.click();
    sel.value = 'tm-default';
    sel.dispatchEvent(new Event('change'));
    expect(session.inputs.lineType).toBe('dc500');
  });

  it('pick B by tap snaps to the substation and ends pick mode', async () => {
    handle.startPick('B');
    expect(state.routePick).toBe(true);
    expect(dcz.disable).toHaveBeenCalled();
    expect(session.status).toEqual({ kind: 'picking', end: 'B' });
    expect(document.querySelector('.ri-toast')?.getAttribute('aria-live')).toBe('polite');
    await flush();
    [...input.hover].forEach((f) => f(ptr(-116.81, 43.21)));
    expect(document.querySelector('.ri-callout')?.textContent).toContain('Hemingway');
    tap(ptr(-116.81, 43.21));
    await flush();
    expect(session.inputs.b?.hit?.name).toBe('Hemingway');
    expect(session.inputs.b?.lngLat).toEqual([-116.80, 43.20]);
    expect(state.routePick).toBe(false);
    expect(dcz.enable).toHaveBeenCalled();
    expect(input.tap.size + input.hover.size).toBe(0);
    expect(document.querySelector('.ri-toast')).toBeNull();
    expect(session.status).toEqual({ kind: 'idle' });
  });

  it('typing a name while picking fills the end and stops picking', async () => {
    handle.startPick('B');
    const b = combo('B');
    expect(document.activeElement).toBe(b);
    b.value = 'hemi';
    b.dispatchEvent(new Event('input'));
    await wait(150);
    key(b, 'Enter');
    expect(session.inputs.b?.hit?.name).toBe('Hemingway');
    expect(state.routePick).toBe(false);
  });

  it('Alt-tap gives a raw point', async () => {
    handle.startPick('A');
    tap(ptr(-116.81, 43.21, true));
    await flush();
    expect(session.inputs.a).toEqual({ lngLat: [-116.81, 43.21], hit: null });
  });

  it('Esc stops pick mode, clears state.routePick and restores double-click zoom', () => {
    const measure = vi.spyOn(toolHooks, 'deactivateMeasure');
    const edit = vi.spyOn(toolHooks, 'exitEdit');
    handle.startPick('A');
    expect(measure).toHaveBeenCalled();
    expect(edit).toHaveBeenCalled();
    const ev = key(document.body, 'Escape');
    expect(ev.defaultPrevented).toBe(true);
    expect(state.routePick).toBe(false);
    expect(dcz.enable).toHaveBeenCalled();
    expect(input.tap.size).toBe(0);
    expect(session.inputs.a).toBeNull();
  });

  it('toolHooks.deactivateRoutePick (measure/draw starting) stops the pick', () => {
    handle.startPick('B');
    toolHooks.deactivateRoutePick();
    expect(state.routePick).toBe(false);
    expect(input.tap.size).toBe(0);
  });

  it('a pin dragend re-snaps the endpoint', async () => {
    await handle.setEnd('A', [-119.31, 45.95]);
    expect(session.inputs.a?.hit?.name).toBe('McNary');
    const m = markers()[0];
    m.lngLat = [-116.79, 43.19];
    m.emit('dragend');
    await flush();
    expect(session.inputs.a?.hit?.name).toBe('Hemingway');
  });

  it('Find stays disabled until both ends are set, and while busy', async () => {
    const find = el.querySelector<HTMLButtonElement>('.ri-primary')!;
    expect(find.disabled).toBe(true);
    await handle.setEnd('A', [-119.31, 45.95]);
    expect(find.disabled).toBe(true);
    await handle.setEnd('B', [-116.81, 43.21]);
    expect(find.disabled).toBe(false);
    find.click();
    expect(cb.onFind).toHaveBeenCalledTimes(1);
    handle.setBusy(true);
    expect(find.disabled).toBe(true);
  });

  it('setErrors shows the fix message and disables Find', async () => {
    await handle.setEnd('A', [-119.31, 45.95]);
    await handle.setEnd('B', [-116.81, 43.21]);
    handle.setErrors(2);
    const line = el.querySelector<HTMLElement>('.ri-errors')!;
    expect(line.hidden).toBe(false);
    expect(line.textContent).toBe(t('route.in.fixErrors', { n: 2 }));
    expect(el.querySelector<HTMLButtonElement>('.ri-primary')!.disabled).toBe(true);
    handle.setErrors(0);
    expect(line.hidden).toBe(true);
  });

  it('clearing a field removes its pin; destroy removes the rest', async () => {
    await handle.setEnd('A', [-119.31, 45.95]);
    await handle.setEnd('B', [-116.81, 43.21]);
    el.querySelector<HTMLButtonElement>('.ri-ep-x')!.click();
    expect(session.inputs.a).toBeNull();
    expect(document.querySelectorAll('.ri-pin').length).toBe(1);
    handle.destroy();
    expect(document.querySelectorAll('.ri-pin').length).toBe(0);
  });

  it('folds to the one-line strip and Edit unfolds', async () => {
    await handle.setEnd('A', [-119.31, 45.95]);
    handle.setFolded(true);
    const strip = el.querySelector<HTMLElement>('.ri-strip')!;
    expect(strip.hidden).toBe(false);
    expect(el.querySelector<HTMLElement>('.ri-body')!.hidden).toBe(true);
    expect(strip.textContent).toContain('McNary');
    expect(strip.querySelector('.ri-strip-extra')).not.toBeNull();
    strip.querySelector<HTMLButtonElement>('.ri-strip-edit')!.click();
    expect(strip.hidden).toBe(true);
  });

  it('never says "corridor"', async () => {
    handle.startPick('B');
    await flush();
    [...input.hover].forEach((f) => f(ptr(-100, 30)));
    expect(document.body.textContent!.toLowerCase()).not.toContain('corridor');
    key(document.body, 'Escape');
  });

  it('destroy before the substation index resolves places no pin', async () => {
    const before = markers().length;
    const p = handle.setEnd('A', [-119.31, 45.95]);
    handle.destroy();
    await p;
    await flush();
    expect(markers().length).toBe(before);
    expect(session.inputs.a).toBeNull();
  });

  it('pick mode does not focus the field on a coarse pointer', () => {
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: q.includes('coarse'), media: q, addEventListener() {}, removeEventListener() {} }));
    (document.activeElement as HTMLElement | null)?.blur?.();
    handle.startPick('B');
    expect(document.activeElement).not.toBe(combo('B'));
  });

  it('static texts follow a language change through data-i18n', async () => {
    const { DICTIONARIES, setLocale, updateDomTranslations } = await import('../../src/i18n/index.js');
    (DICTIONARIES as Record<string, Record<string, string>>).es = {
      ...(DICTIONARIES.en as Record<string, string>),
      'route.in.endpoints': 'PUNTOS', 'route.in.placeholder': 'Buscar subestación',
    };
    try {
      setLocale('es' as never);
      updateDomTranslations(el);
      expect(el.querySelector('.ri-h')!.textContent).toBe('PUNTOS');
      expect(combo('A').placeholder).toBe('Buscar subestación');
    } finally {
      setLocale('en');
      delete (DICTIONARIES as Record<string, unknown>).es;
    }
  });

  it('a route:presets event rebuilds the method list and shows the session method; destroy stops listening', () => {
    const select = el.querySelector<HTMLSelectElement>('.ri-select')!;
    const store = createCustomPresetStore(localStorage);
    const r = store.save('Steep', 'tm-default', { rows: [{ row: 9, band: 'slope', note: 'mountain, ≥ 4°', cost_x: 2 }] });
    expect(r.ok).toBe(true);
    const id = `custom:${r.ok ? r.result.id : ''}`;
    session.inputs.presetId = id;
    document.dispatchEvent(new CustomEvent('route:presets'));
    expect([...select.options].map((o) => o.value)).toContain(id);
    expect(select.value).toBe(id);
    // deleted elsewhere: falls back to a built-in
    localStorage.clear();
    cb.onChange.mockClear();
    document.dispatchEvent(new CustomEvent('route:presets'));
    expect(session.inputs.presetId).not.toBe(id);
    expect(select.value).toBe(session.inputs.presetId);
    expect(cb.onChange).toHaveBeenCalledOnce();
    handle.destroy();
    const n = select.options.length;
    store.save('Again', 'tm-default', {});
    document.dispatchEvent(new CustomEvent('route:presets'));
    expect(select.options.length).toBe(n);
  });
});
