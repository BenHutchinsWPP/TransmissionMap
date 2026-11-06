// ─── Line tools: the Profile section of the Line tab (lazy, with ui-line.ts) ──
// Role: the elevation profile of the line in the Line tab's scope
//       (docs/line-tools.md). Nothing leaves the page until the visitor
//       chooses "Show elevation profile": then lines/profile.ts samples USGS 3DEP and fills
//       from Terrain Tiles, with progress and Cancel (AbortController; ui-line.ts also aborts
//       on a tab close or another line). The result is cached per line and scope for the
//       session (a Swap reverses it, no new request).
//   profileSection(host)   the section: intro (it says points go to USGS only when some fall in
//       3DEP's coverage, profile.ts reaches3dep) + button, progress, failure + retry, or the
//       chart (canvas; every label drawn with fillText or set as textContent), a readout,
//       min / max / total climb and descent (2 m hysteresis), the sources used and their
//       credits, and PNG / CSV downloads. Hover, drag (touch: horizontal drag; the drawer
//       still scrolls vertically) or ←/→ put a crosshair on the chart and a marker on the
//       map (host.onHover); the fault pins are drawn on the same distance axis.
//   cancelProfile()        abort a running profile and drop the crosshair.
//   Distances and elevations follow the display units (src/units.ts). Session only: no URL
//   write, no undo step, not kept in tm-drawer.
// Deps: lines/profile.ts, lines/along.ts (Pos), user-data/user-data-export.ts (downloadFile),
//       src/units.ts, i18n (t, getLocale). Loaded by: ui-line.ts.

import { lineProfile, profileCredits, profileCsv, profileStats, reaches3dep, reversed, SOURCE_NAME,
  type LineProfile, type ProfileProgress, type ElevSource } from '../lines/profile.js';
import type { Pos } from '../lines/along.js';
import { downloadFile } from '../user-data/user-data-export.js';
import { convElevation, fmtDistance, fmtElevation, getUnits, unitLabel } from '../../src/units.js';
import { t, getLocale } from '../../src/i18n/index.js';

export interface ProfileHost {
  key: string;                                // the line and scope: one cached profile each
  line: Pos[] | null;                         // A → B; null when the line is in pieces
  pins: { alongM: number; label: string }[];  // fault pins, metres from A
  title: string;
  lineCredit?: string;                        // the line layer's credit (HTML; toCsv strips it)
  onHover(pos: Pos | null): void;             // the map marker
}

const COLOUR: Record<ElevSource, { line: string; fill: string }> = {
  '3dep': { line: '#2563eb', fill: 'rgba(37, 99, 235, 0.14)' },
  terrarium: { line: '#d97706', fill: 'rgba(217, 119, 6, 0.16)' },
};
const INK = '#0f172a', MUTED = '#6b7280', GRID = '#e5e7eb', PIN = '#dc2626';
const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
const CHART_H = 190, PNG_W = 1000, PNG_H = 430;

interface Cached { p: LineProfile; start: Pos }
const cache = new Map<string, Cached>();
let job: { key: string; ctrl: AbortController; progress: ProfileProgress | null } | null = null;
const failed = new Set<string>();
let section: HTMLElement | null = null;
let host: ProfileHost | null = null;
let hoverD: number | null = null;
let hoverKey = '';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...kids: (Node | string | null | false)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v; else e.setAttribute(k, v);
  }
  for (const c of kids) if (c) e.append(c);
  return e;
}

const btn = (label: string, cls: string, onClick: () => void) => {
  const b = el('button', { type: 'button', class: `td-btn ${cls}` }, label);
  b.addEventListener('click', onClick);
  return b;
};

export function cancelProfile(): void {
  job?.ctrl.abort();
  job = null;
  hoverD = null;
  host?.onHover(null);
}

/** The cached profile for the host's line, walked from its end A. */
function profileFor(h: ProfileHost): LineProfile | null {
  const c = cache.get(h.key);
  if (!c || !h.line) return null;
  const a = h.line[0];
  return c.start[0] === a[0] && c.start[1] === a[1] ? c.p : reversed(c.p);
}

export function profileSection(h: ProfileHost): HTMLElement {
  host = h;
  if (job && job.key !== h.key) cancelProfile();
  if (hoverKey !== h.key) { hoverKey = h.key; hoverD = null; }
  section = el('section', { class: 'lt-profile', 'aria-label': t('line.profile') });
  fill();
  return section;
}

