// copy-rows.ts: which layers copy and how, the clone of the map's own features,
// the credit as text and the licence taken from an untrusted manifest.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const added: { features: GeoJSON.Feature[]; layerName?: string }[] = [];
vi.mock('./user-data.js', () => ({
  addCopiedFeatures: (features: GeoJSON.Feature[], layerName?: string) => {
    // what mountLayer does to what it is handed
    for (const f of features) (f.properties as Record<string, unknown>).__uid = 'u' + added.length;
    added.push({ features, layerName });
    return { saved: true };
  },
  storedUserDataChars: () => 0,
}));
vi.mock('./user-data-export.js', () => ({ downloadFile: vi.fn() }));
const copyLines = vi.fn(async () => ({ kind: 'copied', n: 1, simplified: 0 }));
vi.mock('../lines/line-copy.js', () => ({ copyLines }));
vi.mock('../lines/line-read.js', () => ({ MAX_SELECTION: 1000, lineDataset: async () => ({ ok: true, result: {} }) }));

const { copyMode, copyNoun, copyRows, copyAvailable, resetCopyManifest } = await import('./copy-rows.js');
const { LAYERS, layerById } = await import('../../src/registry/index.js');
const { hasPopupRenderer } = await import('../popup-format.js');

const row = (id: number | string, extra: Record<string, unknown> = {}) => ({
  id, props: {},
  feature: { type: 'Feature', geometry: { type: 'Point', coordinates: [1, 2] }, properties: { name: 'A', ...extra } } as GeoJSON.Feature,
});

function manifest(body: unknown, ok = true) {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok, json: async () => body })));
}

beforeEach(() => { added.length = 0; copyLines.mockClear(); resetCopyManifest(); manifest(null, false); });

describe('copyMode', () => {
  const queryable = LAYERS.filter(l => l.dataset && l.data?.id);
  it('splits the queryable layers by mode', () => {
    const tally = { exact: 0, full: 0, point: 0, none: 0 };
    for (const l of queryable) tally[copyMode(l.id)]++;
    expect(tally.full).toBe(21);
    expect(tally.point).toBe(2);
    expect(tally.exact).toBe(12);
    expect(tally.none).toBe(0);
  });
  it('full for the line and polygon datasets, point for the tiled point layers with a columns file', () => {
    expect(['osm-transmission-lines', 'hifld-transmission-lines', 'osm-substations-polygons', 'osm-plants-polygons', 'osm-pipelines-lines', 'hifld-natgas-lines', 'retail-territories', 'eia-ba', 'nerc-regions', 'control-areas', 'crithab', 'padus', 'us-states', 'countries', 'admin1', 'tribal-lands', 'us-counties', 'us-zcta', 'bia-tribal-lands', 'boem-wind-leases', 'railroads'].map(copyMode)).toEqual(Array(21).fill('full'));
    expect(['osm-substations-points', 'osm-generators'].map(copyMode)).toEqual(['point', 'point']);
  });
  it('names the copy by its geometry: lines for the line datasets, else features', () => {
    expect(copyNoun('osm-transmission-lines')).toBe('line');
    expect(copyNoun('osm-pipelines-lines')).toBe('line');
    expect(copyNoun('hifld-natgas-lines')).toBe('line');
    expect(copyNoun('railroads')).toBe('line');
    expect(copyNoun('osm-substations-polygons')).toBe('feature');
    expect(copyNoun('osm-plants-polygons')).toBe('feature');
    expect(copyNoun('nerc-regions')).toBe('feature');
    expect(copyNoun('control-areas')).toBe('feature');
    expect(copyNoun('osm-substations-points')).toBe('feature');
  });
  it('is none for non-queryable layers and unknown ids', () => {
    for (const l of LAYERS.filter(x => !queryable.includes(x))) expect(copyMode(l.id)).toBe('none');
    expect(copyMode('nope')).toBe('none');
  });
  it('every exact layer has a popup renderer for its __src', () => {
    for (const l of LAYERS) if (copyMode(l.id) === 'exact') expect(l.mapLayerIds.some(hasPopupRenderer), l.id).toBe(true);
  });
  it('availability: exact and point yes, none no, full by the geometry files', async () => {
    expect(await copyAvailable('osm-substations-points')).toBe(true);
    expect(await copyAvailable('hifld-substations')).toBe(true);
    expect(await copyAvailable('nexrad-radar')).toBe(false);
    expect(await copyAvailable('osm-transmission-lines')).toBe(true);
  });
});

