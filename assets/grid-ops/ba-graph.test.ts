import { describe, it, expect } from 'vitest';
import { buildHour, arc, arrowAt, sizeScale, numbersShown, OFF_AREA, BAS, WECC_AREAS, SOURCE_FUEL, type HourData, type BaHour } from './ba-graph.js';
import { FUEL_LEGEND } from '../../src/colors/fuel.js';

const ba = (load: number | null, gen: number | null, net: number | null, fuels: Record<string, number> = {}): BaHour =>
  ({ load, gen, net, fuels });

function hour(bas: Record<string, BaHour>, pairs: [string, string, number][]): HourData {
  return { at: 0, bas: new Map(Object.entries(bas)), pairs: pairs.map(([b, adj, mw]) => ({ ba: b, adj, mw })) };
}

const props = <T>(fc: GeoJSON.FeatureCollection<GeoJSON.Geometry, T>, key: keyof T, value: unknown) =>
  fc.features.find(f => f.properties[key] === value)?.properties;

describe('buildHour', () => {
  it('averages the two sides of a tie and points the edge from the exporter', () => {
    // BPAT says it sends PGE 1,800; PGE says it takes 2,600 from BPAT.
    const { edges } = buildHour(hour({ BPAT: ba(6800, 13750, 6950), PGE: ba(3900, 2800, -1100) },
      [["BPAT", "PGE", 1800], ["PGE", "BPAT", -2600]]), "ba");
    expect(edges.features).toHaveLength(1);
    expect(edges.features[0].properties).toEqual({ from: "BPAT", to: "PGE", mw: 2200, a: 1800, b: 2600 });
  });

  it('keeps the exporter as `from` when the alphabetically later BA exports', () => {
    const { edges } = buildHour(hour({ AZPS: ba(1, 1, 1), CISO: ba(1, 1, 1) },
      [["CISO", "AZPS", -457], ["AZPS", "CISO", 591]]), "ba");
    expect(edges.features[0].properties).toEqual({ from: "AZPS", to: "CISO", mw: 524, a: 591, b: 457 });
  });

  it('uses one side when only one side reports', () => {
    const { edges } = buildHour(hour({ BPAT: ba(1, 1, 1) }, [["BPAT", "BCHA", -1869]]), "ba");
    expect(edges.features[0].properties).toEqual({ from: "BCHA", to: "BPAT", mw: 1869, a: null, b: 1869 });
  });

  it('marks a neighbour with no load or generation as external', () => {
    const { nodes } = buildHour(hour({ BPAT: ba(6800, 13750, 6950) }, [["BPAT", "BCHA", -1869]]), "ba");
    expect(props(nodes, "id", "BCHA")?.kind).toBe("external");
    expect(props(nodes, "id", "BPAT")?.kind).toBe("ba");
  });

  it('lists each node’s ties with both reports from its own side', () => {
    const { nodes } = buildHour(hour({ BPAT: ba(1, 1, 1), PGE: ba(1, 1, 1) },
      [["BPAT", "PGE", 1800], ["PGE", "BPAT", -2600]]), "ba");
    expect(JSON.parse(props(nodes, "id", "PGE")!.ties)).toEqual([{ with: "BPAT", mw: -2200, mine: -2600, theirs: -1800 }]);
    expect(JSON.parse(props(nodes, "id", "BPAT")!.ties)).toEqual([{ with: "PGE", mw: 2200, mine: 1800, theirs: 2600 }]);
  });

  it('folds EIA-930 sources into the legend fuels and adds coarse and fine', () => {
    const { nodes } = buildHour(hour({ CISO: ba(44000, 39150, -4850, {
      solar_wo_integrated_battery_storage: 17152, solar_w_integrated_battery_storage: 200,
      hydro_excluding_pumped_storage: 3257, battery_storage: -1200, gas: 13668, unknown: 0,
    }) }, []), "ba");
    expect(JSON.parse(props(nodes, "id", "CISO")!.fuels)).toEqual([
      ["solar", 17352], ["hydro", 3257], ["gas", 13668], ["storage", -1200],
    ]);
  });

  it('sums a region and drops the flows inside it', () => {
    const { nodes, edges } = buildHour(hour({
      BPAT: ba(6800, 13750, 6950), PGE: ba(3900, 2800, -1100), CISO: ba(44000, 39150, -4850),
    }, [["BPAT", "PGE", 1100], ["PGE", "BPAT", -1100], ["BPAT", "CISO", 2600], ["CISO", "BPAT", -2600]]), "region");
    const nw = props(nodes, "id", "NW")!;
    expect(nw).toMatchObject({ name: "Northwest", load: 10700, gen: 16550, net: 5850 });
    expect(JSON.parse(nw.members)).toEqual(["BPAT", "PGE"]);
    expect(edges.features.map(e => e.properties)).toEqual([{ from: "NW", to: "CAL", mw: 2600, a: 2600, b: 2600 }]);
  });

  it('keeps Canada its own interconnection group', () => {
    const { nodes } = buildHour(hour({ BPAT: ba(1, 1, 1) }, [["BPAT", "BCHA", -1869]]), "interconnect");
    expect(nodes.features.map(f => f.properties.id).sort()).toEqual(["CAN", "western"]);
  });

  it('reports codes it cannot place and leaves them off the map', () => {
    const { nodes, dropped } = buildHour(hour({ XXXX: ba(1, 1, 1) }, []), "ba");
    expect(dropped).toEqual(["XXXX"]);
    expect(nodes.features).toHaveLength(0);
  });
});

