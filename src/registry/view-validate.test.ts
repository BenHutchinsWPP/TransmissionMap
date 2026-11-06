// Selection checks (validateSelection, selectionIdsError, normalizeSelection)
// against the measured id shapes: EIA '1:1', natgas 'lng_terminal:12', NERC
// 'CA-MX US' (a space), HIFLD '107655', and OSM integer fids.
import { describe, it, expect } from 'vitest';
import { validateSelection, selectionIdsError, normalizeSelection, MAX_SELECTION_IDS } from './view-validate.js';

describe('selectionIdsError', () => {
  it.each([
    ['eia-generators', ['1:1', '27:3']],
    ['hifld-natgas-points', ['lng_terminal:12']],
    ['nerc-regions', ['CA-MX US']],
    ['hifld-substations', ['107655']],
    ['osm-plants-points', [1261615731]],
    ['osm-transmission-lines', [12345678902, 9876543213]],
  ])('accepts %s ids %j', (id, ids) => {
    expect(selectionIdsError(id, ids)).toBeNull();
  });

  it.each([
    ['osm-transmission-lines', [12345678900], 'type digit 0'],
    ['osm-transmission-lines', ['12345678902'], 'a string on a native-id layer'],
    ['osm-plants-points', [1.5], 'not an integer'],
    ['eia-generators', [2 ** 53], 'not a safe integer'],
    ['eia-generators', ['x'.repeat(65)], 'longer than 64 chars'],
    ['eia-generators', [''], 'empty'],
    ['eia-generators', ['a\nb'], 'a control character'],
    ['eia-generators', [true], 'not a string or number'],
    ['hifld-substations', [107655], 'a number on a string-id layer'],
    ['eia-generators', [11], 'a number on a string-id layer'],
    ['eia-generators', [], 'no ids'],
  ] as [string, unknown[], string][])('rejects %s %j (%s)', (id, ids) => {
    expect(selectionIdsError(id, ids)).toMatch(/feature id|1 or more/);
  });

  it('rejects a layer without a dataset or stable id, and an unknown layer', () => {
    expect(selectionIdsError('us-states', ['TX'])).toMatch(/takes no selection/);
    expect(selectionIdsError('nope', [1])).toMatch(/not a layer id/);
  });
});

describe('validateSelection', () => {
  const ids = (n: number) => Array.from({ length: n }, (_, i) => `${i}:1`);

  it('accepts a selection up to the cap across layers, and refuses one past it', () => {
    expect(validateSelection({ mode: 'isolate', ids: { 'eia-generators': ids(MAX_SELECTION_IDS) } })).toBeNull();
    expect(validateSelection({
      mode: 'keep', ids: { 'eia-generators': ids(MAX_SELECTION_IDS), 'nerc-regions': ['CA-MX US'] },
    })).toMatch(/at most 500 ids \(this one has 501\)/);
  });

  it('refuses a bad shape, mode or empty selection', () => {
    expect(validateSelection(null)).toMatch(/object/);
    expect(validateSelection({ mode: 'mark', ids: { 'nerc-regions': ['TRE'] } })).toMatch(/mode/);
    expect(validateSelection({ mode: 'keep', ids: {} })).toMatch(/1 or more layers/);
    expect(validateSelection({ mode: 'keep', ids: { 'nerc-regions': ['TRE'] }, x: 1 })).toMatch(/unknown selection key/);
  });
});

describe('normalizeSelection', () => {
  it('drops a layer left with no ids', () => {
    expect(normalizeSelection({ mode: 'keep', ids: { 'eia-generators': [], 'nerc-regions': ['TRE'] } }))
      .toEqual({ mode: 'keep', ids: { 'nerc-regions': ['TRE'] } });
  });


  it('deduplicates and sorts each layer, numbers first, without touching the input', () => {
    const sel = { mode: 'keep' as const, ids: { 'eia-generators': ['b', 'a', 'b'], 'osm-plants-points': [31, 11, 31] } };
    expect(normalizeSelection(sel)).toEqual({ mode: 'keep', ids: { 'eia-generators': ['a', 'b'], 'osm-plants-points': [11, 31] } });
    expect(sel.ids['eia-generators']).toEqual(['b', 'a', 'b']);
  });
});
