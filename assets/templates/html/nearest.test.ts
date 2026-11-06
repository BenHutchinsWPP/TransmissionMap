// nearest.js in a jsdom frame: points coloured within / beyond, the slider
// (display units) moves the threshold and the counts, "Select the N beyond"
// sends only the card's own ids (disabled past 500), a point's menu and a
// target's zoom, the table lists id / label / distance / nearest, no HTML sink,
// drawn after the map's idle.
import { describe, it, expect } from 'vitest';
import { frame, settle, source, type Loose } from './template-fakes.js';

const CODE = source('nearest.js');
const pt = (id: string | number | null, x: number, y: number, props: Record<string, unknown>) =>
  ({ type: 'Feature', ...(id !== null && { id }), geometry: { type: 'Point', coordinates: [x, y] }, properties: props });

function payload(over: Record<string, unknown> = {}) {
  return {
    v: 1, template: 'nearest', params: { layer2: 'hifld-substations', within: 10 }, scope: 'area',
    rows: [{ id: 'a', d_km: 2, to: 0, count: 1 }, { id: 'b', d_km: 30, to: 1, count: 1 }, { id: 'c', d_km: 50, to: 1, count: 1 }],
    features: [pt('a', -100, 40, { name: 'DC A' }), pt('b', -99, 41, { name: 'DC B' }), pt('c', -98, 42, { name: 'DC C' })],
    second: { layer: 'hifld-substations', credit: 'HIFLD', features: [pt('s1', -100, 40.02, { name: 'Sub 1' }), pt('s2', -98.5, 41.5, { name: 'Sub 2' })] },
    roles: { by: [], measure: { name: 'count' } }, colours: {},
    labels: {
      title: 'Nearest', locale: 'en-US', 'near.within': 'Within', 'near.beyond': 'Beyond', 'near.selectBeyond': 'Select the {n} beyond',
      'near.tooMany': '{n} beyond: more than {max} to select', 'field.distance': 'Distance (km)', 'field.nearest': 'Nearest in Substations',
      'field.name': 'Name', 'field.id': 'ID', 'near.layer2': 'Substations', 'near.fly2': 'Zoom to its nearest',
      'act.select': 'Select on the map ({n})', 'act.fly': 'Zoom the map here', 'act.table': 'Show in table',
    },
    credit: 'OSM · HIFLD', units: { distance: 'km' }, complete: true, truncated: false, theme: 'light', ...over,
  };
}

async function shown(over: Record<string, unknown> = {}) {
  const f = frame(CODE, payload(over));
  await settle();
  const map = f.map();
  map.fire('load');
  return { ...f, map };
}
const beyondBtn = (doc: Loose) => [...doc.querySelectorAll('.nr-side .kit-btn')].find((b: Loose) => /beyond/.test(b.textContent)) as Loose;
const colours = (map: Loose) => map.sources.pts.data.features.map((f: Loose) => f.properties.c);

