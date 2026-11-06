// ─── Local commands: the common asks, answered without a model ───────────────
// Role: a regex table over English phrases (English only; the model
//       handles every other language) that turns a chat message into one map
//       tool call, so "undo", "turn off railroads" or "show only Texas" run
//       instantly, with no key and no network.
//         parseLocal(text, ctx)   → {kind: 'call', call} — one tool call, as
//                                   tools.ts dispatch() takes it;
//                                   {kind: 'ambiguous', what, options} — a
//                                   layer or area name that fits several, each
//                                   option carrying its own call (the chat
//                                   offers them as buttons), at most 8, with
//                                   `more` = how many were cut ("…and N more");
//                                   {kind: 'none'} — not a local command (the
//                                   model answers, or the chat shows
//                                   LOCAL_EXAMPLES when no key is set).
//         localContext()          the names parseLocal matches against: each
//                                   layer's id and title in the current
//                                   language, the area labels (lazy chunk; null
//                                   when it cannot load → areas by code only),
//                                   the basemaps.
//       Templates: "fuel mix in Texas", "top 10 owners of transmission lines", "capacity added
//       by year", "transmission lines by voltage", "density of substations" → one showTemplate
//       call. The layer comes from a noun table, the field from a word list read against the
//       layer's roles, the area from a trailing "in <area>"; a layer that lacks the field, the
//       measure or the area is not an option, several left → ambiguous, none → the model. Tiled
//       layers take no area. Flow, buildout-map, distribution and compare-regions phrases
//       match only where the template's signature fits the layer (`fit`); nearest stays the
//       model's (its second layer and threshold are not in the phrase). A message led by add /
//       turn / switch / hide / remove / disable / delete / clear / close / stop is never a
//       template. A question (a "?", or how/what/which/where/… first) goes to the
//       model, except "where are the <X> clustered" (density).
//       Phrases: add [layer] <service title|id>, show <service title> service (a library
//       service by whole-word title, never a guess: several → ambiguous, a layer
//       that names the words as well or better → left to the layer rule); undo / redo / reset; turn|switch on|off, show|hide <layer>;
//       show only <area> (and clear area); fly|go|zoom to <place>; <name>
//       basemap; clear selection; clear styles; share link.
//       Layer and area names match by whole words, then word prefixes; the
//       best tier wins, and a tie is ambiguous rather than a guess. An exact
//       area name wins over partial ones, in the first kind of KIND_ORDER that
//       has it — save a US state and a country of one name, which tie
//       ("Georgia": the state first, then the country).
//       Pure: parseLocal reads only its arguments; loop.ts runs the call.
//
// Deps: registry (LAYERS), i18n (t), map-api.ts (BASEMAPS),
//       area-filter.ts (AreaKind, areaCondition), field-roles.ts (rolesOf), field-schema.ts (a year's ops),
//       template-signatures.ts (slotFields, fit, TEMPLATE_SIGNATURES), colors/fuel.ts (FUEL_LEGEND), ui/area-labels.ts (loadAreaLabels, areaLabel),
//       src/registry/service-library.json (dynamic import, titles only).

import { LAYERS } from '../../src/registry/index.js';
import { t } from '../../src/i18n/index.js';
import { BASEMAPS } from '../map-api.js';
import { areaCondition, type AreaKind, type AreaFilter } from '../../src/registry/area-filter.js';
import { rolesOf, type Roles } from '../../src/registry/field-roles.js';
import { slotFields, fit, TEMPLATE_SIGNATURES } from '../../src/registry/template-signatures.js';
import { FIELD_SCHEMA } from '../../src/registry/field-schema.js';
import { layerById } from '../../src/registry/index.js';
import { FUEL_LEGEND } from '../../src/colors/fuel.js';
import { loadAreaLabels, areaLabel, type AreaLabels } from '../ui/area-labels.js';

