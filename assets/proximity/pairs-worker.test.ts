import { describe, it, expect } from 'vitest';
import { handlePairs, BAD_INPUT, type PairsRequest } from './pairs-worker.js';
import { proximityPairs } from './proximity.js';
import { d2Clustered } from './fixtures.js';

type Msg = { id: number; progress?: number; outcome?: { ok: boolean; result?: ReturnType<typeof proximityPairs>; reason?: string } };

function run(req: PairsRequest) {
  const msgs: Msg[] = [];
  const transfers: ArrayBuffer[][] = [];
  handlePairs(req, (m, t) => { msgs.push(m as Msg); transfers.push(t ?? []); });
  return { msgs, transfers };
}

describe('handlePairs', () => {
  const p = d2Clustered(6000, 22);

  it('answers what proximityPairs gives, with progress first and the buffers transferred', () => {
    const want = proximityPairs(p.lon, p.lat, 100);
    expect(want.a.length).toBeGreaterThan(100_000);
    const { msgs, transfers } = run({ id: 7, lon: p.lon.slice(), lat: p.lat.slice(), km: 100 });
    const last = msgs[msgs.length - 1];
    expect(last.id).toBe(7);
    expect(last.outcome?.ok).toBe(true);
    const got = last.outcome!.result!;
    expect(Array.from(got.a)).toEqual(Array.from(want.a));
    expect(Array.from(got.b)).toEqual(Array.from(want.b));
    expect(Array.from(got.km)).toEqual(Array.from(want.km));
    expect(got.truncated).toBe(want.truncated);
    const progress = msgs.slice(0, -1);
    expect(progress.length).toBeGreaterThan(0);
    expect(progress.every((m) => m.id === 7 && typeof m.progress === 'number')).toBe(true);
    expect(transfers[transfers.length - 1]).toHaveLength(3);
  });

  it('passes ids and max through', () => {
    const ids = new Int32Array(p.lon.length).fill(-1);
    const { msgs } = run({ id: 1, lon: p.lon, lat: p.lat, km: 25, ids, max: 10 });
    const r = msgs[msgs.length - 1].outcome!.result!;
    expect(r.a.length).toBe(10);
    expect(r.truncated).toBe(true);
  });

  it('refuses a bad threshold without echoing any input', () => {
    const lon = Float64Array.from([-97.123456, -97.123457]), lat = Float64Array.from([31.654321, 31.654322]);
    const { msgs, transfers } = run({ id: 2, lon, lat, km: 5000 });
    expect(msgs).toHaveLength(1);
    const o = msgs[0].outcome!;
    expect(o.ok).toBe(false);
    expect(o.reason).toBe(BAD_INPUT);
    expect(o.reason).not.toMatch(/5000|97\.|31\./);
    expect(transfers[0]).toEqual([]);
  });

  it('refuses a bad max and unequal arrays', () => {
    expect(run({ id: 3, lon: p.lon, lat: p.lat, km: 5, max: -1 }).msgs[0].outcome?.ok).toBe(false);
    expect(run({ id: 4, lon: p.lon, lat: p.lat.slice(1), km: 5 }).msgs[0].outcome?.ok).toBe(false);
  });
});
