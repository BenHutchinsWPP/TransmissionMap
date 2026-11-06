// ─── Chat eval: scripts/eval_asks.json through ask(), mocked or live ─────────
// Role: opt-in harness for the map chat (`npm run eval:chat`, vitest.eval.config.ts;
//       never part of `npm test`, whose include is *.test.ts). Each ask goes through the
//       real ask() — local commands, SYSTEM_PROMPT, toolSchemas(), dispatch()'s
//       schema/argument checks and the view validators — with the map-api tool layer
//       stubbed (no browser): reads answer from the field schema, writes are validated
//       and acknowledged, showTemplate runs validateTemplateArgs and returns canned
//       page figures. A fresh session per ask.
//         mocked (default)   OpenRouter answered from per-ask scripts (the ask's `mock`,
//                            else built from its first expectation); no network. Proves
//                            the plumbing and the expectation checker; must pass 100 %.
//         live (EVAL_LIVE=1) real requests with the key read ONLY from
//                            process.env.OPENROUTER_API_KEY; never printed, logged or
//                            written (reports are scrubbed of it and of anything key-shaped).
//       Env: EVAL_MODEL (default DEFAULT_MODEL), EVAL_OUT (default tmp/eval), EVAL_CAP
//       (hard spend cap in $, default 1.00, lowered to the key's remaining limit),
//       EVAL_ONLY (comma list of ask ids or categories), EVAL_LOCAL=0 (skip local
//       commands: every ask goes to the model), EVAL_REPEAT (default 1).
//       Mock view: each ask starts at the registry's default layers (plus its `on` list); aggregate and
//       showTemplate answer from one synthetic dataset per layer, so their figures agree: group keys from a
//       where's or the Area's values, else the field's domain, kV levels or region codes; each template's
//       summary in its page shape (regions, links, stats, span; nearest numbers only).
//       Reports: <out>/<mode>-<model>-<time>.json and .md (per-ask pass, tool calls,
//       tokens, cost, latency; pass rate per category).
//       Expectations (eval_asks.json `expect`): calls (each a successful tool run whose
//       args contain the given ones: $oneOf, $has, $re, $gte), forbid, noChange, answer,
//       answerNot, choose (a local ambiguous result offering the named options), clarify
//       (a question back, no map change), anyOf (alternatives; ambiguity answered with
//       the right options passes).
//
// Deps: loop.ts (ask, SYSTEM_PROMPT), tools.ts, openrouter.ts, local-commands.ts,
//       templates/show-template.ts (validateTemplateArgs), scripts/eval_asks.json.

import { describe, it, expect, vi, beforeAll } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// One synthetic dataset per layer: aggregate() and showTemplate() both read their groups, counts and
// totals from here, so the model sees the same figures from either. The visibility map starts at the
// registry's default view for each ask and follows setLayerVisible / reset.
const shared = vi.hoisted(() => {
  const N = 5;
  const sumOf = (i: number) => 5000 - i * 700;
  return {
    groups: (keys: readonly string[], sums: string[]) => keys.slice(0, N).map((key, i) => ({ key, count: 100 - i * 10, sums: Object.fromEntries(sums.map(s => [s, sumOf(i)])) })),
    total: (sums: string[], n = N) => ({ count: Array.from({ length: n }, (_, i) => 100 - i * 10).reduce((a, b) => a + b, 0), sums: Object.fromEntries(sums.map(s => [s, Array.from({ length: n }, (_, i) => sumOf(i)).reduce((a, b) => a + b, 0)])) }),
    vis: {} as Record<string, boolean>,
    // Group keys as the page would name them: a where's or the Area's own values, else the field's closed
    // domain, else plausible kV levels or region codes.
    keysOf: (field: string | undefined, def: { type?: string; values?: readonly string[]; list?: boolean } | undefined,
      where: unknown, area: { kind: string; codes: string[] } | null | undefined): string[] => {
      if (!field) return ['A', 'B', 'C', 'D', 'E'];
      const w = (Array.isArray(where) ? where as { field: string; op: string; value: unknown }[] : [])
        .find(c => c.field === field && ['=', 'in', 'contains', 'contains_any'].includes(c.op));
      if (w) return [w.value].flat().map(String);
      if (area?.kind === field) return area.codes;
      if (def?.values) return [...def.values];
      if (def?.list || field === 'states') return ['TX', 'CA', 'NY', 'FL', 'PA'];
      return def?.type === 'number' ? ['500', '345', '230', '138', '69'] : ['A', 'B', 'C', 'D', 'E'];
    },
  };
});

