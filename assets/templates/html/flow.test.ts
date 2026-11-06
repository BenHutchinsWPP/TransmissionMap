// flow.js in a jsdom frame: d3 then d3-sankey, ≤ 40 nodes (top per side +
// Other), names and colours from the payload, node hover dims the other links,
// node and link clicks offer `where` on their own field (never Other / none),
// the narrow layout swaps axes, text only (no HTML sink), drawn once, and the
// table lists the pairs by name.
import { describe, it, expect } from 'vitest';
import { frame, settle, source, type Loose } from './template-fakes.js';

const CODE = source('flow.js');

function payload(over: Record<string, unknown> = {}) {
  return {
    v: 1, template: 'flow', params: { by: 'energy_source', split: 'states', measure: 'nameplate_mw', top: 10 }, scope: 'area',
    rows: [
      { energy_source: 'gas', states: 'TX', count: 3, sum: 300 }, { energy_source: 'solar', states: 'TX', count: 2, sum: 200 },
      { energy_source: 'solar', states: 'CA', count: 2, sum: 150 }, { energy_source: null, states: 'CA', count: 1, sum: 5 },
    ],
    roles: { by: [{ field: 'energy_source', role: 'category' }, { field: 'states', role: 'region' }], measure: { name: 'nameplate_mw', unit: 'MW' } },
    colours: { energy_source: { gas: '#111111', solar: '#ffcc00' } },
    labels: {
      title: 'Flow', locale: 'en-US', measure: 'Nameplate (MW)', count: 'Count', other: 'Other', none: '(none)',
      'value.energy_source.gas': 'Gas', 'value.energy_source.solar': 'Solar', 'value.states.TX': 'Texas', 'value.states.CA': 'California',
      'field.energy_source': 'Fuel', 'field.states': 'State', 'act.where': 'Show only this on the map', 'flow.only': 'Show only “{name}” on the map',
      'flow.overlap': 'Regions overlap.',
    },
    credit: 'EIA', units: {}, complete: true, truncated: false, theme: 'light', ...over,
  };
}

async function shown(over: Record<string, unknown> = {}) {
  const f = frame(CODE, payload(over));
  await settle();
  return f;
}
const texts = (doc: Loose, sel: string) => [...doc.querySelectorAll(sel)].map((x: Loose) => x.textContent);

