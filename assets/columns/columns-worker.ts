// ─── Columns decode worker ───────────────────────────────────────────────────
// Role: module Worker that decodes one column of one row group off the main thread. Message in
//       {id, schema, rowGroup, column, bytes, start} (rowGroup = that one row group's footer entry,
//       never the whole footer; `bytes` the column chunk's bytes copied from `start`, never a
//       transferred buffer); one message per column. Message out {id, ok: true, col} with
//       col.codes.buffer transferred, or {id, ok: false}: a failed decode carries no input value.
//       Fetches nothing and keeps no state. handleDecode is the pure part (unit-tested without a
//       Worker); the onmessage wiring is the rest.
//       Started only by columns-read.ts (`new Worker(new URL(...), {type: 'module'})`).
// Deps: columns-decode.ts only.

import { decodeColumn, type DecodeInput } from './columns-decode.js';

export type DecodeRequest = DecodeInput & { id: number };

export function handleDecode(msg: DecodeRequest, post: (m: unknown, transfer?: ArrayBuffer[]) => void): Promise<void> {
  const { id, ...input } = msg;
  return decodeColumn(input).then(
    col => post({ id, ok: true, col }, [col.codes.buffer as ArrayBuffer]),
    () => post({ id, ok: false }),
  );
}

// tsconfig has no WebWorker lib: the two members of the worker scope used here.
if (typeof document === 'undefined' && typeof self !== 'undefined') {
  const scope = self as unknown as {
    onmessage: ((e: MessageEvent<DecodeRequest>) => void) | null;
    postMessage(msg: unknown, transfer?: ArrayBuffer[]): void;
  };
  scope.onmessage = (e) => { void handleDecode(e.data, (m, t) => scope.postMessage(m, t)); };
}
