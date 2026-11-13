// @vitest-environment jsdom
// The table's designed default columns stay inside what a row may carry
// (allowedFields), and each keeps the column the rows first sort by; the
// drawer's three panes (table, Ask, Route) open, close and take turns.
// Deps: ui-table.js, dataset-query.js, test-drawer-env.js.
import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import {
  TABLE_DEFAULT_COLUMNS, defaultColumns, defaultSumField,
  openRoute, closeRoute, routeOpen, routePanel, routeActions, setRouteTall,
  openAsk, closeAsk, showTable, closeTable,
} from './ui-table.js';
import { installDrawerEnv, resetDrawerEnv, type DrawerEnv } from './test-drawer-env.js';
import { allowedFields, describe as describeLayer } from '../dataset-query.js';

const fieldsOf = (layerId: string) => {
  const d = describeLayer(layerId);
  if (!d.ok || !d.result.queryable) throw new Error(`${layerId} is not queryable`);
  return d.result;
};

describe('TABLE_DEFAULT_COLUMNS', () => {
  for (const [layerId, cols] of Object.entries(TABLE_DEFAULT_COLUMNS)) {
    it(`${layerId}: every default column is allowed, the sum field included`, () => {
      expect(cols.filter(c => !allowedFields(layerId).includes(c))).toEqual([]);
      const { fields } = fieldsOf(layerId);
      const sum = defaultSumField(fields);
      if (sum) expect(cols).toContain(sum);
      expect(fields.find(f => f.name === sum)?.additive).not.toBe(false);
    });
  }

  it('never sums a level: OSM lines and substations count by default', () => {
    expect(defaultSumField(fieldsOf('osm-transmission-lines').fields)).toBe('');
    expect(defaultSumField(fieldsOf('osm-substations-points').fields)).toBe('');
  });

  it('EIA starts with 8 columns, OSM substations with 6', () => {
    const eia = fieldsOf('eia-generators');
    expect(defaultColumns('eia-generators', eia.fields, eia.idField)).toHaveLength(8);
    const sub = fieldsOf('osm-substations-points');
    expect(defaultColumns('osm-substations-points', sub.fields, sub.idField)).toHaveLength(6);
  });

  it('any other layer shows every field but the region lists and the id', () => {
    const { fields, idField } = fieldsOf('hifld-substations');
    const cols = defaultColumns('hifld-substations', fields, idField);
    expect(cols).not.toContain(idField);
    expect(cols.some(c => fields.find(f => f.name === c)?.list)).toBe(false);
    expect(cols.length).toBeGreaterThan(0);
  });
});

// ─── The drawer's three panes ────────────────────────────────────────────────
// One pane shows at a time; Esc and × close the active pane only; the drawer hides
// when no pane is left; ←→ Home End move over the open tabs.

