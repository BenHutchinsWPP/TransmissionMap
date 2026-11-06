// pies-per-region.js in a jsdom frame: groups summed over regions and cut to the
// top + Other, one pie per region with an outline and a centre, area-proportional
// radii (sqrt of the total, a floor for tiny regions), slices in group order with
// the payload's colours (grey for Other), a size legend on the same scale, hover
// tip, click menus that send where / fly on the right field, text only, drawn once.
import { describe, it, expect } from 'vitest';
import { frame, settle, source, type Loose } from './template-fakes.js';

const CODE = source('pies-per-region.js');

const poly = (x: number, y: number) => ({ type: 'Polygon', coordinates: [[[x, y], [x + 4, y], [x + 4, y + 2], [x, y + 2], [x, y]]] });

function payload(over: Record<string, unknown> = {}) {
  return {
    v: 1, template: 'pies-per-region', params: { by: 'energy_source', split: 'states', measure: 'nameplate_mw', top: 2 }, scope: 'area',
    rows: [
      { energy_source: 'gas', states: 'TX', count: 3, sum: 300 }, { energy_source: 'solar', states: 'TX', count: 2, sum: 60 },
      { energy_source: 'wind', states: 'TX', count: 1, sum: 30 }, { energy_source: 'coal', states: 'TX', count: 1, sum: 10 },
      { energy_source: 'gas', states: 'CA', count: 1, sum: 80 }, { energy_source: 'solar', states: 'CA', count: 1, sum: 20 },
      { energy_source: 'gas', states: 'NV', count: 1, sum: 1 },
    ],
    features: [
      { type: 'Feature', id: 'TX', properties: {}, geometry: poly(-100, 30) },
      { type: 'Feature', id: 'CA', properties: {}, geometry: poly(-120, 36) },
      { type: 'Feature', id: 'NV', properties: {}, geometry: poly(-117, 38) },
    ],
    centres: { TX: [-98, 31], CA: [-118, 37], NV: [-115, 39] },
    roles: { by: [{ field: 'energy_source', role: 'category' }, { field: 'states', role: 'region' }], measure: { name: 'nameplate_mw', unit: 'MW' } },
    colours: { energy_source: { gas: '#111111', solar: '#ffcc00', wind: '#3366ff', coal: '#555555' } },
    labels: {
      title: 'Pies', locale: 'en-US', measure: 'Nameplate (MW)', count: 'Count', other: 'Other', none: '(none)',
      'value.energy_source.gas': 'Gas', 'value.energy_source.solar': 'Solar', 'value.energy_source.wind': 'Wind', 'value.energy_source.coal': 'Coal',
      'value.states.TX': 'Texas', 'value.states.CA': 'California', 'value.states.NV': 'Nevada',
      'field.energy_source': 'Fuel', 'field.states': 'State', 'act.where': 'Show only this on the map', 'act.fly': 'Zoom the map here',
      'pie.size': 'Pie area shows the total', 'pie.only': 'Show only “{name}” on the map',
    },
    credit: 'EIA', units: {}, complete: true, truncated: false, theme: 'light', ...over,
  };
}

async function shown(over: Record<string, unknown> = {}) {
  const f = frame(CODE, payload(over));
  await settle();
  const map = f.map();
  map?.fire('load');
  return { ...f, map };
}
const pies = (doc: Loose) => [...doc.querySelectorAll('.pr-pie')] as Loose[];
const texts = (doc: Loose, sel: string) => [...doc.querySelectorAll(sel)].map((x: Loose) => x.textContent);

