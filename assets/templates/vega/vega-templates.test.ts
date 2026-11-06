// The Vega-Lite template builders (composition, ranking, timeline): the spec's
// structure, what it computes from a payload (groups, "Other" fold, legend
// colours, race frames, zero-filled years, two-sided years), that it is plain
// JSON the frame accepts (validateVegaLite over the spec without its data), and
// that each one runs through showTemplate over layers of different families
// (shapeRows mocked with synthetic rows, everything else real: registry,
// roles, legend folds, humanised titles).
// Compiling the spec with Vega-Lite and running it is a headless-browser check
// (the drive-app scenarios): vega and vega-lite are not dependencies.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ShapeOpts, ShapeResult, ShapeRow } from '../../dataset-query.js';

const m = vi.hoisted(() => ({ shape: vi.fn() }));
vi.mock('../../dataset-query.js', async orig => ({ ...(await orig<typeof import('../../dataset-query.js')>()), shapeRows: m.shape }));

import { build as buildComposition } from './composition.js';
import { build as buildRanking, VALUE_ROOM } from './ranking.js';
import { build as buildTimeline } from './timeline.js';
import { build as buildCompare } from './compare-regions.js';
import { build as buildDistribution } from './distribution.js';
import { layoutWidth, wrap, compact, uniqueLabels } from './common.js';
import { showTemplate, validateTemplateArgs, summarise, templatesFor, monthly } from '../show-template.js';
import { LAYERS } from '../../../src/registry/index.js';
import { validateVegaLite, MAX_SPEC_BYTES } from '../../vega-spec.js';
import { rolesOf } from '../../../src/registry/field-roles.js';
import { facet } from '../../../src/colors/facets.js';
import { state } from '../../state.js';
import type { TemplatePayload } from '../payload.js';

type Spec = Record<string, any>;   // eslint-disable-line @typescript-eslint/no-explicit-any
const composition = (p: TemplatePayload, o: { width: number }) => buildComposition(p, o) as Spec;
const ranking = (p: TemplatePayload, o: { width: number }) => buildRanking(p, o) as Spec;
const timeline = (p: TemplatePayload, o: { width: number }) => buildTimeline(p, o) as Spec;
const compare = (p: TemplatePayload, o: { width: number }) => buildCompare(p, o) as Spec;
const distribution = (p: TemplatePayload, o: { width: number }) => buildDistribution(p, o) as Spec;

const FUELS: [string, string, string][] = [['NG', 'Gas', '#e15759'], ['SUN', 'Solar', '#edc948'], ['WND', 'Wind', '#59a14f'], ['NUC', 'Nuclear', '#b07aa1'], ['COL', 'Coal', '#4d4d4d'], ['WAT', 'Hydro', '#4e79a7']];

function payload(over: Partial<TemplatePayload> & { rows: ShapeRow[] }, withColours = true): TemplatePayload {
  const labels: Record<string, string> = { title: 'EIA Power Plants: Nameplate (MW) by Fuel Type', summary: 's', locale: 'en', other: 'Other', none: '(none)', measure: 'Nameplate (MW)', 'field.energy_source': 'Fuel Type', 'field.op_year': 'Op year' };
  const colours: Record<string, string> = {};
  for (const [k, l, c] of FUELS) { labels[`value.energy_source.${k}`] = l; colours[k] = c; }
  return {
    v: 1, template: 'composition', params: { top: 4 }, scope: 'area',
    roles: { by: [{ field: 'energy_source', role: 'category' }], measure: { name: 'nameplate_mw', unit: 'MW' } },
    colours: withColours ? { energy_source: colours } : {}, labels, credit: 'EIA', units: {} as never, complete: true, truncated: false, theme: 'light', ...over,
  } as TemplatePayload;
}

const fuelRows = (): ShapeRow[] => FUELS.map(([k], i) => ({ energy_source: k, count: 10 - i, sum: 1000 / (i + 1) }));
const yearRows = (from = 1990, to = 2010, every = 1): ShapeRow[] => {
  const rows: ShapeRow[] = [];
  for (let y = from; y <= to; y += every) for (const [k] of FUELS.slice(0, 3)) rows.push({ energy_source: k, op_year: y, count: 2, sum: 50 + ((y * 7 + k.charCodeAt(0)) % 40) });
  return rows;
};
const timeRoles = { by: [{ field: 'energy_source', role: 'category' as const }], measure: { name: 'nameplate_mw', unit: 'MW' }, time: { field: 'op_year', bin: 'year' as const } };

/** The spec as the frame would get it, minus its inline data, through the page's own checks. */
function accepted(spec: Spec) {
  const rest = { ...spec };
  delete rest.data;
  const r = validateVegaLite(rest);
  expect(r.ok, r.ok ? '' : r.reason).toBe(true);
  expect(new TextEncoder().encode(JSON.stringify(rest)).length).toBeLessThan(MAX_SPEC_BYTES);
  // Nothing a template spec may not carry: no URLs, no window or timer events.
  const text = JSON.stringify(spec);
  expect(text).not.toMatch(/"(url|href|element|datasets|usermeta)"/);
  expect(text).not.toMatch(/window:|"timer"|selector/);
  return spec;
}

describe('common', () => {
  it('layoutWidth falls back without a DOM-sized chat pane; wrap and compact behave', () => {
    expect(layoutWidth()).toBeGreaterThanOrEqual(260);
    expect(wrap('one two three four five', 9)).toEqual(['one two', 'three', 'four five']);
    expect(wrap('x'.repeat(80), 20)[0].endsWith('…')).toBe(true);
    expect(compact(1_897_257, 'en')).toBe('1.9M');
    expect(compact(0.5, 'en')).toBe('0.5');
    expect(uniqueLabels(['Other', 'Gas', 'Other'])).toEqual(['Other', 'Gas', 'Other (2)']);
  });
});

