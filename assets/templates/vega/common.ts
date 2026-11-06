// ─── Shared pieces of the Vega-Lite template builders ───────────────────────
// Role: what the Vega-Lite builders (composition, ranking, timeline,
//       compare-regions, distribution) have in common, so they read alike:
//         layoutWidth()      the room a card has, in px, read from the chat
//                            pane (the page builds the spec, the frame cannot
//                            tell it); a fixed fallback without a DOM. A
//                            concat spec is not fitted by the frame, so the
//                            builders size every view from this number.
//         compact(n, loc)    a number as "1.2K" / "3.4M" in the locale
//         full(n, loc)       the same, in full, for a tooltip
//         percent(x, loc)    a 0..1 share as "12.3%"
//         wrap(text, chars)  a title as lines of ≤ chars characters (≤ 3 lines)
//         titleChars / subtitleChars / wrapLines  how much text a line of this width holds
//         head(p, width, total, groups, notes?)  the spec's title: the payload's
//                            title and, under it, "Total …", "Groups: n" and a line of notes
//         empty(p, width)    the spec for a payload with nothing to draw: the
//                            title and one "nothing to show" line
//         CONFIG             one look for them all (fonts, no frame stroke)
//         uniqueLabels(ls)   display labels made unique
//         colourOf(g)        a group's colour, with grey for the fold and light grey for "(none)"
//         groupLabels(gs)    the labels of ranked groups, a folded "Other" kept apart from a legend's
//         binLabels(edges, loc)  each bin as "lo–hi" (whole numbers in full, the rest compact)
//         edgeText(v, whole, loc)  one edge or value as binLabels writes it
//         monthText(key, loc)  a "YYYY-MM" month as "Mar 2025" in the locale
//       Every string is a payload label (page-translated) or a `template.*`
//       key through t(); no model text reaches a spec except the checked title.
//
// Deps: payload.ts (types), i18n (t).

import type { TemplatePayload } from '../payload.js';
import { t } from '../../../src/i18n/index.js';

export const FALLBACK_WIDTH = 640;
export const MIN_WIDTH = 260;
export const MAX_WIDTH = 920;
const CARD_MAX = 720;

/** An axis labelExpr: SI-compact tick labels, a plain 0. */
export const SI = "datum.value == 0 ? '0' : format(datum.value, '~s')";

export const INK = '#1f2937';
export const MUTED = '#6b7280';
export const GRID = '#e5e7eb';
export const BAR = '#4e79a7';

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/** The room for a chart in the chat card, in px. */
export function layoutWidth(): number {
  try {
    if (typeof document === 'undefined') return FALLBACK_WIDTH;
    const host = document.querySelector('.chat-log') ?? document.querySelector('.table-drawer');
    const w = host?.clientWidth || (typeof window !== 'undefined' ? window.innerWidth : 0);
    // A card is at most CARD_MAX wide (style.css .chat-log > *) inside the log's
    // padding; its border, padding and the frame's box and scrollbar take ~50 px.
    return w ? clamp(Math.min(CARD_MAX, w - 24) - 50, MIN_WIDTH, MAX_WIDTH) : FALLBACK_WIDTH;
  } catch {
    return FALLBACK_WIDTH;
  }
}

const locOf = (p: Pick<TemplatePayload, 'labels'>) => p.labels.locale || 'en';

export function compact(n: number, loc: string): string {
  try {
    return new Intl.NumberFormat(loc, { notation: 'compact', maximumSignificantDigits: 3 }).format(n);
  } catch { return String(Math.round(n * 100) / 100); }
}

export function full(n: number, loc: string): string {
  try { return new Intl.NumberFormat(loc, { maximumFractionDigits: 2 }).format(n); } catch { return String(n); }
}

export function percent(x: number, loc: string): string {
  try { return new Intl.NumberFormat(loc, { style: 'percent', maximumFractionDigits: x < 0.1 ? 1 : 0 }).format(x); } catch { return `${Math.round(x * 100)}%`; }
}

/** `text` as lines of at most `chars` characters, broken at spaces. */
export function wrap(text: string, chars: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    if (cur && (cur + ' ' + w).length > chars) { lines.push(cur); cur = w; } else cur = cur ? cur + ' ' + w : w;
  }
  if (cur) lines.push(cur);
  return lines.slice(0, 3).map(l => (l.length > chars + 12 ? l.slice(0, chars + 11) + '…' : l));
}

