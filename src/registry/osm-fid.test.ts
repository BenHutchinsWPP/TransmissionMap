// osm-fid.ts: the OSM fid decoder (osmRef), and that every OSM layer declares
// its stable id with the shared OSM_FID / OSM_NATIVE_FID objects — by
// reference, since view-validate.ts recognises an OSM id with `===`.
// Deps: osm-fid.ts, src/registry/index.ts (LAYERS).
import { describe, it, expect } from 'vitest';
import { LAYERS } from './index.js';
import { OSM_FID, OSM_NATIVE_FID, osmRef } from './osm-fid.js';

describe('osmRef', () => {
  it('reads the element type from the last digit and the OSM id from the rest', () => {
    expect(osmRef(4535892832)).toEqual({ type: 'way', id: 453589283 });
    expect(osmRef(1)).toBeNull();
    expect(osmRef(11)).toEqual({ type: 'node', id: 1 });
    expect(osmRef(142_700_000_003)).toEqual({ type: 'relation', id: 14_270_000_000 });
    expect(osmRef('1233')).toEqual({ type: 'relation', id: 123 });
  });

  it('refuses anything that is not an OSM fid', () => {
    for (const v of [1230, 1234, 129, -12, 12.5, '12a', '', null, undefined, 2 ** 53, {}])
      expect(osmRef(v), String(v)).toBeNull();
  });
});

describe('OSM id declarations', () => {
  it('every osm_* layer with an id uses a shared decl object, and no other layer does', () => {
    const withId = LAYERS.filter((l) => l.data?.id);
    expect(withId.some((l) => l.data!.key.startsWith('osm_'))).toBe(true);
    for (const l of withId) {
      const shared = l.data!.id === OSM_FID || l.data!.id === OSM_NATIVE_FID;
      expect(shared, l.id).toBe(l.data!.key.startsWith('osm_'));
    }
  });
});