describe('composition', () => {
  it('draws a donut, a list and bars side by side on a wide card, sharing hover and click selections', () => {
    const s = accepted(composition(payload({ rows: fuelRows() }), { width: 700 }));
    expect(s.hconcat.map((v: Spec) => v.name)).toEqual(['donut', 'list', 'bars']);
    expect(s.params.map((p: Spec) => p.name)).toEqual(['hov', 'pick']);
    expect(s.params[0].select).toMatchObject({ type: 'point', on: 'mouseover', clear: 'mouseout', resolve: 'union' });
    expect(s.params[1].select).toMatchObject({ on: 'click', toggle: true, resolve: 'union' });
    expect(s.params.every((p: Spec) => p.views.length === 3)).toBe(true);
  });

  it('stacks the donut over the list and bars on a narrow card', () => {
    const s = accepted(composition(payload({ rows: fuelRows() }), { width: 360 }));
    expect(s.vconcat[0].name).toBe('donut');
    expect(s.vconcat[1].hconcat.map((v: Spec) => v.name)).toEqual(['list', 'bars']);
  });

  it('takes the top groups and folds the rest into a grey Other; legend colours and totals', () => {
    const rows = fuelRows();
    const s = composition(payload({ rows }), { width: 700 });
    const v = s.data.values as Spec[];
    expect(v.map(x => x.label)).toEqual(['Gas', 'Solar', 'Wind', 'Nuclear', 'Other']);
    expect(v.slice(0, 4).map(x => x.colour)).toEqual(['#e15759', '#edc948', '#59a14f', '#b07aa1']);
    expect(v[4].colour).toBe('#9ca3af');
    const total = rows.reduce((a, r) => a + (r.sum ?? 0), 0);
    expect(v.reduce((a, x) => a + x.value, 0)).toBeCloseTo(total, 6);
    expect(v.reduce((a, x) => a + x.share, 0)).toBeCloseTo(1, 9);
    expect(s.title.subtitle.join(' ')).toMatch(/Total: .*MW/);
    expect(s.title.subtitle.join(' ')).toMatch(/Groups: 5/);
    const text = JSON.stringify(s);
    expect(text).toContain('"#e15759"');
  });

  it('tells a folded Other from a legend bucket called Other', () => {
    const rows: ShapeRow[] = [...fuelRows(), { energy_source: 'other', count: 1, sum: 900 }];
    const p = payload({ rows, params: { top: 5 } });
    p.labels = { ...p.labels, 'value.energy_source.other': 'Other' };
    const names = (composition(p, { width: 700 }).data.values as Spec[]).map(x => x.label);
    expect(names).toContain('Other');
    expect(names[names.length - 1]).toBe('Smaller groups');
  });

  it('a payload with nothing to draw gives a titled "nothing to show" spec', () => {
    for (const rows of [[], [{ energy_source: 'NG', count: 0, sum: 0 }]] as ShapeRow[][]) {
      const s = accepted(composition(payload({ rows }), { width: 500 }));
      expect(s.data.values[0].m).toBe('Nothing to show for this selection.');
    }
  });

  it('a null group is "(none)" in a lighter grey than Other', () => {
    const s = composition(payload({ rows: [...fuelRows().slice(0, 2), { energy_source: null, count: 1, sum: 5 }], params: { top: 5 } }), { width: 600 });
    const none = (s.data.values as Spec[]).find(x => x.label === '(none)')!;
    expect(none.colour).toBe('#d1d5db');
  });
});

