// @vitest-environment jsdom
// The Proximity tab's grid without the table chunk: ui-proximity.ts registers
// its own Tabulator modules, so with ui-table.js unloadable the grid still
// mounts, and a cell is a text node.
// Deps: ui-proximity.js (ui-table.js mocked to throw; user-data-csv.js,
//       proximity-map.js, pairs-open.js mocked), drawer.js, test-drawer-env.js.

import { it, expect, vi, afterEach } from 'vitest';
import { installDrawerEnv, resetDrawerEnv } from '../test-drawer-env.js';
import type { CsvPoints } from '../../user-data/user-data-csv.js';

const pick = vi.hoisted(() => vi.fn());
vi.mock('../ui-table.js', () => { throw new Error('ui-table.js loaded'); });
vi.mock('../../user-data/user-data-csv.js', () => ({ pickCsvPoints: pick }));
vi.mock('./proximity-map.js', () => ({ startProximityMap: () => {} }));
vi.mock('../../proximity/pairs-open.js', () => ({ runPairs: vi.fn(), cancelPairs: vi.fn() }));

const { state } = await import('../../state.js');
const px = await import('./ui-proximity.js');
const { panel, closePane } = await import('../drawer.js');

const points: CsvPoints = {
  fileName: 'sites.csv', headers: ['Site', 'lat', 'lng'], skipped: 0, latCol: 1, lngCol: 2, nameCols: [0], idCol: null,
  features: [[0, 0, 'Alpha'], [0, 0.001, 'Bravo']].map(([lon, lat, name]) =>
    ({ type: 'Feature', properties: { Site: name, name }, geometry: { type: 'Point', coordinates: [lon as number, lat as number] } })),
  dataRowIndex: Int32Array.from([0, 1]),
};

afterEach(() => { (state as { map: unknown }).map = null; closePane('prox'); resetDrawerEnv(); });

it('mounts the grid with ui-table.js unloadable, and a cell is a text node', async () => {
  installDrawerEnv();
  px.openProximity();
  pick.mockResolvedValueOnce(points);
  const input = panel('prox').querySelector<HTMLInputElement>('.px-file')!;
  Object.defineProperty(input, 'files', { value: [{ name: 'sites.csv', size: 100 }], configurable: true });
  input.dispatchEvent(new Event('change'));
  await vi.waitFor(() => expect(panel('prox').querySelectorAll('.px-grid .tabulator-row')).toHaveLength(2));
  const cell = panel('prox').querySelector('.px-grid .tabulator-row .tabulator-cell:nth-child(2)')!;
  expect(cell.childNodes).toHaveLength(1);
  expect(cell.firstChild!.nodeType).toBe(Node.TEXT_NODE);
  expect(cell.textContent).toBe('1');
});
