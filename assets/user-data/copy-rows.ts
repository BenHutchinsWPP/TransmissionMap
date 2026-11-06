// ─── Copy a table's rows to My Data (lazy chunk) ─────────────────────────────
// Role: the generic "copy these query rows" step behind the table's copy button
//       and the chat's copyToMyData. `copyMode` says what a layer's copy is:
//       'full' (a layer with `data.analysis`: full geometry from its GeoParquet
//       files, via lines/line-copy.ts; a polygon never falls back to tile
//       geometry), 'point' (a tiled point layer with a columns file: a
//       columns-file row copies its own exact point; a tile row takes the max-zoom
//       tile point of the same id, read through lines/osm-substation.ts, else the tile point marked
//       `geometry_source: "simplified from map tiles"`), 'exact' (a GeoJSON
//       layer without `data.analysis`: the feature's own geometry, from the source data; also
//       the region layers' edit-mode copy before their files answer, `fromSource`, whose
//       geometry is marked `geometry_source: "simplified from the served map layer"`) or 'none' (everything else, so no
//       copy is offered). `copyNoun` says whether the wording is for lines or
//       features. An exact or point row is cloned (rows are the map's own source objects, which My Data
//       would otherwise mutate), its `__` keys dropped, and given `source`,
//       `attribution` (credit as text), `licence`/`source_url` (from the data
//       manifest, fetched once with a timeout and treated as untrusted), `osm`
//       for OSM ids and `__src` (a map layer with a popup renderer). Caps, the
//       download fallback and the save come from copy-fit.ts.
// Deps: copy-fit.ts, dataset-query.ts (QueryRow type), popup-format.ts
//       (hasPopupRenderer), copy-mode.ts (copyMode, copyNoun, re-exported), src/registry (layerById, osmRef), constants (DATA). lines/line-copy.ts and
//       lines/osm-substation.ts only through import(). Imported only
//       dynamically (ui-table.ts, map-api.ts, popup.ts).

import { commitCopy, creditText, MAX_COPY_ITEMS, SIMPLIFIED, SIMPLIFIED_SERVED, type CopyMeta, type CopyResult } from './copy-fit.js';
import type { QueryRow } from '../dataset-query.js';
import { hasPopupRenderer } from '../popup-format.js';
import { DATA } from '../constants.js';
import { layerById } from '../../src/registry/index.js';
import { copyMode, copyNoun, type CopyMode } from './copy-mode.js';
import { osmRef, OSM_FID, OSM_NATIVE_FID } from '../../src/registry/osm-fid.js';

export { copyMode, copyNoun, type CopyMode };

/** true / false; null when the line files could not be read this time (asked again on the next sync). */
export async function copyAvailable(layerId: string): Promise<boolean | null> {
  const mode = copyMode(layerId);
  if (mode === 'exact' || mode === 'point') return true;
  if (mode === 'none') return false;
  try {
    const r = await (await import('../lines/line-read.js')).lineDataset(layerId);
    return r.ok ? true : r.reason === 'unavailable' ? false : null;
  } catch {
    return null;
  }
}

const SHORT = 300;
const text = (v: unknown) => (typeof v === 'string' && v.length <= SHORT && v !== 'UNKNOWN' ? v : undefined);

let manifest: Promise<Record<string, unknown> | null> | null = null;
function loadManifest() {
  return manifest ??= (async () => {
    try {
      const resp = await fetch(DATA.data_manifest, { signal: AbortSignal.timeout(5000) });
      if (!resp.ok) return null;
      const layers = ((await resp.json()) as { layers?: unknown } | null)?.layers;
      return layers && typeof layers === 'object' && !Array.isArray(layers) ? layers as Record<string, unknown> : null;
    } catch {
      return null;
    }
  })();
}

/** The layer's manifest entry reduced to label/url/licence strings; empty when absent or odd. */
async function manifestMeta(dataset: string) {
  const layers = await loadManifest();
  const e = layers && Object.hasOwn(layers, dataset) ? layers[dataset] : null;
  const o = e && typeof e === 'object' ? e as Record<string, unknown> : {};
  return { label: text(o.label), url: text(o.url), licence: text(o.licence) };
}

const unitM = (z: number) => 40_075_017 / 2 ** z / 4096;   // one grid unit at tile zoom z, equator metres

/** Each tile row's max-zoom point, read from the max-zoom tiles around the tile point (never trusted from the
 *  map zoom: a drawn tile can be a lower zoom). `zoom` only sizes the padding (one grid unit of the drawn tile,
 *  at most the max zoom's). A row not found, or an archive that cannot be read, is absent (the caller keeps
 *  the tile point, marked). */
