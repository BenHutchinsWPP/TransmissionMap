// @vitest-environment jsdom
// View files: build/read round trip through the link codec, import routing
// (handleFileOpen), story handling, and rejection of anything that is not a v1 view file with a sane hash.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { UrlStateData, CameraView } from '../url-state-codec.js';
import type { DroppedStyle } from '../style-overrides.js';

const { applyView, notice, endExperience, restoreFromUrl, addUserLayer } = vi.hoisted(() => ({
  applyView: vi.fn((_data: Partial<UrlStateData>, _camera?: CameraView): DroppedStyle[] => []),
  notice: vi.fn(),
  endExperience: vi.fn(),
  restoreFromUrl: vi.fn(),
  addUserLayer: vi.fn(),
}));
vi.mock('../experiences.js', () => ({ endExperience }));
vi.mock('../ui/ui-experiences.js', () => ({ restoreFromUrl }));
vi.mock('./user-data.js', () => ({ addUserLayer, renderMyDataTab: vi.fn() }));
vi.mock('../view-state.js', async orig => ({ ...(await orig<object>()), applyView }));
vi.mock('../url-state.js', async orig => ({ ...(await orig<object>()), showDroppedNotice: notice }));
vi.mock('./user-data-export.js', () => ({ downloadFile: vi.fn() }));

import { state } from '../state.js';
import { beginExperience, endExperienceLink, activeExperienceId } from '../experience-link.js';
import { buildViewFile, readViewFile, openViewFile } from './view-file.js';
import { handleFileOpen } from './user-data-import.js';
import { splitHash, parseUrlState, formatUrlState, formatCameraSegment, defaultView } from '../url-state-codec.js';

const view = { ...defaultView(), basemap: 'aerial', terrain3d: true };
const hash = formatCameraSegment({ center: [-120.5, 45.25], zoom: 6, bearing: 10, pitch: 20 })
  + '?' + formatUrlState(view).join('&');
const file = (hash: unknown, extra: object = {}) =>
  JSON.stringify({ format: 'tmview', v: 1, title: 'T', note: '', hash, ...extra });

const open = (text: string, name: string) => openViewFile(JSON.parse(text), name);
const flush = () => new Promise(r => setTimeout(r, 0));
const asFile = (text: string, name: string) => ({ name, text: () => Promise.resolve(text) }) as unknown as File;

beforeEach(() => {
  for (const m of [applyView, notice, endExperience, restoreFromUrl, addUserLayer]) m.mockClear();
  vi.stubGlobal('alert', vi.fn());
  state.mapReady = true;
  endExperienceLink();
});

