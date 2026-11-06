// ─── Fit a copy of map features into My Data, or offer it as a download ──────
// Role: the one set of caps, the one download fallback and the one credit rule
//       every copy to My Data shares (popup, table, chat). A copy of at most
//       MAX_COPY_ITEMS features, MAX_COPY_CHARS of GeoJSON and a projected
//       `tm-user-data` payload of MAX_STORE_CHARS is committed (`commitCopy`);
//       over a cap, or when the browser refuses the save, nothing is kept and
//       the result is a `download`: a GeoJSON file without `__src`, with the
//       attribution, licence and source URL as foreign members. `creditText`
//       turns a registry credit (HTML) into the plain text a copy stores.
//       `showCopyResult` shows a copy's outcome as its button's text.
// Deps: user-data/user-data.ts (addCopiedFeatures, storedUserDataChars),
//       user-data/user-data-export.ts (downloadFile), src/i18n (t); line-read.ts
//       by `import type` only (its hyparquet stays in the lazy line chunk).
//       Boot-bundle safe. Used by lines/line-copy.ts, popup.ts, ui/ui-line.ts.

import type { LineFailure } from '../lines/line-read.js';
import { addCopiedFeatures, storedUserDataChars } from './user-data.js';
import { downloadFile } from './user-data-export.js';
import { t } from '../../src/i18n/index.js';

export const MAX_COPY_ITEMS = 1000;
export const MAX_COPY_CHARS = 1_500_000;
export const MAX_STORE_CHARS = 4_000_000;
export const SIMPLIFIED = 'simplified from map tiles';

export interface CopyItem {
  fid: string | number;
  properties: Record<string, unknown>;
  tileGeometry: GeoJSON.Geometry | null;
  mapLayerId: string;   // the style layer drawn — the copy keeps its popup (`__src`)
}

export type CopyRefusal = LineFailure | 'not-copyable' | 'empty';
export type CopyDownload = { kind: 'download'; n: number; chars: number; fc: GeoJSON.FeatureCollection; filename: string;
  storageFull?: true };
export type CopyResult =
  | { kind: 'copied'; n: number; simplified: number }
  | CopyDownload
  | { kind: 'refused'; reason: CopyRefusal };
export interface CopyMeta { label: string; attribution?: string; licence?: string; url?: string; dataset?: string }

function withoutSrc(p: GeoJSON.GeoJsonProperties) {
  const rest = { ...p };
  delete rest.__src;
  return rest;
}

/** The download form: no __src, the credit as foreign members, `${dataset ?? layerId}-${n}.geojson`. */
export function toDownload(features: GeoJSON.Feature[], meta: CopyMeta | null, layerId: string, chars: number): CopyDownload {
  const fc = {
    type: 'FeatureCollection', features: features.map(f => ({ ...f, properties: withoutSrc(f.properties) })),
    ...(meta && { attribution: meta.attribution, licence: meta.licence, source_url: meta.url }),
  } as GeoJSON.FeatureCollection;
  return { kind: 'download', n: features.length, chars, fc, filename: `${meta?.dataset ?? layerId}-${features.length}.geojson` };
}

/** Fits the caps → 'fits'; else the download. */
export function fitCopy(features: GeoJSON.Feature[], meta: CopyMeta | null, storedChars: number, layerId: string):
  { kind: 'fits'; chars: number } | CopyDownload {
  const chars = JSON.stringify({ type: 'FeatureCollection', features }).length;
  if (chars > MAX_COPY_CHARS || storedChars + chars > MAX_STORE_CHARS) return toDownload(features, meta, layerId, chars);
  return { kind: 'fits', chars };
}

/** Commits a fitting copy: addCopiedFeatures, then 'copied', or the download with storageFull when the save failed. */
export function commitCopy(features: GeoJSON.Feature[], meta: CopyMeta | null, layerId: string, layerName: string | undefined,
  simplified: number): CopyResult {
  const fit = fitCopy(features, meta, storedUserDataChars(), layerId);
  if (fit.kind === 'download') return fit;
  const fallback = toDownload(features, meta, layerId, fit.chars);   // before the commit adds its ids to the features
  // A mocked or older addCopiedFeatures may return nothing: only an explicit false is a failed save.
  if (addCopiedFeatures(features, layerName)?.saved === false) return { ...fallback, storageFull: true };
  return { kind: 'copied', n: features.length, simplified };
}

const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©' };

/** A registry credit (HTML) as plain text: tags stripped, entities decoded, whitespace collapsed. No DOM. */
export function creditText(html: string): string {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(?:#(\d+)|#x([0-9a-f]+)|(\w+));/gi, (m, dec, hex, name) => {
      if (name) return Object.hasOwn(NAMED, name.toLowerCase()) ? NAMED[name.toLowerCase()] : m;
      const cp = dec ? parseInt(dec, 10) : parseInt(hex, 16);
      return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    })
    .replace(/\s+/g, ' ')
    .trim();
}

export function downloadCopy(r: CopyDownload) {
  downloadFile(JSON.stringify(r.fc), r.filename, 'application/geo+json');
}

/** A copy's outcome on the button that started it (text only): done, a download offer, or why not.
 *  With `offer`, the button's next click downloads; without, the caller wires it.
 *  `noun` picks the too-many wording: lines (line.reason) or features (copy.reason). */
export function showCopyResult(btn: HTMLButtonElement, r: CopyResult, offer = true, noun: 'line' | 'feature' = 'line') {
  if (r.kind === 'copied') {
    btn.textContent = t(r.simplified ? 'line.copiedSimplified' : 'line.copied', { n: r.n });
  } else if (r.kind === 'download') {
    btn.disabled = false;
    btn.textContent = t('line.download', { n: r.n, size: (r.chars / 1e6).toFixed(1) });
    btn.title = t('line.tooBig');
    if (offer) btn.addEventListener('click', () => downloadCopy(r), { once: true });
  } else {
    const key = r.reason === 'not-copyable' || r.reason === 'empty' || (r.reason === 'too-many' && noun === 'feature')
      ? 'copy.reason.' + r.reason : 'line.reason.' + r.reason;
    btn.textContent = t('line.copyFailed', { reason: t(key) });
  }
}
