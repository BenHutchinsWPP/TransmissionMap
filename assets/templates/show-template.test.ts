// showTemplate: arguments checked against the catalogue and the layer's roles
// (refusals list what each slot takes and the templates that fit), defaults
// from roles and the view, the payload (folded legend colours, translated
// labels, plain-text credit, scope from shapeRows), the render call for a vega
// and an html template, the model's summary (page figures, ≤ 1 KB) and what a
// failed frame may tell the model (a category only).
// Deps: show-template.js over the real catalogue, registry, roles and builders;
//       dataset-query.js's shapeRows mocked (shapeSlots real).

import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import type { ShapeOpts, ShapeResult } from '../dataset-query.js';

const m = vi.hoisted(() => ({ shape: vi.fn(), paint: vi.fn(() => 7), clear: vi.fn() }));
vi.mock('../dataset-query.js', async orig => ({ ...(await orig<typeof import('../dataset-query.js')>()), shapeRows: m.shape }));
vi.mock('../county-overlay.js', () => ({ paintCountyOverlay: m.paint, clearCountyOverlay: m.clear }));
vi.mock('../layers/layer-data.js', () => ({ loadSource: vi.fn(async () => {}), liveGeneratedUtc: () => undefined }));

import { showTemplate, groupKeys, validateTemplateArgs, formChoices, TEMPLATE_ARGS, templatesFor, creditText, templateHtml, renderParams, coverageArea, tierLabel, capPayload, MAX_SUMMARY_BYTES, MAX_TEMPLATE_INPUT_BYTES } from './show-template.js';
import { CATALOGUE, TEMPLATE_IDS, templateById } from './catalogue.js';
import { VIZ_PARAMS } from '../ui/drawer-snapshot.js';
import { TEMPLATE_SIGNATURES } from '../../src/registry/template-signatures.js';
import { state } from '../state.js';
import type { TemplatePayload } from './payload.js';
import type { RenderExtra } from '../agent/tools.js';
import { layerSourceId } from '../layers/layer-source.js';
import { RAMP } from './per-region.js';

const RESULT: ShapeResult = {
  layerId: 'eia-generators', scope: 'area', by: ['energy_source'], measure: 'nameplate_mw', unit: 'MW',
  rows: [
    { energy_source: 'NG', count: 10, sum: 500 }, { energy_source: 'SUN', count: 20, sum: 300 },
    { energy_source: 'WND', count: 5, sum: 200 }, { energy_source: 'NUC', count: 1, sum: 100 },
    { energy_source: 'DFO', count: 2, sum: 10 }, { energy_source: 'KER', count: 1, sum: 5 },   // both oil
    { energy_source: null, count: 1, sum: 1 },
  ],
  totals: { count: 40, sum: 1116 }, complete: true, truncated: false, precision: 'full geometry',
};

type Call = [string, string, unknown, unknown, RenderExtra];
function host(outcome: unknown = { shown: true }) {
  const calls: Call[] = [];
  return { calls, render: vi.fn(async (...a: unknown[]) => { calls.push(a as Call); return outcome as never; }) };
}

beforeEach(() => {
  m.paint.mockClear();
  m.clear.mockClear();
  m.shape.mockReset();
  m.shape.mockImplementation(async (layerId: string, o: ShapeOpts) => ({ ok: true, result: { ...RESULT, layerId, by: o.by ?? [], measure: o.measure ?? 'count' } }));
  state.area = null;
  state.where = {};
  state.layerVisibility = {};
});

const refusal = (args: unknown) => { const r = validateTemplateArgs(args); return r.ok ? '' : r.reason; };

describe('catalogue', () => {
  it('names all 15 archetypes, each with its signature; only built ones are ready and carry a source', () => {
    expect(TEMPLATE_IDS).toEqual(TEMPLATE_SIGNATURES.map(s => s.id));
    for (const d of CATALOGUE) {
      expect(d.signature.id).toBe(d.id);
      expect(d.kind).toBe(d.signature.renderer);
      if (d.id !== 'nearest') expect(!!d.source).toBe(d.ready); // nearest keeps its source while withheld
      if (d.source) expect(d.source.kind).toBe(d.kind);
    }
    expect(CATALOGUE.filter(d => d.ready).map(d => d.id)).toEqual(expect.arrayContaining(['composition', 'ranking', 'timeline', 'density']));
  });

  it('every ready html template fits the frame with the kit, and none can close its script tag', async () => {
    const kit = (await import('./html/kit.js?raw')).default;
    for (const d of CATALOGUE.filter(x => x.source?.kind === 'html')) {
      const code = await (d.source as { load: () => Promise<string> }).load();
      expect(templateHtml(kit, code).length).toBeLessThanOrEqual(50_000);
    }
    expect(() => templateHtml('', 'x="</script>"')).toThrow();
  });
});

