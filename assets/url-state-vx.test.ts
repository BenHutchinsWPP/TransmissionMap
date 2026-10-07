// @vitest-environment jsdom
// The `vx` param (view `where` + `style`): encoding, determinism, its place
// before `exp`, and the trust boundary on decode.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Inflate, deflateSync, strToU8 } from 'fflate';
import type { Map as MaplibreMap } from 'maplibre-gl';
import { formatUrlState, parseUrlState, defaultView, type UrlStateData } from './url-state-codec.js';
import { state } from './state.js';
import { beginExperience, endExperienceLink, experienceIsDirty } from './experience-link.js';
import { readUrlState, writeUrlState, paintLinkedView } from './url-state.js';
import { setLocale, loadDictionary } from '../src/i18n/index.js';
import type { Condition } from '../src/registry/condition-compile.js';
import type { StyleOverride } from '../src/types.js';
import { setWhere } from './filters.js';
import { EXPERIENCES } from '../src/registry/experiences.js';
import { validateWhere, validateStyleOverride } from '../src/registry/view-validate.js';
import { getDiagLog, clearDiagLog } from './diag-log.js';

// readUrlState() runs once, before initMap() builds the map: hide the fixture's
// map for the read, as a cold boot would, then hand it back for the writes.
function coldBoot() {
  const { map, mapReady } = state;
  state.map = null;
  state.mapReady = false;
  try { readUrlState(); } finally { state.map = map; state.mapReady = mapReady; }
}

const KV345: Condition = { field: 'nominal_kv', op: '>=', value: 345 };
const WIND: Condition = { field: 'energy_source', op: 'in', value: ['WND', 'SUN'] };

function b64url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
const rawVx = (json: string) => 'j' + b64url(strToU8(json));

function format(where: UrlStateData['where'], style: UrlStateData['style'], extra: Partial<UrlStateData> = {}) {
  return formatUrlState({ ...defaultView(), where, style, ...extra });
}
const vxOf = (parts: string[]) => parts.find(p => p.startsWith('vx='))?.slice(3);
const parse = (qs: string) => parseUrlState(new URLSearchParams(qs));

