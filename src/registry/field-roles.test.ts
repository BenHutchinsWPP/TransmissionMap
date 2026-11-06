// field-roles.ts + template-signatures.ts: every queryable layer has roles a
// template can bind to (geometry, label, a category or region, units on every
// measure), the annotations agree with DISPLAY_FIELDS, FACETS, the registry and
// the tile manifest, and docs/templates-coverage.md is the matrix the code
// computes (UPDATE_TEMPLATES_COVERAGE=1 npm test rewrites it).
import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { LAYERS, layerById } from './index.js';
import { FIELD_SCHEMA, YEAR_IN_TEXT } from './field-schema.js';
import { FIELD_ROLES, rolesOf, type Roles } from './field-roles.js';
import { TEMPLATE_SIGNATURES, fit } from './template-signatures.js';
import { FACETS, facet } from '../colors/facets.js';
import { allowedFields, DISPLAY_FIELDS } from '../../assets/dataset-query.js';

const QUERYABLE = LAYERS.filter(l => l.dataset && Object.hasOwn(FIELD_SCHEMA, l.dataset) && l.data?.id).map(l => l.id);
const ROLES = QUERYABLE.map(id => rolesOf(id)!);

// The tile manifest's `select:` lists, by dataset id.
const SELECT = new Map<string, string[]>();
for (const block of readFileSync('scripts/tile_manifest.yaml', 'utf8').split(/^ {2}- id:/m).slice(1)) {
  const m = block.match(/^ {4}select:\s*\[([^\]]*)\]/m);
  if (m) SELECT.set(block.match(/^\s*(\S+)/)![1], m[1].split(',').map(x => x.trim()));
}

describe('field roles', () => {
  it('cover exactly the queryable layers', () => {
    expect(QUERYABLE.length).toBeGreaterThanOrEqual(20);
    expect(Object.keys(FIELD_ROLES).sort()).toEqual([...QUERYABLE].sort());
    expect(rolesOf('us-states')).toBeNull();
  });

  it('give every queryable layer a geometry, a readable label and a category or region', () => {
    for (const r of ROLES) {
      expect(['point', 'line', 'polygon'], r.layerId).toContain(r.geometry);
      expect(allowedFields(r.layerId), `${r.layerId} label`).toContain(r.label);
      expect(r.fields.some(f => f.role === 'category' || f.role === 'region'), r.layerId).toBe(true);
      expect(r.derived[0]).toBe('count');
      expect(r.derived.includes('length_km')).toBe(r.geometry === 'line');
      expect(r.derived.includes('area_km2')).toBe(r.geometry === 'polygon');
    }
  });

  it('list the fields allowedFields() reads, in its order', () => {
    for (const r of ROLES) expect(r.fields.map(f => f.name), r.layerId).toEqual(allowedFields(r.layerId));
  });

  it('declare a role on every schema field: a unit on each measure, a granularity on each time', () => {
    for (const [ds, fields] of Object.entries(FIELD_SCHEMA)) {
      for (const [name, d] of Object.entries(fields)) {
        const at = `${ds}.${name}`;
        expect(d.role, at).toBeDefined();
        if (d.type === 'number') expect(['measure', 'time'], at).toContain(d.role);
        if (d.role === 'measure') expect(d.unit, `${at} unit`).toBeTruthy();
        if (d.role === 'time') expect(d.time, `${at} time`).toBeDefined();
        if (d.role === 'region') expect(d.list, at).toBe(true);
        if (d.list) expect(d.role, at).toBe('region');
        if (d.unit || d.additive === false) expect(d.role, at).toBe('measure');
      }
    }
  });

  it('annotate every display field that is not a schema field, and nothing else', () => {
    for (const id of QUERYABLE) {
      const schema = FIELD_SCHEMA[layerById(id)!.dataset!];
      const r = FIELD_ROLES[id];
      expect(Object.keys(r.display).sort(), id).toEqual((DISPLAY_FIELDS[id] ?? []).filter(f => !Object.hasOwn(schema, f)).sort());
      for (const [name, role] of Object.entries(r.display)) if (role === 'label') expect(name, `${id} label`).toBe(r.label);
    }
  });

  it('name facets that exist and classify the field they are attached to', () => {
    const attached = (key: string, field: string) => {
      const f = facet(key);
      return f.field === field || !!f.fields?.includes(field);
    };
    for (const r of ROLES) {
      for (const f of [...r.fields, ...r.pending]) {
        if (f.facet) expect(attached(f.facet, f.name), `${r.layerId}.${f.name} → ${f.facet}`).toBe(true);
      }
    }
    for (const [id, roles] of Object.entries(FIELD_ROLES)) {
      for (const name of Object.keys(roles.facets ?? {})) expect(allowedFields(id), `${id}.${name}`).toContain(name);
    }
  });

  it('keep the kv and fuel facets\' fields in step with each layer\'s filterField', () => {
    for (const l of LAYERS) {
      if (l.filterType === 'kv') expect(facet('kv').fields, l.id).toContain(l.filterField);
      if (l.filterType === 'fuel_eia' || l.filterType === 'fuel_osm') expect(facet('fuel').fields, l.id).toContain(l.filterField);
    }
    for (const f of FACETS) expect(!!f.field && !!f.fields, `${f.key} has field and fields`).toBe(false);
  });

  it('list as pending only fields a row cannot read yet, and that the build keeps', () => {
    for (const r of ROLES) {
      const sel = SELECT.get(layerById(r.layerId)!.dataset!);
      for (const p of r.pending) {
        expect(allowedFields(r.layerId), `${r.layerId}.${p.name} is already readable`).not.toContain(p.name);
        if (sel) expect(sel, `${r.layerId}.${p.name} not in select:`).toContain(p.name);
        if (p.role === 'measure') expect(p.unit, `${r.layerId}.${p.name} unit`).toBeTruthy();
      }
    }
  });

  it('read a year out of the start_date forms measured in the OSM data', () => {
    const year = (s: string) => YEAR_IN_TEXT.exec(s)?.[1];
    expect(['2019', '2019-05', '2019-05-01', '05/2019', '01.04.2019', '~2019', 'c. 2019', '2019..2020', '2019;2001', '(2019 to 1987)'].map(year))
      .toEqual(Array(10).fill('2019'));
    expect(['20190109', '工事中', '1373', '3.2'].map(year)).toEqual([undefined, undefined, undefined, undefined]);
  });
});

