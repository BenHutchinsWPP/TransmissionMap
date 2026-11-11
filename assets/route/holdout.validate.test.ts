// Held-out route set: the 27 PNAS corridors (tm-default and pnas-wu2023), ~200 PNAS spurs, the 8 default routes and
// 300 built HIFLD lines (fixtures/holdout-routes.json; spur and line groups, CAL/HOLD split frozen in
// fixtures/holdout-split.json). First describe: the split rules, run from the fixtures alone (no cube).
// Second describe: solves every route on the cube in data/route/250m/ (cap 100e6, ac500 for corridors and spurs, the line's
// own type for lines) and records one row per route. A failed solve is a row with its Outcome reason.
// HOLDOUT_OUT=<file.json> writes the rows; HOLDOUT_ONLY=<substring> and HOLDOUT_LIMIT=<n> narrow the run.
// Run: npx vitest run --config vitest.route.config.ts assets/route/holdout.validate.test.ts --maxWorkers=4 --disableConsoleIntercept
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, writeFileSync, openSync, readSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { route, readGridJson, type RouteIO } from './route.js';
import type { Fetcher } from './cog-read.js';

const CUBE = process.env.ROUTE_CUBE ?? 'data/route/250m/';
const CAP = 100e6;
type XY = [number, number];
interface HoldRoute {
  id: string; set: string; split: 'CAL' | 'HOLD' | 'none'; group: string | null; from: XY; to: XY;
  presets: string[]; lineType: string; region?: string; tercile?: number;
}
const routes: HoldRoute[] = JSON.parse(readFileSync('assets/route/fixtures/holdout-routes.json', 'utf8')).routes;
const frozen = JSON.parse(readFileSync('assets/route/fixtures/holdout-split.json', 'utf8'));
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

/** CAL when the first hex digit of sha256(group id) is even. */
const parity = (group: string): 'CAL' | 'HOLD' => (parseInt(sha(group)[0], 16) % 2 === 0 ? 'CAL' : 'HOLD');
/** The key a route is split by: its group (never its own id). */
const splitKey = (r: HoldRoute): string => r.group!;

function haversineM(a: XY, b: XY): number {
  const rad = Math.PI / 180, dp = (b[1] - a[1]) * rad, dl = (b[0] - a[0]) * rad;
  const h = Math.sin(dp / 2) ** 2 + Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin(dl / 2) ** 2;
  return 2 * 6371008.8 * Math.asin(Math.sqrt(h));
}

/** Spur groups: connected components of "an end of one within 5 km of an end of the other"; id = smallest member id. */
function spurGroups(spurs: HoldRoute[]): Map<string, string> {
  const par = spurs.map((_, i) => i);
  const find = (i: number): number => { while (par[i] !== i) { par[i] = par[par[i]]; i = par[i]; } return i; };
  for (let i = 0; i < spurs.length; i++) for (let j = 0; j < i; j++)
    if ([spurs[i].from, spurs[i].to].some((a) => [spurs[j].from, spurs[j].to].some((b) => haversineM(a, b) <= 5000))) par[find(i)] = find(j);
  const members = new Map<number, string[]>();
  spurs.forEach((s, i) => { const k = find(i); members.set(k, [...(members.get(k) ?? []), s.id.replace(/^spur:/, '')]); });
  const out = new Map<string, string>();
  for (const ms of members.values()) { const g = ms.reduce((a, b) => (a < b ? a : b)); for (const m of ms) out.set(m, g); }
  return out;
}

describe('Holdout split (frozen)', () => {
  it('has the frozen id list and counts', () => {
    expect(sha(routes.map((r) => r.id).sort().join('\n'))).toBe(frozen.idListSha256);
    expect(routes.length).toBe(frozen.total);
    const cnt: Record<string, number> = {};
    for (const r of routes) cnt[`${r.set}|${r.split}`] = (cnt[`${r.set}|${r.split}`] ?? 0) + 1;
    expect(Object.fromEntries(Object.entries(cnt).sort())).toEqual(frozen.counts);
    expect(new Set(routes.filter((r) => r.set === 'pnas-spurs').map((r) => r.group)).size).toBe(frozen.spurGroups);
    expect(new Set(routes.filter((r) => r.set === 'holdout-lines').map((r) => r.group)).size).toBe(frozen.lineGroups);
    expect(new Set(routes.map((r) => r.id)).size).toBe(routes.length);
  });

  it('splits spurs and lines by the parity of their group id, with spur groups recomputed from the ends', () => {
    const spurs = routes.filter((r) => r.set === 'pnas-spurs');
    const groups = spurGroups(spurs);
    for (const s of spurs) expect(s.group, s.id).toBe(groups.get(s.id.replace(/^spur:/, '')));
    for (const r of routes.filter((x) => x.set === 'pnas-spurs' || x.set === 'holdout-lines')) expect(r.split, r.id).toBe(parity(splitKey(r)));
    for (const r of routes.filter((x) => x.set !== 'pnas-spurs' && x.set !== 'holdout-lines')) expect(r.split).toBe('none');
  });

  it('puts no spur group or line group in both splits', () => {
    const seen = new Map<string, Set<string>>();
    for (const r of routes.filter((x) => x.group)) seen.set(`${r.set}|${r.group}`, (seen.get(`${r.set}|${r.group}`) ?? new Set()).add(r.split));
    expect(seen.size).toBeGreaterThan(0);
    for (const [g, s] of seen) expect(s.size, g).toBe(1);
  });
});

