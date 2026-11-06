// feature-id.ts: the stable id a map feature carries (featureId, featureIdExpr).
// Then the registry ↔ scripts/tile_manifest.yaml
// parity: each layer's `data.id` must name the column the tile build puts the
// id in (`id_field`, `native_id: true` for a tippecanoe feature id).
// Deps: feature-id.ts, src/registry (LAYERS), constants.ts (DATA).
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { LAYERS } from '../src/registry/index.js';
import { DATA } from './constants.js';
import { featureId, featureIdExpr } from './feature-id.js';

describe('featureId', () => {
  it('returns the tile feature id for a native id, never a property', () => {
    expect(featureId('osm-generators', { id: 4535892832, properties: {} })).toBe(4535892832);
    expect(featureId('osm-generators', { properties: { fid: 12 } })).toBeUndefined();
  });

  it('returns the promoted id, or the column itself on a plain feature', () => {
    expect(featureId('hifld-transmission-lines', { id: '100200', properties: { ID: '100200' } })).toBe('100200');
    expect(featureId('eia-generators', { properties: { fid: '3:1' } })).toBe('3:1');
    expect(featureId('us-states', { properties: { stusps: 'TX' } })).toBe('TX');
  });

  it('returns nothing for a layer that declares no id, or a feature without one', () => {
    expect(featureId('nexrad-radar', { id: 7, properties: {} })).toBeUndefined();
    expect(featureId('no-such-layer', { id: 7 })).toBeUndefined();
    expect(featureId('mines', { properties: { name: 'x' } })).toBeUndefined();
  });

  it('reads the id inside a filter the same way', () => {
    expect(featureIdExpr('osm-transmission-lines')).toEqual(['id']);
    expect(featureIdExpr('nerc-regions')).toEqual(['get', 'sub_nm']);
    expect(featureIdExpr('nexrad-radar')).toBeUndefined();
  });
});

// ─── Registry ↔ tile manifest parity ─────────────────────────────────────────
// A dependency-free read of the manifest: each `  - id:` block's id_field and
// native_id lines, built_elsewhere entries included (they share the indent).
interface ManifestId { field?: string; native: boolean }
function readManifest(): Map<string, ManifestId> {
  const text = readFileSync(new URL('../scripts/tile_manifest.yaml', import.meta.url), 'utf8');
  const blocks = new Map<string, ManifestId>();
  for (const block of text.split(/^ {2}- id:/m).slice(1)) {
    const id = block.match(/^\s*(\S+)/)![1];
    const field = block.match(/^ {4}id_field:\s*["']?([^"'\s#]+)/m)?.[1];
    blocks.set(id, { field, native: /^ {4}native_id:\s*true\b/m.test(block) });
  }
  return blocks;
}

const manifest = readManifest();
// The manifest block a registry layer is built by: its FIELD_SCHEMA dataset
// (the OSM kV bands share one), else its DATA file's basename.
const blockOf = (l: (typeof LAYERS)[number]) =>
  l.dataset ?? DATA[l.data!.key].split('/').pop()!.replace(/\.(pmtiles|geojson(\.gz)?)$/, '');
const declaring = LAYERS.filter(l => l.data?.id);

// Join sources no registry layer declares: their builders set promoteId
// themselves (nws-zone-join.ts). county_boundaries is declared by us-counties.
const JOIN_SOURCE_IDS: Record<string, string> = { nws_zones: 'key' };

describe('registry stable ids match scripts/tile_manifest.yaml', () => {
  it('every declaring layer has a manifest block or a built_elsewhere entry', () => {
    expect(declaring.filter(l => !manifest.has(blockOf(l))).map(l => l.id)).toEqual([]);
  });

  // Needs the id_field/native_id lines in the manifest; skipped, by name,
  // only while the manifest declares no id at all.
  const manifestHasIds = [...manifest.values()].some(b => b.field);
  it.skipIf(!manifestHasIds)('each declaration names the manifest block\'s id_field and native_id (needs the manifest id_field lines)', () => {
    for (const l of declaring.filter(l => manifest.has(blockOf(l)))) {
      const b = manifest.get(blockOf(l))!;
      expect({ field: b.field, native: b.native }, `${l.id} → ${blockOf(l)}`)
        .toEqual({ field: l.data!.id!.field, native: !!l.data!.id!.native });
    }
  });

  it.skipIf(!manifestHasIds)('every manifest id_field is declared by a registry layer or a join source (needs the manifest id_field lines)', () => {
    const declared = new Set(declaring.map(blockOf));
    for (const [id, b] of manifest) {
      if (!b.field) continue;
      if (id in JOIN_SOURCE_IDS) expect(b.field, id).toBe(JOIN_SOURCE_IDS[id]);
      else expect(declared.has(id), `${id} declares id_field ${b.field}; declare data.id on its layer`).toBe(true);
    }
  });
});

describe('registry data.analysis names its geometry dataset', () => {
  it('every layer with data.analysis names the dataset its own data.key builds', () => {
    expect(LAYERS.filter(l => l.data?.analysis && l.data.analysis !== l.data.key).map(l => `${l.id}: ${l.data!.analysis}`)).toEqual([]);
  });
});
