// The local command parser over the real registry titles (English) and the
// real area labels: each phrase → the one tool call it names, an ambiguous name
// → its options (each with its call), and anything else → no match, so the
// model answers. Every call it returns passes tools.ts's own argument check.
import { describe, it, expect, beforeAll, vi } from 'vitest';

vi.mock('../map-api.js', () => ({ BASEMAPS: ['light', 'dark', 'street', 'topo', 'aerial', 'hydro'] }));

import { parseLocal, localContext, type LocalContext, type LocalCall } from './local-commands.js';
import { toolSchemas, checkArgs, type Schema } from './tools.js';
import { validateTemplateArgs } from '../templates/show-template.js';

let ctx: LocalContext;
beforeAll(async () => { ctx = await localContext(); });

const on = (layerId: string, v = true): LocalCall => ({ tool: 'setLayerVisible', args: { layerId, on: v } });
const area = (kind: string, code: string): LocalCall => ({ tool: 'setArea', args: { area: { kind, codes: [code] } } });

const CALLS: [string, LocalCall][] = [
  ['undo', { tool: 'undo', args: {} }],
  ['Undo.', { tool: 'undo', args: {} }],
  ['go back', { tool: 'undo', args: {} }],
  ['redo', { tool: 'redo', args: {} }],
  ['reset', { tool: 'reset', args: {} }],
  ['Reset the map!', { tool: 'reset', args: {} }],
  ['turn on railroads', on('railroads')],
  ['Turn off the railroads layer', on('railroads', false)],
  ['switch radar on', on('nexrad-radar')],
  ['please hide eia plants', on('eia-generators', false)],
  ['show eia-generators', on('eia-generators')],
  ['turn on census counties', on('us-counties')],
  ['show power outages', on('odin-outages')],
  ['show only Texas', area('states', 'TX')],
  ['only show Germany', area('countries', 'DEU')],
  ['filter to tx', area('states', 'TX')],
  ['clear the area', { tool: 'setArea', args: { area: null } }],
  ['fly to Denver', { tool: 'fitTo', args: { place: 'denver' } }],
  ['zoom to Houston, TX', { tool: 'fitTo', args: { place: 'houston, tx' } }],
  ['center on Lake Tahoe', { tool: 'fitTo', args: { place: 'lake tahoe' } }],
  ['dark basemap', { tool: 'setBasemap', args: { basemap: 'dark' } }],
  ['switch to satellite basemap', { tool: 'setBasemap', args: { basemap: 'aerial' } }],
  ['basemap topo', { tool: 'setBasemap', args: { basemap: 'topo' } }],
  ['clear selection', { tool: 'setSelection', args: { selection: null } }],
  ['clear all styles', { tool: 'clearStyle', args: {} }],
  ['share link', { tool: 'shareLink', args: {} }],
];

describe('parseLocal: one call', () => {
  it.each(CALLS)('%s', (text, expected) => {
    expect(parseLocal(text, ctx)).toEqual({ kind: 'call', call: expected });
  });

  it('an admin-1 region by name', () => {
    const code = Object.entries(ctx.areas!.admin1).find(([, v]) => Array.isArray(v) && v[0] === 'Bayern')![0];
    expect(parseLocal('show only Bayern', ctx)).toEqual({ kind: 'call', call: area('admin1', code) });
  });

  it('every call passes its tool schema', () => {
    const schemas = new Map(toolSchemas().map(s => [s.function.name, s.function.parameters as Schema]));
    for (const [text, c] of CALLS) {
      expect(schemas.has(c.tool), text).toBe(true);
      expect(checkArgs(c.args, schemas.get(c.tool)!), text).toBeNull();
    }
  });
});