/** Display labels made unique: a second "Other" becomes "Other (2)". */
export function uniqueLabels(labels: readonly string[]): string[] {
  const seen = new Map<string, number>();
  return labels.map(l => {
    const n = (seen.get(l) ?? 0) + 1;
    seen.set(l, n);
    return n === 1 ? l : `${l} (${n})`;
  });
}

/** Display labels for ranked groups: unique, and a folded "Other" told apart from a legend bucket that is itself called Other. */
export function groupLabels(groups: readonly { label: string; other?: true }[]): string[] {
  const names = groups.map(g => g.label);
  const last = groups[groups.length - 1];
  if (last?.other && names.slice(0, -1).includes(last.label)) names[names.length - 1] = t('template.smaller');
  return uniqueLabels(names);
}

/** An edge for a bin label: whole numbers in full (years, kV), the rest compact. */
export function edgeText(v: number, whole: boolean, loc: string): string {
  return whole && Math.abs(v) < 1e5 ? String(v) : compact(v, loc);
}

/** Each bin [edges[i], edges[i + 1]) as "lo–hi". */
export function binLabels(edges: readonly number[], loc: string): string[] {
  const whole = edges.every(Number.isInteger);
  return edges.slice(0, -1).map((e, i) => `${edgeText(e, whole, loc)}–${edgeText(edges[i + 1], whole, loc)}`);
}

/** A "YYYY-MM" month in the locale ("Mar 2025"); the key itself when it is not one. */
export function monthText(key: string, loc: string): string {
  const m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(key);
  if (!m) return key;
  try { return new Intl.DateTimeFormat(loc, { month: 'short', year: 'numeric', timeZone: 'UTC' }).format(Date.UTC(Number(m[1]), Number(m[2]) - 1, 1)); } catch { return key; }
}

/** A group's colour: its own, the grey of "Other" for the fold, a lighter one for "(none)". */
export function colourOf(g: { key: string | number | null; colour: string; other?: true }): string {
  return g.other ? '#9ca3af' : g.key === null ? '#d1d5db' : g.colour;
}

export const CONFIG = {
  background: '#ffffff',
  font: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  view: { stroke: null },
  axis: { labelFontSize: 11, titleFontSize: 11, labelColor: INK, titleColor: MUTED, domainColor: GRID, tickColor: GRID, gridColor: GRID },
  legend: { labelFontSize: 11, titleFontSize: 11, labelColor: INK, titleColor: MUTED, symbolType: 'square' },
  title: { fontSize: 14, subtitleFontSize: 11, subtitleColor: MUTED, color: INK, anchor: 'start', fontWeight: 600 },
  text: { color: INK, fontSize: 11 },
};

/** Characters that fit a title / subtitle line of `width` px (14 px semi-bold / 11 px). */
export const titleChars = (width: number) => Math.max(20, Math.floor(width / 8.6));
export const subtitleChars = (width: number) => Math.max(28, Math.floor(width / 5.9));
/** Each text as wrapped lines, one list. */
export const wrapLines = (texts: readonly string[], chars: number) => texts.flatMap(x => wrap(x, chars));

/** The spec's title: the payload's, wrapped to `width`, with the total and the group count under it. */
export function head(p: TemplatePayload, width: number, total: number, groups: number, notes: readonly string[] = []): Record<string, unknown> {
  const loc = locOf(p);
  const unit = p.roles.measure.unit && p.roles.measure.name !== 'count' ? ` ${p.roles.measure.unit}` : '';
  const sub = [t('template.total', { value: compact(total, loc) + unit }), ...(groups > 0 ? [t('template.groupsN', { n: groups })] : [])].join('  ·  ');
  return { text: wrap(p.labels.title ?? '', titleChars(width)), subtitle: wrapLines([sub, ...(notes.length ? [notes.join('  ·  ')] : [])], subtitleChars(width)), ...CONFIG.title, subtitleColor: MUTED, offset: 8 };
}

/** The spec for a payload with nothing to draw. */
export function empty(p: TemplatePayload, width: number): Record<string, unknown> {
  return {
    description: p.labels.summary ?? p.labels.title ?? '',
    title: { text: wrap(p.labels.title ?? '', titleChars(width)), ...CONFIG.title },
    data: { values: [{ m: t('template.noData') }] },
    width, height: 60,
    mark: { type: 'text', align: 'left', baseline: 'middle', color: MUTED, fontSize: 12, x: 0, y: 30 },
    encoding: { text: { field: 'm', type: 'nominal' } },
    config: CONFIG,
  };
}