function refresh() {
  if (section?.isConnected) fill();
}

function fill() {
  const h = host!, sec = section!;
  const head = el('h4', { class: 'lt-sub' }, t('line.profile'));
  if (!h.line) { sec.replaceChildren(head, el('p', { class: 'lt-hint' }, t('line.profilePieces'))); return; }
  const p = profileFor(h);
  if (p) { sec.replaceChildren(head, ...chartBlock(h, p)); return; }
  if (job?.key === h.key) {
    const pr = job.progress;
    const msg = pr?.phase === 'terrarium' || pr?.total === 0 ? t('line.profileFilling')
      : t('line.profileReading', { done: pr?.done ?? 0, total: pr?.total ?? '…' });
    sec.replaceChildren(head, el('p', { class: 'lt-status', role: 'status' }, msg),
      el('div', { class: 'lt-actions' }, btn(t('line.profileCancel'), 'lt-prof-cancel', () => { cancelProfile(); refresh(); })));
    return;
  }
  const kids: Node[] = [head];
  if (failed.has(h.key)) kids.push(el('p', { class: 'lt-refuse', role: 'alert' }, t('line.profileFailed')));
  else kids.push(el('p', { class: 'lt-hint' }, t(reaches3dep(h.line) ? 'line.profileIntro' : 'line.profileIntroWorld')));
  kids.push(el('div', { class: 'lt-actions' },
    btn(failed.has(h.key) ? t('line.profileRetry') : t('line.profileShow'), 'lt-prof-show', () => void start(h))));
  sec.replaceChildren(...kids);
}

async function start(h: ProfileHost) {
  if (!h.line || job?.key === h.key) return;
  const line = h.line, key = h.key;
  const ctrl = new AbortController();
  job = { key, ctrl, progress: null };
  failed.delete(key);
  refresh();
  try {
    const p = await lineProfile(line, { signal: ctrl.signal, onProgress: pr => { if (job?.ctrl === ctrl) { job.progress = pr; refresh(); } } });
    if (job?.ctrl !== ctrl) return;
    job = null;
    if (p.points.every(q => q.m === null)) failed.add(key);
    else {
      if (cache.size >= 20) cache.delete(cache.keys().next().value!);
      cache.set(key, { p, start: line[0] });
    }
  } catch (err) {
    if (job?.ctrl !== ctrl) return;
    job = null;
    if ((err as Error)?.name !== 'AbortError') failed.add(key);
  }
  refresh();
}

// ─── The chart ───────────────────────────────────────────────────────────────
const distUnitM = () => (getUnits().distance === 'mi' ? 1609.344 : 1000);
const num = (n: number, digits = 0) => n.toLocaleString(getLocale(), { maximumFractionDigits: digits });

/** About five round tick values over [lo, hi]. */
function ticks(lo: number, hi: number, want = 5): number[] {
  if (!(hi > lo)) return [lo];
  const raw = (hi - lo) / want;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => s >= raw)!;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) out.push(Math.round(v / step) * step || 0);
  return out;
}

interface Frame { x0: number; x1: number; toX(d: number): number; toD(x: number): number }

/** Index of the sample nearest `d` metres from A. */
function nearest(p: LineProfile, d: number): number {
  const pts = p.points;
  let lo = 0, hi = pts.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (pts[m].d < d) lo = m; else hi = m; }
  return d - pts[lo].d <= pts[hi].d - d ? lo : hi;
}

