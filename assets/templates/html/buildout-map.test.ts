// buildout-map.js in a jsdom frame: one step per year (or month) with no gaps,
// the map filtered to the steps shown so far, Play advances the step and stops
// at the end, scrubbing pauses and jumps, reduced motion opens on the last step
// and never plays by itself, undated features counted, a dot's menu, the table
// by name, no HTML sink.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { frame, settle, source, type Loose } from './template-fakes.js';

const CODE = source('buildout-map.js');
const pt = (id: number, x: number, y: number, props: Record<string, unknown>) => ({ type: 'Feature', id, geometry: { type: 'Point', coordinates: [x, y] }, properties: props });

function payload(over: Record<string, unknown> = {}) {
  return {
    v: 1, template: 'buildout-map', params: { by: 'energy_source', time: 'op_year', measure: 'nameplate_mw' }, scope: 'area',
    rows: [{ energy_source: 'solar', op_year: 2001, count: 1, sum: 10 }, { energy_source: 'gas', op_year: 2004, count: 2, sum: 300 }],
    features: [
      pt(1, -100, 40, { plant_name: 'A', energy_source: 'solar', op_year: 2001, nameplate_mw: 10 }),
      pt(2, -99, 41, { plant_name: 'B', energy_source: 'gas', op_year: 2004, nameplate_mw: 100 }),
      pt(3, -98, 42, { plant_name: 'C', energy_source: 'gas', op_year: 2004, nameplate_mw: 200 }),
      pt(4, -97, 43, { plant_name: 'D', energy_source: 'gas', op_year: null, nameplate_mw: 5 }),
    ],
    roles: { by: [{ field: 'energy_source', role: 'category' }], measure: { name: 'nameplate_mw', unit: 'MW' }, time: { field: 'op_year', bin: 'year' } },
    colours: { energy_source: { solar: '#ffcc00', gas: '#111111' } },
    labels: {
      title: 'Build-out', locale: 'en-US', 'value.energy_source.solar': 'Solar', 'value.energy_source.gas': 'Gas', 'field.op_year': 'Op year',
      'bo.play': 'Play', 'bo.pause': 'Pause', 'bo.total': 'Shown: {n}', 'bo.added': 'added this step: {n}', undated: 'Left out: {n} without a usable year.',
      'act.select': 'Select on the map ({n})', 'act.fly': 'Zoom the map here', 'act.table': 'Show in table',
    },
    credit: 'EIA', units: {}, complete: true, truncated: false, theme: 'light', ...over,
  };
}

async function shown(over: Record<string, unknown> = {}, opts = {}) {
  const f = frame(CODE, payload(over), opts);
  await settle();
  const map = f.map();
  map.fire('load');
  return { ...f, map, step: () => f.doc.querySelector('.bo-step').textContent, play: () => f.doc.querySelector('.bo-ctl .kit-btn') as Loose };
}
afterEach(() => { vi.useRealTimers(); });

describe('buildout-map template', () => {
  it('a step per year from the first to the last, the map filtered to the steps so far; undated counted', async () => {
    const { doc, map, step, sink } = await shown();
    expect(step()).toBe('2001');
    expect((doc.querySelector('.bo-ctl input[type=range]') as Loose).max).toBe('3');   // 2001…2004
    expect(map.filters.pts).toEqual(['<=', ['get', 's'], 0]);
    expect(map.sources.pts.data.features).toHaveLength(3);
    expect(map.sources.pts.data.features[2].properties.r).toBeGreaterThan(map.sources.pts.data.features[1].properties.r);
    expect([...doc.querySelectorAll('.bo-stat')].map((x: Loose) => x.textContent)).toContain('Left out: 1 without a usable year.');
    expect(doc.querySelectorAll('.bo-spark rect')).toHaveLength(5);   // background + 4 steps
    expect(sink).not.toHaveBeenCalled();
  });

  it('plays from the first step once drawn, advancing and stopping at the end', async () => {
    const { map, step, play, TM } = await shown();
    vi.useFakeTimers();
    map.fire('idle');
    expect(TM.drawn).toHaveBeenCalledTimes(1);
    expect(play().textContent).toBe('Pause');
    vi.advanceTimersByTime(5000);
    expect(step()).toBe('2004');
    expect(map.filters.pts).toEqual(['<=', ['get', 's'], 3]);
    expect(play().textContent).toBe('Play');
    play().click();                       // from the end: starts again at the first step
    expect(step()).toBe('2001');
  });

  it('scrubbing pauses and jumps to the step', async () => {
    const { doc, map, w, step, play } = await shown();
    vi.useFakeTimers();
    map.fire('idle');
    const r = doc.querySelector('.bo-ctl input[type=range]') as Loose;
    r.value = '2';
    r.dispatchEvent(new w.Event('input'));
    expect(step()).toBe('2003');
    expect(play().textContent).toBe('Play');
    expect(doc.querySelector('.bo-stat').textContent.replace(/\u00a0/g, ' ')).toBe('Shown: 10 MW (1) · added this step: 0 MW');
  });

  it('under reduced motion: opens on the last step and never plays by itself', async () => {
    const { map, step, play } = await shown({}, { reducedMotion: true });
    vi.useFakeTimers();
    map.fire('idle');
    vi.advanceTimersByTime(5000);
    expect(step()).toBe('2004');
    expect(play().textContent).toBe('Play');
    expect(map.filters.pts).toEqual(['<=', ['get', 's'], 3]);
  });

  it('month steps when the page read the field by month, labelled from the payload', async () => {
    const { doc, step } = await shown({
      roles: { by: [], measure: { name: 'count' }, time: { field: 'last_event', bin: 'month' } },
      params: { time: 'last_event' }, rows: [{ last_event: '2024-11', count: 1 }, { last_event: '2025-02', count: 1 }],
      features: [pt(1, 0, 0, { last_event: '2024-11' }), pt(2, 1, 1, { last_event: '2025-02' })],
      labels: { ...payload().labels, 'value.last_event.2024-11': 'Nov 2024', 'value.last_event.2025-02': 'Feb 2025' },
    }, { reducedMotion: true });
    expect(step()).toBe('Feb 2025');
    expect((doc.querySelector('.bo-ctl input[type=range]') as Loose).max).toBe('3');   // Nov, Dec, Jan, Feb
  });

  it('a shown dot offers select, table and zoom by its id', async () => {
    const { doc, map, TM } = await shown();
    map.hits = [{ properties: { i: 1 } }];
    map.fire('click', { point: { x: 1, y: 1 } });
    const items = [...doc.querySelectorAll('.kit-menu button')] as Loose[];
    expect(items.map(b => b.textContent)).toEqual(['Select on the map (1)', 'Show in table', 'Zoom the map here']);
    items[2].click();
    expect(TM.action).toHaveBeenLastCalledWith('fly', { id: 2 });
  });

  it('the table lists the rows by name', async () => {
    const { doc } = await shown();
    (doc.querySelector('.kit-btn') as Loose).click();
    expect([...doc.querySelectorAll('.kit-table tbody tr:first-child td')].map((x: Loose) => x.textContent)).toEqual(['2001', 'Solar', '1', '10']);
  });
});
