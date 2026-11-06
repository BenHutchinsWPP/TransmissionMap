// service-library.json: every curated entry is a valid, vetted, credited service.
import { describe, it, expect } from 'vitest';
import LIBRARY from '../../src/registry/service-library.json';
import { parseServiceUrl, validateServiceSpec, validateStyle, RASTER_KINDS, type ServiceKind } from './service-spec.js';
import { isVetted } from './service-hosts.js';

const CATEGORIES = ['energy', 'environment', 'hazards', 'land', 'transport', 'boundaries', 'imagery', 'weather'];
interface Entry { id: string; title: string; category: string; kind: ServiceKind; url: string; layer?: string;
  version?: '1.1.1' | '1.3.0'; style: unknown; minzoom?: number; credit: string; licence: string; source: string; host: string; description: string }
const ENTRIES = LIBRARY as unknown as Entry[];

describe('service library', () => {
  it('has entries with distinct short kebab-case ids', () => {
    expect(ENTRIES.length).toBeGreaterThanOrEqual(35);
    expect(new Set(ENTRIES.map(e => e.id)).size).toBe(ENTRIES.length);
    for (const e of ENTRIES) expect(e.id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });

  describe.each(ENTRIES.map(e => [e.id, e] as const))('%s', (_id, e) => {
    it('parses and validates as a service', () => {
      const p = parseServiceUrl(e.url, e.kind);
      expect(p.ok).toBe(true);
      if (!p.ok) return;
      expect(p.result.url).toBe(e.url);
      expect(p.result.host).toBe(e.host);
      const spec = validateServiceSpec({ kind: e.kind, url: e.url, layer: e.layer, version: e.version });
      expect(spec.ok).toBe(true);
      if (e.kind === 'wms' || e.kind === 'arcgis-feature') expect(e.layer).toBeDefined();
    });

    it('has a valid style that fits its kind', () => {
      const s = validateStyle(e.style);
      expect(s.ok).toBe(true);
      if (!s.ok) return;
      expect(s.result).toEqual(e.style);
      expect(s.result.kind === 'raster').toBe(RASTER_KINDS.has(e.kind));
      if (e.minzoom !== undefined) expect(s.result.minzoom).toBe(e.minzoom);
    });

    it('is vetted', () => {
      expect(isVetted(e.url, e.kind)).toBe(true);
    });

    it('carries credit, licence, description and a known category', () => {
      expect(CATEGORIES).toContain(e.category);
      for (const f of [e.credit, e.licence, e.title, e.description]) expect(f.trim().length).toBeGreaterThan(0);
    });

    it('names its source page: an https link with no credentials, or UNKNOWN', () => {
      expect(typeof e.source).toBe('string');
      if (e.source === 'UNKNOWN') return;
      const u = new URL(e.source);
      expect(u.protocol).toBe('https:');
      expect(u.username + u.password).toBe('');
    });
  });
});
