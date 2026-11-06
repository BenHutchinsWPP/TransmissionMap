// @vitest-environment jsdom
// The Visualize pane: the layer picker (switched-on layers first), the gallery
// listing only the ready templates a layer fits, a form whose selects list only
// the fields each slot takes, Show calling showTemplate with the form's
// arguments and stacking the card, timeline's net mode only where a
// retirement year exists, a tiled layer read from the current view (no Area)
// and, switched off, a Switch on button; the GeoJSON Area checkbox; and the
// tm-drawer round trip: saved on hidden, restored after a reload of the same
// link (a Vega card drawn again, an html card as a Re-run placeholder, a card
// whose params no longer pass dropped).
// Each "page load" is a fresh module graph (vi.resetModules) over the same
// sessionStorage, as a reload in the same tab.
// Deps: ui-templates.js over the real ui-table.js / catalogue / validateTemplateArgs;
//       show-template.js's showTemplate and visibility.js mocked; test-drawer-env.js.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const m = vi.hoisted(() => ({ calls: [] as Record<string, unknown>[], switched: [] as [string, boolean][], overlay: 0, cleared: [] as (number | undefined)[] }));

vi.mock('../templates/show-template.js', async (orig) => {
  const real = await orig<typeof import('../templates/show-template.js')>();
  return {
    ...real,
    showTemplate: async (args: Record<string, unknown>, host: { render?: (...a: unknown[]) => Promise<unknown> }) => {
      m.calls.push(args);
      const v = real.validateTemplateArgs(args);
      if (!v.ok) return v;
      const kind = v.result.def.kind;
      void host.render?.(kind, `${args.template} of ${args.layer}`, kind === 'vega' ? { mark: 'bar' } : '<p>x</p>', undefined,
        { template: { kind: 'template', templateId: args.template, layer: args.layer, params: real.renderParams(v.result) }, ...(m.overlay && { overlay: m.overlay++ }) });
      return { ok: true, result: { shown: true } };
    },
  };
});
// The county overlay as a token log: which card cleared which overlay.
vi.mock('../county-overlay.js', () => ({
  clearCountyOverlay: (token?: number) => { m.cleared.push(token); return true; },
  countyOverlayHeld: () => true, countyOverlayToken: () => null,
  onCountyOverlay: () => () => {}, ownCountyOverlay: () => {},
}));
vi.mock('../visibility.js', () => ({ setLayerVisibility: (id: string, on: boolean) => { m.switched.push([id, on]); } }));