describe('the BA table and fuel map', () => {
  it('places every BA once, on the map', () => {
    expect(new Set(BAS.map(b => b.code)).size).toBe(BAS.length);
    for (const b of BAS) {
      expect(b.lon).toBeGreaterThan(-170);
      expect(b.lon).toBeLessThan(-50);
      expect(b.lat).toBeGreaterThan(14);
      expect(b.lat).toBeLessThan(72);
    }
  });

  it('maps every EIA-930 source to a fuel legend row', () => {
    const ids = new Set(FUEL_LEGEND.map(f => f.id));
    for (const fuel of Object.values(SOURCE_FUEL)) expect(ids.has(fuel)).toBe(true);
  });
});

describe('arc', () => {
  it('starts and ends on its points', () => {
    const pts = arc([0, 0], [10, 0]);
    expect(pts[0]).toEqual([0, 0]);
    expect(pts[pts.length - 1]).toEqual([10, 0]);
    expect(pts[6][1]).toBeGreaterThan(0);
  });
});

describe('arrowAt', () => {
  const deg = (a: [number, number], b: [number, number]) => (Math.round(arrowAt([a, b, b]).rotate) + 360) % 360;
  it('turns the east-pointing head clockwise onto the line, from its start to its end', () => {
    expect(deg([0, 40], [1, 40])).toBe(0);
    expect(deg([1, 40], [0, 40])).toBe(180);
    expect(deg([0, 40], [0, 41])).toBe(270);
    expect(deg([0, 41], [0, 40])).toBe(90);
  });

  it('measures the angle in Web Mercator, where a degree of latitude is longer', () => {
    // One degree east and one north at 45°N is steeper than 45° on the map.
    expect(arrowAt([[0, 45], [1, 46], [1, 46]]).rotate).toBeLessThan(-50);
  });

  it('sits on the middle point of an arc and follows its tangent there', () => {
    const line = arc([0, 30], [10, 30]);
    const { at, rotate } = arrowAt(line);
    expect(at).toEqual(line[6]);
    expect(Math.abs(rotate)).toBeLessThan(1);
  });
});

