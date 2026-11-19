import { describe, expect, it } from "vitest";
import { buildSubstationIndex, kvFloor, osmKv, searchSubstations, snapAmong, snapAt, type OsmPoint } from "./snap.js";

const pt = (id: string, name: string, kv: number | null, states: string, lng: number, lat: number) => ({
  type: "Feature" as const,
  geometry: { type: "Point" as const, coordinates: [lng, lat] },
  properties: { hifld_id: id, name, max_kv: kv, states, ba: "|BPAT|" },
});
const fc: GeoJSON.FeatureCollection = {
  type: "FeatureCollection",
  features: [
    pt("1", "Alvey", 500, "|OR|", -123, 44),
    pt("2", "Malvey Tap", 230, "|OR|", -123.001, 44),
    pt("3", "Alvord", null, "|OR|", -123.002, 44),
    pt("4", "Alvin Low", 69, "|OR|", -123.0005, 44),
    pt("5", "UNKNOWN123456", 345, "|OR|", -123.01, 44),
    pt("6", "Anchorage", 345, "|AK|", -123, 44),
    pt("7", "Far", 500, "|OR|", -123, 44.03),
  ],
};
const idx = buildSubstationIndex(fc);

describe("kvFloor", () => {
  it("ladder", () => {
    expect([500, 345, 230, 161, 138, 115, 69, 20].map(kvFloor)).toEqual([345, 230, 115, 138, 115, 69, 69, 69]);
    expect(kvFloor(765)).toBe(500);
  });
});

describe("index", () => {
  it("drops non-CONUS", () => {
    expect(idx.subs.map((s) => s.id)).not.toContain("6");
    expect(idx.subs).toHaveLength(6);
  });
});

describe("snapAt", () => {
  it("orders known kV first, unknown after, skips ineligible", () => {
    const r = snapAt(idx, [-123, 44], 345);
    expect(r.best?.id).toBe("1");
    expect(r.others.map((h) => h.id)).toEqual(["2", "5", "3"]);
    expect(r.others[2].kvUnknown).toBe(true);
    expect(snapAt(idx, [-123.0005, 44], 69).best?.id).toBe("4");
    expect(r.others.map((h) => h.id)).not.toContain("4");
  });
  it("placeholder snappable with null name; unknown kV flagged", () => {
    const r = snapAt(idx, [-123.01, 44], 345);
    expect(r.best?.id).toBe("5");
    expect(r.best?.name).toBeNull();
    expect(snapAt(idx, [-123.002, 44], 345).best?.id).toBe("2");
  });
  it("every hit is HIFLD; the rest of the hit is as before", () => {
    const r = snapAt(idx, [-123, 44], 345);
    expect([r.best, ...r.others].every((h) => h?.source === "hifld")).toBe(true);
    expect(r.best).toEqual({
      id: "1", name: "Alvey", lngLat: [-123, 44], maxKv: 500, kvUnknown: false, distanceKm: 0,
      states: ["OR"], ba: ["BPAT"], source: "hifld",
    });
    expect(searchSubstations(idx, "alv", 345).every((h) => h.source === "hifld")).toBe(true);
  });
  it("radius boundary", () => {
    expect(snapAt(idx, [-123, 44.03], 500, 1).best?.id).toBe("7");
    expect(snapAt(idx, [-123, 44.02], 500, 1).best).toBeNull();
    expect(snapAt(idx, [-123, 44.02], 500, 3).best?.id).toBe("7");
  });
});

describe("string max_kv (HIFLD)", () => {
  const sfc: GeoJSON.FeatureCollection = {
    type: "FeatureCollection",
    features: [
      pt("a", "Strong", "500.0" as unknown as number, "|OR|", -123, 44),
      pt("b", "Weak", "69.0" as unknown as number, "|OR|", -123.0005, 44),
      pt("c", "Blank", "" as unknown as number, "|OR|", -123.001, 44),
      pt("d", "Garbage", "abc" as unknown as number, "|OR|", -123.0015, 44),
      pt("e", "", "" as unknown as number, "|OR|", -123.002, 44),
    ],
  };
  const sidx = buildSubstationIndex(sfc);
  it("parses numeric strings and treats blank/garbage as unknown", () => {
    expect(sidx.subs.map((s) => s.maxKv)).toEqual([500, 69, null, null, null]);
  });
  it("applies the kV floor to string values and flags unknowns", () => {
    const r = snapAt(sidx, [-123, 44], 500);
    expect(r.best?.id).toBe("a");
    const ids = [r.best, ...r.others].map((h) => h?.id);
    expect(ids).not.toContain("b");
    expect(ids).toEqual(expect.arrayContaining(["c", "d", "e"]));
    expect(r.others.every((h) => h.kvUnknown)).toBe(true);
    expect(r.others.find((h) => h.id === "e")?.name).toBeNull();
  });
});

