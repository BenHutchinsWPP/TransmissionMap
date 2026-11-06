// ─── Route constraints: concerns, rules and colours ──────────────────────────
// Role: the one source of truth for the Routing constraints layer: the concern
//   picker's entries, the cube rule behind each, the "What constrains" overview
//   palette and its index codes, and the Land manager palette. Masks and classes
//   concerns may read the `osm_` bands (`osm_flags`, `adj`); the overview and the
//   land manager read `pd_` bands only. Pure data; no MapLibre or DOM side effects.
// Deps: ./buckets.js (PAD-US / Tribal colours). Read by the layer legend, the
//   route panel, and (as scripts/route_constraints.json, written from
//   `constraintsExport()` by route-constraints.test.ts) the Python tile build, with
//   each class's matching values in scripts/route_constraints_sets.json (`constraintsSets()`).
// Band numbers, bit meanings and agency codes mirror scripts/route_grid.py;
//   route-constraints.test.ts checks every rule against the committed cube grid.json.

import { PADUS_CLASS_BUCKETS, TRIBAL_BUCKETS, PADUS_CLASS_DEFAULT } from './buckets.js';

/** A cell test on one cube band (pd_, or osm_ for `osm_flags` / `adj`). `bit`: that bit is set. `values`: (band & mask) is one of them (mask default: all bits). */
export type ConstraintRule =
  | { band: string; bit: number }
  | { band: string; values: number[]; mask?: number };

export type ConcernGroup =
  'overview' | 'land' | 'protection' | 'wildlife' | 'hazards' | 'sites' | 'population' | 'corridors';
export type ConcernKind = 'overview' | 'categorical' | 'mask' | 'classes';

/** One shaded class of a `classes` concern; a higher `code` draws on top. Class value sets never overlap. */
export interface ConcernClass {
  id: string;
  labelKey: string;
  colour: string;
  rules: ConstraintRule[];
  /** index-raster code, 1..255 */
  code: number;
}

/** Cube bands that come from the `osm_` files; a concern reading one is an OSM concern. */
export const OSM_RULE_BANDS: readonly string[] = ['osm_flags', 'osm_maxkv', 'adj'];

export interface Concern {
  id: string;
  group: ConcernGroup;
  labelKey: string;
  kind: ConcernKind;
  /** masks only */
  rule?: ConstraintRule;
  /** masks only */
  colour?: string;
  /** classes only, highest code first */
  classes?: ConcernClass[];
  /** classes only: `max` for ordinal classes, `mode` for nominal ones */
  resampling?: 'max' | 'mode';
  noteKey?: string;
}

const padus = (id: string): string => {
  const b = PADUS_CLASS_BUCKETS.find(x => x.id === id);
  if (!b) throw new Error(`route-constraints: no PAD-US bucket ${id}`);
  return b.color;
};
const TRIBAL = TRIBAL_BUCKETS.find(x => x.id === 'reservation')!.color;

// ─── "What constrains" overview ───────────────────────────────────────────────
// Index raster codes: where classes overlap, a cell can draw only one, so each
// class has a fixed draw order: the first entry takes the highest code, and the
// overview's `max` resampling keeps that code. Draw order is a rendering rule,
// not a ranking of the land, and no visitor-facing text explains it.
// CONSTRAINT_PALETTE is in draw order (index 0 drawn on top); code = length - index:
//   9 tribal · 8 military · 7 WSA · 6 GAP 1-2 · 5 critical habitat · 4 PHMA
//   · 3 sites · 2 floodplain · 1 other federal · 0 none (transparent).
export interface ConstraintClass {
  id: string;
  /** index-raster code, 1 (drawn under) .. length (drawn on top) */
  code: number;
  labelKey: string;
  colour: string;
  /** the cell is in this class when ANY rule matches */
  rules: ConstraintRule[];
  noteKey?: string;
}