export interface LocalCall { tool: string; args: Record<string, unknown> }
export interface LocalOption { label: string; call: LocalCall }
export type LocalMatch =
  | { kind: 'call'; call: LocalCall }
  | { kind: 'ambiguous'; what: 'layer' | 'area'; options: LocalOption[]; more: number }
  | { kind: 'none' };

export interface LocalContext {
  layers: { id: string; title: string }[];
  areas: AreaLabels | null;
  basemaps: readonly string[];
  /** The service library's ids and titles (absent: no service commands). */
  services?: { id: string; title: string }[];
}

export const LOCAL_EXAMPLES: readonly string[] = [
  'turn on railroads', 'show only Texas', 'fly to Denver', 'dark basemap', 'undo', 'reset',
];

const MAX_OPTIONS = 8;

export async function localContext(): Promise<LocalContext> {
  return {
    layers: LAYERS.map(l => ({ id: l.id, title: t(l.titleKey) })),
    areas: await loadAreaLabels(),
    basemaps: BASEMAPS,
    services: await import('../../src/registry/service-library.json')
      .then(m => (m.default as { id: string; title: string }[]).map(({ id, title }) => ({ id, title })))
      .catch(() => []),
  };
}

// ─── Words ────────────────────────────────────────────────────────────────────

/** Lower case, accents and punctuation (and emoji) dropped, one space between words. */
const norm = (s: string) => s.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
  .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/** Plural to singular, the same on both sides of a match ("counties" ~ "county"). */
const stem = (w: string) => w.length > 4 && w.endsWith('ies') ? w.slice(0, -3) + 'y'
  : w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w;

const FILLER = new Set(['the', 'a', 'an', 'layer', 'layers', 'map', 'data', 'please']);
const words = (s: string) => norm(s).split(' ').filter(w => w && !FILLER.has(w)).map(stem);

/** How well `q` names something called `names`: 3 the whole name, 2 every word
 *  of q is a word of it, 1 every word of q starts one of its words, 0 no match. */
function score(q: string[], names: string[]): number {
  if (!q.length) return 0;
  let best = 0;
  for (const name of names) {
    const n = words(name);
    if (q.join(' ') === n.join(' ')) return 3;
    if (q.every(w => n.includes(w))) best = Math.max(best, 2);
    else if (q.every(w => w.length >= 3 && n.some(x => x.startsWith(w)))) best = Math.max(best, 1);
  }
  return best;
}

/** The candidates in the best tier, at most MAX_OPTIONS of them. */
function bestOf<T>(q: string[], items: T[], names: (x: T) => string[]): T[] {
  let top = 0;
  let out: T[] = [];
  for (const x of items) {
    const s = score(q, names(x));
    if (s > top) { top = s; out = [x]; } else if (s && s === top) out.push(x);
  }
  return out;
}

function pick(what: 'layer' | 'area', options: LocalOption[]): LocalMatch {
  if (!options.length) return { kind: 'none' };
  if (options.length === 1) return { kind: 'call', call: options[0].call };
  return { kind: 'ambiguous', what, options: options.slice(0, MAX_OPTIONS), more: Math.max(0, options.length - MAX_OPTIONS) };
}

// ─── Layers ───────────────────────────────────────────────────────────────────

function layerCall(name: string, on: boolean, ctx: LocalContext): LocalMatch {
  const q = words(name);
  const hits = bestOf(q, ctx.layers, l => [l.title, l.id.replace(/-/g, ' ')]);
  return pick('layer', hits.map(l => ({ label: l.title, call: { tool: 'setLayerVisible', args: { layerId: l.id, on } } })));
}

// ─── Services ─────────────────────────────────────────────────────────────────