// jsdom has no CSS.escape.
(globalThis as { CSS?: unknown }).CSS ??= { escape: (s: string) => s.replace(/["\\]/g, '\\$&') };

type Mods = {
  v: typeof import('./ui-templates.js');
  t: typeof import('./ui-table.js');
  state: typeof import('../state.js')['state'];
  bus: typeof import('../state-bus.js');
  cat: typeof import('../templates/catalogue.js');
  st: typeof import('../templates/show-template.js');
};

async function load(nav = 'reload'): Promise<Mods> {
  vi.resetModules();
  vi.spyOn(performance, 'getEntriesByType').mockReturnValue([{ type: nav } as unknown as PerformanceEntry]);
  document.body.replaceChildren();
  const env = await import('./test-drawer-env.js');
  const { state } = await import('../state.js');
  env.installDrawerEnv();
  Object.assign(state.map!, { loaded: () => true, once: () => {} });
  state.layerVisibility = {};
  state.area = null;
  state.where = {};
  return {
    v: await import('./ui-templates.js'), t: await import('./ui-table.js'), state, bus: await import('../state-bus.js'),
    cat: await import('../templates/catalogue.js'), st: await import('../templates/show-template.js'),
  };
}

const q = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const cards = () => [...document.querySelectorAll<HTMLElement>('.tv-card')].map(c => c.dataset.template);
const options = (sel: string) => [...q<HTMLSelectElement>(sel).options].map(o => o.value);
const choose = (sel: string, value: string) => { const s = q<HTMLSelectElement>(sel); s.value = value; s.dispatchEvent(new Event('change')); };
const pick = (id: string) => q<HTMLButtonElement>(`.tv-card[data-template="${id}"]`).click();
const settle = () => new Promise(r => setTimeout(r, 0));
function setHidden(hidden: boolean) {
  Object.defineProperty(document, 'visibilityState', { value: hidden ? 'hidden' : 'visible', configurable: true });
  document.dispatchEvent(new Event('visibilitychange'));
}

beforeEach(() => {
  sessionStorage.clear(); history.replaceState(null, '', '#3/40/-100?l=a'); vi.restoreAllMocks(); setHidden(false);
  m.calls.length = 0; m.switched.length = 0; m.overlay = 0; m.cleared.length = 0;
});
afterEach(async () => { (await import('./test-drawer-env.js')).resetDrawerEnv(); });

describe('the Visualize pane', () => {
  it('opens on the layer a row asked for, with the gallery of templates that fit it', async () => {
    const { v, t, cat } = await load();
    v.openVisualize('eia-generators');
    expect(t.vizOpen()).toBe(true);
    expect(q('#td-tab-viz').hidden).toBe(false);
    expect(q('#td-viz').hidden).toBe(false);
    expect(q<HTMLSelectElement>('.tv-layer').value).toBe('eia-generators');
    expect(cards()).toEqual(cat.templatesFor('eia-generators').map(d => d.id));
    expect(cards()).toContain('timeline');
    choose('.tv-layer', 'osm-transmission-lines');
    expect(cards()).toEqual(cat.templatesFor('osm-transmission-lines').map(d => d.id));
    expect(cards()).toContain('lines-by-class');
    expect(cards()).not.toContain('timeline');
  });

  it('lists the layers a template fits, switched-on ones first', async () => {
    const { v, state, cat } = await load();
    state.layerVisibility['mines'] = true;
    v.openVisualize();
    const ids = options('.tv-layer');
    expect(ids[0]).toBe('mines');
    expect(q<HTMLSelectElement>('.tv-layer').value).toBe('mines');
    expect(ids.every(id => cat.templatesFor(id).length > 0)).toBe(true);
    expect(ids).not.toContain('wind-speed');
  });

  it('the form lists only the fields each slot takes, by their labels', async () => {
    const { v, cat, st } = await load();
    v.openVisualize('eia-generators');
    pick('composition');
    const def = cat.templateById('composition')!;
    const c = st.formChoices(def, 'eia-generators')!;
    expect(options('.tv-by')).toEqual(c.by.map(f => f.name));
    expect(options('.tv-by')).not.toContain('nameplate_mw');
    expect([...q<HTMLSelectElement>('.tv-by').options].map(o => o.text)).toEqual(c.by.map(f => st.fieldLabel(f)));
    expect(options('.tv-measure')).toEqual(c.measure.map(x => x.name));
    expect(options('.tv-measure')).toContain('nameplate_mw');
    expect(document.querySelector('.tv-mode')).toBeNull();
  });

  it('Show calls showTemplate with the form’s arguments and stacks the card, newest first', async () => {
    const { v } = await load();
    v.openVisualize('eia-generators');
    pick('ranking');
    const by = options('.tv-by')[1];
    choose('.tv-by', by);
    const top = q<HTMLInputElement>('.tv-top');
    top.value = '5'; top.dispatchEvent(new Event('change'));
    q<HTMLButtonElement>('.tv-show').click();
    await vi.waitFor(() => expect(m.calls).toHaveLength(1));
    expect(m.calls[0]).toEqual({ template: 'ranking', layer: 'eia-generators', measure: 'nameplate_mw', by, top: 5 });
    await vi.waitFor(() => expect(document.querySelectorAll('.tv-cards .chat-canvas')).toHaveLength(1));
    expect(q('.tv-cards .chat-canvas').hasAttribute('data-template')).toBe(true);
    expect(q('.tv-cards .chat-canvas-label').textContent).toBe('TransmissionMap template');
    pick('composition');
    await vi.waitFor(() => expect(q<HTMLButtonElement>('.tv-show').disabled).toBe(false));
    q<HTMLButtonElement>('.tv-show').click();
    await vi.waitFor(() => expect(document.querySelectorAll('.tv-cards .chat-canvas')).toHaveLength(2));
    expect(q('.tv-cards .chat-canvas-title').textContent).toBe('composition of eia-generators');
    q<HTMLButtonElement>('.tv-cards .chat-canvas-close').click();
    expect(document.querySelectorAll('.tv-cards .chat-canvas')).toHaveLength(1);
  });

  it('split never offers by\'s field, and follows a by change', async () => {
    const { v } = await load();
    v.openVisualize('eia-generators');
    pick('flow');
    const by = q<HTMLSelectElement>('.tv-by').value;
    expect(options('.tv-split')).not.toContain(by);
    const split = options('.tv-split')[0];
    choose('.tv-split', split);
    choose('.tv-by', split);
    expect(options('.tv-split')).not.toContain(split);
    expect(options('.tv-split')).toContain(by);
    q<HTMLButtonElement>('.tv-show').click();
    await vi.waitFor(() => expect(m.calls).toHaveLength(1));
    expect(m.calls[0]).toMatchObject({ template: 'flow', by: split, split: q<HTMLSelectElement>('.tv-split').value });
    expect(m.calls[0].split).not.toBe(split);
  });

  it.skip('nearest takes a second layer, one condition on it and a threshold in the visitor\'s unit', async () => {
    const { v } = await load();
    v.openVisualize('osm-datacenters');
    pick('nearest');
    expect(q<HTMLSelectElement>('.tv-layer2').value).toBe('hifld-substations');
    expect(options('.tv-layer2')).not.toContain('osm-datacenters');
    expect(document.querySelector('.tv-measure')).toBeNull();
    expect(document.querySelector('.tv-top')).toBeNull();
    choose('.tv-cond-field', 'max_kv');
    choose('.tv-cond-op', '>=');
    const val = q<HTMLInputElement>('.tv-cond-value');
    val.value = '230'; val.dispatchEvent(new Event('change'));
    // Miles by default: 10 mi is 16.09 km.
    const w = q<HTMLInputElement>('.tv-within');
    expect(w.value).toBe('10');
    w.value = '5'; w.dispatchEvent(new Event('change'));
    q<HTMLButtonElement>('.tv-show').click();
    await vi.waitFor(() => expect(m.calls).toHaveLength(1));
    expect(m.calls[0]).toMatchObject({ template: 'nearest', layer: 'osm-datacenters', layer2: 'hifld-substations',
      where2: [{ field: 'max_kv', op: '>=', value: 230 }] });
    expect(m.calls[0].within as number).toBeCloseTo(8.04672, 4);
    expect(m.calls[0].area).toBeUndefined();   // validateTemplateArgs defaults it to the US
    // HIFLD covers the US only: the form says the points are cut to the US, and unticking reads the whole layer.
    const cb = q<HTMLInputElement>('.tv-in-area');
    expect(cb.checked).toBe(true);
    expect(cb.parentElement!.textContent).toMatch(/United States/);
    cb.checked = false; cb.dispatchEvent(new Event('change'));
    q<HTMLButtonElement>('.tv-show').click();
    await vi.waitFor(() => expect(m.calls).toHaveLength(2));
    expect(m.calls[1].area).toBeNull();
  });

  it('keeps at most six live cards: an older one collapses to a Re-run placeholder with no frame or payload', async () => {
    const { v } = await load();
    v.openVisualize('eia-generators');
    pick('ranking');
    for (let i = 1; i <= 7; i++) {
      await vi.waitFor(() => expect(q<HTMLButtonElement>('.tv-show').disabled).toBe(false));
      q<HTMLButtonElement>('.tv-show').click();
      await vi.waitFor(() => expect(document.querySelectorAll('.tv-cards > .chat-canvas')).toHaveLength(i));
    }
    const all = [...document.querySelectorAll<HTMLElement>('.tv-cards > .chat-canvas')];
    expect(all.slice(0, 6).every(c => !c.classList.contains('chat-canvas-restored'))).toBe(true);
    const ph = all[6];
    expect(ph.classList.contains('chat-canvas-restored')).toBe(true);
    expect(ph.querySelector('iframe, .chat-canvas-csv, .chat-canvas-table-slot')).toBeNull();
    // Only three frames are live; the evicted live cards have let go of theirs too.
    expect(document.querySelectorAll('.tv-cards iframe')).toHaveLength(3);
    m.calls.length = 0;
    ph.querySelector<HTMLButtonElement>('.chat-canvas-rerun')!.click();
    await vi.waitFor(() => expect(m.calls).toHaveLength(1));
    expect(m.calls[0]).toMatchObject({ template: 'ranking', layer: 'eia-generators', measure: 'nameplate_mw', top: 10 });
  });

  it('a card collapsed beyond six clears the county overlay it painted', async () => {
    const { v } = await load();
    v.openVisualize('eia-generators');
    pick('ranking');
    m.overlay = 1;   // each card paints one: tokens 1..7, oldest first
    for (let i = 1; i <= 7; i++) {
      await vi.waitFor(() => expect(q<HTMLButtonElement>('.tv-show').disabled).toBe(false));
      q<HTMLButtonElement>('.tv-show').click();
      await vi.waitFor(() => expect(document.querySelectorAll('.tv-cards > .chat-canvas')).toHaveLength(i));
    }
    expect(m.cleared).toEqual([1]);
  });

  it('timeline offers net only on a layer with a retirement year', async () => {
    const { v } = await load();
    v.openVisualize('eia-generators');
    pick('timeline');
    expect(options('.tv-mode')).toEqual(['additions', 'net']);
    choose('.tv-mode', 'net');
    q<HTMLButtonElement>('.tv-show').click();
    await vi.waitFor(() => expect(m.calls).toHaveLength(1));
    expect(m.calls[0]).toMatchObject({ template: 'timeline', layer: 'eia-generators', mode: 'net' });
    choose('.tv-layer', 'osm-datacenters');
    pick('timeline');
    expect(document.querySelector('.tv-mode')).toBeNull();
  });

  it('a GeoJSON layer reads the view’s Area unless the visitor unticks it', async () => {
    const { v, state } = await load();
    state.area = { kind: 'states', codes: ['TX'] };
    v.openVisualize('eia-generators');
    pick('composition');
    const cb = q<HTMLInputElement>('.tv-in-area');
    expect(cb.checked).toBe(true);
    q<HTMLButtonElement>('.tv-show').click();
    await vi.waitFor(() => expect(m.calls).toHaveLength(1));
    expect(m.calls[0]).not.toHaveProperty('area');
    cb.checked = false; cb.dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(q<HTMLButtonElement>('.tv-show').disabled).toBe(false));
    q<HTMLButtonElement>('.tv-show').click();
    await vi.waitFor(() => expect(m.calls).toHaveLength(2));
    expect(m.calls[1]).toMatchObject({ area: null });
  });

  it('a tiled layer reads the current view: no Area; switched off it offers Switch on', async () => {
    const { v, state, bus } = await load();
    state.area = { kind: 'states', codes: ['TX'] };
    v.openVisualize('osm-transmission-lines');
    pick('lines-by-class');
    expect(document.querySelector('.tv-in-area')).toBeNull();
    expect(q<HTMLButtonElement>('.tv-show').disabled).toBe(true);
    const on = q<HTMLButtonElement>('.tv-switch-on');
    expect(q('.tv-off').textContent).toContain('first: it is charted from the current view');
    on.click();
    expect(m.switched).toEqual([['osm-transmission-lines', true]]);
    state.layerVisibility['osm-transmission-lines'] = true;
    bus.emit('layer:visibility', { id: 'osm-transmission-lines', visible: true });
    expect(document.querySelector('.tv-switch-on')).toBeNull();
    expect(q('.tv-scope').textContent).toMatch(/Current view only/);
    expect(q<HTMLButtonElement>('.tv-show').disabled).toBe(false);
    q<HTMLButtonElement>('.tv-show').click();
    await vi.waitFor(() => expect(m.calls).toHaveLength(1));
    expect(m.calls[0]).not.toHaveProperty('area');
    expect(m.calls[0]).toMatchObject({ template: 'lines-by-class', layer: 'osm-transmission-lines' });
  });
});

describe('a columns-file layer', () => {
  it('accepts the Area and works switched off: no Switch on', async () => {
    const { v, state } = await load();
    state.area = { kind: 'states', codes: ['TX'] };
    state.layerVisibility['osm-substations-points'] = false;
    v.openVisualize('osm-substations-points');
    pick('composition');
    expect(document.querySelector('.tv-switch-on')).toBeNull();
    expect(q('.tv-in-area')).toBeTruthy();
    expect(q<HTMLButtonElement>('.tv-show').disabled).toBe(false);
  });
});

describe('Visualize in the tab snapshot', () => {
  async function saved() {
    const { v } = await load();
    v.openVisualize('eia-generators');
    pick('ranking');
    q<HTMLButtonElement>('.tv-show').click();
    await vi.waitFor(() => expect(document.querySelectorAll('.tv-cards .chat-canvas')).toHaveLength(1));
    choose('.tv-layer', 'ogf-planned-transmission');
    pick('lines-by-class');
    await vi.waitFor(() => expect(q<HTMLButtonElement>('.tv-show').disabled).toBe(false));
    q<HTMLButtonElement>('.tv-show').click();
    await vi.waitFor(() => expect(document.querySelectorAll('.tv-cards .chat-canvas')).toHaveLength(2));
    setHidden(true);
    setHidden(false);
  }

  it('saves the pane, its layer and its cards (params, never code)', async () => {
    await saved();
    const s = JSON.parse(sessionStorage.getItem('tm-drawer')!);
    expect(s.data).toMatchObject({ ask: false, table: null, pane: 'viz', viz: { layer: 'ogf-planned-transmission' } });
    expect(s.data.viz.cards.map((c: { templateId: string; layer: string }) => [c.templateId, c.layer]))
      .toEqual([['lines-by-class', 'ogf-planned-transmission'], ['ranking', 'eia-generators']]);
    expect(s.data.viz.cards[1].params).toMatchObject({ measure: 'nameplate_mw', top: 10 });
    expect(JSON.stringify(s)).not.toMatch(/<p>|mark/);
  });

  it('restores after a reload of the same link: Vega drawn again, html as Re-run, no focus moved', async () => {
    await saved();
    const { t, v } = await load();
    m.calls.length = 0;
    const before = document.activeElement;
    await t.restoreDrawer(async () => {}, v.resumeVisualize);
    expect(t.vizOpen()).toBe(true);
    expect(q('#td-viz').hidden).toBe(false);
    expect(q<HTMLSelectElement>('.tv-layer').value).toBe('ogf-planned-transmission');
    expect(document.activeElement).toBe(before);
    // The Vega card draws again on its own (from a queued microtask); the html one waits for Re-run.
    await vi.waitFor(() => expect(m.calls).toHaveLength(1));
    expect(document.querySelectorAll('.tv-cards > .chat-canvas')).toHaveLength(2);
    expect(document.querySelectorAll('.tv-cards .chat-canvas-restored')).toHaveLength(1);
    expect(m.calls[0]).toMatchObject({ template: 'ranking', layer: 'eia-generators', measure: 'nameplate_mw', top: 10 });
    await settle();
    const ph = q('.tv-cards .chat-canvas-restored');
    expect(ph.dataset.kind).toBe('html');
    ph.querySelector<HTMLButtonElement>('.chat-canvas-rerun')!.click();
    await vi.waitFor(() => expect(m.calls).toHaveLength(2));
    expect(m.calls[1]).toMatchObject({ template: 'lines-by-class', layer: 'ogf-planned-transmission' });
    await vi.waitFor(() => expect(document.querySelectorAll('.tv-cards .chat-canvas-restored')).toHaveLength(0));
  });

  it('redraws only into free frame slots (at most three, no eviction); the other Vega cards stay Re-run', async () => {
    const card = (title: string) => ({ templateId: 'ranking', layer: 'eia-generators', params: { measure: 'nameplate_mw', top: 10, title }, title });
    sessionStorage.setItem('tm-drawer', JSON.stringify({ v: 1, hash: location.hash, at: 1, data: {
      v: 1, ask: false, table: null, pane: 'viz', frac: 0, collapsed: false,
      viz: { layer: 'eia-generators', cards: ['E', 'D', 'C', 'B', 'A'].map(card) } } }));
    const { t, v } = await load();
    await t.restoreDrawer(async () => {}, v.resumeVisualize);
    await vi.waitFor(() => expect(m.calls).toHaveLength(3));
    await settle();
    expect(m.calls).toHaveLength(3);
    // The newest three, drawn oldest first so the stack ends at its top.
    expect(m.calls.map(c => c.title)).toEqual(['C', 'D', 'E']);
    expect([...document.querySelectorAll('.tv-cards .chat-canvas-restored .chat-canvas-title')].map(e => e.textContent)).toEqual(['B', 'A']);
    expect(document.querySelectorAll('.tv-cards iframe')).toHaveLength(3);
  });

  it('drops a card whose params no longer pass, and restores nothing on a fresh link', async () => {
    const put = (data: unknown) => sessionStorage.setItem('tm-drawer', JSON.stringify({ v: 1, hash: location.hash, at: 1, data }));
    const snap = { v: 1, ask: false, table: null, pane: 'viz', frac: 0, collapsed: false, viz: { layer: 'eia-generators', cards: [
      { templateId: 'ranking', layer: 'eia-generators', params: { by: 'no_such_field' }, title: 'x' },
      { templateId: 'density', layer: 'eia-generators', params: { measure: 'count' }, title: 'Density' },
    ] } };
    put(snap);
    let { t, v } = await load();
    await t.restoreDrawer(async () => {}, v.resumeVisualize);
    expect([...document.querySelectorAll('.tv-cards .chat-canvas-title')].map(e => e.textContent)).toEqual(['Density']);
    put(snap);
    ({ t, v } = await load('navigate'));
    await t.restoreDrawer(async () => {}, v.resumeVisualize);
    expect(t.vizOpen()).toBe(false);
  });
});
