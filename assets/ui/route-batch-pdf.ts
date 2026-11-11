// ─── Route batch PDF ─────────────────────────────────────────────────────────
// Role: a route report as a PDF `renderPdf(model, pictures)` lays out route-report-model.ts's
//       `RouteReportModel` in `reportText` order (header, disclaimer, pictures, cost, endpoints, waterfall, strip,
//       crossings, observations tables, tribal, method, caveats) with jsPDF, loaded lazily on first use.
//       Text rule: app wording first passes `pdfGlyphs()` (a fixed symbol table; the eight WinAnsi
//       punctuation characters are admitted as they are, because jsPDF's standard-font `text()` writes them
//       as bytes 0x96 0x97 0x85 0x91–0x95; route-batch-pdf.test.ts checks the bytes); a block whose characters
//       (NFC) all pass `isCoreText` is core-font text (selectable); any other block is drawn on a 2D canvas at
//       2× (system fonts; right-to-left when the first strong letter is Arabic/Hebrew) and added as an image.
//       One predicate, one helper (`block`). A line that mixes app wording with visitor text (the model's
//       `parts`, a `Tpl`) is built with the wording mapped and the visitor parameters raw, and the predicate runs on
//       the finished string; a canvas block always draws the unmapped string. No font asset.
//       A picture may carry a `caption` (above it) and a `legend` (colour swatches under it), kept on the picture's page; `causeLegend` makes
//       the cause map's from the solver's overlay, `classLegend` the cost / weight classes', `similarLegend` the similar-cost classes'.
//       `makeRenderPdf({canvas, compress})` is the injectable form (tests). The observations tables are rendered from `model.observations` raw data
//       through route-observations.ts's exported pure row builders, so panel, CSV and PDF share one wording. The method's uploaded-layer lines are drawn with the label as raw visitor text; unavailable lines use unavailableText.
// Deps: route-batch-types.ts (RenderPdf, PdfPicture, types), route-report-model.ts (RouteReportModel, fillTpl), route-observations.ts (row builders),
//       route/route.ts (overlay palettes and breaks; types), route/screening.ts (types only), i18n (t), jspdf (dynamic import only — never the boot bundle).

import type { jsPDF as JsPdf } from 'jspdf';
import { t } from '../../src/i18n/index.js';
import { COST_BARRIER, COST_BREAKS, COST_PALETTE, SURFACE_PALETTE, WEIGHT_BARRIER, WEIGHT_BREAKS, WEIGHT_PALETTE, type WeightImage } from '../route/route.js';
import type { RouteScreening } from '../route/screening.js';
import { facilityHead, facilityRows, runwayHead, runwayRows, source, surveys, unavailableText } from './route-observations.js';
import type { PdfPicture, RenderPdf } from './route-batch-types.js';
import { fillTpl, type RouteReportModel, type Tpl } from './route-report-model.js';

// ── text rule ──────────────────────────────────────────────────────────

const GLYPHS: [string, string][] = [
  ['\u2212', '-'], ['\u2192', '->'], ['\u2264', '<='], ['\u2265', '>='], ['\u00a0', ' '], ['\u202f', ' '],
  ['\u2248', '~'], ['\u2713', 'yes'], ['\uff0b', '+'], ['\u24d8', ''], ['\u2208', ' in '], ['\u222a', ' or '], ['\u03a0', 'product of'],
];
const GLYPH_RE = new RegExp(`[${GLYPHS.map(([k]) => k).join('')}]`, 'g');
const GLYPH_MAP = new Map(GLYPHS);

/** App wording with the symbols the core fonts lack replaced by plain ones (visitor text never goes through this). */
export function pdfGlyphs(s: string): string {
  return s.replace(GLYPH_RE, c => GLYPH_MAP.get(c) ?? c);
}

// \n, ASCII, Latin-1 (not the C1 range U+0080–009F) and the eight WinAnsi punctuation characters.
const CORE = /^[\n -~\u00a0-\u00ff\u2013\u2014\u2026\u2018\u2019\u201c\u201d\u2022]*$/;

/** True when jsPDF's standard fonts draw the whole string (after NFC) as selectable text. */
export function isCoreText(s: string): boolean {
  return CORE.test(s.normalize('NFC'));
}

