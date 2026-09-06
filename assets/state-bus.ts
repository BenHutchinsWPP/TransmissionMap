// assets/state-bus.ts — typed pub/sub for coordinating state mutations.
// Emitters write state then emit; subscribers react (apply filters, write URL).
// No circular deps: this file imports only types.

import type { SupportedLocale } from '../src/i18n/types.js';
import type { LayerScope } from '../src/types.js';

type Events = {
  'filter:generators':    void;   // MW / fuel / year / status changed
  'filter:layer': { id: string }; // per-layer bucket filter changed
  'filter:all':           void;   // re-apply every filter (used by reset)
  'gen:mode':    { id: string };  // generator display mode changed
  'ogf:colorby':          void;   // OGF planned-lines color-by mode changed
  'westtec:colorby':      void;   // WestTEC 10-Yr color-by mode changed
  'units:changed':        void;   // display-unit preference changed
  'lang:changed': { locale: SupportedLocale }; // language preference changed
  'region:changed': { region: LayerScope }; // layer-list scope changed
  'map:ready':            void;   // style loaded, every layer added, filters applied
  'exp:dirty':            void;   // the user edited the view out of its experience
  'exp:ended':            void;   // the active experience was dismissed
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
