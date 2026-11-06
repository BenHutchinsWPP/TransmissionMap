// @vitest-environment jsdom
// The `vx` `sv` section (linked services): the link form round-trips every
// field a view holds, a bad entry drops only itself, the caps (5 entries,
// 3,000 UTF-8 bytes of link JSON) are applied per entry on decode and refused
// whole by validateServices(), and a worst-case view — `sv` at its byte cap with
// CJK titles and credits at their length caps, beside `where`, `style` and a full
// 500-id selection — still fits the 8,192-char `vx`.
import { describe, it, expect } from 'vitest';
import { strToU8 } from 'fflate';
import { formatUrlState, parseUrlState, defaultView, VX_LINK_MAX_CHARS } from './url-state-codec.js';
import {
  serviceLinkEntry, serviceFromLinkEntry, servicesLinkBytes, validateServices,
} from '../src/registry/view-validate.js';
import { MAX_SERVICES, MAX_SERVICES_JSON, type LinkedService } from './services/service-spec.js';

export const VETTED: LinkedService = {
  id: 'tw1', kind: 'arcgis-feature', url: 'https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/State_County/MapServer',
  host: 'tigerweb.geo.census.gov', layer: '0', title: 'States', credit: 'US Census Bureau',
  style: { kind: 'fill', color: '#336699', opacity: 0.5 }, visible: true,
};
export const UNVETTED: LinkedService = {
  id: 'px1', kind: 'geojson', url: 'https://example.org/data/parcels.geojson', host: 'example.org',
  title: 'example.org', credit: 'example.org', style: { kind: 'circle', color: '#f00', opacity: 1, radius: 3 }, visible: false,
};

const params = (parts: string[]) => new URLSearchParams(parts.join('&'));
const roundTrip = (services: LinkedService[]) => parseUrlState(params(formatUrlState({ ...defaultView(), services })));

function b64url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
const rawVx = (payload: object) => new URLSearchParams('vx=j' + b64url(strToU8(JSON.stringify(payload))));

// Incompressible path characters, so deflate cannot hide a URL's length.
function noise(n: number, seed: number): string {
  let x = seed;
  let s = '';
  for (let i = 0; i < n; i++) { x = (x * 1103515245 + 12345) % 2147483648; s += 'abcdefghijklmnopqrstuvwxyz0123456789'[x % 36]; }
  return s;
}
function geojsonAt(i: number, pathChars: number): LinkedService {
  const url = `https://h${i}.example.org/${noise(pathChars, i + 1)}.geojson`;
  return { id: 's' + i, kind: 'geojson', url, host: `h${i}.example.org`, title: `h${i}.example.org`, credit: `h${i}.example.org`,
    style: { kind: 'line', color: '#123456', opacity: 0.8, width: 2 }, visible: true };
}
// Incompressible CJK text: three UTF-8 bytes a character.
function cjk(n: number, seed: number): string {
  let x = seed;
  let s = '';
  for (let i = 0; i < n; i++) { x = (x * 1103515245 + 12345) % 2147483648; s += String.fromCharCode(0x4e00 + (x % 0x5000)); }
  return s;
}
/** Five services whose link form is exactly MAX_SERVICES_JSON bytes. */
function atTheCaps(): LinkedService[] {
  const list = Array.from({ length: MAX_SERVICES }, (_, i) => geojsonAt(i, 400));
  const short = MAX_SERVICES_JSON - servicesLinkBytes(list);
  list[4] = geojsonAt(4, 400 + short);
  return list;
}
/** Five services at MAX_SERVICES_JSON bytes, the first with a 200-character CJK
 *  title and a 300-character CJK credit (their caps), the rest with short CJK ones. */
function cjkAtTheCaps(): LinkedService[] {
  const withText = (s: LinkedService, i: number, t: number, c: number) => ({ ...s, title: cjk(t, 100 + i), credit: cjk(c, 200 + i) });
  const list = Array.from({ length: MAX_SERVICES }, (_, i) => withText(geojsonAt(i, 10), i, i ? 20 : 200, i ? 20 : 300));
  const short = MAX_SERVICES_JSON - servicesLinkBytes(list);
  list[4] = withText(geojsonAt(4, 10 + short), 4, 20, 20);
  return list;
}