vi.mock('../map-api.js', async () => {
  const dq = await import('../dataset-query.js');
  const { LAYERS, layerById } = await import('../../src/registry/index.js');
  const { t } = await import('../../src/i18n/index.js');
  const { FIELD_SCHEMA } = await import('../../src/registry/field-schema.js');
  const { validateWhere, validateArea, validateStyleOverride } = await import('../../src/registry/view-validate.js');
  const BASEMAPS = ['light', 'dark', 'street', 'topo', 'aerial', 'hydro'];
  const ok = (result: unknown) => ({ ok: true, result });
  const no = (reason: string) => ({ ok: false, reason });
  const queryable = (id: string) => {
    const d = dq.describe(id);
    return !d.ok ? no(d.reason) : d.result.queryable ? null : no(d.result.reason);
  };
  const known = (layerId: string, fields: string[] = []) => {
    const q = queryable(layerId);
    if (q) return q;
    const allowed = dq.allowedFields(layerId);
    const bad = fields.find(f => !allowed.includes(f));
    return bad ? no(`"${bad}" is not a field of "${layerId}"`) : null;
  };
  const whereArea = (layerId: string, o: { where?: unknown; area?: unknown }) =>
    (o.where ? validateWhere(layerId, o.where) : null) ?? (o.area ? validateArea(o.area) : null);
  return {
    BASEMAPS,
    __resetView: (on: string[] = []) => {
      for (const k of Object.keys(shared.vis)) delete shared.vis[k];
      for (const l of LAYERS) shared.vis[l.id] = !!l.defaultOn;
      for (const id of on) shared.vis[id] = true;
    },
    listLayers: () => ok(LAYERS.map(l => ({ id: l.id, title: t(l.titleKey), group: l.group, on: !!shared.vis[l.id], queryable: !!l.dataset }))),
    setLayerVisible: (id: string, on: boolean) => {
      if (!layerById(id)) return no(`unknown layer "${id}"`);
      shared.vis[id] = on;
      return ok({ id, on });
    },
    setBasemap: (b: string) => (BASEMAPS.includes(b) ? ok({ basemap: b }) : no(`unknown basemap "${b}"`)),
    setWhere: (id: string, c: unknown[]) => { const e = validateWhere(id, c); return e ? no(e) : ok({ id, conditions: c.length }); },
    setArea: (a: unknown) => { const e = a === null ? null : validateArea(a); return e ? no(e) : ok({ area: a }); },
    setSelection: () => ok({ selected: 0 }),
    setStyle: (id: string, o: unknown) => { const e = validateStyleOverride(id, o); return e ? no(e) : ok({ id, style: o }); },
    clearStyle: () => ok({ cleared: 'all' }),
    setCamera: (c: unknown) => ok(c),
    fitTo: (t: unknown) => ok(t),
    describe: dq.describe,
    query: async (id: string, o: { fields?: string[]; where?: unknown; area?: unknown; orderBy?: { field: string }; limit?: number }) => {
      const e = known(id, [...(o.fields ?? []), ...(o.orderBy ? [o.orderBy.field] : [])]) ?? (whereArea(id, o) && no(whereArea(id, o)!));
      if (e) return e;
      const fields = o.fields?.length ? o.fields : dq.allowedFields(id).slice(0, 6);
      const ds = layerById(id)!.dataset!;
      const rows = Array.from({ length: Math.min(o.limit ?? 5, 5) }, (_, i) => ({
        id: i + 1, feature: { type: 'Feature', properties: {}, geometry: null },
        props: Object.fromEntries(fields.map(f => [f, FIELD_SCHEMA[ds]?.[f]?.type === 'number' ? 900 - i * 100 : FIELD_SCHEMA[ds]?.[f]?.values?.[i] ?? `Example ${i + 1}`])),
      }));
      return ok({ layerId: id, complete: true, fields, rows, total: 5, truncated: false });
    },
    count: async (id: string, o: { where?: unknown; area?: unknown }) =>
      known(id) ?? (whereArea(id, o) ? no(whereArea(id, o)!) : ok({ layerId: id, complete: true, total: shared.total([]).count })),
    aggregate: async (id: string, o: { groupBy: string; sum?: string[]; where?: unknown; area?: unknown }) => {
      const e = known(id, [o.groupBy, ...(o.sum ?? [])]) ?? (whereArea(id, o) ? no(whereArea(id, o)!) : null);
      if (e) return e;
      const ds = layerById(id)!.dataset!;
      const keys = shared.keysOf(o.groupBy, FIELD_SCHEMA[ds]?.[o.groupBy], o.where, o.area as never);
      const groups = shared.groups(keys, o.sum ?? []);
      return ok({ layerId: id, complete: true, groupBy: o.groupBy, sum: o.sum ?? [], groups, total: shared.total([]).count });
    },
    showTable: async (r: { layerId: string }) => known(r.layerId) ?? ok({ layerId: r.layerId }),
    joinPoints: async (a: { points: string; polygons: string; where?: unknown }) =>
      known(a.points) ?? known(a.polygons) ?? ok({ rows: [{ layer: a.polygons, id: 'x', label: 'Region X', count: 12 }], complete: true }),
    crossings: async (a: { polygons: string[] }) =>
      a.polygons.map(p => known(p)).find(Boolean) ?? ok({ rows: [], complete: true }),
    runAnalysis: async () => ok({ value: { total: 123.4, count: 5, note: 'canned result' }, ms: 5, complete: true, inputs: [] }),
    layerRows: async () => ok({ fc: { type: 'FeatureCollection', features: [] }, inputs: [], partial: [] }),
    addService: async (a: unknown) => ok({ id: 'svc-1', ...(a as object) }),
    removeService: (id: string) => ok({ id }),
    listServices: () => ok([]),
    undo: () => ok({ done: true }),
    redo: () => ok({ done: true }),
    reset: () => { for (const l of LAYERS) shared.vis[l.id] = !!l.defaultOn; return ok({ done: true }); },
    shareLink: () => ok({ url: 'https://example.invalid/#view' }),
  };
});

