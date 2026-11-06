// ─── Route panel: Profile sub-tab ────────────────────────────────────────────
// Role: elevation along the route (Terrarium tiles, sampled once per result and cached) with aligned
//       tracks under it on the same mile axis — land cover, agency, tribal, protected, habitat, homes,
//       existing line, cost ×, driver. Hover (or ←/→) puts a crosshair and a readout on the chart and, with
//       "Sync map marker" on, a marker on the route; dragging zooms the mile range and fits the map to it.
//       One hand-written SVG, rebuilt on resize and zoom. Session only. disabled() is final.
// Deps: route/profile.ts, elevation/terrarium.ts, route/categories.ts (types/labels), src/units.ts,
//       route-tabs/types.ts (types), i18n (t), ./profile.css.

import './profile.css';
import { t } from '../../../src/i18n/index.js';
import { convElevation, unitLabel } from '../../../src/units.js';
import { sampleElevation, TERRAIN_CREDIT } from '../../elevation/terrarium.js';
import { categoryLabelKey } from '../../route/categories.js';
import type { ProfileRun, RouteProfile } from '../../route/profile.js';
import type { RouteTab, RouteTabContext } from './types.js';

const LEFT = 124, RIGHT = 12, DEFAULT_W = 800, ELEV_TOP = 8, ELEV_H = 120, AXIS_H = 22, TRACK_H = 16, TRACK_GAP = 3;
const MIN_DRAG_PX = 4;

type Seg = { text: string; colour: string };
interface Track { key: string; of(r: ProfileRun): Seg | null }

const NLCD_COLOURS: Record<number, string> = {
  11: '#9ec5e8', 12: '#e6eef6', 21: '#e8c9c3', 22: '#e3a79f', 23: '#d4766b', 24: '#b5453b', 31: '#c9c0b0',
  41: '#7fb77e', 42: '#3f8f5a', 43: '#a3c98a', 51: '#cdb98a', 52: '#d8c27a', 71: '#e6dc9a', 72: '#e6dc9a', 73: '#d8e0b8', 74: '#d8e0b8',
  81: '#e7d46f', 82: '#c89b5a', 90: '#8fbcb0', 95: '#9fd1c5',
};
const AGENCY_COLOURS: Record<number, string> = {
  1: '#e5e7eb', 2: '#f2cf86', 3: '#8fc79a', 4: '#7fb0d9', 5: '#9bd3c7', 6: '#c9a3d6', 7: '#e5a3a3', 8: '#a9c3e8', 9: '#d6c08f', 10: '#f0b88a', 11: '#d8d4a0', 12: '#e39bb0', 13: '#b8d98f',
};
// The tm-default steps (1–2 / 3–9 / 10+ homes in the cell), light to the homes concern colour.
const HOMES: Seg[] = [{ text: '1–2', colour: '#f6c58f' }, { text: '3–9', colour: '#e08a3c' }, { text: '10+', colour: '#b45309' }];
const DRIVER_PALETTE = ['#93c5fd', '#fca5a5', '#fcd34d', '#86efac', '#c4b5fd', '#f9a8d4', '#fdba74', '#5eead4', '#d1d5db'];

/** Cost × → colour: 1 pale yellow through orange to deep red at 3+. */
export function costColour(x: number): string {
  const f = Math.min(1, Math.max(0, (x - 1) / 2));
  return `hsl(${Math.round(55 - 55 * f)}, ${Math.round(85 + 5 * f)}%, ${Math.round(75 - 25 * f)}%)`;
}
function driverColour(key: string): string {
  let h = 0;
  for (const c of key) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return DRIVER_PALETTE[h % DRIVER_PALETTE.length];
}

/** The shared NLCD class / land-manager name (route.lbl.*), or "Class n" / "Agency n" for an unknown code. */
function lbl(set: 'nlcd' | 'agency', n: number): string {
  const k = `route.lbl.${set}.${n}`, v = t(k);
  return v === k ? t(`route.lbl.${set}.other`, { n }) : v;
}