describe('ranking', () => {
  it('a plain ranking: bars by the measure, value and share labels, legend colours, Other grey', () => {
    const s = accepted(ranking(payload({ rows: fuelRows(), template: 'ranking' }), { width: 600 }));
    expect(s.vconcat).toHaveLength(1);
    const v = s.data.values as Spec[];
    expect(v.map(x => x.label)).toEqual(['Gas', 'Solar', 'Wind', 'Nuclear', 'Other']);
    const top = v.slice(0, 4).map(x => x.value);
    expect(top).toEqual([...top].sort((a, b) => b - a));
    expect(v[0].vlabel).toMatch(/\(\d+%\)$/);
    expect(v[4].colour).toBe('#9ca3af');
    expect(v[0].colour).toBe('#e15759');
    expect(s.vconcat[0].layer.map((l: Spec) => l.mark.type)).toEqual(['bar', 'text']);
  });

  it('a field with no legend gets one colour, not a rainbow', () => {
    const rows: ShapeRow[] = ['A', 'B', 'C', 'D'].map((k, i) => ({ energy_source: k, count: 4 - i, sum: 40 - i }));
    const v = ranking(payload({ rows, template: 'ranking' }, false), { width: 600 }).data.values as Spec[];
    expect(new Set(v.map(x => x.colour))).toEqual(new Set(['#4e79a7']));
  });

  it('a race: running totals ranked per year behind one slider param; no timers, no window events', () => {
    const rows = yearRows(1990, 2000);
    const s = accepted(ranking(payload({ rows, template: 'ranking', params: { top: 3 }, roles: timeRoles }), { width: 620 }));
    expect(s.params).toHaveLength(1);
    expect(s.params[0]).toMatchObject({ name: 'yr', value: 2000, bind: { input: 'range', min: 1990, max: 2000, step: 1 } });
    const v = s.data.values as Spec[];
    expect(new Set(v.map(x => x.yr)).size).toBe(11);
    for (let y = 1990; y <= 2000; y++) {
      const f = v.filter(x => x.yr === y);
      expect(f.map(x => x.rank)).toEqual([0, 1, 2]);
      expect(f.map(x => x.value)).toEqual([...f.map(x => x.value)].sort((a, b) => b - a));
    }
    // Running: nothing shrinks, and the last frame is the plain ranking of the same rows.
    const at = (y: number, label: string) => v.find(x => x.yr === y && x.label === label)?.value ?? 0;
    for (const label of ['Gas', 'Solar', 'Wind']) expect(at(2000, label)).toBeGreaterThan(at(1995, label));
    const plain = ranking(payload({ rows, template: 'ranking', params: { top: 3 } }), { width: 620 }).data.values as Spec[];
    const last = v.filter(x => x.yr === 2000).map(x => [x.label, x.value]);
    expect(last).toEqual(plain.slice(0, 3).map(x => [x.label, x.value]));
    expect(s.vconcat[0].layer[0].transform).toEqual([{ filter: 'datum.yr === yr' }]);
    // The longest bar ends VALUE_ROOM short of the plot, so its value label is not clipped.
    const width = s.vconcat[0].width as number;
    expect(s.vconcat[0].layer[0].encoding.x.scale.range).toEqual([0, width - VALUE_ROOM]);
  });

  it('a race leaves out features without a usable year and says how many', () => {
    const rows = [...yearRows(2000, 2003), { energy_source: 'NG', op_year: null, count: 7, sum: 9 }, { energy_source: 'NG', op_year: 0, count: 2, sum: 1 }];
    const s = ranking(payload({ rows, template: 'ranking', params: { top: 3 }, roles: timeRoles }), { width: 620 });
    expect(JSON.stringify(s.title.subtitle)).toContain('Left out: 9');
  });

  it('a time field with no usable year falls back to the plain ranking', () => {
    const rows = fuelRows().map(r => ({ ...r, op_year: null }));
    const s = ranking(payload({ rows, template: 'ranking', roles: timeRoles }), { width: 600 });
    expect(s.params).toBeUndefined();
    expect(s.vconcat).toHaveLength(1);
  });

  it('caps a race at 250 frames, folding earlier years into the first', () => {
    const rows: ShapeRow[] = [{ energy_source: 'NG', op_year: 1710, count: 1, sum: 5 }, { energy_source: 'NG', op_year: 2020, count: 1, sum: 1 }, { energy_source: 'SUN', op_year: 2020, count: 1, sum: 2 }];
    const s = ranking(payload({ rows, template: 'ranking', roles: timeRoles }), { width: 600 });
    expect(s.params[0].bind.min).toBe(1771);
    const first = (s.data.values as Spec[]).filter(x => x.yr === 1771);
    expect(first.map(x => [x.label, x.value])).toEqual([['Gas', 5]]);
  });

  it('nothing to rank gives the empty spec', () => {
    expect(ranking(payload({ rows: [], template: 'ranking' }), { width: 500 }).data.values[0].m).toBe('Nothing to show for this selection.');
  });
});

