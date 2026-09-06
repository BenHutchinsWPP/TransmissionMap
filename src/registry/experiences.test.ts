// @vitest-environment jsdom
// Guards the Experiences catalogue against the live registry: a renamed layer,
// a retired legend bucket or a mistyped basemap code fails here rather than
// silently rendering an empty map.
import { describe, it, expect } from 'vitest';
import {
  EXPERIENCES, EXPERIENCE_CATEGORY_LABELS, EXPERIENCE_CATEGORY_ORDER,
  AERIAL_MAX_ZOOM, experienceById, type ExperienceCategory,
} from './experiences.js';
import { LAYERS, layerById } from './index.js';
import { WEATHER_VARIABLES } from './conditions.js';
// ui-legends.ts sits in an import cycle with url-state-codec.ts, and the codec
// reads LEGEND_FILTERS at module scope. Pulling the codec in first lets
// ui-legends finish evaluating before that loop runs — the ordering
// url-state.test.ts gets for free by importing url-state.ts first.
import '../../assets/url-state-codec.js';
import { LEGEND_FILTERS, LEGEND_FILTERS_BY_KEY, legendAllIds } from '../../assets/ui/ui-legends.js';

const BASEMAPS = new Set(['light', 'dark', 'street', 'topo', 'aerial', 'hydro']);
const LAYER_IDS = new Set(LAYERS.map(l => l.id));

describe('EXPERIENCES catalogue shape', () => {
  it('holds the full curated set', () => {
    expect(EXPERIENCES.length).toBe(16);
  });

  it('ids are unique and URL-safe slugs', () => {
    const ids = EXPERIENCES.map(e => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id, `"${id}" is not a lowercase slug`).toMatch(/^[a-z0-9-]+$/);
  });

  it('experienceById round-trips every entry and rejects unknown ids', () => {
    for (const exp of EXPERIENCES) expect(experienceById(exp.id)).toBe(exp);
    expect(experienceById('does-not-exist')).toBeNull();
  });

  it('every entry carries title, summary, narrative and 2–4 takeaways', () => {
    for (const exp of EXPERIENCES) {
      expect(exp.title.length, `"${exp.id}" title`).toBeGreaterThan(0);
      expect(exp.summary.length, `"${exp.id}" summary`).toBeGreaterThan(0);
      expect(exp.narrative.length, `"${exp.id}" narrative`).toBeGreaterThan(0);
      expect(exp.takeaways.length, `"${exp.id}" takeaway count`).toBeGreaterThanOrEqual(2);
      expect(exp.takeaways.length, `"${exp.id}" takeaway count`).toBeLessThanOrEqual(4);
    }
  });

  it('every category is labelled and ordered in the gallery', () => {
    for (const exp of EXPERIENCES) {
      expect(EXPERIENCE_CATEGORY_LABELS[exp.category], `"${exp.id}" category`).toBeDefined();
      expect(EXPERIENCE_CATEGORY_ORDER, `"${exp.id}" category`).toContain(exp.category);
    }
  });

  it('the category order lists every labelled category exactly once', () => {
    const labelled = Object.keys(EXPERIENCE_CATEGORY_LABELS) as ExperienceCategory[];
    expect([...EXPERIENCE_CATEGORY_ORDER].sort()).toEqual([...labelled].sort());
  });
});

describe('EXPERIENCES camera', () => {
  it('centers are valid lng/lat and zoom/pitch sit inside the map limits', () => {
    for (const { id, camera } of EXPERIENCES) {
      const [lng, lat] = camera.center;
      expect(Math.abs(lng), `"${id}" lng`).toBeLessThanOrEqual(180);
      expect(Math.abs(lat), `"${id}" lat`).toBeLessThanOrEqual(85);
      expect(camera.zoom, `"${id}" zoom`).toBeGreaterThanOrEqual(0);
      expect(camera.zoom, `"${id}" zoom`).toBeLessThanOrEqual(18); // Map maxZoom
      expect(camera.pitch ?? 0, `"${id}" pitch`).toBeGreaterThanOrEqual(0);
      expect(camera.pitch ?? 0, `"${id}" pitch`).toBeLessThanOrEqual(75); // Map maxPitch
    }
  });

  it('aerial stories stay under the imagery ceiling', () => {
    for (const exp of EXPERIENCES) {
      if (exp.state.basemap !== 'aerial') continue;
      expect(exp.camera.zoom, `"${exp.id}" is aerial above the imagery ceiling`)
        .toBeLessThanOrEqual(AERIAL_MAX_ZOOM);
    }
  });

  it('highlight coordinates are valid lng/lat', () => {
    for (const exp of EXPERIENCES) {
      for (const h of exp.highlights ?? []) {
        const [lng, lat] = h.coordinates;
        expect(Math.abs(lng), `"${exp.id}" → ${h.label} lng`).toBeLessThanOrEqual(180);
        expect(Math.abs(lat), `"${exp.id}" → ${h.label} lat`).toBeLessThanOrEqual(85);
      }
    }
  });
});

