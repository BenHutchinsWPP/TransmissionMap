import { describe, it, expect } from 'vitest';
import { frame, settle, source, type Loose } from './template-fakes.js';

const CODE = source('lines-by-class.js');

const line = (coords: number[][], props: Record<string, unknown>) => ({ type: 'Feature', geometry: { type: 'LineString', coordinates: coords }, properties: props });

function payload(over: Record<string, unknown> = {}) {
  return {
    v: 1, template: 'lines-by-class', params: { measure: 'length_km', top: 10 }, scope: 'view',
    rows: [
      { nominal_kv: '200-299', count: 4, sum: 120 },
      { nominal_kv: '500-549', count: 2, sum: 300 },
      { nominal_kv: null, count: 1, sum: 5 },
    ],
    features: [
      line([[-100, 40], [-99, 40]], { name: 'Path 15', nominal_kv: '500-549', length_km: 85.2 }),
      line([[-98, 41], [-97, 41]], { name: 'Tie A', nominal_kv: '200-299', length_km: 84 }),
      line([[-96, 42], [-95, 42]], { name: null, nominal_kv: null, length_km: 2 }),
    ],
    roles: { by: [{ field: 'nominal_kv', role: 'class' }], measure: { name: 'length_km', unit: 'km' } },
    colours: { nominal_kv: { '500-549': '#ff0000', '200-299': '#00ff00' } },
    labels: { title: 'Lines by voltage', locale: 'en-US', measure: 'Length (km)', other: 'Other', none: 'Unknown', 'value.nominal_kv.500-549': '500 kV', 'value.nominal_kv.200-299': '230 kV' },
    credit: 'OSM', units: { distance: 'km' }, complete: false, truncated: false, tiersHidden: ['lv'], theme: 'light', ...over,
  };
}

async function shown(over: Record<string, unknown> = {}) {
  const f = frame(CODE, payload(over));
  await settle();
  const map = f.map();
  map.fire('load');
  return { ...f, map };
}

const txt = (s: string) => s.replace(/\u00a0/g, ' ');
const barNames = (doc: Loose) => [...doc.querySelectorAll('.lbc-bar title')].map((t: Loose) => txt(t.textContent));

