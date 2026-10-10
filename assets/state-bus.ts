// assets/state-bus.ts — typed pub/sub for coordinating state mutations.
// Emitters write state then emit; subscribers react (repaint panels, write URL).
// No circular deps: this file imports only types.
// Each handler runs in its own try/catch: a throw is rethrown in a microtask (so window
// `error` handlers see it) and the remaining handlers and the emitter carry on.

import type { SupportedLocale } from '../src/i18n/types.js';

type Events = {
  'layer:visibility': { id: string; visible: boolean }; // setLayerVisibility() switched a layer
  'layer:data':       { id: string };  // a GeoJSON source's features landed in state.sourcesData (layer-data.ts load,
                                       // live-staleness.ts auto-refresh); id is the GeoJSON source id (a registry id
                                       // after LAYER_SOURCE_ALIAS, or a source-only id such as weather-admin-lines)
  'view:applied':         void;   // view-state.ts applyView() finished — resync panels + controls
  'style:weather':        void;   // the weather wash's opacity override changed (style-overrides.ts)
                                  // bus: weather-live imports style-overrides, so a direct call would be a cycle
  'units:changed':        void;   // display-unit preference changed
                                  // bus: emitter ui-settings is a lazy chunk
  'lang:changed': { locale: SupportedLocale }; // language preference changed
  'map:ready':            void;   // style loaded, every layer added, filters applied
  'exp:dirty':            void;   // the user edited the view out of its experience
  'exp:ended':            void;   // the active experience was dismissed
                                  // exp:*: subscriber ui-experiences is a lazy chunk and imports both emitters (a cycle)
  'url:write':            void;   // persist current state to URL / localStorage
  'undo:changed':         void;   // undo.ts: canUndo()/canRedo() may have changed
                                  // bus: ui-menubar imports undo, so a direct call would be a cycle
};

type Handler<K extends keyof Events> = (payload: Events[K]) => void;

const subs = new Map<string, Set<(p: unknown) => void>>();

export function on<K extends keyof Events>(event: K, fn: Handler<K>): void {
  if (!subs.has(event)) subs.set(event, new Set());
  subs.get(event)!.add(fn as (p: unknown) => void);
}

export function emit<K extends keyof Events>(event: K, ...args: Events[K] extends void ? [] : [Events[K]]): void {
  const payload = args[0];
  subs.get(event)?.forEach(fn => {
    try { fn(payload as unknown); } catch (e) { queueMicrotask(() => { throw e; }); }
  });
}