function serviceCall(name: string, ctx: LocalContext, viaShow: boolean): LocalMatch {
  const q = words(name);
  const names = (x: { id: string; title: string }) => [x.title, x.id.replace(/-/g, ' ')];
  const hits = bestOf(q, ctx.services ?? [], names);
  if (!hits.length) return { kind: 'none' };
  const top = Math.max(...hits.map(h => score(q, names(h))));
  if (top < 2) return { kind: 'none' };
  // "add railroads" with a layer of that name is the layer's: a service wins only by a better match.
  if (!viaShow && ctx.layers.some(l => score(q, [l.title, l.id.replace(/-/g, ' ')]) >= top)) return { kind: 'none' };
  return pick('layer', hits.map(h => ({ label: h.title, call: { tool: 'addService', args: { libraryId: h.id } } })));
}

// ─── Areas ────────────────────────────────────────────────────────────────────

// Which kind an exact name means when several carry it: the first in this
// order ("Texas" is the US state, not the world layer's admin-1 region;
// "Mexico" the country, not the Mexican state). A US state and a country of
// one name are the exception: "Georgia" offers both, the state first.
const KIND_ORDER: AreaKind[] = ['states', 'countries', 'admin1', 'nerc', 'ba', 'retail', 'counties'];
const CODED_KINDS = new Set<AreaKind>(['states', 'countries', 'nerc', 'ba']);

function areaCall(name: string, ctx: LocalContext): LocalMatch {
  const q = words(name);
  if (!q.length || !ctx.areas) return { kind: 'none' };
  const table = ctx.areas;
  const opt = (kind: AreaKind, code: string): LocalOption =>
    ({ label: areaLabel(table, kind, code), call: { tool: 'setArea', args: { area: { kind, codes: [code] } } } });
  const raw = name.trim().toUpperCase();
  const all: { kind: AreaKind; code: string; name: string }[] = [];
  const exact: { kind: AreaKind; code: string }[] = [];
  for (const kind of KIND_ORDER) {
    for (const [code, v] of Object.entries(table[kind])) {
      const label = typeof v === 'string' ? v : v[0];
      if ((CODED_KINDS.has(kind) && code === raw) || words(label).join(' ') === q.join(' ')) exact.push({ kind, code });
      all.push({ kind, code, name: label });
    }
  }
  // A US state and a country of one name are a tie; otherwise the first kind wins.
  const first = exact.filter(e => e.kind === exact[0]?.kind || (exact[0]?.kind === 'states' && e.kind === 'countries'));
  if (first.length) return pick('area', first.map(e => opt(e.kind, e.code)));
  return pick('area', bestOf(q, all, a => [a.name]).map(a => opt(a.kind, a.code)));
}

// ─── Templates ────────────────────────────────────────────────────────────────

type Tiers = string[][];
// Noun → layers, in tiers: the first tier with a layer that fits the rest of the phrase wins,
// a tier with several is ambiguous. Most specific noun first.
const NOUNS: [RegExp, Tiers][] = [
  [/\b(?:planned|proposed|future) (?:transmission )?(?:lines?|projects?)\b|\bplanned transmission\b/, [['ogf-planned-transmission']]],
  [/\b(?:natural gas|gas) pipelines?\b/, [['hifld-natgas-lines']]],
  [/\bpipelines?\b/, [['hifld-natgas-lines', 'osm-pipelines-lines']]],
  [/\b(?:natural gas|gas) (?:facilit(?:y|ies)|compressor stations?)\b/, [['hifld-natgas-points']]],
  [/\bsubstations?\b/, [['hifld-substations', 'osm-substations-points', 'osm-substations-polygons']]],
  [/\btransmission(?: (?:lines?|miles?|mileage|km|kilometers?|kilometres?))?\b|\b(?:power|grid) lines?\b|\blines?\b/,
    [['hifld-transmission-lines', 'osm-transmission-lines']]],
  [/\bdata ?cent(?:er|re)s?\b/, [['osm-datacenters']]],
  [/\bmines?\b/, [['mines']]],
  [/\b(?:power )?(?:plants?|stations?|generators?)\b/, [['eia-generators', 'osm-plants-points']]],
];
// No noun, but a generation word: the EIA plants, else the OSM plants (a country area).
const GEN_IMPLICIT = /\b(?:fuel|generation|capacity|retire\w*|build-?out|solar|wind|nuclear|coal|hydro|geothermal|biomass)\b/;
const GEN_TIERS: Tiers = [['eia-generators'], ['osm-plants-points']];
const ANY_NOUN = new RegExp(NOUNS.map(([re]) => re.source).join('|'));