describe('sizeScale', () => {
  it('measures each BA against its own interconnection', () => {
    expect(sizeScale('CISO', 'ba')).toBe('western');
    expect(sizeScale('BPAT', 'ba')).toBe('western');
    expect(sizeScale('MISO', 'ba')).toBe('eastern');
    expect(sizeScale('ERCO', 'ba')).toBe('ercot');
    expect(sizeScale('BCHA', 'ba')).toBe('CAN');
  });
  it('measures regions by their interconnection, and interconnections on one scale', () => {
    expect(sizeScale('NW', 'region')).toBe('western');
    expect(sizeScale('MIDW', 'region')).toBe('eastern');
    expect(sizeScale('western', 'interconnect')).toBe(sizeScale('eastern', 'interconnect'));
  });
});

describe('WECC areas', () => {
  const west = BAS.filter(b => b.interconnect === "western" || (b.region && ["NW", "CAL", "SW"].includes(b.region)) || ["AESO", "BCHA", "CEN", "CFE"].includes(b.code));
  it('puts every western BA in exactly one area, or in OFF_AREA', () => {
    expect(west.length).toBeGreaterThan(30);
    const owners = (code: string) => Object.entries(WECC_AREAS).filter(([, a]) => a.members.includes(code)).map(([id]) => id);
    for (const b of west) expect(owners(b.code).length + (b.code in OFF_AREA ? 1 : 0), b.code).toBe(1);
  });
  it('groups the pinned BAs into the contract areas', () => {
    const area = (code: string) => Object.keys(WECC_AREAS).find(id => WECC_AREAS[id].members.includes(code));
    expect(area('CISO')).toBe('A22-24-30');
    expect(area('BPAT')).toBe('A40');
    expect(area('AESO')).toBe('A54');
    expect(area('NEVP')).toBe('A18-64');
  });
  it('drops flows inside one area and sums the rest', () => {
    const { nodes, edges } = buildHour(hour({ BPAT: ba(1, 1, 1), PACW: ba(1, 1, 1), CISO: ba(1, 1, 1), BANC: ba(1, 1, 1) },
      [["BPAT", "PACW", 500], ["PACW", "CISO", 300], ["BPAT", "CISO", 100], ["CISO", "BANC", 50]]), "wecc");
    expect(nodes.features.map(f => f.properties.id).sort()).toEqual(["A22-24-30", "A40"]);
    expect(edges.features).toHaveLength(1);
    expect(edges.features[0].properties).toMatchObject({ from: "A40", to: "A22-24-30", mw: 400 });
    expect(props(nodes, "id", "A40")?.name).toBe("Area 40 · Northwest");
    expect(props(nodes, "id", "A40")?.tag).toBe("A40: NW");
    expect(props(nodes, "id", "A22-24-30")?.tag).toBe("A22/24/30: CAISO");
    expect(JSON.parse(props(nodes, "id", "A40")!.members)).toEqual(["BPAT", "PACW"]);
  });
  it('groups WACM into A73 before 2026-04-01 and SWPW into A63-73 after', () => {
    const before = buildHour(hour({ WACM: ba(1, 1, 1) }, []), "wecc");
    const after = buildHour(hour({ SWPW: ba(1, 1, 1) }, []), "wecc");
    expect(before.nodes.features.map(f => f.properties.id)).toEqual(["A73"]);
    expect(after.nodes.features.map(f => f.properties.id)).toEqual(["A63-73"]);
  });
  it('falls back to the EIA region for a BA outside WECC', () => {
    const { nodes } = buildHour(hour({ MISO: ba(1, 1, 1), ERCO: ba(1, 1, 1) }, []), "wecc");
    expect(nodes.features.map(f => f.properties.id).sort()).toEqual(["MIDW", "TEX"]);
    expect(props(nodes, "id", "MIDW")?.name).toBe("Midwest");
    expect(sizeScale('MIDW', 'wecc')).toBe('eastern');
    expect(sizeScale('TEX', 'wecc')).toBe('ercot');
    expect(sizeScale('A40', 'wecc')).toBe('western');
    expect(sizeScale('A54', 'wecc')).toBe('western');
  });
});

