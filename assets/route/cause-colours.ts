// ─── Route cause colours ──────────────────────────────────────────────────────
// Role: category key (categories.ts routeCategory) → {colour, labelKey} for the
//       cell-weight overlay's "What constrains" mode, which colours each cell by the
//       category of the routing row that drives the current method's weight there.
//       Land-concern categories take the hybrid colours of the Routing constraints
//       layer (CONSTRAINT_PALETTE / CONCERNS) where the fact is the same; other land
//       facts get their concern colour or a distinct one; OSM-derived categories get
//       neutral greys of different lightness, terrain tans; an uploaded layer (`upload`) one cyan;
//       anything else is 'other' grey.
//       Pure: no DOM, no i18n import.
// Deps: categories.ts, src/colors/route-constraints.ts.

import { CATEGORY_LABEL_KEYS, categoryLabelKey } from './categories.js';
import { CONSTRAINT_PALETTE, concernColour } from '../../src/colors/route-constraints.js';

export interface CauseColour { colour: string; labelKey: string }

const cls = (id: string): string => CONSTRAINT_PALETTE.find((c) => c.id === id)!.colour;
const concern = concernColour;

export const COLOURS: Record<string, string> = {
  // land concerns: the layer's hybrid colours
  protection: cls('gap-1-2'), protect: cls('gap-1-2'), military: cls('military'), sites: cls('sites'),
  'flags:0': cls('tribal'), 'flags:1': cls('military'), 'flags:3': cls('critical-habitat'),
  'flags2:0': cls('phma'), 'flags2:2': cls('floodplain'), 'flags2:3': cls('sites'), 'flags2:4': cls('sites'),
  'desig:0': cls('wsa'), 'desig:6': cls('other-federal'), 'desig:7': concern('wilderness-np'),
  // other land facts: their concern colour, or a distinct one
  wildfire: concern('wildfire-high'), whpclass: concern('wildfire-high'),
  'flags:2': concern('airfields'), 'flags:4': concern('section-368'), 'flags:5': concern('pop-100'), 'flags:6': concern('park'), 'flags:7': concern('tall-structures'),
  'flags2:1': concern('ghma'), 'flags2:5': concern('superfund'), 'flags2:6': concern('cbrs'), 'flags2:7': concern('fuds'),
  'desig:1': concern('nm-nca'), 'desig:2': concern('ira'), 'desig:3': concern('acec'), 'desig:4': concern('wsr'), 'desig:5': concern('nht-nst'),
  flags: '#a78bfa', flags2: '#e879f9', desig: '#fbbf24',
  // OSM-derived: neutral greys, by lightness; terrain: tans, so the land facts stand out over it
  parallel: '#c2c7cf', adj: '#b4bac4', 'osm_flags:0': '#e2e5ea', 'osm_flags:1': '#d3d7de', 'osm_flags:2': '#a6adb8',
  'osm_flags:3': '#9aa1ad', 'osm_flags:4': '#8e96a3', 'osm_flags:5': '#838b98', 'osm_flags:6': '#78808d', 'osm_flags:7': '#6d7582',
  'terrain:landcover': '#d6c6a0', 'terrain:slope': '#bba57f', landcover: '#d6c6a0', slope: '#bba57f',
  bldg: concern('homes'), built: concern('buildings'), nonres: concern('nonresidential'), bldgunk: concern('building-unknown'),
  wetland: concern('wetland'), aviation: concern('airfields'), nfhl: cls('floodplain'), state: '#4d5561', isoreg: '#434a56', other: '#8b919c',
  // a visitor's uploaded layer: one colour no land concern uses
  upload: '#22d3ee',
};

/** Every known routeCategory key, with its colour and label key; an unknown key reads as 'other'. */
export const CAUSE_COLOURS: Record<string, CauseColour> =
  Object.fromEntries(Object.keys(CATEGORY_LABEL_KEYS).map((k) => [k, { colour: COLOURS[k] ?? COLOURS.other, labelKey: CATEGORY_LABEL_KEYS[k] }]));

export const causeColour = (key: string): CauseColour => CAUSE_COLOURS[key] ?? { colour: COLOURS.other, labelKey: categoryLabelKey(key) };

/** '#rrggbb' → [r, g, b]. */
export const hexRgb = (hex: string): [number, number, number] => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
