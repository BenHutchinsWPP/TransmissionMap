// ─── 3D rotate/tilt hint toast ─────────────────────────────────────────────────
// One-time, non-blocking tip shown the first time either 3D toggle (terrain or
// buildings) turns on — explains the rotate/tilt gesture. The toggles already
// carry a hover `title` with the same info, but that's invisible on touch and
// easy to miss on desktop. Shown at most once ever (localStorage), auto-dismisses.
// Called from: ui/ui.ts (checkbox change) and terrain.ts (apply3dFromState — a
// shared 3D link restores the toggle without firing a change event).
// No deps beyond the DOM — deliberately not a <dialog> like the site's
// consent/staleness modals; this is a dismissible tip, not something to block on.

const SEEN_KEY = "tm_3d_hint_seen";
const AUTO_DISMISS_MS = 7000;

let dismissTimer: ReturnType<typeof setTimeout> | null = null;

function dismiss() {
  if (dismissTimer) { clearTimeout(dismissTimer); dismissTimer = null; }
  document.getElementById("rotateHintToast")?.setAttribute("hidden", "");
}

export function maybeShowRotateHint() {
  if (localStorage.getItem(SEEN_KEY)) return;
  const toast = document.getElementById("rotateHintToast");
  if (!toast) return;
  localStorage.setItem(SEEN_KEY, "1");
  toast.removeAttribute("hidden");
  dismissTimer = setTimeout(dismiss, AUTO_DISMISS_MS);
  document.getElementById("rotateHintDismiss")?.addEventListener("click", dismiss, { once: true });
}
