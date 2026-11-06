// The page's check of a model's Vega-Lite spec (every refusal says what to
// fix), and the rows injected as its data: a runAnalysis value only as flat
// rows, at most 5,000; and the CSV built from those rows.
import { describe, it, expect } from 'vitest';
import { validateVegaLite, rowsFromValue, vegaWithData, vegaTitle, rowsCsv,
  MAX_ROWS, MAX_SPEC_BYTES } from './vega-spec.js';

const BAR = { mark: 'bar', encoding: { x: { field: 'group', type: 'nominal' }, y: { field: 'count', type: 'quantitative' } } };
const nest = (n: number): Record<string, unknown> => (n <= 1 ? {} : { a: nest(n - 1) });

describe('validateVegaLite', () => {
  it('accepts a plain spec, a v5/v6 $schema and string formats', () => {
    expect(validateVegaLite(BAR)).toEqual({ ok: true, result: BAR });
    for (const v of ['v5', 'v6', 'v5.20.1', 'v6.1']) {
      expect(validateVegaLite({ ...BAR, $schema: `https://vega.github.io/schema/vega-lite/${v}.json` }).ok, v).toBe(true);
    }
    expect(validateVegaLite({ ...BAR, encoding: { y: { field: 'count', type: 'quantitative', axis: { format: ',.0f' } } } }).ok).toBe(true);
  });

  it.each([
    ['not an object', [BAR], /must be an object/],
    ['a top-level data', { ...BAR, data: { values: [] } }, /remove "data".*page adds/],
    ['a nested data', { layer: [{ ...BAR, data: { url: 'x' } }] }, /remove "layer\[0\]\.data"/],
    ['datasets', { ...BAR, datasets: {} }, /remove "datasets"/],
    ['url', { ...BAR, mark: { type: 'image', url: 'https://x' } }, /remove "mark\.url"/],
    ['href', { ...BAR, encoding: { href: { field: 'group' } } }, /remove "encoding\.href"/],
    ['element', { ...BAR, params: [{ name: 'p', bind: { element: '#x' } }] }, /"element"/],
    ['usermeta', { ...BAR, usermeta: {} }, /"usermeta"/],
    ['an object format', { ...BAR, encoding: { x: { field: 'group', axis: { format: { type: 'json' } } } } }, /format string/],
    ['a v4 $schema', { ...BAR, $schema: 'https://vega.github.io/schema/vega-lite/v4.json' }, /\$schema/],
    ['a Vega (not Vega-Lite) $schema', { ...BAR, $schema: 'https://vega.github.io/schema/vega/v5.json' }, /\$schema/],
    ['a non-string $schema', { ...BAR, $schema: 5 }, /\$schema/],
    ['an own __proto__ key', JSON.parse('{"mark":"bar","__proto__":{"x":1}}'), /"__proto__" is not allowed/],
    ['a constructor key', { ...BAR, encoding: { constructor: 1 } }, /"constructor" is not allowed/],
    ['a prototype key', { ...BAR, prototype: 1 }, /"prototype" is not allowed/],
    ['a function', { ...BAR, mark: () => 'bar' }, /JSON \(no function\)/],
    ['a symbol value', { ...BAR, mark: Symbol('x') }, /JSON \(no symbol\)/],
    ['a symbol key', { ...BAR, [Symbol('x')]: 1 }, /no symbols/],
    ['undefined', { ...BAR, mark: undefined }, /JSON \(no undefined\)/],
    ['a non-finite number', { ...BAR, width: Infinity }, /finite number/],
    ['a class instance', { ...BAR, mark: new Date() }, /plain object/],
    ['nesting past 16', { ...BAR, config: nest(17) }, /deeper than 16/],
    ['over 20 KB', { ...BAR, description: 'x'.repeat(MAX_SPEC_BYTES) }, /over 20 KB/],
  ])('refuses %s, saying what to fix', (_, v, re) => {
    const r = validateVegaLite(v);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(re);
  });

  it('allows 16 levels', () => {
    expect(validateVegaLite({ config: nest(15) }).ok).toBe(true);
  });
});

describe('rows', () => {
  it('takes a runAnalysis value only as ≤ 5,000 flat objects', () => {
    expect(rowsFromValue([{ a: 1, b: 'x', c: null, d: true }])).toEqual([{ a: 1, b: 'x', c: null, d: true }]);
    expect(rowsFromValue({ a: 1 })).toBeNull();
    expect(rowsFromValue([{ a: { b: 1 } }])).toBeNull();
    expect(rowsFromValue([{ a: [1] }])).toBeNull();
    expect(rowsFromValue([1, 2])).toBeNull();
    expect(rowsFromValue([{ a: NaN }])).toBeNull();
    expect(rowsFromValue(Array.from({ length: MAX_ROWS + 1 }, () => ({ a: 1 })))).toBeNull();
  });

  it('injects the rows as top-level data.values without touching the spec', () => {
    const rows = [{ i: 1 }, { i: 2 }];
    const out = vegaWithData(BAR, rows);
    expect(out.data).toEqual({ values: rows });
    expect(out.mark).toBe('bar');
    expect(BAR).not.toHaveProperty('data');
  });

  it("uses the spec's title when it is a string, clipped to 120", () => {
    expect(vegaTitle({ title: ' Gas ' })).toBe('Gas');
    expect(vegaTitle({ title: 'x'.repeat(200) })).toHaveLength(120);
    expect(vegaTitle({ title: { text: 'x' } })).toBeUndefined();
    expect(vegaTitle({})).toBeUndefined();
  });

  it('builds a CSV with a BOM, every column, the title note, the credit and formula cells guarded', () => {
    const csv = rowsCsv([{ group: 'Gas', count: 3 }, { group: '=HYPERLINK("x")', count: 1, extra: 2 }], 'Generators by fuel', ['eia-generators']);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    const lines = csv.slice(1).trim().split('\r\n');
    expect(lines[0]).toBe('group,count,extra');
    expect(lines[2]).toMatch(/^"?'=HYPERLINK/);
    expect(lines[3]).toBe('Generators by fuel');
    expect(lines[4]).toMatch(/^"?Source: /);
  });
});
