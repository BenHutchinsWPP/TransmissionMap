// assets/download-packs.ts — a layer's `downloads` → the links its Download menu
// offers: the continent table, pack naming and the Release URL. Pure; no DOM, no
// i18n — a link carries its continent's label key and the row builder translates it.
// Deps: constants.ts (RELEASES_ORIGIN), src/types.ts (LayerDef, type only).
// Consumed by ui/ui-layer-rows.ts (the row's Download menu).
// download-packs.test.ts holds the continent codes and continental packs to
// scripts/build_releases.py and scripts/release_manifest.yaml.

import { RELEASES_ORIGIN } from './constants.js';
import type { LayerDef } from '../src/types.js';

/** labelKey: the continent's i18n key, present only on a continental pack's links. */
export interface PackLink { labelKey?: string; url: string }
/** label: the format's menu text ("CSV", "GeoJSON", "SHP", "GeoTIFF"). */
export interface PackFormat { label: string; links: PackLink[] }

// Geofabrik continents, in the order the packs are built — the same codes as
// scripts/build_releases.py CONTINENT_CODES.
const CONTINENTS = [
  { code: 'na', labelKey: 'region.northAmerica' },
  { code: 'eu', labelKey: 'region.europe' },
  { code: 'as', labelKey: 'region.asia' },
  { code: 'sa', labelKey: 'region.southAmerica' },
  { code: 'af', labelKey: 'region.africa' },
  { code: 'oc', labelKey: 'region.oceania' },
  { code: 'ca', labelKey: 'region.centralAmerica' },
  { code: 'an', labelKey: 'region.antarctica' },
];

const FORMATS = [['csv', 'CSV'], ['geojson', 'GeoJSON'], ['shp', 'SHP'], ['tif', 'GeoTIFF']] as const;

// Registry entries name packs by repo-relative path. In prod that maps to a flat
// Release asset name; in dev (origin "") it stays a path the Vite server serves from disk.
const packUrl = (path: string, origin: string) =>
  origin ? origin + path.replace(/^data\/releases\//, '') : path;

// Every OSM-derived pack is built per continent: Geofabrik's continental
// extracts are the pipeline's unit of work, and a download is a file someone
// opens in QGIS, so each format (CSV, GeoJSON, SHP) ships one archive per
// continental code. Non-OSM packs are single-file and stay flat links.
// The continent code sits ahead of the format suffix:
//   osm-transmission-lines.zip      → osm-transmission-lines-eu.zip
//   osm-transmission-lines-shp.zip  → osm-transmission-lines-eu-shp.zip
const coded = (path: string, code: string) =>
  path.replace(/(-shp)?\.zip$/, (_m, shp = '') => `-${code}${shp}.zip`);

/** The formats a layer's Download menu offers, in menu order; [] means no button. */
export function packLinks(downloads: LayerDef['downloads'], origin = RELEASES_ORIGIN): PackFormat[] {
  const out: PackFormat[] = [];
  for (const [key, label] of FORMATS) {
    const path = downloads[key];
    if (!path) continue;
    const links = path.includes('data/releases/osm-')
      ? CONTINENTS.map(c => ({ labelKey: c.labelKey, url: packUrl(coded(path, c.code), origin) }))
      : [{ url: packUrl(path, origin) }];
    out.push({ label, links });
  }
  return out;
}