const TRACKS: Track[] = [
  { key: 'landcover', of: (r) => r.landcover === null ? null : {
      text: lbl('nlcd', r.landcover),
      colour: NLCD_COLOURS[r.landcover] ?? '#d1d5db' } },
  { key: 'agency', of: (r) => r.agency === null ? null : {
      text: lbl('agency', r.agency),
      colour: AGENCY_COLOURS[r.agency] ?? '#d1d5db' } },
  { key: 'tribal', of: (r) => r.tribal ? { text: t('route.prof.tribal'), colour: '#e39bb0' } : null },
  { key: 'protected', of: (r) => r.gap !== null && r.gap <= 3 ? { text: t('route.prof.gap', { n: r.gap }), colour: r.gap < 3 ? '#4f9d69' : '#a8d5a2' } : null },
  { key: 'habitat', of: (r) => {
      if (!r.critHab && !r.phma) return null;
      return { text: [r.critHab ? t('route.prof.crithab') : '', r.phma ? t('route.prof.phma') : ''].filter(Boolean).join(' · '), colour: '#f0a35e' };
    } },
  { key: 'homes', of: (r) => r.homes ? HOMES[r.homes - 1] : null },
  { key: 'follows', of: (r) => {
      const parts = [r.follows === 1 ? t('route.prof.onLine') : r.follows === 2 ? t('route.prof.besideLine') : '', r.s368 ? t('route.prof.s368') : ''].filter(Boolean);
      return parts.length ? { text: parts.join(' · '), colour: r.follows === 1 ? '#7dd3a8' : '#b6e3cc' } : null;
    } },
  { key: 'cost', of: (r) => ({ text: `×${r.costX.toFixed(2)}`, colour: costColour(r.costX) }) },
  { key: 'driver', of: (r) => r.driver === null ? null : { text: t(categoryLabelKey(r.driver)), colour: driverColour(r.driver) } },
];

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const num = (n: number) => String(Math.round(n * 10) / 10);

/** Elevation per sample (metres), or 'fail'. Cached per profile object once settled. */
type Elev = (number | null)[] | 'fail';
const CACHE = new WeakMap<RouteProfile, Elev>();

/** SVG path: a polyline per run of non-null values (an M restarts after each gap). */
export function elevationPath(xs: number[], ys: (number | null)[]): string {
  let d = '', pen = false;
  ys.forEach((y, i) => {
    if (y === null) { pen = false; return; }
    d += `${pen ? 'L' : 'M'}${num(xs[i])},${num(y)}`;
    pen = true;
  });
  return d;
}

function niceStep(span: number, target: number): number {
  const raw = span / Math.max(1, target);
  for (const s of [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000]) if (s >= raw) return s;
  return 1000;
}

function runAt(runs: ProfileRun[], mi: number): ProfileRun | null {
  for (const r of runs) if (mi >= r.mi0 && mi <= r.mi1) return r;
  return runs.length ? (mi < runs[0].mi0 ? runs[0] : runs[runs.length - 1]) : null;
}

const tab: RouteTab = {
  id: 'profile',
  labelKey: 'route.sub.profile',
  disabled: (s) => {
    const p = s.result?.profile;
    if (p === null) return t('route.sub.why.straight');
    return p && p.runs.length ? null : t('route.sub.why.reprofile');
  },
  render(root, ctx) {
    tab.dispose?.();
    root.replaceChildren();
    const profile = ctx.session.result?.profile;
    if (!profile || !profile.runs.length) return;
    mount(root, ctx, profile);
  },
  dispose() { teardown?.(); },
};

let teardown: (() => void) | null = null;