// protect b3: GAP int 1-4 in bits 0-2 (mask 0b111); bit 7 = NPS unit named Preserve (nps-preserve). Agencies 2-5, 7-9: BLM, USFS, NPS, FWS, DOE, BOR, other federal.
const PALETTE_SRC: Omit<ConstraintClass, 'code'>[] = [
  { id: 'tribal', labelKey: 'route.class.tribal', colour: '#7c3aed', rules: [{ band: 'flags', bit: 0 }] },
  { id: 'military', labelKey: 'route.concern.military', colour: '#dc2626', rules: [{ band: 'flags', bit: 1 }],
    noteKey: 'route.concern.noteMilitary' },
  { id: 'wsa', labelKey: 'route.concern.wsa', colour: '#2b4595', rules: [{ band: 'desig', bit: 0 }] },
  { id: 'gap-1-2', labelKey: 'route.concern.gap-1-2', colour: '#5bbe71',
    rules: [{ band: 'protect', values: [1, 2], mask: 0b111 }] },
  { id: 'critical-habitat', labelKey: 'route.concern.critical-habitat', colour: '#f38038', rules: [{ band: 'flags', bit: 3 }] },
  { id: 'phma', labelKey: 'route.concern.phma', colour: '#f362dd', rules: [{ band: 'flags2', bit: 0 }] },
  { id: 'sites', labelKey: 'route.class.sites', colour: '#7f2502',
    rules: [{ band: 'flags2', bit: 3 }, { band: 'flags2', bit: 4 }] },
  { id: 'floodplain', labelKey: 'route.concern.floodplain', colour: '#a6cee3', rules: [{ band: 'nfhl', values: [2] }] },
  { id: 'other-federal', labelKey: 'route.class.other-federal', colour: '#758595',
    rules: [{ band: 'agency', values: [2, 3, 4, 5, 7, 8, 9] }] },
];
export const CONSTRAINT_PALETTE: readonly ConstraintClass[] = PALETTE_SRC.map((c, i) => ({
  ...c, code: PALETTE_SRC.length - i,
}));

// ─── Land manager (who manages the cell → PAD-US colours) ─────────────────────
// Listed in draw order (index 0 drawn on top); code = length - index, so the
// index raster's highest code draws where managers overlap. Tribal and DOD also read the pd flags
// bits (0 tribal, 1 PAD-US military), which cover far more cells than the agency band;
// the rest are agency-band codes, one agency per cell. Code 1 (private/none) draws
// transparent. 7-9 share one slate.
export interface LandManagerClass {
  id: string; labelKey: string; colour: string;
  /** the cell is this manager when ANY rule matches */
  rules: ConstraintRule[];
  /** index-raster code, 1 (drawn under) .. length (drawn on top) */
  code: number;
}
const LM_SRC: Omit<LandManagerClass, 'code'>[] = [
  { id: 'tribal', labelKey: 'route.class.tribal', colour: TRIBAL,
    rules: [{ band: 'flags', bit: 0 }, { band: 'agency', values: [12] }] },
  { id: 'dod', labelKey: 'route.class.dod', colour: padus('military'),
    rules: [{ band: 'flags', bit: 1 }, { band: 'agency', values: [6] }] },
  { id: 'blm', labelKey: 'route.class.blm', colour: padus('blm'), rules: [{ band: 'agency', values: [2] }] },
  { id: 'usfs', labelKey: 'route.class.usfs', colour: padus('forest'), rules: [{ band: 'agency', values: [3] }] },
  { id: 'nps', labelKey: 'route.class.nps', colour: padus('park'), rules: [{ band: 'agency', values: [4] }] },
  { id: 'fws', labelKey: 'route.class.fws', colour: padus('refuge'), rules: [{ band: 'agency', values: [5] }] },
  { id: 'state', labelKey: 'route.class.state', colour: padus('state'), rules: [{ band: 'agency', values: [10] }] },
  { id: 'local', labelKey: 'route.class.local', colour: padus('local'), rules: [{ band: 'agency', values: [11] }] },
  { id: 'other-federal', labelKey: 'route.class.other-federal', colour: PADUS_CLASS_DEFAULT,
    rules: [{ band: 'agency', values: [7, 8, 9] }] },
  { id: 'ngo', labelKey: 'route.class.ngo', colour: padus('conserv'), rules: [{ band: 'agency', values: [13] }] },
];
export const LAND_MANAGER_PALETTE: readonly LandManagerClass[] = LM_SRC.map((c, i) => ({
  ...c, code: LM_SRC.length - i,
}));