// The template pass reads the map; here the arguments are the real validator's and the figures are canned.
vi.mock('../templates/show-template.js', async orig => {
  const actual = await orig<typeof import('../templates/show-template.js')>();
  return {
    ...actual,
    showTemplate: vi.fn(async (args: unknown) => {
      const v = actual.validateTemplateArgs(args);
      if (!v.ok) return v;
      const { FIELD_SCHEMA } = await import('../../src/registry/field-schema.js');
      const { layerById } = await import('../../src/registry/index.js');
      const r = v.result;
      const ds = layerById(r.layer)?.dataset ?? '';
      const keysOf = (field?: string) => shared.keysOf(field, field ? FIELD_SCHEMA[ds]?.[field] : undefined, r.where, r.area);
      const keys = keysOf(r.by);
      const sum = r.measure !== 'count' ? [r.measure] : [];
      const val = (g: { count: number; sums: Record<string, number> }) => (sum.length ? g.sums[r.measure] : g.count);
      const groups = shared.groups(keys, sum);
      const all = shared.total(sum, groups.length);
      const total = sum.length ? { count: all.count, sum: all.sums[r.measure] } : { count: all.count };
      const denom = sum.length ? total.sum! : total.count;
      const scope = layerById(r.layer)?.data?.kind === 'geojson' ? 'area' : 'view';
      const base = { measure: r.measure, total, scope, complete: true };
      const share = (v: number) => Math.round((v / denom) * 100) / 100;
      // nearest tells the model numbers only (chat trust model): no group or feature names.
      let summary: Record<string, unknown>;
      if (r.def.id === 'nearest') {
        const n = total.count, within = Math.round(n * 0.6);
        summary = { measure: 'count', total: { count: n }, scope, complete: true,
          nearest: { n, median_km: 9.4, p90_km: 31.2, within_km: r.within ?? 16.1, within, share: Math.round(within / n * 100) / 100, beyond: n - within } };
      } else if (r.def.id === 'distribution') {
        summary = { ...base, stats: { n: total.count, p10: 1.5, median: 20, p90: 150 } };
      } else if (r.def.id === 'compare-regions') {
        const regions = keysOf(r.split).slice(0, 6).map((key, i) => ({ key, value: val(groups[i % groups.length]), top: { key: groups[0].key, share: 0.4 } }));
        summary = { ...base, groups: groups.length, regions };
      } else if (r.def.id === 'flow') {
        const to = keysOf(r.split);
        summary = { ...base, groups: groups.length, links: groups.slice(0, 3).map((g, i) => ({ from: g.key, to: to[i % to.length], value: val(g), share: share(val(g)) })) };
      } else {
        summary = { ...base, groups: groups.length, top: groups.slice(0, 3).map(g => ({ key: g.key, value: val(g), share: share(val(g)) })) };
        if (r.def.id === 'buildout-map') {
          const from = r.where.find(c => c.field === r.time && (c.op === '>=' || c.op === '>'))?.value;
          summary.span = { first: typeof from === 'number' ? from : 1950, last: 2025, peak: 2024 };
        }
      }
      return { ok: true, result: { shown: true, template: r.def.id, layer: r.layer, scope, complete: true, summary } };
    }),
  };
});