interface FieldWord { re: RegExp; key: string; names?: string[]; facet?: string; rank?: true }
const FIELD_WORDS: FieldWord[] = [
  { re: /\b(?:kv|voltages?|volts?)(?: class(?:es)?)?\b/, key: 'kv', facet: 'kv' },
  { re: /\bfuels?\b|\benergy sources?\b/, key: 'fuel', facet: 'fuel' },
  { re: /\bowner(?:s|ship)?\b/, key: 'owner', names: ['OWNER', 'Owner', 'operator', 'utility_name'], rank: true },
  { re: /\boperators?\b/, key: 'operator', names: ['operator', 'OWNER', 'Owner'], rank: true },
  { re: /\b(?:utility|retail) territor(?:y|ies)\b/, key: 'territory', names: ['retail'], rank: true },
  { re: /\butilit(?:y|ies)\b/, key: 'utility', names: ['utility_name', 'operator', 'OWNER'], rank: true },
  { re: /\bstates?\b/, key: 'state', names: ['states', 'addr_state', 'state'], rank: true },
  { re: /\bcount(?:y|ies)\b/, key: 'county', names: ['counties'], rank: true },
  { re: /\bbalancing authorit(?:y|ies)\b/, key: 'ba', names: ['ba'], rank: true },
  { re: /\bnerc(?: regions?)?\b/, key: 'nerc', names: ['nerc'] },
  { re: /\bcountr(?:y|ies)\b/, key: 'country', names: ['countries'], rank: true },
  { re: /\bcit(?:y|ies)\b/, key: 'city', names: ['addr_city'], rank: true },
  { re: /\bcommodit(?:y|ies)\b/, key: 'commodity', names: ['commodity'] },
  { re: /\bsubstances?\b/, key: 'substance', names: ['substance'] },
  { re: /\bsectors?\b/, key: 'sector', names: ['sector_name'] },
  { re: /\btechnolog(?:y|ies)\b/, key: 'technology', names: ['technology'] },
  { re: /\b(?:types?|class(?:es)?|kinds?|categor(?:y|ies))\b/, key: 'type',
    names: ['fac_type', 'pipe_type', 'sub_type', 'type', 'pipeline', 'substance'] },
];

