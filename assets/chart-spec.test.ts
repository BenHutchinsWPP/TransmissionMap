// The chat chart's trust boundary and its CSV: validateChart takes only own,
// known keys of the right types and sizes (a model's runAnalysis value goes
// through it), and chartCsv carries a BOM,
// the title and credit rows and no unguarded formula cell. Also the chart
// card's pure helpers: tick values and file names.
import { describe, it, expect } from 'vitest';
import { humanise, validateChart, chartCsv, MAX_CATEGORIES, MAX_PIE, MAX_SERIES, type Chart } from './chart-spec.js';
import { ticks, fileName } from './ui/ui-chart.js';

const GOOD = { type: 'bar', title: 'MW by fuel', categories: ['Gas', 'Wind'], series: [{ name: 'MW', values: [10, 5] }] };
const reason = (v: unknown) => { const r = validateChart(v); return r.ok ? '' : r.reason; };

describe('validateChart', () => {
  it('takes a well-formed spec, numbers as category labels too', () => {
    expect(validateChart(GOOD)).toEqual({ ok: true, result: GOOD });
    const r = validateChart({ ...GOOD, type: 'line', categories: [2020, 2021], unit: 'MW', xLabel: 'year' });
    expect(r.ok && r.result.categories).toEqual(['2020', '2021']);
  });

  it.each([
    ['not an object', [1, 2], /must be an object/],
    ['an unknown key', { ...GOOD, html: '<b>' }, /"html" is not a chart key/],
    ['a prototype key', JSON.parse('{"type":"bar","title":"t","categories":["a"],"series":[{"name":"n","values":[1]}],"__proto__":{"x":1}}'), /"__proto__" is not a chart key/],
    ['an unknown type', { ...GOOD, type: 'radar' }, /bar, pie or line/],
    ['no title', { ...GOOD, title: '  ' }, /needs a title/],
    ['no categories', { ...GOOD, categories: [], series: [{ name: 'MW', values: [] }] }, /1–40/],
    ['too many categories', { ...GOOD, categories: Array(MAX_CATEGORIES + 1).fill('a'), series: [{ name: 'n', values: Array(MAX_CATEGORIES + 1).fill(1) }] }, /1–40/],
    ['a pie over 8 slices', { ...GOOD, type: 'pie', categories: Array(MAX_PIE + 1).fill('a'), series: [{ name: 'n', values: Array(MAX_PIE + 1).fill(1) }] }, /Other/],
    ['an object as a label', { ...GOOD, categories: [{}, 'b'] }, /string or a number/],
    ['too many series', { ...GOOD, series: Array(MAX_SERIES + 1).fill({ name: 'n', values: [1, 2] }) }, /1–8/],
    ['two pie series', { ...GOOD, type: 'pie', series: [{ name: 'a', values: [1, 2] }, { name: 'b', values: [1, 2] }] }, /1–1/],
    ['values of the wrong length', { ...GOOD, series: [{ name: 'MW', values: [1] }] }, /one number per category \(2\)/],
    ['a non-finite value', { ...GOOD, series: [{ name: 'MW', values: [1, null] }] }, /finite numbers/],
    ['an extra series key', { ...GOOD, series: [{ name: 'MW', values: [1, 2], color: 'red' }] }, /\{name, values\}/],
    ['a negative pie slice', { ...GOOD, type: 'pie', series: [{ name: 'MW', values: [3, -1] }] }, /≥ 0/],
    ['an all-zero pie', { ...GOOD, type: 'pie', series: [{ name: 'MW', values: [0, 0] }] }, /above 0/],
    ['a colour that is not #rrggbb', { ...GOOD, colors: ['red', '#00ff00'] }, /#rrggbb/],
    ['a colour list of the wrong length', { ...GOOD, colors: ['#ff0000'] }, /#rrggbb/],
    ['a unit that is not a string', { ...GOOD, unit: 5 }, /unit/],
  ])('refuses %s', (_, v, re) => { expect(reason(v)).toMatch(re); });

  it('clips long labels and titles, and copies the arrays', () => {
    const values = [1, 2];
    const r = validateChart({ ...GOOD, title: 't'.repeat(500), categories: ['c'.repeat(200), 'b'], series: [{ name: 'n'.repeat(200), values }] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.result.title.length).toBe(120);
    expect(r.result.categories[0].length).toBe(60);
    expect(r.result.series[0].name.length).toBe(60);
    values[0] = 99;
    expect(r.result.series[0].values[0]).toBe(1);
  });

  it('allows negative bar and line values', () => {
    expect(validateChart({ ...GOOD, series: [{ name: 'Δ', values: [-3, 2] }] }).ok).toBe(true);
  });
});

describe('chartCsv', () => {
  const chart: Chart = {
    type: 'bar', title: 'Capacity', unit: 'MW', xLabel: 'fuel', layers: ['eia-generators'], complete: true,
    categories: ['=HYPERLINK("x")', '+1', '@a', '-2', 'Gas, "lean"'],
    series: [{ name: 'MW', values: [1, 2, 3, -4, 5] }, { name: 'MW', values: [0, 0, 0, 0, 0] }],
  };
  const csv = chartCsv(chart);
  const lines = csv.slice(1).trimEnd().split('\r\n');

  it('does not repeat a unit the title already carries', () => {
    expect(chartCsv({ ...chart, title: 'Nameplate (MW) by Fuel Type' })).toContain('\r\nNameplate (MW) by Fuel Type\r\n');
    expect(csv).toContain('\r\nCapacity (MW)\r\n');
  });

  it('starts with a BOM and a header of the category label and series (duplicates numbered)', () => {
    expect(csv.charCodeAt(0)).toBe(0xFEFF);
    expect(lines[0]).toBe('fuel,MW,MW (2)');
  });

  it('guards formula cells and quotes commas and quotes; numbers stay numbers', () => {
    expect(lines[1]).toBe(`"'=HYPERLINK(""x"")",1,0`);
    expect(lines[2]).toBe("'+1,2,0");
    expect(lines[3]).toBe("'@a,3,0");
    expect(lines[4]).toBe("'-2,-4,0");
    expect(lines[5]).toBe('"Gas, ""lean""",5,0');
    expect(lines.slice(1, 6).every(l => !/^[=+@-]/.test(l))).toBe(true);
  });

  it('ends with the title (and unit) and the layer credit', () => {
    expect(lines[6]).toBe('Capacity (MW)');
    expect(lines[7]).toMatch(/^"?Source: .*EIA/);
  });
});

describe('chart card helpers', () => {
  it('ticks are round and cover the range', () => {
    expect(ticks(0, 100)).toEqual([0, 25, 50, 75, 100]);
    expect(ticks(-3, 7)).toEqual([-2.5, 0, 2.5, 5]);
    expect(ticks(5, 5)).toEqual([5]);
  });

  it('file names come from the title, any script', () => {
    expect(fileName('EIA Power Plants: nameplate_mw by energy_source', 'png')).toBe('eia-power-plants-nameplate-mw-by-energy-source.png');
    expect(fileName('発電所', 'csv')).toBe('発電所.csv');
    expect(fileName('***', 'csv')).toBe('chart.csv');
  });
});

describe('humanise', () => {
  it('reads overrides and acronyms well, and keeps the plain rule', () => {
    expect(humanise('ba_code')).toBe('Balancing authority');
    expect(humanise('nerc')).toBe('NERC region');
    expect(humanise('op_year')).toBe('Operating year');
    expect(humanise('fid')).toBe('ID');
    expect(humanise('addr_state')).toBe('State');
    expect(humanise('eia_plant_id')).toBe('EIA plant ID');
    expect(humanise('nameplate_mw')).toBe('Nameplate (MW)');
    expect(humanise('owner_state')).toBe('Owner state');
  });
});