describe('flow template', () => {
  it('loads d3 before d3-sankey, draws a node per group and a link per pair, then says drawn', async () => {
    const { TM, doc, sink } = await shown();
    expect(TM.lib.mock.calls.map((c: Loose) => c[0])).toEqual(['d3', 'd3-sankey']);
    expect(texts(doc, '.fl-node text')).toEqual(['Solar', 'Gas', '(none)', 'Texas', 'California']);   // largest first
    expect(doc.querySelectorAll('.fl-link')).toHaveLength(4);
    expect(doc.querySelector('.fl-link').getAttribute('stroke')).toBe('#111111');
    expect(TM.drawn).toHaveBeenCalledTimes(1);
    expect(TM.fail).not.toHaveBeenCalled();
    expect(sink).not.toHaveBeenCalled();
    expect(texts(doc, '.fl-note')).toContain('Regions overlap.');
  });

  it('keeps each side to its top groups + Other: never more than 40 nodes', async () => {
    const rows = [];
    for (let i = 0; i < 30; i++) for (let j = 0; j < 30; j++) rows.push({ energy_source: `f${i}`, states: `s${j}`, count: 1, sum: 1 + i + j });
    const { doc } = await shown({ rows, params: { top: 30 } });
    const names = texts(doc, '.fl-node text');
    expect(names.length).toBe(40);
    expect(names.filter((n: string) => n === 'Other')).toHaveLength(2);
  });

  it('the fold is "Smaller groups" when a group is already called Other; crowded labels are left out, names kept', async () => {
    const rows = [{ energy_source: 'other', states: 'TX', count: 1, sum: 900 }];
    for (let i = 0; i < 12; i++) rows.push({ energy_source: `f${i}`, states: 'TX', count: 1, sum: 1 });
    const { doc } = await shown({ rows, params: { top: 3 }, labels: { ...payload().labels, 'value.energy_source.other': 'Other', smaller: 'Smaller groups' } });
    const nodes = [...doc.querySelectorAll('.fl-node')] as Loose[];
    expect(nodes.map(n => n.getAttribute('aria-label').split(':')[0])).toEqual(['Other', 'f0', 'f1', 'Smaller groups', 'Texas']);
    // f0 and f1 are 1/912 of the height each: their labels would sit on Other's or each other's.
    expect(nodes.filter(n => !n.querySelector('text')).length).toBeGreaterThan(0);
  });

  it('hovering a node lights its links and dims the rest; leaving restores them', async () => {
    const { doc } = await shown();
    const gas = [...doc.querySelectorAll('.fl-node')][1] as Loose;
    gas.dispatchEvent(new doc.defaultView.MouseEvent('mouseenter'));
    const op = [...doc.querySelectorAll('.fl-link')].map((l: Loose) => l.getAttribute('stroke-opacity'));
    expect(op).toEqual(['0.72', '0.07', '0.07', '0.07']);
    gas.dispatchEvent(new doc.defaultView.MouseEvent('mouseleave'));
    expect(doc.querySelector('.fl-link').getAttribute('stroke-opacity')).toBe('0.42');
  });

  it('a node offers where on its own field; a link one item per end; none and Other offer nothing', async () => {
    const { doc, TM } = await shown();
    const nodes = [...doc.querySelectorAll('.fl-node')] as Loose[];
    nodes[3].dispatchEvent(new doc.defaultView.MouseEvent('click', { clientX: 5, clientY: 5 }));
    (doc.querySelector('.kit-menu button') as Loose).click();
    expect(TM.action).toHaveBeenLastCalledWith('where', { field: 'states', bin: 'TX' });
    const links = [...doc.querySelectorAll('.fl-link')] as Loose[];
    links[1].dispatchEvent(new doc.defaultView.MouseEvent('click', { clientX: 5, clientY: 5 }));
    expect(texts(doc, '.kit-menu button')).toEqual(['Show only “Solar” on the map', 'Show only “Texas” on the map']);
    (doc.querySelectorAll('.kit-menu button')[0] as Loose).click();
    expect(TM.action).toHaveBeenLastCalledWith('where', { field: 'energy_source', bin: 'solar' });
    TM.action.mockClear();
    nodes[2].dispatchEvent(new doc.defaultView.MouseEvent('click', { clientX: 5, clientY: 5 }));   // (none)
    expect(doc.querySelector('.kit-menu')).toBeNull();
    expect(TM.action).not.toHaveBeenCalled();
  });

  it('Enter on a focused node opens the same menu', async () => {
    const { doc } = await shown();
    const n = doc.querySelectorAll('.fl-node')[0] as Loose;
    n.dispatchEvent(new doc.defaultView.KeyboardEvent('keydown', { key: 'Enter' }));
    expect(texts(doc, '.kit-menu button')).toEqual(['Show only this on the map']);
  });

  it('a narrow frame draws top to bottom, labels upright, a long name truncated with a title', async () => {
    const f = frame(CODE, payload({ labels: { ...payload().labels, 'value.states.TX': 'A very long region name that cannot fit' } }));
    Object.defineProperty(f.w.HTMLElement.prototype, 'clientWidth', { get: () => 380 });
    await settle();
    const t = [...f.doc.querySelectorAll('.fl-node text')].find((x: Loose) => x.firstChild.nodeValue.endsWith('…')) as Loose;
    expect(t.getAttribute('transform')).toMatch(/^rotate\(-90/);
    expect(t.querySelector('title').textContent).toBe('A very long region name that cannot fit');
    const svg = f.doc.querySelector('.fl svg');
    expect(Number(svg.getAttribute('height'))).toBeGreaterThan(Number(svg.getAttribute('width')));
  });

  it('the table lists every pair by name; the SVG is the PNG export', async () => {
    const { doc } = await shown();
    (doc.querySelector('.kit-btn') as Loose).click();
    const cells = texts(doc, '.kit-table tbody tr:first-child td');
    expect(cells.slice(0, 2)).toEqual(['Gas', 'Texas']);
    expect((doc.querySelector('.kit-dl-menu .kit-btn:nth-child(2)') as Loose).hidden).toBe(false);
  });

  it('no rows: a note instead of a sankey, still drawn', async () => {
    const { doc, TM } = await shown({ rows: [] });
    expect(doc.querySelector('.fl svg text').textContent).toMatch(/Nothing to show/);
    expect(TM.drawn).toHaveBeenCalledTimes(1);
  });
});