describe('off-area and lone BAs', () => {
  const synth = hour({ GRID: ba(100, 50, -50), PNM: ba(1, 1, 1), SRP: ba(1, 1, 1), WALC: ba(1, 1, 1), BPAT: ba(1, 1, 1) },
    [["GRID", "BPAT", 10], ["GRID", "PNM", 20], ["GRID", "SRP", 30], ["GRID", "WALC", 40]]);
  it('keeps GRID its own node in wecc, at OFF_AREA.at, with its reason', () => {
    const { nodes, edges } = buildHour(synth, "wecc");
    const g = props(nodes, "id", "GRID")!;
    expect(g.offArea).toBe(OFF_AREA.GRID.why);
    expect(nodes.features.find(f => f.properties.id === "GRID")!.geometry.coordinates).toEqual(OFF_AREA.GRID.at);
    expect(g.name).toBe('Gridforce Energy Management LLC');
    expect(JSON.parse(props(nodes, "id", "A40")!.members)).toEqual(["BPAT"]);
    expect(props(nodes, "id", "A40")!.offArea).toBe("");
    const to = edges.features.map(e => e.properties).filter(p => p.from === "GRID" || p.to === "GRID").map(p => p.from === "GRID" ? p.to : p.from).sort();
    expect(to).toEqual(["A10", "A15", "A19", "A40"]);
  });
  it('draws GRID at its BA position in ba mode, with no off-area reason', () => {
    const { nodes } = buildHour(synth, "ba");
    expect(props(nodes, "id", "GRID")!.offArea).toBe("");
    expect(nodes.features.find(f => f.properties.id === "GRID")!.geometry.coordinates).not.toEqual(OFF_AREA.GRID.at);
  });
  it('keeps a BA with no region as a node in region mode', () => {
    const { nodes } = buildHour(hour({ GRID: ba(1, 1, 1), CEA: ba(1, 1, 1) }, []), "region");
    expect(nodes.features.map(f => f.properties.id).sort()).toEqual(["CEA", "GRID"]);
    expect(props(nodes, "id", "CEA")?.name).toBe('Chugach Electric Association Inc');
  });
  it('sizes GRID against the western interconnection', () => {
    expect(sizeScale('GRID', 'wecc')).toBe('western');
    expect(sizeScale('GRID', 'region')).toBe('western');
  });
});

describe('node cover and short', () => {
  const one = (b: BaHour, by: 'ba' | 'wecc' = 'ba', code = 'BPAT') => buildHour(hour({ [code]: b }, []), by).nodes.features[0].properties;
  it('is gen over load to 2 decimals', () => { expect(one(ba(3, 1, 0)).cover).toBe(0.33); expect(one(ba(6800, 13750, 0)).cover).toBe(2.02); });
  it('is null without load, with zero load or without gen', () => {
    expect(one(ba(null, 5, 0)).cover).toBeNull();
    expect(one(ba(0, 5, 0)).cover).toBeNull();
    expect(one(ba(5, null, 0)).cover).toBeNull();
  });
  it('is a WECC area code for an area and the id for a BA', () => {
    expect(one(ba(1, 1, 0), 'wecc').short).toBe('NW');
    expect(one(ba(1, 1, 0), 'ba').short).toBe('BPAT');
    expect(one(ba(1, 1, 0), 'wecc', 'MISO').short).toBe('MIDW');
  });
});

describe('numbersShown', () => {
  it('follows the visitor, else off only for WECC areas', () => {
    expect(numbersShown(null, 'wecc')).toBe(false);
    expect(numbersShown(null, 'ba')).toBe(true);
    expect(numbersShown(null, 'region')).toBe(true);
    expect(numbersShown(true, 'wecc')).toBe(true);
    expect(numbersShown(false, 'ba')).toBe(false);
  });
});