describe('copyRows (exact)', () => {
  it('clones: the source feature is untouched and gets no __uid', async () => {
    const r = row(7, { __x: 1 });
    const before = structuredClone(r.feature);
    const res = await copyRows('hifld-substations', [r], 'S');
    expect(res).toMatchObject({ kind: 'copied', n: 1 });
    expect(r.feature).toEqual(before);
    expect(r.feature.properties).not.toHaveProperty('__uid');
    expect(added[0].features[0]).not.toBe(r.feature);
    expect(added[0].features[0].geometry).not.toBe(r.feature.geometry);
    expect(added[0].features[0].geometry).toEqual(r.feature.geometry);
    expect(added[0].layerName).toBe('S');
  });
  it('drops __ keys, adds the id, source, text credit and a popup src', async () => {
    const l = layerById('hifld-substations')!;
    await copyRows('hifld-substations', [row('abc', { __x: 1 })], 'S');
    const p = added[0].features[0].properties!;
    expect(p).not.toHaveProperty('__x');
    expect(p[l.data!.id!.field]).toBe('abc');
    expect(String(p.attribution)).not.toMatch(/[<]|&[#\w]+;/);
    expect(p.source).toBeTruthy();
    expect(hasPopupRenderer(String(p.__src))).toBe(true);
  });
  it('skips rows without an id; refuses empty and too many', async () => {
    expect(await copyRows('hifld-substations', [{ ...row(1), id: null }], 'S')).toEqual({ kind: 'refused', reason: 'empty' });
    const many = Array.from({ length: 1001 }, (_, i) => row(i));
    expect(await copyRows('hifld-substations', many, 'S')).toEqual({ kind: 'refused', reason: 'too-many' });
    expect(added).toHaveLength(0);
  });
  it('refuses a layer with no copy', async () => {
    expect(await copyRows('nexrad-radar', [row(1)], 'S')).toEqual({ kind: 'refused', reason: 'not-copyable' });
    expect(await copyRows('nope', [row(1)], 'S')).toEqual({ kind: 'refused', reason: 'not-copyable' });
  });
  it('takes the licence from the manifest', async () => {
    const ds = layerById('hifld-substations')!.dataset!;
    manifest({ layers: { [ds]: { label: 'L', licence: 'PD', url: 'https://x.test/' } } });
    await copyRows('hifld-substations', [row(1)], 'S');
    expect(added[0].features[0].properties).toMatchObject({ licence: 'PD', source_url: 'https://x.test/', source: 'L' });
  });
  it('leaves out an UNKNOWN or oversized licence, a bad shape, and a failed fetch', async () => {
    const ds = layerById('hifld-substations')!.dataset!;
    for (const body of [{ layers: { [ds]: { licence: 'UNKNOWN', url: 7 } } }, { layers: { [ds]: { licence: 'x'.repeat(301) } } },
      { layers: [] }, null, 'junk']) {
      resetCopyManifest(); added.length = 0; manifest(body);
      await copyRows('hifld-substations', [row(1)], 'S');
      expect(added[0].features[0].properties).not.toHaveProperty('licence');
      expect(added[0].features[0].properties).not.toHaveProperty('source_url');
    }
    resetCopyManifest(); added.length = 0;
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    expect(await copyRows('hifld-substations', [row(1)], 'S')).toMatchObject({ kind: 'copied' });
    expect(added[0].features[0].properties).not.toHaveProperty('licence');
  });
  it('fetches the manifest once per page', async () => {
    manifest({ layers: {} });
    await copyRows('hifld-substations', [row(1)], 'S');
    await copyRows('hifld-substations', [row(2)], 'S');
    expect((fetch as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });
  it('keeps an OSM id as given and links the object', async () => {
    const osm = LAYERS.find(l => copyMode(l.id) === 'exact' && l.data?.id?.native)?.id;
    if (!osm) return;
    await copyRows(osm, [row(1234562)], 'S');
    expect(added[0].features[0].properties?.osm).toBe('https://www.openstreetmap.org/way/123456');
  });
});

describe('copyRows (fromSource on a full GeoJSON layer)', () => {
  it('marks the served outline as simplified; the exact copy of a plain GeoJSON layer carries no mark', async () => {
    const res = await copyRows('us-states', [row('TX')], 'S', undefined, true);
    expect(res).toMatchObject({ kind: 'copied', n: 1, simplified: 1 });
    expect(added[0].features[0].properties?.geometry_source).toBe('simplified from the served map layer');
    await copyRows('hifld-substations', [row('abc')], 'S', undefined, true);
    expect(added[1].features[0].properties).not.toHaveProperty('geometry_source');
  });
});

describe('copyRows (lines)', () => {
  it('hands rows to copyLines as items', async () => {
    await copyRows('osm-transmission-lines', [row(5)], 'N');
    expect(copyLines).toHaveBeenCalledOnce();
    const items = (copyLines.mock.calls[0] as unknown as [string, { fid: number }[], string]);
    expect(items[0]).toBe('osm-transmission-lines');
    expect(items[1][0].fid).toBe(5);
    expect(items[2]).toBe('N');
  });
});

describe('pointOnly rows', () => {
  it('a line copy never carries the point as tile geometry', async () => {
    await copyRows('osm-transmission-lines', [{ ...row(5), pointOnly: true as const }, row(6)], 'N');
    const items = (copyLines.mock.calls[0] as unknown as [string, { fid: number; tileGeometry?: unknown }[]])[1];
    expect(items[0].tileGeometry).toBeNull();
    expect((items[0] as { searchHint?: unknown }).searchHint).toEqual({ type: 'Point', coordinates: [1, 2] });
    expect((items[1] as { searchHint?: unknown }).searchHint).toBeUndefined();
    expect(items[1].tileGeometry).toBeTruthy();
  });
  it('an exact copy refuses a point standing in for a shape', async () => {
    expect(await copyRows('hifld-substations', [{ ...row(1), pointOnly: true as const }], 'S')).toEqual({ kind: 'refused', reason: 'not-copyable' });
    expect(added).toHaveLength(0);
  });
});

describe('bundle split', () => {
  it('imports line-copy and line-read only through import()', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('./copy-rows.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/^import[^\n]*line-(copy|read)/m);
  });
});
