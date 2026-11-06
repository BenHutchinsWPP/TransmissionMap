// ─── Proximity sample worker ─────────────────────────────────────────────────
// Role: module Worker that downloads the HIFLD substations layer (a gzipped GeoJSON), unzips and
//       parses it and cuts it to the map view's box, off the main thread. Message in
//       {id, url, box, cap}; message out {id, outcome}: a SampleCut (sample.ts) or {kind: 'failed'}.
//       No fetched value is put in the failure. handleSample is the testable part (fetch injected).
//       Started only by sample-open.ts.
// Deps: sample.ts.

import { cutSample, type Box, type SampleCut } from './sample.js';

export interface SampleRequest { id: number; url: string; box: Box; cap: number }
export type SampleOutcome = SampleCut | { kind: 'failed' };

export async function handleSample(msg: SampleRequest, post: (m: unknown) => void, fetchFn: typeof fetch = fetch): Promise<void> {
  let outcome: SampleOutcome;
  try {
    const resp = await fetchFn(msg.url);
    if (!resp.ok || !resp.body) throw new Error('bad response');
    const body = msg.url.endsWith('.gz') ? resp.body.pipeThrough(new DecompressionStream('gzip')) : resp.body;
    outcome = cutSample(await new Response(body).json(), msg.box, msg.cap);
  } catch {
    outcome = { kind: 'failed' };
  }
  post({ id: msg.id, outcome });
}

if (typeof document === 'undefined' && typeof self !== 'undefined') {
  const scope = self as unknown as {
    onmessage: ((e: MessageEvent<SampleRequest>) => void) | null;
    postMessage(msg: unknown): void;
  };
  scope.onmessage = (e) => { void handleSample(e.data, m => scope.postMessage(m)); };
}
