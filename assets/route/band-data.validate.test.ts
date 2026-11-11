// Real-cube check (excluded from `npm test`, like every *.validate.test.ts): every band / bit entry of
// src/registry/route-band-data.ts has its `tokens` in the cube's own source text (grid.json
// `pd_band_sources` / `osm_band_sources`), so a rebuild with new vintages fails here. Skips when the cube is absent.
// Run: npx vitest run --config vitest.route.config.ts assets/route/band-data.validate.test.ts
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { BIT_DATA, BAND_DATA, PROTECT_DATA, type BandData } from '../../src/registry/route-band-data.js';

const GRID = (process.env.ROUTE_CUBE ?? 'data/route/250m/') + 'grid.json';
const have = existsSync(GRID);
if (!have) console.warn('route cube absent: band-data.validate suite skipped');

type Src = Record<string, { bits?: Record<string, unknown> } & Record<string, unknown>>;
type DesigSrc = { des_tp_to_bit: Record<string, number>; fee_des_tp_to_bit: Record<string, number>; ira: string; sources: Record<string, string> };

describe.skipIf(!have)('band data vs the cube source text', () => {
  const g = JSON.parse(readFileSync(GRID, 'utf8')) as { pd_band_sources: Src; osm_band_sources: Src };
  const pd = g.pd_band_sources;
  const osm = g.osm_band_sources;

  const check = (what: string, e: BandData, source: unknown) => {
    expect(source, `${what}: no source object in the cube`).toBeTruthy();
    const text = JSON.stringify(source).toLowerCase();
    for (const t of e.tokens) expect(text.includes(t.toLowerCase()), `${what}: token "${t}" not in the cube's source text`).toBe(true);
  };

  // flags: pd_band_sources.flags.bits[bit]; osm_flags: osm_band_sources.flags.bits[bit];
  // desig: the cube keys its sources by dataset, not by bit, so a bit's text is the Des_Tp / Fee Des_Tp codes that map to it
  // plus the dataset source(s) it is cut from (desigText), and the bit must have at least one code;
  // flags2: sage_grouse (bits 0-1), superfund (bit 5), bit<N> (bits 2, 3, 4, 6, 7), as build_route_restrict.py writes them.
  const flags2Key = (b: number) => (b <= 1 ? 'sage_grouse' : b === 5 ? 'superfund' : `bit${b}`);

  const desigText = (b: number) => {
    const d = pd.desig as unknown as DesigSrc;
    const codes = [...Object.entries(d.des_tp_to_bit), ...Object.entries(d.fee_des_tp_to_bit)].filter(([, v]) => v === b).map(([k]) => k);
    const srcs = b === 5 ? [d.sources.trails] : b === 7 ? [d.sources.padus_fee] : b === 4 ? [d.sources.wsr_lines, d.sources.padus_designation]
      : b === 2 ? [d.ira, d.sources.padus_designation] : [d.sources.padus_designation];
    return { codes, srcs };
  };

  for (let b = 0; b < 8; b++) {
    it(`flags bit ${b}`, () => check(`flags bit ${b}`, BIT_DATA.flags[b], pd.flags?.bits?.[String(b)]));
    it(`flags2 bit ${b}`, () => check(`flags2 bit ${b}`, BIT_DATA.flags2[b], pd.flags2?.[flags2Key(b)]));
    it(`desig bit ${b}`, () => {
      const { codes, srcs } = desigText(b);
      expect(codes.length, `desig bit ${b}: no Des_Tp code maps to it`).toBeGreaterThan(0);
      check(`desig bit ${b}`, BIT_DATA.desig[b], { codes, srcs });
    });
    it(`osm_flags bit ${b}`, () => check(`osm_flags bit ${b}`, BIT_DATA.osm_flags[b], osm.flags?.bits?.[String(b)]));
  }

  it('protect: GAP and TNC fields', () => {
    check('protect GAP', PROTECT_DATA.gap, pd.protect);
    check('protect TNC', PROTECT_DATA.tnc, pd.protect);
    check('protect preserve', PROTECT_DATA.preserve, pd.protect);
  });

  const src = (band: string) => (band === 'osm_maxkv' ? osm.maxkv : band === 'adj' ? osm.adj : pd[band]);
  for (const [band, e] of Object.entries(BAND_DATA)) it(`${band}`, () => check(band, e!, src(band)));
});