const COMPOSITION = /\b(?:mix|composition|breakdown|makeup|split|kinds? of|types? of)\b/;
const RANKING = /\b(?:top(?: \d+)?|rank(?:ed|ing)?|largest|biggest|most)\b/;
const TIMELINE = /\b(?:by|per|each) year\b|\bover time\b|\btimeline\b|\bbuild[- ]?out\b|\bover the years\b|\bannual(?:ly)?\b/;
const PER_REGION = /\b(?:by|per|in each|for each|across) (?:the )?(?:nerc|iso|rto|ba|balancing authorit(?:y|ies)|states?|count(?:y|ies)|countr(?:y|ies)|regions?)\b/;
/** A distance ask: nearest, whose second layer and threshold the model picks. */
const MODEL_ASK = /\b(?:nearest|closest|distances?|how far)\b/;
/** A flow: "sankey of fuel to balancing authority", "flow of plants from sector to NERC region". */
const FLOW = /\b(?:sankey|alluvial|flows?)\b/;
const FLOW_SIDES = /\b(?:of|from) ([^]+?) (?:to|into) ([^]+)$/;
const ANIMATE = /\banimat\w*\b/;
/** The templates a local phrase reaches only when their signature fits the layer. */
const WAVE2 = new Set(['flow', 'buildout-map', 'distribution', 'compare-regions']);
const DISTRIBUTION = /\b(?:distribution|histogram|spread) of\b/;
const DENSITY = /\bdensity\b|\bheat ?map\b|\bhex(?:agon)?-?bin\b|\bclustered\b|\bclusters?\b/;
const MEASURES: [RegExp, (r: Roles) => string | undefined][] = [
  [/\b(?:capacity|mw|megawatts?|nameplate|output)\b/, r => r.fields.find(f => f.unit === 'MW' && f.additive !== false && f.role === 'measure')?.name],
  [/\b(?:miles?|mileage|lengths?|km|kilometers?|kilometres?)\b/, r => r.derived.includes('length_km') ? 'length_km' : undefined],
  [/\b(?:how many|number of|counts?)\b/, () => 'count'],
];
/** What distribution bins: an amount or a level (kV), never a count. */
const BIN_MEASURES: [RegExp, (r: Roles) => string | undefined][] = [
  [MEASURES[0][0], r => r.fields.find(f => f.unit === 'MW' && f.role === 'measure')?.name],
  [MEASURES[1][0], MEASURES[1][1]],
  [/\b(?:kv|voltages?|volts?)\b/, r => r.fields.find(f => f.facet === 'kv' && f.role === 'measure')?.name],
];
const LEAD = /^(?:(?:show|chart|plot|draw|make|give|display|visuali[sz]e)(?: me)?)\s+(?:(?:an?|the)\s+)?(?:(?:bar |pie |donut )?(?:chart|graph|plot)\s+(?:of|for|showing)\s+)?/;

const fuelWhere = (s: string, field: string): unknown[] | null => {
  const word = /\b(solar|wind|nuclear|coal|hydro|oil|geothermal|biomass|storage|(?:natural )?gas)\b/.exec(s)?.[1];
  if (!word) return null;
  const id = word.endsWith('gas') ? 'gas' : word === 'geothermal' ? 'geo' : word;
  const row = FUEL_LEGEND.find(f => f.id === id);
  const value = field === 'energy_source' ? row?.eiaCodes : field === 'source' ? row?.osmValues : undefined;
  return value?.length ? [{ field, op: 'in', value }] : null;
};

/** One showTemplate call for `layerId`, or null when the layer lacks the field, measure, time or area. */
function templateArgs(layerId: string, p: {
  kind: string; text: string; word?: FieldWord; word2?: FieldWord; measure?: number; top?: number; net: boolean;
  since?: number; area: AreaFilter | null; split?: string;
}): Record<string, unknown> | null {
  const roles = rolesOf(layerId);
  const layer = layerById(layerId);
  if (!roles || !layer) return null;
  const sig = TEMPLATE_SIGNATURES.find(x => x.id === p.kind);
  if (WAVE2.has(p.kind) && (!sig || fit(sig, roles, []) !== 'fits')) return null;
  const args: Record<string, unknown> = { template: p.kind, layer: layerId };
  if (p.area) {
    const c = areaCondition(layer.dataset, p.area);
    if (layer.data?.kind !== 'geojson' || (typeof c === 'object' && 'unfiltered' in c)) return null;
    args.area = p.area;
  }
  const fieldOf = (w: FieldWord, slot: 'C' | 'CR') => {
    const ok = slotFields(slot, roles.fields.filter(f => f.role !== 'id' && f.role !== 'label'));
    return (w.facet ? ok.find(x => x.facet === w.facet) : w.names!.map(n => ok.find(x => x.name === n)).find(Boolean))?.name;
  };
  if (p.word) {
    const f = fieldOf(p.word, p.kind === 'ranking' ? 'CR' : 'C');
    if (!f) return null;
    args.by = f;
  } else if (p.kind === 'ranking' || p.kind === 'flow') return null;
  if (p.split) {
    if (!roles.fields.some(f => f.name === p.split && f.role === 'region')) return null;
    args.split = p.split;
  }
  if (p.kind === 'flow') {
    const f = p.word2 && fieldOf(p.word2, 'CR');
    if (!f || f === args.by) return null;
    args.split = f;
  }
  if (p.measure !== undefined) {
    const m = (p.kind === 'distribution' ? BIN_MEASURES : MEASURES)[p.measure][1](roles);
    if (!m || (m !== 'count' && !(roles.derived as string[]).includes(m) && !roles.fields.some(f => f.name === m))) return null;
    args.measure = m;
  }
  const where: unknown[] = [];
  if (p.since !== undefined) {
    // "since 2000": on the year the template reads first (its default time), when that takes a range.
    const time = roles.fields.find(f => f.role === 'time');
    if (!time || !FIELD_SCHEMA[layer.dataset!]?.[time.name]?.ops.includes('>=')) return null;
    where.push({ field: time.name, op: '>=', value: p.since });
  }
  if (p.kind === 'timeline') {
    const times = roles.fields.filter(f => f.role === 'time');
    if (!times.length || (p.net && !times.some(f => /retire/i.test(f.name)))) return null;
    if (p.net) args.mode = 'net';
  }
  if (p.top) args.top = p.top;
  const fuel = roles.fields.find(f => f.facet === 'fuel');
  where.unshift(...(fuel ? fuelWhere(p.text, fuel.name) ?? [] : []));
  if (where.length) args.where = where;
  return args;
}