describe('sv link form', () => {
  it('round-trips every field a view holds, in order', () => {
    const wms: LinkedService = {
      id: 'w', kind: 'wms', url: 'https://hazards.fema.gov/gis/nfhl/services/public/NFHL/MapServer/WMSServer', host: 'hazards.fema.gov',
      layer: '28', version: '1.1.1', title: 'Flood zones', credit: 'FEMA', libraryId: 'fema-nfhl',
      style: { kind: 'raster', color: '#000', opacity: 0.6, minzoom: 8 }, visible: true,
    };
    const { services, dropped } = roundTrip([VETTED, UNVETTED, wms]);
    expect(dropped).toBeUndefined();
    expect(services).toEqual([VETTED, UNVETTED, wms]);
  });

  it('leaves a title and credit equal to the host out of the link, and an empty view out of vx', () => {
    expect(serviceLinkEntry(UNVETTED)).toEqual({ i: 'px1', u: UNVETTED.url, k: 'geojson', st: UNVETTED.style, h: 1 });
    expect(formatUrlState({ ...defaultView(), services: [] })).toEqual([]);
  });

  it('is deterministic: equal views give equal links', () => {
    const a = formatUrlState({ ...defaultView(), services: [VETTED, UNVETTED] });
    const b = formatUrlState({ ...defaultView(), services: [structuredClone(VETTED), structuredClone(UNVETTED)] });
    expect(a).toEqual(b);
  });
});

describe('sv decode is a trust boundary', () => {
  it('drops a bad entry, not the section', () => {
    const good = serviceLinkEntry(VETTED);
    const { services, dropped } = parseUrlState(rawVx({ v: 1, sv: [
      good,
      { ...serviceLinkEntry(UNVETTED), u: 'http://example.org/a.geojson' },  // not https
      { ...serviceLinkEntry(UNVETTED), x: 1 },                                // unknown key
      { ...serviceLinkEntry(UNVETTED), u: 'https://example.org/a.geojson?token=abc' },
      { ...serviceLinkEntry(UNVETTED), st: { kind: 'circle', color: 'red', opacity: 1 } },
      { ...serviceLinkEntry(UNVETTED), h: true },
      { ...good },                                                            // repeated id
      serviceLinkEntry(UNVETTED),
    ] }));
    expect(services).toEqual([VETTED, UNVETTED]);
    expect(dropped!.map(d => d.split(':')[0])).toEqual(['vx.sv.1', 'vx.sv.2', 'vx.sv.3', 'vx.sv.4', 'vx.sv.5', 'vx.sv.6']);
  });

  it('keeps at most five services, dropping the rest one by one', () => {
    const list = Array.from({ length: 7 }, (_, i) => serviceLinkEntry(geojsonAt(i, 10)));
    const { services, dropped } = parseUrlState(rawVx({ v: 1, sv: list }));
    expect(services).toHaveLength(MAX_SERVICES);
    expect(dropped).toEqual(['vx.sv.5: a view links at most 5 services', 'vx.sv.6: a view links at most 5 services']);
  });

  it('drops an entry that takes the services past 3,000 bytes, keeping the rest', () => {
    const big = Array.from({ length: 3 }, (_, i) => serviceLinkEntry(geojsonAt(i, 900)));
    const { services, dropped } = parseUrlState(rawVx({ v: 1, sv: [...big, serviceLinkEntry(VETTED)] }));
    expect(services!.map(s => s.id)).toEqual(['s0', 's1', 'tw1']);
    expect(dropped).toEqual([expect.stringMatching(/^vx\.sv\.2: the services pass 3000 bytes/)]);
  });

  it('counts the cap in UTF-8 bytes: CJK text under 3,000 characters but over 3,000 bytes is dropped', () => {
    const wide = Array.from({ length: 3 }, (_, i) => ({ ...geojsonAt(i, 10), title: cjk(200, i), credit: cjk(300, 50 + i) }));
    expect(JSON.stringify(wide.map(serviceLinkEntry)).length).toBeLessThan(MAX_SERVICES_JSON);
    expect(servicesLinkBytes(wide)).toBeGreaterThan(MAX_SERVICES_JSON);
    const { services, dropped } = parseUrlState(rawVx({ v: 1, sv: wide.map(serviceLinkEntry) }));
    expect(services!.map(s => s.id)).toEqual(['s0']);
    expect(dropped).toEqual([expect.stringMatching(/^vx\.sv\.1: /), expect.stringMatching(/^vx\.sv\.2: /)]);
    expect(validateServices(wide)).toMatchObject({ ok: false, reason: expect.stringContaining('bytes') });
  });

  it('drops a section that is not a list, keeping where/style', () => {
    const { services, style, dropped } = parseUrlState(rawVx({ v: 1, sv: { a: 1 }, s: { railroads: { opacity: 0.5 } } }));
    expect(services).toBeUndefined();
    expect(style).toEqual({ railroads: { opacity: 0.5 } });
    expect(dropped).toEqual(['vx.sv: not a list']);
  });

  it('refuses a library id alone: the entry carries its spec', () => {
    expect(serviceFromLinkEntry({ l: 'fema-nfhl' }).ok).toBe(false);
  });
});

