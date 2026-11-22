// Golden values for the link codec's legend groups, captured from the codec
// before it read src/colors/facets.ts directly: the default view's formatted
// hash and legend sets, one hash with every legend group set, and the group
// codes in param order.
import { describe, it, expect } from 'vitest';
import { formatUrlState, defaultView, parseUrlState } from './url-state-codec.js';

const GROUP_CODES = ['v', 'o', 'f', 'i', 'p', 'h', 'j', 't', 'n', 'r', 'u', 'c', 'e', 'a', 'b', 'g', 'm', 'k', 'd', 'q', 'x', 'z'];

const DEFAULT_SETS: Record<string, string[]> = {
  kv: ['550+', '500-549', '300-499', '200-299', '100-199', '<100', 'unknown'],
  underground: ['overhead', 'underground'],
  fuel: ['wind', 'solar', 'hydro', 'pumped_storage', 'nuclear', 'coal', 'gas', 'oil', 'storage', 'geo', 'biomass', 'other'],
  sector: ['utility', 'ipp', 'commercial', 'industrial'],
  pipeline: ['pig_launcher', 'compressor', 'delivery', 'interconnect', 'end', 'other'],
  crithab: ['endangered', 'threatened', 'prop-endangered', 'prop-threatened'],
  padus: ['blm', 'forest', 'refuge', 'park', 'wild', 'conserv', 'state', 'local', 'private', 'military', 'other'],
  tribal: ['reservation', 'hawaiian', 'anvsa', 'otsa', 'sdtsa', 'tdsa', 'statereserv'],
  natgasLine: ['interstate', 'intrastate', 'hgl', 'gathering'],
  natgasPts: ['lng_terminal', 'underground', 'spr', 'trading_hub', 'processing', 'border_cross', 'peak_shaving', 'lng_storage', 'pol_terminal'],
  substance: ['gas', 'oil', 'products', 'hydrogen', 'coal'],
  nerc: ['WECC', 'SERC', 'RFC', 'NPCC', 'MRO', 'SPP', 'TRE', 'FRCC'],
  retail: ['iou', 'coop', 'muni', 'public', 'other'],
  dcm: ['ban', 'active', 'pending', 'ended'],
  ogfRegion: ['wecc', 'ercot', 'spp', 'miso', 'pjm', 'nyiso', 'isone', 'southeast', 'other'],
  ogfStatus: ['planning', 'engineering', 'permitting', 'construction', 'complete', 'on_hold', 'terminated', 'other'],
  ogfWork: ['new', 'existing'],
  mines: ['precious', 'base', 'ferroalloy', 'battery', 'energy', 'gem', 'industrial', 'other'],
  minesStatus: ['active'],
  nwsGroup: ['convective', 'flood', 'fire', 'heat', 'wind', 'winter', 'tropical', 'other'],
  westtecScenario: ['base_case', 'sra', 'ida', 'congestion'],
  westtecDataset: ['planned', 'identified'],
};

// One non-default bucket per group, each group's last coded bucket.
const ONE_EACH: Record<string, string> = {
  kv: 'unknown', underground: 'underground', fuel: 'other', sector: 'industrial', pipeline: 'other',
  crithab: 'prop-threatened', padus: 'other', tribal: 'statereserv', natgasLine: 'gathering',
  natgasPts: 'pol_terminal', substance: 'other', nerc: 'FRCC', retail: 'other', dcm: 'ended',
  ogfRegion: 'other', ogfStatus: 'other', ogfWork: 'existing', mines: 'other', minesStatus: 'retired',
  nwsGroup: 'other', westtecScenario: 'congestion', westtecDataset: 'identified',
};
const ONE_EACH_PARAMS = ['v=U', 'o=u', 'f=x', 'i=n', 'p=O', 'h=Q', 'j=O', 't=J', 'n=G', 'r=O', 'u=u', 'c=F', 'e=O', 'a=E',
  'b=O', 'g=O', 'm=E', 'k=o', 'd=2', 'q=o', 'x=C', 'z=I'];

const sets = (o: Record<string, Set<string>>) => Object.fromEntries(Object.entries(o).map(([k, s]) => [k, [...s]]));

describe('url-state-codec legend groups (golden)', () => {
  it('the default view formats to nothing and holds the default legend sets', () => {
    const v = defaultView();
    expect(formatUrlState(v)).toEqual([]);
    expect(sets(v.legendFilters)).toEqual(DEFAULT_SETS);
  });

  it('a view with every legend group set formats to the golden params, in group order', () => {
    const lf = Object.fromEntries(Object.entries(ONE_EACH).map(([k, id]) => [k, new Set([id])]));
    const out = formatUrlState({ ...defaultView(), legendFilters: lf });
    expect(out).toEqual(ONE_EACH_PARAMS);
    expect(out.map(p => p[0])).toEqual(GROUP_CODES);
  });

  it('the golden hash parses back to the one bucket per group', () => {
    const parsed = parseUrlState(new URLSearchParams(ONE_EACH_PARAMS.join('&')));
    expect(sets(parsed.legendFilters!)).toEqual(Object.fromEntries(Object.entries(ONE_EACH).map(([k, id]) => [k, [id]])));
  });
});