describe('timeline', () => {
  const tp = (rows: ShapeRow[], over: Omit<Partial<TemplatePayload>, 'rows'> = {}) => payload({ rows, template: 'timeline', params: { top: 3 }, roles: timeRoles, ...over });

  it('dense years: a stacked area per group with the year range, view mode and a legend selection', () => {
    const s = accepted(timeline(tp(yearRows(1990, 2010)), { width: 640 }));
    const v = s.vconcat[0];
    expect(v.mark.type).toBe('area');
    expect(s.params.map((p: Spec) => p.name)).toEqual(['mode', 'y0', 'y1']);
    expect(s.params[1].bind).toMatchObject({ input: 'range', min: 1990, max: 2010, step: 1 });
    expect(s.params[0].bind).toMatchObject({ input: 'select', options: ['year', 'cum'] });
    expect(v.params[0]).toMatchObject({ name: 'leg', bind: 'legend', select: { type: 'point', fields: ['label'], toggle: true } });
    expect(v.encoding.opacity.condition).toEqual({ param: 'leg', value: 0.95 });
    const rows = s.data.values as Spec[];
    expect(new Set(rows.map(r => r.label))).toEqual(new Set(['Gas', 'Solar', 'Wind']));
    expect(rows).toHaveLength(21 * 3);
  });

  it('sparse years: stacked bars, and the years between are zero-filled', () => {
    const rows = yearRows(1950, 2010, 20);
    const s = accepted(timeline(tp(rows), { width: 640 }));
    expect(s.vconcat[0].mark.type).toBe('bar');
    const v = s.data.values as Spec[];
    expect(v).toHaveLength(61 * 3);
    expect(v.filter(r => r.year === 1951).every(r => r.value === 0)).toBe(true);
    expect(v.filter(r => r.year === 1950).some(r => r.value > 0)).toBe(true);
  });

  it('folds groups past top into Other and keeps legend colours', () => {
    const rows = yearRows(2000, 2012).concat(fuelRows().slice(3).map(r => ({ ...r, op_year: 2005 })));
    const s = timeline(tp(rows), { width: 640 });
    const labels = [...new Set((s.data.values as Spec[]).map(r => r.label))];
    expect(labels).toContain('Other');
    expect(s.vconcat[0].encoding.color.scale.range).toContain('#9ca3af');
    expect(s.vconcat[0].encoding.color.scale.range[0]).toBe('#e15759');
  });

  it('cumulative is each group\'s running total', () => {
    const rows = yearRows(2000, 2004);
    const v = timeline(tp(rows), { width: 640 }).data.values as Spec[];
    const gas = v.filter(r => r.label === 'Gas');
    let run = 0;
    for (const r of gas) { run += r.value; expect(r.cum).toBeCloseTo(run, 9); }
  });

  it('no `by`: one series named for the measure', () => {
    const p = tp(yearRows(2000, 2010).filter(r => r.energy_source === 'NG').map(r => ({ count: r.count, sum: r.sum, op_year: r.op_year })), { roles: { by: [], measure: { name: 'nameplate_mw', unit: 'MW' }, time: { field: 'op_year', bin: 'year' } } });
    const s = accepted(timeline(p, { width: 640 }));
    expect(new Set((s.data.values as Spec[]).map(r => r.label))).toEqual(new Set(['Nameplate (MW)']));
  });

  it('both sides: additions up, retirements down, with Added and Retired views', () => {
    const rows: ShapeRow[] = [];
    for (let y = 2000; y <= 2010; y++) {
      rows.push({ energy_source: 'NG', op_year: y, side: 'add', count: 1, sum: 10 });
      rows.push({ energy_source: 'NG', op_year: y, side: 'retire', count: 1, sum: 4 });
    }
    const s = accepted(timeline(tp(rows), { width: 640 }));
    const v = s.data.values as Spec[];
    expect(v.filter(r => r.side === 'retire').every(r => r.value <= 0)).toBe(true);
    expect(v.filter(r => r.side === 'add').every(r => r.value >= 0)).toBe(true);
    expect(s.params[0].bind.options).toEqual(['year', 'cum', 'add', 'retire']);
    // Net running total is added minus retired.
    expect(v.filter(r => r.year === 2010 && r.side === 'add')[0].cum).toBeCloseTo(11 * 6, 9);
  });

  it('net: groups rank by additions + retirements, in the chart and in the summary a model sees', () => {
    // Gas: 10 added, 0 retired; Coal: 2 added, 15 retired; Solar: 5 added. Top 2: Coal (17), Gas (10).
    const rows: ShapeRow[] = [
      { energy_source: 'NG', op_year: 2000, side: 'add', count: 1, sum: 10 },
      { energy_source: 'COL', op_year: 2000, side: 'add', count: 1, sum: 2 },
      { energy_source: 'COL', op_year: 2001, side: 'retire', count: 3, sum: 15 },
      { energy_source: 'SUN', op_year: 2001, side: 'add', count: 1, sum: 5 },
    ];
    const p = tp(rows, { params: { top: 2 } });
    const labels = [...new Set((timeline(p, { width: 640 }).data.values as Spec[]).map(r => r.label))];
    expect(labels).toEqual(['Coal', 'Gas', 'Other']);
    const sum = summarise(p, { count: 3, sum: 17 }, 'nameplate_mw', 'MW');
    expect(sum.rankedBy).toBe('additions + retirements');
    expect(sum.top!.map(g => [g.key, g.value])).toEqual([['Coal', 17], ['Gas', 10], ['Solar', 5]]);
  });

  it('counts features outside 1700-2200 or with no year in the subtitle, not the chart', () => {
    const rows = [...yearRows(2000, 2010), { energy_source: 'NG', op_year: 9999, count: 3, sum: 1 }, { energy_source: 'NG', op_year: null, count: 2, sum: 1 }];
    const s = timeline(tp(rows), { width: 640 });
    expect(JSON.stringify(s.title.subtitle)).toContain('Left out: 5');
    expect(Math.max(...(s.data.values as Spec[]).map(r => r.year))).toBe(2010);
  });

  it('nothing dated gives the empty spec; no time field too', () => {
    expect(timeline(tp([{ energy_source: 'NG', op_year: null, count: 1, sum: 1 }]), { width: 600 }).data.values[0].m).toBe('Nothing to show for this selection.');
    expect(timeline(payload({ rows: fuelRows() }), { width: 600 }).data.values[0].m).toBe('Nothing to show for this selection.');
  });
});

