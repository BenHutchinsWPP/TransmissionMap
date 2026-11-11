// @vitest-environment jsdom
// The Routing constraints concern: its raster url, the setter's fallback, the
// source url swap on a fake map (held before the first show, live after), and
// the legend body each kind of concern draws, from the palettes.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { state } from './state.js';
import { applyLayerPlan, setMapLayerVisibility } from './layers/layer-plan.js';
import { planRouteConstraints } from './layers/map-layers-land.js';
import { routeConcernUrl, routeConcernLegendHtml, setRouteConcern, ROUTE_CONSTRAINTS_ID } from './route-constraints.js';
import { CONCERNS, CONSTRAINT_PALETTE, LAND_MANAGER_PALETTE, DEFAULT_CONCERN, concernById, concernKeys } from '../src/colors/route-constraints.js';
import { routeConstraintsDisclaimer, _resetDisclaimer } from './route-constraints.js';
import en from '../src/i18n/locales/en.js';
import { updateLegends } from './ui/ui-legends.js';

const swatches = (html: string) => [...html.matchAll(/class="legend-swatch" style="background:([^"]+)"/g)].map(m => m[1]);
const keys = (html: string) => [...html.matchAll(/data-i18n="([^"]+)"/g)].map(m => m[1]);

/** A map whose sources record setUrl; land() fires a source's metadata. */
function fakeMap() {
  const sources = new Map<string, { url?: string; setUrl: (u: string) => void }>();
  const layers = new Map<string, unknown>();
  const handlers: Record<string, ((e: object) => void)[]> = {};
  const setUrls: string[] = [];
  const known: Record<string, unknown> = {
    addSource: (id: string, spec: { url?: string }) => {
      const src = { url: spec.url, setUrl: (u: string) => { setUrls.push(u); src.url = u; } };
      sources.set(id, src);
    },
    addLayer: (spec: { id: string }) => { layers.set(spec.id, spec); },
    getSource: (id: string) => sources.get(id),
    getLayer: (id: string) => layers.get(id),
    on: (t: string, h: (e: object) => void) => { (handlers[t] ??= []).push(h); },
    off: (t: string, h: (e: object) => void) => { handlers[t] = (handlers[t] ?? []).filter(f => f !== h); },
  };
  const map = new Proxy(known, { get: (t, k: string) => t[k] ?? vi.fn() }) as unknown as NonNullable<typeof state.map>;
  const land = (sourceId: string) =>
    [...(handlers.sourcedata ?? [])].forEach(h => h({ type: 'sourcedata', sourceId, sourceDataType: 'metadata' }));
  return { map, sources, setUrls, land };
}

beforeEach(() => {
  state.map = null;
  state.layerVisibility = {};
  state.routeConcern = DEFAULT_CONCERN;
  document.body.innerHTML = '';
});

describe('routeConcernUrl', () => {
  it('names the concern\'s archive beside the route cube', () => {
    expect(routeConcernUrl('floodplain')).toBe(`pmtiles://${new URL('data/route/constraints/floodplain.pmtiles', location.href).href}`);
  });
});