function fileFetcher(path: string): Fetcher {
  const fd = openSync(path, 'r');
  return async (start, end) => {
    const buf = Buffer.alloc(end - start);
    const n = readSync(fd, buf, 0, buf.length, start);
    return new Uint8Array(buf.buffer, buf.byteOffset, n);
  };
}
const lineIO = (): RouteIO => {
  const fds = new Map<string, Fetcher>();
  return {
    baseUrl: CUBE,
    async fetchJson(url) { return JSON.parse(readFileSync(url, 'utf8')); },
    fetchRange(url, start, end) {
      if (!fds.has(url)) fds.set(url, fileFetcher(url));
      return fds.get(url)!(start, end);
    },
  };
};

const have = existsSync(CUBE + 'grid.json');
if (have) { const m = readGridJson(JSON.parse(readFileSync(CUBE + 'grid.json', 'utf8'))); if (typeof m === 'string') throw new Error(m); }

/** Routes with the largest buffer factor (1, then x0.75 steps) whose bbox fits CAP. */
async function routeFitting(req: { from: XY; to: XY; preset: string; lineType: string }, io: RouteIO) {
  let factor = 1;
  for (;;) {
    const out = await route({ ...req, cap: CAP, bufferFactor: factor }, io);
    const tooBig = !out.ok && /exceeds the cap/.test(out.reason);
    if (!tooBig || factor < 0.1) return { out, factor };
    factor = Math.round(factor * 0.75 * 100) / 100;
  }
}

describe.skipIf(!have)('Holdout: solving every held-out route on the cube', () => {
  it('solves and records', async () => {
    const only = process.env.HOLDOUT_ONLY, limit = Number(process.env.HOLDOUT_LIMIT || Infinity);
    const todo = routes.filter((r) => !only || r.id.includes(only)).slice(0, limit);
    const io = lineIO();
    const rows: Record<string, unknown>[] = [];
    for (const r of todo) for (const preset of r.presets) {
      const base = { id: r.id, set: r.set, split: r.split, group: r.group, preset, lineType: r.lineType, region: r.region ?? null, tercile: r.tercile ?? null, from: r.from, to: r.to };
      const t0 = performance.now();
      const { out, factor } = await routeFitting({ from: r.from, to: r.to, preset, lineType: r.lineType }, io);
      const wallMs = performance.now() - t0;
      if (!out.ok) { rows.push({ ...base, ok: false, error: out.reason, wallMs, bufferFactor: factor }); console.log(`${r.id} ${preset}: FAILED ${out.reason}`); continue; }
      const x = out.result;
      rows.push({
        ...base, ok: true, path: x.path.coordinates, cellsSha256: sha(JSON.stringify(x.path.coordinates)), lengthMi: x.lengthMi,
        total2025: x.cost.total2025, routingCost: x.routeCost, optimality: x.optimality, maskLimited: x.maskLimited,
        timingsMs: x.timingsMs, bboxCells: x.cells.bbox, cells: x.cells, bufferM: x.bufferM, bufferFactor: factor, wallMs,
      });
      console.log(`${r.id.padEnd(34)} ${preset.padEnd(10)} ${x.lengthMi.toFixed(1)} mi ${x.optimality} att ${x.timingsMs.attempts.length} ${(wallMs / 1000).toFixed(1)} s`);
    }
    if (process.env.HOLDOUT_OUT) writeFileSync(process.env.HOLDOUT_OUT, JSON.stringify(rows));
    expect(rows.length).toBe(todo.reduce((n, r) => n + r.presets.length, 0));
  }, 36_000_000);
});