// ─── Concerns (the picker) ────────────────────────────────────────────────────
const mask = (id: string, group: ConcernGroup, rule: ConstraintRule, colour: string, noteKey?: string): Concern =>
  ({ id, group, labelKey: `route.concern.${id}`, kind: 'mask', rule, colour, ...(noteKey ? { noteKey } : {}) });
const range = (lo: number, hi: number): number[] => Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
/** A classes concern; `src` is listed highest code first and gets codes length..1. */
const classes = (
  id: string, group: ConcernGroup, resampling: 'max' | 'mode',
  src: { id: string; colour: string; rules: ConstraintRule[] }[], noteKey?: string,
): Concern => ({
  id, group, labelKey: `route.concern.${id}`, kind: 'classes', resampling,
  classes: src.map((c, i) => ({ ...c, labelKey: `route.concern.${id}.${c.id}`, code: src.length - i })),
  ...(noteKey ? { noteKey } : {}),
});
const overview = (id: string, group: ConcernGroup, kind: ConcernKind): Concern =>
  ({ id, group, labelKey: `route.concern.${id}`, kind });
const cls = (id: string): string => CONSTRAINT_PALETTE.find(c => c.id === id)!.colour;

export const CONCERNS: readonly Concern[] = [
  overview('what-constrains', 'overview', 'overview'),
  overview('land-manager', 'land', 'categorical'),
  mask('tribal', 'land', { band: 'flags', bit: 0 }, TRIBAL),
  // NLCD classes, one per code group the routing rows use; nominal, so a low-zoom cell shows the most common class.
  classes('landcover', 'land', 'mode', [
    { id: 'water', colour: '#466b9f', rules: [{ band: 'landcover', values: [11] }] },
    { id: 'ice-snow', colour: '#d1def8', rules: [{ band: 'landcover', values: [12] }] },
    { id: 'developed-high', colour: '#ab0000', rules: [{ band: 'landcover', values: [24] }] },
    { id: 'developed-low-med', colour: '#d99282', rules: [{ band: 'landcover', values: [22, 23] }] },
    { id: 'forest', colour: '#38814e', rules: [{ band: 'landcover', values: [41, 42, 43] }] },
    { id: 'wetland', colour: '#6c9fb8', rules: [{ band: 'landcover', values: [90, 95] }] },
    { id: 'barren', colour: '#b3ac9f', rules: [{ band: 'landcover', values: [31] }] },
    { id: 'crops', colour: '#ab6c28', rules: [{ band: 'landcover', values: [82] }] },
    { id: 'other', colour: '#dfdfc2', rules: [{ band: 'landcover', values: [21, 52, 71, 81] }] },
  ], 'route.concern.noteLandcoverPnas'),
  mask('osm-lake', 'land', { band: 'osm_flags', bit: 0 }, '#2563eb'),
  // isoreg b11 (scripts/route_grid.py ISO_CODES): the cost-region input of the regional multipliers; nominal.
  classes('isoreg', 'land', 'mode', [
    { id: 'teppc', colour: '#16a34a', rules: [{ band: 'isoreg', values: [1] }] },
    { id: 'caiso', colour: '#f59e0b', rules: [{ band: 'isoreg', values: [2] }] },
    { id: 'miso', colour: '#2563eb', rules: [{ band: 'isoreg', values: [3] }] },
    { id: 'spp', colour: '#dc2626', rules: [{ band: 'isoreg', values: [4] }] },
    { id: 'ercot', colour: '#7c3aed', rules: [{ band: 'isoreg', values: [5] }] },
    { id: 'pjm', colour: '#0891b2', rules: [{ band: 'isoreg', values: [6] }] },
    { id: 'nyiso', colour: '#db2777', rules: [{ band: 'isoreg', values: [7] }] },
    { id: 'isone', colour: '#84cc16', rules: [{ band: 'isoreg', values: [8] }] },
    { id: 'southeast', colour: '#a16207', rules: [{ band: 'isoreg', values: [9] }] },
  ]),
  // landval b12: county farmland $/acre, code = 1 + 16 log2($/100); class edges at about $1,000, $5,000 and $25,000.
  classes('landval', 'land', 'max', [
    { id: '4', colour: '#78350f', rules: [{ band: 'landval', values: range(128, 255) }] },
    { id: '3', colour: '#d97706', rules: [{ band: 'landval', values: range(91, 127) }] },
    { id: '2', colour: '#fcd34d', rules: [{ band: 'landval', values: range(54, 90) }] },
    { id: '1', colour: '#fef3c7', rules: [{ band: 'landval', values: range(1, 53) }] },
  ]),
  classes('gap-1-2', 'protection', 'max', [
    { id: 'gap-1', colour: '#1b7837', rules: [{ band: 'protect', values: [1], mask: 0b111 }] },
    { id: 'gap-2', colour: '#5bbe71', rules: [{ band: 'protect', values: [2], mask: 0b111 }] },
  ]),
  mask('gap-3', 'protection', { band: 'protect', values: [3], mask: 0b111 }, padus('conserv')),
  // protect b3 bits 4-5: TNC category 1-3 (PoPWest), inside its study area only.
  classes('tnc', 'protection', 'max', [
    { id: 'cat-1', colour: '#7f1d1d', rules: [{ band: 'protect', values: [16], mask: 0b110000 }] },
    { id: 'cat-2', colour: '#d9622b', rules: [{ band: 'protect', values: [32], mask: 0b110000 }] },
    { id: 'cat-3', colour: '#f2c14e', rules: [{ band: 'protect', values: [48], mask: 0b110000 }] },
  ], 'route.concern.noteTnc'),
  mask('wsa', 'protection', { band: 'desig', bit: 0 }, cls('wsa')),
  mask('wilderness-np', 'protection', { band: 'desig', bit: 7 }, '#166534'),
  mask('nps-preserve', 'protection', { band: 'protect', values: [128], mask: 128 }, '#5f8f2b'),
  mask('acec', 'protection', { band: 'desig', bit: 3 }, padus('blm')),
  mask('ira', 'protection', { band: 'desig', bit: 2 }, padus('forest')),
  mask('nm-nca', 'protection', { band: 'desig', bit: 1 }, padus('park')),
  mask('wsr', 'protection', { band: 'desig', bit: 4 }, padus('refuge')),
  mask('nht-nst', 'protection', { band: 'desig', bit: 5 }, '#a16207'),
  mask('other-special', 'protection', { band: 'desig', bit: 6 }, '#758595'),
  mask('park', 'protection', { band: 'flags', bit: 6 }, padus('local')),
  mask('critical-habitat', 'wildlife', { band: 'flags', bit: 3 }, cls('critical-habitat')),
  mask('phma', 'wildlife', { band: 'flags2', bit: 0 }, cls('phma')),
  mask('ghma', 'wildlife', { band: 'flags2', bit: 1 }, '#c026d3'),
  mask('floodplain', 'hazards', { band: 'flags2', bit: 2 }, cls('floodplain')),
  // nfhl b19: nominal, so `mode`; 1 = FEMA map in effect and not a special flood hazard area (unshaded here, shaded by fema-flood-map with 2).
  classes('fema-flood', 'hazards', 'mode', [
    { id: 'sfha', colour: '#1d4ed8', rules: [{ band: 'nfhl', values: [2] }] },
    { id: 'no-map', colour: '#9ca3af', rules: [{ band: 'nfhl', values: [3] }] },
  ]),
  mask('fema-flood-map', 'hazards', { band: 'nfhl', values: [1, 2] }, '#bfdbfe'),
  classes('wildfire-high', 'hazards', 'max', [
    { id: 'very-high', colour: '#b91c1c', rules: [{ band: 'whpclass', values: [5] }] },
    { id: 'high', colour: '#f97316', rules: [{ band: 'whpclass', values: [4] }] },
  ]),
  // wildfire b5: WHP continuous 1-255; the PNAS ramp weighs 1 + 4(v-1)/254, so v = 1 carries no weight and is unshaded.
  classes('wildfire-potential', 'hazards', 'max', [
    { id: 'q4', colour: '#7f0000', rules: [{ band: 'wildfire', values: range(192, 255) }] },
    { id: 'q3', colour: '#e34a33', rules: [{ band: 'wildfire', values: range(129, 191) }] },
    { id: 'q2', colour: '#fdbb84', rules: [{ band: 'wildfire', values: range(65, 128) }] },
    { id: 'q1', colour: '#fee8c8', rules: [{ band: 'wildfire', values: range(2, 64) }] },
  ], 'route.concern.noteWildfirePotential'),
  mask('slope-15', 'hazards', { band: 'slope', values: [6, 7, 8] }, '#78716c'),
  classes('slope', 'hazards', 'max', [
    { id: 'mountain', colour: '#8c6d46', rules: [{ band: 'slope', values: range(4, 8) }] },
    { id: 'rolling', colour: '#d6c6a0', rules: [{ band: 'slope', values: [2, 3] }] },
  ]),
  classes('wetland', 'hazards', 'max', [
    { id: 'over-half', colour: '#0e7490', rules: [{ band: 'wetland', values: range(52, 101) }] },
    { id: 'quarter-half', colour: '#67c5d6', rules: [{ band: 'wetland', values: range(27, 51) }] },
  ]),
  mask('occupied-facilities', 'sites', { band: 'flags2', bit: 3 }, cls('sites')),
  mask('nrhp', 'sites', { band: 'flags2', bit: 4 }, cls('sites')),
  mask('superfund', 'sites', { band: 'flags2', bit: 5 }, '#9333ea'),
  mask('fuds', 'sites', { band: 'flags2', bit: 7 }, '#be123c'),
  mask('cbrs', 'sites', { band: 'flags2', bit: 6 }, '#0d9488'),
  mask('tall-structures', 'sites', { band: 'flags', bit: 7 }, '#475569'),
  mask('airfields', 'sites', { band: 'flags', bit: 2 }, '#0284c7'),
  // aviation b18: worst Part 77 screening class of the cell (ordinal, so `max`); code 1 = evaluated: outside the notice extent, no surface below 61 m AGL.
  classes('aviation', 'sites', 'max', [
    { id: 'primary', colour: '#0c4a6e', rules: [{ band: 'aviation', values: [6] }] },
    { id: 'under-30', colour: '#0369a1', rules: [{ band: 'aviation', values: [5] }] },
    { id: '30-46', colour: '#0ea5e9', rules: [{ band: 'aviation', values: [4] }] },
    { id: '46-61', colour: '#7dd3fc', rules: [{ band: 'aviation', values: [3] }] },
    { id: 'notice', colour: '#e0f2fe', rules: [{ band: 'aviation', values: [2] }] },
  ], 'route.concern.noteAviation'),
  mask('military', 'sites', { band: 'flags', bit: 1 }, cls('military'), 'route.concern.noteMilitary'),
  mask('osm-military', 'sites', { band: 'osm_flags', bit: 7 }, '#991b1b'),
  mask('pop-100', 'population', { band: 'flags', bit: 5 }, '#db2777'),
  // bldg b13: 1 + residential structures in the cell (1 = none), so codes 2–255 hold a home.
  classes('homes', 'population', 'max', [
    { id: 'ten-plus', colour: '#b45309', rules: [{ band: 'bldg', values: range(11, 255) }] },
    { id: 'three-nine', colour: '#f59e0b', rules: [{ band: 'bldg', values: range(4, 10) }] },
    { id: 'one-two', colour: '#fde68a', rules: [{ band: 'bldg', values: [2, 3] }] },
  ]),
  mask('buildings', 'population', { band: 'built', values: range(2, 101) }, '#7c3aed', 'route.concern.noteBuildings'),
  mask('nonresidential', 'population', { band: 'nonres', values: range(2, 101) }, '#be185d', 'route.concern.noteBuildings'),
  mask('building-unknown', 'population', { band: 'bldgunk', values: range(2, 101) }, '#64748b', 'route.concern.noteBuildings'),
  mask('building-coverage', 'population', { band: 'built', values: range(1, 101) }, '#0891b2', 'route.concern.noteBuildingCoverage'),
  mask('section-368', 'corridors', { band: 'flags', bit: 4 }, '#0f766e'),
  // osm_flags b1 bit 2: the OSM line >= 230 kV buffer; adj b3: line class in bits 0-1 (>= 230 kV) and 5-6 (100-229 kV).
  mask('existing-line-230', 'corridors', { band: 'osm_flags', bit: 2 }, '#4338ca'),
  mask('parallel-230', 'corridors', { band: 'adj', values: [1, 2], mask: 0b11 }, '#1e3a8a'),
  mask('parallel-100', 'corridors', { band: 'adj', values: [32, 64], mask: 0b1100000 }, '#60a5fa'),
];

