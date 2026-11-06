// The OSM stable id. `fid` = osm_id × 10 + type digit (1 node, 2 way,
// 3 relation), built by scripts/osm_common.py osm_fid(). OSM_NATIVE_FID and
// OSM_FID are the one `data.id` declaration each OSM layer shares — the only
// instances: view-validate.ts tells an OSM id by reference (`===`), so never
// copy or re-declare them. osmRef() decodes a fid into the openstreetmap.org
// object. Pure.
//
// Deps: src/types.ts (FeatureIdDecl).
// Consumed by: src/registry/{generators,pipelines,regions,transmission}.ts
// (the decls), view-validate.ts (decls + osmRef), assets/popup-format.ts (osmRef).

import type { FeatureIdDecl } from '../types.js';

// The vector archives carry the fid as the native MVT feature id; the GeoJSON
// files carry it as a property MapLibre promotes.
export const OSM_NATIVE_FID: FeatureIdDecl = { field: "fid", native: true };
export const OSM_FID: FeatureIdDecl = { field: "fid" };

export type OsmRef = { type: "node" | "way" | "relation"; id: number };
const OSM_TYPES = [undefined, "node", "way", "relation"] as const;

/** An OSM `fid` (number or digit string) → its element type and OSM id, or
 *  null when it is not one: last digit 1/2/3, osm id >= 1, below 2^53. */
export function osmRef(fid: unknown): OsmRef | null {
  const n = typeof fid === "number" ? fid : typeof fid === "string" && /^\d+$/.test(fid) ? Number(fid) : NaN;
  if (!Number.isSafeInteger(n) || n < 11) return null;
  const type = OSM_TYPES[n % 10];
  return type ? { type, id: Math.floor(n / 10) } : null;
}
