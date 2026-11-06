// packLinks: a layer's downloads → its Download menu's formats and links, and
// the registry's packs held to the pipeline that builds them
// (scripts/build_releases.py, scripts/release_manifest.yaml).
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { packLinks } from './download-packs.js';
import { LAYERS } from '../src/registry/index.js';

const lines = { geojson: 'data/releases/osm-transmission-lines.zip', shp: 'data/releases/osm-transmission-lines-shp.zip' };

describe('packLinks', () => {
  it('a flat pack keeps its repo-relative path in dev, where Vite serves it from disk', () => {
    expect(packLinks({ csv: 'data/releases/hifld-substations.zip' }, ''))
      .toEqual([{ label: 'CSV', links: [{ url: 'data/releases/hifld-substations.zip' }] }]);
  });

  it('a flat pack maps to a flat Release asset name in prod', () => {
    expect(packLinks({ csv: 'data/releases/hifld-substations.zip' }, 'https://h/'))
      .toEqual([{ label: 'CSV', links: [{ url: 'https://h/hifld-substations.zip' }] }]);
  });

  it('a continental pack expands to one labelled link per continent, code ahead of -shp', () => {
    const [geojson, shp] = packLinks(lines, '');
    expect([geojson.label, shp.label]).toEqual(['GeoJSON', 'SHP']);
    for (const f of [geojson, shp]) {
      expect(f.links).toHaveLength(8);
      expect(f.links.every(l => l.labelKey?.startsWith('region.'))).toBe(true);
    }
    expect(geojson.links[0].url).toBe('data/releases/osm-transmission-lines-na.zip');
    expect(geojson.links[7].url).toBe('data/releases/osm-transmission-lines-an.zip');
    expect(shp.links[0].url).toBe('data/releases/osm-transmission-lines-na-shp.zip');
    expect(shp.links[7].url).toBe('data/releases/osm-transmission-lines-an-shp.zip');
    expect(packLinks(lines, 'https://h/')[1].links[1].url).toBe('https://h/osm-transmission-lines-eu-shp.zip');
  });

  it('drops empty formats and keeps the CSV, GeoJSON, SHP, GeoTIFF order', () => {
    expect(packLinks({}, '')).toEqual([]);
    expect(packLinks({ csv: null, geojson: '', shp: null, tif: null }, '')).toEqual([]);
    const all = { tif: 'data/releases/t.zip', shp: 'data/releases/s-shp.zip', geojson: 'data/releases/s.zip', csv: 'data/releases/c.zip' };
    expect(packLinks(all, '').map(f => f.label)).toEqual(['CSV', 'GeoJSON', 'SHP', 'GeoTIFF']);
  });
});

// A registry pack the pipeline does not build is a download that 404s for
// every visitor, and nothing else notices.
describe('registry packs match the pipeline', () => {
  const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');

  it('the continent codes are build_releases.py CONTINENT_CODES, in order', () => {
    const m = read('../scripts/build_releases.py').match(/^CONTINENT_CODES = \[([^\]]*)\]/m);
    const codes = [...(m?.[1] ?? '').matchAll(/"(\w+)"/g)].map(x => x[1]);
    const ours = packLinks({ csv: 'data/releases/osm-x.zip' }, '')[0].links.map(l => l.url.match(/-(\w+)\.zip$/)?.[1]);
    expect(codes).toHaveLength(8);
    expect(ours).toEqual(codes);
  });

  it('every downloads path names a built manifest layer, continental iff osm-, -shp iff shp', () => {
    const manifest = read('../scripts/release_manifest.yaml');
    const body = manifest.slice(manifest.indexOf('\nlayers:'));
    const parts = body.split(/^ {2}([\w-]+):\n/m);
    const entries = new Map<string, string>();
    for (let i = 1; i < parts.length; i += 2) entries.set(parts[i], parts[i + 1]);

    const packs = LAYERS.flatMap(l => Object.entries(l.downloads ?? {}).filter(([, p]) => p) as [string, string][]);
    expect(packs.length).toBeGreaterThan(30);
    for (const [format, path] of packs) {
      expect(path.endsWith('-shp.zip'), `${format}: ${path}`).toBe(format === 'shp');
      const id = path.replace(/^data\/releases\//, '').replace(/(-shp)?\.zip$/, '');
      const entry = entries.get(id);
      expect(entry, `${path} names no release_manifest.yaml layer`).toBeDefined();
      expect(/^\s+skip: true\b/m.test(entry!), `${id} is skipped in release_manifest.yaml`).toBe(false);
      expect(/^\s+continental: true\b/m.test(entry!), `${id} continental flag`).toBe(id.startsWith('osm-'));
    }
  });
});
