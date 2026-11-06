// The hover LUT cache: one download on first switch-on, a grid kept only while
// its URL is the probe's current lut(), and fetches landing out of order (a
// playback tick outrunning a slow grid) never leaving an older step's grid.
// Weather probes, since theirs are the URLs that move; fetch is faked and each
// response is held until the test releases it.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { gzipSync } from 'fflate';
import { ensureRasterLut, sampleRaster, setWeatherLutStep } from './raster-probes.js';

const GRID = { width: 1, height: 1, bbox: [-180, -90, 180, 90], scale: 1, nodata: -32768 };
const META = { vars: { temp: GRID, wind: GRID } };

// url → release its response; every LUT url reads as the value in VALUES.
let pending: [string, () => void][] = [];
const VALUES: Record<string, number> = {};
const fetchMock = vi.fn((url: string) => new Promise<Response>(resolve => {
  const body = url.includes('meta.json')
    ? JSON.stringify(META)
    : gzipSync(new Uint8Array(new Int16Array([VALUES[url.split('?')[0].split('/').pop()!]]).buffer));
  pending.push([url, () => resolve(new Response(body))]);
}));
vi.stubGlobal('fetch', fetchMock);

const lutCalls = () => fetchMock.mock.calls.filter(([u]) => u.includes('.i16.gz'));
// Releases the held LUT responses whose URL contains `match`, and every meta.json.
function release(match: string) {
  const go = pending.filter(([u]) => u.includes(match) || u.includes('meta.json'));
  pending = pending.filter(p => !go.includes(p));
  go.forEach(([, fn]) => fn());
}
const releaseAll = () => release('');
const flush = () => new Promise(r => setTimeout(r, 0));

beforeEach(() => {
  fetchMock.mockClear();
  pending = [];
  Object.assign(VALUES, { 'temp.i16.gz': 10, 'temp_003.i16.gz': 3, 'temp_006.i16.gz': 6,
    'wind_003.i16.gz': 30, 'wind_006.i16.gz': 60 });
});

describe('weather hover LUT', () => {
  it('fetches nothing before the first bake is read, then downloads once on switch-on', async () => {
    await ensureRasterLut('weather-live'); // visibility.ts, before weather-live has a bake
    expect(fetchMock).not.toHaveBeenCalled();
    setWeatherLutStep('', 'bake-1');
    const a = ensureRasterLut('weather-live');
    const b = ensureRasterLut('weather-live'); // the paint right after switch-on
    expect(lutCalls()).toHaveLength(1);
    releaseAll();
    await Promise.all([a, b]);
    expect(sampleRaster('weather-live', 0, 0)).toBe(10);
  });

  it('refetches a new bake at the same step and stops sampling the old one', async () => {
    setWeatherLutStep('', 'bake-2');
    expect(sampleRaster('weather-live', 0, 0)).toBeNull();
    const p = ensureRasterLut('weather-live');
    expect(lutCalls()).toHaveLength(1);
    expect(lutCalls()[0][0]).toContain('bake-2');
    releaseAll();
    await p;
    expect(sampleRaster('weather-live', 0, 0)).toBe(10);
  });

  for (const [id, v3, v6] of [['weather-live', 3, 6], ['weather-live-wind', 30, 60]] as const) {
    it(`${id}: keeps the scrubbed-to step when the earlier step's grid lands last`, async () => {
      setWeatherLutStep('_003', 'bake-3');
      const first = ensureRasterLut(id);
      setWeatherLutStep('_006', 'bake-3');
      const second = ensureRasterLut(id);
      expect(lutCalls()).toHaveLength(2);
      release('_006');
      await second;
      expect(sampleRaster(id, 0, 0)).toBe(v6);
      releaseAll();
      await first;
      await flush();
      expect(sampleRaster(id, 0, 0)).toBe(v6);
      // Scrubbing back to the discarded step fetches it afresh.
      setWeatherLutStep('_003', 'bake-3');
      const again = ensureRasterLut(id);
      releaseAll();
      await again;
      expect(sampleRaster(id, 0, 0)).toBe(v3);
    });
  }
});
