// The proximity sample: the view's box (wrapped, whole world), the cut with its cap, and the worker's
// fetch → gunzip → cut over a fake fetch; a failure carries no fetched value.
// Deps: sample.ts, sample-worker.ts.

import { describe, it, expect } from 'vitest';
import { gzipSync } from 'node:zlib';
import { viewBox, inBox, cutSample } from './sample.js';
import { handleSample } from './sample-worker.js';

const pt = (x: number, y: number, p: Record<string, unknown> = {}) => ({ type: 'Feature', properties: p, geometry: { type: 'Point', coordinates: [x, y] } });
const fc = (...f: unknown[]) => ({ type: 'FeatureCollection', features: f });

describe('viewBox / inBox', () => {
  it('keeps an ordinary box, wraps longitudes past ±180 and takes the whole world when 360° wide', () => {
    expect(viewBox({ west: -100, south: 30, east: -90, north: 40 })).toEqual({ w: -100, s: 30, e: -90, n: 40 });
    const b = viewBox({ west: 170, south: -95, east: 190, north: 10 });
    expect(b).toEqual({ w: 170, s: -90, e: -170, n: 10 });
    expect(inBox(175, 0, b)).toBe(true);
    expect(inBox(-175, 0, b)).toBe(true);
    expect(inBox(0, 0, b)).toBe(false);
    expect(viewBox({ west: -300, south: 0, east: 100, north: 1 })).toMatchObject({ w: -180, e: 180 });
  });
});

describe('cutSample', () => {
  const box = { w: -100, s: 30, e: -90, n: 40 };
  it('keeps the Points in the box with their name, id and kV as text', () => {
    const r = cutSample(fc(pt(-95, 35, { name: 'A', hifld_id: 12, max_kv: 345, kv_range: '300-400' }), pt(0, 0), { type: 'Feature', geometry: null }), box);
    expect(r).toMatchObject({ kind: 'ok', props: [['A', '12', '345', '300-400']] });
    if (r.kind === 'ok') expect([...r.lon, ...r.lat]).toEqual([-95, 35]);
  });
  it('says none at zero and refuses above the cap with the count', () => {
    expect(cutSample(fc(pt(0, 0)), box)).toEqual({ kind: 'none' });
    expect(cutSample(fc(pt(-95, 35), pt(-95, 36), pt(-95, 37)), box, 2)).toEqual({ kind: 'tooMany', n: 3 });
    expect(cutSample(fc(pt(-95, 35), pt(-95, 36)), box, 2).kind).toBe('ok');
  });
  it('throws on something that is not a FeatureCollection', () => {
    expect(() => cutSample({}, box)).toThrow();
  });
});

describe('handleSample', () => {
  const box = { w: -100, s: 30, e: -90, n: 40 };
  const reply = (body: Uint8Array | string, ok = true) => (async () => new Response(body as BodyInit, { status: ok ? 200 : 500 })) as unknown as typeof fetch;
  it('unzips a .gz, parses and cuts', async () => {
    const out: { outcome: unknown }[] = [];
    const gz = gzipSync(JSON.stringify(fc(pt(-95, 35, { name: 'A' }), pt(5, 5))));
    await handleSample({ id: 1, url: 'https://x/y.geojson.gz', box, cap: 10 }, m => out.push(m as never), reply(new Uint8Array(gz)));
    expect(out[0].outcome).toMatchObject({ kind: 'ok', props: [['A', '', '', '']] });
  });
  it('fails with a fixed outcome on a bad status or body', async () => {
    const out: { outcome: unknown }[] = [];
    await handleSample({ id: 1, url: 'https://x/y.geojson', box, cap: 10 }, m => out.push(m as never), reply('nope', false));
    await handleSample({ id: 2, url: 'https://x/y.geojson', box, cap: 10 }, m => out.push(m as never), reply('{not json'));
    expect(out.map(o => o.outcome)).toEqual([{ kind: 'failed' }, { kind: 'failed' }]);
  });
});
