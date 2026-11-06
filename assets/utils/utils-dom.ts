// ─── DOM helpers ─────────────────────────────────────────────────────────────
// Role: the loading indicator (hideLoading) and the element builders the route panel and its tabs share:
//       h(tag, cls?, text?) — text set when non-empty; ht(tag, cls, key) — the same with the translated
//       string and data-i18n, so a language switch re-translates it.
// Deps: src/i18n/index.ts (t).

import { t } from '../../src/i18n/index.js';

export function hideLoading() {
  document.getElementById("logo")?.classList.remove("spin");
}

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

/** A text element that follows the language: ui.ts's lang:changed handler re-runs updateDomTranslations over the page. */
export function ht<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, key: string): HTMLElementTagNameMap[K] {
  const e = h(tag, cls, t(key));
  e.dataset.i18n = key;
  return e;
}
