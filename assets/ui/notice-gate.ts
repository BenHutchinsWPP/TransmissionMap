// ─── Usage notices: the accept gate ──────────────────────────────────────────
// Role: whether the visitor has accepted the route planner's or the map chat's
//       usage notice. `noticeAccepted(id, v)` / `acceptNotice(id, v)` /
//       `forgetNotice(id)`. The chat notice is accepted once per browser and
//       version: localStorage `tm-notice-chat` holds the accepted version as a
//       string (a higher version asks everyone again); every storage access is
//       guarded, and when storage is blocked acceptance lasts for the page in
//       memory only. The route notice is asked every time the Route pane opens:
//       its acceptance lives in memory and ui-route.ts forgets it when the pane
//       closes. The notice text and dialog are notice-dialog.ts (lazy chunks only).
// Deps: none (boot-bundle safe).
// Consumed by ui-route.ts (openRoutePanel, routeForChat, dispose), ui-chat.ts, notice-dialog.ts.

export type NoticeId = 'route' | 'chat';
export const ROUTE_NOTICE_VERSION = 2;
/** Bump to ask every visitor to accept the chat notice again. */
export const CHAT_NOTICE_VERSION = 1;

const STORED: Record<NoticeId, boolean> = { route: false, chat: true };
const memory: Partial<Record<NoticeId, number>> = {};
const keyOf = (id: NoticeId) => `tm-notice-${id}`;

export function noticeAccepted(id: NoticeId, version: number): boolean {
  if ((memory[id] ?? 0) >= version) return true;
  if (!STORED[id]) return false;
  try {
    const v = Number(localStorage.getItem(keyOf(id)));
    return Number.isFinite(v) && v >= version;
  } catch { return false; }
}

export function acceptNotice(id: NoticeId, version: number): void {
  memory[id] = version;
  if (!STORED[id]) return;
  try { localStorage.setItem(keyOf(id), String(version)); } catch { /* memory holds it for this page */ }
}

/** Ask again next time: drops the page's acceptance (a stored chat acceptance stays). */
export function forgetNotice(id: NoticeId): void {
  delete memory[id];
}