function draw(g: CanvasRenderingContext2D, p: LineProfile, w: number, h: number, pins: ProfileHost['pins'], hover: number | null): Frame {
  const st = profileStats(p.points);
  const lo = convElevation(st.min!.m!), hi = convElevation(st.max!.m!);
  const pad = Math.max((hi - lo) * 0.08, convElevation(5));
  const yt = ticks(lo - pad, hi + pad, h > 250 ? 6 : 4);
  const ylo = Math.min(lo - pad, yt[0]), yhi = Math.max(hi + pad, yt.at(-1)!);
  g.font = `11px ${FONT}`;
  g.textBaseline = 'middle';
  const axW = Math.max(...yt.map(v => g.measureText(num(v)).width)) + 10;
  const x0 = axW + 4, x1 = w - 10, y0 = 18, y1 = h - 24;
  const dm = distUnitM(), L = p.lengthM || 1;
  const toX = (d: number) => x0 + (d / L) * (x1 - x0);
  const toD = (x: number) => Math.min(L, Math.max(0, ((x - x0) / (x1 - x0)) * L));
  const toY = (m: number) => y1 - ((convElevation(m) - ylo) / ((yhi - ylo) || 1)) * (y1 - y0);

  g.textAlign = 'right';
  for (const v of yt) {
    const y = Math.round(y1 - ((v - ylo) / ((yhi - ylo) || 1)) * (y1 - y0)) + 0.5;
    g.strokeStyle = GRID; g.lineWidth = 1;
    g.beginPath(); g.moveTo(x0, y); g.lineTo(x1, y); g.stroke();
    g.fillStyle = MUTED; g.fillText(num(v), x0 - 6, y);
  }
  g.textAlign = 'left'; g.fillText(unitLabel('elevation'), 2, 8);
  const xt = ticks(0, L / dm, Math.max(4, Math.floor((x1 - x0) / 80)));
  g.textAlign = 'center';
  for (const v of xt) {
    const x = Math.round(toX(v * dm)) + 0.5;
    g.strokeStyle = GRID; g.beginPath(); g.moveTo(x, y1); g.lineTo(x, y1 + 4); g.stroke();
    if (x > x0 + 10 && x < x1 - 28) g.fillText(num(v, 2), x, y1 + 12);
  }
  g.font = `600 11px ${FONT}`; g.fillStyle = INK;
  g.textAlign = 'left'; g.fillText('A', x0, y1 + 12);
  g.textAlign = 'right'; g.fillText(`B · ${unitLabel('distance')}`, x1, y1 + 12);

  // Runs of one source with no gap: a fill to the baseline and a 2 px line.
  const pts = p.points;
  for (let i = 0; i < pts.length;) {
    if (pts[i].m === null) { i++; continue; }
    const src = pts[i].src!;
    let j = i;
    while (j + 1 < pts.length && pts[j + 1].m !== null && pts[j + 1].src === src) j++;
    // join to the next run so a source change leaves no hole
    const end = j + 1 < pts.length && pts[j + 1].m !== null ? j + 1 : j;
    g.beginPath();
    g.moveTo(toX(pts[i].d), y1);
    for (let k = i; k <= end; k++) g.lineTo(toX(pts[k].d), toY(pts[k].m!));
    g.lineTo(toX(pts[end].d), y1);
    g.closePath();
    g.fillStyle = COLOUR[src].fill; g.fill();
    g.beginPath();
    for (let k = i; k <= end; k++) (k === i ? g.moveTo : g.lineTo).call(g, toX(pts[k].d), toY(pts[k].m!));
    if (i === end) g.arc(toX(pts[i].d), toY(pts[i].m!), 1.5, 0, Math.PI * 2);
    g.strokeStyle = COLOUR[src].line; g.lineWidth = 2; g.lineJoin = 'round'; g.stroke();
    i = j + 1;
  }
  g.strokeStyle = MUTED; g.lineWidth = 1;
  g.beginPath(); g.moveTo(x0, y1 + 0.5); g.lineTo(x1, y1 + 0.5); g.stroke();

  g.font = `11px ${FONT}`; g.textBaseline = 'alphabetic';
  for (const pin of pins) {
    const x = Math.round(toX(pin.alongM)) + 0.5;
    g.strokeStyle = PIN; g.lineWidth = 1.5; g.setLineDash([4, 3]);
    g.beginPath(); g.moveTo(x, y0); g.lineTo(x, y1); g.stroke();
    g.setLineDash([]);
    g.fillStyle = PIN;
    g.textAlign = x > (x0 + x1) / 2 ? 'right' : 'left';
    g.fillText(pin.label, x + (x > (x0 + x1) / 2 ? -4 : 4), y0 + 2);
  }
  if (hover !== null) {
    const q = pts[nearest(p, hover)];
    const x = Math.round(toX(q.d)) + 0.5;
    g.strokeStyle = INK; g.lineWidth = 1;
    g.beginPath(); g.moveTo(x, y0 - 6); g.lineTo(x, y1); g.stroke();
    if (q.m !== null) {
      g.fillStyle = '#ffffff'; g.strokeStyle = q.src ? COLOUR[q.src].line : INK; g.lineWidth = 2;
      g.beginPath(); g.arc(x, toY(q.m), 4, 0, Math.PI * 2); g.fill(); g.stroke();
    }
  }
  return { x0, x1, toX, toD };
}