describe('pies-per-region template', () => {
  it('draws one pie per region, largest first, and says drawn once the map is idle', async () => {
    const { doc, TM, map, sink } = await shown();
    expect(pies(doc).map(g => g.getAttribute('data-k'))).toEqual(['TX', 'CA', 'NV']);
    expect(TM.lib.mock.calls.map((c: Loose) => c[0])).toEqual(['maplibre-gl', 'maplibre-gl.css']);
    expect(TM.drawn).not.toHaveBeenCalled();
    map.fire('idle');
    expect(TM.drawn).toHaveBeenCalledTimes(1);
    expect(TM.fail).not.toHaveBeenCalled();
    expect(sink).not.toHaveBeenCalled();
    expect(map.sources.regions.data.features).toHaveLength(3);
  });

  it('sizes pies by area: radius grows with the square root of the total, with a floor', async () => {
    const { doc } = await shown();
    const r = Object.fromEntries(pies(doc).map(g => [g.getAttribute('data-k'), Number(g.getAttribute('data-r'))]));
    expect(r.TX).toBe(34);                                   // 400, the largest
    expect(r.CA).toBeCloseTo(34 * Math.sqrt(100 / 400), 1);  // a quarter of the area: half the radius
    expect(r.NV).toBe(4);                                    // 1 of 400: under the floor
  });

  it('places each pie at its centre through map.project, again on every move', async () => {
    const { doc, map } = await shown();
    const tx = pies(doc)[0];
    expect(tx.getAttribute('transform')).toBe('translate(-980.0,-310.0)');
    map.project = () => ({ x: 5, y: 6 });
    map.fire('move');
    expect(tx.getAttribute('transform')).toBe('translate(5.0,6.0)');
  });

  it('slices by the top groups of the whole map and folds the rest into a grey Other', async () => {
    const { doc } = await shown();
    const tx = pies(doc)[0];
    const fills = [...tx.querySelectorAll('path')].map((x: Loose) => x.getAttribute('fill'));
    expect(fills).toEqual(['#111111', '#ffcc00', '#9ca3af']);        // gas, solar, then wind + coal as Other
    expect(texts(doc, '.pr-name')).toEqual(['Gas', 'Solar', 'Other']);
    // A region with one group is a full circle.
    expect(pies(doc)[2].querySelectorAll('circle')).toHaveLength(1);
  });

  it('draws the size legend on the same scale', async () => {
    const { doc } = await shown();
    const circles = [...doc.querySelectorAll('.pr-size circle')].map((c: Loose) => Number(c.getAttribute('r')));
    expect(circles[0]).toBe(34);
    expect(circles[1]).toBeCloseTo(17, 5);
    expect(circles[2]).toBe(8.5);
    expect(texts(doc, '.pr-size text').map((x: string) => x.replace(/\u00a0/g, ' '))).toEqual(['400 MW', '100 MW', '25 MW']);
    expect(doc.querySelector('.pr-size').firstChild.nodeValue).toBe('Pie area shows the total');
  });

  it('hovering a pie lights it and names the region and its largest slices; leaving clears', async () => {
    const { doc, map } = await shown();
    map.fire('mousemove', { point: { x: -980, y: -310 } });
    expect(pies(doc)[0].classList.contains('on')).toBe(true);
    const tip = doc.querySelector('.pr-tip');
    expect(tip.hidden).toBe(false);
    expect(tip.querySelector('b').textContent).toBe('Texas');
    expect(tip.textContent.replace(/\u00a0/g, ' ')).toContain('Gas: 300 MW · 75%');
    map.fire('mousemove', { point: { x: 9999, y: 0 } });
    expect(pies(doc)[0].classList.contains('on')).toBe(false);
    expect(tip.hidden).toBe(true);
  });

  it('a click on a pie offers where on the region field and a fly to its code', async () => {
    const { doc, map, TM } = await shown();
    map.fire('click', { point: { x: -980, y: -310 }, originalEvent: { clientX: 4, clientY: 4 } });
    expect(texts(doc, '.kit-menu button')).toEqual(['Show only this on the map', 'Zoom the map here']);
    (doc.querySelectorAll('.kit-menu button')[0] as Loose).click();
    expect(TM.action).toHaveBeenLastCalledWith('where', { field: 'states', bin: 'TX' });
    map.fire('click', { point: { x: -980, y: -310 }, originalEvent: { clientX: 4, clientY: 4 } });
    (doc.querySelectorAll('.kit-menu button')[1] as Loose).click();
    expect(TM.action).toHaveBeenLastCalledWith('fly', { id: 'TX' });
  });

  it('a legend row offers where on the group field; Other offers nothing', async () => {
    const { doc, TM } = await shown();
    const rows = [...doc.querySelectorAll('.pr-row')] as Loose[];
    rows[1].dispatchEvent(new doc.defaultView.MouseEvent('click', { clientX: 5, clientY: 5 }));
    expect(texts(doc, '.kit-menu button')).toEqual(['Show only “Solar” on the map']);
    (doc.querySelector('.kit-menu button') as Loose).click();
    expect(TM.action).toHaveBeenLastCalledWith('where', { field: 'energy_source', bin: 'solar' });
    TM.action.mockClear();
    rows[2].dispatchEvent(new doc.defaultView.MouseEvent('click', { clientX: 5, clientY: 5 }));
    expect(doc.querySelector('.kit-menu')).toBeNull();
    expect(TM.action).not.toHaveBeenCalled();
  });

  it('a region with no outline or centre gets no pie; with none at all, the panel and note remain and drawn is said', async () => {
    const { doc } = await shown({ centres: { TX: [-98, 31] } });
    expect(pies(doc).map(g => g.getAttribute('data-k'))).toEqual(['TX']);
    const none = frame(CODE, payload({ features: undefined, centres: undefined, labels: { ...payload().labels, 'pie.noMap': 'No outlines.' } }));
    await settle();
    expect(none.map()).toBeNull();
    expect(none.doc.querySelectorAll('.pr-pie')).toHaveLength(0);
    expect(texts(none.doc, '.pr-note')).toEqual(['No outlines.']);
    expect(texts(none.doc, '.pr-name')).toEqual(['Gas', 'Solar', 'Other']);
    expect(none.TM.drawn).toHaveBeenCalledTimes(1);
  });

  it('the header total is of totalOnce, the table lists every row by name', async () => {
    const { doc } = await shown({ totalOnce: { count: 7, sum: 400 } });
    expect(texts(doc, '.pr-total b')[0].replace(/\u00a0/g, ' ')).toBe('400 MW');
    (doc.querySelector('.kit-btn') as Loose).click();
    expect(texts(doc, '.kit-table tbody tr:first-child td').slice(0, 2)).toEqual(['Texas', 'Gas']);
  });

  it('fails visibly when the library does not load', async () => {
    const f = frame(CODE, payload(), { failLib: true });
    await settle();
    expect(f.TM.fail).toHaveBeenCalledWith('library', expect.any(String));
  });
});