describe('vx – encoding', () => {
  it('is omitted when both sections are empty, so existing links are unchanged', () => {
    expect(format({}, {})).toEqual([]);
    expect(format({ 'osm-substations-points': [] }, { railroads: {} })).toEqual([]);
    expect(format({}, {}, { basemap: 'dark' })).toEqual(['bm=d']);
  });

  // Deflate wins on any realistic payload; raw only when it does not compress.
  it('keeps the raw (j) form when deflate is not shorter', () => {
    const vx = vxOf(format({}, { ['ÿþýüûúùø÷öõôóòñð']: { size: 2 } }))!;
    expect(vx[0]).toBe('j');
    expect(parse('vx=' + vx).dropped).toHaveLength(1);   // not a layer id
  });

  it('decodes a raw (j) payload', () => {
    const where = { 'osm-substations-points': [KV345] };
    const style = { railroads: { size: 2 } };
    expect(parse('vx=' + rawVx(JSON.stringify({ v: 1, w: where, s: style })))).toEqual({ where, style });
  });

  it('round-trips a large view through the deflated (z) path', () => {
    const where: Record<string, Condition[]> = {
      'eia-generators': [WIND, { field: 'gen_status', op: 'in', value: ['existing', 'proposed'] }],
      'osm-substations-points': [KV345],
      'osm-transmission-lines': [KV345],
      'osm-substations-polygons': [KV345],
    };
    const style: Record<string, StyleOverride> = {
      railroads: { opacity: 0.5, size: 2, color: '#ff0000' },
      'osm-transmission-lines': { opacity: 0.8, size: 1.5 },
      'eia-generators': { size: 1.25 },
    };
    const vx = vxOf(format(where, style))!;
    expect(vx[0]).toBe('z');
    expect(parse('vx=' + vx)).toEqual({ where, style });
  });

  it('sorts keys at every level: insertion order does not change the string', () => {
    const a = format(
      { 'osm-transmission-lines': [KV345], 'eia-generators': [WIND] },
      { railroads: { opacity: 0.5, color: '#fff' } },
    );
    const b = format(
      { 'eia-generators': [{ value: ['WND', 'SUN'], op: 'in', field: 'energy_source' }], 'osm-transmission-lines': [{ value: 345, field: 'nominal_kv', op: '>=' }] },
      { railroads: { color: '#fff', opacity: 0.5 } },
    );
    expect(a).toEqual(b);
  });

  it('is emitted before exp', () => {
    const parts = format({ 'osm-substations-points': [KV345] }, {}, { basemap: 'dark', experienceId: 'columbia-hydro' });
    expect(parts.map(p => p.split('=')[0])).toEqual(['bm', 'vx', 'exp']);
  });

  it('a realistic view (3 where layers, 5 style entries) stays well under 2,000 chars', () => {
    const vx = vxOf(format(
      {
        'eia-generators': [WIND, { field: 'op_year', op: '>=', value: 2010 }],
        'osm-substations-points': [KV345],
        'osm-transmission-lines': [{ field: 'nominal_kv', op: '>=', value: 230 }],
      },
      {
        railroads: { opacity: 0.4 },
        'osm-transmission-lines': { size: 1.5, color: '#1d4ed8' },
        'osm-substations-points': { size: 1.25 },
        'eia-generators': { opacity: 0.8, size: 1.5 },
        'hifld-transmission-lines': { opacity: 0.6, color: 'rgb(220, 38, 38)' },
      },
    ))!;
    expect(vx.length).toBeLessThan(1000);
  });

  it('records a diag event when the encoded value passes the decode cap, and still writes it', () => {
    clearDiagLog();
    let seed = 1;
    const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const conds: Condition[] = Array.from({ length: 1500 }, () => ({ field: 'nominal_kv', op: '>=', value: rand() * 1000 }));
    const vx = vxOf(format({ 'osm-transmission-lines': conds }, {}))!;
    expect(vx.length).toBeGreaterThan(8192);
    expect(getDiagLog().some(e => e.detail.includes('over the 8192'))).toBe(true);
    expect(parse('vx=' + vx).dropped).toHaveLength(1);
  });

  it('records nothing for a link within the cap', () => {
    clearDiagLog();
    format({ 'osm-substations-points': [KV345] }, {});
    expect(getDiagLog()).toEqual([]);
  });
});

describe('lb', () => {
  it('writes lb=0 only for labels explicitly off', () => {
    expect(formatUrlState({ ...defaultView(), basemapLabels: false })).toContain('lb=0');
    expect(formatUrlState({ ...defaultView(), basemapLabels: true }).some(p => p.startsWith('lb='))).toBe(false);
    const d = { ...defaultView(), basemapLabels: undefined } as unknown as UrlStateData;
    expect(formatUrlState(d).some(p => p.startsWith('lb='))).toBe(false);
  });
});

