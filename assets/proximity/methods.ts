// ─── Proximity method registry ──────────────────────────────────────────────
// Role: every proximity method by id, all behind ProximityMethod, for the parity
//       harness (proximity.test.ts) and the benchmarks to run. The harness checks
//       every entry except 'm0' against it.
//         m0        the oracle: all pairs, WGS84 geodesic (oracle.ts)
//         m5        the shipped method: sparse or dense by measured crowding (proximity.ts)
//         m5sparse  m5 forced onto the sparse branch (methods/m2.ts), so it is tested on every set
//         m5dense   m5 forced onto the dense branch (methods/m2f.ts), likewise
//       Pure: no DOM, no map.
//
// Deps: ./oracle.js, ./proximity.js, ./types.js. Used by proximity.test.ts and the benchmarks.

import { oracle } from './oracle.js';
import { m5, makeM5 } from './proximity.js';
import type { ProximityMethod } from './types.js';

export const METHODS: Record<string, ProximityMethod> = {
  m0: oracle, m5, m5sparse: makeM5(Infinity), m5dense: makeM5(-1),
};