describe('routeConcernUrl in a build', () => {
  it('names the data host\'s versioned constraints archive', async () => {
    vi.resetModules();
    vi.stubEnv('PROD', true);
    try {
      const { routeConcernUrl: prodUrl } = await import('./route-constraints.js');
      const { ROUTE_ID } = await import('./constants.js');
      expect(prodUrl('floodplain')).toBe(`pmtiles://https://data.wpptx.org/data/route/${ROUTE_ID}/constraints/floodplain.pmtiles`);
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });
});

describe('setRouteConcern', () => {
  it('writes state without a map, and falls back to the default for an unknown id', () => {
    setRouteConcern('wsa');
    expect(state.routeConcern).toBe('wsa');
    setRouteConcern('nope');
    expect(state.routeConcern).toBe(DEFAULT_CONCERN);
  });

  it('opens the raster on the concern in state', () => {
    state.routeConcern = 'phma';
    state.layerVisibility = { [ROUTE_CONSTRAINTS_ID]: true };
    const { map, sources } = fakeMap();
    applyLayerPlan(map, planRouteConstraints());
    expect(sources.get(ROUTE_CONSTRAINTS_ID)!.url).toBe(routeConcernUrl('phma'));
  });

  it('a pick before the first show is the url the first show loads; after it, the source reloads', () => {
    const { map, setUrls, land } = fakeMap();
    state.map = map;
    applyLayerPlan(map, planRouteConstraints());
    setRouteConcern('floodplain');            // a link or an Undo, layer still off
    expect(setUrls).toEqual([]);
    setMapLayerVisibility(map, ROUTE_CONSTRAINTS_ID, 'visible');
    expect(setUrls).toEqual([routeConcernUrl('floodplain')]);
    land(ROUTE_CONSTRAINTS_ID);
    setRouteConcern('land-manager');
    expect(setUrls).toEqual([routeConcernUrl('floodplain'), routeConcernUrl('land-manager')]);
    setRouteConcern('land-manager');
    expect(setUrls).toHaveLength(2);
  });
});

describe('routeConcernLegendHtml', () => {
  it('the overview lists every precedence class in order, with the military and low-zoom notes', () => {
    const html = routeConcernLegendHtml('what-constrains');
    expect(swatches(html)).toEqual(CONSTRAINT_PALETTE.map(c => c.colour));
    expect(keys(html)).toEqual([
      ...CONSTRAINT_PALETTE.map(c => c.labelKey), 'route.concern.noteMilitary', 'route.concern.noteMaxOverview',
    ]);
  });

  it('Land manager lists the manager colours and says what is unshaded', () => {
    const html = routeConcernLegendHtml('land-manager');
    expect(swatches(html)).toEqual(LAND_MANAGER_PALETTE.map(c => c.colour));
    expect(keys(html).at(-1)).toBe('route.concern.noteUnshaded');
  });

  it('a mask draws one swatch in its colour, its note, and the low-zoom note', () => {
    for (const c of CONCERNS.filter(c => c.kind === 'mask')) {
      const html = routeConcernLegendHtml(c.id);
      expect(swatches(html), c.id).toEqual([c.colour]);
      const credit = c.id.startsWith('osm-') ? ['route.concern.creditOsm'] : [];
      expect(keys(html), c.id).toEqual([c.labelKey, ...(c.noteKey ? [c.noteKey] : []), 'route.concern.noteMax', ...(c.id === 'existing-line-230' || c.id.startsWith('parallel-') ? ['route.concern.creditOsmLines'] : credit)]);
    }
  });

  it('a classes concern lists its classes, then its notes and credit', () => {
    const homes = routeConcernLegendHtml('homes');
    expect(swatches(homes)[0]).toBe('#b45309');
    expect(swatches(homes)).toHaveLength(3);
    expect(keys(homes).at(-1)).toBe('route.concern.noteMax');
    const land = routeConcernLegendHtml('landcover');
    expect(swatches(land)).toHaveLength(9);
    expect(keys(land).slice(-2)).toEqual(['route.concern.noteLandcoverPnas', 'route.concern.noteMode']);
    expect(keys(routeConcernLegendHtml('tnc')).at(-1)).toBe('route.concern.creditPopwest');
    expect(keys(routeConcernLegendHtml('parallel-100')).at(-1)).toBe('route.concern.creditOsmLines');
    expect(keys(routeConcernLegendHtml('osm-lake')).at(-1)).toBe('route.concern.creditOsm');
    expect(keys(routeConcernLegendHtml('floodplain')).some(k => k.includes('.credit'))).toBe(false);
  });

  it('the English dictionary has every concern, class, note and credit key', () => {
    const want = [...concernKeys(), 'route.concern.noteMode', 'route.concern.creditOsm', 'route.concern.creditOsmLines', 'route.concern.creditPopwest'];
    expect(want.filter(k => !(k in en))).toEqual([]);
  });

  it('setRouteConcern redraws the legend body and its title', () => {
    document.body.innerHTML = `<div id="legendContainer" hidden></div>
      <div id="routeConstraintsLegend" hidden><span id="routeConstraintsConcern"></span><div id="routeConstraintsLegendItems"></div></div>`;
    setRouteConcern('military');
    expect(document.getElementById('routeConstraintsLegendItems')!.innerHTML).toBe(routeConcernLegendHtml('military'));
    const title = document.getElementById('routeConstraintsConcern')!;
    expect(title.dataset.i18n).toBe(concernById('military')!.labelKey);
    expect(title.textContent).toBe('Military land');
    updateLegends();
    expect(document.getElementById('routeConstraintsLegend')!.hidden).toBe(true);
    state.layerVisibility = { [ROUTE_CONSTRAINTS_ID]: true };
    updateLegends();
    expect(document.getElementById('routeConstraintsLegend')!.hidden).toBe(false);
  });
});

describe('setRouteConcern on a held source', () => {
  it('a pick after a failed first load loads the newly picked concern', () => {
    const { map, setUrls } = fakeMap();
    state.map = map;
    applyLayerPlan(map, planRouteConstraints());          // held: the layer was off at plan time
    state.layerVisibility = { [ROUTE_CONSTRAINTS_ID]: true };   // switched on, but its first show never loaded
    expect(setUrls).toEqual([]);
    setRouteConcern('floodplain');
    expect(setUrls.at(-1)).toBe(routeConcernUrl('floodplain'));
  });
});

describe('tribal disclaimer', () => {
  const show = vi.fn();
  beforeEach(() => {
    _resetDisclaimer();
    show.mockClear();
    document.body.innerHTML = '<dialog id="tribalDisclaimerDialog"></dialog>';
    (document.getElementById('tribalDisclaimerDialog') as HTMLDialogElement).showModal = show;
  });

  it('shows once when the layer is on with a concern that draws tribal land', () => {
    state.layerVisibility = { [ROUTE_CONSTRAINTS_ID]: true };
    setRouteConcern('floodplain');
    expect(show).not.toHaveBeenCalled();
    setRouteConcern('land-manager');
    expect(show).toHaveBeenCalledTimes(1);
    setRouteConcern('what-constrains');
    expect(show).toHaveBeenCalledTimes(1);
  });

  it('shows for the Tribal land concern', () => {
    state.layerVisibility = { [ROUTE_CONSTRAINTS_ID]: true };
    setRouteConcern('tribal');
    expect(show).toHaveBeenCalledTimes(1);
  });

  it('stays quiet while the layer is off, and shows when it is switched on', () => {
    state.layerVisibility = {};
    setRouteConcern('what-constrains');
    expect(show).not.toHaveBeenCalled();
    state.layerVisibility = { [ROUTE_CONSTRAINTS_ID]: true };
    routeConstraintsDisclaimer();
    expect(show).toHaveBeenCalledTimes(1);
  });
});