describe('timeline by month', () => {
  const monthRoles = { by: [{ field: 'energy_source', role: 'category' as const }], measure: { name: 'count' }, time: { field: 'last_event', bin: 'month' as const } };
  const months = (keys: string[]): ShapeRow[] => keys.flatMap((m, i) => FUELS.slice(0, 2).map(([k]) => ({ energy_source: k, last_event: m, count: 1 + (i % 3) })));
  const mp = (rows: ShapeRow[]) => payload({ rows, template: 'timeline', params: { top: 3 }, roles: monthRoles });

  it('one bar per month, zero-filled, labelled in the locale; no year sliders; a click picks the month', () => {
    const s = accepted(timeline(mp(months(['2024-11', '2025-02', '2025-03', 'nope']).filter(r => r.last_event !== 'nope')), { width: 640 }));
    const v = s.vconcat[0];
    expect(v.mark).toMatchObject({ type: 'bar', cursor: 'pointer' });
    expect(s.params.map((p: Spec) => p.name)).toEqual(['mode']);
    expect(s.params[0].bind.labels).toEqual(['Per month', 'Cumulative']);
    expect(v.params.map((p: Spec) => p.name)).toEqual(['leg', 'mon']);
    expect(v.params[1]).toMatchObject({ select: { type: 'point', fields: ['mkey'], on: 'click' } });
    const rows = s.data.values as Spec[];
    // Nov 2024 … Mar 2025: 5 months × 2 groups, the gaps zero.
    expect(new Set(rows.map(r => r.mkey))).toEqual(new Set(['2024-11', '2024-12', '2025-01', '2025-02', '2025-03']));
    expect(rows).toHaveLength(10);
    expect(rows.find(r => r.mkey === '2024-12')!.value).toBe(0);
    expect(rows.find(r => r.mkey === '2024-11')!.tl).toBe('Nov 2024');
    expect(v.encoding.x).toMatchObject({ field: 'tl', type: 'ordinal' });
    expect(v.encoding.x.sort).toEqual(['Nov 2024', 'Dec 2024', 'Jan 2025', 'Feb 2025', 'Mar 2025']);
    expect(JSON.stringify(v.transform)).not.toContain('y0');
  });

  it('months when ≥ 90 % of the dated features are in the last 6 years; the last 72 months drawn, older ones counted', () => {
    const yr = (y: number, count: number) => ({ last_event: y, count });
    expect(monthly([yr(2018, 8), yr(2024, 11), yr(2025, 56), yr(2026, 1172)], 'last_event')).toBe(true);
    expect(monthly([yr(2010, 30), yr(2025, 70)], 'last_event')).toBe(false);
    expect(monthly([{ last_event: null, count: 5 }], 'last_event')).toBe(false);
    const s = timeline(mp(months(['2018-05', '2020-01', '2025-12'])), { width: 640 });
    const keys = new Set((s.data.values as Spec[]).map(r => r.mkey));
    expect(keys.size).toBe(72);
    expect([...keys][0]).toBe('2020-01');
    expect(s.title.subtitle.join(' ')).toMatch(/Left out: 2 before Jan 2020/);
  });

  it('cumulative runs over the months; rows without a usable month are counted, not drawn', () => {
    const rows = [...months(['2025-01', '2025-03']), { energy_source: 'NG', last_event: null, count: 4 }];
    const s = timeline(mp(rows), { width: 400 });
    const gas = (s.data.values as Spec[]).filter(r => r.label === 'Gas');
    expect(gas.map(r => r.cum)).toEqual([1, 1, 3]);
    expect(s.title.subtitle.join(' ')).toMatch(/Left out: 4 without a usable date/);
  });
});

describe('compare-regions', () => {
  const REG = ['TX', 'CA', 'NY'];
  const cmpRows = (): ShapeRow[] => REG.flatMap((r, ri) => FUELS.map(([k], i) => ({ energy_source: k, states: r, count: 2, sum: (ri + 1) * 100 / (i + 1) })));
  const cp = (rows: ShapeRow[], labels: Record<string, string> = {}) => {
    const p = payload({ rows, template: 'compare-regions', params: { top: 4 }, roles: { by: [{ field: 'energy_source', role: 'category' }, { field: 'states', role: 'region' }], measure: { name: 'nameplate_mw', unit: 'MW' } } });
    return { ...p, labels: { ...p.labels, 'value.states.TX': 'Texas', 'value.states.CA': 'California', 'value.states.NY': 'New York', ...labels } } as TemplatePayload;
  };

  it('a region bar view over a facet of panels, largest region first; the same groups in every panel', () => {
    const s = accepted(compare(cp(cmpRows()), { width: 640 }));
    expect(s.vconcat).toHaveLength(2);
    const [regions, panels] = s.vconcat;
    expect(regions.encoding.y.sort).toEqual(['New York', 'California', 'Texas']);
    expect(regions.layer[0].params[0]).toMatchObject({ name: 'reg', select: { fields: ['region'], on: 'click' } });
    expect(panels.facet).toMatchObject({ field: 'region', sort: ['New York', 'California', 'Texas'] });
    expect(panels.columns).toBe(2);
    expect(panels.spec.layer[0].params[0]).toMatchObject({ name: 'pick', select: { fields: ['label'], on: 'click' } });
    expect(panels.spec.encoding.y.sort).toEqual(['Gas', 'Solar', 'Wind', 'Nuclear', 'Other']);
    const cells = (s.data.values as Spec[]).filter(v => v.kind === 'c');
    expect(cells).toHaveLength(3 * 5);
    expect(cells.every(c => typeof c.rkey === 'string' && 'key' in c)).toBe(true);
    // Shares are of each region's own total.
    const ny = cells.filter(c => c.rkey === 'NY');
    expect(ny.reduce((a, c) => a + c.share, 0)).toBeCloseTo(1, 6);
    expect(s.params[0]).toMatchObject({ name: 'cmp', value: 'abs', bind: { input: 'select', options: ['abs', 'share'] } });
  });

  it('one panel per row on a phone; three columns on a wide card', () => {
    expect(compare(cp(cmpRows()), { width: 330 }).vconcat[1].columns).toBe(1);
    expect(compare(cp(cmpRows()), { width: 900 }).vconcat[1].columns).toBe(3);
  });

  it('notes the page set under the title; nothing to compare gives the empty spec', () => {
    const s = compare(cp(cmpRows(), { 'cmp.view': 'Regions in the current view.', 'cmp.overlap': 'Regions overlap.' }), { width: 640 });
    expect(s.title.subtitle.join(' ')).toMatch(/current view.*overlap/);
    expect(JSON.stringify(compare(cp([]), { width: 640 }))).toContain('"m":');
    expect(JSON.stringify(compare(cp(cmpRows().map(r => ({ ...r, states: null }))), { width: 640 }))).toContain('"m":');
  });
});

