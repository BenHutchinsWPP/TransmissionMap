// ─── Chat charts: a checked chart spec drawn on a canvas (chat chunk) ────────
// Role: chartCard(chart) → the card ui-chat.ts puts in the conversation for an
//       runAnalysis call made with `chart` (or a restored card): the title, the chart
//       (bar: horizontal bars, grouped per series; line: one 2 px line per
//       series on a y axis with ticks; pie: slices with a legend giving each
//       share), a "partial" note when the data was not all read, and PNG / CSV
//       downloads. The spec has passed chart-spec.ts validateChart; every
//       label is drawn with fillText or set as textContent, never as HTML
//       (eslint holds this file to the chat's text-only rule). One draw()
//       serves the card (redrawn at its width by a ResizeObserver, at the
//       device pixel ratio) and the PNG (880 px wide at 2×, white, with the
//       title and the legend in the image). Hovering a mark sets the canvas
//       tooltip to its label and value. Colours: the spec's per-category
//       colours (fuel rows) when given, else a fixed eight-hue categorical
//       order (never cycled: the caps in chart-spec.ts keep within it);
//       "Other" is grey.
//       Strings: data-chat-key, so ui-chat.ts's lang:changed handler
//       re-translates them.
//
// Deps: chart-spec.ts (Chart, chartCsv), user-data-export.ts (downloadFile),
//       i18n (t, getLocale).
// Loaded by: ui-chat.ts (in the chat chunk).

import { chartCsv, type Chart } from '../chart-spec.js';
import { downloadFile } from '../user-data/user-data-export.js';
import { t, getLocale } from '../../src/i18n/index.js';

const PALETTE = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948'];
const GREY = '#9ca3af';
const INK = '#0f172a';
const MUTED = '#6b7280';
const GRID = '#e5e7eb';
const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
const PNG_W = 880;

type Hit = { label: string; rect?: [number, number, number, number]; wedge?: [number, number, number, number, number] };

const fmt = (n: number, compact = false) => n.toLocaleString(getLocale(),
  compact ? { notation: 'compact', maximumFractionDigits: 1 } : { maximumFractionDigits: Math.abs(n) >= 100 ? 0 : Math.abs(n) >= 1 ? 1 : 3 });
const withUnit = (c: Chart, n: number, compact = false) => fmt(n, compact) + (c.unit ? ` ${c.unit}` : '');

/** The colour of category `i` of series `j`. */
function colorOf(c: Chart, i: number, j: number): string {
  if (c.type === 'line' || c.series.length > 1) return PALETTE[j % PALETTE.length];
  if (c.colors) return c.colors[i];
  if (c.type === 'bar') return PALETTE[0];
  return c.categories[i] === t('chart.other') ? GREY : PALETTE[i % PALETTE.length];
}

/** Legend entries: a pie's slices, or the series when there are several. */
function legendOf(c: Chart): { label: string; color: string }[] {
  if (c.type === 'pie') {
    const vals = c.series[0].values;
    const total = vals.reduce((s, v) => s + v, 0);
    return c.categories.map((cat, i) => ({ label: `${cat} · ${(vals[i] / total * 100).toLocaleString(getLocale(), { maximumFractionDigits: 1 })} % (${withUnit(c, vals[i])})`, color: colorOf(c, i, 0) }));
  }
  return c.series.length > 1 ? c.series.map((s, j) => ({ label: s.name, color: colorOf(c, 0, j) })) : [];
}

const clipText = (g: CanvasRenderingContext2D, s: string, w: number) => {
  if (g.measureText(s).width <= w) return s;
  let lo = 0, hi = s.length;
  while (lo < hi) { const m = (lo + hi + 1) >> 1; if (g.measureText(s.slice(0, m) + '…').width <= w) lo = m; else hi = m - 1; }
  return s.slice(0, lo) + '…';
};

/** Legend rows laid out over `w` px: [label, colour, x, row][]. */
function legendLayout(g: CanvasRenderingContext2D, items: { label: string; color: string }[], w: number, oneColumn: boolean) {
  g.font = `12px ${FONT}`;
  const out: [string, string, number, number][] = [];
  let x = 0, row = 0;
  for (const it of items) {
    const label = clipText(g, it.label, w - 16);
    const iw = 16 + g.measureText(label).width + 14;
    if (x > 0 && (oneColumn || x + iw > w)) { x = 0; row++; }
    out.push([label, it.color, x, row]);
    x += iw;
  }
  return { items: out, rows: items.length ? row + 1 : 0 };
}

