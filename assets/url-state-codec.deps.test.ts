// The link codec reads the facet records (src/colors/facets.ts), never the
// legend UI, filters or state: importing it, parsing and formatting must not
// touch ./state.js, ./ui/ui-legends.js or ./filters.js.
import { describe, it, expect, vi } from 'vitest';

const boom = vi.hoisted(() => (name: string) => () => { throw new Error(`url-state-codec reached ${name}`); });
vi.mock('./state.js', boom('state.js'));
vi.mock('./ui/ui-legends.js', boom('ui/ui-legends.js'));
vi.mock('./filters.js', boom('filters.js'));

describe('url-state-codec dependencies', () => {
  it('imports, parses and formats without state, ui-legends or filters', async () => {
    const { parseUrlState, formatUrlState, defaultView } = await import('./url-state-codec.js');
    const parsed = parseUrlState(new URLSearchParams('v=U&mw=100-500'));
    expect([...parsed.legendFilters!.kv]).toEqual(['unknown']);
    expect(parsed.mwFilter).toEqual({ min: 100, max: 500 });
    expect(formatUrlState(defaultView())).toEqual([]);
  });
});