describe('distribution', () => {
  const EDGES = [0, 10, 20, 30, 40, 50];
  const binRows = (by = false): ShapeRow[] => [
    ...EDGES.slice(0, -1).flatMap((lo, i) => (by ? FUELS.slice(0, 2) : [['', '', '']]).map(([k], j) => ({
      ...(by && { energy_source: k }), bin: i, lo, hi: EDGES[i + 1], count: i === 2 ? 0 : 5 - Math.abs(2 - i) + j, sum: 7 * i,
    }))).filter(r => r.count > 0),
    { bin: null, count: 3, sum: 0 },
  ];
  const dp = (rows: ShapeRow[], over: Partial<NonNullable<TemplatePayload['roles']['bins']>> = {}, by = false) => {
    const p = payload({ rows, template: 'distribution', params: { top: 4 }, roles: {
      by: by ? [{ field: 'energy_source', role: 'category' }] : [], measure: { name: 'nameplate_mw', unit: 'MW' },
      bins: { field: 'nameplate_mw', scale: 'lin', edges: EDGES, stats: { n: 20, p10: 4, median: 24.5, p90: 44 }, filter: true, ...over },
    } });
    return { ...p, labels: { ...p.labels, 'field.nameplate_mw': 'Nameplate (MW)', count: 'Count' } } as TemplatePayload;
  };

  it('a bar per bin, empty bins drawn as zero, a median rule, a histogram / cumulative toggle and a bin pick', () => {
    const s = accepted(distribution(dp(binRows()), { width: 640 }));
    const v = s.vconcat[0];
    const rows = s.data.values as Spec[];
    expect(rows.map(r => r.label)).toEqual(['0–10', '10–20', '20–30', '30–40', '40–50']);
    expect(rows[2].value).toBe(0);
    expect(rows.map(r => r.key)).toEqual([0, 1, 2, 3, 4]);
    expect(rows[rows.length - 1].cum).toBe(1);
    expect(rows.find(r => r.med)!.label).toBe('20–30');
    expect(s.params[0]).toMatchObject({ name: 'dv', value: 'hist', bind: { options: ['hist', 'area', 'ecdf'] } });
    expect(v.layer[0].params[0]).toMatchObject({ name: 'pick', select: { fields: ['label'], on: 'click' } });
    expect(v.layer[0].mark.cursor).toBe('pointer');
    expect(v.layer[1].mark).toMatchObject({ type: 'area', interpolate: 'monotone' });
    expect(v.layer[1].transform[0].filter).toBe("dv === 'area'");
    expect(v.layer[2].mark).toMatchObject({ type: 'line', interpolate: 'step-after' });
    expect(v.layer[3].layer[0].mark.type).toBe('rule');
    expect(v.layer[0].encoding.x.axis.title).toBe('Nameplate (MW)');
    const sub = s.title.subtitle.join(' ');
    expect(sub).toMatch(/Median 24\.5 · middle 80%: 4 to 44/);
    expect(sub).toMatch(/Left out: 3 without a value/);
  });

  it('stacks a by field\'s groups; a bin with no field to filter on takes no click and says so', () => {
    const s = accepted(distribution(dp(binRows(true), {}, true), { width: 640 }));
    expect(new Set((s.data.values as Spec[]).map(r => r.g))).toEqual(new Set(['Gas', 'Solar']));
    expect(s.vconcat[0].layer[0].encoding.color.legend).not.toBeNull();
    const n = distribution(dp(binRows(), { filter: false }), { width: 640 });
    expect(n.vconcat[0].layer[0].params).toBeUndefined();
    expect(n.vconcat[0].layer[0].mark.cursor).toBeUndefined();
    expect(n.title.subtitle.join(' ')).toMatch(/do not filter the map/);
  });

  it('edges read back from the rows when the payload has none; log bins say so; no bins → empty', () => {
    const s = distribution(dp(binRows(), { edges: undefined, scale: 'log' }), { width: 500 });
    expect((s.data.values as Spec[]).map(r => r.label)).toEqual(['0–10', '10–20', '20–30', '30–40', '40–50']);
    expect(s.title.subtitle.join(' ')).toMatch(/Log bins/);
    expect(JSON.stringify(distribution(dp([{ bin: null, count: 4 }]), { width: 500 }))).toContain('"m":');
  });
});

// ─── Through showTemplate, over layers of different families ─────────────────
const REGION_CODES = ['TX', 'CA', 'NY', 'FL', 'OK', 'NM', 'AZ', 'WA'];
function rowsFor(layerId: string, o: ShapeOpts): ShapeRow[] {
  const roles = rolesOf(layerId)!;
  const keysOf = (name: string): string[] => {
    const f = roles.fields.find(x => x.name === name);
    if (f?.facet === 'fuel') return ['NG', 'SUN', 'WND', 'COL', 'NUC', 'WAT', 'DFO'];
    if (f?.facet === 'kv') return facet('kv').buckets.map(b => b.id);
    if (f?.facet) { const b = facet(f.facet).buckets.filter(x => x.values?.length).map(x => x.values![0]); if (b.length) return b; }
    return ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L'];
  };
  const by = o.by?.[0], by2 = o.by?.[1];
  // A date field (dc-moratoriums last_event) spans 2024–2026: by year 3 years, by month 30 months.
  const date = o.time && roles.fields.find(f => f.name === o.time!.field)?.time === 'date';
  const years: (number | string | undefined)[] = !o.time ? [undefined]
    : o.time.bin === 'month' ? Array.from({ length: 30 }, (_, i) => `${2024 + Math.floor(i / 12)}-${String(i % 12 + 1).padStart(2, '0')}`)
    : date ? [2024, 2025, 2026] : Array.from({ length: 31 }, (_, i) => 1990 + i);
  const bins = o.bins ? [0, 1, 2, 3, 4, 5, 6, 7, null] : [undefined];
  const rows: ShapeRow[] = [];
  for (const k of by ? keysOf(by) : [undefined]) {
    for (const k2 of by2 ? REGION_CODES : [undefined]) {
      for (const y of years) {
        for (const b of bins) {
          const row: ShapeRow = { count: 3, sum: o.measure === 'count' ? undefined : 40 + rows.length };
          if (row.sum === undefined) delete row.sum;
          if (by) row[by] = k as string;
          if (by2) row[by2] = k2 as string;
          if (o.time && y !== undefined) row[o.time.field] = y;
          if (b !== undefined) { row.bin = b; if (b !== null) { row.lo = b * 10; row.hi = b * 10 + 10; } }
          rows.push(row);
        }
      }
    }
  }
  return rows;
}

