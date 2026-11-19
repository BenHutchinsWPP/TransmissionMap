// ─── OSM substation names and points by stable id or place (lazy) ────────────
// Role: reads of a points archive, whether or not the map has its tiles loaded.
//   Names: the OSM substation at a chain end (line-read.ts Chain startSub /
//   endSub, an OSM fid). Points: the max-zoom point of a feature, for
//   copy-rows.ts (any point archive, by DATA key). Near: every substation point
//   around a place, for the route planner's OSM snap. Names:
//   Reads the substation points archive (DATA.osm_substations_points: every
//   substation at every zoom, each substation way as its centroid under the
//   way's own fid) at its max zoom, only the tiles within NEAR_M of the chain
//   end (1–4 small tiles); a chain end lies within 150 m of a point or inside
//   the polygon (scripts/build_line_parquet.py SUB_POINT_M).
//   osmSubstationName(fid, at)   → the name, or null (no name, not found, or the
//                                  archive could not be read); cached per fid
//   tilesAround(at, z, m)        the [z, x, y] tiles meeting the box m metres around `at` (pure)
//   nameIn(tile, fid)            the name of feature `fid` in a decoded tile (pure)
//   archiveMaxZoom(key)          a point archive's (DATA key) max zoom
//   pointsByFid(key, wanted)     the max-zoom point of each wanted fid, read from the tiles
//                                around its drawn point, at most MAX_COPY_TILES distinct
//                                tiles per call; the rest are left out
//   pointIn(tile, x, y, z, fid)  the [lng, lat] of point feature `fid` in a decoded tile (pure)
//   substationPointsIn(tile, x, y, z)  every point feature of a decoded tile as an OsmPoint (pure)
//   substationPointsNear(at, m)  the substation points within the box m metres around `at`,
//                                read at the highest zoom (≤ the archive's max) whose box needs
//                                ≤ NEAR_TILES tiles (the archive keeps every point at every zoom),
//                                at most MAX_SNAP_TILES tiles; decoded tiles held in a cache of
//                                SNAP_CACHE tiles, oldest out; rejects when the archive cannot be read
// Deps: pmtiles, @mapbox/vector-tile + pbf (the tile decoder, this chunk only),
//   constants.ts (DATA), elevation/terrarium.ts (tileForLngLat), route/snap.ts (osmKv, OsmPoint).
//   Imported by: ui/ui-line.ts (names), user-data/copy-rows.ts (points),
//   ui/substation-index.ts (near), all dynamically.

import { PMTiles } from 'pmtiles';
import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';
import { DATA } from '../constants.js';
import type { DataKey } from '../../src/types.js';
import { tileForLngLat } from '../elevation/terrarium.js';
import { osmKv, type OsmPoint } from '../route/snap.js';

export const NEAR_M = 1500;

export const MAX_COPY_TILES = 20;
const archives = new Map<string, PMTiles>();
const archiveOf = (key: DataKey) => {
  let a = archives.get(key);
  if (!a) { a = new PMTiles(DATA[key] as string); archives.set(key, a); }
  return a;
};
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
  const archive = archiveOf('osm_substations_points');
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

interface PointTile { layers: Record<string, { length: number; feature(i: number): { id?: number; type: number;
  properties?: Record<string, unknown>; toGeoJSON(x: number, y: number, z: number): { geometry: { type: string; coordinates: unknown } } } }> }

/** The [lng, lat] of the point feature with id `fid` in the decoded tile z/x/y, or null. Pure. */
export function pointIn(tile: PointTile, x: number, y: number, z: number, fid: string | number): [number, number] | null {
  for (const layer of Object.values(tile.layers)) {
    for (let i = 0; i < layer.length; i++) {
      const f = layer.feature(i);
      if (f.id === undefined || String(f.id) !== String(fid)) continue;
      const g = f.toGeoJSON(x, y, z).geometry;
      if (g.type === 'Point') return g.coordinates as [number, number];
    }
  }
  return null;
}

export async function archiveMaxZoom(key: DataKey): Promise<number> {
  return (await archiveOf(key).getHeader()).maxZoom;
}

/** Point archive `key`'s max-zoom point for each wanted fid, read from the tiles within `padM` metres of
 *  its drawn point `at`. Items are taken in order while the distinct tiles stay within MAX_COPY_TILES;
 *  a fid beyond that, or not in its tiles, is absent from the result. Rejects when the archive cannot be read. */