async function maxZoomPoints(layerId: string, rows: readonly QueryRow[], zoom: number | undefined): Promise<Map<string, [number, number]> | null> {
  if (zoom === undefined || !rows.length) return null;
  try {
    const m = await import('../lines/osm-substation.js');
    const key = layerById(layerId)!.data!.key;
    const padM = unitM(Math.max(0, Math.min(Math.floor(zoom), await m.archiveMaxZoom(key))));
    return await m.pointsByFid(key, rows.flatMap(r => r.feature.geometry.type === 'Point'
      ? [{ fid: r.id as string | number, at: r.feature.geometry.coordinates, padM }] : []));
  } catch {
    return null;
  }
}

/** `zoom`: the map's zoom, for a tile row of a 'point' layer (it sizes the search padding).
 *  `fromSource`: a GeoJSON layer's rows copy their own geometry ('exact') even when the layer
 *  also has geometry files (the edit-mode click before the files have answered). */
export async function copyRows(layerId: string, rows: readonly QueryRow[], layerName: string | undefined, zoom?: number,
  fromSource = false): Promise<CopyResult> {
  const owner = layerById(layerId);
  const mode = fromSource && owner?.data?.kind === 'geojson' && copyMode(layerId) !== 'none' ? 'exact' : copyMode(layerId);
  const served = fromSource && mode === 'exact' && copyMode(layerId) === 'full';
  if (mode === 'none' || !owner) return { kind: 'refused', reason: 'not-copyable' };
  // A columns-file row carries a point on the feature, not its shape: it is never copied as geometry.
  if (mode === 'exact' && rows.some(r => r.pointOnly)) return { kind: 'refused', reason: 'not-copyable' };
  const usable = rows.filter(r => r.id !== null);
  if (usable.length > MAX_COPY_ITEMS) return { kind: 'refused', reason: 'too-many' };
  if (!usable.length) return { kind: 'refused', reason: 'empty' };
  const src = owner.mapLayerIds.find(hasPopupRenderer) ?? owner.mapLayerIds[0];

  if (mode === 'full') {
    const m = await import('../lines/line-copy.js');
    return m.copyLines(layerId, usable.map(r => ({
      fid: r.id!, mapLayerId: owner.mapLayerIds[0],
      properties: { ...r.feature.properties }, tileGeometry: r.pointOnly ? null : r.feature.geometry,
      ...(r.pointOnly && { searchHint: r.feature.geometry }),
    })), layerName);
  }

  const atMax = mode === 'point' ? await maxZoomPoints(layerId, usable.filter(r => !r.pointOnly), zoom) : null;
  const mm = await manifestMeta(owner.dataset!);
  const attribution = creditText(owner.data!.credit);
  const label = mm.label ?? owner.label ?? layerId;
  const idField = owner.data!.id!.field;
  const isOsm = owner.data!.id === OSM_FID || owner.data!.id === OSM_NATIVE_FID;
  let simplified = 0;
  const features = usable.map((r): GeoJSON.Feature => {
    const f = structuredClone(r.feature);
    const props = Object.fromEntries(Object.entries(f.properties ?? {}).filter(([k]) => !k.startsWith('__')));
    const ref = isOsm ? osmRef(r.id) : null;
    let geometry = f.geometry, marked = false;
    if (mode === 'point' && !r.pointOnly) {
      const p = atMax?.get(String(r.id));
      if (p) geometry = { type: 'Point', coordinates: p };
      else { marked = true; simplified++; }
    }
    if (served) simplified++;
    return {
      type: 'Feature',
      geometry,
      properties: {
        ...props,
        [idField]: r.id,
        source: label,
        attribution,
        ...(mm.licence && { licence: mm.licence }),
        ...(mm.url && { source_url: mm.url }),
        ...(ref && { osm: `https://www.openstreetmap.org/${ref.type}/${ref.id}` }),
        ...(marked && { geometry_source: SIMPLIFIED }),
        ...(served && { geometry_source: SIMPLIFIED_SERVED }),
        __src: src,
      },
    };
  });
  const meta: CopyMeta = { label, attribution, licence: mm.licence, url: mm.url, dataset: owner.dataset };
  return commitCopy(features, meta, layerId, layerName, simplified);
}

/** Test support: forget the fetched manifest. */
export function resetCopyManifest() { manifest = null; }