beforeEach(() => {
  state.area = null;
  state.where = {};
  state.layerVisibility = {};
  m.shape.mockReset();
  m.shape.mockImplementation(async (layerId: string, o: ShapeOpts) => {
    const tiled = layerId.startsWith('osm-transmission') || layerId.startsWith('retail');
    const result: ShapeResult = {
      layerId, scope: tiled ? 'view' : 'area', by: o.by ?? [], measure: o.measure ?? 'count', ...(o.measure && o.measure !== 'count' && { unit: o.measure === 'length_km' ? undefined : 'MW' }),
      ...(o.time && { time: o.time.field, timeBin: o.time.bin }),
      ...(o.bins && { bins: { field: o.bins.field, scale: 'lin' as const, edges: [0, 10, 20, 30, 40, 50, 60, 70, 80], stats: { n: 90, p10: 6, median: 41, p90: 77 } } }),
      rows: rowsFor(layerId, o), totals: { count: 100, sum: 1000 }, complete: !tiled, truncated: false, precision: 'full geometry',
    };
    return { ok: true, result };
  });
});

type Call = [string, string, Spec, unknown, { csv?: () => string; partial?: string[] }];
async function render(args: Record<string, unknown>) {
  const calls: Call[] = [];
  const r = await showTemplate(args, { render: vi.fn(async (...a: unknown[]) => { calls.push(a as Call); return { shown: true } as never; }) });
  return { r, calls };
}

const CASES: [string, string, Record<string, unknown>?][] = [
  ['composition', 'eia-generators'], ['composition', 'hifld-substations'], ['composition', 'osm-datacenters'], ['composition', 'osm-transmission-lines'], ['composition', 'retail-territories'],
  ['ranking', 'eia-generators'], ['ranking', 'hifld-substations'], ['ranking', 'osm-transmission-lines'], ['ranking', 'osm-datacenters'],
  ['ranking', 'eia-generators', { by: 'state', time: 'op_year' }],
  ['timeline', 'eia-generators'], ['timeline', 'osm-plants-points'], ['timeline', 'osm-datacenters'],
];

const FITTING = (id: string) => LAYERS.filter(l => templatesFor(l.id).some(d => d.id === id)).map(l => l.id);

describe('compare-regions and distribution over every layer they fit', () => {
  for (const template of ['compare-regions', 'distribution']) {
    it(`${template}: ${FITTING(template).length} layers`, async () => {
      expect(FITTING(template).length).toBeGreaterThan(10);
      for (const layer of FITTING(template)) {
        const { r, calls } = await render({ template, layer });
        expect(r.ok, `${layer}: ${r.ok ? '' : r.reason}`).toBe(true);
        const [kind, title, spec, , x] = calls[0];
        expect(kind).toBe('vega');
        accepted(spec);
        expect(title, layer).not.toMatch(/[a-z]_[a-z]/);
        expect(JSON.stringify(spec), layer).not.toContain('"m":');
        expect(x.csv!().length).toBeGreaterThan(20);
        expect(new TextEncoder().encode(JSON.stringify(r.ok && r.result.summary)).length).toBeLessThanOrEqual(1024);
      }
    });
  }

  it('compare-regions: at most 6 panels, the largest; both picks bridged with their own label → key maps', async () => {
    const { r, calls } = await render({ template: 'compare-regions', layer: 'hifld-substations' });
    expect(r.ok).toBe(true);
    const spec = calls[0][2];
    const regions = new Set((spec.data.values as Spec[]).filter(v => v.kind === 'r').map(v => v.rkey));
    expect(regions.size).toBe(6);
    expect(spec.title.subtitle.join(' ')).toMatch(/The 6 largest of 8 regions/);
    const x = calls[0][4] as unknown as { signals: Spec[] };
    expect(x.signals.map(s => [s.signal, s.field, s.read])).toEqual([['pick', 'max_kv', 'label'], ['reg', 'states', 'region']]);
    // The model is told each region, its value and its largest group's share.
    const sm = r.ok ? r.result.summary : null;
    expect(sm!.regions).toHaveLength(6);
    expect(sm!.regions![0]).toMatchObject({ key: expect.any(String), value: expect.any(Number), top: { key: expect.any(String), share: expect.any(Number) } });
  });

  it('compare-regions: an Area of states names the panels; region names from the label table', async () => {
    const { calls } = await render({ template: 'compare-regions', layer: 'hifld-substations', area: { kind: 'states', codes: ['TX', 'CA', 'NY'] } });
    const regions = (calls[0][2].data.values as Spec[]).filter(v => v.kind === 'r');
    expect(regions.map(v => v.rkey).sort()).toEqual(['CA', 'NY', 'TX']);
    expect(regions.map(v => v.region)).toContain('Texas');
  });

  it('distribution: page quantiles in the summary; a computed measure takes no click', async () => {
    const { r, calls } = await render({ template: 'distribution', layer: 'eia-generators', measure: 'nameplate_mw' });
    expect(r.ok && r.result.summary).toMatchObject({ measure: 'nameplate_mw', unit: 'MW', stats: { n: 90, p10: 6, median: 41, p90: 77 } });
    expect((calls[0][4] as unknown as { signals: Spec[] }).signals).toEqual([{ signal: 'pick', kind: 'where', layer: 'eia-generators', field: 'nameplate_mw', read: 'label' }]);
    // A stack by a legend field: its fold keeps every bin apart.
    const by = await render({ template: 'distribution', layer: 'eia-generators', measure: 'nameplate_mw', by: 'energy_source' });
    const vals = by.calls[0][2].data.values as Spec[];
    expect(new Set(vals.filter(v => v.value > 0).map(v => v.key)).size).toBe(8);
    expect(vals.find(v => v.first && v.key === 0)!.cum).toBeCloseTo(1 / 8, 6);
    const len = await render({ template: 'distribution', layer: 'ogf-planned-transmission', measure: 'length_km' });
    expect(len.r.ok).toBe(true);
    expect((len.calls[0][4] as unknown as { signals: Spec[] }).signals).toEqual([]);
    expect(len.calls[0][2].vconcat[0].layer[0].params).toBeUndefined();
  });

  it('timeline over a date field spanning ≤ 6 years reads by month, with the month pick bridged; a longer span stays yearly', async () => {
    const { r, calls } = await render({ template: 'timeline', layer: 'dc-moratoriums' });
    expect(r.ok, r.ok ? '' : r.reason).toBe(true);
    expect(m.shape.mock.calls.map(c => (c[1] as ShapeOpts).time?.bin)).toEqual(['year', 'month']);
    const spec = calls[0][2];
    expect(new Set((spec.data.values as Spec[]).map(v => v.mkey)).size).toBe(30);
    expect((calls[0][4] as unknown as { signals: Spec[] }).signals.map(s => [s.signal, s.read])).toContainEqual(['mon', 'mkey']);
    m.shape.mockClear();
    await render({ template: 'timeline', layer: 'eia-generators' });
    expect(m.shape.mock.calls.map(c => (c[1] as ShapeOpts).time?.bin)).toEqual(['year']);
  });
});

