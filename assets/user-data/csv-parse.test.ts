import { describe, it, expect } from 'vitest';
import { parseCSV, guessColumn, LAT_NAMES, LNG_NAMES } from './csv-parse.js';

describe('parseCSV', () => {
  it('parses rows and columns, skips blank lines', () => {
    expect(parseCSV('a,b\n1,2\n\n3,4\n')).toEqual([['a', 'b'], ['1', '2'], ['3', '4']]);
  });

  it('handles quoted fields with commas, newlines, and escaped quotes', () => {
    expect(parseCSV('name,note\n"Smith, Jr.","said ""hi""\nline2"'))
      .toEqual([['name', 'note'], ['Smith, Jr.', 'said "hi"\nline2']]);
  });

  it('handles CRLF line endings', () => {
    expect(parseCSV('a,b\r\n1,2\r\n')).toEqual([['a', 'b'], ['1', '2']]);
  });
});

describe('guessColumn', () => {
  it('detects lat/lng by header name, case-insensitive', () => {
    const h = ['id', 'Latitude', 'LONGITUDE'];
    expect(guessColumn(h, LAT_NAMES)).toBe(1);
    expect(guessColumn(h, LNG_NAMES)).toBe(2);
  });

  it('returns -1 when no match', () => {
    expect(guessColumn(['a', 'b'], LAT_NAMES)).toBe(-1);
  });
});