describe('parseLocal: ambiguous', () => {
  it('a layer name several layers carry offers each of them', () => {
    const r = parseLocal('turn on power plants', ctx);
    expect(r.kind).toBe('ambiguous');
    if (r.kind !== 'ambiguous') return;
    expect(r.what).toBe('layer');
    const ids = r.options.map(o => o.call.args.layerId);
    expect(ids).toEqual(expect.arrayContaining(['eia-generators', 'osm-plants-points']));
    expect(r.options.every(o => o.call.tool === 'setLayerVisible' && o.call.args.on === true)).toBe(true);
  });

  it('"turn off pipelines" lists the pipeline layers, all off', () => {
    const r = parseLocal('turn off pipelines', ctx);
    expect(r.kind).toBe('ambiguous');
    if (r.kind !== 'ambiguous') return;
    expect(r.options.map(o => o.call.args.layerId)).toEqual(
      expect.arrayContaining(['hifld-natgas-lines', 'osm-pipelines-lines']));
    expect(r.options.every(o => o.call.args.on === false)).toBe(true);
  });

  it('an area name in several places offers each, with its label', () => {
    const r = parseLocal('show only Harris County', ctx);
    expect(r.kind).toBe('ambiguous');
    if (r.kind !== 'ambiguous') return;
    expect(r.what).toBe('area');
    expect(r.options.map(o => o.label)).toEqual(expect.arrayContaining(['Harris County, TX', 'Harris County, GA']));
  });

  it('"ERCOT" is both a NERC region and a balancing authority', () => {
    const r = parseLocal('limit to ERCOT', ctx);
    expect(r.kind === 'ambiguous' && r.options.map(o => o.call)).toEqual([area('nerc', 'TRE'), area('ba', 'ERCO')]);
  });

  it('caps the options at 8 and says how many more there are', () => {
    const r = parseLocal('turn on osm', ctx);
    expect(r.kind === 'ambiguous' && r.options.length).toBe(8);
    const osm = ctx.layers.filter(l => /osm/i.test(`${l.id} ${l.title}`)).length;
    expect(r.kind === 'ambiguous' && r.more).toBe(osm - 8);
    expect(parseLocal('show only Harris County', ctx)).toMatchObject({ kind: 'ambiguous', more: 0 });
  });

  it('"Georgia" offers the US state, then the country', () => {
    const r = parseLocal('show only Georgia', ctx);
    expect(r.kind === 'ambiguous' && r.options.map(o => o.call)).toEqual([area('states', 'GA'), area('countries', 'GEO')]);
  });

  it('any other exact name is the first kind that has it', () => {
    expect(parseLocal('show only Mexico', ctx)).toEqual({ kind: 'call', call: area('countries', 'MEX') });
    for (const name of ['Texas', 'Florida', 'Montana']) {
      expect(parseLocal(`show only ${name}`, ctx), name).toMatchObject({ kind: 'call', call: { args: { area: { kind: 'states' } } } });
    }
  });
});

describe('parseLocal: no match (the model answers)', () => {
  it.each([
    'how much solar capacity is in Texas?',
    'turn on unicorns',
    'show only Narnia',
    'neon basemap',
    'what is a substation',
    'What kinds of gas facilities are in Louisiana?',
    'how many gas facilities of each type?',  // the vega drive-app scenario's phrase
    'how many gas facilities of each type',
    'which state has the most substations?',
    'which state has the most substations',
    'what is the fuel mix in Texas',
    'where is the most wind capacity',
    'fuel mix in Texas?',                      // a question mark makes it a question
    '',
    'undo the last three things and then reset',
  ])('%s', text => {
    expect(parseLocal(text, ctx)).toEqual({ kind: 'none' });
  });

  it('areas need the label table', () => {
    expect(parseLocal('show only Texas', { ...ctx, areas: null })).toEqual({ kind: 'none' });
  });
});