function templateCall(s: string, ctx: LocalContext): LocalMatch {
  s = s.replace(LEAD, '');
  const none: LocalMatch = { kind: 'none' };
  if (MODEL_ASK.test(s)) return none;
  const view = /\b(?:in|within|across) (?:the )?(?:current )?(?:view|map|viewport)$|\bhere$/;
  s = s.replace(view, '').trim();

  // Area: a trailing "in/for/within <area>" must be an area; a trailing "of <area>" only when it names no layer or field.
  let areas: { label?: string; area: AreaFilter }[] = [];
  const named = (x: string) => ANY_NOUN.test(x) || FIELD_WORDS.some(w => w.re.test(x));
  const tail = /\b(?:in|for|within|across) (?:the )?([^]+)$/.exec(s) ?? (() => {
    const m = /\bof (?:the )?([^]+)$/.exec(s);
    return m && !named(m[1]) ? m : null;
  })();
  if (tail) {
    const a = areaCall(tail[1], ctx);
    const strict = !tail[0].startsWith('of');
    if (a.kind === 'none') { if (strict) return none; }
    else {
      const opts = a.kind === 'call' ? [{ label: undefined, call: a.call }] : a.kind === 'ambiguous' ? a.options : [];
      areas = opts.map(o => ({ label: o.label, area: o.call.args.area as AreaFilter }));
      s = s.slice(0, tail.index).trim();
    }
  }

  // A flow names its two sides ("from fuel to balancing authority"); "since 2000" keeps a year range.
  const sides = FLOW.test(s) ? FLOW_SIDES.exec(s) : null;
  if (FLOW.test(s) && !sides) return none;
  const since = Number(/\bsince (\d{4})\b/.exec(s)?.[1]) || undefined;
  if (since) s = s.replace(/ ?\bsince \d{4}\b/, '');

  const noun = NOUNS.find(([re]) => re.test(s));
  const tiers = noun?.[1] ?? (GEN_IMPLICIT.test(s) ? GEN_TIERS : null);
  if (!tiers) return none;
  const nounless = noun ? s.replace(noun[0], ' ') : s;

  const top = RANKING.test(s) ? Number(/\btop (\d+)\b/.exec(s)?.[1]) || undefined : undefined;
  if (top !== undefined && (top < 3 || top > 30)) return none;
  const byPart = s.includes(' by ') ? s.slice(s.lastIndexOf(' by ') + 4) : '';
  const binned = !sides && !ANIMATE.test(s) && DISTRIBUTION.test(s);
  const fieldWord = (part: string) => FIELD_WORDS.find(w => w.re.test(part));
  // A distribution's measure may be a level (kV): only a word after "by" groups it.
  let word = sides ? fieldWord(sides[1]) : binned ? fieldWord(byPart) : fieldWord(byPart) ?? fieldWord(nounless);
  const head = binned && nounless.includes(' by ') ? nounless.slice(0, nounless.lastIndexOf(' by ')) : nounless;
  const measure = (binned ? BIN_MEASURES : MEASURES).findIndex(([re]) => re.test(head));
  const isLine = tiers.flat().every(id => rolesOf(id)?.geometry === 'line');

  let kind: string | null = null;
  if (sides) kind = 'flow';
  else if (ANIMATE.test(s)) kind = 'buildout-map';
  else if (binned) kind = 'distribution';
  else if (DENSITY.test(s)) kind = 'density';
  else if (TIMELINE.test(s)) kind = 'timeline';
  else if (isLine && word && ['kv', 'substance', 'type'].includes(word.key) && !RANKING.test(s)) kind = 'lines-by-class';
  else if (RANKING.test(s) || word?.rank) kind = word ? 'ranking' : null;
  else if (word || COMPOSITION.test(s)) kind = 'composition';
  if (!kind) return none;
  // A mix per NERC region is a comparison: compare-regions. Any other region kind is the model's call.
  let split: string | undefined;
  if (kind === 'composition' && PER_REGION.test(s)) {
    if (areas.length || !/\bby (?:the )?nerc(?: regions?)?$/.test(s)) return none;
    word = fieldWord(s.slice(0, s.lastIndexOf(' by ')));
    if (!word) return none;
    kind = 'compare-regions';
    split = 'nerc';
  }

  // "since 2000" is a where on the year a timeline bins: left to the model.
  if (since && kind === 'timeline') return none;
  const shown = kind !== 'density';
  const word2 = sides ? fieldWord(sides[2]) : undefined;
  if (sides && !word2) return none;
  const p = {
    kind, text: s, ...(shown && word && { word }), ...(word2 && { word2 }), ...(measure >= 0 && shown && kind !== 'flow' && { measure }),
    ...(top && { top }), ...(split && { split }), net: /\bretire\w*\b/.test(s), ...(since && { since }), area: null as AreaFilter | null,
  };
  const titleOf = (id: string) => ctx.layers.find(l => l.id === id)?.title;
  const build = (area: AreaFilter | null) => {
    for (const tier of tiers) {
      const out = tier.flatMap(id => {
        const args = titleOf(id) ? templateArgs(id, { ...p, area }) : null;
        return args ? [{ label: titleOf(id)!, call: { tool: 'showTemplate', args } }] : [];
      });
      if (out.length) return out;
    }
    return [];
  };

  if (areas.length > 1) {
    const per = areas.map(a => ({ label: a.label ?? '', opts: build(a.area) }));
    if (per.some(x => x.opts.length !== 1)) return none;
    return pick('area', per.map(x => ({ label: x.label, call: x.opts[0].call })));
  }
  return pick('layer', build(areas[0]?.area ?? null));
}