import * as mapApi from '../map-api.js';
import { ask, newSession, SYSTEM_PROMPT, type AskResult, type ToolRun } from './loop.js';
import { localContext, type LocalContext } from './local-commands.js';
import { DEFAULT_MODEL, RECOMMENDED_MODELS } from './openrouter.js';

// ─── Ask file and expectations ───────────────────────────────────────────────
type Json = unknown;
interface CallExpect { tool: string; args?: Json }
interface Expect {
  calls?: CallExpect[];
  forbid?: CallExpect[];
  noChange?: boolean;
  answer?: boolean;
  answerNot?: string;
  choose?: { what: 'layer' | 'area'; include: string[] };
  clarify?: boolean;
  anyOf?: Expect[];
}
type MockTurn = { text: string } | { calls: { tool: string; args: Json }[] };
interface Ask { id: string; category: string; ask: string; expect: Expect; mock?: MockTurn[]; on?: string[] }

const asks: Ask[] = JSON.parse(readFileSync(join(__dirname, '../../scripts/eval_asks.json'), 'utf8')).asks;

/** Tools that change the view or open something for the visitor. */
const MUTATING = new Set(['setLayerVisible', 'setBasemap', 'setWhere', 'setArea', 'setSelection', 'setStyle', 'clearStyle',
  'setCamera', 'fitTo', 'showTable', 'showTemplate', 'showCanvas', 'addService', 'removeService', 'undo', 'redo', 'reset']);

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Whether `actual` contains `want`: objects by key, arrays by element, scalars equal; $oneOf / $has / $re / $gte matchers. */
export function matches(actual: unknown, want: unknown): boolean {
  if (isObj(want)) {
    if ('$oneOf' in want) return (want.$oneOf as unknown[]).some(w => matches(actual, w));
    if ('$has' in want) return Array.isArray(actual) && actual.some(a => matches(a, want.$has));
    if ('$re' in want) return typeof actual === 'string' && new RegExp(want.$re as string, 'i').test(actual);
    if ('$gte' in want) return typeof actual === 'number' && actual >= (want.$gte as number);
    return isObj(actual) && Object.entries(want).every(([k, w]) => matches(actual[k], w));
  }
  if (Array.isArray(want)) return Array.isArray(actual) && want.every(w => actual.some(a => matches(a, w)));
  return actual === want;
}

/** A matcher-free value that satisfies `want` (for the mocked model's scripted calls). */
function literal(want: unknown): unknown {
  if (isObj(want)) {
    if ('$oneOf' in want) return literal((want.$oneOf as unknown[])[0]);
    if ('$has' in want) return [literal(want.$has)];
    if ('$gte' in want) return want.$gte;
    if ('$re' in want) throw new Error('a $re expectation needs an explicit mock');
    return Object.fromEntries(Object.entries(want).map(([k, w]) => [k, literal(w)]));
  }
  return Array.isArray(want) ? want.map(literal) : want;
}

function mockFor(a: Ask): MockTurn[] {
  if (a.mock) return a.mock;
  const e = a.expect.anyOf?.[0] ?? a.expect;
  if (e.calls?.length) return [{ calls: e.calls.map(c => ({ tool: c.tool, args: literal(c.args ?? {}) })) }, { text: 'Done.' }];
  if (e.clarify || e.choose) return [{ text: `Which one do you mean? ${(e.choose?.include ?? []).join(' or ')}` }];
  return [{ text: 'I cannot do that with this map.' }];
}

interface Verdict { pass: boolean; why: string[] }

