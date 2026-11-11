// Measurements (excluded from `npm test`, like every *.validate.test.ts): the grid's crossings
// (route() with profile: true) against the exact crossings (report-read.ts + crossings-exact.ts over
// data/route/report/) on the real cube, tm-default ac500, for the three surface.validate routes plus
// Dallas -> Houston and Chicago -> Indianapolis. Per route and kind: grid count, exact count, matched
// (greedy one-to-one, same kind, |along-route difference| <= 0.62 mi), exact-only, grid-only, median
// matched position difference in metres; per route: bytes read, read ms, exact pass ms, dupDropped,
// families not ok. Writes tmp/route-crossings/{compare.csv (unmatched), matched.csv, <slug>.geojson}.
// Asserted: each route solved and each family read ok. Nothing else.
// Run: npx vitest run --config vitest.route.config.ts assets/route/crossings.validate.test.ts --disableConsoleIntercept
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, openSync, readSync, statSync, mkdirSync, writeFileSync } from 'node:fs';
import type { Fetcher } from './cog-read.js';
import { albersForward, albersInverse } from './grid.js';
import { route, type RouteIO, type RouteResult } from './route.js';
import { readReport } from './report-read.js';
import { exactCrossings } from './crossings-exact.js';
import type { CrossingPoint } from './profile.js';

const CUBE = process.env.ROUTE_CUBE ?? 'data/route/250m/';
const REPORT = 'data/route/report/';
const OUT = 'tmp/route-crossings/';
const have = existsSync(CUBE + 'grid.json') && existsSync(REPORT + 'rivers.parquet');
const TOL_MI = 0.62;
type XY = [number, number];
const ROUTES: { name: string; from: XY; to: XY }[] = [
  { name: 'Front Range (Denver -> Colorado Springs)', from: [-104.99, 39.74], to: [-104.82, 38.83] },
  { name: 'Boise -> SLC', from: [-116.20, 43.62], to: [-111.89, 40.76] },
  { name: 'WY wind -> Las Vegas', from: [-106.3, 41.8], to: [-115.15, 36.17] },
  { name: 'Dallas -> Houston', from: [-96.80, 32.78], to: [-95.37, 29.76] },
  { name: 'Chicago -> Indianapolis', from: [-87.63, 41.88], to: [-86.16, 39.77] },
];
const KINDS: CrossingPoint['kind'][] = ['river', 'road', 'rail', 'pipeline', 'line230', 'line100'];

const fds = new Map<string, Fetcher>();
const io: RouteIO & { reportUrl: string } = {
  baseUrl: CUBE,
  reportUrl: REPORT,
  async fetchJson(url) { return JSON.parse(readFileSync(url, 'utf8')); },
  async byteLength(url) { return statSync(url).size; },
  fetchRange(url, start, end) {
    if (!fds.has(url)) {
      const fd = openSync(url, 'r');
      fds.set(url, async (s, e) => { const buf = Buffer.alloc(e - s); const n = readSync(fd, buf, 0, buf.length, s); return new Uint8Array(buf.buffer, buf.byteOffset, n); });
    }
    return fds.get(url)!(start, end);
  },
};

const haversineM = (a: XY, b: XY) => {
  const r = Math.PI / 180, dLat = (b[1] - a[1]) * r, dLng = (b[0] - a[0]) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * r) * Math.cos(b[1] * r) * Math.sin(dLng / 2) ** 2;
  return 12742000 * Math.asin(Math.sqrt(h));
};
const median = (v: number[]) => { if (!v.length) return NaN; const s = [...v].sort((x, y) => x - y); return s[s.length >> 1]; };
const csvCell = (v: unknown) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const csvRow = (r: unknown[]) => r.map(csvCell).join(',');
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

interface Tot { grid: number; exact: number; matched: number; xOnly: number; gOnly: number; d: number[] }
const totals = new Map<string, Tot>(KINDS.map((k) => [k, { grid: 0, exact: 0, matched: 0, xOnly: 0, gOnly: 0, d: [] }]));
const unmatched: string[] = [csvRow(['route', 'kind', 'mile', 'source', 'name', 'detail', 'lng', 'lat'])];
const matchedCsv: string[] = [csvRow(['route', 'kind', 'grid_mile', 'exact_mile', 'dist_m', 'grid_name', 'grid_detail', 'exact_name', 'exact_detail', 'lng', 'lat'])];

