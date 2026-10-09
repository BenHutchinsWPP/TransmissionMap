// assets/state-bus.ts — typed pub/sub for coordinating state mutations.
// Emitters write state then emit; subscribers react (apply filters, write URL).
// No circular deps: this file imports only types.

import type { SupportedLocale } from '../src/i18n/types.js';

type Events = {
  'filter:generators':    void;   // MW / fuel / year / status changed
  'filter:layer': { id: string }; // per-layer bucket filter changed
  'filter:all':           void;   // re-apply every filter (used by reset)
  'layer:visibility': { id: string; visible: boolean }; // setLayerVisibility() switched a layer
  'view:applied':         void;   // view-state.ts applyView() finished — resync panels + controls
  'style:weather':        void;   // the weather wash's opacity override changed (style-overrides.ts)
  'units:changed':        void;   // display-unit preference changed
  'lang:changed': { locale: SupportedLocale }; // language preference changed
  'map:ready':            void;   // style loaded, every layer added, filters applied
  'exp:dirty':            void;   // the user edited the view out of its experience
  'exp:ended':            void;   // the active experience was dismissed
  'url:write':            void;   // persist current state to URL / localStorage
  'undo:changed':         void;   // undo.ts: canUndo()/canRedo() may have changed
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