function mount(root: HTMLElement, ctx: RouteTabContext, profile: RouteProfile): void {
  const { runs, samples } = profile;
  const total = runs[runs.length - 1].mi1;
  let v0 = 0, v1 = total;
  let sync = true;
  let cursor: number | null = null;
  let drag: { from: number; to: number } | null = null;
  let elev: Elev | 'loading' = CACHE.get(profile) ?? 'loading';
  let width = DEFAULT_W;
  let controller: AbortController | null = null;
  let markerOn = false;
  const uid = Math.random().toString(36).slice(2, 8);

  const div = (cls: string) => { const e = document.createElement('div'); e.className = cls; return e; };
  const wrap = div('rpf');
  const head = div('rpf-head');
  const title = document.createElement('span');
  title.className = 'rpf-title';
  title.textContent = t('route.prof.title', { unit: unitLabel('elevation'), credit: TERRAIN_CREDIT });
  const syncLab = document.createElement('label');
  syncLab.className = 'rpf-sync';
  const syncBox = document.createElement('input');
  syncBox.type = 'checkbox';
  syncBox.checked = true;
  syncLab.append(syncBox, document.createTextNode(t('route.prof.sync')));
  const reset = document.createElement('button');
  reset.type = 'button';
  reset.className = 'rpf-reset';
  reset.hidden = true;
  reset.textContent = t('route.prof.reset');
  const hint = document.createElement('span');
  hint.className = 'rpf-hint';
  hint.textContent = t('route.prof.hint');
  head.append(title, syncLab, reset, hint);
  const chart = div('rpf-wrap');
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'rpf-svg');
  svg.setAttribute('tabindex', '0');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', t('route.prof.aria'));
  const read = div('rpf-read');
  read.hidden = true;
  chart.append(svg, read);
  wrap.append(head, chart);
  root.append(wrap);

  const plotW = () => width - LEFT - RIGHT;
  const xOf = (mi: number) => LEFT + ((mi - v0) / (v1 - v0)) * plotW();
  const miOfX = (px: number) => Math.min(v1, Math.max(v0, v0 + ((px - LEFT) / plotW()) * (v1 - v0)));
  const eventMi = (e: MouseEvent) => {
    const r = svg.getBoundingClientRect();
    return miOfX((e.clientX - r.left) * (r.width > 0 ? width / r.width : 1));
  };

  const elevAt = (mi: number): number | null => {
    if (!Array.isArray(elev) || !samples.length) return null;
    let best = 0;
    for (let i = 1; i < samples.length; i++) if (Math.abs(samples[i].mi - mi) < Math.abs(samples[best].mi - mi)) best = i;
    return elev[best] ?? null;
  };
  const fmtElev = (m: number) => `${Math.round(convElevation(m)).toLocaleString()} ${unitLabel('elevation')}`;

  function draw(): void {
    const H = ELEV_TOP + ELEV_H + AXIS_H + TRACKS.length * (TRACK_H + TRACK_GAP) + 4;
    svg.setAttribute('viewBox', `0 0 ${width} ${H}`);
    let s = `<defs><clipPath id="rpf-clip-${uid}"><rect x="${LEFT}" y="0" width="${plotW()}" height="${H}"/></clipPath></defs>`;
    const baseY = ELEV_TOP + ELEV_H;
    // elevation
    if (Array.isArray(elev)) {
      const vals = elev.filter((v): v is number => v !== null);
      if (vals.length) {
        // Axis on round numbers in the display unit (ft or m), never below 0 for land above sea level.
        const d0 = convElevation(Math.min(...vals)), d1 = convElevation(Math.max(...vals));
        const span = Math.max(d1 - d0, 10), mag = 10 ** Math.floor(Math.log10(span / 3));
        const tick = [1, 2, 2.5, 5, 10].map((k) => k * mag).find((k) => span / k <= 4) ?? 10 * mag;
        const t0 = Math.floor(d0 / tick) * tick, nTicks = Math.max(1, Math.ceil((d1 - t0) / tick));
        const per = convElevation(1) || 1;   // display units per metre
        const lo = t0 / per, hi = (t0 + nTicks * tick) / per;
        const yOf = (m: number) => ELEV_TOP + (1 - (m - lo) / (hi - lo)) * ELEV_H;
        const xs = samples.map((p) => xOf(p.mi));
        const ys = elev.map((v) => (v === null ? null : yOf(v)));
        const line = elevationPath(xs, ys);
        let area = '';
        for (let i = 0; i < ys.length;) {
          if (ys[i] === null) { i++; continue; }
          let j = i;
          while (j + 1 < ys.length && ys[j + 1] !== null) j++;
          area += `M${num(xs[i])},${baseY}` + ys.slice(i, j + 1).map((y, k) => `L${num(xs[i + k])},${num(y!)}`).join('') + `L${num(xs[j])},${baseY}Z`;
          i = j + 1;
        }
        for (let k = 0; k <= nTicks; k++) {
          const m = (t0 + k * tick) / per, y = yOf(m);
          s += `<line class="rpf-grid" x1="${LEFT}" x2="${width - RIGHT}" y1="${num(y)}" y2="${num(y)}"/>` +
            `<text class="rpf-tick" x="${LEFT - 6}" y="${num(y + 3)}" text-anchor="end">${esc(Math.round(convElevation(m)).toLocaleString())}</text>`;
        }
        s += `<g clip-path="url(#rpf-clip-${uid})"><path class="rpf-elev-area" d="${area}"/><path class="rpf-elev-line" d="${line}"/></g>`;
      }
    } else {
      s += `<text class="rpf-note" x="${LEFT}" y="${ELEV_TOP + ELEV_H / 2}">${esc(t(elev === 'fail' ? 'route.prof.unavailable' : 'route.prof.loading'))}</text>`;
    }
    // mile axis (the route panel works in miles throughout: ticks, readout, marker), unit in the label column
    s += `<line class="rpf-axis" x1="${LEFT}" x2="${width - RIGHT}" y1="${baseY}" y2="${baseY}"/>` +
      `<text class="rpf-tick rpf-unit" x="${LEFT - 6}" y="${baseY + 15}" text-anchor="end">${esc(t('route.prof.axisMi'))}</text>`;
    const step = niceStep(v1 - v0, plotW() / 80);
    for (let m = Math.ceil(v0 / step) * step; m <= v1 + 1e-9; m += step) {
      s += `<line class="rpf-axis" x1="${num(xOf(m))}" x2="${num(xOf(m))}" y1="${baseY}" y2="${baseY + 4}"/>` +
        `<text class="rpf-tick" x="${num(xOf(m))}" y="${baseY + 15}" text-anchor="middle">${num(m)}</text>`;
    }
    // tracks
    TRACKS.forEach((tr, ti) => {
      const y = baseY + AXIS_H + ti * (TRACK_H + TRACK_GAP);
      const name = t(`route.prof.track.${tr.key}`), short = name.length > 20 ? `${name.slice(0, 19)}…` : name;
      s += `<text class="rpf-track-lab" x="${LEFT - 6}" y="${y + TRACK_H - 4}" text-anchor="end"><title>${esc(name)}</title>${esc(short)}</text><g clip-path="url(#rpf-clip-${uid})" data-track="${tr.key}">`;
      let cur: { seg: Seg; mi0: number; mi1: number } | null = null;
      const flush = () => {
        if (!cur || cur.mi1 < v0 || cur.mi0 > v1) return;
        const x = xOf(cur.mi0), w = xOf(cur.mi1) - x;
        s += `<rect class="rpf-seg" data-mi0="${num(cur.mi0)}" data-mi1="${num(cur.mi1)}" x="${num(x)}" y="${y}" width="${num(Math.max(w, 0))}" height="${TRACK_H}" fill="${cur.seg.colour}"><title>${esc(cur.seg.text)}</title></rect>`;
        if (w >= cur.seg.text.length * 5.2 + 6) s += `<text class="rpf-seg-text" x="${num(x + w / 2)}" y="${y + TRACK_H - 5}" text-anchor="middle">${esc(cur.seg.text)}</text>`;
      };
      for (const r of runs) {
        const seg = tr.of(r);
        if (!seg) { flush(); cur = null; continue; }
        if (cur && cur.seg.text === seg.text && cur.seg.colour === seg.colour && Math.abs(cur.mi1 - r.mi0) < 1e-9) cur.mi1 = r.mi1;
        else { flush(); cur = { seg, mi0: r.mi0, mi1: r.mi1 }; }
      }
      flush();
      s += '</g>';
    });
    if (drag) {
      const a = xOf(Math.min(drag.from, drag.to)), b = xOf(Math.max(drag.from, drag.to));
      s += `<rect class="rpf-sel" x="${num(a)}" y="${ELEV_TOP}" width="${num(b - a)}" height="${H - ELEV_TOP}"/>`;
    }
    if (cursor !== null && cursor >= v0 && cursor <= v1) {
      s += `<line class="rpf-cross" x1="${num(xOf(cursor))}" x2="${num(xOf(cursor))}" y1="${ELEV_TOP}" y2="${H - 4}"/>`;
    }
    svg.innerHTML = s;
  }

  function readout(mi: number): void {
    const r = runAt(runs, mi);
    const e = elevAt(mi);
    const dash = t('route.prof.none');
    const parts = [`<b>${esc(t('route.prof.mile', { mi: mi.toFixed(1) }))}</b>`];
    if (e !== null) parts.push(esc(fmtElev(e)));
    if (r) for (const tr of TRACKS) parts.push(`${esc(t(`route.prof.track.${tr.key}`))}: ${esc(tr.of(r)?.text ?? dash)}`);
    read.innerHTML = parts.join(' · ');
    read.hidden = false;
    const x = xOf(mi);
    const w = Math.max(0, chart.clientWidth || width);
    const flip = x > w * 0.55;
    read.style.left = flip ? '' : `${Math.round(x + 10)}px`;
    read.style.right = flip ? `${Math.round(w - x + 10)}px` : '';
  }

  function moveTo(mi: number): void {
    cursor = mi;
    draw();
    readout(mi);
    if (sync) {
      const e = elevAt(mi);
      const mt = Math.round(mi);
      ctx.setProfileMarker(mi, e === null ? t('route.prof.markerMi', { mi: mt }) : t('route.prof.markerMiElev', { mi: mt, elev: fmtElev(e) }));
      markerOn = true;
    }
  }
  function clearCursor(): void {
    cursor = null;
    read.hidden = true;
    if (markerOn) { ctx.setProfileMarker(null); markerOn = false; }
    draw();
  }
  function zoom(a: number, b: number): void {
    v0 = a; v1 = b;
    reset.hidden = false;
    draw();
    ctx.fitMiles(a, b);
  }
  function resetZoom(): void {
    if (v0 === 0 && v1 === total) return;
    v0 = 0; v1 = total;
    reset.hidden = true;
    draw();
    ctx.fitMiles(0, total);
  }

  svg.addEventListener('mousemove', (e) => {
    const mi = eventMi(e);
    if (drag) { drag.to = mi; draw(); }
    moveTo(mi);
  });
  svg.addEventListener('mouseleave', () => { if (!drag) clearCursor(); });
  svg.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    const mi = eventMi(e);
    drag = { from: mi, to: mi };
    (drag as { px?: number }).px = e.clientX;
  });
  const onUp = (e: MouseEvent) => {
    if (!drag) return;
    const d = drag as { from: number; to: number; px?: number };
    drag = null;
    const moved = Math.abs(e.clientX - (d.px ?? e.clientX));
    const a = Math.min(d.from, d.to), b = Math.max(d.from, d.to);
    if (moved >= MIN_DRAG_PX && b - a > 0.01) zoom(a, b);
    else draw();
  };
  window.addEventListener('mouseup', onUp);
  svg.addEventListener('dblclick', resetZoom);
  reset.addEventListener('click', resetZoom);
  svg.addEventListener('keydown', (e) => {
    const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    moveTo(Math.min(v1, Math.max(v0, (cursor ?? (v0 + v1) / 2) + step)));
  });
  svg.addEventListener('blur', () => { if (cursor !== null) clearCursor(); });
  syncBox.addEventListener('change', () => {
    sync = syncBox.checked;
    if (!sync && markerOn) { ctx.setProfileMarker(null); markerOn = false; }
    else if (sync && cursor !== null) moveTo(cursor);
  });

  let ro: ResizeObserver | null = null;
  if (typeof ResizeObserver !== 'undefined') {
    ro = new ResizeObserver(() => {
      const w = chart.clientWidth;
      if (w > 0 && Math.abs(w - width) >= 1) { width = w; draw(); if (cursor !== null) readout(cursor); }
    });
    ro.observe(chart);
  }

  if (elev === 'loading') {
    controller = new AbortController();
    const c = controller;
    sampleElevation(samples.map((p) => p.lngLat), { signal: c.signal }).then(
      (vals) => {
        if (c.signal.aborted) return;
        elev = vals.some((v) => v !== null) ? vals : 'fail';
        CACHE.set(profile, elev);
        draw();
      },
      () => {
        if (c.signal.aborted) return;
        elev = 'fail';
        draw();
      },
    );
  }

  draw();

  teardown = () => {
    teardown = null;
    controller?.abort();
    ro?.disconnect();
    window.removeEventListener('mouseup', onUp);
    ctx.setProfileMarker(null);
  };
}

export default tab;