function check(e: Expect, result: AskResult, runs: ToolRun[]): Verdict {
  if (e.anyOf) {
    const vs = e.anyOf.map(x => check(x, result, runs));
    return vs.find(v => v.pass) ?? { pass: false, why: vs.flatMap((v, i) => v.why.map(w => `alt ${i + 1}: ${w}`)) };
  }
  const why: string[] = [];
  const done = runs.filter(r => r.outcome.ok);
  const text = result.kind === 'answer' ? result.text : '';
  if (result.kind === 'error') why.push(`error ${result.code}`);
  for (const c of e.calls ?? []) {
    if (!done.some(r => r.name === c.tool && matches(r.args, c.args ?? {}))) why.push(`no successful ${c.tool} matching ${JSON.stringify(c.args ?? {})}`);
  }
  for (const c of e.forbid ?? []) {
    if (done.some(r => r.name === c.tool && matches(r.args, c.args ?? {}))) why.push(`forbidden ${c.tool} succeeded`);
  }
  if (e.noChange && done.some(r => MUTATING.has(r.name))) why.push('changed the map');
  if (e.answer && result.kind === 'answer' && !text.trim()) why.push('no answer text');
  if (e.answer && result.kind === 'choose') why.push('offered options instead of an answer');
  if (e.answerNot && new RegExp(e.answerNot, 'i').test(text)) why.push(`answer matches ${e.answerNot}`);
  if (e.choose) {
    const labels = result.kind === 'choose' ? result.options.map(o => o.label.toLowerCase()).join('|') : text.toLowerCase();
    if (result.kind !== 'choose' && !text.includes('?')) why.push('neither offered options nor asked');
    if (result.kind === 'choose' && result.what !== e.choose.what) why.push(`options for ${result.what}, wanted ${e.choose.what}`);
    for (const w of e.choose.include) if (!labels.includes(w.toLowerCase())) why.push(`options lack "${w}"`);
  }
  if (e.clarify) {
    const asked = result.kind === 'choose' || text.includes('?');
    if (!asked) why.push('did not ask back');
    if (done.some(r => MUTATING.has(r.name))) why.push('changed the map instead of asking');
  }
  return { pass: why.length === 0, why };
}

// ─── Key-safe output ─────────────────────────────────────────────────────────
const KEY = process.env.OPENROUTER_API_KEY ?? '';
const scrub = (s: string) => {
  let out = s.replace(/sk-[A-Za-z0-9_-]{8,}/g, '[redacted]');
  if (KEY.length >= 8) out = out.split(KEY).join('[redacted]');
  return out;
};
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

// ─── Run ─────────────────────────────────────────────────────────────────────
const LIVE = process.env.EVAL_LIVE === '1';
const MODEL = process.env.EVAL_MODEL || DEFAULT_MODEL;
const OUT = process.env.EVAL_OUT || join(process.cwd(), 'tmp/eval');
const USE_LOCAL = process.env.EVAL_LOCAL !== '0';
const REPEAT = Math.max(1, Number(process.env.EVAL_REPEAT) || 1);
const ONLY = (process.env.EVAL_ONLY ?? '').split(',').map(s => s.trim()).filter(Boolean);
let cap = Number(process.env.EVAL_CAP) || 1.0;

const realFetch = globalThis.fetch;
interface Usage { requests: number; prompt: number; completion: number; cost: number }
let current: Usage = { requests: 0, prompt: 0, completion: 0, cost: 0 };
let spent = 0;
let mockQueue: MockTurn[] = [];
let callSeq = 0;

const completion = (turn: MockTurn) => ({
  choices: [{ message: 'text' in turn ? { role: 'assistant', content: turn.text }
    : { role: 'assistant', content: null, tool_calls: turn.calls.map(c => ({ id: `call_${++callSeq}`, type: 'function', function: { name: c.tool, arguments: JSON.stringify(c.args) } })) } }],
  usage: { prompt_tokens: 3000, completion_tokens: 40, cost: 0.0002 },
});

function count(body: { usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number } }) {
  current.requests++;
  current.prompt += body.usage?.prompt_tokens ?? 0;
  current.completion += body.usage?.completion_tokens ?? 0;
  current.cost += body.usage?.cost ?? 0;
  spent += body.usage?.cost ?? 0;
}

globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  if (!url.includes('/chat/completions')) throw new Error('eval: unexpected request');
  if (!LIVE) {
    const turn = mockQueue.shift() ?? { text: '(no scripted turn)' };
    const body = completion(turn);
    count(body);
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  if (spent > cap) throw new TypeError('eval: spend cap reached');
  const res = await realFetch(input, init);
  if (res.ok) count(await res.clone().json().catch(() => ({})));
  return res;
}) as typeof fetch;

