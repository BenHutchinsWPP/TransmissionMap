// ─── Tribal layer disclaimer ──────────────────────────────────────────────────
// Shown every time a tribal layer is enabled (no "acknowledged" persistence) and
// once on load when a shared URL arrives with one already on. On a first visit the
// site-wide disclaimer owns the screen, so we wait for it to close rather than
// stacking a second modal on top of it.
// Imported by: visibility.ts (setLayerVisibility), ui.ts (init).

export const TRIBAL_LAYER_IDS = ["tribal-lands", "bia-tribal-lands"];

export function showTribalDisclaimer() {
  const dlg = document.getElementById("tribalDisclaimerDialog") as HTMLDialogElement | null;
  if (!dlg || dlg.open) return;

  // Re-entering through this same function on close re-runs the dlg.open guard above,
  // so a double-enable can't call showModal() twice (which throws). addEventListener
  // also dedupes identical (type, listener) pairs, so the listener can't stack.
  const mainDlg = document.getElementById("disclaimerDialog") as HTMLDialogElement | null;
  if (mainDlg?.open) {
    mainDlg.addEventListener("close", showTribalDisclaimer, { once: true });
    return;
  }

  dlg.showModal();
}