// ─── The phrase table ─────────────────────────────────────────────────────────

const BASEMAP_ALIAS: Record<string, string> = {
  satellite: 'aerial', imagery: 'aerial', streets: 'street', road: 'street', terrain: 'topo',
  topographic: 'topo', water: 'hydro', hydrography: 'hydro', grey: 'light', gray: 'light',
};

const call = (tool: string, args: Record<string, unknown> = {}): LocalMatch => ({ kind: 'call', call: { tool, args } });

type Rule = [RegExp, (m: RegExpMatchArray, ctx: LocalContext, question: boolean) => LocalMatch];

/** A question is the model's: a chart template answers only an imperative or noun-phrase ask
 *  ("fuel mix in Texas", "chart gas facilities by type"), plus the one density phrase below. */
const QUESTION = /^(?:how|what|what's|which|why|where|who|whose|when|is|are|was|were|does|do|did|can|could|would|should|will|has|have)\b/;
const CLUSTER_ASK = /^where are (?:the )?.+ clustered$/;

const RULES: Rule[] = [
  [/^(?:undo|undo that|go back|take that back)$/, () => call('undo')],
  [/^redo$/, () => call('redo')],
  [/^(?:reset|reset (?:the )?(?:map|view)|start over)$/, () => call('reset')],
  [/^(?:clear|remove|drop) (?:the )?selection$|^(?:deselect all|select none)$/, () => call('setSelection', { selection: null })],
  [/^(?:clear|remove|reset) (?:all )?(?:the )?styles?$/, () => call('clearStyle')],
  [/^(?:share|copy) (?:the )?link$|^share(?: (?:this )?(?:map|view))?$/, () => call('shareLink')],
  [/^(?:clear|remove|reset) (?:the )?(?:area|area filter|region)$|^show (?:everywhere|all areas|all regions)$/,
    () => call('setArea', { area: null })],
  [/^(?:show only|only show|filter (?:the map )?to|limit (?:the map )?to|restrict (?:the map )?to) (.+)$/,
    (m, ctx) => areaCall(m[1], ctx)],
  [/^(?:fly|go|zoom|take me|move|pan|jump) to (.+)$|^(?:center|centre) (?:the map )?on (.+)$/,
    m => call('fitTo', { place: (m[1] ?? m[2]).trim() })],
  [/^(?:(?:switch|change) (?:the )?basemap to |(?:switch|change) to |use |show )?(?:the |an? )?([a-z]+) (?:basemap|base map|background)$|^basemap ([a-z]+)$/,
    (m, ctx) => {
      const w = m[1] ?? m[2];
      const bm = BASEMAP_ALIAS[w] ?? w;
      return ctx.basemaps.includes(bm) ? call('setBasemap', { basemap: bm }) : { kind: 'none' };
    }],
  [/^(?:turn|switch) (on|off) (.+)$/, (m, ctx) => layerCall(m[2], m[1] === 'on', ctx)],
  [/^(?:turn|switch) (.+) (on|off)$/, (m, ctx) => layerCall(m[1], m[2] === 'on', ctx)],
  [/^(?!(?:add|turn|switch|hide|remove|disable|delete|clear|close|stop)\b)(.+)$/,
    (m, ctx, q) => ((q || QUESTION.test(m[1])) && !CLUSTER_ASK.test(m[1]) ? { kind: 'none' } : templateCall(m[1], ctx))],
  [/^add (?:the )?(?:layer |service )?(.+?)(?: service)?$/, (m, ctx) => serviceCall(m[1], ctx, false)],
  [/^(?:show|display|add) (?:the )?(.+?) service$/, (m, ctx) => serviceCall(m[1], ctx, true)],
  [/^(show|enable|display|add|hide|disable|remove) (.+)$/,
    (m, ctx) => layerCall(m[2], ['show', 'enable', 'display', 'add'].includes(m[1]), ctx)],
];

/** The tool call a chat message names, if it is one of the local commands. */
export function parseLocal(text: string, ctx: LocalContext): LocalMatch {
  const s = text.trim().toLowerCase().replace(/\s+/g, ' ').replace(/^please /, '').replace(/[\s.!?]+$|,? please$/g, '');
  if (!s || s.length > 200) return { kind: 'none' };
  const question = text.includes('?');
  for (const [re, fn] of RULES) {
    const m = s.match(re);
    if (!m) continue;
    const r = fn(m, ctx, question);
    if (r.kind !== 'none') return r;
  }
  return { kind: 'none' };
}
