// ─── Copy a table's rows to My Data (lazy chunk) ─────────────────────────────
// Role: the generic "copy these query rows" step behind the table's copy button
//       and the chat's copyToMyData. `copyMode` says what a layer's copy is:
//       'lines' (transmission lines: full geometry from the line files, via
//       lines/line-copy.ts), 'exact' (a GeoJSON layer: the feature's own
//       geometry) or 'none' (everything else, so no copy is offered). An exact
//       row is cloned (rows are the map's own source objects, which My Data
//       would otherwise mutate), its `__` keys dropped, and given `source`,
//       `attribution` (credit as text), `licence`/`source_url` (from the data
//       manifest, fetched once with a timeout and treated as untrusted), `osm`
//       for OSM ids and `__src` (a map layer with a popup renderer). Caps, the
//       download fallback and the save come from copy-fit.ts.
// Deps: copy-fit.ts, dataset-query.ts (QueryRow type), popup-format.ts
//       (hasPopupRenderer), src/registry (layerById, FIELD_SCHEMA, osmRef),
//       constants (DATA). lines/line-copy.ts only through import(). Imported
//       only dynamically (ui-table.ts, map-api.ts).

import { commitCopy, creditText, MAX_COPY_ITEMS, type CopyMeta, type CopyResult } from './copy-fit.js';
import type { QueryRow } from '../dataset-query.js';
import { hasPopupRenderer } from '../popup-format.js';
import { DATA } from '../constants.js';
import { layerById } from '../../src/registry/index.js';
import { FIELD_SCHEMA } from '../../src/registry/field-schema.js';
import { osmRef, OSM_FID, OSM_NATIVE_FID } from '../../src/registry/osm-fid.js';

export type CopyMode = 'lines' | 'exact' | 'none';

export function copyMode(layerId: string): CopyMode {
  const l = layerById(layerId);
  if (!l?.dataset || !Object.hasOwn(FIELD_SCHEMA, l.dataset) || !l.data?.id) return 'none';
  if (l.data.analysis) return 'lines';
  return l.data.kind === 'geojson' ? 'exact' : 'none';
}

/** true / false; null when the line files could not be read this time (asked again on the next sync). */
export async function copyAvailable(layerId: string): Promise<boolean | null> {
  const mode = copyMode(layerId);
  if (mode === 'exact') return true;
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

export async function copyRows(layerId: string, rows: readonly QueryRow[], layerName: string): Promise<CopyResult> {
  const mode = copyMode(layerId);
  const owner = layerById(layerId);
  if (mode === 'none' || !owner) return { kind: 'refused', reason: 'not-copyable' };
  const usable = rows.filter(r => r.id !== null);
  if (usable.length > MAX_COPY_ITEMS) return { kind: 'refused', reason: 'too-many' };
  if (!usable.length) return { kind: 'refused', reason: 'empty' };
  const src = owner.mapLayerIds.find(hasPopupRenderer) ?? owner.mapLayerIds[0];

  if (mode === 'lines') {
    const m = await import('../lines/line-copy.js');
    return m.copyLines(layerId, usable.map(r => ({
      fid: r.id!, mapLayerId: owner.mapLayerIds[0],
      properties: { ...r.feature.properties }, tileGeometry: r.feature.geometry,
    })), layerName);
  }

  const mm = await manifestMeta(owner.dataset!);
  const attribution = creditText(owner.data!.credit);
  const label = mm.label ?? owner.label ?? layerId;
  const idField = owner.data!.id!.field;
  const isOsm = owner.data!.id === OSM_FID || owner.data!.id === OSM_NATIVE_FID;
  const features = usable.map((r): GeoJSON.Feature => {
    const f = structuredClone(r.feature);
    const props = Object.fromEntries(Object.entries(f.properties ?? {}).filter(([k]) => !k.startsWith('__')));
    const ref = isOsm ? osmRef(r.id) : null;
    return {
      type: 'Feature',
      geometry: f.geometry,
      properties: {
        ...props,
        [idField]: r.id,
        source: label,
        attribution,
        ...(mm.licence && { licence: mm.licence }),
        ...(mm.url && { source_url: mm.url }),
        ...(ref && { osm: `https://www.openstreetmap.org/${ref.type}/${ref.id}` }),
        __src: src,
      },
    };
  });
  const meta: CopyMeta = { label, attribution, licence: mm.licence, url: mm.url, dataset: owner.dataset };
  return commitCopy(features, meta, layerId, layerName, 0);
}

/** Test support: forget the fetched manifest. */
export function resetCopyManifest() { manifest = null; }
