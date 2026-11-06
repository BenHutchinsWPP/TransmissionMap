// copy-fit.ts: the shared caps at their boundaries, the download form (no __src, credit
// carried), commitCopy's failed-save fallback, creditText on every registry credit, and
// the bundle split (line-read.ts by `import type` only).
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

const added: { features: GeoJSON.Feature[]; layerName?: string }[] = [];
let stored = 0;
let saved = true;
vi.mock('./user-data.js', () => ({
  addCopiedFeatures: (features: GeoJSON.Feature[], layerName?: string) => { added.push({ features, layerName }); return { saved }; },
  storedUserDataChars: () => stored,
}));
const downloadFile = vi.fn();
vi.mock('./user-data-export.js', () => ({ downloadFile: (...a: unknown[]) => downloadFile(...a) }));

const { MAX_COPY_ITEMS, MAX_COPY_CHARS, MAX_STORE_CHARS, fitCopy, toDownload, commitCopy, creditText, downloadCopy,
  showCopyResult } = await import('./copy-fit.js');
const { MAX_SELECTION } = await import('../lines/line-read.js');
const { LAYERS } = await import('../../src/registry/index.js');

const META = { label: 'L', attribution: '© OpenStreetMap contributors', licence: 'ODbL 1.0', url: 'https://example.org/c', dataset: 'ds' };
const feat = (pad = 0): GeoJSON.Feature => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [0, 0] },
  properties: { name: 'x'.repeat(pad), __src: 'some-layer' } });
/** One feature whose serialised collection is exactly `chars` long. */
function sized(chars: number): GeoJSON.Feature[] {
  const base = JSON.stringify({ type: 'FeatureCollection', features: [feat(0)] }).length;
  return [feat(chars - base)];
}

beforeEach(() => { added.length = 0; stored = 0; saved = true; downloadFile.mockClear(); });

describe('caps', () => {
  it('MAX_COPY_ITEMS is the line files\' selection cap', () => expect(MAX_COPY_ITEMS).toBe(MAX_SELECTION));

  it('1.5 MB fits, 1.5 MB + 1 downloads', () => {
    expect(fitCopy(sized(MAX_COPY_CHARS), META, 0, 'l')).toEqual({ kind: 'fits', chars: MAX_COPY_CHARS });
    expect(fitCopy(sized(MAX_COPY_CHARS + 1), META, 0, 'l').kind).toBe('download');
  });

  it('the projected store: stored + copy at the cap fits, one over downloads', () => {
    const fs = sized(1000);
    stored = MAX_STORE_CHARS - 1000;
    expect(fitCopy(fs, META, stored, 'l').kind).toBe('fits');
    expect(fitCopy(fs, META, stored + 1, 'l').kind).toBe('download');
  });
});

describe('download form', () => {
  it('has no __src, carries the credit and licence, and is named dataset-n', () => {
    const d = toDownload([feat(), feat()], META, 'layer-x', 10);
    expect(d.filename).toBe('ds-2.geojson');
    expect(JSON.stringify(d.fc)).not.toContain('__src');
    expect(d.fc).toMatchObject({ attribution: META.attribution, licence: 'ODbL 1.0', source_url: 'https://example.org/c' });
    expect(d.n).toBe(2);
  });

  it('without meta it is named by the layer and carries no credit', () => {
    const d = toDownload([feat()], null, 'layer-x', 10);
    expect(d.filename).toBe('layer-x-1.geojson');
    expect(d.fc).not.toHaveProperty('attribution');
  });

  it('downloadCopy writes the stripped collection', () => {
    downloadCopy(toDownload([feat()], META, 'l', 1));
    expect(downloadFile).toHaveBeenCalledWith(expect.not.stringContaining('__src'), 'ds-1.geojson', 'application/geo+json');
  });
});

describe('commitCopy', () => {
  it('commits a fitting copy', () => {
    expect(commitCopy([feat()], META, 'l', 'Name', 2)).toEqual({ kind: 'copied', n: 1, simplified: 2 });
    expect(added).toHaveLength(1);
    expect(added[0].layerName).toBe('Name');
  });

  it('a failed save is a download with storageFull, without __src', () => {
    saved = false;
    const r = commitCopy([feat()], META, 'l', undefined, 0);
    expect(r).toMatchObject({ kind: 'download', storageFull: true, n: 1 });
    expect(JSON.stringify((r as { fc: unknown }).fc)).not.toContain('__src');
  });

  it('over a cap it downloads and commits nothing', () => {
    const r = commitCopy(sized(MAX_COPY_CHARS + 1), META, 'l', undefined, 0);
    expect(r.kind).toBe('download');
    expect(r).not.toHaveProperty('storageFull');
    expect(added).toHaveLength(0);
  });
});

describe('creditText', () => {
  it('strips tags, decodes entities, collapses space', () => {
    expect(creditText('&copy; <a href="https://x">Open&amp;Street</a>\n  &lt;b&gt; &#169; &#x41; &nbsp;z &bogus;'))
      .toBe('© Open&Street <b> © A z &bogus;');
  });

  it('every registry credit becomes plain text', () => {
    let n = 0;
    for (const l of LAYERS) {
      const c = l.data?.credit;
      if (!c) continue;
      n++;
      const out = creditText(c);
      expect(out, l.id).not.toMatch(/</);
      expect(out, l.id).not.toMatch(/&[#\w]+;/);
    }
    expect(n).toBeGreaterThan(10);
  });
});

describe('showCopyResult', () => {
  const btn = () => ({ textContent: '', title: '', disabled: true, addEventListener() {} }) as unknown as HTMLButtonElement;
  it('names a feature copy\'s too-many and a not-copyable layer', () => {
    const b = btn();
    showCopyResult(b, { kind: 'refused', reason: 'too-many' }, true, 'feature');
    expect(b.textContent).toContain('features');
    showCopyResult(b, { kind: 'refused', reason: 'too-many' });
    expect(b.textContent).toContain('lines');
    showCopyResult(b, { kind: 'refused', reason: 'not-copyable' });
    expect(b.textContent).toContain('no copyable geometry');
  });
});

describe('bundle split', () => {
  it('copy-fit.ts imports line-read only as a type', () => {
    const src = readFileSync(new URL('./copy-fit.ts', import.meta.url), 'utf8');
    const imports = src.split('\n').filter(l => /^import\b/.test(l) && l.includes('line-read'));
    expect(imports.length).toBeGreaterThan(0);
    for (const l of imports) expect(l).toMatch(/^import type /);
  });
});