function readoutText(p: LineProfile, d: number | null): string {
  if (d === null) return t('line.profileHoverHint');
  const q = p.points[nearest(p, d)];
  return t('line.profileReadout', { d: fmtDistance(q.d), e: q.m === null ? '—' : fmtElevation(q.m), src: q.src ? SOURCE_NAME[q.src] : '—' });
}

function chartBlock(h: ProfileHost, p: LineProfile): Node[] {
  const st = profileStats(p.points);
  const cv = el('canvas', { class: 'lt-prof-chart', tabindex: '0', role: 'img' });
  cv.setAttribute('aria-label', t('line.profileAria', {
    min: fmtElevation(st.min!.m!), max: fmtElevation(st.max!.m!), up: fmtElevation(st.climbM), down: fmtElevation(st.descentM) }));
  const readout = el('p', { class: 'lt-prof-readout', 'aria-live': 'polite' }, readoutText(p, hoverD));
  let frame: Frame | null = null, w = 0;
  const paint = () => {
    const g = cv.getContext('2d');
    if (!g || !w) return;
    const dpr = window.devicePixelRatio || 1;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, CHART_H);
    frame = draw(g, p, w, CHART_H, h.pins, hoverD);
  };
  new ResizeObserver(() => {
    const nw = Math.floor(cv.clientWidth);
    if (!nw || nw === w) return;
    w = nw;
    const dpr = window.devicePixelRatio || 1;
    cv.width = Math.round(w * dpr); cv.height = Math.round(CHART_H * dpr);
    paint();
  }).observe(cv);
  const setHover = (d: number | null) => {
    hoverD = d;
    paint();
    readout.textContent = readoutText(p, d);
    h.onHover(d === null ? null : p.points[nearest(p, d)].pos);
  };
  const atPointer = (ev: PointerEvent) => {
    if (!frame) return;
    const r = cv.getBoundingClientRect();
    setHover(frame.toD(ev.clientX - r.left));
  };
  cv.addEventListener('pointerdown', ev => { cv.setPointerCapture(ev.pointerId); atPointer(ev); });
  cv.addEventListener('pointermove', ev => { if (ev.pointerType === 'mouse' || cv.hasPointerCapture(ev.pointerId)) atPointer(ev); });
  cv.addEventListener('pointerleave', ev => { if (ev.pointerType === 'mouse' && !cv.hasPointerCapture(ev.pointerId)) setHover(null); });
  cv.addEventListener('keydown', ev => {
    const stepM = p.lengthM * (ev.shiftKey ? 0.1 : 0.01);
    const cur = hoverD ?? 0;
    const next = ev.key === 'ArrowRight' ? cur + stepM : ev.key === 'ArrowLeft' ? cur - stepM
      : ev.key === 'Home' ? 0 : ev.key === 'End' ? p.lengthM : ev.key === 'Escape' ? null : undefined;
    if (next === undefined) return;
    ev.preventDefault();
    setHover(next === null ? null : Math.min(p.lengthM, Math.max(0, next)));
  });
  if (hoverD !== null) h.onHover(p.points[nearest(p, hoverD)].pos);

  const dl = el('dl', { class: 'lt-facts lt-prof-stats' });
  const fact = (k: string, v: string) => dl.append(el('dt', {}, k), el('dd', {}, v));
  fact(t('line.profileMin'), `${fmtElevation(st.min!.m!)} (${t('line.profileAt', { d: fmtDistance(st.min!.d) })})`);
  fact(t('line.profileMax'), `${fmtElevation(st.max!.m!)} (${t('line.profileAt', { d: fmtDistance(st.max!.d) })})`);
  fact(t('line.profileClimb'), fmtElevation(st.climbM));
  fact(t('line.profileDescent'), fmtElevation(st.descentM));
  fact(t('line.profileSamples'), t('line.profileSamplesVal', { n: num(p.points.length), step: `${num(convDist(p.stepM), 0)} ${smallUnit()}` }));
  const n = p.points.length;
  const share = (k: number) => `${num((k / n) * 100, k && k < n ? 1 : 0)} %`;
  fact(t('line.profileSource'), [st.n3dep && `${SOURCE_NAME['3dep']} ${share(st.n3dep)}`, st.nTerrarium && `${SOURCE_NAME.terrarium} ${share(st.nTerrarium)}`]
    .filter(Boolean).join(' · '));

  const legend = el('div', { class: 'lt-prof-legend' },
    ...(['3dep', 'terrarium'] as const).filter(s => (s === '3dep' ? st.n3dep : st.nTerrarium) > 0)
      .map(s => el('span', { class: 'lt-prof-key' }, el('span', { class: 'lt-prof-sw', style: `background:${COLOUR[s].line}` }), SOURCE_NAME[s])));
  const notes = el('ul', { class: 'lt-notes' });
  if (st.nTerrarium) notes.append(el('li', {}, t('line.profileTerrNote')));
  if (st.nGap) notes.append(el('li', { class: 'lt-warn' }, t('line.profileGaps', { n: num(st.nGap) })));
  const credits = profileCredits(st);
  const png = btn(t('line.profilePng'), 'lt-prof-png', () => savePng(h, p, credits));
  const csv = btn(t('line.profileCsv'), 'lt-prof-csv', () =>
    downloadFile(profileCsv(p, { title: h.title, lineCredit: h.lineCredit }), fileName(h.title, 'csv'), 'text/csv;charset=utf-8'));
  return [
    el('div', { class: 'lt-prof-plot' }, cv, legend),
    readout,
    el('div', { class: 'lt-prof-foot' }, dl,
      el('div', {}, notes, el('div', { class: 'lt-actions' }, png, csv),
        el('p', { class: 'lt-prof-credit' }, t('line.profileCredit', { credits: credits.join('; ') })))),
  ];
}