interface Row {
  id: string; category: string; ask: string; pass: boolean; why: string[]; source: string; kind: string;
  calls: { name: string; args: unknown; ok: boolean; reason?: string }[];
  firstCallValid: boolean | null; requests: number; promptTokens: number; completionTokens: number; cost: number;
  ms: number; answer: string; skipped?: boolean;
}

async function runAsk(a: Ask, ctx: LocalContext | null): Promise<Row> {
  current = { requests: 0, prompt: 0, completion: 0, cost: 0 };
  mockQueue = LIVE ? [] : [...mockFor(a)];
  (mapApi as unknown as { __resetView: (on?: string[]) => void }).__resetView(a.on);
  const session = newSession();
  const t0 = Date.now();
  const runAndCheck = async () => {
    const result = await ask(session, a.ask, { key: LIVE ? KEY : 'sk-or-v1-mock', model: MODEL, local: ctx, confirm: async () => true, render: async () => ({ shown: true }) });
    const runs = result.kind === 'choose' ? [] : result.runs;
    return { result, runs, verdict: check(a.expect, result, runs) };
  };
  let r = await runAndCheck();
  // One retry of a transient service error (fresh session); its spend still counts.
  if (LIVE && r.result.kind === 'error' && ['rate', 'server', 'network', 'timeout'].includes(r.result.code) && spent <= cap) {
    session.messages.length = 0;
    r = await runAndCheck();
  }
  const model = r.runs.filter(x => x.source === 'model');
  const answer = r.result.kind === 'answer' ? r.result.text : r.result.kind === 'choose' ? `[options] ${r.result.options.map(o => o.label).join('; ')}` : `[error ${r.result.code}]`;
  return {
    id: a.id, category: a.category, ask: a.ask, pass: r.verdict.pass, why: r.verdict.why,
    source: r.result.kind === 'answer' ? r.result.source : r.result.kind === 'choose' ? 'local' : 'model', kind: r.result.kind,
    calls: r.runs.map(x => ({ name: x.name, args: x.args, ok: x.outcome.ok, ...(!x.outcome.ok && { reason: clip(x.outcome.reason, 200) }) })),
    firstCallValid: model.length ? model[0].outcome.ok : null,
    requests: current.requests, promptTokens: current.prompt, completionTokens: current.completion, cost: current.cost,
    ms: Date.now() - t0, answer: clip(answer, 400),
  };
}

function markdown(meta: Record<string, unknown>, rows: Row[]): string {
  const cats = [...new Set(rows.map(r => r.category))];
  const live = rows.filter(r => !r.skipped);
  const pct = (xs: Row[]) => `${xs.filter(r => r.pass).length}/${xs.length}`;
  const lines = [
    `# Chat eval: ${meta.mode} ${meta.model}`, '',
    `- date: ${meta.date}; asks run: ${live.length} of ${rows.length}; local commands: ${meta.local ? 'on' : 'off'}; repeat: ${meta.repeat}`,
    `- passed: ${pct(live)}; reached the model: ${live.filter(r => r.source === 'model').length}; requests: ${meta.requests}`,
    `- tokens: ${meta.promptTokens} prompt, ${meta.completionTokens} completion; cost: $${(meta.cost as number).toFixed(4)} (cap $${meta.cap})`, '',
    '| category | pass |', '|---|---|',
    ...cats.map(c => `| ${c} | ${pct(live.filter(r => r.category === c))} |`), '',
    '| id | pass | via | calls | req | tokens in/out | $ | ms |', '|---|---|---|---|---|---|---|---|',
    ...rows.map(r => `| ${r.id} | ${r.skipped ? 'skipped' : r.pass ? 'pass' : 'FAIL'} | ${r.source} | ${r.calls.map(c => c.name + (c.ok ? '' : '!')).join(', ')} | ${r.requests} | ${r.promptTokens}/${r.completionTokens} | ${r.cost.toFixed(4)} | ${r.ms} |`),
    '', '## Failures', '',
  ];
  for (const r of rows.filter(x => !x.pass && !x.skipped)) {
    lines.push(`### ${r.id} (${r.category})`, `- ask: ${r.ask}`, `- why: ${r.why.join('; ')}`,
      `- calls: ${r.calls.map(c => `${c.name}(${clip(JSON.stringify(c.args), 240)})${c.ok ? '' : ` REFUSED: ${c.reason}`}`).join(' | ') || '(none)'}`,
      `- answer: ${r.answer}`, '');
  }
  return lines.join('\n');
}