describe('nearest template', () => {
  it('colours points within / beyond the threshold, counts them, and offers to select the ones beyond', async () => {
    const { doc, map, TM, sink } = await shown();
    expect(colours(map)).toEqual(['#0969da', '#cf222e', '#cf222e']);
    expect(map.sources.tgt.data.features).toHaveLength(2);
    expect(doc.querySelector('.nr-row.nr-stat').textContent).toBe('Within: 1 (33.3%)Beyond: 2');
    const b = beyondBtn(doc);
    expect(b.textContent).toBe('Select the 2 beyond');
    b.click();
    expect(TM.action).toHaveBeenLastCalledWith('select', { ids: ['b', 'c'] });
    expect(sink).not.toHaveBeenCalled();
  });

  it('the slider moves the threshold: recolours, recounts and redraws the rule', async () => {
    const { doc, map, w } = await shown();
    const s = doc.querySelector('.nr-row input[type=range]') as Loose;
    s.value = String(Math.round(Math.log(40 / 0.1) / Math.log(50 / 0.1) * 1000));   // a log slider from 0.1 to 50 km
    s.dispatchEvent(new w.Event('input'));
    map.fire('idle');
    expect(colours(map)).toEqual(['#0969da', '#0969da', '#cf222e']);
    expect(beyondBtn(doc).textContent).toBe('Select the 1 beyond');
  });

  it('reads and shows miles when the visitor uses miles', async () => {
    const { doc } = await shown({ units: { distance: 'mi' } });
    expect(doc.querySelector('.nr-row b').textContent).toMatch(/^6\.21\smi$/);   // 10 km, as asked, not snapped to a step
    expect(doc.querySelector('.nr-row.nr-stat').textContent).toBe('Within: 1 (33.3%)Beyond: 2');
  });

  it('far points (a world layer measured to a regional one): a note, and the chart reads on a log axis', async () => {
    const rows = Array.from({ length: 40 }, (_, i) => ({ d_km: i < 30 ? 0.5 + i : 3000 + i, to: 0, count: 1 }));
    const features = rows.map((_, i) => pt(i, -100 + i / 10, 40, { name: `P${i}` }));
    const { doc } = await shown({ rows, features, labels: { ...payload().labels, 'near.far': '{n} points are more than {d} from every feature of Substations.' } });
    expect([...doc.querySelectorAll('.nr-stat')].map((x: Loose) => x.textContent.replace(/\u00a0/g, ' '))).toContain('10 points are more than 500 km from every feature of Substations.');
    const ticks = [...doc.querySelectorAll('.nr-side svg text')].map((x: Loose) => x.textContent.replace(/\u00a0/g, ' '));
    expect(ticks.slice(-3)).toEqual(['0.1', '20', '5,000 km']);
  });

  it('more than 500 beyond: the button is disabled and says how many', async () => {
    const n = 501;
    const { doc, TM } = await shown({
      rows: Array.from({ length: n }, (_, i) => ({ id: i, d_km: 99, to: 0, count: 1 })),
      features: Array.from({ length: n }, (_, i) => pt(i, -100 + i / 1000, 40, { name: `P${i}` })),
    });
    const b = beyondBtn(doc);
    expect(b.disabled).toBe(true);
    expect(b.textContent).toBe('501 beyond: more than 500 to select');
    b.click();
    expect(TM.action).not.toHaveBeenCalled();
  });

  it('a point offers select / table / zoom and a zoom to its nearest; a target offers the zoom only', async () => {
    const { doc, map, TM } = await shown();
    map.hits = [{ properties: { i: 1 } }];
    map.fire('click', { point: { x: 5, y: 5 } });
    const items = [...doc.querySelectorAll('.kit-menu button')] as Loose[];
    expect(items.map(b => b.textContent)).toEqual(['Select on the map (1)', 'Show in table', 'Zoom the map here', 'Zoom to its nearest']);
    items[0].click();
    expect(TM.action).toHaveBeenLastCalledWith('select', { ids: ['b'] });
    map.fire('click', { point: { x: 5, y: 5 } });
    (doc.querySelectorAll('.kit-menu button')[3] as Loose).click();
    const [kind, p] = TM.action.mock.calls.at(-1) as Loose[];
    expect(kind).toBe('fly');
    expect(p.bbox[0]).toBeCloseTo(-98.52, 5);
    // A target: the fake map answers the same hits for every layer, so hand it none for the points first.
    (map as Loose).queryRenderedFeatures = (_pt: unknown, o: Loose) => (o.layers[0] === 'tgt' ? [{ properties: { k: 0 } }] : []);
    map.fire('click', { point: { x: 5, y: 5 } });
    expect([...doc.querySelectorAll('.kit-menu button')].map((b: Loose) => b.textContent)).toEqual(['Zoom the map here']);
  });

  it('hovering a point draws the line to its target and a text tooltip', async () => {
    const { doc, map } = await shown();
    map.hits = [{ properties: { i: 0 } }];
    map.fire('mousemove', { point: { x: 5, y: 5 } });
    expect(map.sources.link.data.features[0].geometry.coordinates).toEqual([[-100, 40], [-100, 40.02]]);
    expect(doc.querySelector('.nr-tip').textContent.replace(/\u00a0/g, ' ')).toBe('DC A2 kmNearest in Substations: Sub 1');
  });

  it('the table lists id, label, distance and nearest; drawn after idle', async () => {
    const { doc, map, TM } = await shown();
    (doc.querySelector('.kit-btn') as Loose).click();
    expect([...doc.querySelectorAll('.kit-table th')].map((x: Loose) => x.textContent)).toEqual(['ID', 'Name', 'Distance (km)', 'Nearest in Substations']);
    expect([...doc.querySelectorAll('.kit-table tbody tr:nth-child(2) td')].map((x: Loose) => x.textContent)).toEqual(['b', 'DC B', '30', 'Sub 2']);
    expect(TM.drawn).not.toHaveBeenCalled();
    map.fire('idle');
    expect(TM.drawn).toHaveBeenCalledTimes(1);
  });

  it('a point without an id offers only the zoom to its nearest, and is never in the beyond selection', async () => {
    const { doc, map } = await shown({ features: [pt(null, -100, 40, { name: 'X' }), pt('b', -99, 41, {}), pt('c', -98, 42, {})] });
    map.hits = [{ properties: { i: 0 } }];
    map.fire('click', { point: { x: 5, y: 5 } });
    expect([...doc.querySelectorAll('.kit-menu button')].map((b: Loose) => b.textContent)).toEqual(['Zoom to its nearest']);
    expect(beyondBtn(doc).disabled).toBe(false);   // a and the null-id point are within; b and c beyond carry ids
  });
});