const RTL = /[\u0590-\u08ff\ufb1d-\ufefc]/;

/** Base direction from the first strong (letter) character: Arabic/Hebrew script reads right to left. */
export function isRtl(s: string): boolean {
  const first = /\p{L}/u.exec(s);
  return !!first && RTL.test(first[0]);
}

/** The cause map's colour key: one entry per category the overlay shows, largest share first. */
export function causeLegend(w: Pick<WeightImage, 'cause'>): { colour: string; label: string }[] {
  return (w.cause?.present ?? []).map(p => ({ colour: p.colour, label: t(p.labelKey) }));
}

const hex = (c: readonly number[]): string => '#' + c.slice(0, 3).map(v => v.toString(16).padStart(2, '0')).join('');

/** The cost-multiplier (`'cost'`) or routing-weight (`'route'`) overlay's classes as swatches, with the barrier class. */
export function classLegend(mode: 'cost' | 'route'): { colour: string; label: string }[] {
  const [pal, breaks, barrier] = mode === 'cost' ? [COST_PALETTE, COST_BREAKS, COST_BARRIER] : [WEIGHT_PALETTE, WEIGHT_BREAKS, WEIGHT_BARRIER];
  const edges = [1, ...breaks];
  return [...edges.map((lo, i) => ({ colour: hex(pal[i + 1]), label: i + 1 < edges.length ? `\u00d7${lo}\u2013${edges[i + 1]}` : `\u00d7${lo}+` })),
    { colour: hex(pal[barrier]), label: t('route.insp.legend.blocked') }];
}

/** The similar-cost areas' classes (routing cost above the least-cost route) as swatches. */
export function similarLegend(bands: readonly number[]): { colour: string; label: string }[] {
  return bands.map((b, k) => ({ colour: hex(SURFACE_PALETTE[k + 1]), label: `\u2264 ${Math.round(b * 100)} %` }));
}

// ── canvas path ──────────────────────────────────────────────────────────────

export interface CanvasCtx {
  font: string; direction: string; textAlign: string; textBaseline: string; fillStyle: string;
  measureText(s: string): { width: number };
  fillText(s: string, x: number, y: number): void;
}
export interface CanvasLike { width: number; height: number; getContext(kind: '2d'): CanvasCtx | null; toDataURL(type: string): string }
export interface PdfOptions {
  /** Makes a canvas; default `document.createElement('canvas')`. */
  canvas?: () => CanvasLike;
  /** jsPDF stream compression; default true. Tests turn it off to read the streams. */
  compress?: boolean;
}

const SCALE = 2;
const PAGE_W = 612, PAGE_H = 792, MARGIN = 40, CONTENT_W = PAGE_W - 2 * MARGIN;

interface Style { size?: number; bold?: boolean; color?: [number, number, number]; align?: 'left' | 'right' }
const BLACK: [number, number, number] = [20, 20, 20];
const GREY: [number, number, number] = [95, 95, 95];

function wrapCanvas(ctx: CanvasCtx, text: string, maxPx: number): string[] {
  const out: string[] = [];
  for (const para of text.split('\n')) {
    let cur = '';
    for (const ch of Array.from(para)) {
      cur += ch;
      if (ctx.measureText(cur).width > maxPx && Array.from(cur).length > 1) {
        const sp = cur.lastIndexOf(' ', cur.length - 2);
        if (sp > 0) { out.push(cur.slice(0, sp)); cur = cur.slice(sp + 1); }
        else { const chars = Array.from(cur); const last = chars.pop()!; out.push(chars.join('')); cur = last; }
      }
    }
    out.push(cur);
  }
  return out;
}

/** The render function over jsPDF; `renderPdf` is its default instance. */
export function makeRenderPdf(opts: PdfOptions = {}): RenderPdf {
  const newCanvas = opts.canvas ?? ((): CanvasLike => document.createElement('canvas') as unknown as CanvasLike);
  return async (model, pictures) => {
    const { jsPDF } = await import('jspdf');
    return draw(jsPDF, newCanvas, opts.compress ?? true, model, pictures);
  };
}

