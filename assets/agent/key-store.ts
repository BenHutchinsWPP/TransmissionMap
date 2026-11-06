// ─── Key store: the visitor's OpenRouter key ─────────────────────────────────
// Role: where the key lives while the chat uses it.
//         getKey()               the key in memory, or loads a remembered one.
//         setKey(key, remember)  keeps a key that has the OpenRouter shape in
//                                memory; `remember` also writes it to
//                                localStorage (`tm-openrouter-key`), and
//                                remember=false removes any stored copy.
//         forgetKey()            clears both.
//         isRemembered()         whether a stored copy exists.
//       Memory only unless the visitor opts in. A trust boundary like
//       units-store.ts: a stored value is used only when it passes
//       isKeyShape(), and anything else is removed. The key never goes into
//       the URL, a view file, the diagnostics log or an error message —
//       openrouter.ts sends it in the Authorization header and nowhere else.
//       Every storage access is guarded (private mode, quota, blocked storage).
//
// Deps: none.

const STORE_KEY = 'tm-openrouter-key';
const KEY_SHAPE = /^sk-or-v1-[0-9a-f]{64}$/;

let key: string | null = null;

export const isKeyShape = (k: unknown): k is string => typeof k === 'string' && KEY_SHAPE.test(k);

function storage(): Storage | null {
  try { return globalThis.localStorage ?? null; } catch { return null; }
}

export function getKey(): string | null {
  if (key) return key;
  const s = storage();
  try {
    const stored = s?.getItem(STORE_KEY) ?? null;
    if (stored === null) return null;
    if (isKeyShape(stored)) return (key = stored);
    s?.removeItem(STORE_KEY);
  } catch { /* storage blocked: memory only */ }
  return null;
}

/** Keep `k` (trimmed) for this session, and on this device when `remember`. False when it is not a key. */
export function setKey(k: string, remember: boolean): boolean {
  const v = typeof k === 'string' ? k.trim() : '';
  if (!isKeyShape(v)) return false;
  key = v;
  try {
    if (remember) storage()?.setItem(STORE_KEY, v);
    else storage()?.removeItem(STORE_KEY);
  } catch { /* storage blocked: memory only */ }
  return true;
}

export function forgetKey(): void {
  key = null;
  try { storage()?.removeItem(STORE_KEY); } catch { /* nothing stored */ }
}

export function isRemembered(): boolean {
  try { return isKeyShape(storage()?.getItem(STORE_KEY)); } catch { return false; }
}