export const CONCERN_GROUPS: readonly ConcernGroup[] =
  ['overview', 'land', 'protection', 'wildlife', 'hazards', 'sites', 'population', 'corridors'];
export const concernGroupKey = (g: ConcernGroup): string => `route.concernGroup.${g}`;
/** Shown under the legend when a low-zoom overview is on. */
export const CONCERN_MAX_NOTE_KEY = 'route.concern.noteMax';
/** Shown under the legend of a `mode`-resampled classes concern. */
export const CONCERN_MODE_NOTE_KEY = 'route.concern.noteMode';

export const DEFAULT_CONCERN = 'what-constrains';

export function concernById(id: string): Concern | undefined {
  return CONCERNS.find(c => c.id === id);
}
/** Trust boundary for a URL / stored value. */
export function isConcernId(v: unknown): v is string {
  return typeof v === 'string' && concernById(v) !== undefined;
}

/** The colour that stands for a concern: a mask's, else its highest-code class's. */
export function concernColour(id: string): string {
  const c = concernById(id);
  const col = c?.colour ?? c?.classes?.[0]?.colour;
  if (!col) throw new Error(`route-constraints: concern ${id} has no colour`);
  return col;
}

/** The concern reads an `osm_` band (derived; it is credited to OpenStreetMap). */
export function concernReadsOsm(c: Concern): boolean {
  return [c.rule, ...(c.classes ?? []).flatMap(k => k.rules)].some(r => r !== undefined && OSM_RULE_BANDS.includes(r.band));
}

