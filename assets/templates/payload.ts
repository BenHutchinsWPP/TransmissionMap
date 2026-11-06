// ─── Template payload: what a page-owned template reads in its frame ────────
// Role: the contract between the page and a template (assets/templates/): the
//       one object an html template reads as the deep-frozen window.TM_INPUT
//       (sent as runCanvas's `inputs`; a Vega template gets its rows as
//       data.values instead). Types only. The page builds it from
//       dataset-query.ts shapeRows() (rows, features, scope, complete,
//       truncation, tiersHidden, totals as totalOnce), field-roles.ts (roles), the legend colours,
//       nearest.ts (nearest: rows per point {id, d_km, to}, `second` the targets),
//       t() (labels: every chrome string, already translated), the layer's
//       registry credit with its tags stripped (credit) and src/units.ts
//       (units). Model text reaches a template only as a `params` value that
//       passed the template's own params check; the template sets text with
//       textContent, never as HTML.
//       The frame API beside it (TM.drawn, TM.fail, TM.action, TM.lib) is in
//       sandbox/canvas-runner.js's header; the libraries a template may load
//       are src/registry/template-libs.json.
//
// Deps: types only — dataset-query.ts (ShapeRow), src/registry/field-schema.ts
//       (FieldRole), src/units.ts (UnitPrefs).

import type { ShapeRow } from '../dataset-query.js';
import type { FieldRole } from '../../src/registry/field-schema.js';
import type { UnitPrefs } from '../../src/units.js';

export const TEMPLATE_PAYLOAD_VERSION = 1;

/** A validated param value: what the template's params schema let through. */
export type TemplateParam = string | number | boolean | null | readonly string[];

export interface TemplateRoles {
  /** The grouping fields, in the order the rows carry them (≤ 2). */
  by: readonly { field: string; role: FieldRole }[];
  /** A measure field, or the derived 'count' | 'length_km' | 'area_km2'; its unit when known. */
  measure: { name: string; unit?: string };
  /** The time field the rows are binned by. */
  time?: { field: string; bin: 'year' | 'month' };
  /** A numeric field the rows are binned by (distribution): each row's `bin` index with its `lo` / `hi` edges ([lo, hi)), `bin: null` for no value. */
  bins?: {
    field: string; scale: 'lin' | 'log';
    /** The edges the rows were binned on (row `bin` i is [edges[i], edges[i + 1])). */
    edges?: readonly number[];
    /** The values' own quantiles (dataset-query.ts binStats): n, p10, median, p90. */
    stats?: { n: number; p10: number; median: number; p90: number };
    /** false: a bin takes no map filter (length / area, or a year read out of text), so the chart's bars are not clickable. */
    filter?: boolean;
  };
}

export interface TemplatePayload {
  v: typeof TEMPLATE_PAYLOAD_VERSION;
  /** The catalogue id. */
  template: string;
  params: Readonly<Record<string, TemplateParam>>;
  /** 'area': the whole GeoJSON file within the Area; 'view': the tiles of the current view. */
  scope: 'area' | 'view';
  rows: readonly ShapeRow[];
  /** Only when the template's signature asks for geometry (≤ 50,000). */
  features?: readonly GeoJSON.Feature[];
  /** nearest: the second layer's features that are some point's nearest (each once; rows' `to` indexes
   *  them), as points with their label; never selectable — the frame may only fly to them. */
  second?: { layer: string; credit: string; features: readonly GeoJSON.Feature[] };
  /** points-per-polygon by a region field: each matching feature once (shapeRows totals), for the
   *  header total and the shares; the rows count a feature in every region it is tagged with. */
  totalOnce?: { count: number; sum?: number };
  /** pies-per-region: each region's pie centre [lon, lat] by region code (per-region.ts regionCentre, from the outlines in `features`). */
  centres?: Readonly<Record<string, readonly [number, number]>>;
  roles: TemplateRoles;
  /** field → value → '#rrggbb', the map legend's own colours. */
  colours: Readonly<Record<string, Readonly<Record<string, string>>>>;
  /** Chrome strings by key (title, measure, other, partial, scope, table, download…), page-translated. */
  labels: Readonly<Record<string, string>>;
  /** Plain text: the registry credit without its tags. */
  credit: string;
  units: Readonly<UnitPrefs>;
  /** false: the rows do not cover everything the scope names (tiles: only what is loaded). */
  complete: boolean;
  /** true: rows or features were cut; `truncation` says which. Never silent. */
  truncated: boolean;
  truncation?: string;
  /** Voltage tiers (OSM_TL_TIERS ids) the current zoom does not draw (scope 'view'). */
  tiersHidden?: readonly string[];
  theme: 'light';
}
