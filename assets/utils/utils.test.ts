// utils.ts: isGzipUrl reads the path's extension, with or without a ?v= token.
import { describe, it, expect } from 'vitest';
import { isGzipUrl } from './utils.js';

describe('isGzipUrl', () => {
  it('is true for .gz with or without a query or fragment', () => {
    expect(isGzipUrl('https://h/x.geojson.gz')).toBe(true);
    expect(isGzipUrl('https://h/x.geojson.gz?v=abc')).toBe(true);
    expect(isGzipUrl('x.i16.gz#a')).toBe(true);
  });
  it('is false for other files', () => {
    expect(isGzipUrl('https://h/x.geojson')).toBe(false);
    expect(isGzipUrl('https://h/x.geojson?v=abc')).toBe(false);
    expect(isGzipUrl('https://h/x.gzip')).toBe(false);
  });
});
