// ─── Proximity rows: the pure view model behind the Proximity grids ──────────
// Role: which rows the Groups and Pairs grids show and in what order (a contains-filter per column,
//       then a stable sort over typed key arrays), the range as tab-separated text, and the cached
//       locale collation and number formatting that keep a million pairs affordable. No DOM, no
//       Tabulator, no i18n: the grid only renders. Nothing here stores or logs a value.
// Deps: grid-copy.ts (clipValue, tsvOf). Used by: ui-proximity.ts.

import { clipValue, tsvOf } from './grid-copy.js';

/** A column over row indices k (a group's or a pair's index). A pairs column that shows a point's
 *  field sets `point`: its filter then runs once per point and the result maps to the pairs. */
export interface ProxCol {
  field: string;
  title: string;
  num: boolean;
  text(k: number): string;            // display text (what the cell shows)
  value(k: number): string | number;  // raw value: copy (clipValue) and number sort
  rank?(k: number): number;           // text sort key (from rankOf); negative = empty; else collator on text
  point?: { count: number; of(k: number): number; text(p: number): string; value(p: number): string | number };
}
export type Sort = { field: string; dir: 1 | -1 } | null;

const formats = new Map<string, Intl.NumberFormat>();
/** One formatter per locale and fraction digits, built on first use. */
export function numberFormat(locale: string, digits: number): Intl.NumberFormat {
  const key = `${locale}|${digits}`;
  let f = formats.get(key);
  if (!f) { f = new Intl.NumberFormat(locale, { minimumFractionDigits: digits, maximumFractionDigits: digits }); formats.set(key, f); }
  return f;
}

/** Point → rank by locale collation (numeric, base sensitivity); equal texts share a rank, empty text is -1. */
export function rankOf(n: number, text: (i: number) => string, locale: string): Int32Array {
  const col = new Intl.Collator(locale, { numeric: true, sensitivity: 'base' });
  const texts: string[] = new Array(n);
  const order: number[] = [];
  for (let i = 0; i < n; i++) { texts[i] = text(i); if (texts[i] !== '') order.push(i); }
  order.sort((a, b) => col.compare(texts[a], texts[b]) || a - b);
  const out = new Int32Array(n).fill(-1);
  let r = -1;
  for (let j = 0; j < order.length; j++) {
    if (j === 0 || col.compare(texts[order[j]], texts[order[j - 1]]) !== 0) r++;
    out[order[j]] = r;
  }
  return out;
}

const has = (hay: string, q: string) => hay.toLowerCase().includes(q);
const hits = (text: string, value: string | number, q: string) => has(text, q) || (typeof value === 'number' ? has(String(value), q) : has(value, q));

/** Base order, filtered (every filter must match; contains, case-insensitive, on the cell's text or raw
 *  value), then stably sorted; ties keep base order, empty and NaN go last either way, no sort keeps base order. */
export function viewOrder(base: Int32Array, cols: ProxCol[], sort: Sort, filters: ReadonlyMap<string, string>): Int32Array {
  let rows = base;
  for (const [field, raw] of filters) {
    const q = raw.trim().toLowerCase();
    const c = q ? cols.find(x => x.field === field) : undefined;
    if (!c) continue;
    const keep = new Int32Array(rows.length);
    let m = 0;
    if (c.point) {
      const pt = c.point, ok = new Uint8Array(pt.count);
      for (let p = 0; p < pt.count; p++) ok[p] = hits(pt.text(p), pt.value(p), q) ? 1 : 0;
      for (let i = 0; i < rows.length; i++) if (ok[pt.of(rows[i])]) keep[m++] = rows[i];
    } else {
      for (let i = 0; i < rows.length; i++) { const k = rows[i]; if (hits(c.text(k), c.value(k), q)) keep[m++] = k; }
    }
    rows = keep.subarray(0, m);
  }
  const sc = sort && cols.find(x => x.field === sort.field);
  if (!sc || !sort) return rows === base ? base : rows.slice();
  const n = rows.length, keys = new Float64Array(n);
  if (sc.num) {
    for (let i = 0; i < n; i++) { const v = sc.value(rows[i]); keys[i] = typeof v === 'number' && Number.isFinite(v) ? v : NaN; }
  } else if (sc.rank) {
    for (let i = 0; i < n; i++) { const r = sc.rank(rows[i]); keys[i] = r < 0 ? NaN : r; }
  } else {
    const texts: string[] = new Array(n), ix: number[] = [];
    for (let i = 0; i < n; i++) { texts[i] = sc.text(rows[i]); keys[i] = NaN; if (texts[i] !== '') ix.push(i); }
    const col = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
    ix.sort((a, b) => col.compare(texts[a], texts[b]) || a - b);
    let r = -1;
    for (let j = 0; j < ix.length; j++) {
      if (j === 0 || col.compare(texts[ix[j]], texts[ix[j - 1]]) !== 0) r++;
      keys[ix[j]] = r;
    }
  }
  const pos = new Int32Array(n);
  for (let i = 0; i < n; i++) pos[i] = i;
  const d = sort.dir;
  pos.sort((a, b) => {
    const x = keys[a], y = keys[b];
    if (x !== x) return y !== y ? a - b : 1;
    if (y !== y) return -1;
    return x === y ? a - b : x < y ? -d : d;
  });
  const out = new Int32Array(n);
  for (let i = 0; i < n; i++) out[i] = rows[pos[i]];
  return out;
}

/** The range as TSV: titles and cells go through clipValue (raw values, formula-guarded). */
export function rangeTsvOf(cols: ProxCol[], rows: number[]): string {
  return tsvOf(cols.map(c => String(clipValue(c.title))), rows.map(k => cols.map(c => clipValue(c.value(k)))));
}