// ─── Coverage: archetype × layer ─────────────────────────────────────────────
const DOC = 'docs/templates-coverage.md';

function coverage(): string {
  const code = (roles: Roles, i: number): string => {
    const f = fit(TEMPLATE_SIGNATURES[i], roles, ROLES);
    if (f === 'no') return '—';
    if (f === 'pending') return 'R';
    return layerById(roles.layerId)!.data!.kind === 'geojson' ? 'Y' : 'P';
  };
  const grid = ROLES.map(r => TEMPLATE_SIGNATURES.map((_, i) => code(r, i)));
  const family = (id: string) => layerById(id)!.group;
  const lines = [
    '# Template coverage',
    '',
    '<!-- Generated by src/registry/field-roles.test.ts from field-schema.ts, field-roles.ts and',
    '     template-signatures.ts. Do not edit: run `UPDATE_TEMPLATES_COVERAGE=1 npm test`. -->',
    '',
    `Which of the ${TEMPLATE_SIGNATURES.length} template archetypes (\`src/registry/template-signatures.ts\`) each queryable layer can fill, from its field roles.`,
    '',
    '- **Y** fits: a GeoJSON layer, the whole dataset.',
    '- **P** fits, partial: a vector-tile layer, the features in the current view only.',
    '- **R** needs fields: fits once a field the served data already carries becomes readable (`pending` in `field-roles.ts`).',
    '- **—** does not apply: the geometry, or a role no field of the layer has.',
    '',
    `| layer | geometry | ${TEMPLATE_SIGNATURES.map(s => s.id).join(' | ')} |`,
    `|---|---|${TEMPLATE_SIGNATURES.map(() => '---').join('|')}|`,
    ...ROLES.map((r, j) => `| ${r.layerId} | ${r.geometry} | ${grid[j].join(' | ')} |`),
    '',
    '## By archetype',
    '',
    '| archetype | signature | Y | P | R | families that fit |',
    '|---|---|---|---|---|---|',
    ...TEMPLATE_SIGNATURES.map((s, i) => {
      const n = (c: string) => grid.filter(g => g[i] === c).length;
      const fams = [...new Set(ROLES.filter((_, j) => grid[j][i] === 'Y' || grid[j][i] === 'P').map(r => family(r.layerId)))];
      const sig = [s.slots.join(' + ') || '—', s.derived && 'length / area too', s.geometry && `on ${s.geometry.join('/')}`, s.second && `+ ${s.second} layer`]
        .filter(Boolean).join(', ');
      return `| ${s.id} | ${sig} | ${n('Y')} | ${n('P')} | ${n('R')} | ${fams.join(', ') || '—'}${fams.length === 1 ? ' (one family)' : ''} |`;
    }),
    '',
  ];
  return lines.join('\n');
}

describe('templates coverage', () => {
  it(`equals ${DOC} (UPDATE_TEMPLATES_COVERAGE=1 rewrites it)`, () => {
    const text = coverage();
    if (process.env.UPDATE_TEMPLATES_COVERAGE) writeFileSync(DOC, text);
    expect(readFileSync(DOC, 'utf8')).toBe(text);
  });

  it('fits every archetype somewhere today', () => {
    for (const s of TEMPLATE_SIGNATURES) expect(ROLES.some(r => fit(s, r, ROLES) === 'fits'), s.id).toBe(true);
    expect(TEMPLATE_SIGNATURES).toHaveLength(15);
  });
});