describe('showTemplate over layers of different families', () => {
  for (const [template, layer, extra] of CASES) {
    it(`${template} over ${layer}${extra ? ' (' + Object.keys(extra).join(', ') + ')' : ''}`, async () => {
      const { r, calls } = await render({ template, layer, ...extra });
      expect(r.ok, r.ok ? '' : r.reason).toBe(true);
      const [kind, title, spec, , x] = calls[0];
      expect(kind).toBe('vega');
      accepted(spec);
      // Humanised: words, not field names, and no raw units twice.
      expect(title).not.toMatch(/[a-z]_[a-z]/);
      expect(title).not.toMatch(/\((\w+)\) \(\1\)/i);
      expect((spec.data.values as unknown[]).length).toBeGreaterThan(0);
      expect(x.csv!().length).toBeGreaterThan(20);
      expect(x.partial).toEqual(r.ok && !r.result.complete ? [expect.any(String)] : []);
      expect(JSON.stringify(spec)).not.toContain('"m":');   // not the empty spec
    });
  }

  it('titles read "Nameplate (MW) by Fuel Type" (a legend facet\'s title) and a timeline "by Op year"', async () => {
    expect((await render({ template: 'composition', layer: 'eia-generators' })).calls[0][1]).toMatch(/: Nameplate \(MW\) by Fuel Type$/);
    expect((await render({ template: 'ranking', layer: 'hifld-substations' })).calls[0][1]).toMatch(/: Count by Voltage \(kV\)$/);
    expect((await render({ template: 'timeline', layer: 'eia-generators' })).calls[0][1]).toMatch(/: Nameplate \(MW\) by Operating year$/);
    expect((await render({ template: 'ranking', layer: 'osm-datacenters', by: 'operator' })).calls[0][1]).toMatch(/ by Operator$/);
  });

  it('a race is off unless time is asked for; given, the page checks it is a time field', async () => {
    const plain = validateTemplateArgs({ template: 'ranking', layer: 'eia-generators' });
    expect(plain.ok && plain.result.time).toBeUndefined();
    const race = validateTemplateArgs({ template: 'ranking', layer: 'eia-generators', time: 'op_year' });
    expect(race.ok && race.result.time).toBe('op_year');
    const bad = validateTemplateArgs({ template: 'ranking', layer: 'eia-generators', time: 'plant_name' });
    expect(bad.ok).toBe(false);
    const timeline = validateTemplateArgs({ template: 'timeline', layer: 'eia-generators' });
    expect(timeline.ok && [timeline.result.time, timeline.result.by]).toEqual(['op_year', 'energy_source']);
    const noBy = validateTemplateArgs({ template: 'timeline', layer: 'eia-generators', by: 'gen_status' });
    expect(noBy.ok && noBy.result.by).toBe('gen_status');
  });

  it('a race through showTemplate has the slider and one frame per year', async () => {
    const { calls } = await render({ template: 'ranking', layer: 'eia-generators', by: 'state', time: 'op_year', top: 5 });
    const spec = calls[0][2];
    expect(spec.params[0]).toMatchObject({ name: 'yr', value: 2020, bind: { min: 1990, max: 2020 } });
    expect(new Set((spec.data.values as Spec[]).map(r => r.yr)).size).toBe(31);
  });
});
