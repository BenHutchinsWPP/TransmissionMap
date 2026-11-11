// Every row and except entry of every route preset names its dataset; bit-matched bands have no band fallback.
import { describe, it, expect } from 'vitest';
import { ROUTE_PRESETS, routePreset, type Match } from './route-presets.js';
import { bandData, bandDataLabel, methodSources, BIT_DATA, BAND_DATA, PROTECT_DATA } from './route-band-data.js';

describe('route band data', () => {
  it('(a) every row and except entry of every preset has a non-empty label', () => {
    let n = 0;
    for (const p of ROUTE_PRESETS) {
      for (const [i, r] of p.rows.entries()) {
        const where = `${p.id} row ${i} ${r.note ?? r.band}`;
        expect(bandDataLabel(r.band, r.match).trim().length, where).toBeGreaterThan(0);
        n++;
        for (const [j, x] of (r.except ?? []).entries()) {
          expect(bandDataLabel(x.band, x.match).trim().length, `${where} except ${j}`).toBeGreaterThan(0);
          n++;
        }
      }
    }
    expect(n).toBeGreaterThan(60);
  });

  it('entries are well formed: label ≤ 48 chars, a vintage, tokens', () => {
    const all = [...Object.values(BIT_DATA).flatMap((t) => Object.values(t)), ...Object.values(BAND_DATA), ...Object.values(PROTECT_DATA)];
    for (const e of all) {
      expect(e.label.length, e.label).toBeLessThanOrEqual(48);
      expect(e.vintage.trim().length, e.label).toBeGreaterThan(0);
      expect(e.tokens.length, e.label).toBeGreaterThan(0);
      for (const t of e.tokens) expect(t.trim().length, e.label).toBeGreaterThan(0);
    }
  });

  it('every bit of every bit-matched band has its own entry', () => {
    for (const [band, table] of Object.entries(BIT_DATA)) expect(Object.keys(table).map(Number), band).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it('(d) literal labels for the named rows', () => {
    expect(bandDataLabel('osm_flags', { bit: 7 })).toBe('OpenStreetMap landuse=military');
    expect(bandDataLabel('flags', { bit: 1 })).toBe('PAD-US DOD + DoD MIRTA');
    expect(bandDataLabel('desig', { bit: 7 })).toBe('PAD-US 4.1 (WA, SW, NP)');
    expect(bandDataLabel('flags2', { bit: 0 })).toBe('BLM sage-grouse RODs 2025–26');
    expect(bandDataLabel('flags2', { bit: 1 })).toBe('BLM sage-grouse RODs 2025–26');
    expect(bandDataLabel('protect', { bit: 7 })).toBe('PAD-US 4.1 Fee (NPS units named Preserve)');
    expect(bandDataLabel('landcover', { codes: [41] })).toBe('NLCD 2025 (MRLC/USGS)');
  });

  it('(e) a bit-matched band throws for an unknown bit or a non-bit match', () => {
    for (const band of ['flags', 'flags2', 'desig', 'osm_flags'] as const) {
      expect(() => bandData(band, { bit: 8 }), band).toThrow();
      expect(() => bandData(band, { codes: [1] } as Match), band).toThrow();
    }
    expect(() => bandData('protect', { codes: [1] })).toThrow();
    expect(() => bandData('protect', { bit: 3 })).toThrow();
  });
});

describe('methodSources', () => {
  const all = (id: string) => methodSources(routePreset(id)!, Object.keys(routePreset(id)!.line_types)[0]).join('; ');
  it('tm-default lists its datasets with licences and no PoPWest', () => {
    const txt = all('tm-default');
    for (const w of ['FEMA', 'FAA', 'Wetlands', 'USA Structures', 'USDA']) expect(txt).toContain(w);
    expect(txt).not.toContain('PoPWest');
    expect(txt).toContain('(ODbL)');
  });
  it('pnas-wu2023 lists PoPWest with its licence', () => {
    expect(all('pnas-wu2023')).toContain('PoPWest exclusions (TNC et al.) (CC BY 4.0)');
  });
  it('has no duplicates and skips nothing it should list', () => {
    const list = methodSources(routePreset('tm-default')!, 'ac230');
    expect(new Set(list).size).toBe(list.length);
    expect(list.length).toBeGreaterThan(5);
  });
});