describe.skipIf(!have)('grid crossings vs exact crossings (tm-default ac500)', () => {
  mkdirSync(OUT, { recursive: true });
  for (const rt of ROUTES) {
    it(rt.name, async () => {
      const t0 = performance.now();
      const res = await route({ from: rt.from, to: rt.to, preset: 'tm-default', lineType: 'ac500', profile: true }, io);
      const solveMs = performance.now() - t0;
      expect(res.ok, res.ok ? '' : res.reason).toBe(true);
      const r = (res as { ok: true; result: RouteResult }).result;
      const grid = r.profile?.crossings;
      expect(grid).toBeTruthy();
      writeFileSync(`${OUT}${slug(rt.name)}.geojson`, JSON.stringify({ type: 'Feature', properties: { name: rt.name, lengthMi: r.lengthMi }, geometry: r.path }));
      const poly = r.path.coordinates.map(([x, y]) => albersForward(x, y) as [number, number]);

      const tR = performance.now();
      const rep = await readReport(io, [poly], Date.now() + 120_000);
      const readMs = performance.now() - tR;
      const tX = performance.now();
      const ex = exactCrossings([poly], rep.features, { toLngLat: albersInverse as (x: number, y: number) => [number, number], lengthsMi: [r.lengthMi] })[0];
      const exMs = performance.now() - tX;
      const bad = Object.entries(rep.status).filter(([, s]) => !s.ok);
      const bytes = Object.values(rep.status).reduce((s, x) => s + x.bytes, 0);

      const lines = ['', `${rt.name}  ${r.lengthMi.toFixed(1)} mi  solve ${(solveMs / 1000).toFixed(1)} s  features ${rep.features.length}  bytes ${(bytes / 1048576).toFixed(2)} MB  read ${readMs.toFixed(0)} ms  exact pass ${exMs.toFixed(0)} ms  dupDropped ${ex.dupDropped}  families not ok: ${bad.length ? bad.map(([f, s]) => `${f} (${s.note})`).join('; ') : 'none'}`,
        `${'kind'.padEnd(10)}${'grid'.padStart(6)}${'exact'.padStart(7)}${'matched'.padStart(9)}${'exactOnly'.padStart(11)}${'gridOnly'.padStart(10)}${'med |d| m'.padStart(11)}`];
      for (const kind of KINDS) {
        const g = grid!.points.filter((p) => p.kind === kind), e = ex.points.filter((p) => p.kind === kind);
        const used = new Set<number>(), dm: number[] = [];
        let matched = 0;
        // greedy one-to-one: closest pairs first
        const pairs: [number, number, number][] = [];
        e.forEach((p, i) => g.forEach((q, j) => { const d = Math.abs(p.mi - q.mi); if (d <= TOL_MI) pairs.push([d, i, j]); }));
        pairs.sort((a, b) => a[0] - b[0]);
        const usedE = new Set<number>();
        for (const [, i, j] of pairs) {
          if (usedE.has(i) || used.has(j)) continue;
          usedE.add(i); used.add(j); matched++;
          const d = haversineM(e[i].lngLat, g[j].lngLat); dm.push(d);
          matchedCsv.push(csvRow([rt.name, kind, g[j].mi.toFixed(3), e[i].mi.toFixed(3), d.toFixed(0), g[j].name, g[j].detail, e[i].name, e[i].detail, e[i].lngLat[0].toFixed(5), e[i].lngLat[1].toFixed(5)]));
        }
        e.forEach((p, i) => { if (!usedE.has(i)) unmatched.push(csvRow([rt.name, kind, p.mi.toFixed(3), 'exact', p.name, p.detail, p.lngLat[0].toFixed(5), p.lngLat[1].toFixed(5)])); });
        g.forEach((p, j) => { if (!used.has(j)) unmatched.push(csvRow([rt.name, kind, p.mi.toFixed(3), 'grid', p.name, p.detail, p.lngLat[0].toFixed(5), p.lngLat[1].toFixed(5)])); });
        const t = totals.get(kind)!;
        t.grid += g.length; t.exact += e.length; t.matched += matched; t.xOnly += e.length - matched; t.gOnly += g.length - matched; t.d.push(...dm);
        lines.push(`${kind.padEnd(10)}${String(g.length).padStart(6)}${String(e.length).padStart(7)}${String(matched).padStart(9)}${String(e.length - matched).padStart(11)}${String(g.length - matched).padStart(10)}${(dm.length ? median(dm).toFixed(0) : '-').padStart(11)}`);
      }
      console.log(lines.join('\n'));
      writeFileSync(`${OUT}compare.csv`, unmatched.join('\n') + '\n');
      writeFileSync(`${OUT}matched.csv`, matchedCsv.join('\n') + '\n');
      expect(bad.map(([f]) => f)).toEqual([]);
    }, 600_000);
  }

  it('totals', () => {
    const lines = ['', 'totals over all routes', `${'kind'.padEnd(10)}${'grid'.padStart(6)}${'exact'.padStart(7)}${'matched'.padStart(9)}${'exactOnly'.padStart(11)}${'gridOnly'.padStart(10)}${'med |d| m'.padStart(11)}`];
    for (const kind of KINDS) {
      const t = totals.get(kind)!;
      lines.push(`${kind.padEnd(10)}${String(t.grid).padStart(6)}${String(t.exact).padStart(7)}${String(t.matched).padStart(9)}${String(t.xOnly).padStart(11)}${String(t.gOnly).padStart(10)}${(t.d.length ? median(t.d).toFixed(0) : '-').padStart(11)}`);
    }
    console.log(lines.join('\n'));
  });
});