const LEG_ROW = 18;

/** The canvas height a chart wants at width `w` (CSS px), title excluded. */
export function heightFor(c: Chart, w: number): number {
  if (c.type === 'pie') return w >= 420 ? 220 : 2 * Math.min(90, w / 2 - 12) + 36 + legendOf(c).length * LEG_ROW;
  const leg = c.series.length > 1 ? Math.ceil(c.series.length / Math.max(1, Math.floor(w / 140))) * LEG_ROW + 8 : 0;
  if (c.type === 'line') return 220 + leg;
  const rows = c.categories.length * Math.max(1, c.series.length);
  return Math.min(440, Math.max(120, 16 + rows * (c.series.length > 1 ? 10 : 22) + c.categories.length * (c.series.length > 1 ? 6 : 0))) + leg;
}

/** Draw `c` into `g` over W×H CSS px; returns the marks' hit areas. */
function draw(g: CanvasRenderingContext2D, c: Chart, W: number, H: number, title: boolean): Hit[] {
  const hits: Hit[] = [];
  let top = 4;
  g.textBaseline = 'middle';
  if (title) {
    g.font = `600 15px ${FONT}`;
    g.fillStyle = INK;
    g.textAlign = 'left';
    g.fillText(clipText(g, c.title, W - 24), 12, 18);
    top = 40;
  }
  const left = 12, right = W - 12;
  const items = legendOf(c);
  if (c.type === 'pie') {
    const side = W >= 420;
    const r = Math.min(side ? (H - top - 16) / 2 : 90, (side ? W * 0.4 : W) / 2 - 12);
    const cx = side ? left + r + 8 : W / 2, cy = top + 8 + r;
    const vals = c.series[0].values;
    const total = vals.reduce((s, v) => s + v, 0);
    let a = -Math.PI / 2;
    vals.forEach((v, i) => {
      const da = v / total * Math.PI * 2;
      g.beginPath(); g.moveTo(cx, cy); g.arc(cx, cy, r, a, a + da); g.closePath();
      g.fillStyle = colorOf(c, i, 0); g.fill();
      g.strokeStyle = '#ffffff'; g.lineWidth = 2; g.stroke();
      hits.push({ label: items[i].label, wedge: [cx, cy, r, a, a + da] });
      a += da;
    });
    const lx = side ? cx + r + 24 : left, lw = side ? right - lx : right - left;
    const lay = legendLayout(g, items, lw, true);
    const ly = side ? Math.max(top + 8, cy - lay.rows * LEG_ROW / 2) : cy + r + 16;
    drawLegend(g, lay.items, lx, ly);
    return hits;
  }
  // Legend (several series) above the plot.
  if (items.length) {
    const lay = legendLayout(g, items, right - left, false);
    drawLegend(g, lay.items, left, top + 6);
    top += lay.rows * LEG_ROW + 8;
  }
  const all = c.series.flatMap(s => s.values);
  const lo = Math.min(0, ...all), hi = Math.max(0, ...all);
  if (c.type === 'bar') return drawBars(g, c, hits, left, right, top, H, lo, hi);
  return drawLine(g, c, hits, left, right, top, H, lo, hi);
}

function drawLegend(g: CanvasRenderingContext2D, items: [string, string, number, number][], x0: number, y0: number) {
  g.font = `12px ${FONT}`;
  g.textAlign = 'left';
  for (const [label, color, x, row] of items) {
    const y = y0 + row * LEG_ROW;
    g.fillStyle = color; g.fillRect(x0 + x, y - 5, 10, 10);
    g.fillStyle = INK; g.fillText(label, x0 + x + 16, y);
  }
}