describe("searchSubstations", () => {
  it("short query empty, placeholders excluded", () => {
    expect(searchSubstations(idx, "a", 500)).toEqual([]);
    expect(searchSubstations(idx, "unknown", 500)).toEqual([]);
  });
  it("prefix before substring; lower kV last within tier", () => {
    const r = searchSubstations(idx, "ALV", 345);
    expect(r.map((h) => h.id)).toEqual(["1", "3", "4", "2"]);
    expect(Number.isNaN(r[0].distanceKm)).toBe(true);
  });
});

describe("osmKv", () => {
  it("numeric > 0, number or string; anything else unknown", () => {
    const table: [unknown, number | null][] = [
      [345, 345], ["345", 345], [" 230 ", 230], ["69.0", 69],
      ["", null], [" ", null], [undefined, null], [null, null], [0, null], ["0", null], [-1, null], ["-1", null],
      ["345;115", null], ["abc", null], [NaN, null], [Infinity, null], [true, null], [{}, null],
    ];
    for (const [v, kv] of table) expect([v, osmKv(v)]).toEqual([v, kv]);
  });
});

describe("snapAmong (OSM points)", () => {
  // Reno, NV: on the routing grid, in the US.
  const at: [number, number] = [-119.8, 39.5];
  const p = (fid: number, kv: number | null, dLng: number, o: Partial<OsmPoint> = {}): OsmPoint =>
    ({ fid, lngLat: [at[0] + dLng, at[1]], name: `S${fid}`, kv, subType: "transmission", countries: "|USA|", ...o });

  it("nearest known kV at or above the floor (500 kV line → 345 floor)", () => {
    const pts = [p(1, 230, 0.001), p(2, 345, 0.01), p(3, 500, 0.02)];
    const h = snapAmong(pts, at, 500);
    expect(h).toMatchObject({ id: "osm:2", name: "S2", maxKv: 345, kvUnknown: false, states: [], ba: [], source: "osm" });
    expect(h?.lngLat).toEqual([at[0] + 0.01, at[1]]);
    expect(h?.distanceKm).toBeCloseTo(0.86, 1);
    expect(snapAmong(pts, at, 230)?.id).toBe("osm:1");   // 230 line → 115 floor
  });

  it("refuses unknown kV (no fall-back to an unknown point)", () => {
    expect(snapAmong([p(1, null, 0.001)], at, 345)).toBeNull();
    expect(snapAmong([p(1, null, 0.001), p(2, 345, 0.02)], at, 345)?.id).toBe("osm:2");
  });

  it("drops traction and industrial (any case, padded) and minor_distribution", () => {
    const pts = [
      p(1, 500, 0.001, { subType: "traction" }), p(2, 500, 0.002, { subType: " Industrial " }),
      p(3, 500, 0.003, { subType: "minor_distribution" }), p(4, 500, 0.004, { subType: null }),
    ];
    expect(snapAmong(pts, at, 345)?.id).toBe("osm:4");
    expect(snapAmong(pts.slice(0, 3), at, 345)).toBeNull();
  });

  it("radius edge", () => {
    const one = [p(1, 345, 0.0347)];   // ≈ 2.98 km east at 39.5° N
    expect(snapAmong(one, at, 345, 3)?.id).toBe("osm:1");
    expect(snapAmong(one, at, 345, 2.9)).toBeNull();
    expect(snapAmong([p(1, 345, 0.04)], at, 345, 3)).toBeNull();
  });

  it("a blank name keeps the hit with name null", () => {
    expect(snapAmong([p(1, 345, 0.001, { name: "  " })], at, 345)).toMatchObject({ id: "osm:1", name: null });
    expect(snapAmong([p(1, 345, 0.001, { name: null })], at, 345)).toMatchObject({ id: "osm:1", name: null });
  });

  it("US points on the routing grid only", () => {
    expect(snapAmong([p(1, 345, 0.001, { countries: "|CAN|" })], at, 345)).toBeNull();
    expect(snapAmong([p(1, 345, 0.001, { countries: null })], at, 345)).toBeNull();
    expect(snapAmong([p(1, 345, 0.001, { countries: "|CAN|USA|" })], at, 345)?.id).toBe("osm:1");
    // A US-tagged point off the grid (Hawaii) is refused.
    const hi: [number, number] = [-157.85, 21.3];
    expect(snapAmong([{ fid: 9, lngLat: [hi[0] + 0.001, hi[1]], name: "H", kv: 138, countries: "|USA|" }], hi, 138)).toBeNull();
  });
});
