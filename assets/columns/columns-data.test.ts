// @vitest-environment jsdom
// The built columns files (data/analysis/, served by range from disk as the host serves them) answer the
// dataset-scope calls with the same totals as the independent pyarrow reference
// (scripts/check_columns_parquet.py --emit-reference tmp/columns-ref), and within the read budgets of
// docs/roadmap/tier1-parquet.plan.md D5 (world aggregate, the same with Area TX, the two table opens,
// each footer). Runs only with TM_COLUMNS_DATA=1 (needs the built data/analysis/ and the reference);
// skipped otherwise, so CI and `npm test` pass without data/.
// TM_COLUMNS_MUTATE=1 plants a fault: pruneGroups drops the first row group of a call with no
// conditions (the world calls), so the run must fail on the totals.
// Deps: dataset-query.ts (count, aggregate, shapeRows — scope 'dataset'), ui/ui-table.ts (showTable,
//       real, in jsdom through test-drawer-env.ts), columns-read.ts (wrapped), parquet/range-io.ts
//       (requestLog, resetRangeIo), the real layer plans (base filters, legend filters).
import { closeSync, existsSync, openSync, readFileSync, readSync } from 'node:fs';
import { describe as group, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import { state } from '../state.js';
import { seedView } from '../view-state.js';
import { resetRangeIo, requestLog } from '../parquet/range-io.js';
import { resetDecoded } from './columns-read.js';
import { areaCondition, type AreaFilter } from '../../src/registry/area-filter.js';
import { COLUMNS_DATASETS } from '../../src/registry/columns.js';
import { FACET_APPLIERS } from '../filters.js';
import { applyLayerPlan, type LayerPlan } from '../layers/layer-plan.js';
import { planOsmTransmission } from '../layers/map-layers-osm.js';
import { planRetailTerritories } from '../layers/map-layers-hifld.js';
import { planPadus } from '../layers/map-layers-land.js';
import { describe, count, aggregate, query, shapeRows, QUERY_MAX_ROWS, type ShapeResult, type Group } from '../dataset-query.js';

const RUN = process.env.TM_COLUMNS_DATA === '1';

// The planted fault: only under TM_COLUMNS_MUTATE=1, pruneGroups leaves out the first non-empty row group of a
// call with no conditions (every row of it passes such a call). Without the env var it is the real function.
const mut = vi.hoisted(() => ({ on: process.env.TM_COLUMNS_MUTATE === '1', dropped: 0 }));
vi.mock('./columns-read.js', async importOriginal => {
  const m = await importOriginal<typeof import('./columns-read.js')>();
  return {
    ...m,
    pruneGroups: (md: Parameters<typeof m.pruneGroups>[0], conds: Parameters<typeof m.pruneGroups>[1]) => {
      const g = m.pruneGroups(md, conds);
      if (!mut.on || conds.length) return g;
      const drop = g.find(i => Number(md.row_groups[i].num_rows) > 0);
      if (drop === undefined) return g;
      mut.dropped++;
      return g.filter(i => i !== drop);
    },
  };
});

const ROOT = process.cwd() + '/';
const REF_PATH = ROOT + 'tmp/columns-ref/columns-reference.json';
const TL = 'osm-transmission-lines', PADUS = 'padus', RETAIL = 'retail-territories';
const TX: AreaFilter = { kind: 'states', codes: ['TX'] };
const MB = 1_000_000, KiB = 1024;

// ─── The host: data/analysis/ from disk, Range honoured ───────────────────────
interface Served { url: string; start: number | null; end: number | null; bytes: number }
const served: Served[] = [];
const fds = new Map<string, number>();

function serve(url: string, init?: RequestInit): Response {
  if (!url.startsWith('data/analysis/') || url.includes('..')) {
    served.push({ url, start: null, end: null, bytes: 0 });
    return new Response('', { status: 404 });
  }
  const path = ROOT + url;
  if (!existsSync(path)) return new Response('', { status: 404 });
  const range = new Headers(init?.headers).get('range');
  if (!range) {
    const body = readFileSync(path);
    served.push({ url, start: null, end: null, bytes: body.byteLength });
    return new Response(new Uint8Array(body), { status: 200 });
  }
  const m = range.match(/^bytes=(\d+)-(\d+)$/);
  if (!m) return new Response('', { status: 416 });
  const start = Number(m[1]), end = Number(m[2]) + 1;
  let fd = fds.get(path);
  if (fd === undefined) fds.set(path, fd = openSync(path, 'r'));
  const buf = Buffer.alloc(end - start);
  const n = readSync(fd, buf, 0, buf.length, start);
  served.push({ url, start, end: start + n, bytes: n });
  return new Response(new Uint8Array(buf.subarray(0, n)), { status: 206 });
}

// A host answers after a round trip; 20 ms also lets the drawer's grid finish building before a size prompt
// redraws it (jsdom: a prompt raised within the grid's first build throws on its unbuilt element).
const latency = () => new Promise(r => setTimeout(r, 20));

/** Bytes and requests of the columns files (ranged GETs) since the last reset. */
function reads() {
  const ranged = served.filter(s => s.start !== null);
  return { bytes: ranged.reduce((a, s) => a + s.bytes, 0), requests: ranged.length };
}
const measured: Record<string, { bytes: number; requests: number; budget: string }> = {};

function freshIo() {
  resetRangeIo();
  resetDecoded();
  served.length = 0;
}

// ─── A map holding the real layer plans (base filters, legend filters, zooms) ──
function installMap(zoom: number) {
  const added = new Map<string, unknown>();
  const extra = {
    getSource: (id: string) => added.get('s:' + id),
    getLayer: (id: string) => added.get('l:' + id),
    addSource: (id: string, spec: unknown) => { added.set('s:' + id, spec); },
    addLayer: (spec: { id: string }) => { added.set('l:' + spec.id, spec); },
    setFilter: () => {}, setLayoutProperty: () => {}, setPaintProperty: () => {}, on: () => {}, off: () => {},
    once: () => {}, loaded: () => true, getZoom: () => zoom,
    getBounds: () => ({ getWest: () => -180, getSouth: () => -85, getEast: () => 180, getNorth: () => 85 }),
  };
  Object.assign(state.map!, extra);
  state.mapReady = true;
  const plans: LayerPlan = [...planOsmTransmission(), ...planPadus(), ...planRetailTerritories()];
  applyLayerPlan(state.map as never, plans);
  for (const apply of Object.values(FACET_APPLIERS)) apply();
}

// ─── Reference ───────────────────────────────────────────────────────────────
type RefGroups = Record<string, { count: number; sum: number }>;
interface Reference {
  osm_transmission_lines: { admin1_all: RefGroups; 'admin1_US-TX': RefGroups; 'area_US-TX_admin1_code': string; sum_field: string };
  padus: { by_state: RefGroups; sum_field: string };
  retail_territories: { by_type: RefGroups; sum_field: string };
}
let ref: Reference;

const ok = <T,>(r: { ok: true; result: T } | { ok: false; reason: string }): T => {
  if (!r.ok) throw new Error(r.reason);
  return r.result;
};

// The reference keys a value as check_columns_parquet.py does: a region list split on "|", with null or
// empty → "none" (split_region); a plain field's null → "none", "" kept as "". The app groups a missing
// value and "" under the key null (dataset-query.ts keysOf / aggregator). So an app null is the reference's
// "none" for a region list, and "" or "none" for a plain field — each reference that has both would make
// the comparison ambiguous, which `keyOf` refuses.
function keyOf(k: string | number | null, list: boolean, groups: RefGroups): string {
  if (k !== null) return String(k);
  if (list) return 'none';
  const has = ['', 'none'].filter(x => Object.hasOwn(groups, x));
  if (has.length > 1) throw new Error('the reference holds both "" and "none": an app null group matches neither alone');
  return has[0] ?? 'none';
}

// Sums: the reference is math.fsum (correctly rounded); the app adds in file order. For n non-negative
// terms, plain left-to-right summation is within (n−1)·u·Σx of the exact sum (u = 2⁻⁵³, Higham §4.2),
// and fsum within u·Σx, so |app − ref| ≤ n·u·ref, taken here with a 2× margin: n·2⁻⁵²·ref. No looser:
// a dropped row group moves a sum by far more. Integer sums below 2⁵³ (retail customers) are exact,
// so those must be equal.
const sumTol = (n: number, refSum: number) => n * 2 ** -52 * Math.abs(refSum);

function compareGroups(
  label: string, app: Map<string, { count: number; sum?: number }>, want: RefGroups, opts: { sums: boolean; exactSums?: boolean },
) {
  const bad: string[] = [];
  for (const k of new Set([...app.keys(), ...Object.keys(want)])) {
    const a = app.get(k), w = want[k];
    if (!a || !w) { bad.push(`${k}: app ${JSON.stringify(a)} ref ${JSON.stringify(w)}`); continue; }
    if (a.count !== w.count) bad.push(`${k}: count app ${a.count} ref ${w.count}`);
    if (opts.sums) {
      const d = Math.abs((a.sum ?? NaN) - w.sum);
      if (opts.exactSums ? a.sum !== w.sum : !(d <= sumTol(w.count, w.sum))) {
        bad.push(`${k}: sum app ${a.sum} ref ${w.sum} (|Δ| ${d}, tol ${opts.exactSums ? 0 : sumTol(w.count, w.sum)})`);
      }
    }
  }
  expect(bad.slice(0, 20), `${label}: ${bad.length} group(s) differ from the reference`).toEqual([]);
}

function shapeMap(r: ShapeResult, field: string, want: RefGroups) {
  const out = new Map<string, { count: number; sum?: number }>();
  for (const row of r.rows) {
    const k = keyOf(row[field] as string | null, true, want);
    if (out.has(k)) throw new Error(`two rows fold into "${k}"`);
    out.set(k, { count: row.count, sum: row.sum });
  }
  return out;
}

function aggMap(groups: Group[], field: string, sum: string | null, list: boolean, want: RefGroups) {
  const out = new Map<string, { count: number; sum?: number }>();
  for (const g of groups) {
    const k = keyOf(g.key, list, want);
    if (out.has(k)) throw new Error(`two groups fold into "${k}"`);
    out.set(k, { count: g.count, ...(sum && { sum: g.sums[sum] }) });
  }
  return out;
}

const refRows = (g: RefGroups) => Object.values(g).reduce((a, x) => a + x.count, 0);

// ─── Tests ───────────────────────────────────────────────────────────────────
(globalThis as { CSS?: unknown }).CSS ??= { escape: (s: string) => s };

group.skipIf(!RUN)('columns files against the pyarrow reference and the D5 budgets', () => {
  let env: typeof import('../ui/test-drawer-env.js');

  beforeAll(async () => {
    if (!existsSync(REF_PATH)) throw new Error(`${REF_PATH} is missing: run make columns-check ARGS="--emit-reference tmp/columns-ref"`);
    ref = JSON.parse(readFileSync(REF_PATH, 'utf8')) as Reference;
    state.map = null;
    seedView({});
    env = await import('../ui/test-drawer-env.js');
    env.installDrawerEnv();
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => { await latency(); return serve(String(url), init); }));
    installMap(2);
  });
  beforeEach(() => {
    freshIo();
    state.layerVisibility = {};
    state.area = null;
    state.where = {};
    state.sel = null;
  });
  afterAll(() => {
    env?.resetDrawerEnv();
    for (const fd of fds.values()) closeSync(fd);
    fds.clear();
    console.log('measured reads:\n' + Object.entries(measured)
      .map(([k, v]) => `  ${k}: ${v.bytes} bytes, ${v.requests} requests (budget ${v.budget})`).join('\n'));
  });

  it('phrases Area US-TX as the reference does: admin1 contains_any its code', () => {
    expect(areaCondition('osm_transmission_lines', TX))
      .toEqual({ field: 'admin1', op: 'contains_any', value: [ref.osm_transmission_lines['area_US-TX_admin1_code']] });
  });

  it('osm_transmission_lines, world: length_km by admin1 (shapeRows) and counts by admin1 (aggregate)', async () => {
    const want = ref.osm_transmission_lines.admin1_all;
    const s = ok(await shapeRows(TL, { by: ['admin1'], measure: 'length_km' }));
    expect(s).toMatchObject({ scope: 'area', complete: true, truncated: false });
    compareGroups('shapeRows admin1, world', shapeMap(s, 'admin1', want), want, { sums: true });
    const a = ok(await aggregate(TL, { groupBy: 'admin1' }));
    expect(a.complete).toBe(true);
    compareGroups('aggregate admin1, world', aggMap(a.groups, 'admin1', null, true, want), want, { sums: false });
  }, 600_000);

  it('osm_transmission_lines, Area US-TX: the same, and count() equals the lines tagged USAB', async () => {
    const want = ref.osm_transmission_lines['admin1_US-TX'];
    const s = ok(await shapeRows(TL, { by: ['admin1'], measure: 'length_km', area: TX }));
    expect(s).toMatchObject({ scope: 'area', complete: true, truncated: false });
    compareGroups('shapeRows admin1, Area TX', shapeMap(s, 'admin1', want), want, { sums: true });
    const a = ok(await aggregate(TL, { groupBy: 'admin1', area: TX }));
    compareGroups('aggregate admin1, Area TX', aggMap(a.groups, 'admin1', null, true, want), want, { sums: false });
    const c = ok(await count(TL, { area: TX }));
    expect(c).toMatchObject({ complete: true, total: want[ref.osm_transmission_lines['area_US-TX_admin1_code']].count });
    expect(s.totals.count).toBe(c.total);
  }, 600_000);

  it('padus: acres by state (aggregate), and count() equals the rows', async () => {
    const want = ref.padus.by_state;
    const a = ok(await aggregate(PADUS, { groupBy: 'state', sum: ['acres'] }));
    expect(a.complete).toBe(true);
    compareGroups('aggregate padus state', aggMap(a.groups, 'state', 'acres', false, want), want, { sums: true });
    expect(ok(await count(PADUS)).total).toBe(refRows(want));
  }, 600_000);

  it('retail_territories: customers by type (aggregate, integer sums exact), and count() equals the rows', async () => {
    const want = ref.retail_territories.by_type;
    const a = ok(await aggregate(RETAIL, { groupBy: 'type', sum: ['customers'] }));
    expect(a.complete).toBe(true);
    compareGroups('aggregate retail type', aggMap(a.groups, 'type', 'customers', false, want), want, { sums: true, exactSums: true });
    expect(ok(await count(RETAIL)).total).toBe(refRows(want));
  }, 600_000);

  // ─── D5 budgets (cold cache each) ──────────────────────────────────────────
  it('budget: world aggregate, OSM transmission by nominal_kv + sum length_km ≤ 8 MB, ≤ 96 requests', async () => {
    const s = ok(await shapeRows(TL, { by: ['nominal_kv'], measure: 'length_km' }));
    expect(s).toMatchObject({ scope: 'area', complete: true });
    const r = reads();
    measured['world nominal_kv + length_km'] = { ...r, budget: '8 MB, 96 requests' };
    expect(requestLog.length).toBe(r.requests);
    expect(r.bytes).toBeLessThanOrEqual(8 * MB);
    expect(r.requests).toBeLessThanOrEqual(96);
  }, 600_000);

  it('budget: the same with Area TX ≤ 1.5 MB', async () => {
    const s = ok(await shapeRows(TL, { by: ['nominal_kv'], measure: 'length_km', area: TX }));
    expect(s).toMatchObject({ scope: 'area', complete: true });
    const r = reads();
    measured['Area TX nominal_kv + length_km'] = { ...r, budget: '1.5 MB' };
    expect(r.bytes).toBeLessThanOrEqual(1.5 * MB);
  }, 600_000);

  /** The calls a table open over `TL` makes as drawn (ui-table.ts load): the summary — count(), since the layer
   *  has no groupable field — then query() of every allowed field, ≤ QUERY_MAX_ROWS rows, here with no sort. */
  async function tableCalls() {
    const d = ok(describe(TL));
    if (!d.queryable) throw new Error(`${TL} is not queryable`);
    expect(d.fields.filter(f => (f.values || f.valueCount) && !f.list), 'groupable fields (the summary would aggregate)').toEqual([]);
    freshIo();
    const c = ok(await count(TL, { asDrawn: true }));
    const q = ok(await query(TL, { asDrawn: true, fields: d.fields.map(f => f.name), limit: QUERY_MAX_ROWS }));
    expect(c).toMatchObject({ complete: true });
    expect(q).toMatchObject({ complete: true, total: c.total });
    expect(q.rows.length).toBe(Math.min(c.total, QUERY_MAX_ROWS));
    return reads();
  }

  /** The real table drawer opened on `TL` (its size prompt answered with Load), until its rows are in. It opens
   *  sorted by its sum field (nominal_kv, descending), so it is measured for the record, not held to the
   *  no-sort budget. */
  async function openRealTable() {
    const t = await import('../ui/ui-table.js');
    t.closeTable();
    freshIo();
    let prompted = false;
    const shown = t.showTable({ layerId: TL });
    await vi.waitFor(() => {
      const load = document.querySelector<HTMLButtonElement>('.td-status button');
      if (load && !prompted) { prompted = true; load.click(); }
      expect(document.querySelector<HTMLElement>('.td-status')?.hidden && !!document.querySelector('.td-row')).toBe(true);
    }, { timeout: 300_000, interval: 50 });
    await shown;
    expect(served.filter(s => s.start !== null && s.url.includes('/osm_transmission_lines.')).length).toBeGreaterThan(0);
    expect(served.filter(s => !s.url.startsWith('data/analysis/'))).toEqual([]);
    t.closeTable();
    return { ...reads(), prompted };
  }

  it('budget: table open, world OSM transmission, as drawn, no sort ≤ 4 MB', async () => {
    installMap(2);
    state.layerVisibility[TL] = true;
    const ui = await openRealTable();
    measured['real table open, world, as drawn (sorted by nominal_kv desc)'] = { bytes: ui.bytes, requests: ui.requests, budget: `none (record); size prompt ${ui.prompted ? 'shown' : 'not shown'}` };
    const r = await tableCalls();
    measured['table open, world, as drawn, no sort'] = { ...r, budget: '4 MB' };
    expect(r.bytes).toBeLessThanOrEqual(4 * MB);
  }, 600_000);

  it('budget: table open with af=s.TX ≤ 2 MB', async () => {
    installMap(5);
    state.layerVisibility[TL] = true;
    state.area = TX;
    const ui = await openRealTable();
    measured['real table open, af=s.TX (sorted by nominal_kv desc)'] = { bytes: ui.bytes, requests: ui.requests, budget: `none (record); size prompt ${ui.prompted ? 'shown' : 'not shown'}` };
    const r = await tableCalls();
    measured['table open, af=s.TX, no sort'] = { ...r, budget: '2 MB' };
    expect(r.bytes).toBeLessThanOrEqual(2 * MB);
  }, 600_000);

  it('budget: each footer ≤ 256 KiB (index.json footer_len, and the footer request each file was opened with)', async () => {
    const index = JSON.parse(readFileSync(ROOT + 'data/analysis/index.json', 'utf8')) as
      { columns: Record<string, { file: { name: string; footer_len: number } }> };
    for (const ds of COLUMNS_DATASETS) {
      const e = index.columns[ds];
      expect(e, ds).toBeDefined();
      expect(e.file.footer_len + 8, ds).toBeLessThanOrEqual(256 * KiB);
    }
    for (const ds of ['osm_transmission_lines', 'padus', 'retail_territories']) {
      freshIo();
      const layer = { osm_transmission_lines: TL, padus: PADUS, retail_territories: RETAIL }[ds]!;
      ok(await count(layer, { where: [] }));
      const first = served.find(s => s.start !== null);
      expect(first?.url, ds).toContain(`/${ds}.`);
      expect(first!.bytes, ds).toBeLessThanOrEqual(256 * KiB);
      measured[`footer ${ds}`] = { bytes: first!.bytes, requests: 1, budget: '256 KiB' };
    }
  }, 600_000);

  it('the planted fault, when set, was reached', () => {
    if (mut.on) expect(mut.dropped).toBeGreaterThan(0);
  });
});
