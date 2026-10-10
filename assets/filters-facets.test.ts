// @vitest-environment jsdom
// Legend facet appliers on a recording fake map. FIXTURE is the literal
// (map layers, field, bucket ids, value map) each common-pattern facet filters
// with; every subset of its buckets must reach exactly those map layers with
// compileBucketExpr() over exactly that tuple. Also: every facet has an
// applier, every legend row carries one, each non-standard facet keeps its
// hand applier, and every generically applied facet resolves its targets.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { state } from './state.js';
import * as filters from './filters.js';
import { compileBucketExpr, facetValueMap, FACET_APPLIERS } from './filters.js';
import { FACETS } from '../src/colors/facets.js';
import { LEGEND_FILTERS } from './ui/ui-legends.js';
import { layerById } from '../src/registry/index.js';

interface Row {
  key: string;
  mapLayerIds: string[];
  field: string;
  bucketIds: string[];
  valueMap: Record<string, string[]>;
}

const FIXTURE: Row[] = [
  { key: "pipeline", mapLayerIds: ["osm-pipelines-points"], field: "pipeline",
    bucketIds: ["pig_launcher", "compressor", "delivery", "interconnect", "end", "other"],
    valueMap: {
      pig_launcher: ["pig_launcher"], compressor: ["substation", "pump_station"],
      delivery: ["delivery", "receipt", "reciept", "measurement", "meter"],
      interconnect: ["interconnect"], end: ["end"],
    } },
  { key: "crithab", mapLayerIds: ["crithab-fill", "crithab-outline"], field: "listing_st",
    bucketIds: ["endangered", "threatened", "prop-endangered", "prop-threatened"],
    valueMap: {
      endangered: ["Endangered"], threatened: ["Threatened"],
      "prop-endangered": ["Proposed Endangered"], "prop-threatened": ["Proposed Threatened"],
    } },
  { key: "padus", mapLayerIds: ["padus-fill", "padus-outline"], field: "desig",
    bucketIds: ["blm", "forest", "refuge", "park", "wild", "conserv", "state", "local", "private", "military", "other"],
    valueMap: {
      blm: ["National Public Lands"],
      forest: ["National Forest", "National Grassland"],
      refuge: ["National Wildlife Refuge"],
      park: ["National Park", "National Monument", "National Recreation Area", "National Lakeshore or Seashore",
             "National Scenic or Historic Trail", "National Scenic, Botanical or Volcanic Area"],
      wild: ["State Wilderness", "Wild and Scenic River"],
      conserv: ["Conservation Area", "Resource Management Area", "Recreation Management Area",
                "Watershed Protection Area", "Research or Educational Area", "Special Designation Area"],
      state: ["State Resource Management Area", "State Conservation Area", "State Park", "State Recreation Area",
              "State Other or Unknown", "State Historic or Cultural Area"],
      local: ["Local Conservation Area", "Local Other or Unknown", "Local Resource Management Area", "Local Park",
              "Local Recreation Area", "Local Historic or Cultural Area"],
      private: ["Private Conservation", "Private Other or Unknown", "Private Recreation or Education", "Private Ranch",
                "Private Park", "Private Forest Stewardship", "Private Historic or Cultural", "Private Agricultural",
                "Conservation Easement", "Forest Stewardship Easement", "Mitigation Land or Bank"],
      military: ["Military Land"],
      other: [],
    } },
  { key: "tribal", mapLayerIds: ["tribal-fill", "tribal-outline"], field: "area_type",
    bucketIds: ["reservation", "hawaiian", "anvsa", "otsa", "sdtsa", "tdsa", "statereserv"],
    valueMap: {
      reservation: ["American Indian Reservation", "Off-Reservation Trust Land", "Reservation / Off-Reservation Trust Land"],
      hawaiian: ["Hawaiian Home Land"],
      anvsa: ["Alaska Native Village Statistical Area"],
      otsa: ["Oklahoma Tribal Statistical Area"],
      sdtsa: ["State-Designated Tribal Statistical Area"],
      tdsa: ["Tribal-Designated Statistical Area"],
      statereserv: ["State American Indian Reservation"],
    } },
  { key: "natgasLine",
    mapLayerIds: ["hifld-natgas-interstate", "hifld-natgas-intrastate", "hifld-natgas-hgl", "hifld-natgas-gathering"],
    field: "pipe_type", bucketIds: ["interstate", "intrastate", "hgl", "gathering"],
    valueMap: { interstate: ["Interstate"], intrastate: ["Intrastate"], hgl: ["HGL"], gathering: ["Gathering"] } },
  { key: "natgasPts", mapLayerIds: ["hifld-natgas-points", "hifld-petroleum-facilities"], field: "fac_type",
    bucketIds: ["lng_terminal", "underground", "spr", "trading_hub", "processing", "border_cross", "peak_shaving",
                "lng_storage", "pol_terminal"],
    valueMap: {
      lng_terminal: ["lng_terminal"], underground: ["underground"], spr: ["spr"], trading_hub: ["trading_hub"],
      processing: ["processing"], border_cross: ["border_cross"], peak_shaving: ["peak_shaving"],
      lng_storage: ["lng_storage"], pol_terminal: ["pol_terminal"],
    } },
  { key: "substance", mapLayerIds: ["osm-pipelines-lines"], field: "substance",
    bucketIds: ["gas", "oil", "products", "hydrogen", "coal", "other"],
    valueMap: {
      gas: ["gas", "natural_gas", "cng", "methane", "lng", "LNG", "landfill_gas", "coke_gas", "syngas", "fcc_gas"],
      oil: ["oil", "crude_oil", "petroleum", "condensate"],
      products: ["fuel", "ngl", "lpg", "propane", "butane", "isobutane", "n-butane", "liquid_butane", "pentane",
                 "isopentane", "y-grade", "ethane", "naphtha", "gasoline", "diesel", "jet_fuel", "kerosene", "hvl",
                 "natural_gasoline", "gasoil"],
      hydrogen: ["hydrogen", "liquid_hydrogen"],
      coal: ["coal"],
    } },
  { key: "nerc", mapLayerIds: ["nerc-fill", "nerc-outline"], field: "code",
    bucketIds: ["WECC", "SERC", "RFC", "NPCC", "MRO", "SPP", "TRE", "FRCC"],
    valueMap: {
      WECC: ["WECC"], SERC: ["SERC"], RFC: ["RFC"], NPCC: ["NPCC"],
      MRO: ["MRO"], SPP: ["SPP"], TRE: ["TRE"], FRCC: ["FRCC"],
    } },
  { key: "retail", mapLayerIds: ["retail-fill", "retail-outline"], field: "type",
    bucketIds: ["iou", "coop", "muni", "public", "other"],
    valueMap: {
      iou: ["INVESTOR OWNED"], coop: ["COOPERATIVE"],
      muni: ["MUNICIPAL", "MUNICIPAL MKTG AUTHORITY"],
      public: ["STATE", "FEDERAL", "POLITICAL SUBDIVISION"],
    } },
  { key: "dcm",
    mapLayerIds: ["dcm-state-fill", "dcm-state-line", "dcm-utility-fill", "dcm-utility-line",
                  "dcm-county-fill", "dcm-county-line", "dcm-points-recent", "dcm-points"],
    field: "cls", bucketIds: ["ban", "active", "pending", "ended"],
    valueMap: { ban: ["ban"], active: ["active"], pending: ["pending"], ended: ["ended"] } },
];

