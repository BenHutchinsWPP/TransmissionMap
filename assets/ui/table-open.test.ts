// The table opener's restore glue (table-open.ts → drawer-open.ts): the table
// chunk loads only when the shell asks for the table (prepare), start runs on
// the loaded chunk synchronously, and a chunk that fails to load rejects prepare.
// Deps: table-open.ts (drawer-open.js, ui-table.js and diag-log.js mocked).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { TableSnapshot } from './drawer-snapshot.js';

type Resume = { ask(): Promise<void>; table: { prepare(s: TableSnapshot): Promise<boolean>; start(s: TableSnapshot): Promise<void> } };
let resume: Resume | null = null;
let tableLoads = 0;
const TABLE = { req: { layerId: 'osm-substations-points' } } as TableSnapshot;

beforeEach(() => {
  vi.resetModules();
  resume = null;
  tableLoads = 0;
  vi.doMock('./drawer-open.js', () => ({ restoreDrawer: async (r: Resume) => { resume = r; } }));
  vi.doMock('../diag-log.js', () => ({ recordDiagEvent: () => {} }));
});

const chunk = { prepareRestore: vi.fn(async () => true), startRestore: vi.fn(async () => {}) };

describe('table-open restoreDrawer', () => {
  it('hands the shell its resumes without loading the table chunk', async () => {
    vi.doMock('./ui-table.js', () => { tableLoads++; return chunk; });
    const { restoreDrawer } = await import('./table-open.js');
    await restoreDrawer(async () => {});
    await new Promise(r => setTimeout(r, 50));   // an eager import would have settled by now
    expect(resume).not.toBeNull();
    expect(tableLoads).toBe(0);
  });

  it('prepare loads the chunk and asks it; start calls the loaded chunk at once', async () => {
    vi.doMock('./ui-table.js', () => { tableLoads++; return chunk; });
    const { restoreDrawer } = await import('./table-open.js');
    await restoreDrawer(async () => {});
    expect(await resume!.table.prepare(TABLE)).toBe(true);
    expect(tableLoads).toBe(1);
    expect(chunk.prepareRestore).toHaveBeenCalledWith(TABLE);
    void resume!.table.start(TABLE);
    expect(chunk.startRestore).toHaveBeenCalledWith(TABLE);
  });

  it('a table chunk that fails to load rejects prepare', async () => {
    vi.doMock('./ui-table.js', () => { throw new Error('offline'); });
    const { restoreDrawer } = await import('./table-open.js');
    await restoreDrawer(async () => {});
    await expect(resume!.table.prepare(TABLE)).rejects.toThrow();
  });
});