describe('parseLocal: library services', () => {
  const svc = (libraryId: string): LocalCall => ({ tool: 'addService', args: { libraryId } });

  it.each([
    ['add Section 368 energy corridors', 'section-368-energy-corridors'],
    ['add layer EPA cleanup sites', 'epa-cleanup-sites'],
    ['show National Wetlands Inventory service', 'nwi'],
  ])('%s', (text, id) => {
    const r = parseLocal(text, ctx);
    expect(r.kind).toBe('call');
    if (r.kind !== 'call') return;
    expect(r.call.tool).toBe('addService');
    expect(ctx.services!.find(s => s.id === r.call.args.libraryId)).toBeDefined();
    expect(id).toBeTruthy();
  });

  it('a single match is the library id call, and it passes the tool schema', () => {
    const only = { ...ctx, services: [{ id: 'epa-cleanup-sites', title: 'EPA cleanup sites' }] };
    const r = parseLocal('Add EPA Cleanup Sites', only);
    expect(r).toEqual({ kind: 'call', call: svc('epa-cleanup-sites') });
    const schema = toolSchemas().find(s => s.function.name === 'addService')!.function.parameters as Schema;
    expect(checkArgs((r as { call: LocalCall }).call.args, schema)).toBeNull();
  });

  it('several matches are ambiguous, with the candidates', () => {
    const two = { ...ctx, layers: [], services: [
      { id: 'faa-airspace', title: 'FAA controlled airspace' }, { id: 'faa-uas', title: 'FAA UAS facility map' }] };
    const r = parseLocal('add faa', two);
    expect(r.kind === 'ambiguous' && r.options.map(o => o.call)).toEqual([svc('faa-airspace'), svc('faa-uas')]);
  });

  it('no match falls through, to a layer or to the model', () => {
    expect(parseLocal('add unicorn herds', ctx)).toEqual({ kind: 'none' });
    expect(parseLocal('add railroads', ctx)).toEqual({ kind: 'call', call: on('railroads') });
    expect(parseLocal('add railroads', { ...ctx, services: undefined })).toEqual({ kind: 'call', call: on('railroads') });
  });

  it('never takes a URL', () => {
    expect(parseLocal('add https://example.org/x/FeatureServer', ctx)).toEqual({ kind: 'none' });
  });
});