function drawBars(g: CanvasRenderingContext2D, c: Chart, hits: Hit[], left: number, right: number, top: number, H: number,
  lo: number, hi: number): Hit[] {
  const n = c.categories.length, ns = c.series.length;
  const band = (H - top - 6) / n;
  const fs = Math.max(9, Math.min(12, band * 0.6));
  g.font = `${fs}px ${FONT}`;
  const labW = Math.min((right - left) * 0.35, Math.max(...c.categories.map(s => g.measureText(s).width)) + 8);
  const valW = ns === 1 ? Math.min(90, Math.max(...c.series[0].values.map(v => g.measureText(withUnit(c, v)).width)) + 8) : 0;
  const x0 = left + labW, x1 = right - valW;
  const sx = (v: number) => x0 + (v - lo) / ((hi - lo) || 1) * (x1 - x0);
  const zero = sx(0);
  for (let i = 0; i < n; i++) {
    const y = top + i * band;
    g.fillStyle = INK; g.textAlign = 'right';
    g.fillText(clipText(g, c.categories[i], labW - 8), x0 - 6, y + band / 2);
    const bh = Math.max(1, (band - 2) / ns - (ns > 1 ? 1 : 0));
    c.series.forEach((s, j) => {
      const v = s.values[i];
      const a = sx(Math.min(0, v)), b = sx(Math.max(0, v));
      const by = y + 1 + j * (bh + (ns > 1 ? 1 : 0));
      g.fillStyle = colorOf(c, i, j);
      g.fillRect(a, by, Math.max(1, b - a), bh);
      hits.push({ label: `${c.categories[i]}${ns > 1 ? ` · ${s.name}` : ''}: ${withUnit(c, v)}`, rect: [a, by, Math.max(4, b - a), bh] });
      if (ns === 1 && band >= 10) {
        g.fillStyle = MUTED; g.textAlign = 'left';
        g.fillText(withUnit(c, v), b + 4, by + bh / 2);
      }
    });
  }
  g.strokeStyle = MUTED; g.lineWidth = 1;
  g.beginPath(); g.moveTo(zero + 0.5, top); g.lineTo(zero + 0.5, H - 4); g.stroke();
  return hits;
}

/** About five round tick values over [lo, hi]. */
export function ticks(lo: number, hi: number): number[] {
  if (hi === lo) return [lo];
  const raw = (hi - lo) / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => s >= raw)!;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) out.push(Math.round(v / step) * step);
  return out;
}

function drawLine(g: CanvasRenderingContext2D, c: Chart, hits: Hit[], left: number, right: number, top: number, H: number,
  lo: number, hi: number): Hit[] {
  const tk = ticks(lo, hi);
  const ylo = Math.min(lo, tk[0]), yhi = Math.max(hi, tk.at(-1)!);
  g.font = `11px ${FONT}`;
  const axW = Math.max(...tk.map(v => g.measureText(fmt(v, true)).width)) + 8;
  const x0 = left + axW, x1 = right - 8, y0 = top + (c.unit ? 22 : 6), y1 = H - 22;
  const sy = (v: number) => y1 - (v - ylo) / ((yhi - ylo) || 1) * (y1 - y0);
  const n = c.categories.length;
  const sx = (i: number) => (n === 1 ? (x0 + x1) / 2 : x0 + i / (n - 1) * (x1 - x0));
  g.textAlign = 'right';
  for (const v of tk) {
    g.strokeStyle = v === 0 ? MUTED : GRID; g.lineWidth = 1;
    g.beginPath(); g.moveTo(x0, Math.round(sy(v)) + 0.5); g.lineTo(x1, Math.round(sy(v)) + 0.5); g.stroke();
    g.fillStyle = MUTED; g.fillText(fmt(v, true), x0 - 6, sy(v));
  }
  if (c.unit) { g.textAlign = 'left'; g.fillText(c.unit, left, top + 6); }
  // x labels: every k-th, so none overlap.
  const widest = Math.max(...c.categories.map(s => g.measureText(s).width)) + 10;
  const k = Math.max(1, Math.ceil(widest / ((x1 - x0) / Math.max(1, n - 1))));
  g.textAlign = 'center'; g.fillStyle = MUTED;
  for (let i = 0; i < n; i += k) g.fillText(clipText(g, c.categories[i], widest * k), sx(i), y1 + 12);
  c.series.forEach((s, j) => {
    g.strokeStyle = colorOf(c, 0, j); g.lineWidth = 2; g.lineJoin = 'round';
    g.beginPath();
    s.values.forEach((v, i) => (i ? g.lineTo(sx(i), sy(v)) : g.moveTo(sx(i), sy(v))));
    g.stroke();
    s.values.forEach((v, i) => {
      if (n <= 24) { g.fillStyle = colorOf(c, 0, j); g.beginPath(); g.arc(sx(i), sy(v), 3, 0, Math.PI * 2); g.fill(); }
      hits.push({ label: `${c.categories[i]}${c.series.length > 1 ? ` · ${s.name}` : ''}: ${withUnit(c, v)}`, rect: [sx(i) - 6, sy(v) - 6, 12, 12] });
    });
  });
  return hits;
}