describe('drawer panes', () => {
  let env: DrawerEnv;
  const q = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
  const drawer = () => q('.table-drawer');
  const visibleTabs = () => [...document.querySelectorAll<HTMLElement>('.td-tab')].filter(b => !b.hidden).map(b => b.id);
  const selected = () => [...document.querySelectorAll<HTMLElement>('.td-tab')]
    .filter(b => !b.hidden && b.getAttribute('aria-selected') === 'true').map(b => b.id);
  const tableShown = () => !drawer().classList.contains('td--table-off');
  const key = (el: HTMLElement, k: string) => el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
  const openTable = () => showTable({ layerId: 'osm-substations-points' });

  beforeAll(() => {
    env = installDrawerEnv();
    Object.defineProperty(env.container, 'clientHeight', { value: 800, configurable: true });
  });
  afterAll(resetDrawerEnv);
  afterEach(() => { closeRoute(); closeAsk(); closeTable(); });

  it('Route alone: only its tab, selected, and its pane', () => {
    const panel = routePanel();
    openRoute();
    expect(routeOpen()).toBe(true);
    expect(drawer().hidden).toBe(false);
    expect(visibleTabs()).toEqual(['td-tab-route']);
    expect(selected()).toEqual(['td-tab-route']);
    expect(panel.hidden).toBe(false);
    expect(q('#td-ask').hidden).toBe(true);
    expect(tableShown()).toBe(false);
  });

  it('Route with the table: both tabs; Route selected shows alone', async () => {
    openRoute();
    await openTable();
    expect(visibleTabs()).toEqual(['td-tab', 'td-tab-route']);
    expect(selected()).toEqual(['td-tab']);   // Show in table brings the table forward
    expect(routeOpen()).toBe(true);
    expect(q('#td-route').hidden).toBe(true);
    q('#td-tab-route').click();
    expect(selected()).toEqual(['td-tab-route']);
    expect(q('#td-route').hidden).toBe(false);
    expect(tableShown()).toBe(false);
  });

  it('shows one pane at a time and keeps the others mounted', async () => {
    routePanel();
    Object.defineProperty(drawer(), 'clientWidth', { value: 1200, configurable: true });
    await openTable();
    openAsk();
    expect(selected()).toEqual(['td-tab-ask']);
    expect(q('#td-ask').hidden).toBe(false);
    expect(tableShown()).toBe(false);
    q('#td-tab').click();
    expect(selected()).toEqual(['td-tab']);
    expect(q('#td-ask').hidden).toBe(true);
    expect(tableShown()).toBe(true);
    expect(visibleTabs()).toEqual(['td-tab-ask', 'td-tab']);
    openRoute();
    expect(selected()).toEqual(['td-tab-route']);
    expect(q('#td-ask').hidden).toBe(true);
    expect(tableShown()).toBe(false);
    closeRoute();
    expect(selected()).toEqual(['td-tab']);
    delete (drawer() as { clientWidth?: number }).clientWidth;
  });

  it('closing the table keeps Route and the drawer', async () => {
    openRoute();
    await openTable();
    closeTable();
    expect(drawer().hidden).toBe(false);
    expect(visibleTabs()).toEqual(['td-tab-route']);
    expect(selected()).toEqual(['td-tab-route']);
    expect(q('#td-route').hidden).toBe(false);
  });

  it('closing Ask keeps Route and the drawer', () => {
    openRoute();
    openAsk();
    expect(selected()).toEqual(['td-tab-ask']);
    closeAsk();
    expect(drawer().hidden).toBe(false);
    expect(routeOpen()).toBe(true);
    expect(selected()).toEqual(['td-tab-route']);
  });

  it('Esc with Route in view closes Route only', async () => {
    openRoute();
    await openTable();
    q('#td-tab-route').click();
    key(q('#td-tab-route'), 'Escape');
    expect(routeOpen()).toBe(false);
    expect(drawer().hidden).toBe(false);
    expect(visibleTabs()).toEqual(['td-tab']);
    expect(tableShown()).toBe(true);
  });

  it('Esc already handled (defaultPrevented) is left alone', () => {
    openRoute();
    const ev = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    ev.preventDefault();
    routePanel().dispatchEvent(ev);
    expect(routeOpen()).toBe(true);
  });

  it('each tab has a × that closes just that pane; the drawer hides with the last', () => {
    const onClose = vi.fn();
    openRoute(onClose);
    openAsk();
    q('.td-tab-x[data-pane="ask"]').click();
    expect(routeOpen()).toBe(true);
    expect(visibleTabs()).toEqual(['td-tab-route']);
    expect(drawer().hidden).toBe(false);
    expect(q('.td-tab-x[data-pane="ask"]').hidden).toBe(true);
    q('.td-tab-x[data-pane="route"]').click();
    expect(routeOpen()).toBe(false);
    expect(onClose).toHaveBeenCalledOnce();
    expect(drawer().hidden).toBe(true);
    expect(document.activeElement).toBe(env.canvas);
  });

  it('closeRoute returns focus to the opener', () => {
    const btn = document.body.appendChild(document.createElement('button'));
    openRoute(undefined, btn);
    closeRoute();
    expect(document.activeElement).toBe(btn);
    btn.remove();
  });

  it('←→ Home End cycle over the open tabs', async () => {
    await openTable();
    openAsk();
    openRoute();
    expect(visibleTabs()).toEqual(['td-tab-ask', 'td-tab', 'td-tab-route']);
    key(q('#td-tab-route'), 'ArrowRight');
    expect(document.activeElement!.id).toBe('td-tab-ask');
    expect(selected()).toContain('td-tab-ask');
    key(q('#td-tab-ask'), 'ArrowLeft');
    expect(document.activeElement!.id).toBe('td-tab-route');
    key(q('#td-tab-route'), 'Home');
    expect(document.activeElement!.id).toBe('td-tab-ask');
    key(q('#td-tab-ask'), 'End');
    expect(document.activeElement!.id).toBe('td-tab-route');
    closeAsk();
    key(q('#td-tab-route'), 'ArrowRight');   // Ask's tab is hidden: skipped
    expect(document.activeElement!.id).toBe('td-tab');
  });

  it('routeActions shows only while Route is in view', async () => {
    const slot = routeActions();
    expect(slot.closest('.td-head')).not.toBeNull();
    openRoute();
    expect(slot.hidden).toBe(false);
    await openTable();
    expect(slot.hidden).toBe(true);
    q('#td-tab-route').click();
    expect(slot.hidden).toBe(false);
    closeRoute();
    expect(slot.hidden).toBe(true);
  });

  it('setRouteTall: at least 540 px while on, the previous height after', () => {
    openRoute();
    const before = drawer().style.height;
    expect(parseFloat(before)).toBeLessThan(540);
    setRouteTall(true);
    expect(drawer().style.height).toBe('540px');
    setRouteTall(false);
    expect(drawer().style.height).toBe(before);
  });
});