function fakeMap(ids: string[]) {
  const map = {
    getLayer: vi.fn((id: string) => (ids.includes(id) ? {} : undefined)),
    setFilter: vi.fn(),
  };
  state.map = map as unknown as typeof state.map;
  return map;
}

function subsets(ids: string[]): Set<string>[] {
  const out: Set<string>[] = [];
  for (let mask = 0; mask < (1 << ids.length); mask++) out.push(new Set(ids.filter((_, i) => mask & (1 << i))));
  return out;
}

beforeEach(() => {
  state.mapReady = true;
  state.where = {};
  state.legendFilters = {};
});

describe('common-pattern facet appliers match the fixture', () => {
  for (const row of FIXTURE) {
    it(`${row.key}: every bucket subset filters ${row.mapLayerIds.length} map layer(s) on ${row.field}`, () => {
      const apply = FACET_APPLIERS[row.key];
      const map = fakeMap(row.mapLayerIds);
      const buckets = row.bucketIds.map(id => ({ id }));
      for (const active of subsets(row.bucketIds)) {
        state.legendFilters[row.key] = active;
        map.setFilter.mockClear();
        apply();
        const expected = compileBucketExpr(row.field, active, buckets, row.valueMap);
        expect(map.setFilter.mock.calls).toEqual(row.mapLayerIds.map(id => [id, expected]));
      }
    });

    it(`${row.key}: the derived value map lists the same values per bucket`, () => {
      const nonEmpty = (m: Record<string, string[]>) => Object.entries(m).filter(([, v]) => v.length);
      const facet = FACETS.find(f => f.key === row.key)!;
      expect(nonEmpty(facetValueMap(facet))).toEqual(nonEmpty(row.valueMap));
      expect(facet.buckets.map(b => b.id)).toEqual(row.bucketIds);
    });

    it(`${row.key}: writes nothing before the map is ready`, () => {
      const map = fakeMap(row.mapLayerIds);
      state.mapReady = false;
      state.legendFilters[row.key] = new Set();
      FACET_APPLIERS[row.key]();
      expect(map.setFilter).not.toHaveBeenCalled();
    });
  }
});

describe('facet applier coverage', () => {
  it('every facet record has an applier', () => {
    for (const f of FACETS) expect(FACET_APPLIERS[f.key], f.key).toBeTypeOf('function');
    expect(Object.keys(FACET_APPLIERS)).toEqual(FACETS.map(f => f.key));
  });

  it('every legend row carries its facet\'s applier', () => {
    for (const row of LEGEND_FILTERS) {
      expect(row.apply, row.key).toBeTypeOf('function');
      expect(row.apply).toBe(FACET_APPLIERS[row.key]);
    }
  });

  it('each non-standard facet keeps its hand applier', () => {
    const HAND: Record<string, () => void> = {
      kv: filters.applyVoltageFilter, underground: filters.applyVoltageFilter,
      fuel: filters.applyGeneratorFilters, sector: filters.applyGeneratorFilters,
      ogfRegion: filters.applyOGFFilters, ogfStatus: filters.applyOGFFilters, ogfWork: filters.applyOGFFilters,
      mines: filters.applyMinesFilter, minesStatus: filters.applyMinesFilter,
      nwsGroup: filters.applyNwsGroupFilter,
      westtecScenario: filters.applyWestTECFilters, westtecDataset: filters.applyWestTECFilters,
    };
    for (const [key, apply] of Object.entries(HAND)) expect(FACET_APPLIERS[key] === apply, key).toBe(true);
  });

  it('every generically applied facet names a field and its map layers', () => {
    const exported = new Set(Object.values(filters));
    for (const f of FACETS.filter(f => !exported.has(FACET_APPLIERS[f.key]))) {
      expect(f.field, f.key).toBeTruthy();
      const mapLayerIds = f.mapLayerIds ?? (f.layerRef ? layerById(f.layerRef)?.mapLayerIds : undefined);
      expect(mapLayerIds?.length, f.key).toBeGreaterThan(0);
    }
  });
});