export async function pointsByFid(key: DataKey, wanted: { fid: string | number; at: number[]; padM: number }[]):
  Promise<Map<string, [number, number]>> {
  const archive = archiveOf(key);
  const z = (await archive.getHeader()).maxZoom;
  const plan = new Map<string, [number, number, number]>();
  const perItem: { fid: string | number; tiles: string[] }[] = [];
  for (const w of wanted) {
    const tiles = tilesAround(w.at, z, w.padM);
    const fresh = tiles.filter(t => !plan.has(t.join('/')));
    if (plan.size + fresh.length > MAX_COPY_TILES) continue;
    for (const t of tiles) plan.set(t.join('/'), t);
    perItem.push({ fid: w.fid, tiles: tiles.map(t => t.join('/')) });
  }
  const decoded = new Map<string, PointTile | null>();
  await Promise.all([...plan].map(async ([k, [tz, x, y]]) => {
    const got = await archive.getZxy(tz, x, y);
    decoded.set(k, got?.data ? new VectorTile(new PbfReader(new Uint8Array(got.data))) as unknown as PointTile : null);
  }));
  const out = new Map<string, [number, number]>();
  for (const it of perItem) {
    for (const k of it.tiles) {
      const tile = decoded.get(k);
      if (!tile) continue;
      const [tz, x, y] = plan.get(k)!;
      const p = pointIn(tile, x, y, tz, it.fid);
      if (p) { out.set(String(it.fid), p); break; }
    }
  }
  return out;
}

export const NEAR_TILES = 4;
export const MAX_SNAP_TILES = 16;
export const SNAP_CACHE = 64;
const snapTiles = new Map<string, Promise<OsmPoint[]>>();

/** Every point feature of the decoded tile z/x/y with a feature id, as an OsmPoint. Pure. */
export function substationPointsIn(tile: PointTile, x: number, y: number, z: number): OsmPoint[] {
  const out: OsmPoint[] = [];
  for (const layer of Object.values(tile.layers)) {
    for (let i = 0; i < layer.length; i++) {
      const f = layer.feature(i);
      if (f.id === undefined || f.type !== 1) continue;
      const g = f.toGeoJSON(x, y, z).geometry;
      if (g.type !== 'Point') continue;
      const p = f.properties ?? {};
      const str = (v: unknown) => (typeof v === 'string' ? v : null);
      out.push({
        fid: f.id, lngLat: g.coordinates as [number, number], name: str(p.name), kv: osmKv(p.nominal_kv),
        subType: str(p.sub_type), countries: str(p.countries),
      });
    }
  }
  return out;
}

/** Test support: forget the decoded snap tiles. */
export function _resetSnapTiles(): void { snapTiles.clear(); }

function snapTile(archive: PMTiles, z: number, x: number, y: number): Promise<OsmPoint[]> {
  const k = `${z}/${x}/${y}`;
  const held = snapTiles.get(k);
  if (held) { snapTiles.delete(k); snapTiles.set(k, held); return held; }
  const p = archive.getZxy(z, x, y).then((got) =>
    got?.data ? substationPointsIn(new VectorTile(new PbfReader(new Uint8Array(got.data))) as unknown as PointTile, x, y, z) : []);
  p.catch(() => { if (snapTiles.get(k) === p) snapTiles.delete(k); });
  snapTiles.set(k, p);
  while (snapTiles.size > SNAP_CACHE) snapTiles.delete(snapTiles.keys().next().value!);
  return p;
}

/** The OSM substation points in the tiles meeting the box m metres around `at`. Rejects when the archive
 *  cannot be read. */
export async function substationPointsNear(at: [number, number], m: number): Promise<OsmPoint[]> {
  const archive = archiveOf('osm_substations_points');
  const h = await archive.getHeader();
  const lo = Math.max(0, h.minZoom ?? 0);
  let z = Math.max(lo, h.maxZoom);
  while (z > lo && tilesAround(at, z, m).length > NEAR_TILES) z--;
  const tiles = tilesAround(at, z, m).slice(0, MAX_SNAP_TILES);
  return (await Promise.all(tiles.map(([tz, x, y]) => snapTile(archive, tz, x, y)))).flat();
}
