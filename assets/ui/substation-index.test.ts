// Tests for substation-index.ts: one shared load, a failed or empty load is forgotten and retried.
// Deps: substation-index.ts; layer-data.js is mocked; state.sourcesData is filled by hand.
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../layers/layer-data.js', () => ({ loadSource: vi.fn() }));

import { loadSource } from '../layers/layer-data.js';
import { state } from '../state.js';
import { layerSourceId } from '../layers/layer-source.js';
import { ensureSubstationIndex, cachedSubstationIndex, _resetSubstationIndex } from './substation-index.js';

const sub = (id: string, name: string, lng: number, lat: number) => ({
  type: 'Feature' as const, geometry: { type: 'Point' as const, coordinates: [lng, lat] },
  properties: { hifld_id: id, name, max_kv: 345, states: '|NV|', ba: '|NEVP|' },
});
const key = () => layerSourceId('hifld-substations');

beforeEach(() => {
  _resetSubstationIndex();
  vi.mocked(loadSource).mockReset();
  delete (state.sourcesData as Record<string, unknown>)[key()];
});

describe('ensureSubstationIndex', () => {
  it('builds the index from the loaded features and shares one load', async () => {
    vi.mocked(loadSource).mockImplementation(async () => {
      (state.sourcesData as Record<string, unknown>)[key()] = [sub('1', 'ALPHA', -119.8, 39.5), sub('2', 'BETA', -119.9, 39.6)];
    });
    const [a, b] = await Promise.all([ensureSubstationIndex(), ensureSubstationIndex()]);
    expect(vi.mocked(loadSource)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(loadSource)).toHaveBeenCalledWith('hifld-substations');
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) { expect(a.result).toBe(b.result); expect(a.result.subs.map((s) => s.id)).toEqual(['1', '2']); }
    expect(cachedSubstationIndex()).not.toBeNull();
    await ensureSubstationIndex();
    expect(vi.mocked(loadSource)).toHaveBeenCalledTimes(1);
  });

  it('refuses an empty list and retries on the next call', async () => {
    vi.mocked(loadSource).mockResolvedValue(undefined as never);
    const o = await ensureSubstationIndex();
    expect(o).toEqual({ ok: false, reason: 'the substation list could not be loaded; try again' });
    expect(cachedSubstationIndex()).toBeNull();
    vi.mocked(loadSource).mockImplementation(async () => {
      (state.sourcesData as Record<string, unknown>)[key()] = [sub('1', 'ALPHA', -119.8, 39.5)];
    });
    expect((await ensureSubstationIndex()).ok).toBe(true);
    expect(vi.mocked(loadSource)).toHaveBeenCalledTimes(2);
  });

  it('refuses a failed load and retries', async () => {
    vi.mocked(loadSource).mockRejectedValueOnce(new Error('net'));
    expect((await ensureSubstationIndex()).ok).toBe(false);
    vi.mocked(loadSource).mockImplementation(async () => {
      (state.sourcesData as Record<string, unknown>)[key()] = [sub('1', 'ALPHA', -119.8, 39.5)];
    });
    expect((await ensureSubstationIndex()).ok).toBe(true);
  });
});