/** Every label, class, note and group key the registry names (for the locale key test). */
export function concernKeys(): string[] {
  const keys = new Set<string>([CONCERN_MAX_NOTE_KEY, CONCERN_MODE_NOTE_KEY, ...CONCERN_GROUPS.map(concernGroupKey)]);
  for (const c of CONCERNS) {
    keys.add(c.labelKey);
    if (c.noteKey) keys.add(c.noteKey);
    for (const k of c.classes ?? []) keys.add(k.labelKey);
  }
  for (const k of CONSTRAINT_PALETTE) { keys.add(k.labelKey); if (k.noteKey) keys.add(k.noteKey); }
  for (const k of LAND_MANAGER_PALETTE) keys.add(k.labelKey);
  return [...keys].sort();
}

/** One cell value against one rule (the twin of build_route_constraints.py's rule_match). */
export function ruleMatches(r: ConstraintRule, v: number): boolean {
  if ('bit' in r) return ((v >> r.bit) & 1) === 1;
  return r.values.includes(v & (r.mask ?? 0xff));
}

/** The build's view of the above (scripts/route_constraints.json): ids, codes, rules, colours; no labels. */
export function constraintsExport() {
  return {
    default: DEFAULT_CONCERN,
    overview: CONSTRAINT_PALETTE.map(c => ({ id: c.id, code: c.code, colour: c.colour, rules: c.rules })),
    landManager: LAND_MANAGER_PALETTE.map(c => ({ id: c.id, code: c.code, colour: c.colour, rules: c.rules })),
    concerns: CONCERNS.map(c => ({
      id: c.id, group: c.group, kind: c.kind,
      ...(c.rule ? { rule: c.rule } : {}), ...(c.colour ? { colour: c.colour } : {}),
      ...(c.classes ? {
        resampling: c.resampling,
        classes: c.classes.map(k => ({ id: k.id, code: k.code, colour: k.colour, rules: k.rules })),
      } : {}),
    })),
  };
}

/** scripts/route_constraints_sets.json: concern id → class id (`mask` for a mask) → the sorted values 0..255 its rules match. */
export function constraintsSets(): Record<string, Record<string, number[]>> {
  const set = (rules: ConstraintRule[]) =>
    Array.from({ length: 256 }, (_, v) => v).filter(v => rules.some(r => ruleMatches(r, v)));
  return Object.fromEntries(CONCERNS.flatMap(c =>
    c.rule ? [[c.id, { mask: set([c.rule]) }]]
      : c.classes ? [[c.id, Object.fromEntries(c.classes.map(k => [k.id, set(k.rules)]))]] : []));
}