const convDist = (m: number) => (getUnits().distance === 'mi' ? m * 3.28084 : m);
const smallUnit = () => (getUnits().distance === 'mi' ? 'ft' : 'm');

function fileName(title: string, ext: string): string {
  const base = `${title} elevation profile`.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 70);
  return `${base || 'elevation-profile'}.${ext}`;
}

function savePng(h: ProfileHost, p: LineProfile, credits: string[]) {
  const cv = document.createElement('canvas');
  cv.width = PNG_W * 2; cv.height = PNG_H * 2;
  const g = cv.getContext('2d');
  if (!g) return;
  g.scale(2, 2);
  g.fillStyle = '#ffffff'; g.fillRect(0, 0, PNG_W, PNG_H);
  g.fillStyle = INK; g.font = `600 15px ${FONT}`; g.textBaseline = 'alphabetic'; g.textAlign = 'left';
  g.fillText(`${h.title} · ${t('line.profile')}`, 12, 22);
  const st = profileStats(p.points);
  g.font = `12px ${FONT}`; g.fillStyle = MUTED;
  g.fillText(`${t('line.profileMin')} ${fmtElevation(st.min!.m!)} · ${t('line.profileMax')} ${fmtElevation(st.max!.m!)} · ${t('line.profileClimb')} ${fmtElevation(st.climbM)} · ${t('line.profileDescent')} ${fmtElevation(st.descentM)} · ${fmtDistance(p.lengthM)}`, 12, 40);
  g.save();
  g.translate(0, 50);
  draw(g, p, PNG_W, PNG_H - 50 - 44, h.pins, null);
  g.restore();
  g.font = `11px ${FONT}`; g.fillStyle = MUTED; g.textAlign = 'left'; g.textBaseline = 'alphabetic';
  const line = h.lineCredit?.replace(/<[^>]*>/g, '').replace(/&copy;/g, '©').replace(/&amp;/g, '&');
  g.fillText(t('line.profileCredit', { credits: credits.join('; ') }), 12, PNG_H - 24, PNG_W - 24);
  if (line) g.fillText(line, 12, PNG_H - 9, PNG_W - 24);
  cv.toBlob(b => { if (b) downloadFile(b, fileName(h.title, 'png'), 'image/png'); }, 'image/png');
}