function draw(Ctor: typeof JsPdf, newCanvas: () => CanvasLike, compress: boolean, m: RouteReportModel, pictures: PdfPicture[]): Uint8Array {
  const doc = new Ctor({ unit: 'pt', format: 'letter', compress });
  let y = MARGIN;

  const ensure = (h: number): void => {
    if (y + h > PAGE_H - MARGIN && y > MARGIN) { doc.addPage(); y = MARGIN; }
  };

  /** How a string is drawn: core text (`mapped`, default `pdfGlyphs(raw)`) or canvas (`raw`), and its wrapped lines at `width` pt. */
  interface Block { canvas: boolean; lines: string[]; lh: number; st: Required<Style> & { rtl: boolean } }
  const block = (raw: string, width: number, style: Style = {}, mapped: string = pdfGlyphs(raw)): Block => {
    const size = style.size ?? 10;
    const canvas = !isCoreText(mapped);
    const st = { size, bold: !!style.bold, color: style.color ?? BLACK, align: style.align ?? 'left', rtl: canvas && isRtl(raw) };
    const lh = size * 1.3;
    if (!canvas) {
      doc.setFont('helvetica', st.bold ? 'bold' : 'normal');
      doc.setFontSize(size);
      return { canvas, lines: mapped.normalize('NFC').split('\n').flatMap(p => doc.splitTextToSize(p, width) as string[]), lh, st };
    }
    const c = newCanvas();
    const ctx = c.getContext('2d');
    if (!ctx) throw new Error('route pdf: no 2D canvas for non-Latin text');
    ctx.font = `${st.bold ? 'bold ' : ''}${size * SCALE}px sans-serif`;
    return { canvas, lines: wrapCanvas(ctx, raw.normalize('NFC'), width * SCALE), lh, st };
  };

  const paint = (b: Block, lines: string[], x: number, top: number, width: number): void => {
    const { st } = b;
    if (!b.canvas) {
      doc.setFont('helvetica', st.bold ? 'bold' : 'normal');
      doc.setFontSize(st.size);
      doc.setTextColor(...st.color);
      lines.forEach((l, i) => {
        const base = top + i * b.lh + st.size;
        if (st.align === 'right') doc.text(l, x + width, base, { align: 'right' });
        else doc.text(l, x, base);
      });
      return;
    }
    const c = newCanvas();
    c.width = Math.ceil(width * SCALE);
    c.height = Math.ceil(lines.length * b.lh * SCALE);
    const ctx = c.getContext('2d')!;
    ctx.font = `${st.bold ? 'bold ' : ''}${st.size * SCALE}px sans-serif`;
    ctx.fillStyle = `rgb(${st.color.join(',')})`;
    ctx.textBaseline = 'top';
    const right = st.align === 'right' || st.rtl;
    ctx.direction = st.rtl ? 'rtl' : 'ltr';
    ctx.textAlign = right ? 'right' : 'left';
    lines.forEach((l, i) => ctx.fillText(l, right ? c.width : 0, i * b.lh * SCALE + (b.lh - st.size) * SCALE / 2));
    doc.addImage(c.toDataURL('image/png'), 'PNG', x, top, width, lines.length * b.lh);
  };

  /** A paragraph at the cursor, split across pages by lines. */
  const para = (raw: string, style: Style = {}, gap = 4, mapped?: string): void => {
    if (!raw) return;
    const b = block(raw, CONTENT_W, style, mapped);
    let i = 0;
    while (i < b.lines.length) {
      ensure(b.lh);
      const fit = Math.max(1, Math.floor((PAGE_H - MARGIN - y) / b.lh));
      const chunk = b.lines.slice(i, i + fit);
      paint(b, chunk, MARGIN, y, CONTENT_W);
      y += chunk.length * b.lh;
      i += chunk.length;
    }
    y += gap;
  };

  /** A line of app wording and visitor text: the wording mapped, the visitor's text exact. */
  const paraT = (p: Tpl, style: Style = {}, gap = 4): void => para(fillTpl(p), style, gap, fillTpl(p, pdfGlyphs));

  const heading = (raw: string): void => { y += 6; ensure(40); para(raw, { size: 13, bold: true }, 4); };

  /** One table row: cells at fractional column widths, the tallest sets the height. */
  const tableRow = (cells: string[], widths: number[], style: Style = {}, aligns: ('left' | 'right')[] = []): void => {
    const xs: number[] = [];
    let acc = MARGIN;
    const ws = widths.map(f => f * CONTENT_W);
    for (const w of ws) { xs.push(acc); acc += w; }
    const blocks = cells.map((c, i) => block(c, ws[i] - 6, { ...style, align: aligns[i] ?? 'left' }));
    const h = Math.max(...blocks.map(b => b.lines.length * b.lh)) + 2;
    ensure(h);
    blocks.forEach((b, i) => paint(b, b.lines, xs[i] + 3, y, ws[i] - 6));
    y += h;
  };

  // ── header and pictures ──
  paraT(m.parts.title, { size: 18, bold: true }, 2);
  paraT(m.parts.subtitle, { size: 10, color: GREY }, 2);
  para(m.badge.label, { size: 10, bold: true }, 8);
  heading(m.disclaimer.heading);
  for (const x of m.disclaimer.paras) para(x, { size: 8 }, 3);
  y += 5;
  if (pictures.length === 0) para(m.snapshot.unavailable, { size: 9, color: GREY }, 6);
  for (const p of pictures) {
    // caption, picture and legend are measured first and kept on one page
    const cap = p.caption ? block(p.caption, CONTENT_W, { size: 9, bold: true }) : null;
    const capH = cap ? cap.lines.length * cap.lh + 2 : 0;
    let img: { w: number; h: number } | null = null;
    if (p.jpeg) {
      const props = doc.getImageProperties(p.jpeg);
      const w = Math.min(CONTENT_W, 300 * (props.width / props.height));
      img = { w, h: w * (props.height / props.width) };
    }
    const legend = (p.legend ?? []).map(l => ({ l, b: block(l.label, CONTENT_W - 14, { size: 8 }) }));
    const legH = legend.reduce((n, { b }) => n + b.lines.length * b.lh, 0) + (legend.length ? 6 : 0);
    ensure(capH + (img ? img.h + 6 : 0) + legH);
    if (cap) { paint(cap, cap.lines, MARGIN, y, CONTENT_W); y += capH; }
    if (p.jpeg && img) {
      ensure(img.h + 6);
      doc.addImage(p.jpeg, 'JPEG', MARGIN, y, img.w, img.h);
      y += img.h + 6;
    } else if (p.note) para(p.note, { size: 9, color: GREY }, 6);
    for (const { l, b } of legend) {
      const h = b.lines.length * b.lh;
      ensure(h);
      doc.setFillColor(...cssRgb(l.colour));
      doc.rect(MARGIN, y + 1, 8, 8, 'F');
      paint(b, b.lines, MARGIN + 14, y, CONTENT_W - 14);
      y += h;
    }
    if (p.legend?.length) y += 6;
  }

  // ── cost ──
  heading(m.cost.heading);
  for (const k of m.cost.kpis) { para(k.value, { size: 14, bold: true }, 0); para(k.label, { size: 9, color: GREY }, 4); }
  const r = m.cost.range;
  para(`${r.label} ${r.pct}`, { size: 10, bold: true }, 1);
  tableRow([r.low, r.point, r.high], [1 / 3, 1 / 3, 1 / 3], { size: 10 });
  para(m.cost.note, { size: 9, color: GREY }, 4);

  // ── endpoints ──
  heading(m.endpoints.heading);
  paraT(m.parts.endpointA, {}, 1); paraT(m.parts.endpointB, {}, 1); para(m.endpoints.optimality);

  // ── waterfall ──
  heading(m.waterfall.heading);
  for (const l of m.waterfall.lines) {
    const strong = l.group === 'subtotal' || l.group === 'total';
    tableRow([l.label, l.text], [0.72, 0.28], { bold: strong, size: 9 }, ['left', 'right']);
  }
  para(m.waterfall.legend.map(l => l.label).join(' \u00b7 '), { size: 8, color: GREY }, 4);

  // ── strip ──
  if (m.strip) {
    const s = m.strip;
    heading(s.heading);
    para(s.legend, { size: 8, color: GREY }, 2);
    ensure(40);
    const total = s.lengthMi || 1;
    for (const key of ['costFill', 'agencyFill'] as const) {
      for (const run of s.runs) {
        const x0 = MARGIN + (run.mi0 / total) * CONTENT_W, x1 = MARGIN + (run.mi1 / total) * CONTENT_W;
        doc.setFillColor(...cssRgb(run[key]));
        doc.rect(x0, y, Math.max(0.5, x1 - x0), 12, 'F');
      }
      y += 14;
    }
    para(`${s.startLabel}  ...  ${s.endLabel}`, { size: 8, color: GREY }, 4);
  }

  // ── crossings ──
  if (m.crossings) {
    heading(m.crossings.heading);
    tableRow(m.crossings.head, [0.55, 0.22, 0.23], { bold: true, size: 9 });
    for (const row of m.crossings.rows) tableRow([row.label, row.count, row.miles], [0.55, 0.22, 0.23], { size: 9 });
    if (m.crossings.aviationNote) para(m.crossings.aviationNote, { size: 9, color: GREY }, 2);
    para(m.crossings.note, { size: 9, color: GREY }, 4);
  }

  // ── observations (raw data → the wording of route-observations.ts) ──
  if (m.observations) observations(m.observations.screening);

  // ── tribal ──
  if (m.tribal.shown) { heading(m.tribal.heading); para(m.tribal.note); }

  // ── method ──
  const me = m.method;
  heading(me.heading);
  paraT(m.parts.methodPreset);
  if (me.editsSummary !== null) { para(me.editsSummary, {}, 1); for (const e of me.edits) para(`- ${e}`, { size: 9 }, 1); }
  for (const u of me.uploads) { const line = fillTpl(u), mapped = fillTpl(u, pdfGlyphs); para(`- ${line}`, { size: 9 }, 1, `- ${mapped}`); }
  para(me.attribution, { size: 9 }); para(me.caveat, { size: 9 }); para(me.class5, { size: 9 }); para(me.grid, { size: 9 });
  heading(me.sourcesHeading);
  para(me.sources, { size: 9 });

  // ── caveats ──
  heading(m.caveats.heading);
  para(m.caveats.screening, { size: 9 });
  para(m.caveats.credit, { size: 8, color: GREY });

  function observations(o?: RouteScreening): void {
    const table = (head: string[], rows: (string | number)[][], widths: number[]): void => {
      tableRow(head, widths, { bold: true, size: 9 });
      for (const row of rows) tableRow(row.map(String), widths, { size: 9 });
    };
    heading(t('route.obs.heading'));
    if (!o) { para(t('route.obs.notRead')); return; }
    const a = o.aviation;
    para(t('route.obs.aviation'), { bold: true }, 2);
    if (a.status === 'unavailable') para(unavailableText(a), { size: 9 });
    else {
      para(a.scope, { size: 9 }, 1);
      para(t('route.obs.inventory', { facilities: a.facilities.length, runways: a.runways.length }), { size: 9 }, 1);
      para(t('route.obs.cycle', { cycle: a.cycle }), { size: 9 });
      table(runwayHead(), runwayRows(a), [0.37, 0.21, 0.21, 0.21]);
      for (const rw of a.runways) para(`${rw.airport} ${rw.runway} \u00b7 ${t('route.obs.surveys', { dates: surveys(rw.surveyDates) })}`, { size: 8, color: GREY }, 1);
      para(t('route.obs.facilities'), { bold: true }, 2);
      table(facilityHead(), facilityRows(a), [0.34, 0.34, 0.14, 0.18]);
      para(source(a.provenance), { size: 8, color: GREY });
    }
    para(t('route.obs.aviationLimit'), { size: 9 });
  }

  return new Uint8Array(doc.output('arraybuffer'));
}

/** `#rrggbb` or `hsl(h s% l%)` \u2192 [r, g, b]. */
function cssRgb(css: string): [number, number, number] {
  const hex = /^#([0-9a-f]{6})$/i.exec(css);
  if (hex) { const n = parseInt(hex[1], 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
  const hsl = /^hsl\(\s*([\d.]+)[ ,]+([\d.]+)%[ ,]+([\d.]+)%\s*\)$/i.exec(css);
  if (!hsl) return [200, 200, 200];
  const h = +hsl[1], s = +hsl[2] / 100, l = +hsl[3] / 100;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number): number => { const k = (n + h / 30) % 12; return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)))); };
  return [f(0), f(8), f(4)];
}

export const renderPdf: RenderPdf = makeRenderPdf();
