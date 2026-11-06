// ─── Route cost categories ────────────────────────────────────────────────────
// Role: groups preset rows (src/registry/route-presets.ts CostRow) into display
//       categories for the route panel's waterfall and "driver" colouring:
//       routeCategory(row) = row.group ?? row.band, with the terrain group split by
//       band (`terrain:landcover`, `terrain:slope`) and an ungrouped bit-flag row
//       (bands flags, flags2, osm_flags, desig) split by the one bit it tests
//       (`flags:3`, `osm_flags:2`; a match that is not a single bit keeps the band key); an
//       uploaded layer's row (bands upl_<hash>, preset-patch.ts add_rows) is `upload`, its own
//       label being the row's note.
//       CATEGORY_LABEL_KEYS maps each
//       known key to its i18n key `route.cat.<key, ':' → '_'>`; categoryLabelKey()
//       falls back to `route.cat.other`. Pure: no DOM, no i18n import.
// Deps: src/registry/route-presets.ts (types only), route-presets.ts (isUploadBand).

import type { CostRow } from '../../src/registry/route-presets.js';
import { isUploadBand } from '../../src/registry/route-presets.js';

/** Groups whose rows are shown per band rather than as one category. */
const SPLIT_GROUPS = new Set(['terrain']);

const BIT_BANDS = new Set(['flags', 'flags2', 'osm_flags', 'desig']);

export function routeCategory(row: CostRow): string {
  if (isUploadBand(row.band)) return 'upload';
  if (row.group === undefined) return BIT_BANDS.has(row.band) && 'bit' in row.match ? `${row.band}:${row.match.bit}` : row.band;
  return SPLIT_GROUPS.has(row.group) ? `${row.group}:${row.band}` : row.group;
}

const KNOWN = [
  'terrain:landcover', 'terrain:slope', 'protection', 'protect', 'military', 'parallel', 'sites', 'wildfire', 'whpclass', 'flags',
  'flags2', 'desig', 'osm_flags', 'adj', 'landcover', 'slope', 'state', 'isoreg', 'bldg', 'built', 'nonres', 'bldgunk', 'other',
  'flags:0', 'flags:1', 'flags:2', 'flags:3', 'flags:4', 'flags:5', 'flags:6', 'flags:7', 'flags2:0', 'flags2:1', 'flags2:2', 'flags2:3', 'flags2:4', 'flags2:5', 'flags2:6', 'flags2:7',
  'osm_flags:0', 'osm_flags:1', 'osm_flags:2', 'osm_flags:3', 'osm_flags:4', 'osm_flags:5', 'osm_flags:6', 'osm_flags:7',
  'desig:0', 'desig:1', 'desig:2', 'desig:3', 'desig:4', 'desig:5', 'desig:6', 'desig:7', 'wetland', 'aviation', 'nfhl', 'upload',
];

export const CATEGORY_LABEL_KEYS: Record<string, string> =
  Object.fromEntries(KNOWN.map((k) => [k, `route.cat.${k.replace(':', '_')}`]));

export const categoryLabelKey = (key: string): string => CATEGORY_LABEL_KEYS[key] ?? CATEGORY_LABEL_KEYS.other;
