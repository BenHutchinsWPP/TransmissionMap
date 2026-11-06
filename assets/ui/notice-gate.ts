// ─── Usage notices: the accept-once gate ─────────────────────────────────────
// Role: whether the visitor has accepted the route planner's or the map chat's
//       usage notice, per browser and per notice version. `noticeAccepted(id, v)`
//       / `acceptNotice(id, v)` over localStorage `tm-notice-route` /
//       `tm-notice-chat` (each holds the accepted version as a string; a higher
//       version asks everyone again). Every storage access is guarded; when
//       storage is blocked, acceptance lasts for the page in memory only.
//       The notice text and dialog are notice-dialog.ts (lazy chunks only).
// Deps: none (boot-bundle safe).
// Consumed by ui-route.ts (openRoutePanel, routeForChat), ui-chat.ts.

export type NoticeId = 'route' | 'chat';
/** Bump a version to ask every visitor to accept that notice again. */
export const ROUTE_NOTICE_VERSION = 1;
export const CHAT_NOTICE_VERSION = 1;

const memory: Partial<Record<NoticeId, number>> = {};
const keyOf = (id: NoticeId) => `tm-notice-${id}`;

export function noticeAccepted(id: NoticeId, version: number): boolean {
  if ((memory[id] ?? 0) >= version) return true;
  try {
    const v = Number(localStorage.getItem(keyOf(id)));
    return Number.isFinite(v) && v >= version;
  } catch { return false; }
}

export function acceptNotice(id: NoticeId, version: number): void {
  memory[id] = version;
  try { localStorage.setItem(keyOf(id), String(version)); } catch { /* memory holds it for this page */ }
}