describe('EXPERIENCES state presets', () => {
  it('every layersOn / layersOff id exists in the layer registry', () => {
    for (const exp of EXPERIENCES) {
      for (const id of [...(exp.state.layersOn ?? []), ...(exp.state.layersOff ?? [])]) {
        expect(LAYER_IDS.has(id), `"${exp.id}" names unknown layer "${id}"`).toBe(true);
      }
    }
  });

  it('no layer is switched on and off by the same experience', () => {
    for (const exp of EXPERIENCES) {
      const off = new Set(exp.state.layersOff ?? []);
      for (const id of exp.state.layersOn ?? []) {
        expect(off.has(id), `"${exp.id}" both enables and disables "${id}"`).toBe(false);
      }
    }
  });

  it('every basemap code is one the map can switch to', () => {
    for (const exp of EXPERIENCES) {
      if (!exp.state.basemap) continue;
      expect(BASEMAPS.has(exp.state.basemap), `"${exp.id}" basemap "${exp.state.basemap}"`).toBe(true);
    }
  });

  it('legendFilters name real legends and real buckets', () => {
    for (const exp of EXPERIENCES) {
      for (const [key, ids] of Object.entries(exp.state.legendFilters ?? {})) {
        const cfg = LEGEND_FILTERS_BY_KEY[key];
        expect(cfg, `"${exp.id}" names unknown legend "${key}"`).toBeDefined();
        const valid = new Set(legendAllIds(cfg));
        expect(ids.length, `"${exp.id}" legend "${key}" is empty`).toBeGreaterThan(0);
        for (const id of ids) {
          expect(valid.has(id), `"${exp.id}" legend "${key}" has unknown bucket "${id}"`).toBe(true);
        }
      }
    }
  });

  // A legend filter narrows layers that are off by default, so an experience
  // that sets one without switching a matching layer on renders nothing at all.
  it('a fuel filter always comes with a generator layer switched on', () => {
    const fuelLayers = new Set(LAYERS.filter(l => l.fuelLayer).map(l => l.id));
    for (const exp of EXPERIENCES) {
      if (!exp.state.legendFilters?.fuel) continue;
      const on = exp.state.layersOn ?? [];
      expect(on.some(id => fuelLayers.has(id)), `"${exp.id}" filters fuel with no generator layer on`).toBe(true);
    }
  });

  it('layerFilters name layers that have buckets, and real bucket ids', () => {
    for (const exp of EXPERIENCES) {
      for (const [layerId, ids] of Object.entries(exp.state.layerFilters ?? {})) {
        const entry = layerById(layerId);
        expect(entry, `"${exp.id}" names unknown layer "${layerId}"`).not.toBeNull();
        const buckets = entry?.filterBuckets;
        expect(buckets, `"${exp.id}" layer "${layerId}" has no filterBuckets`).toBeDefined();
        const valid = new Set((buckets ?? []).map(b => b.id));
        for (const id of ids) {
          expect(valid.has(id), `"${exp.id}" layer "${layerId}" has unknown bucket "${id}"`).toBe(true);
        }
      }
    }
  });

  it('genMode names mode-capable layers and modes they actually offer', () => {
    for (const exp of EXPERIENCES) {
      for (const [layerId, mode] of Object.entries(exp.state.genMode ?? {})) {
        const entry = layerById(layerId);
        expect(entry, `"${exp.id}" names unknown layer "${layerId}"`).not.toBeNull();
        const modes = entry?.modes
          ? entry.modes.map(m => m.id)
          : entry?.heatLayerId ? ['icons', 'heat', 'both'] : [];
        expect(modes, `"${exp.id}" layer "${layerId}" has no display modes`).not.toHaveLength(0);
        expect(modes, `"${exp.id}" layer "${layerId}" mode "${mode}"`).toContain(mode);
      }
    }
  });

  it('weatherVar names a real forecast variable and comes with the weather layer', () => {
    const varIds = new Set(WEATHER_VARIABLES.map(v => v.id));
    for (const exp of EXPERIENCES) {
      if (!exp.state.weatherVar) continue;
      expect(varIds.has(exp.state.weatherVar), `"${exp.id}" weatherVar "${exp.state.weatherVar}"`).toBe(true);
      expect(exp.state.layersOn ?? [], `"${exp.id}" sets weatherVar without weather-live`).toContain('weather-live');
    }
  });

  it('smokeOpacity stays in 0–1 and comes with the smoke layer', () => {
    for (const exp of EXPERIENCES) {
      if (exp.state.smokeOpacity === undefined) continue;
      expect(exp.state.smokeOpacity, `"${exp.id}" smokeOpacity`).toBeGreaterThanOrEqual(0);
      expect(exp.state.smokeOpacity, `"${exp.id}" smokeOpacity`).toBeLessThanOrEqual(1);
      expect(exp.state.layersOn ?? [], `"${exp.id}" sets smokeOpacity without wildfire-smoke`).toContain('wildfire-smoke');
    }
  });

  it('color-by presets stay within the modes the toggles offer', () => {
    for (const exp of EXPERIENCES) {
      if (exp.state.ogfColorBy) expect(['status', 'scenario', 'planauth']).toContain(exp.state.ogfColorBy);
      if (exp.state.westtecColorBy) expect(['scenario', 'dataset']).toContain(exp.state.westtecColorBy);
    }
  });

  it('every legend key the catalogue uses still exists in LEGEND_FILTERS', () => {
    const keys = new Set(LEGEND_FILTERS.map(c => c.key));
    for (const exp of EXPERIENCES) {
      for (const key of Object.keys(exp.state.legendFilters ?? {})) {
        expect(keys.has(key), `unknown legend key "${key}"`).toBe(true);
      }
    }
  });
});