describe('parseLocal: templates (showTemplate, no model)', () => {
  const tpl = (args: Record<string, unknown>): LocalCall => ({ tool: 'showTemplate', args });
  const TX = { kind: 'states', codes: ['TX'] };

  const CALLS_T: [string, Record<string, unknown>][] = [
    ['Mix of substations by voltage in Texas', { template: 'composition', layer: 'hifld-substations', area: TX, by: 'max_kv' }],
    ['Fuel mix by NERC region', { template: 'compare-regions', layer: 'eia-generators', by: 'energy_source', split: 'nerc' }],
    ['fuel mix by nerc', { template: 'compare-regions', layer: 'eia-generators', by: 'energy_source', split: 'nerc' }],
    ['fuel mix in Texas', { template: 'composition', layer: 'eia-generators', area: TX, by: 'energy_source' }],
    ['capacity by fuel in Texas', { template: 'composition', layer: 'eia-generators', area: TX, by: 'energy_source', measure: 'nameplate_mw' }],
    ['fuel mix of power plants in Germany', { template: 'composition', layer: 'osm-plants-points', area: { kind: 'countries', codes: ['DEU'] }, by: 'source' }],
    ['Kinds of gas facilities in Louisiana', { template: 'composition', layer: 'hifld-natgas-points', area: { kind: 'states', codes: ['LA'] }, by: 'fac_type' }],
    ['chart gas facilities by type', { template: 'composition', layer: 'hifld-natgas-points', by: 'fac_type' }],
    ['Mines by commodity in Nevada', { template: 'composition', layer: 'mines', area: { kind: 'states', codes: ['NV'] }, by: 'commodity' }],
    ['rank substations by state', { template: 'ranking', layer: 'hifld-substations', by: 'states' }],
    ['Top 10 states by number of data centers', { template: 'ranking', layer: 'osm-datacenters', by: 'addr_state', measure: 'count', top: 10 }],
    ['Substations per county in Ohio', { template: 'ranking', layer: 'hifld-substations', area: { kind: 'states', codes: ['OH'] }, by: 'counties' }],
    ['capacity added by year', { template: 'timeline', layer: 'eia-generators', measure: 'nameplate_mw' }],
    ['build-out timeline of solar', { template: 'timeline', layer: 'eia-generators', where: [{ field: 'energy_source', op: 'in', value: ['SUN'] }] }],
    ['retirements by year', { template: 'timeline', layer: 'eia-generators', mode: 'net' }],
    ['retirements by year and fuel', { template: 'timeline', layer: 'eia-generators', by: 'energy_source', mode: 'net' }],
    ['Capacity added per year by fuel in PJM', { template: 'timeline', layer: 'eia-generators', area: { kind: 'ba', codes: ['PJM'] }, by: 'energy_source', measure: 'nameplate_mw' }],
    ['data centers over time', { template: 'timeline', layer: 'osm-datacenters' }],
    ['Pipelines by substance', { template: 'lines-by-class', layer: 'osm-pipelines-lines', by: 'substance' }],
    ['where are the data centers clustered', { template: 'density', layer: 'osm-datacenters' }],
    ['Where are the data centers clustered?', { template: 'density', layer: 'osm-datacenters' }],
    ['Heat map of mines', { template: 'density', layer: 'mines' }],
    ['Hexbin of data centers in Virginia', { template: 'density', layer: 'osm-datacenters', area: { kind: 'states', codes: ['VA'] } }],
    // Density keeps the fuel word's filter.
    ['show me where solar is clustered', { template: 'density', layer: 'eia-generators', where: [{ field: 'energy_source', op: 'in', value: ['SUN'] }] }],
    // Flow names both sides; buildout keeps the fuel and "since"; distribution bins an amount or a level.
    ['Sankey of fuel to balancing authority', { template: 'flow', layer: 'eia-generators', by: 'energy_source', split: 'ba' }],
    ['flow of power plants from sector to NERC region in Texas', { template: 'flow', layer: 'eia-generators', area: TX, by: 'sector_name', split: 'nerc' }],
    ['animate solar plants since 2000', { template: 'buildout-map', layer: 'eia-generators',
      where: [{ field: 'energy_source', op: 'in', value: ['SUN'] }, { field: 'op_year', op: '>=', value: 2000 }] }],
    ['Animate data centers', { template: 'buildout-map', layer: 'osm-datacenters' }],
    ['histogram of data centers by state', { template: 'distribution', layer: 'osm-datacenters', by: 'addr_state' }],
    ['spread of planned line lengths', { template: 'distribution', layer: 'ogf-planned-transmission', measure: 'length_km' }],
  ];

  it.each(CALLS_T)('%s', (text, args) => {
    expect(parseLocal(text, ctx)).toEqual({ kind: 'call', call: tpl(args) });
  });

  const layersOf = (text: string) => {
    const r = parseLocal(text, ctx);
    return r.kind === 'ambiguous' ? r.options.map(o => o.call.args.layer) : null;
  };

  it('a phrase that fits several layers offers each, never a guess', () => {
    expect(layersOf('density of substations')).toEqual(['hifld-substations', 'osm-substations-points', 'osm-substations-polygons']);
    expect(layersOf('heat map of plants')).toEqual(['eia-generators', 'osm-plants-points']);
    expect(layersOf('transmission lines by voltage')).toEqual(['hifld-transmission-lines', 'osm-transmission-lines']);
    expect(layersOf('kV mix of lines in view')).toEqual(['hifld-transmission-lines', 'osm-transmission-lines']);
    expect(layersOf('top 10 owners of transmission lines')).toEqual(['hifld-transmission-lines', 'osm-transmission-lines']);
    expect(layersOf('largest pipeline operators')).toEqual(['hifld-natgas-lines', 'osm-pipelines-lines']);
    expect(layersOf('Pipeline mileage by operator')).toEqual(['hifld-natgas-lines', 'osm-pipelines-lines']);
    expect(layersOf('distribution of substation voltage')).toEqual(['hifld-substations', 'osm-substations-points', 'osm-substations-polygons']);
    const r = parseLocal('histogram of plant capacity by fuel in Texas', ctx);
    expect(r.kind === 'ambiguous' && r.options.map(o => o.call.args)).toEqual([
      { template: 'distribution', layer: 'eia-generators', area: TX, by: 'energy_source', measure: 'nameplate_mw' },
      { template: 'distribution', layer: 'osm-plants-points', area: TX, by: 'source', measure: 'output_mw' }]);
  });

  it('a layer that lacks the field is not an option', () => {
    // OSM substations carry no state tag: "by state" is HIFLD's alone.
    expect(parseLocal('rank substations by state', ctx)).toMatchObject({ kind: 'call' });
    // Only EIA plants carry a retirement year.
    expect(parseLocal('retirements by year', ctx)).toMatchObject({ kind: 'call', call: { args: { layer: 'eia-generators' } } });
  });

  it('an area name in several places offers each area, with the one layer', () => {
    const r = parseLocal('generation mix of ERCOT', ctx);
    expect(r.kind === 'ambiguous' && r.what).toBe('area');
    expect(r.kind === 'ambiguous' && r.options.map(o => o.call.args.area)).toEqual([
      { kind: 'nerc', codes: ['TRE'] }, { kind: 'ba', codes: ['ERCO'] }]);
  });

  it('every call it produces passes validateTemplateArgs and the tool schema', () => {
    const schema = toolSchemas().find(s => s.function.name === 'showTemplate')!.function.parameters as Schema;
    const texts = [...CALLS_T.map(c => c[0]), 'density of substations', 'heat map of plants', 'transmission lines by voltage',
      'kV mix of lines in view', 'top 10 owners of transmission lines', 'largest pipeline operators', 'generation mix of ERCOT',
      'Pipeline mileage by operator', 'Top 10 plant owners by capacity', 'animate solar plants coming online since 2000',
      'distribution of substation voltage', 'histogram of plant capacity by fuel in Texas'];
    for (const text of texts) {
      const r = parseLocal(text, ctx);
      const calls = r.kind === 'call' ? [r.call] : r.kind === 'ambiguous' ? r.options.map(o => o.call) : [];
      expect(calls.length, text).toBeGreaterThan(0);
      for (const c of calls) {
        expect(c.tool, text).toBe('showTemplate');
        expect(checkArgs(c.args, schema), text).toBeNull();
        expect(validateTemplateArgs(c.args), text).toMatchObject({ ok: true });
      }
    }
  });

  it.each([
    'how much solar capacity is in Texas?',   // a question, not a chart
    'what is a substation',
    'show eia plants',                         // a layer, no chart word
    'Transmission miles by owner in Arizona',  // a tiled layer takes no area: the model explains
    'Transmission miles by voltage class in WECC',
    'top 100 owners of transmission lines',    // top is 3 to 30
    'fuel mix in the last decade',             // an "in" that is no area
    'fuel mix in Narnia',
    'fuel mix by NERC region in Texas',        // an area too: the model's call
    'chart gas facilities by NERC region',     // compare-regions needs the layer to fit
    'fuel mix per state',
    'distance from data centers to substations', // nearest is the model's call (second layer, threshold)
    'sankey of power plants',                    // a flow names both sides
    'sankey of fuel to fuel',
    'capacity added by year since 2000',         // a where on a timeline's own year: the model's call
    'animate transmission lines',                // buildout-map draws points
    'Mostrar la mezcla de combustibles en California',
    'Which BAs have the most proposed capacity?',
    'rank railroads by owner',
    // A leading hide / remove / disable / delete / clear / close / stop is never a chart.
    'hide the fuel mix in Texas',
    'remove substations by voltage',
    'disable heat map of mines',
    'delete capacity by fuel in Texas',
    'clear fuel mix',
    'close the data centers over time',
    'stop density of data centers',
  ])('falls through to the model or the layer rules: %s', text => {
    const r = parseLocal(text, ctx);
    expect(r.kind === 'none' || (r.kind === 'call' && r.call.tool !== 'showTemplate')).toBe(true);
  });
});
