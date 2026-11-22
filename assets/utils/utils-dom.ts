// ─── DOM helpers ─────────────────────────────────────────────────────────────
// Role: the loading indicator (hideLoading) and the shared element builders:
//       h(tag, cls?, text?) — text set when non-empty; ht(tag, cls, key) — the same with the translated
//       string and data-i18n, so a language switch re-translates it; hx(tag, attrs, ...kids) — attributes
//       and text/Node children, null/false/undefined kids skipped. Children are text only, never parsed
//       as HTML; attributes are set as given, so never pass model or remote text as href/src/srcdoc/on*.
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

/** An element with attributes (`class` through className) and children; a null, false or undefined child is skipped. */
export function hx<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  ...kids: (string | Node | null | false | undefined)[]
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v; else e.setAttribute(k, v);
  }
  for (const c of kids) if (c != null && c !== false) e.append(c);
  return e;
}