describe(`chat eval (${LIVE ? 'live' : 'mocked'})`, () => {
  let ctx: LocalContext | null = null;
  beforeAll(async () => { ctx = USE_LOCAL ? await localContext() : null; });

  it('the matcher reads expectations', () => {
    expect(matches({ a: [1, 2], b: 'x' }, { a: [2] })).toBe(true);
    expect(matches({ a: 'TX' }, { a: { $oneOf: ['TX', 'NM'] } })).toBe(true);
    expect(matches({ a: ['TX', 'NM'] }, { a: { $has: 'NM' } })).toBe(true);
    expect(matches({ a: 5 }, { a: { $gte: 6 } })).toBe(false);
    expect(matches({ a: 'Denver, CO' }, { a: { $re: 'denver' } })).toBe(true);
    expect(matches({ a: null }, { a: null })).toBe(true);
    expect(matches({ a: 'x' }, { b: 'x' })).toBe(false);
  });

  it('uses the production prompt and the recommended models', () => {
    expect(SYSTEM_PROMPT.length).toBeGreaterThan(500);
    if (LIVE) expect(RECOMMENDED_MODELS).toContain(MODEL);
  });

  it('runs the ask set and writes the report', { timeout: 3_600_000 }, async () => {
    if (LIVE) {
      if (!KEY) throw new Error('EVAL_LIVE=1 needs OPENROUTER_API_KEY in the environment');
      const r = await realFetch('https://openrouter.ai/api/v1/key', { headers: { Authorization: `Bearer ${KEY}` } });
      const remaining = (await r.json().catch(() => ({})) as { data?: { limit_remaining?: number | null } }).data?.limit_remaining;
      if (typeof remaining === 'number') {
        // eslint-disable-next-line no-restricted-syntax -- stdout, not DOM
        process.stdout.write(`eval: key has $${remaining.toFixed(2)} remaining\n`);
        cap = Math.min(cap, remaining);
      }
    }
    const chosen = asks.filter(a => !ONLY.length || ONLY.includes(a.id) || ONLY.includes(a.category));
    const rows: Row[] = [];
    let stopped = false;
    for (let rep = 0; rep < REPEAT; rep++) {
      for (const a of chosen) {
        if (stopped || spent > cap) {
          stopped = true;
          rows.push({ id: a.id, category: a.category, ask: a.ask, pass: false, why: ['spend cap reached'], source: '-', kind: '-', calls: [], firstCallValid: null,
            requests: 0, promptTokens: 0, completionTokens: 0, cost: 0, ms: 0, answer: '', skipped: true });
          continue;
        }
        rows.push(await runAsk(a, ctx));
      }
    }
    const ran = rows.filter(r => !r.skipped);
    const meta = {
      mode: LIVE ? 'live' : 'mocked', model: LIVE ? MODEL : 'fixtures', date: new Date().toISOString(), local: USE_LOCAL, repeat: REPEAT, cap,
      requests: ran.reduce((n, r) => n + r.requests, 0), promptTokens: ran.reduce((n, r) => n + r.promptTokens, 0),
      completionTokens: ran.reduce((n, r) => n + r.completionTokens, 0), cost: ran.reduce((n, r) => n + r.cost, 0),
      passed: ran.filter(r => r.pass).length, ran: ran.length, stoppedAtCap: stopped,
    };
    mkdirSync(OUT, { recursive: true });
    const base = join(OUT, `${meta.mode}-${meta.model.replace(/[^a-z0-9.]+/gi, '_')}-${meta.date.replace(/[:.]/g, '-')}`);
    writeFileSync(`${base}.json`, scrub(JSON.stringify({ meta, rows }, null, 1)));
    writeFileSync(`${base}.md`, scrub(markdown(meta, rows)));
    // eslint-disable-next-line no-restricted-syntax -- stdout, not DOM
    process.stdout.write(`eval: ${meta.passed}/${meta.ran} passed, $${meta.cost.toFixed(4)}, report ${base}.md\n`);
    expect(ran.length).toBeGreaterThan(0);
    if (!LIVE) {
      expect(rows.filter(r => !r.pass).map(r => `${r.id}: ${r.why.join('; ')}`)).toEqual([]);
    }
  });
});
