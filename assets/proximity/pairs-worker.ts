// ─── Proximity pairs worker ─────────────────────────────────────────────────
// Role: module Worker that runs proximityPairs off the main thread, so enumerating up to a
//       million pairs never freezes the tab. Message in {id, lon, lat, km, ids?, max?} (typed
//       arrays, transferred); messages out {id, progress: found} about every 50,000 pairs,
//       then {id, outcome}: Outcome<PairsResult> with the a, b and km buffers transferred.
//       A RangeError (threshold, ids or max out of range, arrays of unequal length) becomes a
//       refusal with a fixed reason; no input value is ever put in a reason.
//       handlePairs is the pure part (unit-tested without a Worker); the onmessage wiring is the rest.
//       Started only by pairs-open.ts (`new Worker(new URL(...), {type: 'module'})`).
// Deps: proximity.ts; dataset-query.ts (Outcome type only).

import type { Outcome } from '../dataset-query.js';
import { proximityPairs } from './proximity.js';
import type { PairsResult } from './types.js';

export interface PairsRequest {
  id: number;
  lon: Float64Array;
  lat: Float64Array;
  km: number;
  ids?: Int32Array;
  max?: number;
}

export const BAD_INPUT = 'The threshold, ids or limit are out of range.';
export const FAILED = 'The proximity run failed.';

export function handlePairs(msg: PairsRequest, post: (m: unknown, transfer?: ArrayBuffer[]) => void): void {
  const { id } = msg;
  let outcome: Outcome<PairsResult>;
  try {
    const result = proximityPairs(msg.lon, msg.lat, msg.km, {
      ...(msg.ids ? { ids: msg.ids } : {}),
      ...(msg.max !== undefined ? { max: msg.max } : {}),
      onProgress: (found) => post({ id, progress: found }),
    });
    outcome = { ok: true, result };
  } catch (e) {
    outcome = { ok: false, reason: e instanceof RangeError ? BAD_INPUT : FAILED };
  }
  post({ id, outcome }, outcome.ok ? [outcome.result.a.buffer as ArrayBuffer, outcome.result.b.buffer as ArrayBuffer, outcome.result.km.buffer as ArrayBuffer] : []);
}

// tsconfig has no WebWorker lib: the two members of the worker scope used here.
// Wired only inside a worker, so a test (or the main bundle) importing handlePairs is unaffected.
if (typeof document === 'undefined' && typeof self !== 'undefined') {
  const scope = self as unknown as {
    onmessage: ((e: MessageEvent<PairsRequest>) => void) | null;
    postMessage(msg: unknown, transfer?: ArrayBuffer[]): void;
  };
  scope.onmessage = (e) => handlePairs(e.data, (m, t) => scope.postMessage(m, t));
}
