// assets/state-bus.ts — typed pub/sub for coordinating state mutations.
// Emitters write state then emit; subscribers react (apply filters, write URL).
// No circular deps: this file imports nothing.

type Events = {
  'filter:generators':    void;   // MW / fuel / year / status changed
  'filter:layer': { id: string }; // per-layer bucket filter changed
  'filter:all':           void;   // re-apply every filter (used by reset)
  'gen:mode':    { id: string };  // generator display mode changed
  'ogf:colorby':          void;   // OGF planned-lines color-by mode changed
  'westtec:colorby':      void;   // WestTEC 10-Yr color-by mode changed
  'url:write':            void;   // persist current state to URL / localStorage
};

type Handler<K extends keyof Events> = (payload: Events[K]) => void;

const subs = new Map<string, Set<(p: unknown) => void>>();

export function on<K extends keyof Events>(event: K, fn: Handler<K>): void {
  if (!subs.has(event)) subs.set(event, new Set());
  subs.get(event)!.add(fn as (p: unknown) => void);
}

export function emit<K extends keyof Events>(event: K, ...args: Events[K] extends void ? [] : [Events[K]]): void {
  const payload = args[0];
  subs.get(event)?.forEach(fn => fn(payload as unknown));
}