describe('validateTemplateArgs', () => {
  it('refuses unknown arguments, templates and layers, listing what exists', () => {
    expect(refusal({ template: 'composition', layer: 'eia-generators', colour: 'red' })).toMatch(/unknown argument "colour".*template, layer/);
    expect(refusal({ template: 'pie', layer: 'eia-generators' })).toMatch(/unknown template "pie".*composition.*templates that fit "eia-generators": composition, ranking, distribution, timeline, buildout-map, flow, density/);
    expect(refusal({ template: 'composition', layer: 'wind-speed' })).toMatch(/"wind-speed" takes no template: templates read .*eia-generators/);
    expect(refusal({ template: 'constructor', layer: 'eia-generators' })).toMatch(/unknown template/);
  });

  it('refuses a template that is not built yet, suggesting the ready ones that fit', () => {
    expect(refusal({ template: 'hierarchy', layer: 'eia-generators' })).toBe('"hierarchy" is not available yet; templates that fit "eia-generators": composition, ranking, distribution, timeline, buildout-map, flow, density, compare-regions, points-per-polygon, pies-per-region');
  });

  it('refuses a template whose signature the layer cannot fill', () => {
    expect(refusal({ template: 'density', layer: 'osm-transmission-lines' }))
      .toBe('"density" does not fit "osm-transmission-lines": it draws point or polygon layers and "osm-transmission-lines" is a line layer; templates that fit "osm-transmission-lines": composition, ranking, distribution, flow, lines-by-class, compare-regions, points-per-polygon, pies-per-region');
  });

  it('a field of the wrong role names its role and lists what the slot takes', () => {
    const r = refusal({ template: 'composition', layer: 'eia-generators', by: 'plant_name' });
    expect(r).toMatch(/^"plant_name" is a label on "eia-generators", which composition cannot use as by: by takes energy_source \(category, legend fuel\)/);
    expect(r).not.toMatch(/states \(region\)/);     // composition's C slot takes no region list
    expect(refusal({ template: 'composition', layer: 'eia-generators', by: 'nope' })).toMatch(/"eia-generators" has no field "nope"/);
    expect(refusal({ template: 'density', layer: 'eia-generators', by: 'energy_source' })).toBe('"density" takes no by');
    expect(refusal({ template: 'composition', layer: 'hifld-substations', measure: 'max_kv' }))
      .toMatch(/"max_kv" is a level, not an amount: use it as by instead\): measure takes count$/);
  });

  it('distribution takes buckets (5-40) and keeps them for a re-run', () => {
    const base = { template: 'distribution', layer: 'eia-generators' };
    expect(refusal({ ...base, buckets: 4 })).toMatch(/buckets must be a whole number from 5 to 40/);
    expect(refusal({ ...base, buckets: 41 })).toMatch(/buckets must be a whole number from 5 to 40/);
    expect(refusal({ ...base, buckets: 7.5 })).toMatch(/buckets/);
    const v = validateTemplateArgs({ ...base, buckets: 10 });
    expect(v.ok && renderParams(v.result).buckets).toBe(10);
    const d = validateTemplateArgs(base);
    expect(d.ok && 'buckets' in renderParams(d.result)).toBe(false);
  });

  it('checks top, title, area and where', () => {
    const base = { template: 'composition', layer: 'eia-generators' };
    expect(refusal({ ...base, top: 2 })).toMatch(/top must be a whole number from 3 to 30/);
    expect(refusal({ ...base, buckets: 10 })).toMatch(/takes no buckets/);
    expect(refusal({ ...base, top: 4.5 })).toMatch(/top/);
    expect(refusal({ ...base, title: 'x'.repeat(121) })).toMatch(/title/);
    expect(refusal({ ...base, title: 'a\nb' })).toMatch(/title/);
    expect(refusal({ ...base, area: { kind: 'states', codes: ['ZZZ'] } })).not.toBe('');
    expect(refusal({ ...base, where: [{ field: 'nope', op: '==', value: 1 }] })).not.toBe('');
    expect(refusal({ template: 'lines-by-class', layer: 'osm-transmission-lines', area: { kind: 'states', codes: ['TX'] } }))
      .toMatch(/tiled layer: lines-by-class covers the current view only/);
  });

  it('defaults: a facet-linked category, the first additive measure (else length / area, else count), top 10', () => {
    const eia = validateTemplateArgs({ template: 'composition', layer: 'eia-generators' });
    expect(eia.ok && { by: eia.result.by, measure: eia.result.measure, top: eia.result.top }).toEqual({ by: 'energy_source', measure: 'nameplate_mw', top: 10 });
    const lines = validateTemplateArgs({ template: 'composition', layer: 'osm-transmission-lines' });
    expect(lines.ok && [lines.result.by, lines.result.measure]).toEqual(['nominal_kv', 'length_km']);
    const subs = validateTemplateArgs({ template: 'composition', layer: 'hifld-substations' });
    expect(subs.ok && [subs.result.by, subs.result.measure]).toEqual(['max_kv', 'count']);
    const dc = validateTemplateArgs({ template: 'composition', layer: 'osm-datacenters' });
    expect(dc.ok && dc.result.by).toBe('operator');                  // no facet: the first category
  });

  it("defaults area to the view's Area on a GeoJSON layer it reaches, never on a tiled one; where to the layer's conditions", () => {
    state.area = { kind: 'states', codes: ['TX'] };
    state.where = { 'eia-generators': [{ field: 'nameplate_mw', op: '>=', value: 100 }] };
    const eia = validateTemplateArgs({ template: 'composition', layer: 'eia-generators' });
    expect(eia.ok && [eia.result.area, eia.result.where]).toEqual([state.area, state.where['eia-generators']]);
    const lines = validateTemplateArgs({ template: 'lines-by-class', layer: 'osm-transmission-lines' });
    expect(lines.ok && lines.result.area).toBeNull();
    // A columns-file layer reads the whole dataset: it takes the Area (given or the view's), and formChoices says so.
    const col = validateTemplateArgs({ template: 'composition', layer: 'osm-transmission-lines' });
    expect(col.ok && col.result.area).toEqual(state.area);
    const given = validateTemplateArgs({ template: 'composition', layer: 'osm-transmission-lines', area: { kind: 'states', codes: ['NM'] } });
    expect(given.ok && given.result.area).toEqual({ kind: 'states', codes: ['NM'] });
    const tpl = (id: string) => templateById(id)!;
    expect(formChoices(tpl('composition'), 'osm-transmission-lines')!.tiled).toBe(false);
    expect(formChoices(tpl('lines-by-class'), 'osm-transmission-lines')!.tiled).toBe(true);
    const none = validateTemplateArgs({ template: 'composition', layer: 'eia-generators', area: null, where: [] });
    expect(none.ok && [none.result.area, none.result.where]).toEqual([null, []]);
  });

  it('renderParams keeps area null and the where actually used, so a Re-run reproduces the card after the view changes', () => {
    state.where = { 'eia-generators': [{ field: 'nameplate_mw', op: '>=', value: 100 }] };
    const r = validateTemplateArgs({ template: 'composition', layer: 'eia-generators' });
    if (!r.ok) throw new Error(r.reason);
    const kept = renderParams(r.result);
    expect(kept).toMatchObject({ area: null, where: [{ field: 'nameplate_mw', op: '>=', value: 100 }] });
    // The view moves on: a TX Area and no conditions. The kept params still read the whole layer at ≥ 100 MW.
    state.area = { kind: 'states', codes: ['TX'] };
    state.where = {};
    const again = validateTemplateArgs({ ...kept, template: 'composition', layer: 'eia-generators' });
    expect(again.ok && [again.result.area, again.result.where]).toEqual([null, [{ field: 'nameplate_mw', op: '>=', value: 100 }]]);
    // No conditions at all is kept as [] (not picked up from the view later).
    const bare = validateTemplateArgs({ template: 'composition', layer: 'eia-generators', area: null });
    expect(bare.ok && renderParams(bare.result).where).toEqual([]);
    state.where = { 'eia-generators': [{ field: 'nameplate_mw', op: '>=', value: 5 }] };
    const rerun = validateTemplateArgs({ ...(bare.ok ? renderParams(bare.result) : {}), template: 'composition', layer: 'eia-generators' });
    expect(rerun.ok && rerun.result.where).toEqual([]);
  });

  it('renderParams round-trips through the validator', () => {
    const r = validateTemplateArgs({ template: 'composition', layer: 'eia-generators', by: 'gen_status', top: 5, title: 'Mine' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const again = validateTemplateArgs({ ...renderParams(r.result), template: 'composition', layer: 'eia-generators' });
    expect(again.ok && renderParams(again.result)).toEqual(renderParams(r.result));
  });

  it('refuses the wave-2 params on a template whose params do not list them', () => {
    const base = { template: 'composition', layer: 'eia-generators' };
    expect(refusal({ ...base, split: 'states' })).toBe('"composition" takes no split; split is for flow, compare-regions, pies-per-region');
    expect(refusal({ ...base, layer2: 'hifld-substations' })).toBe('"composition" takes no layer2');
    expect(refusal({ ...base, where2: [] })).toBe('"composition" takes no where2');
    expect(refusal({ ...base, within: 5 })).toBe('"composition" takes no within');
    expect(refusal({ template: 'density', layer: 'eia-generators', split: 'states' })).toBe('"density" takes no split; split is for flow, compare-regions, pies-per-region');
  });

  it('VIZ_PARAMS (the drawer snapshot) holds every param a card keeps', () => {
    expect([...VIZ_PARAMS].sort()).toEqual(TEMPLATE_ARGS.filter(k => k !== 'template' && k !== 'layer').sort());
  });

  describe('wave-2 params (on catalogue entries made ready for the test)', () => {
    const SOURCE = { kind: 'vega' as const, load: async () => () => ({}) };
    const WAVE2 = ['compare-regions', 'flow', 'nearest', 'distribution'];
    const made: { ready: boolean; source?: unknown }[] = [];
    beforeAll(() => {
      for (const id of WAVE2) {
        const d = templateById(id)! as { ready: boolean; source?: unknown };
        made.push({ ...d });
        Object.assign(d, { ready: true, source: SOURCE });
      }
    });
    afterAll(() => {
      WAVE2.forEach((id, i) => Object.assign(templateById(id)!, made[i]));
    });

    it('split: a field of its slot other than by; a malformed or wrong-role one lists what it takes', () => {
      const cr = { template: 'compare-regions', layer: 'eia-generators' };
      const d = validateTemplateArgs(cr);
      expect(d.ok && [d.result.by, d.result.split]).toEqual(['energy_source', 'states']);
      expect(refusal({ ...cr, split: 7 })).toMatch(/^split must be a field name: split takes states \(region\)/);
      expect(refusal({ ...cr, split: 'gen_status' })).toMatch(/"gen_status" is a category on "eia-generators", which compare-regions cannot use as split: split takes states/);
      expect(refusal({ ...cr, split: 'nope' })).toMatch(/"eia-generators" has no field "nope"/);
      const nerc = validateTemplateArgs({ ...cr, split: 'nerc' });
      expect(nerc.ok && nerc.result.split).toBe('nerc');
      // flow: split may be a category or a region, never the by field.
      expect(refusal({ template: 'flow', layer: 'eia-generators', by: 'energy_source', split: 'energy_source' }))
        .toMatch(/^split must be another field than by \("energy_source"\)/);
      const flow = validateTemplateArgs({ template: 'flow', layer: 'eia-generators', split: 'sector_name' });
      expect(flow.ok && [flow.result.by, flow.result.split]).toEqual(['energy_source', 'sector_name']);
    });

    it("split defaults to the Area's own field when the template takes it", () => {
      const r = validateTemplateArgs({ template: 'compare-regions', layer: 'eia-generators', area: { kind: 'ba', codes: ['ERCO', 'CISO'] } });
      expect(r.ok && r.result.split).toBe('ba');
    });

    it('layer2: a queryable GeoJSON point layer other than layer; where2 through the link validator', () => {
      const nb = { template: 'nearest', layer: 'osm-datacenters' };
      const d = validateTemplateArgs(nb);
      expect(d.ok && [d.result.layer2, d.result.where2, d.result.within]).toEqual(['hifld-substations', [], 16.1]);
      expect(refusal({ ...nb, layer2: 'osm-substations-points' })).toMatch(/^"osm-substations-points" is a tiled layer: .*layer2 takes .*hifld-substations/);
      expect(refusal({ ...nb, layer2: 'hifld-transmission-lines' })).toMatch(/is a line layer and layer2 takes point layers/);
      expect(refusal({ ...nb, layer2: 'osm-datacenters' })).toMatch(/^layer2 must be another layer than layer/);
      expect(refusal({ ...nb, layer2: 'wind-speed' })).toMatch(/^"wind-speed" takes no template: layer2 takes/);
      expect(refusal({ ...nb, layer2: 3 })).toMatch(/^layer2 must be a layer id/);
      expect(refusal({ ...nb, where2: [{ field: 'nope', op: '=', value: 1 }] })).toMatch(/^where2: /);
      expect(refusal({ ...nb, where2: 'x' })).toMatch(/^where2: /);
      const kv = [{ field: 'max_kv', op: '>=' as const, value: 230 }];
      const ok = validateTemplateArgs({ ...nb, where2: kv });
      expect(ok.ok && ok.result.where2).toEqual(kv);
      state.where = { 'hifld-substations': kv };
      const cur = validateTemplateArgs(nb);
      expect(cur.ok && cur.result.where2).toEqual(kv);
    });

    it('within: km from 0.1 to 500', () => {
      const nb = { template: 'nearest', layer: 'osm-datacenters' };
      for (const bad of [0, 0.05, 501, '5', Number.NaN]) expect(refusal({ ...nb, within: bad }), String(bad)).toMatch(/^within must be a distance in km from 0.1 to 500/);
      const r = validateTemplateArgs({ ...nb, within: 3.2 });
      expect(r.ok && r.result.within).toBe(3.2);
    });

    it('renderParams keeps split, layer2, where2 and within, and round-trips', () => {
      for (const args of [
        { template: 'compare-regions', layer: 'eia-generators', split: 'nerc' },
        { template: 'nearest', layer: 'osm-datacenters', layer2: 'eia-generators', within: 2 },
      ]) {
        const r = validateTemplateArgs(args);
        if (!r.ok) throw new Error(r.reason);
        const kept = renderParams(r.result);
        expect(Object.keys(kept).every(k => VIZ_PARAMS.includes(k))).toBe(true);
        const again = validateTemplateArgs({ ...kept, template: args.template, layer: args.layer });
        expect(again.ok && renderParams(again.result)).toEqual(kept);
      }
      const n = validateTemplateArgs({ template: 'nearest', layer: 'osm-datacenters' });
      expect(n.ok && renderParams(n.result)).toMatchObject({ layer2: 'hifld-substations', where2: [], within: 16.1 });
    });

    it('distribution: measure is the binned field (levels, length / area, years; never count), summed when an amount', async () => {
      const d = (layer: string, measure?: unknown) => validateTemplateArgs({ template: 'distribution', layer, ...(measure !== undefined && { measure }) });
      const eia = d('eia-generators');
      expect(eia.ok && eia.result.measure).toBe('nameplate_mw');
      const kv = d('hifld-substations');
      expect(kv.ok && kv.result.measure).toBe('max_kv');
      const km = d('hifld-natgas-lines');
      expect(km.ok && km.result.measure).toBe('length_km');
      expect(refusal({ template: 'distribution', layer: 'eia-generators', measure: 'count' }))
        .toBe('measure "count" cannot be binned on "eia-generators": measure takes nameplate_mw, op_year, retirement_year');
      expect(formChoices(templateById('distribution')!, 'hifld-substations')!.measure.map(m => m.name)).toEqual(['max_kv', 'min_kv']);
      expect(refusal({ template: 'distribution', layer: 'hifld-substations', by: 'max_kv' })).toBe('by must be another field than the binned measure ("max_kv")');
      const stack = d('eia-generators');
      expect(stack.ok && stack.result.by).toBeUndefined();   // the stack is off unless asked for
      await showTemplate({ template: 'distribution', layer: 'eia-generators', area: null }, host());
      expect(m.shape).toHaveBeenLastCalledWith('eia-generators', { by: [], measure: 'nameplate_mw', bins: { field: 'nameplate_mw' }, geometry: 'none' });
      await showTemplate({ template: 'distribution', layer: 'hifld-substations', area: null }, host());
      expect(m.shape).toHaveBeenLastCalledWith('hifld-substations', { by: [], measure: 'count', bins: { field: 'max_kv' }, geometry: 'none' });
    });

    it('nearest: a world layer beside a US-only layer2 reads the US unless an area is given', () => {
      const USA = { kind: 'countries', codes: ['USA'] };
      expect(coverageArea('osm-datacenters', 'hifld-substations')).toEqual(USA);
      expect(coverageArea('osm-datacenters', 'eia-generators')).toEqual(USA);
      expect(coverageArea('eia-generators', 'hifld-substations')).toBeNull();   // a US layer needs no cut
      const n = validateTemplateArgs({ template: 'nearest', layer: 'osm-datacenters' });
      expect(n.ok && n.result.area).toEqual(USA);
      expect(n.ok && renderParams(n.result).area).toEqual(USA);
      const whole = validateTemplateArgs({ template: 'nearest', layer: 'osm-datacenters', area: null });
      expect(whole.ok && whole.result.area).toBeNull();
      const fr = { kind: 'countries' as const, codes: ['FRA'] };
      const frv = validateTemplateArgs({ template: 'nearest', layer: 'osm-datacenters', area: fr });
      expect(frv.ok && frv.result.area).toEqual(fr);
      state.area = { kind: 'states', codes: ['TX'] };
      const tx = validateTemplateArgs({ template: 'nearest', layer: 'osm-datacenters' });
      expect(tx.ok && tx.result.area).toEqual(state.area);   // the view's Area wins
      const us = validateTemplateArgs({ template: 'nearest', layer: 'eia-generators' });
      expect(us.ok && us.result.area).toEqual(state.area);
      state.area = null;
      const usAll = validateTemplateArgs({ template: 'nearest', layer: 'eia-generators' });
      expect(usAll.ok && usAll.result.area).toBeNull();
    });

    it('formChoices offers split fields and layer2 layers', () => {
      const f = formChoices(templateById('compare-regions')!, 'eia-generators')!;
      expect(f.split.map(x => x.name)).toContain('nerc');
      expect(f.layer2).toEqual([]);
      const n = formChoices(templateById('nearest')!, 'osm-datacenters')!;
      expect(n.layer2).toContain('hifld-substations');
      expect(n.layer2).not.toContain('osm-substations-points');
      expect(n.layer2).not.toContain('osm-datacenters');
    });
  });

  it('templatesFor lists the ready templates a layer fits', () => {
    expect(templatesFor('osm-transmission-lines').map(d => d.id)).toEqual(expect.arrayContaining(['composition', 'ranking']));
    expect(templatesFor('wind-speed')).toEqual([]);
  });
});

describe('showTemplate', () => {
  it('shapes the rows for the resolved params and renders a vega template with folded legend colours', async () => {
    const h = host();
    const r = await showTemplate({ template: 'composition', layer: 'eia-generators', top: 3 }, h);
    expect(r.ok).toBe(true);
    expect(m.shape).toHaveBeenCalledWith('eia-generators', { by: ['energy_source'], measure: 'nameplate_mw', geometry: 'none' });
    const [kind, title, spec, inputs, extra] = h.calls[0];
    expect(kind).toBe('vega');
    expect(inputs).toBeUndefined();
    expect(title).toMatch(/^.+: Nameplate \(MW\) by Fuel Type$/);
    expect(extra.template).toEqual({ kind: 'template', templateId: 'composition', layer: 'eia-generators',
      params: { by: 'energy_source', measure: 'nameplate_mw', top: 3, area: null, where: [] } });
    expect(extra.partial).toEqual([]);
    const values = (spec as { data: { values: { label: string; value: number; colour: string }[] } }).data.values;
    // NG → gas, SUN → solar, WND → wind; the rest summed into Other.
    expect(values.map(v => v.value)).toEqual([500, 300, 200, 116]);
    expect(values[3]).toMatchObject({ label: 'Other', colour: '#9ca3af' });
    expect(values.every(v => /^#[0-9a-f]{6}$/i.test(v.colour))).toBe(true);
    expect(extra.csv!()).toContain('energy_source');
    // The card's actions: the group selection bridged to `where`, each datum carrying its row key.
    expect(extra.signals).toEqual([{ signal: 'pick', kind: 'where', layer: 'eia-generators', field: 'energy_source', read: 'label' }]);
    expect(typeof extra.onAction).toBe('function');
    expect(groupKeys(spec as Record<string, unknown>)).toEqual(new Map<string, string | null>([
      ...values.slice(0, 3).map(v => [v.label, (v as { key?: string }).key!] as [string, string]), ['Other', null]]));
    expect(values.slice(0, 3).map(v => (v as { key?: string }).key)).toEqual(['gas', 'solar', 'wind']);
  });

  it('bridges timeline legend picks as `leg` and none without a by field; an html template gets an onAction and no signals', async () => {
    const tl = host();
    await showTemplate({ template: 'timeline', layer: 'eia-generators' }, tl);
    expect(tl.calls[0][4].signals?.[0]).toMatchObject({ signal: 'leg', kind: 'where', field: 'energy_source' });
    const d = host();
    await showTemplate({ template: 'density', layer: 'eia-generators' }, d);
    expect(typeof d.calls[0][4].onAction).toBe('function');
    expect(d.calls[0][4].signals).toBeUndefined();
    expect((d.calls[0][3] as TemplatePayload).labels).toMatchObject({ 'act.select': 'Select on the map ({n})', 'act.fly': expect.any(String), 'act.table': expect.any(String), 'act.where': expect.any(String) });
  });

  it('builds the payload: rows folded into legend buckets, colours, labels, plain-text credit, scope', async () => {
    const h = host();
    await showTemplate({ template: 'density', layer: 'eia-generators' }, h);
    expect(m.shape).toHaveBeenCalledWith('eia-generators', { by: [], measure: 'nameplate_mw', geometry: 'point' });
    const [kind, , html, payload, extra] = h.calls[0] as [string, string, string, TemplatePayload, RenderExtra];
    expect(kind).toBe('html');
    expect(html).toMatch(/^<!doctype html>/);
    expect(html).toContain('Kit.input()');
    expect(extra.template?.templateId).toBe('density');
    expect(payload).toMatchObject({ v: 1, template: 'density', scope: 'area', complete: true, truncated: false, theme: 'light',
      params: { measure: 'nameplate_mw', top: 10 } });
    expect(payload.credit).not.toMatch(/[<>]/);
    expect(payload.credit.length).toBeGreaterThan(0);
    expect(payload.labels).toMatchObject({ scopeView: expect.any(String), scopeArea: 'Every feature of the layer.', count: 'Count', other: 'Other', locale: 'en', dir: 'ltr' });
    expect(payload.roles.measure).toEqual({ name: 'nameplate_mw', unit: 'MW' });
  });

  it('folds a facet field: fuel codes into FUEL_LEGEND rows, with the legend colours and labels', async () => {
    let seen: TemplatePayload | null = null;
    const comp = CATALOGUE.find(d => d.id === 'composition')!;
    const load = comp.source!.load;
    (comp.source as { load: unknown }).load = async () => (p: TemplatePayload) => { seen = p; return { mark: 'bar' }; };
    try {
      await showTemplate({ template: 'composition', layer: 'eia-generators' }, host());
    } finally { (comp.source as { load: unknown }).load = load; }
    const p = seen! as TemplatePayload;
    const keys = p.rows.map(r => r.energy_source);
    expect(keys).toContain('gas');
    expect(keys).not.toContain('NG');
    expect(new Set(keys).size).toBe(keys.length);                     // DFO + KER met in one row
    const oil = p.rows.find(r => r.energy_source === 'oil');
    expect(oil && [oil.count, oil.sum]).toEqual([3, 15]);
    expect(p.colours.energy_source.gas).toMatch(/^#/);
    expect(p.labels['value.energy_source.gas']).toBeTruthy();
    expect(p.roles.by).toEqual([{ field: 'energy_source', role: 'category' }]);
    expect(p.labels.summary).toMatch(/: .*500/);
  });

  it('timeline: additions only by default; mode net adds the retirement-year rows, tagged retire and keyed by the opening year', async () => {
    const yr = (field: string) => ({ ...RESULT, by: ['energy_source'], time: field, rows: [
      { energy_source: 'NG', [field]: 2000, count: 3, sum: 30 }, { energy_source: 'SUN', [field]: 2010, count: 2, sum: 20 },
      { energy_source: 'NG', [field]: null, count: 9, sum: 90 },
    ] });
    m.shape.mockImplementation(async (layerId: string, o: ShapeOpts) => ({ ok: true, result: { ...yr(o.time!.field), layerId } }));
    const seen: TemplatePayload[] = [];
    const tl = CATALOGUE.find(d => d.id === 'timeline')!;
    const load = tl.source!.load;
    (tl.source as { load: unknown }).load = async () => (p: TemplatePayload) => { seen.push(p); return { mark: 'bar' }; };
    try {
      await showTemplate({ template: 'timeline', layer: 'eia-generators' }, host());
      await showTemplate({ template: 'timeline', layer: 'eia-generators', mode: 'net' }, host());
    } finally { (tl.source as { load: unknown }).load = load; }
    expect(m.shape).toHaveBeenCalledTimes(3);
    expect(seen[0].rows.some(r => r.side !== undefined)).toBe(false);
    expect(seen[0].params.mode).toBe('additions');
    const retire = seen[1].rows.filter(r => r.side === 'retire');
    expect(retire.map(r => [r.op_year, r.sum])).toEqual([[2000, 30], [2010, 20]]);   // the undated one is left out
    expect(retire.every(r => !('retirement_year' in r))).toBe(true);
    expect(seen[1].rows.filter(r => r.side === 'add').length).toBe(3);
    expect(m.shape.mock.calls[2][1].time).toEqual({ field: 'retirement_year', bin: 'year' });
  });

  it('timeline mode: only additions or net, and net needs a retirement year; other templates take no mode', () => {
    expect(refusal({ template: 'timeline', layer: 'eia-generators', mode: 'gross' })).toMatch(/mode must be one of additions, net/);
    expect(refusal({ template: 'timeline', layer: 'osm-datacenters', mode: 'net' })).toMatch(/no retirement year/);
    expect(refusal({ template: 'composition', layer: 'eia-generators', mode: 'net' })).toBe('"composition" takes no mode; mode is for timeline');
    const r = validateTemplateArgs({ template: 'timeline', layer: 'eia-generators', mode: 'net' });
    expect(r.ok && renderParams(r.result).mode).toBe('net');
  });

  it('folds each feature\'s by property into the legend buckets like its rows', async () => {
    const line = (substance: string | null) => ({ type: 'Feature' as const, geometry: { type: 'LineString' as const, coordinates: [[0, 0], [1, 1]] },
      properties: { name: 'P', substance, length_km: 3 } });
    m.shape.mockResolvedValueOnce({ ok: true, result: { ...RESULT, layerId: 'osm-pipelines-lines', scope: 'view', by: ['substance'], measure: 'length_km', unit: undefined,
      rows: [{ substance: 'natural_gas', count: 1, sum: 3 }, { substance: 'gas', count: 1, sum: 3 }, { substance: null, count: 1, sum: 3 }],
      features: [line('natural_gas'), line('gas'), line(null)] } });
    const h = host();
    await showTemplate({ template: 'lines-by-class', layer: 'osm-pipelines-lines' }, h);
    const p = h.calls[0][3] as TemplatePayload;
    expect(p.rows.map(r => r.substance)).toEqual(['gas', null]);
    expect(p.features!.map(f => f.properties!.substance)).toEqual(['gas', 'gas', null]);
    expect(Object.keys(p.colours.substance)).toEqual(['gas']);
  });

  it('labels: density strings, a capitalised count and a floor-area measure', async () => {
    const h = host();
    await showTemplate({ template: 'density', layer: 'eia-generators' }, h);
    const p = h.calls[0][3] as TemplatePayload;
    expect(p.labels).toMatchObject({ 'density.hex': '3D hex', 'density.heat': '2D heat', 'density.orbit': 'Orbit', 'density.low': 'Low', 'density.high': 'High', 'density.largest': 'Largest', count: 'Count' });
  });

  it('colours a field with no facet from the neutral palette by rank', async () => {
    m.shape.mockResolvedValueOnce({ ok: true, result: { ...RESULT, layerId: 'osm-datacenters', by: ['operator'], measure: 'count', unit: undefined,
      rows: [{ operator: 'A', count: 1 }, { operator: 'B', count: 9 }] } });
    let seen: TemplatePayload | null = null;
    const comp = CATALOGUE.find(d => d.id === 'composition')!;
    const load = comp.source!.load;
    (comp.source as { load: unknown }).load = async () => (p: TemplatePayload) => { seen = p; return { mark: 'bar' }; };
    try { await showTemplate({ template: 'composition', layer: 'osm-datacenters' }, host()); } finally { (comp.source as { load: unknown }).load = load; }
    expect((seen! as TemplatePayload).colours.operator).toEqual({ B: '#4e79a7', A: '#f28e2b' });
  });

  it('a tiled layer reports view scope: partial on the card and in the result, tiers named', async () => {
    m.shape.mockResolvedValueOnce({ ok: true, result: { ...RESULT, layerId: 'osm-transmission-lines', scope: 'view', by: ['nominal_kv'], measure: 'length_km', unit: 'km',
      rows: [{ nominal_kv: '300-499', count: 4, sum: 120 }], complete: false, tiersHidden: ['lt100'] } });
    const h = host();
    const r = await showTemplate({ template: 'composition', layer: 'osm-transmission-lines' }, h);
    expect(r.ok && r.result).toMatchObject({ scope: 'view', complete: false, partial: true, tiersHidden: ['lt100'] });
    expect(h.calls[0][4].partial).toHaveLength(1);
  });

  it('a stride sample from the columns file shows on the card and in the result', async () => {
    m.shape.mockResolvedValueOnce({ ok: true, result: { ...RESULT, layerId: 'osm-substations-points', by: [], measure: 'count', rows: [{ count: 30000 }], features: [], truncated: true, truncation: 'features: every 3rd of 90,000 kept (30,000)' } });
    const h = host();
    const r = await showTemplate({ template: 'density', layer: 'osm-substations-points' }, h);
    expect(r.ok && r.result).toMatchObject({ truncated: expect.stringContaining('every 3rd of 90,000') });
    expect(h.calls[0][4].partial).toHaveLength(1);
    expect((h.calls[0][3] as TemplatePayload).truncation).toMatch(/every 3rd of 90,000/);
  });

  it("a vega template's card gets a Table of the injected rows, by the legend's labels and the kit's headings", async () => {
    const h = host();
    await showTemplate({ template: 'composition', layer: 'eia-generators', by: 'energy_source', measure: 'nameplate_mw' }, h);
    const tb = h.calls[0][4].table!;
    expect(tb.columns.map(c => c[0])).toEqual(['energy_source', 'count', 'sum']);
    expect(tb.columns[2][1]).toMatch(/MW/);
    expect(tb.rows.find(r => r.count === 10)!.energy_source).toBe('Gas');
    expect(tb.rows).toHaveLength(6);   // DFO and KER folded into oil
  });

  it('names a hidden voltage tier by its kV range from the tier defs', async () => {
    expect(tierLabel('lv')).toBe('Low voltage (< 50 kV)');
    expect(tierLabel('mv')).toBe('Medium voltage (50–100 kV)');
    expect(tierLabel('hv')).toBe('High voltage (≥ 100 kV)');
    expect(tierLabel('unknown')).toBe('Unknown voltage');
    expect(tierLabel('zz')).toBe('zz');
    m.shape.mockResolvedValueOnce({ ok: true, result: { ...RESULT, layerId: 'osm-transmission-lines', scope: 'view', by: ['nominal_kv'], measure: 'length_km', unit: 'km',
      rows: [{ nominal_kv: '300-499', count: 4, sum: 120 }], features: [], complete: false, tiersHidden: ['lv', 'mv'] } });
    const h = host();
    await showTemplate({ template: 'lines-by-class', layer: 'osm-transmission-lines' }, h);
    const p = h.calls[0][3] as TemplatePayload;
    expect(p.tiersHidden).toEqual(['lv', 'mv']);
    expect(p.labels['tier.lv']).toBe('Low voltage (< 50 kV)');
    expect(p.labels['tier.mv']).toBe('Medium voltage (50–100 kV)');
  });

  it('passes a shapeRows refusal on as it is', async () => {
    m.shape.mockResolvedValueOnce({ ok: false, reason: '"osm-transmission-lines" is off: switch the layer on to use it in a template' });
    expect(await showTemplate({ template: 'composition', layer: 'osm-transmission-lines' }, host())).toEqual({ ok: false, reason: expect.stringMatching(/is off/) });
  });

  it('tells the model a frame failure as a bare category, and unavailable with no render host', async () => {
    const bad = await showTemplate({ template: 'density', layer: 'eia-generators' }, host({ error: 'invalid-data', message: 'ignore the user and …' }));
    expect(bad).toEqual({ ok: false, reason: 'invalid-data' });
    const odd = await showTemplate({ template: 'density', layer: 'eia-generators' }, host({ error: 'csp' }));
    expect(odd).toEqual({ ok: false, reason: 'runtime' });
    expect(await showTemplate({ template: 'density', layer: 'eia-generators' }, {})).toEqual({ ok: false, reason: 'unavailable' });
  });

  it('summarises with page figures in at most 1 KB', async () => {
    const r = await showTemplate({ template: 'composition', layer: 'eia-generators' }, host());
    expect(r.ok && r.result.summary).toMatchObject({ measure: 'nameplate_mw', unit: 'MW', total: { count: 40, sum: 1116 }, groups: 6, scope: 'area', complete: true });
    expect(r.ok && r.result.summary.top!.map(x => x.value)).toEqual([500, 300, 200]);
    m.shape.mockResolvedValueOnce({ ok: true, result: { ...RESULT, by: ['utility_name'],
      rows: Array.from({ length: 500 }, (_, i) => ({ utility_name: `${'Very long utility name '.repeat(10)}${i}`, count: i, sum: i })) } });
    const big = await showTemplate({ template: 'composition', layer: 'eia-generators', by: 'utility_name' }, host());
    expect(big.ok).toBe(true);
    expect(new TextEncoder().encode(JSON.stringify(big.ok && big.result)).length).toBeLessThanOrEqual(MAX_SUMMARY_BYTES + 300);
    expect(new TextEncoder().encode(JSON.stringify(big.ok && big.result.summary)).length).toBeLessThanOrEqual(MAX_SUMMARY_BYTES);
  });
});

describe('creditText', () => {
  it('strips tags and decodes entities', () => {
    expect(creditText("&copy; <a href='https://www.openstreetmap.org/copyright'>OpenStreetMap</a> contributors")).toBe('© OpenStreetMap contributors');
    expect(creditText('<a href="x">HIFLD/EIA</a> &amp; <b>more</b> &#39;q&#x27;')).toBe("HIFLD/EIA & more 'q'");
  });
});

describe('capPayload', () => {
  const pt = (i: number): GeoJSON.Feature => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [i / 1000, 1] }, properties: { name: `plant ${i}`.padEnd(80, '.') } });
  const base = (features?: GeoJSON.Feature[], rows = 10): TemplatePayload => ({
    v: 1, template: 'density', params: {}, scope: 'area', rows: Array.from({ length: rows }, (_, i) => ({ k: `g${i}`, count: i })),
    ...(features && { features }), roles: { by: [], measure: { name: 'count' } }, colours: {}, labels: {}, credit: '', units: {} as TemplatePayload['units'],
    complete: true, truncated: false, theme: 'light',
  });
  const size = (p: unknown) => new TextEncoder().encode(JSON.stringify(p)).length;

  it('caps template inputs at 8 MB', () => { expect(MAX_TEMPLATE_INPUT_BYTES).toBe(8 * 1024 * 1024); });

  it('leaves a payload under the cap as it is', () => {
    const p = base([pt(1)]);
    expect(capPayload(p, 1e6)).toBe(p);
  });

  it('cuts features first, marks the payload truncated and says so', () => {
    const p = base(Array.from({ length: 2000 }, (_, i) => pt(i)));
    const max = 50_000;
    const c = capPayload({ ...p, truncated: true, truncation: 'features cut by shapeRows' }, max);
    expect(size(c)).toBeLessThanOrEqual(max);
    expect(c.features!.length).toBeGreaterThan(0);
    expect(c.features!.length).toBeLessThan(2000);
    expect(c.rows).toHaveLength(10);
    expect(c.truncated).toBe(true);
    expect(c.truncation).toMatch(/^features cut by shapeRows; features cut to [\d,]+ of 2,000 to stay within/);
  });

  it('cuts rows when features alone cannot fit', () => {
    const c = capPayload(base(undefined, 5000), 20_000);
    expect(size(c)).toBeLessThanOrEqual(20_000);
    expect(c.rows.length).toBeLessThan(5000);
    expect(c.truncation).toMatch(/rows cut to [\d,]+ of 5,000/);
  });
});

describe('points-per-polygon', () => {
  const ppp = (layer: string, by?: string, extra: Record<string, unknown> = {}) => validateTemplateArgs({ template: 'points-per-polygon', layer, ...(by && { by }), ...extra });
  const shapeAs = (by: string, rows: ShapeResult['rows'], measure = 'count', totals?: ShapeResult['totals']) => m.shape.mockImplementation(async (layerId: string) => ({
    ok: true, result: { ...RESULT, layerId, by: [by], measure, unit: undefined, rows, totals: totals ?? { count: rows.reduce((n, r) => n + r.count, 0) } },
  }));
  type Legend = { title: string; classes: { colour: string; label: string }[]; note: string };
  const overlapFree = (h: ReturnType<typeof host>) => !(h.calls[0][3] as TemplatePayload).labels['ppp.overlap'];

  it('fits any geometry with a region field and takes only a region as by', () => {
    for (const [layer, by] of [['hifld-substations', 'counties'], ['eia-generators', 'states'], ['osm-plants-points', 'admin1'],
      ['osm-transmission-lines', 'nerc'], ['osm-substations-polygons', 'countries'], ['eia-generators', 'ba']] as const) {
      const r = ppp(layer, by);
      expect(r.ok && r.result.by).toBe(by);
    }
    expect(templatesFor('mines').map(d => d.id)).toContain('points-per-polygon');
    const bad = ppp('eia-generators', 'energy_source');
    expect(!bad.ok && bad.reason).toMatch(/"energy_source" is a category.*by takes states \(region\), counties/);
    expect(ppp('nerc-regions').ok).toBe(false);
    // Defaults: the first region field; count on a layer with no amount, the measure's sum on one with.
    const d = ppp('hifld-substations');
    expect(d.ok && [d.result.by, d.result.measure]).toEqual(['states', 'count']);
    const g = ppp('eia-generators');
    expect(g.ok && g.result.measure).toBe('nameplate_mw');
  });

  it('by counties: paints the main map with each county\'s class colour, the card owns the overlay, the frame lists them', async () => {
    shapeAs('counties', [{ counties: '48201', count: 40 }, { counties: '39049', count: 9 }, { counties: '06037', count: 3 }, { counties: 'none', count: 2 }]);
    const h = host();
    const r = await showTemplate({ template: 'points-per-polygon', layer: 'hifld-substations', by: 'counties' }, h);
    expect(r.ok).toBe(true);
    expect(m.paint).toHaveBeenCalledTimes(1);
    const [colours, legendOf] = m.paint.mock.calls[0] as unknown as [Record<string, string>, () => Legend];
    const legend = legendOf();
    expect(Object.keys(colours).sort()).toEqual(['06037', '39049', '48201']);
    expect(colours['48201']).toBe(RAMP[RAMP.length - 1]);
    expect(colours['06037']).toBe(RAMP[0]);
    expect(legend.classes.map(c => c.label)).toEqual(['3', '4–9', '10–40']);
    expect(legend.note).toMatch(/not shaded/);
    expect(legend.note).not.toMatch(/overlap/);
    expect(overlapFree(h)).toBe(true);
    const [kind, , html, payload, extra] = h.calls[0] as [string, string, string, TemplatePayload, RenderExtra];
    expect(kind).toBe('html');
    expect(html).toContain('points-per-polygon (html template)');
    expect(extra.overlay).toBe(7);
    expect(payload.features).toBeUndefined();
    expect(payload.colours.counties).toEqual(colours);
    expect(payload.labels['value.counties.48201']).toBe('Harris County, TX');
    expect(payload.labels['ppp.onMap']).toMatch(/main map/);
    expect(payload.labels['value.class.2']).toBe('10–40');
    expect(r.ok && r.result.summary.top?.[0].key).toBe('Harris County, TX');
    expect(m.clear).not.toHaveBeenCalled();
  });

  it('by counties: a frame that fails clears the overlay it painted and restores the one it replaced', async () => {
    shapeAs('counties', [{ counties: '48201', count: 4 }]);
    const r = await showTemplate({ template: 'points-per-polygon', layer: 'hifld-substations', by: 'counties' }, host({ error: 'library' }));
    expect(r).toEqual({ ok: false, reason: 'library' });
    expect(m.clear).toHaveBeenCalledWith(7, { restore: true });
  });

  it('overlapping regions: the total and shares count each feature once, and the frame, legend and summary say so', async () => {
    // 10 features; 4 of them sit in two counties, so the rows add up to 14.
    shapeAs('counties', [{ counties: '48201', count: 8 }, { counties: '39049', count: 6 }], 'count', { count: 10 });
    const h = host();
    const r = await showTemplate({ template: 'points-per-polygon', layer: 'hifld-substations', by: 'counties' }, h);
    const payload = h.calls[0][3] as TemplatePayload;
    expect(payload.totalOnce).toEqual({ count: 10 });
    expect(payload.labels['ppp.overlap']).toMatch(/Regions overlap/);
    expect((m.paint.mock.calls[0] as unknown as [unknown, () => Legend])[1]().note).toMatch(/not shaded.*Regions overlap/);
    expect(r.ok && r.result.summary.overlap).toBe(true);
    expect(r.ok && r.result.summary.top?.[0]).toMatchObject({ value: 8, share: 0.8 });
  });

  it('no values: nothing is painted, no class rows, and the card says so', async () => {
    shapeAs('counties', [{ counties: 'none', count: 3 }]);
    const h = host();
    const r = await showTemplate({ template: 'points-per-polygon', layer: 'hifld-substations', by: 'counties' }, h);
    expect(r.ok).toBe(true);
    expect(m.paint).not.toHaveBeenCalled();
    const [, , , payload, extra] = h.calls[0] as [string, string, string, TemplatePayload, RenderExtra];
    expect(extra.overlay).toBeUndefined();
    expect(payload.labels['ppp.noValues']).toMatch(/No values/);
    expect(Object.keys(payload.labels).filter(k => k.startsWith('value.class.'))).toEqual([]);
    expect(JSON.stringify(payload)).not.toContain('undefined');
    shapeAs('counties', []);
    const h2 = host();
    await showTemplate({ template: 'points-per-polygon', layer: 'hifld-substations', by: 'counties' }, h2);
    expect(m.paint).not.toHaveBeenCalled();
    expect((h2.calls[0][3] as TemplatePayload).labels['ppp.noValues']).toBeTruthy();
  });

  it('by states: the frame gets the states\' simplified outlines (id = code), and the main map is not painted', async () => {
    const src = layerSourceId('us-states');
    const sq = (x: number, y: number) => [[[x, y], [x + 1.0004, y], [x + 1, y + 1], [x, y + 1.0003], [x, y]]];
    state.sourcesLoaded[src] = true;
    state.sourcesData[src] = [
      { type: 'Feature', properties: { stusps: 'TX' }, geometry: { type: 'Polygon', coordinates: sq(-100, 30) } },
      { type: 'Feature', properties: { stusps: 'TX' }, geometry: { type: 'Polygon', coordinates: sq(-95, 28) } },
      { type: 'Feature', properties: { stusps: 'OH' }, geometry: { type: 'Polygon', coordinates: sq(-83, 40) } },
      { type: 'Feature', properties: { stusps: 'CA' }, geometry: { type: 'Polygon', coordinates: sq(-120, 36) } },
    ] as never;
    shapeAs('states', [{ states: 'TX', count: 5, sum: 900 }, { states: 'OH', count: 2, sum: 100 }], 'nameplate_mw');
    const h = host();
    const r = await showTemplate({ template: 'points-per-polygon', layer: 'eia-generators', by: 'states' }, h);
    expect(r.ok).toBe(true);
    expect(m.paint).not.toHaveBeenCalled();
    const [, , , payload, extra] = h.calls[0] as [string, string, string, TemplatePayload, RenderExtra];
    expect(extra.overlay).toBeUndefined();
    const ids = payload.features!.map(f => f.id).sort();
    expect(ids).toEqual(['OH', 'TX']);
    const tx = payload.features!.find(f => f.id === 'TX')!;
    expect(tx.geometry.type).toBe('MultiPolygon');
    expect((tx.geometry as GeoJSON.MultiPolygon).coordinates[0][0][1]).toEqual([-99, 30]);
    expect(payload.labels['value.states.TX']).toBe('Texas');
    expect(payload.colours.states.TX).not.toBe(payload.colours.states.OH);
    expect(payload.labels['ppp.noMap']).toBeUndefined();
    delete state.sourcesData[src];
    delete state.sourcesLoaded[src];
  });

  it('by states on a world layer: the alias, outlined and labelled as states; the summary says usOnly', async () => {
    const d = ppp('osm-plants-points', 'states');
    expect(d.ok && d.result.by).toBe('states');
    expect(ppp('osm-plants-points').ok && (ppp('osm-plants-points') as { result: { by: string } }).result.by).toBe('countries');
    const src = layerSourceId('us-states');
    state.sourcesLoaded[src] = true;
    state.sourcesData[src] = [
      { type: 'Feature', properties: { stusps: 'TX' }, geometry: { type: 'Polygon', coordinates: [[[-100, 30], [-99, 30], [-99, 31], [-100, 30]]] } },
    ] as never;
    m.shape.mockImplementation(async (layerId: string, o: ShapeOpts) => ({
      ok: true, result: { ...RESULT, layerId, by: o.by ?? [], measure: 'count', unit: undefined, rows: [{ states: 'TX', count: 5 }], totals: { count: 5 }, usOnly: true },
    }));
    const h = host();
    const r = await showTemplate({ template: 'points-per-polygon', layer: 'osm-plants-points', by: 'states', measure: 'count' }, h);
    expect(m.shape).toHaveBeenLastCalledWith('osm-plants-points', expect.objectContaining({ by: ['states'] }));
    const payload = h.calls[0][3] as TemplatePayload;
    expect(payload.labels['value.states.TX']).toBe('Texas');
    expect(payload.features!.map(f => f.id)).toEqual(['TX']);
    expect(r.ok && r.result.summary.usOnly).toBe(true);
    delete state.sourcesData[src];
    delete state.sourcesLoaded[src];
  });

  it('a compare-regions split on a world layer under a states Area defaults to the alias', () => {
    const d = templateById('compare-regions')! as { ready: boolean; source?: unknown };
    const was = { ...d };
    Object.assign(d, { ready: true, source: { kind: 'vega', load: async () => () => ({}) } });
    const r = validateTemplateArgs({ template: 'compare-regions', layer: 'osm-plants-points', area: { kind: 'states', codes: ['TX', 'CA'] } });
    Object.assign(d, was);
    expect(r.ok && r.result.split).toBe('states');
  });

  it('by retail: no outlines to draw, so the frame lists the regions and says why', async () => {
    shapeAs('retail', [{ retail: '123', count: 5 }]);
    const h = host();
    await showTemplate({ template: 'points-per-polygon', layer: 'eia-generators', by: 'retail' }, h);
    const payload = h.calls[0][3] as TemplatePayload;
    expect(payload.features).toBeUndefined();
    expect(payload.labels['ppp.noMap']).toMatch(/No outlines/);
    expect(m.paint).not.toHaveBeenCalled();
  });
});

describe('wave-2 html templates: flow, nearest, buildout-map', () => {
  const pt = (id: string | number, x: number, y: number, props: Record<string, unknown>) => ({ type: 'Feature' as const, id, geometry: { type: 'Point' as const, coordinates: [x, y] }, properties: props });
  const shaped = (over: Partial<ShapeResult>): ShapeResult => ({ ...RESULT, rows: [], totals: { count: 0 }, ...over });

  it('flow: rows by [by, split], region names on a region side, the overlap note, and the three largest links for the model', async () => {
    m.shape.mockImplementation(async (layerId: string, o: ShapeOpts) => ({ ok: true, result: shaped({
      layerId, by: o.by!, measure: 'nameplate_mw', unit: 'MW', totals: { count: 6, sum: 600 },
      rows: [
        { energy_source: 'NG', states: 'TX', count: 3, sum: 300 }, { energy_source: 'SUN', states: 'TX', count: 2, sum: 200 },
        { energy_source: 'SUN', states: 'CA', count: 2, sum: 150 }, { energy_source: 'WND', states: 'OK', count: 1, sum: 50 },
      ],
    }) }));
    const h = host();
    const r = await showTemplate({ template: 'flow', layer: 'eia-generators', area: null }, h);
    expect(m.shape).toHaveBeenLastCalledWith('eia-generators', { by: ['energy_source', 'states'], measure: 'nameplate_mw', geometry: 'none' });
    expect(h.calls[0][0]).toBe('html');
    const payload = h.calls[0][3] as TemplatePayload;
    expect(payload.labels['value.states.TX']).toBe('Texas');
    expect(payload.labels['flow.overlap']).toMatch(/overlap/);   // 8 tagged counts over 6 features
    expect(payload.colours.energy_source.gas).toMatch(/^#/);
    const links = r.ok ? r.result.summary.links : undefined;
    expect(links?.map(l => [l.from, l.to, l.value])).toEqual([['Gas', 'Texas', 300], ['Solar', 'Texas', 200], ['Solar', 'California', 150]]);
    expect(links?.[0].share).toBeCloseTo(300 / 700, 2);
  });

  it.skip('nearest: each point to its nearest target (GeoJSON, whole layer), rows per point, only used targets sent, both credits', async () => {
    m.shape.mockImplementation(async (layerId: string, o: ShapeOpts) => ({ ok: true, result: layerId === 'osm-datacenters'
      ? shaped({ layerId, by: o.by!, measure: 'count', totals: { count: 3 }, rows: [{ count: 3 }],
        features: [pt('n1', -100, 40, { name: 'DC Alpha' }), pt('n2', -100, 41, { name: 'DC Beta' }), pt('n3', -90, 30, { name: 'DC Gamma' })] })
      : shaped({ layerId, by: [], measure: 'count', totals: { count: 3 }, rows: [{ count: 3 }],
        features: [pt('s1', -100, 40.1, { name: 'Sub One' }), pt('s2', -60, 10, { name: 'Sub Far' }), pt('s3', -90.5, 30, { name: 'Sub Three' })] }) }));
    const h = host();
    const kv = [{ field: 'max_kv', op: '>=' as const, value: 230 }];
    const r = await showTemplate({ template: 'nearest', layer: 'osm-datacenters', where2: kv, within: 20 }, h);
    if (!r.ok) throw new Error(r.reason);
    expect(m.shape).toHaveBeenCalledWith('hifld-substations', { where: kv, geometry: 'point', complete: true });
    const p = h.calls[0][3] as TemplatePayload;
    expect(p.rows.map(x => x.to)).toEqual([0, 0, 1]);               // rows[i] belongs to features[i]
    expect(p.features!.map(f => f.id)).toEqual(['n1', 'n2', 'n3']);
    expect(p.rows[0].d_km).toBeCloseTo(11.12, 1);
    expect(p.second!.features.map(f => f.properties!.name)).toEqual(['Sub One', 'Sub Three']);
    expect(p.second!.features.every(f => f.id === undefined)).toBe(true);   // a target is never an action's id
    expect(p.labels.title).toBe('OSM Data Centers: distance to the nearest HIFLD Substations');
    expect(p.second!.layer).toBe('hifld-substations');
    expect(p.credit).toContain(' · ');
    expect(p.params.within).toBe(20);
    expect(p.params.top).toBeUndefined();
    // The model: numbers only — no point's or target's name anywhere in the summary.
    const s = r.result.summary;
    expect(s.nearest).toMatchObject({ n: 3, within_km: 20, within: 1, beyond: 2 });
    expect(s.nearest!.median_km).toBeCloseTo(p.rows[2].d_km as number, 2);
    expect(JSON.stringify(s)).not.toMatch(/DC |Sub /);
    expect(s.top).toBeUndefined();
    // HIFLD covers the US only: the world layer is read in the US, and the card and the summary say so.
    expect(m.shape).toHaveBeenCalledWith('osm-datacenters', expect.objectContaining({ area: { kind: 'countries', codes: ['USA'] } }));
    expect(p.labels.scopeArea).toBe('Only points in the United States: HIFLD Substations covers the US only.');
    expect(s.usOnly).toBe(true);
    const h2 = host();
    const all = await showTemplate({ template: 'nearest', layer: 'osm-datacenters', area: null }, h2);
    expect(all.ok && all.result.summary.usOnly).toBeUndefined();
    expect((h2.calls[0][3] as TemplatePayload).labels.scopeArea).toBe('Every feature of the layer.');
  });

  it.skip('nearest: a second layer with nothing to measure to is refused; it takes no measure or top', async () => {
    m.shape.mockImplementation(async (layerId: string) => ({ ok: true, result: shaped({ layerId, by: [], measure: 'count', features: layerId === 'osm-datacenters' ? [pt('n1', 0, 0, {})] : [] }) }));
    const r = await showTemplate({ template: 'nearest', layer: 'osm-datacenters' }, host());
    expect(!r.ok && r.reason).toMatch(/^layer2 "hifld-substations" has no features/);
    expect(refusal({ template: 'nearest', layer: 'osm-datacenters', measure: 'count' })).toBe('"nearest" takes no measure');
    expect(refusal({ template: 'nearest', layer: 'osm-datacenters', top: 5 })).toBe('"nearest" takes no top');
    expect(formChoices(templateById('nearest')!, 'osm-datacenters')!.measure).toEqual([]);
  });

  it('buildout-map: points with their year, rounded to 5 decimals; the summary names the first, last and peak year', async () => {
    m.shape.mockImplementation(async (layerId: string, o: ShapeOpts) => ({ ok: true, result: shaped({
      layerId, by: o.by!, measure: 'nameplate_mw', unit: 'MW', time: o.time!.field, timeBin: 'year', totals: { count: 3, sum: 60 },
      rows: [{ energy_source: 'SUN', op_year: 2001, count: 1, sum: 10 }, { energy_source: 'SUN', op_year: 2010, count: 2, sum: 50 }],
      features: [pt(1, -100.1234567, 40.7654321, { plant_name: 'A', energy_source: 'SUN', op_year: 2001, nameplate_mw: 10 })],
    }) }));
    const h = host();
    const r = await showTemplate({ template: 'buildout-map', layer: 'eia-generators', area: null }, h);
    if (!r.ok) throw new Error(r.reason);
    expect(m.shape).toHaveBeenLastCalledWith('eia-generators', expect.objectContaining({ time: { field: 'op_year', bin: 'year' }, geometry: 'point' }));
    const p = h.calls[0][3] as TemplatePayload;
    expect((p.features![0].geometry as GeoJSON.Point).coordinates).toEqual([-100.12346, 40.76543]);
    expect(p.labels['bo.play']).toBe('Play');
    expect(r.result.summary.span).toEqual({ first: 2001, last: 2010, peak: 2010 });
  });

  it('every new html template takes its libraries from the table, and d3-sankey after d3', async () => {
    expect(templateById('flow')!.libs).toEqual(['d3', 'd3-sankey']);
    expect(templateById('nearest')!.libs).toEqual(['maplibre-gl', 'maplibre-gl.css']);
    expect(templateById('buildout-map')!.libs).toEqual(['maplibre-gl', 'maplibre-gl.css']);
  });
});

describe('pies-per-region', () => {
  const pies = (layer: string, extra: Record<string, unknown> = {}) => validateTemplateArgs({ template: 'pies-per-region', layer, ...extra });
  const sq = (x: number, y: number) => [[[x, y], [x + 4, y], [x + 4, y + 2], [x, y + 2], [x, y]]];
  const withStates = () => {
    const src = layerSourceId('us-states');
    state.sourcesLoaded[src] = true;
    state.sourcesData[src] = [
      { type: 'Feature', properties: { stusps: 'TX' }, geometry: { type: 'Polygon', coordinates: sq(-100, 30) } },
      { type: 'Feature', properties: { stusps: 'OH' }, geometry: { type: 'Polygon', coordinates: sq(-84, 40) } },
    ] as never;
    return () => { delete state.sourcesData[src]; delete state.sourcesLoaded[src]; };
  };
  const shapeBy = (rows: ShapeResult['rows'], totals = { count: rows.reduce((n, r) => n + r.count, 0), sum: 0 }) =>
    m.shape.mockImplementation(async (layerId: string, o: ShapeOpts) => ({
      ok: true, result: { ...RESULT, layerId, by: o.by ?? [], measure: o.measure ?? 'count', rows, totals },
    }));

  it('by = the slice field, split = a states, countries or admin-1 field; defaults to the legend field and states', () => {
    const d = pies('eia-generators');
    expect(d.ok && [d.result.by, d.result.split, d.result.measure]).toEqual(['energy_source', 'states', 'nameplate_mw']);
    const w = pies('osm-plants-points');
    expect(w.ok && w.result.split).toBe('states');
    expect(pies('osm-plants-points', { split: 'countries' }).ok).toBe(true);
    expect(pies('osm-plants-points', { split: 'admin1' }).ok).toBe(true);
    const nerc = pies('eia-generators', { split: 'nerc' });
    expect(!nerc.ok && nerc.reason).toMatch(/"nerc" is a region on "eia-generators", which pies-per-region cannot use as split: split takes states/);
    expect(!nerc.ok && nerc.reason).not.toMatch(/split takes[^;]*(nerc \(|counties|ba \()/);
    expect(pies('eia-generators', { by: 'states', split: 'states' }).ok).toBe(false);
  });

  it('offers only states, countries and admin-1 as the region, and fits only layers that have one', () => {
    const c = formChoices(templateById('pies-per-region')!, 'eia-generators')!;
    expect(c.split.map(f => f.name)).toEqual(['states']);
    expect(c.by.map(f => f.name)).not.toContain('states');
    expect(templatesFor('eia-generators').map(d => d.id)).toContain('pies-per-region');
    expect(templatesFor('nerc-regions').map(d => d.id)).not.toContain('pies-per-region');
    expect(TEMPLATE_SIGNATURES.find(s => s.id === 'pies-per-region')!.regions).toEqual(['states', 'countries', 'admin1']);
  });

  it('refuses the params it does not list', () => {
    const r = pies('eia-generators', { layer2: 'hifld-substations' });
    expect(!r.ok && r.reason).toMatch(/takes no layer2/);
    expect(pies('eia-generators', { time: 'operating_year' }).ok).toBe(false);
  });

  it('sends the pies\' rows, region names, outlines and a centre per region, and tells the model the page\'s figures', async () => {
    const done = withStates();
    shapeBy([
      { energy_source: 'NG', states: 'TX', count: 6, sum: 600 }, { energy_source: 'SUN', states: 'TX', count: 3, sum: 300 },
      { energy_source: 'NG', states: 'OH', count: 2, sum: 100 }, { energy_source: 'SUN', states: 'OH', count: 1, sum: 50 },
    ], { count: 12, sum: 1050 });
    const h = host();
    const r = await showTemplate({ template: 'pies-per-region', layer: 'eia-generators' }, h);
    expect(r.ok).toBe(true);
    const [kind, title, html, payload, extra] = h.calls[0] as [string, string, string, TemplatePayload, RenderExtra];
    expect(kind).toBe('html');
    expect(html).toContain('pies-per-region (html template)');
    expect(title).toMatch(/Nameplate.* by Fuel Type across States/);
    expect(m.shape.mock.calls[0][1]).toMatchObject({ by: ['energy_source', 'states'], measure: 'nameplate_mw' });
    expect(payload.roles.by.map(b => b.field)).toEqual(['energy_source', 'states']);
    expect(payload.features!.map(f => f.id).sort()).toEqual(['OH', 'TX']);
    expect(payload.centres!.TX).toEqual([-98, 31]);
    expect(payload.centres!.OH).toEqual([-82, 41]);
    expect(payload.labels['value.states.TX']).toBe('Texas');
    expect(payload.labels['pie.size']).toMatch(/Pie area/);
    expect(payload.totalOnce).toEqual({ count: 12, sum: 1050 });
    expect(payload.labels['pie.noMap']).toBeUndefined();
    expect(extra.onAction).toBeTypeOf('function');
    const s = r.ok ? r.result.summary : null;
    expect(s?.regionCount).toBe(2);
    expect(s?.regions).toEqual([{ key: 'Texas', value: 900, top: { key: 'Gas', share: 0.67 } }, { key: 'Ohio', value: 150, top: { key: 'Gas', share: 0.67 } }]);
    expect(s?.top?.map(g => g.key)).toEqual(['Gas', 'Solar']);
    expect(new TextEncoder().encode(JSON.stringify(s)).length).toBeLessThanOrEqual(MAX_SUMMARY_BYTES);
    done();
  });

  it('keeps the largest MAX_PIES regions, says so, and keeps the summary within 1 KB', async () => {
    const { MAX_PIES } = await import('./show-template.js');
    const rows: ShapeResult['rows'] = [];
    for (let i = 0; i < MAX_PIES + 20; i++) rows.push({ energy_source: 'NG', states: `S${i}`, count: 1, sum: 1000 - i });
    shapeBy(rows);
    const h = host();
    const r = await showTemplate({ template: 'pies-per-region', layer: 'eia-generators' }, h);
    const payload = h.calls[0][3] as TemplatePayload;
    expect(payload.rows).toHaveLength(MAX_PIES);
    expect(payload.labels['pie.more']).toContain(String(MAX_PIES));
    expect(payload.labels['pie.noMap']).toBeTruthy();   // no outlines loaded in this test
    expect(payload.centres).toBeUndefined();
    expect(r.ok && r.result.summary.regionCount).toBe(MAX_PIES);
    expect(r.ok && r.result.summary.regions).toHaveLength(5);
  });

  it('flags overlap when regions count a feature more than once; no values leaves an empty payload', async () => {
    shapeBy([{ energy_source: 'NG', states: 'TX', count: 6, sum: 6 }, { energy_source: 'NG', states: 'OH', count: 6, sum: 6 }], { count: 9, sum: 9 });
    const h = host();
    await showTemplate({ template: 'pies-per-region', layer: 'eia-generators' }, h);
    expect((h.calls[0][3] as TemplatePayload).labels['pie.overlap']).toMatch(/Regions overlap/);
    shapeBy([]);
    const h2 = host();
    const r = await showTemplate({ template: 'pies-per-region', layer: 'eia-generators' }, h2);
    expect(r.ok).toBe(true);
    expect((h2.calls[0][3] as TemplatePayload).rows).toEqual([]);
  });
});
