import { describe, expect, it } from "vitest";
import { buildSubstationIndex, kvFloor, searchSubstations, snapAt } from "./snap.js";

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