function hitAt(hits: Hit[], x: number, y: number): Hit | undefined {
  return hits.find(h => {
    if (h.rect) { const [a, b, w, hh] = h.rect; return x >= a && x <= a + w && y >= b && y <= b + hh; }
    const [cx, cy, r, a0, a1] = h.wedge!;
    if (Math.hypot(x - cx, y - cy) > r) return false;
    let a = Math.atan2(y - cy, x - cx);
    while (a < a0) a += Math.PI * 2;
    return a <= a1;
  });
}

/** A file name from the chart's title. */
export function fileName(title: string, ext: string): string {
  const base = title.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  return `${base || 'chart'}.${ext}`;
}

function savePng(c: Chart) {
  const h = heightFor(c, PNG_W) + 48;
  const cv = document.createElement('canvas');
  cv.width = PNG_W * 2; cv.height = h * 2;
  const g = cv.getContext('2d');
  if (!g) return;
  g.scale(2, 2);
  g.fillStyle = '#ffffff'; g.fillRect(0, 0, PNG_W, h);
  draw(g, c, PNG_W, h - 4, true);
  cv.toBlob(b => { if (b) downloadFile(b, fileName(`${c.title} ${c.type}`, 'png'), 'image/png'); }, 'image/png');
}

const keyed = <K extends keyof HTMLElementTagNameMap>(tag: K, key: string, cls: string) => {
  const e = document.createElement(tag);
  e.className = cls;
  e.dataset.chatKey = key;
  e.textContent = t(key);
  return e;
};

/** The chart card for the conversation. */
export function chartCard(c: Chart): HTMLElement {
  const fig = document.createElement('figure');
  fig.className = 'chat-chart';
  fig.dataset.type = c.type;
  const cap = document.createElement('figcaption');
  cap.textContent = c.title;
  const cv = document.createElement('canvas');
  cv.setAttribute('role', 'img');
  cv.setAttribute('aria-label', `${c.title}: ${c.categories.slice(0, 8).map((cat, i) => `${cat} ${withUnit(c, c.series[0].values[i])}`).join(', ')}${c.categories.length > 8 ? ', …' : ''}`);
  let hits: Hit[] = [];
  let lastW = 0;
  const render = () => {
    const w = Math.floor(cv.clientWidth);
    if (!w || w === lastW) return;
    lastW = w;
    const h = heightFor(c, w);
    const dpr = window.devicePixelRatio || 1;
    cv.style.height = `${h}px`;
    cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
    const g = cv.getContext('2d');
    if (!g) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    hits = draw(g, c, w, h, false);
  };
  new ResizeObserver(render).observe(cv);
  cv.addEventListener('mousemove', ev => {
    const r = cv.getBoundingClientRect();
    const h = hitAt(hits, ev.clientX - r.left, ev.clientY - r.top);
    cv.title = h?.label ?? '';
    cv.style.cursor = h ? 'default' : '';
  });
  const png = keyed('button', 'chart.png', 'td-btn chat-chart-png');
  const csv = keyed('button', 'chart.csv', 'td-btn chat-chart-csv');
  png.type = csv.type = 'button';
  png.addEventListener('click', () => savePng(c));
  csv.addEventListener('click', () => downloadFile(chartCsv(c), fileName(`${c.title} ${c.type}`, 'csv'), 'text/csv;charset=utf-8'));
  const actions = document.createElement('div');
  actions.className = 'chat-chart-actions';
  actions.append(png, csv);
  fig.append(cap, cv);
  if (!c.complete) fig.append(keyed('p', 'chart.partial', 'chat-chart-note'));
  fig.append(actions);
  return fig;
}