describe('view file', () => {
  it('round-trips: build then open applies the same view and camera', () => {
    expect(open(buildViewFile('T', hash), 'a.tmview.json')).toBe(true);
    const [data, camera] = applyView.mock.calls[0];
    expect(formatUrlState({ ...defaultView(), ...data })).toEqual(formatUrlState(view));
    expect(camera).toEqual({ center: [-120.5, 45.25], zoom: 6, bearing: 10, pitch: 20 });
    expect(notice).not.toHaveBeenCalled();
  });

  it('lets a GeoJSON .json fall through to the GeoJSON importer', () => {
    const fc = JSON.stringify({ type: 'FeatureCollection', features: [] });
    expect(openViewFile(JSON.parse(fc), 'data.json')).toBe(false);
    expect(openViewFile(undefined, 'data.json')).toBe(false);
    expect(applyView).not.toHaveBeenCalled();
  });

  it.each([
    ['wrong format', JSON.stringify({ format: 'x', v: 1, hash })],
    ['v2', file(hash, { v: 2 })],
    ['non-string hash', file(42)],
    ['oversized hash', file('a'.repeat(16 * 1024 + 1))],
  ])('rejects %s without applying', (_n, text) => {
    expect(open(text, 'x.tmview.json')).toBe(true);
    expect(alert).toHaveBeenCalledOnce();
    expect(applyView).not.toHaveBeenCalled();
  });

  it('rejects a v2 file by content even without the file suffix', () => {
    expect(readViewFile(JSON.parse(file(hash, { v: 2 })), 'x.json')).toHaveProperty('error');
  });

  it('applies the rest and reports a bad vx entry', () => {
    const bad = hash + '&vx=' + encodeURIComponent('{"w":{"no-such-layer":[{"f":"x","o":"=","v":1}]},"s":{"no-such-layer":{"bogus":1}}}');
    expect(parseUrlState(splitHash(bad).params).dropped?.length).toBeGreaterThan(0);
    open(file(bad), 'x.tmview.json');
    expect(applyView).toHaveBeenCalledOnce();
    expect(applyView.mock.calls[0][0].basemap).toBe('aerial');
    expect(notice).toHaveBeenCalledOnce();
  });

  it('carries a vx past the link cap that a link would drop', () => {
    let seed = 1;
    const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const conds = Array.from({ length: 800 }, () => ({ field: 'nominal_kv', op: '>=' as const, value: rand() * 1000 }));
    const parts = formatUrlState({ ...view, where: { 'osm-transmission-lines': conds } });
    const vx = parts.find(p => p.startsWith('vx='))!.slice(3);
    expect(vx.length).toBeGreaterThan(8192);
    const big = hash.split('?')[0] + '?' + parts.join('&');
    expect(big.length).toBeLessThanOrEqual(16 * 1024);
    expect(parseUrlState(splitHash(big).params).where).toBeUndefined();
    open(file(big), 'x.tmview.json');
    expect(applyView.mock.calls[0][0].where?.['osm-transmission-lines']).toHaveLength(800);
    expect(notice).not.toHaveBeenCalled();
  });

  it('merges codec drops and apply drops into one notice', () => {
    const bad = hash + '&vx=' + encodeURIComponent('{"s":{"no-such-layer":{"bogus":1}}}');
    const codecDrops = parseUrlState(splitHash(bad).params).dropped!.length;
    applyView.mockReturnValueOnce([{ id: 'x', key: 'k', reason: 'r' } as DroppedStyle]);
    open(file(bad), 'x.tmview.json');
    expect(notice).toHaveBeenCalledOnce();
    const all = notice.mock.calls[0][0] as string[];
    expect(all).toHaveLength(codecDrops + 1);
    expect(all).toContain('vx.s.x.k: r');
  });

  it('restores a known story named by exp, without plain applyView', async () => {
    const h = hash + '&exp=columbia-hydro';
    open(file(h), 'x.tmview.json');
    await flush();
    expect(activeExperienceId()).toBe('columbia-hydro');
    expect(restoreFromUrl).toHaveBeenCalledOnce();
    expect(applyView).not.toHaveBeenCalled();
    expect(endExperience).not.toHaveBeenCalled();
  });

  it('ends the active story before applying a file without exp', () => {
    beginExperience('columbia-hydro');
    open(file(hash), 'x.tmview.json');
    expect(endExperience).toHaveBeenCalledOnce();
    expect(applyView).toHaveBeenCalledOnce();
  });

  it('ignores an unknown exp id and applies plainly', () => {
    open(file(hash + '&exp=no-such-story'), 'x.tmview.json');
    expect(restoreFromUrl).not.toHaveBeenCalled();
    expect(applyView).toHaveBeenCalledOnce();
  });

  it('alerts and applies nothing before the map is ready', () => {
    state.mapReady = false;
    expect(open(file(hash), 'x.tmview.json')).toBe(true);
    expect(alert).toHaveBeenCalledOnce();
    expect(applyView).not.toHaveBeenCalled();
    expect(endExperience).not.toHaveBeenCalled();
  });
});

describe('handleFileOpen routing', () => {
  it('sends a GeoJSON .json to the GeoJSON importer, not the view applier', async () => {
    handleFileOpen(asFile(JSON.stringify({ type: 'FeatureCollection', features: [] }), 'data.json'));
    await flush();
    expect(addUserLayer).toHaveBeenCalledOnce();
    expect(applyView).not.toHaveBeenCalled();
  });

  it('applies a view file and does not import it as GeoJSON', async () => {
    handleFileOpen(asFile(file(hash), 'v.json'));
    await flush();
    expect(applyView).toHaveBeenCalledOnce();
    expect(addUserLayer).not.toHaveBeenCalled();
  });

  it('keeps the import alert for invalid JSON in a plain .json', async () => {
    handleFileOpen(asFile('nope{', 'data.json'));
    await flush();
    expect(alert).toHaveBeenCalledWith(expect.stringContaining('Could not import data.json'));
  });

  it('reports invalid JSON in a .tmview.json as an invalid view file', async () => {
    handleFileOpen(asFile('nope{', 'x.tmview.json'));
    await flush();
    expect(alert).toHaveBeenCalledOnce();
    expect(alert).not.toHaveBeenCalledWith(expect.stringContaining('Could not import'));
  });
});
