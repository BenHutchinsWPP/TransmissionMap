// ─── Copy lines and polygons to My Data with full geometry (lazy chunk) ──────
// Role: a popup's feature or a table's checked rows of a layer with
//       `data.analysis` → My Data features carrying the GeoParquet geometry
//       (line-read.ts) merged with the tile feature's properties, plus `source`,
//       `attribution`, `licence` and, for OSM, an `osm` link. A line the files
//       cannot give (not-found, offline, timeout, stale-build) keeps its tile
//       geometry, marked `geometry_source: "simplified from map tiles"` (a
//       `searchHint` point only sizes a selection's search box, never becomes
//       geometry). A polygon never does: with no tile fallback (a polygon tile
//       piece is clipped) an item the files cannot give is left out and counted
//       in `missing`, as is a columns-file row (no tile geometry) the files lack
//       (`unread` instead when the read itself failed).
//       Nothing found: the read's own failure (timeout, offline, stale-build)
//       when there was one, else `not-found`; with no files at all
//       (`unavailable`) the copy is refused. Caps: MAX_SELECTION (1,000) lines, MAX_COPY_CHARS
//       (1.5 MB) of GeoJSON, and the projected `tm-user-data` payload at most
//       MAX_STORE_CHARS (4 MB) — over a size cap the result is a `download`
//       (a GeoJSON file with the attribution and licence as
//       foreign members). My Data is its own store: a copy persists as an import
//       does, with no `url:write` and no undo step.
// Deps: line-read.ts, user-data/copy-fit.ts (the caps, the download, commitCopy;
//       re-exported here with showCopyResult), src/registry (layerById),
//       src/registry/osm-fid.ts (osmRef). Imported only dynamically: popup.ts,
//       user-data/copy-rows.ts.

import { lineGeometry, selectionGeometry, lineDataset, MAX_SELECTION, type Bbox } from './line-read.js';
import { commitCopy, SIMPLIFIED, type CopyItem, type CopyRefusal, type CopyResult } from '../user-data/copy-fit.js';
import { layerById } from '../../src/registry/index.js';
import { osmRef, OSM_FID, OSM_NATIVE_FID } from '../../src/registry/osm-fid.js';

export { MAX_COPY_CHARS, SIMPLIFIED, showCopyResult, type CopyItem, type CopyResult } from '../user-data/copy-fit.js';

/** The bbox of the items' tile geometries and search hints (a selection read's search window), padded by 1e-6° so a micro-degree coordinate rounded outward still falls inside. Pure. */
const PAD = 1e-6;
export function itemsBbox(items: CopyItem[]): Bbox {
  const bb: Bbox = [Infinity, Infinity, -Infinity, -Infinity];
  const walk = (c: unknown): void => {
    if (Array.isArray(c) && typeof c[0] === 'number') {
      bb[0] = Math.min(bb[0], c[0]); bb[1] = Math.min(bb[1], c[1] as number);
      bb[2] = Math.max(bb[2], c[0]); bb[3] = Math.max(bb[3], c[1] as number);
    } else if (Array.isArray(c)) c.forEach(walk);
  };
  for (const it of items) {
    const g = it.tileGeometry ?? it.searchHint;
    if (g && 'coordinates' in g) walk(g.coordinates);
  }
  if (bb.every(Number.isFinite)) { bb[0] -= PAD; bb[1] -= PAD; bb[2] += PAD; bb[3] += PAD; }
  return bb;
}

const isPolygon = (g: GeoJSON.Geometry | null | undefined) => g?.type === 'Polygon' || g?.type === 'MultiPolygon';

/** Copy `items` of registry layer `layerId`; `layerName` puts them in a new My Data layer. */
export async function copyLines(layerId: string, items: CopyItem[], layerName?: string): Promise<CopyResult> {
  if (items.length > MAX_SELECTION) return { kind: 'refused', reason: 'too-many' };
  const geoms = new Map<string, GeoJSON.Geometry>();
  let readFailure: CopyRefusal | null = null;   // a read that failed, as opposed to an id the files lack
  if (items.length === 1) {
    const got = await lineGeometry(layerId, items[0].fid);
    if (got.ok) geoms.set(String(items[0].fid), got.result);
    else if (got.reason === 'unavailable') return { kind: 'refused', reason: got.reason };
    else if (got.reason !== 'not-found') readFailure = got.reason;
  } else {
    const got = await selectionGeometry(layerId, items.map(i => i.fid), itemsBbox(items));
    if (got.ok) for (const [k, g] of got.result.geometries) geoms.set(k, g);
    else if (got.reason === 'unavailable' || got.reason === 'too-many') return { kind: 'refused', reason: got.reason };
    else readFailure = got.reason;
  }
  const ds = await lineDataset(layerId);
  const meta = ds.ok ? ds.result : null;
  const owner = layerById(layerId);
  const idField = owner?.data?.id?.field ?? 'id';
  const isOsm = owner?.data?.id === OSM_FID || owner?.data?.id === OSM_NATIVE_FID;
  const polygons = meta?.geometry === 'polygon';
  let simplified = 0, missing = 0, unread = 0;
  const features: GeoJSON.Feature[] = [];
  for (const it of items) {
    const full = geoms.get(String(it.fid));
    const fallback = polygons || isPolygon(it.tileGeometry) ? null : it.tileGeometry;
    if (!full && !fallback) { if (readFailure) unread++; else missing++; continue; }
    if (!full) simplified++;
    const ref = isOsm ? osmRef(it.fid) : null;
    features.push({
      type: 'Feature',
      geometry: full ?? fallback!,
      properties: {
        ...it.properties,
        [idField]: it.fid,
        source: meta?.label ?? owner?.label ?? layerId,
        ...(meta && { attribution: meta.attribution, licence: meta.licence }),
        ...(ref && { osm: `https://www.openstreetmap.org/${ref.type}/${ref.id}` }),
        ...(!full && { geometry_source: SIMPLIFIED }),
        __src: it.mapLayerId,
      },
    });
  }
  if (!features.length) return { kind: 'refused', reason: readFailure ?? 'not-found' };
  return commitCopy(features, meta, layerId, layerName, simplified, missing, unread);
}
