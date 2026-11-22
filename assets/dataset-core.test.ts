// @vitest-environment jsdom
// dataset-core.ts: the scope and `complete` rules and the row passes over in-memory rows, with no map,
// no app state and no fetch (state.js and view-state.js are mocked to throw, so any load of them fails).
import { describe as group, it, expect, vi } from 'vitest';
import { featureFilter } from '@maplibre/maplibre-gl-style-spec';
vi.mock('./state.js', () => { throw new Error('the core loaded state'); });
vi.mock('./view-state.js', () => { throw new Error('the core loaded view-state'); });
import { buildTest, readFrom, coverageOf, rowSource, countRows, queryRows } from './dataset-core.js';

const TL = 'osm-transmission-lines';
const line = (id: number, kv: number | null) => ({ type: 'Feature', id, geometry: { type: 'LineString', coordinates: [[0, 0], [1, 1]] },
  properties: { nominal_kv: kv } }) as GeoJSON.Feature;
const ROWS = [line(1, 345), line(2, -1), line(3, 500), line(4, null)];
const VIEW = 'vector tiles: only the features in the tiles loaded for the current view';

group('scope and complete over in-memory rows', () => {
  it('a columns layer reads its file unless view, fragments or ids; a GeoJSON layer reads its file', () => {
    expect(readFrom(TL, {})).toBe('columns');
    for (const o of [{ scope: 'view' as const }, { fragments: true }, { ids: [1] }]) expect(readFrom(TL, o)).toBe('view');
    expect(readFrom('eia-generators', {})).toBe('geojson');
    expect(coverageOf('eia-generators', 'geojson')).toEqual({ layerId: 'eia-generators', complete: true });
  });

  it('view rows are incomplete and say why; kV ≤ 0 and a missing kV never match a number test', () => {
    const src = rowSource(TL, 'view', ROWS, {}, undefined, 'no whole-dataset file is published for it');
    const t = buildTest(TL, { where: [{ field: 'nominal_kv', op: '<', value: 400 }] }, featureFilter, 8);
    if (typeof t !== 'function') throw new Error(t.reason);
    expect(countRows(src, t)).toEqual({ layerId: TL, complete: false, total: 1,
      reason: `${VIEW} (no whole-dataset file is published for it)` });
    const q = queryRows(TL, src, t, { fields: ['nominal_kv'] });
    expect(q.ok && q.result.rows.map(r => r.id)).toEqual([1]);
  });

  it('asDrawn: off replaces the reason; not drawn at this zoom only off a columns read', () => {
    const at = (visible: boolean, drawn: number, shown: number) => ({ visible, drawn, shown, zoom: 6 });
    expect(coverageOf(TL, 'columns', { asDrawn: true }, at(false, 0, 0)))
      .toEqual({ layerId: TL, complete: true, reason: '"osm-transmission-lines" is off, so the map draws none of it' });
    expect(coverageOf(TL, 'columns', { asDrawn: true }, at(true, 0, 2))).toEqual({ layerId: TL, complete: true });
    expect(coverageOf(TL, 'view', { asDrawn: true }, at(true, 0, 2), 'no whole-dataset file is published for it'))
      .toEqual({ layerId: TL, complete: false, reason: '"osm-transmission-lines" is not drawn at zoom 6.0' });
    expect(coverageOf(TL, 'view', { asDrawn: true }, at(true, 1, 2)).reason).toBe(VIEW);
  });
});