describe('vx – trust boundary', () => {
  it('drops an oversized param before decoding; the rest of the link applies', () => {
    const r = parse('bm=d&vx=j' + 'A'.repeat(9000));
    expect(r.basemap).toBe('dark');
    expect(r.where).toBeUndefined();
    expect(r.dropped).toHaveLength(1);
  });

  it('drops bad base64, an unknown marker, and bad JSON — each only vx', () => {
    for (const vx of ['jA', 'j@@', 'q' + rawVx('{"v":1}').slice(1), rawVx('{nope')]) {
      const r = parse('bm=d&vx=' + vx);
      expect(r.basemap, vx).toBe('dark');
      expect(r.where, vx).toBeUndefined();
      expect(r.dropped, vx).toHaveLength(1);
    }
  });

  it('drops a non-object payload and an unknown version', () => {
    for (const json of ['[1]', '"x"', 'null', '{"v":2,"w":{}}', '{"w":{}}']) {
      const r = parse('vx=' + rawVx(json));
      expect(r.where, json).toBeUndefined();
      expect(r.dropped, json).toHaveLength(1);
    }
  });

  it('a bad entry drops only itself', () => {
    const payload = {
      v: 1,
      w: {
        'osm-substations-points': [KV345],
        'not-a-layer': [KV345],
        'eia-generators': [{ field: 'energy_source', op: 'in', value: ['WND', 'UNOBTAINIUM'] }],
        'osm-transmission-lines': [{ field: 'nominal_kv', op: '>=', value: ['get', 'x'] }],
        'hifld-substations': [{ field: 'constructor', op: '=', value: 1 }],
        'nws-alerts': [],
        railroads: [],
      },
      s: {
        railroads: { opacity: 0.5 },
        'eia-generators': { opacity: 7 },
        'osm-transmission-lines': { color: 'url(javascript:alert(1))' },
        nope: { size: 2 },
      },
      x: {},
    };
    // JSON.parse keeps "__proto__" as an own key, as a hostile link would.
    const json = JSON.stringify(payload).replace('"osm-substations-points"', '"__proto__":[],"osm-substations-points"');
    const r = parse('bm=d&vx=' + rawVx(json));
    expect(r.basemap).toBe('dark');
    expect(r.where).toEqual({ 'osm-substations-points': [KV345] });
    expect(Object.getPrototypeOf(r.where)).toBe(Object.prototype);
    expect(r.style).toEqual({ railroads: { opacity: 0.5 } });
    // 7 bad where entries (incl. __proto__), 3 bad styles, 1 unknown section
    expect(r.dropped).toHaveLength(11);
  });

  it('drops a wrongly typed literal at decode; setWhere refuses it too', () => {
    const bad: Record<string, Condition[]> = {
      'osm-substations-points': [{ field: 'nominal_kv', op: '>=', value: '345' }],
      'osm-transmission-lines': [{ field: 'nominal_kv', op: '=', value: true }],
      'eia-generators': [{ field: 'energy_source', op: 'in', value: ['WND', 5] }],
    };
    const r = parse('vx=' + rawVx(JSON.stringify({ v: 1, w: { ...bad, 'hifld-substations': [{ field: 'max_kv', op: '>=', value: 345 }] } })));
    expect(r.where).toEqual({ 'hifld-substations': [{ field: 'max_kv', op: '>=', value: 345 }] });
    expect(r.dropped).toHaveLength(3);
    for (const [id, conds] of Object.entries(bad)) expect(setWhere(id, conds), id).toMatch(/is not a (number|string)/);
  });

  it('drops prototype keys as field without throwing', () => {
    for (const k of ['constructor', '__proto__', 'toString']) {
      const json = `{"v":1,"w":{"osm-substations-points":[{"field":"${k}","op":"=","value":1}]}}`;
      const r = parse('vx=' + rawVx(json));
      expect(r.where, k).toEqual({});
      expect(r.dropped, k).toHaveLength(1);
    }
  });

  it('drops an empty vx= and a truncated deflate stream as vx only', () => {
    const full = vxOf(format({ 'osm-substations-points': [KV345], 'osm-transmission-lines': [KV345] }, { railroads: { opacity: 0.5 } }))!;
    expect(full[0]).toBe('z');
    const packed = Uint8Array.from(atob(full.slice(1).replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
    const truncated = 'z' + b64url(packed.subarray(0, packed.length - 6));
    for (const [vx, why] of [['', 'not a recognised encoding'], [truncated, 'truncated or corrupt']]) {
      const r = parse('bm=d&vx=' + vx);
      expect(r.basemap, vx).toBe('dark');
      expect(r.where, vx).toBeUndefined();
      expect(r.dropped, vx).toEqual([expect.stringContaining(why)]);
    }
  });

  describe('deflate bomb', () => {
    afterEach(() => vi.restoreAllMocks());

    it('stops inflating once output passes 64 KB', () => {
      const bomb = deflateSync(new Uint8Array(1 << 20), { level: 9 });   // 1 MB of zeros
      const push = vi.spyOn(Inflate.prototype, 'push');
      const r = parse('bm=d&vx=z' + b64url(bomb));
      expect(r.basemap).toBe('dark');
      expect(r.where).toBeUndefined();
      expect(r.dropped).toHaveLength(1);
      expect(push.mock.calls.length).toBeLessThan(Math.ceil(bomb.length / 64));
      expect(push.mock.calls.length).toBeLessThanOrEqual(3);
    });
  });
});

describe('vx – url-state glue', () => {
  beforeEach(() => {
    state.where = {};
    state.styleOverrides = {};
    state.basemap = 'light';
    endExperienceLink();
    state.mapReady = true;
    state.map = {
      getCenter: () => ({ lat: 39.5, lng: -98.35 }), getZoom: () => 5, getBearing: () => 0, getPitch: () => 0,
    } as unknown as MaplibreMap;
    setLocale('en');
    document.querySelectorAll('[role=status]').forEach(n => n.remove());
  });

  it('shows one translated notice per session when vx is too large for a link', () => {
    let seed = 1;
    const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    state.where = { 'osm-transmission-lines': Array.from({ length: 1500 }, () => ({ field: 'nominal_kv', op: '>=', value: rand() * 1000 }) as Condition) };
    writeUrlState();
    writeUrlState();
    const notes = document.querySelectorAll('[role=status]');
    expect(notes).toHaveLength(1);
    expect(notes[0].textContent).toContain('Save view');
    expect(location.hash).toContain('vx=');
  });

  it('shows no too-large notice for a small view', () => {
    state.where = { 'osm-substations-points': [KV345] };
    writeUrlState();
    expect(document.querySelector('[role=status]')).toBeNull();
  });

  it('a story with vx keeps exp after two writes', () => {
    state.where = { 'osm-substations-points': [KV345] };
    state.styleOverrides = { railroads: { opacity: 0.5 } };
    beginExperience('columbia-hydro');
    writeUrlState();
    writeUrlState();
    expect(experienceIsDirty()).toBe(false);
    expect(location.hash).toMatch(/vx=[jz][\w-]+&exp=columbia-hydro$/);
  });

  it('changing where after the pristine snapshot makes the story dirty', () => {
    beginExperience('columbia-hydro');
    writeUrlState();
    expect(experienceIsDirty()).toBe(false);
    state.where = { 'osm-substations-points': [KV345] };
    writeUrlState();
    expect(experienceIsDirty()).toBe(true);
    expect(location.hash).not.toContain('exp=');
  });

  it('cold boot seeds both sections and shows no notice for a clean link', () => {
    history.replaceState(null, '', '#5/40/-100?' + format({ 'osm-substations-points': [KV345] }, { railroads: { size: 2 } }).join('&'));
    coldBoot();
    expect(state.where).toEqual({ 'osm-substations-points': [KV345] });
    expect(state.styleOverrides).toEqual({ railroads: { size: 2 } });
    expect(document.querySelector('[role=status]')).toBeNull();
  });

  it('cold boot shows one translated notice counting what was dropped', async () => {
    await loadDictionary('fr');
    const json = JSON.stringify({ v: 1, w: { 'not-a-layer': [KV345] }, s: { nope: {}, railroads: { opacity: 0.5 } } });
    history.replaceState(null, '', '#5/40/-100?bm=d&lang=fr&vx=' + rawVx(json));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    coldBoot();
    expect(state.basemap).toBe('dark');
    expect(state.styleOverrides).toEqual({ railroads: { opacity: 0.5 } });
    state.map = null;                    // the map's own drops: view-state-paint.test.ts
    paintLinkedView();
    const notes = document.querySelectorAll('[role=status]');
    expect(notes).toHaveLength(1);
    expect(notes[0].textContent).toContain('(2)');
    expect(notes[0].textContent).toContain('paramètres');
  });
});

describe('curated experiences', () => {
  it('every where/style entry passes the codec validators', () => {
    let checked = 0;
    for (const e of EXPERIENCES) {
      checked++;
      for (const [id, c] of Object.entries(e.state.where ?? {})) expect(validateWhere(id, c), `${e.id} where ${id}`).toBeNull();
      for (const [id, o] of Object.entries(e.state.style ?? {})) expect(validateStyleOverride(id, o), `${e.id} style ${id}`).toBeNull();
    }
    expect(checked).toBe(EXPERIENCES.length);
    expect(checked).toBeGreaterThan(0);
  });
});