describe('validateServices (the add setter\'s check)', () => {
  it('takes five services at the caps and refuses a sixth or one more character', () => {
    const list = atTheCaps();
    expect(servicesLinkBytes(list)).toBe(MAX_SERVICES_JSON);
    expect(validateServices(list).ok).toBe(true);
    const over = [...list.slice(0, 4), { ...list[4], url: list[4].url.replace('.geojson', 'x.geojson') }];
    expect(validateServices(over)).toMatchObject({ ok: false, reason: expect.stringContaining('3000') });
    expect(validateServices([...list.slice(0, 4), VETTED, UNVETTED])).toMatchObject({ ok: false, reason: expect.stringContaining('at most 5') });
    expect(validateServices([VETTED, { ...UNVETTED, id: VETTED.id }])).toMatchObject({ ok: false });
    expect(validateServices([{ ...UNVETTED, url: 'https://example.org/' + 'a'.repeat(1100) + '.geojson' }])).toMatchObject({ ok: false });
  });
});

describe('worst case', () => {
  it('sv at its byte cap, CJK titles and credits at their caps, beside where, style and a full 500-id selection keeps the whole vx inside a link', () => {
    const services = cjkAtTheCaps();
    expect(servicesLinkBytes(services)).toBe(MAX_SERVICES_JSON);
    expect(services[0].title).toHaveLength(200);
    expect(services[0].credit).toHaveLength(300);
    expect(validateServices(services).ok).toBe(true);
    const ids = Array.from({ length: 500 }, (_, i) => (1_000_000_000 + ((i * 2654435761) % 2_000_000_000)) * 10 + 2);
    const view = {
      ...defaultView(),
      where: {
        'osm-substations-points': [{ field: 'nominal_kv', op: '>=' as const, value: 345 }],
        'eia-generators': [{ field: 'energy_source', op: 'in' as const, value: ['WND', 'SUN'] }],
      },
      style: { railroads: { opacity: 0.5, size: 2, color: '#ff0000' }, 'osm-transmission-lines': { size: 1.5 } },
      sel: { mode: 'keep' as const, ids: { 'osm-substations-points': ids } },
      services,
    };
    const parts = formatUrlState(view);
    const vx = parts.find(p => p.startsWith('vx='))!.slice(3);
    expect(vx.length).toBeLessThanOrEqual(VX_LINK_MAX_CHARS);
    const back = parseUrlState(params(parts));
    expect(back.dropped).toBeUndefined();
    expect(back.services).toEqual(services);
    expect(back.where).toEqual(view.where);
    expect(back.style).toEqual(view.style);
    expect(back.sel!.ids['osm-substations-points']).toHaveLength(500);
  });
});