describe('lines-by-class template', () => {
  it('draws one bar per class in the legend order, with labels, values and shares', async () => {
    const { doc, sink } = await shown();
    expect(barNames(doc)).toEqual(['500 kV', '230 kV', 'Unknown']);
    const vals = [...doc.querySelectorAll('.lbc-val')].map((t: Loose) => txt(t.textContent));
    expect(vals[0]).toBe('300 km · 70.6%');
    expect(txt(doc.querySelector('.lbc-total b').textContent)).toBe('425 km');
    expect(doc.querySelectorAll('.lbc-fill')[0].getAttribute('fill')).toBe('#ff0000');
    expect(sink).not.toHaveBeenCalled();
  });

  it('sums the classes past top into Other', async () => {
    const rows = ['a', 'b', 'c', 'd', 'e'].map((k, i) => ({ owner: k, count: 1, sum: 10 - i }));
    const { doc, map } = await shown({
      rows, params: { top: 3 }, colours: {},
      roles: { by: [{ field: 'owner', role: 'category' }], measure: { name: 'length_km', unit: 'km' } },
      features: [line([[0, 0], [1, 0]], { ID: 'x', owner: 'e' }), line([[0, 1], [1, 1]], { ID: 'y', owner: 'a' })],
    });
    expect(barNames(doc)).toEqual(['a', 'b', 'c', 'Other']);
    expect([...doc.querySelectorAll('.lbc-val')].map((t: Loose) => txt(t.textContent))[3]).toBe('13 km · 32.5%');
    expect(map.sources.lines.data.features.map((f: Loose) => f.properties._c)).toEqual(['\u0000other', 'a']);
  });

  it('colours the lines by class with the payload colours', async () => {
    const { map } = await shown();
    const colour = map.paint.lines['line-color'] as unknown[];
    expect(colour.slice(0, 2)).toEqual(['match', ['get', '_c']]);
    expect(colour).toContain('#ff0000');
    expect(colour[colour.length - 1]).toBe('#9ca3af');
    expect(map.opts.canvasContextAttributes.preserveDrawingBuffer).toBe(true);
    expect(map.camera[0].fit).toEqual([[-100, 40], [-95, 42]]);
  });

  it('lights a class on bar hover and keeps it on click', async () => {
    const { doc, map, w } = await shown();
    const bar = doc.querySelectorAll('.lbc-bar')[1];
    bar.dispatchEvent(new w.Event('mouseenter'));
    expect(map.paint.lines['line-opacity']).toEqual(['case', ['==', ['get', '_c'], '200-299'], 1, 0.12]);
    bar.dispatchEvent(new w.Event('mouseleave'));
    expect(map.paint.lines['line-opacity']).toBe(0.9);
    bar.dispatchEvent(new w.Event('click'));
    expect(bar.getAttribute('aria-pressed')).toBe('true');
    expect(map.paint.lines['line-opacity']).toEqual(['case', ['==', ['get', '_c'], '200-299'], 1, 0.12]);
    bar.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape' }));
    expect(map.paint.lines['line-opacity']).toBe(0.9);
  });

  it('a bar click offers "Show only this" (where: field + bin); Other and none offer nothing', async () => {
    const { doc, w, TM } = await shown({ labels: { ...payload().labels, 'act.where': 'Only this' } });
    const bars = doc.querySelectorAll('.lbc-bar');
    bars[1].dispatchEvent(new w.MouseEvent('click', { clientX: 5, clientY: 5 }));
    const item = doc.querySelector('.kit-menu button');
    expect(item.textContent).toBe('Only this');
    item.click();
    expect(TM.action).toHaveBeenCalledWith('where', { field: 'nominal_kv', bin: '200-299' });
    bars[2].dispatchEvent(new w.MouseEvent('click'));
    expect(doc.querySelector('.kit-menu')).toBeNull();
  });

  it('a line click offers Select, Zoom and Table with its id', async () => {
    const p = payload();
    const features = p.features.map((f, i) => ({ ...f, id: 100 + i }));
    const { doc, map, TM } = await shown({ features });
    map.hits = [{ properties: { _i: 1 } }];
    map.fire('click', { point: { x: 10, y: 10 }, originalEvent: { clientX: 10, clientY: 10 } });
    const items = [...doc.querySelectorAll('.kit-menu button')] as Loose[];
    expect(items.map(b => b.textContent)).toEqual(['Select on the map (1)', 'Zoom the map here', 'Show in table']);
    items[0].click();
    expect(TM.action).toHaveBeenLastCalledWith('select', { ids: [101] });
    map.fire('click', { point: { x: 10, y: 10 } });
    (doc.querySelectorAll('.kit-menu button')[1] as Loose).click();
    expect(TM.action).toHaveBeenLastCalledWith('fly', { id: 101 });
  });

  it('shows a text tooltip for a hovered line and lights its class', async () => {
    const { doc, map } = await shown({ units: { distance: 'mi' } });
    map.hits = [{ properties: { _i: 0 } }];
    map.fire('mousemove', { point: { x: 10, y: 10 } });
    const tip = doc.querySelector('.lbc-tip');
    expect(tip.hidden).toBe(false);
    expect(txt(tip.textContent)).toBe('Path 15500 kV85.2 km (52.9 mi)');
    expect(map.filters.hover).toEqual(['==', ['get', '_i'], 0]);
    expect(doc.querySelectorAll('.lbc-bar')[0].classList.contains('on')).toBe(true);
    map.hits = [];
    map.fire('mousemove', { point: { x: 50, y: 50 } });
    expect(tip.hidden).toBe(true);
    expect(map.paint.lines['line-opacity']).toBe(0.9);
  });

  it('draws a feature whose class is no row key grey under Other and names its own value', async () => {
    const { doc, map } = await shown({
      features: [line([[0, 0], [1, 0]], { name: 'Odd', nominal_kv: 'kv765' })],
    });
    expect(map.sources.lines.data.features[0].properties._c).toBe('\u0000other');
    map.hits = [{ properties: { _i: 0 } }];
    map.fire('mousemove', { point: { x: 1, y: 1 } });
    expect(txt(doc.querySelector('.lbc-tip').textContent)).toMatch(/^Oddkv765111/);
  });

  it('says drawn only after the map is idle', async () => {
    const { TM, map } = await shown();
    expect(TM.drawn).not.toHaveBeenCalled();
    map.fire('idle');
    expect(TM.drawn).toHaveBeenCalledTimes(1);
  });

  it('falls back to the table when a library does not load', async () => {
    const f = frame(CODE, payload(), { failLib: true });
    await settle();
    expect(f.TM.fail).toHaveBeenCalledWith('library', expect.any(String));
    expect((f.doc.querySelector('.kit-table-box') as Loose).hidden).toBe(false);
    expect(f.map()).toBeNull();
  });
});
