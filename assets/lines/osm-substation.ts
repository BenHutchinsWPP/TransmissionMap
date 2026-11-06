// ─── OSM substation names by stable id (lazy, with ui-line.ts) ───────────────
// Role: the name of the OSM substation at a chain end (line-read.ts Chain
//   startSub / endSub, an OSM fid) whether or not the map has its tiles loaded.
//   Reads the substation points archive (DATA.osm_substations_points: every
//   substation at every zoom, each substation way as its centroid under the
//   way's own fid) at its max zoom, only the tiles within NEAR_M of the chain
//   end (1–4 small tiles); a chain end lies within 150 m of a point or inside
//   the polygon (scripts/build_line_parquet.py SUB_POINT_M).
//   osmSubstationName(fid, at)   → the name, or null (no name, not found, or the
//                                  archive could not be read); cached per fid
//   tilesAround(at, z, m)        the [z, x, y] tiles meeting the box m metres around `at` (pure)
//   nameIn(tile, fid)            the name of feature `fid` in a decoded tile (pure)
// Deps: pmtiles, @mapbox/vector-tile + pbf (the tile decoder, this chunk only),
//   constants.ts (DATA), elevation/terrarium.ts (tileForLngLat). Imported by: ui/ui-line.ts.

import { PMTiles } from 'pmtiles';
import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';
import { DATA } from '../constants.js';
import { tileForLngLat } from '../elevation/terrarium.js';

export const NEAR_M = 1500;

let archive: PMTiles | null = null;
const names = new Map<number, Promise<string | null>>();

/** The tiles at zoom z meeting the box m metres around `at`. Pure. */
export function tilesAround(at: number[], z: number, m: number): [number, number, number][] {
  const dLat = m / 111_320, dLng = dLat / Math.max(0.01, Math.cos((at[1] * Math.PI) / 180));
  const a = tileForLngLat(at[0] - dLng, Math.min(85, at[1] + dLat), z);
  const b = tileForLngLat(at[0] + dLng, Math.max(-85, at[1] - dLat), z);
  const out: [number, number, number][] = [];
  for (let x = a.x; x <= b.x; x++) for (let y = a.y; y <= b.y; y++) out.push([z, x, y]);
  return out;
}

interface TileLike { layers: Record<string, { length: number; feature(i: number): { id?: number; properties: Record<string, unknown> } }> }

/** The name of the feature with id `fid` in a decoded tile, or null. Pure. */
export function nameIn(tile: TileLike, fid: number): string | null {
  for (const layer of Object.values(tile.layers)) {
    for (let i = 0; i < layer.length; i++) {
      const f = layer.feature(i);
      if (f.id === fid && typeof f.properties.name === 'string' && f.properties.name.trim()) return f.properties.name;
    }
  }
  return null;
}

async function lookupName(fid: number, at: number[]): Promise<string | null> {
  archive ??= new PMTiles(DATA.osm_substations_points);
  const z = (await archive.getHeader()).maxZoom;
  for (const [tz, x, y] of tilesAround(at, z, NEAR_M)) {
    const got = await archive.getZxy(tz, x, y);
    if (!got?.data) continue;
    const name = nameIn(new VectorTile(new PbfReader(new Uint8Array(got.data))), fid);
    if (name) return name;
  }
  return null;
}

export function osmSubstationName(fid: number, at: number[]): Promise<string | null> {
  let p = names.get(fid);
  if (!p) {
    p = lookupName(fid, at).catch(() => { names.delete(fid); return null; });
    names.set(fid, p);
  }
  return p;
}
