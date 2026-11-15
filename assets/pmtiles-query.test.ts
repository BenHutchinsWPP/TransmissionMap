// A ?v=<token> on a pmtiles:// URL: the Protocol map.ts registers keeps the query
// in the archive URL for both the TileJSON request and the tile requests, so both
// reach one archive instance. Pins PMTiles' greedy tile-URL regex.
import { describe, it, expect, vi } from 'vitest';
import { Protocol } from 'pmtiles';

describe('pmtiles:// URL with a ?v= token', () => {
  it('requests and keys the archive by the full URL, query included', async () => {
    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => { urls.push(String(url)); return new Response(new Uint8Array(16384), { status: 206 }); }));
    const protocol = new Protocol();
    const ac = new AbortController();
    await protocol.tile({ type: 'json', url: 'pmtiles://https://h/x.pmtiles?v=abc' } as never, ac).catch(() => {});
    await protocol.tile({ type: 'image', url: 'pmtiles://https://h/x.pmtiles?v=abc/3/1/2' } as never, ac).catch(() => {});
    expect(urls.length).toBeGreaterThan(0);
    expect(new Set(urls)).toEqual(new Set(['https://h/x.pmtiles?v=abc']));
    expect(protocol.tiles.get('https://h/x.pmtiles?v=abc')).toBeDefined();
    vi.unstubAllGlobals();
  });
});
