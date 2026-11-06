// The drawer's tab snapshot is untrusted input: a wrong version or frame is
// null, a bad table request drops only the table part, bad optional fields fall
// back to defaults, and the caps hold (≤ 500 checked ids, else none).
// Deps: drawer-snapshot.ts (real registry and view-validate.ts).
import { describe, it, expect } from 'vitest';
import { parseDrawerSnapshot } from './drawer-snapshot.js';

const table = {
  req: { layerId: 'hifld-substations', where: [{ field: 'max_kv', op: '>=', value: 345 }] },
  sort: { field: 'max_kv', desc: true }, groupBy: 'nerc', sumField: '', barFilter: 'WECC',
  shown: ['name', 'max_kv'], checked: ['a1', 'b2'], active: 'a1', scrollTop: 260,
};
const snap = { v: 1, ask: true, table, pane: 'table', frac: 0.42, collapsed: false };

describe('parseDrawerSnapshot', () => {
  it('keeps a good snapshot as it was', () => {
    expect(parseDrawerSnapshot(snap)).toEqual(snap);
  });

  it('keeps the shown columns in screen order (a dragged column order), still version 1', () => {
    const r = parseDrawerSnapshot({ ...snap, table: { ...table, shown: ['max_kv', 'nerc', 'name'] } });
    expect(r?.v).toBe(1);
    expect(r?.table?.shown).toEqual(['max_kv', 'nerc', 'name']);
  });

  it('a wrong version, a non-object or nothing open is null', () => {
    for (const d of [null, 'x', [], { ...snap, v: 2 }, { ...snap, ask: false, table: null }]) expect(parseDrawerSnapshot(d)).toBeNull();
  });

  it('a table request a link would refuse drops the table part only', () => {
    const bad = [
      { layerId: 'not-a-layer' },
      { layerId: 'hifld-substations', where: [{ field: 'evil', op: '=', value: 1 }] },
      { layerId: 'hifld-substations', area: { kind: 'state', codes: ['<script>'] } },
      { layerId: 'osm-substations-points', ids: ['not-an-osm-id'] },
      { layerId: 'hifld-substations', asDrawn: 'yes' },
    ];
    for (const req of bad) {
      const r = parseDrawerSnapshot({ ...snap, table: { ...table, req } });
      expect(r).toMatchObject({ ask: true, table: null, pane: 'ask' });
    }
    expect(parseDrawerSnapshot({ ...snap, ask: false, table: { ...table, req: bad[0] } })).toBeNull();
  });

  it('bad optional fields fall back to the table defaults', () => {
    const r = parseDrawerSnapshot({ ...snap, frac: 7, collapsed: 'yes', pane: 'route', table: {
      ...table, sort: { field: 'a b', desc: 1 }, groupBy: '<img>', sumField: 5, barFilter: 'x'.repeat(201),
      shown: ['ok', '<b>', 3], active: { evil: 1 }, scrollTop: -4,
    } })!;
    expect(r).toMatchObject({ frac: 0, collapsed: false, pane: 'table' });
    expect(r.table).toEqual({ req: table.req, barFilter: null, shown: ['ok'], checked: ['a1', 'b2'], active: null, scrollTop: 0 });
  });

  it('more than 500 checked ids, or one bad id, keeps none', () => {
    const many = Array.from({ length: 501 }, (_, i) => `id${i}`);
    expect(parseDrawerSnapshot({ ...snap, table: { ...table, checked: many } })!.table!.checked).toEqual([]);
    expect(parseDrawerSnapshot({ ...snap, table: { ...table, checked: ['ok', 'bad\u0000'] } })!.table!.checked).toEqual([]);
  });

  it('an OSM layer takes osmRef ids only', () => {
    const osm = { ...table, req: { layerId: 'osm-substations-points' }, checked: [1231, 4562], active: 1231 };
    expect(parseDrawerSnapshot({ ...snap, table: osm })!.table).toMatchObject({ checked: [1231, 4562], active: 1231 });
    expect(parseDrawerSnapshot({ ...snap, table: { ...osm, checked: [1230] } })!.table!.checked).toEqual([]);
  });
});

describe('parseDrawerSnapshot — the Visualize part', () => {
  const card = { templateId: 'ranking', layer: 'eia-generators', params: { by: 'state', measure: 'nameplate_mw', top: 10 }, title: 'Top states' };
  const viz = { layer: 'eia-generators', cards: [card] };

  it('keeps the pane, its layer and its cards; Visualize alone is a snapshot', () => {
    const r = parseDrawerSnapshot({ ...snap, ask: false, table: null, pane: 'viz', viz })!;
    expect(r).toMatchObject({ ask: false, table: null, pane: 'viz', viz });
    expect(parseDrawerSnapshot({ ...snap, pane: 'viz', viz })!.pane).toBe('viz');
    expect(parseDrawerSnapshot({ ...snap, pane: 'viz' })!.pane).toBe('table');
  });

  it('drops a bad card, and a bad Visualize part, keeping the rest', () => {
    const bad = [
      { ...card, templateId: '<b>' }, { ...card, layer: 'nope' }, { ...card, title: '' }, { ...card, title: 'x'.repeat(201) },
      { ...card, params: { code: '<script>' } }, { ...card, params: { template: 'density' } }, { ...card, params: [] },
      { ...card, params: { where: 'x'.repeat(20_001) } },
    ];
    const r = parseDrawerSnapshot({ ...snap, viz: { layer: 'nope', cards: [...bad, card] } })!;
    expect(r.viz).toEqual({ layer: null, cards: [card] });
    expect(parseDrawerSnapshot({ ...snap, viz: { cards: 'x' } })!.viz).toBeUndefined();
    expect(parseDrawerSnapshot({ ...snap, ask: false, table: null, viz: 5 })).toBeNull();
  });

  it('keeps at most MAX_VIZ_CARDS cards', () => {
    const r = parseDrawerSnapshot({ ...snap, viz: { layer: null, cards: Array.from({ length: 9 }, () => card) } })!;
    expect(r.viz!.cards).toHaveLength(6);
  });
});
