// ─── Proximity: the 30,000-point oracle check ───────────────────────────────
// Role: runs m0 (all pairs, WGS84 geodesic) at n = 30,000 on D1 and D2 at 25 km, plain
//       and with ids (withBuses), and holds each method named in PX_CHECK (default
//       m5) to it on every field.
//       Not matched by `npm test`; run with
//       `npx vitest run --config assets/proximity/vitest.oracle30k.config.ts`.
//
// Deps: ./methods.js, ./oracle.js, ./fixtures.js. Test support only.

import { expect, it } from 'vitest';
import { METHODS } from './methods.js';
import { oracle } from './oracle.js';
import { d1Uniform, d2Clustered, withBuses } from './fixtures.js';

const KM = 25;

const base = { D1: d1Uniform(30000, 11), D2: d2Clustered(30000, 22) };
const sets: Record<string, { lon: Float64Array; lat: Float64Array; ids?: Int32Array }> = {
  D1: base.D1, D2: base.D2, 'D1+ids': withBuses(base.D1, 77, KM), 'D2+ids': withBuses(base.D2, 77, KM),
};

for (const [name, p] of Object.entries(sets)) {
  it(`${name}: methods equal the oracle at 30,000 points, ${KM} km`, () => {
    const t0 = performance.now();
    const want = oracle(p.lon, p.lat, KM, { ids: p.ids });
    console.log(`oracle ${name}: ${(performance.now() - t0).toFixed(0)} ms, groups ${want.groups}`);
    for (const id of (process.env.PX_CHECK ?? 'm5').split(',')) {
      const got = METHODS[id](p.lon, p.lat, KM, { ids: p.ids });
      expect(got.groups, id).toBe(want.groups);
      expect(got.skipped, id).toBe(want.skipped);
      expect(Array.from(got.group), id).toEqual(Array.from(want.group));
      expect(Array.from(got.size), id).toEqual(Array.from(want.size));
      let worst = 0;
      for (let i = 0; i < want.nearestKm.length; i++) {
        const a = got.nearestKm[i], b = want.nearestKm[i];
        if (Number.isNaN(b)) expect(a, `${id} nearestKm[${i}]`).toBeNaN();
        else worst = Math.max(worst, Math.abs(a - b));
      }
      expect(worst, id).toBeLessThanOrEqual(1e-9);
    }
  }, 600000);
}
