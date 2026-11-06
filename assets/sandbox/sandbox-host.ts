// ─── Analysis sandbox host: runs model-written code away from the page ──────
// Role: the page's side of the analysis sandbox (docs/internal/chat-trust-model.md). On first use it adds a hidden
//       <iframe sandbox="allow-scripts" src="/sandbox.html"> (opaque origin; the
//       frame's own meta CSP gives it no network, no eval, no storage) and waits
//       for the runner's ready ping, which says whether a blob Worker runs there.
//         runInSandbox(code, inputs, {signal?}) → Outcome<{value, ms}>
//       Inputs: JSON, ≤ 5 MB serialized and ≤ 50 000 features (a FeatureCollection's
//       features, an array's items, summed over an object's values); the code ≤
//       100 000 characters. One run at a time (later calls wait their turn).
//       Every reply is matched by event.source === the frame's contentWindow and
//       the run's nonce, never by origin (an opaque origin is "null"). The runner
//       stops the code at 10 s; if no reply comes by 12 s, or the frame navigates
//       or the signal aborts, the frame is removed and the next run makes a new
//       one. This module only runs code: the caller decides what reaches a model.
//
// Deps: dataset-query.ts (Outcome type only); public/sandbox.html (built from
//       sandbox/runner.js + sandbox/geo-kit.ts by scripts/build_sandbox.mjs).

import type { Outcome } from '../dataset-query.js';

export const SANDBOX_URL = `${import.meta.env.BASE_URL}sandbox.html`;
export const MAX_INPUT_CHARS = 5 * 1024 * 1024;
export const MAX_INPUT_FEATURES = 50_000;
export const MAX_CODE_CHARS = 100_000;
export const BACKSTOP_MS = 12_000;
const READY_MS = 10_000;
export const UNAVAILABLE = "Analysis isn't available in this browser";

export interface SandboxResult { value: unknown; ms: number }
export interface SandboxOptions { signal?: AbortSignal }

interface Reply { type?: unknown; id?: unknown; nonce?: unknown; ok?: unknown; value?: unknown; error?: unknown; ms?: unknown; worker?: unknown }
interface Pending { id: number; nonce: string; settle: (r: Outcome<SandboxResult>) => void }

let frame: HTMLIFrameElement | null = null;
let ready: Promise<boolean> | null = null;
let onReady: ((worker: boolean) => void) | null = null;
let pending: Pending | null = null;
let unavailable = false;
let listening = false;
let seq = 0;
let queue: Promise<unknown> = Promise.resolve();

function discard(): void {
  frame?.remove();
  frame = null; ready = null; onReady = null;
}

function onMessage(e: MessageEvent): void {
  if (!frame || e.source !== frame.contentWindow) return;
  const d = e.data as Reply;
  if (!d || typeof d !== 'object') return;
  if (d.type === 'ready') { onReady?.(d.worker === true); onReady = null; return; }
  if (d.type !== 'result' || !pending || d.nonce !== pending.nonce || d.id !== pending.id) return;
  const ms = typeof d.ms === 'number' ? d.ms : 0;
  pending.settle(d.ok === true
    ? { ok: true, result: { value: d.value, ms } }
    : { ok: false, reason: typeof d.error === 'string' ? d.error : 'The analysis failed' });
}

function ensureFrame(): Promise<boolean> {
  if (ready) return ready;
  if (!listening) { window.addEventListener('message', onMessage); listening = true; }
  const f = document.createElement('iframe');
  f.setAttribute('sandbox', 'allow-scripts');
  f.hidden = true;
  f.src = SANDBOX_URL;
  frame = f;
  // A second load after the ready ping is the frame navigating away: its runner is gone.
  let loads = 0, up = false;
  f.addEventListener('load', () => {
    if (++loads < 2 || !up || frame !== f) return;
    pending?.settle({ ok: false, reason: 'The analysis frame was reset' });
    discard();
  });
  const p: Promise<boolean> = new Promise(resolve => {
    const t = setTimeout(() => { if (frame === f) discard(); resolve(false); }, READY_MS);
    onReady = worker => {
      clearTimeout(t);
      up = true;
      resolve(worker);
    };
  });
  ready = p;
  document.body.appendChild(f);
  return p;
}

/** How many features the inputs carry: a FeatureCollection's features, an array's items, summed over an object's values. */
export function countFeatures(x: unknown): number {
  if (Array.isArray(x)) return x.length;
  if (!x || typeof x !== 'object') return 0;
  const o = x as Record<string, unknown>;
  if (o.type === 'FeatureCollection' && Array.isArray(o.features)) return o.features.length;
  let n = 0;
  for (const v of Object.values(o)) n += countFeatures(v);
  return n;
}

function nonce(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
}

async function runOne(code: string, json: string, signal?: AbortSignal): Promise<Outcome<SandboxResult>> {
  if (unavailable) return { ok: false, reason: UNAVAILABLE };
  if (signal?.aborted) return { ok: false, reason: 'Stopped.' };
  const worker = await ensureFrame();
  if (!worker || !frame?.contentWindow) {
    if (frame && !worker) { unavailable = true; discard(); }
    return { ok: false, reason: UNAVAILABLE };
  }
  const win = frame.contentWindow;
  const run: Pending = { id: ++seq, nonce: nonce(), settle: () => {} };
  return new Promise(resolve => {
    const end = (r: Outcome<SandboxResult>, reset: boolean) => {
      if (pending !== run) return;
      pending = null;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (reset) discard();
      resolve(r);
    };
    const abort = () => end({ ok: false, reason: 'Stopped.' }, true);
    const timer = setTimeout(() => end({ ok: false, reason: 'The analysis did not answer within 12 s and was stopped' }, true), BACKSTOP_MS);
    run.settle = r => end(r, false);
    pending = run;
    signal?.addEventListener('abort', abort);
    win.postMessage({ id: run.id, nonce: run.nonce, code, inputs: json }, '*');
  });
}

function toJson(x: unknown): string | undefined {
  try { return JSON.stringify(x === undefined ? null : x); } catch { return undefined; }
}

/** Run `code` over `inputs` in the sandbox. Never rejects. */
export function runInSandbox(code: string, inputs: unknown, opts: SandboxOptions = {}): Promise<Outcome<SandboxResult>> {
  if (typeof code !== 'string' || code.length > MAX_CODE_CHARS) {
    return Promise.resolve({ ok: false, reason: `code must be a string of at most ${MAX_CODE_CHARS} characters` });
  }
  const json = toJson(inputs);
  if (json === undefined) return Promise.resolve({ ok: false, reason: 'inputs must be JSON' });
  if (json.length > MAX_INPUT_CHARS) return Promise.resolve({ ok: false, reason: 'inputs are over 5 MB: narrow the request' });
  const n = countFeatures(inputs);
  if (n > MAX_INPUT_FEATURES) return Promise.resolve({ ok: false, reason: `inputs have ${n} features, over ${MAX_INPUT_FEATURES}: narrow the request` });
  const p = queue.then(() => runOne(code, json, opts.signal))
    .catch((e: unknown) => ({ ok: false, reason: `The analysis failed: ${String(e)}` }) as const);
  queue = p.catch(() => {});
  return p;
}
