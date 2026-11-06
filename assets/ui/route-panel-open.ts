// ─── Route planner entry points (boot bundle, dev server only) ───────────────
// The Tools ▸ "Plan a route…" item and the map's right-click "Route from/to
// here" menu (the app's .dropdown card; its sizes inline, so the boot CSS carries no route rule). The routing cube exists only on the dev server, so in a build
// ROUTE_ENABLED is false and nothing is registered; ui-route.ts loads on use,
// behind the same flag, so a build emits no route-panel or route-worker chunk.
// planRouteFromChat is the map chat's way in (the planRoute tool): it refuses in a
// build and otherwise hands the request to ui-route.ts's routeForChat.
// The route strings (src/i18n/route/) load beside the chunk, before either entry runs.
// Deps: state.ts, map-input.ts (onMapContextMenu), diag-log.ts, i18n (t, loadRouteStrings), ui-route.ts (dynamic),
//       route-tabs/chat-summary.ts and dataset-query.ts (types only).
import { state } from '../state.js';
import { onMapContextMenu } from '../map-input.js';
import { t, loadRouteStrings } from '../../src/i18n/index.js';
import { recordDiagEvent } from '../diag-log.js';
import type { Outcome } from '../dataset-query.js';
import type { RouteSummary } from './route-tabs/chat-summary.js';

export const ROUTE_ENABLED = import.meta.env.DEV;

type End = 'A' | 'B';

/** The chat's route request: substation names or [lng, lat] for both ends, or neither (recall the shown route). */
export interface ChatRouteRequest { from?: string | [number, number]; to?: string | [number, number]; lineType?: string; alternatives?: number }

export async function planRouteFromChat(req: ChatRouteRequest, signal?: AbortSignal): Promise<Outcome<RouteSummary>> {
  if (!ROUTE_ENABLED) return { ok: false, reason: 'routing is available on the dev server only' };
  let m: typeof import('./ui-route.js');
  try { [m] = await Promise.all([import('./ui-route.js'), loadRouteStrings()]); } catch (err) {
    recordDiagEvent('map', `route panel failed to load: ${err instanceof Error ? err.message : String(err)}`);
    return { ok: false, reason: 'the route planner could not be loaded' };
  }
  return m.routeForChat(req, signal);
}

let menu: HTMLElement | null = null;

function closeMenu(): void {
  menu?.remove();
  menu = null;
}

function openPanel(at?: { lngLat: [number, number]; end: End }): void {
  if (!ROUTE_ENABLED) return;   // a build then loads neither ui-route.ts nor the route worker
  void Promise.all([import('./ui-route.js'), loadRouteStrings()]).then(([m]) => m.openRoutePanel(at))
    .catch((err) => recordDiagEvent('map', `route panel failed to load: ${err instanceof Error ? err.message : String(err)}`));
}

function toolActive(): boolean {
  return state.measure.active || state.editMode === 'edit' || state.routePick;
}

function showMenu(x: number, y: number, lngLat: [number, number]): void {
  closeMenu();
  const el = document.createElement('div');
  // The app's card (.dropdown) and item (.menu-item: hover) styles; placement and touch-size rows inline,
  // so no rule for this dev-only menu ships in the boot CSS.
  el.className = 'dropdown menu-dropdown';
  el.setAttribute('role', 'menu');
  el.style.cssText = `position:fixed;left:${Math.min(x, innerWidth - 200)}px;top:${Math.min(y, innerHeight - 110)}px;z-index:1000;min-width:180px`;
  const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  const items: HTMLButtonElement[] = [];
  for (const [end, key] of [['A', 'route.ctxFrom'], ['B', 'route.ctxTo']] as const) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'menu-item';
    b.setAttribute('role', 'menuitem');
    b.textContent = t(key);
    b.style.cssText = `min-height:${coarse ? 44 : 32}px;outline-offset:-2px`;
    b.addEventListener('click', () => { closeMenu(); openPanel({ lngLat, end }); });
    items.push(b);
    el.append(b);
  }
  el.addEventListener('keydown', (e) => {
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); items[(i + 1) % 2].focus(); }
  });
  document.body.append(el);
  menu = el;
  items[0].focus({ preventScroll: true });
}

export function initRoutePanelEntry(): void {
  if (ROUTE_ENABLED) wireRouteEntry();
}

/** Exported for tests; in a build only the dead branch above names it, so it is dropped. */
export function wireRouteEntry(): void {
  const item = document.createElement('button');
  item.className = 'menu-item';
  item.type = 'button';
  item.dataset.i18n = 'route.menu';
  item.textContent = t('route.menu');
  item.addEventListener('click', () => {
    const dropdown = item.closest<HTMLElement>('.menu-dropdown');
    dropdown?.setAttribute('hidden', '');
    dropdown?.previousElementSibling?.setAttribute('aria-expanded', 'false');
    openPanel();
  });
  document.querySelector('.menu-dropdown [data-action=open-diagnostics]')?.before(item);

  onMapContextMenu((e) => {
    closeMenu();
    if (toolActive()) return;
    showMenu(e.originalEvent.clientX, e.originalEvent.clientY, [e.lngLat.lng, e.lngLat.lat]);
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });
  document.addEventListener('pointerdown', (e) => {
    if (menu && !menu.contains(e.target as Node)) closeMenu();
  }, true);
  state.map?.on('movestart', closeMenu);
}
