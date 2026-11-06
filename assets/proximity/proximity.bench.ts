// ─── Proximity benchmarks ───────────────────────────────────────────────────
// Role: median time at n = 30,000 on D1–D4 and 0.1/1/5/25/100/500 km (D3 rebuilt per
//       threshold) of the methods named in PX_METHODS (default m5), and of
//       proximityPairs on D1/D2 at 1 and 25 km. Bench names are `method|dataset|km`
//       and `pairs|dataset|km`. Run with `npx vitest bench --run assets/proximity
//       --outputJson <file>`; never part of `npm test`. Quadratic methods (m5sparse on D3)
//       are not meant for this file; keep PX_METHODS to m5 unless measuring a switch.
//
// Deps: ./methods.js, ./proximity.js, ./fixtures.js. Test and benchmark support only.

import { bench, describe } from 'vitest';
import { METHODS } from './methods.js';
import { proximityPairs } from './proximity.js';
import { d1Uniform, d2Clustered, d3Disc, d4Chains, type Points } from './fixtures.js';

const N = 30000;
const THRESHOLDS = [0.1, 1, 5, 25, 100, 500];
const MAKE: Record<string, (km: number) => Points> = {
  D1: () => d1Uniform(N, 11),
  D2: () => d2Clustered(N, 22),
  D3: (km) => d3Disc(N, 33, km),
  D4: (km) => d4Chains(N, 44, km),
};
const SKIP = (id: string): boolean => id === 'm0';
const SLOW = new Set(['D3']);
const ids = (process.env.PX_METHODS ?? 'm5').split(',');

for (const ds of Object.keys(MAKE)) {
  describe(ds, () => {
    for (const km of THRESHOLDS) {
      const p = MAKE[ds](km);
      for (const id of ids) {
        if (SKIP(id)) continue;
        bench(`${id}|${ds}|${km}`, () => { METHODS[id](p.lon, p.lat, km); }, SLOW.has(ds) ? { time: 0, iterations: 3, warmupTime: 0, warmupIterations: 1 } : { time: 300, iterations: 5, warmupTime: 100, warmupIterations: 2 });
      }
    }
  });
}

describe('pairs', () => {
  for (const ds of ['D1', 'D2']) {
    for (const km of [1, 25]) {
      const p = MAKE[ds](km);
      bench(`pairs|${ds}|${km}`, () => { proximityPairs(p.lon, p.lat, km); }, { time: 300, iterations: 5, warmupTime: 100, warmupIterations: 2 });
    }
  }
});
