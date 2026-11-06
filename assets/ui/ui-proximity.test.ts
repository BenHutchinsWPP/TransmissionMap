// @vitest-environment jsdom
// The Proximity tab over a mocked CSV picker and pairs worker: the threshold's unit
// conversion and range, ID interning, the groups grid (group 0 left out, ordered), the pairs
// view (progress, Cancel, a stale result dropped, the truncation note), both CSV downloads
// (columns, formula guard, truncation note), the 50 MB / 100,000-point refusals, nothing
// written to storage, and the file dropped when the tab closes.
// Deps: ui-proximity.js (user-data-csv.js, pairs-open.js, proximity-map.js mocked; user-data-export.js's
//       downloadFile spied), test-drawer-env.js, ui-table.js, units.js.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { installDrawerEnv, resetDrawerEnv } from './test-drawer-env.js';
import type { CsvPoints } from '../user-data/user-data-csv.js';
import type { PairsResult } from '../proximity/proximity.js';

const mocks = vi.hoisted(() => ({
  pick: vi.fn(),
  runPairs: vi.fn(),
  cancelPairs: vi.fn(),
  downloads: [] as { blob: Blob; name: string }[],
  copied: [] as string[],
  runCsv: vi.fn(),
  cancelCsv: vi.fn(),
  runSample: vi.fn(),
  cancelSample: vi.fn(),
}));
vi.mock('../user-data/user-data-csv.js', () => ({ pickCsvPoints: mocks.pick }));
vi.mock('./proximity-map.js', () => ({ startProximityMap: () => {} }));
vi.mock('../proximity/pairs-open.js', () => ({ runPairs: mocks.runPairs, cancelPairs: mocks.cancelPairs }));
vi.mock('../proximity/csv-open.js', () => ({ runPairsCsv: mocks.runCsv, cancelCsv: mocks.cancelCsv }));
vi.mock('../proximity/sample-open.js', () => ({ runSample: mocks.runSample, cancelSample: mocks.cancelSample }));
vi.mock('./grid-copy.js', async (orig) => ({
  ...(await orig<typeof import('./grid-copy.js')>()),
  copyText: vi.fn((text: string, done: () => void) => { mocks.copied.push(text); done(); }),
}));
vi.mock('../user-data/user-data-export.js', async (orig) => ({
  ...(await orig<typeof import('../user-data/user-data-export.js')>()),
  downloadFile: (blob: Blob, name: string) => { mocks.downloads.push({ blob, name }); },
}));

const { buildPairsCsv } = await import('../proximity/pairs-csv.js');
const { state } = await import('../state.js');
const { emit } = await import('../state-bus.js');
const { loadDictionary, setLocale } = await import('../../src/i18n/index.js');
const px = await import('./ui-proximity.js');
const { closeProx, proxPanel } = await import('./ui-table.js');
const { proximityPairs } = await import('../proximity/proximity.js');
const { setUnits, DEFAULT_UNITS } = await import('../../src/units.js');

// Group 1: A, B, C near (0,0); B and C share a site, so B–C is no pair. Group 2: D, E. F is alone.
const ROWS = [
  { lon: 0, lat: 0, name: 'Alpha', site: 'S1', note: 'a', row: 0 },
  { lon: 0, lat: 0.001, name: 'Bravo', site: 'S2', note: '=1+1', row: 1 },
  { lon: 0, lat: 0.0025, name: 'Charlie', site: ' S2 ', note: 'c', row: 3 },
  { lon: 10, lat: 10, name: 'Far', site: 'S3', note: 'f', row: 4 },
  { lon: 20, lat: 20, name: 'Delta', site: 'S4', note: 'd', row: 5 },
  { lon: 20, lat: 20.001, name: 'Echo', site: 'S5', note: 'e', row: 7 },
];

function csvPoints(rows = ROWS, idCol: number | null = 0): CsvPoints {
  return {
    fileName: 'sites.csv', headers: ['Site', 'Notes', 'lat', 'lng'], skipped: 2, latCol: 2, lngCol: 3, nameCols: [1], idCol,
    features: rows.map(r => ({ type: 'Feature', properties: { Site: r.site, Notes: r.note, name: r.name }, geometry: { type: 'Point', coordinates: [r.lon, r.lat] } })),
    dataRowIndex: Int32Array.from(rows, r => r.row),
  };
}

const q = <T extends HTMLElement = HTMLElement>(sel: string) => proxPanel().querySelector<T>(sel)!;
const flush = () => new Promise(r => setTimeout(r, 0));
const bodyRows = () => [...proxPanel().querySelectorAll('.px-grid .tabulator-row')].map(r => [...r.querySelectorAll('.tabulator-cell')].slice(1).map(c => c.textContent));
const status = () => q('.px-status').textContent ?? '';
const readBlob = (b: Blob) => new Promise<string>(res => { const f = new FileReader(); f.onload = () => res(String(f.result)); f.readAsText(b); });
const csvFile = (size = 100) => ({ name: 'sites.csv', size }) as unknown as File;

async function openWith(points: CsvPoints | null = csvPoints(), file = csvFile()) {
  px.openProximity();
  mocks.pick.mockResolvedValueOnce(points);
  const input = q<HTMLInputElement>('.px-file');
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  input.dispatchEvent(new Event('change'));
  await flush();
  await flush();
}

async function setThreshold(v: string, u?: string) {
  const th = q<HTMLInputElement>('.px-th-input');
  if (u) { q<HTMLSelectElement>('.px-unit').value = u; q('.px-unit').dispatchEvent(new Event('change')); }
  th.value = v;
  th.dispatchEvent(new Event('input'));
  await new Promise(r => setTimeout(r, 300));
  await flush();
}

const pairsFor = (opts: { ids?: Int32Array } = {}) => (lon: Float64Array, lat: Float64Array, km: number) =>
  Promise.resolve({ ok: true as const, result: proximityPairs(lon, lat, km, opts) });

beforeEach(() => {
  installDrawerEnv();
  setUnits({ ...DEFAULT_UNITS, distance: 'mi' });
  mocks.pick.mockReset();
  mocks.runPairs.mockReset();
  mocks.cancelPairs.mockReset();
  mocks.downloads.length = 0;
  mocks.copied.length = 0;
  mocks.runCsv.mockReset();
  mocks.cancelCsv.mockReset();
  mocks.runSample.mockReset();
  mocks.cancelSample.mockReset();
  mocks.runCsv.mockImplementation(async (input: Parameters<typeof buildPairsCsv>[0], o: { limit?: number }) => {
    const r = buildPairsCsv(input, o.limit);
    return r.ok ? { ok: true, blob: new Blob(r.parts, { type: 'text/csv' }) } : { ok: false, reason: 'tooBig', bytes: r.bytes };
  });
  mocks.runPairs.mockImplementation((lon: Float64Array, lat: Float64Array, km: number, o: { ids?: Int32Array }) => pairsFor(o)(lon, lat, km));
});
afterEach(() => { (state as { map: unknown }).map = null; closeProx(); resetDrawerEnv(); setUnits(DEFAULT_UNITS); vi.restoreAllMocks(); });

describe('threshold and ids', () => {
  it('converts ft / mi / m / km to km once', () => {
    expect(px.thresholdKm(5280, 'ft')).toBeCloseTo(1.609344, 9);
    expect(px.thresholdKm(1, 'mi')).toBeCloseTo(1.609344, 9);
    expect(px.thresholdKm(1000, 'm')).toBe(1);
    expect(px.thresholdKm(2.5, 'km')).toBe(2.5);
  });
  it('refuses outside 0.01–1,000 km and non-numbers', () => {
    expect(px.thresholdKm(0.01, 'km')).toBe(0.01);
    expect(px.thresholdKm(1000, 'km')).toBe(1000);
    expect(px.thresholdKm(0.009, 'km')).toBeNull();
    expect(px.thresholdKm(1000.5, 'km')).toBeNull();
    expect(px.thresholdKm(32, 'ft')).toBeNull();
    expect(px.thresholdKm(700, 'mi')).toBeNull();
    expect(px.thresholdKm(NaN, 'km')).toBeNull();
    expect(px.thresholdKm(-1, 'km')).toBeNull();
  });
  it('interns trimmed ids in order of first appearance; empty is -1', () => {
    expect([...px.internIds(['a', ' a ', 'b', '', '   ', 'a', 'c'])]).toEqual([0, 0, 1, -1, -1, 0, 2]);
  });
  it('orders group > 0 by group, nearest, then CSV row', () => {
    const r = {
      group: Int32Array.of(2, 0, 1, 1, 1, 2), groups: 2, size: Int32Array.of(2, 0, 3, 3, 3, 2),
      nearestKm: Float64Array.of(0.5, NaN, 0.2, 0.1, 0.2, 0.5), skipped: 0,
    };
    // points 2 and 4 tie at 0.2 km: the lower CSV row (rowNo 3 < 9) first
    expect([...px.groupOrder(r, Int32Array.of(0, 1, 9, 2, 3, 4))]).toEqual([3, 4, 2, 0, 5]);
  });
});

describe('the Proximity tab', () => {
  it('defaults the unit from the display units', async () => {
    px.openProximity();
    expect(q<HTMLInputElement>('.px-th-input').value).toBe('5280');
    expect(q<HTMLSelectElement>('.px-unit').value).toBe('ft');
    closeProx();
    setUnits({ ...DEFAULT_UNITS, distance: 'km' });
    px.openProximity();
    expect(q<HTMLInputElement>('.px-th-input').value).toBe('1000');
    expect(q<HTMLSelectElement>('.px-unit').value).toBe('m');
    expect(q('.px-privacy').textContent).toBe('Your file never leaves this browser: it is not sent to any server.');
  });

  it('lists only grouped points, ordered by group, with row numbers, ids and the CSV columns', async () => {
    await openWith();
    await vi.waitFor(() => expect(bodyRows()).toHaveLength(5));
    expect(mocks.pick).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ title: 'Choose columns', submit: 'Check proximity' }));
    const rows = bodyRows();
    expect(rows.map(r => r[0])).toEqual(['1', '1', '1', '2', '2']);
    expect(rows.map(r => r[3]).sort()).toEqual(['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo']);
    expect(rows.map(r => r[3])).not.toContain('Far');
    const delta = rows.find(r => r[3] === 'Delta')!;
    expect(delta[1]).toBe('2');           // group size
    expect(delta[2]).toBe('6');           // 1-based CSV data row
    expect(delta[4]).toBe('S4');          // ID
    expect(delta.slice(-2)).toEqual(['S4', 'd']);   // the CSV's own columns
    const titles = [...proxPanel().querySelectorAll('.px-grid .tabulator-col-title, .px-grid .tabulator-col-content')].map(c => c.textContent);
    expect(titles.join('|')).toContain('Nearest (ft)');
    expect(status()).toMatch(/6 points read · 2 skipped · 5 points within the threshold of another · 2 groups/);
  });

  it('keeps same-id points from pairing but still grouping them through a third', async () => {
    await openWith();
    await vi.waitFor(() => expect(bodyRows()).toHaveLength(5));
    const sizes = Object.fromEntries(bodyRows().map(r => [r[3], r[1]]));
    expect(sizes.Charlie).toBe('3');
  });

  it('refuses a threshold outside the range and runs nothing', async () => {
    await openWith();
    await vi.waitFor(() => expect(bodyRows()).toHaveLength(5));
    await setThreshold('0.0001', 'km');
    expect(q('.px-msg').textContent).toMatch(/between 0\.01 km and 1,000 km/);
    expect(bodyRows()).toHaveLength(0);
    expect(status()).toBe('');
    await setThreshold('1', 'mi');
    expect(q('.px-msg').textContent).toBe('');
    await vi.waitFor(() => expect(bodyRows()).toHaveLength(5));
  });

  it('shows the nearest distance in the threshold unit', async () => {
    await openWith();
    await vi.waitFor(() => expect(bodyRows()).toHaveLength(5));
    const ft = bodyRows().find(r => r[3] === 'Alpha')![7]!;
    expect(Number(ft.replace(/,/g, ''))).toBeCloseTo(111.3 / 0.3048, -1);   // A–B, about 365 ft
    await setThreshold('1', 'km');
    await vi.waitFor(() => expect(bodyRows().find(r => r[3] === 'Alpha')![7]).toBe('0.111'));
  });

  it('refuses a file over 50 MB before reading and one over 100,000 points after parsing', async () => {
    await openWith(csvPoints(), csvFile(51 * 1048576));
    expect(mocks.pick).not.toHaveBeenCalled();
    expect(q('.px-msg').textContent).toMatch(/over 50 MB/);
    const many = csvPoints();
    mocks.pick.mockReset();
    many.features = Array.from({ length: 100_001 }, () => many.features[0]);
    await openWith(many);
    expect(q('.px-msg').textContent).toMatch(/100,001 points; the limit is 100,000/);
    expect(bodyRows()).toHaveLength(0);
  });

  it('writes nothing to storage and keeps no link or diagnostics trace', async () => {
    const set = vi.spyOn(Storage.prototype, 'setItem');
    const hash = location.hash;
    await openWith();
    await vi.waitFor(() => expect(bodyRows()).toHaveLength(5));
    await setThreshold('500', 'ft');
    closeProx();
    expect(set).not.toHaveBeenCalled();
    expect(location.hash).toBe(hash);
  });

  it('drops the file and cancels the pairs when the tab closes', async () => {
    const seen: unknown[] = [];
    const off = px.onProxResult(s => seen.push(s));
    await openWith();
    await vi.waitFor(() => expect(px.proxState()).not.toBeNull());
    expect(seen.at(-1)).toMatchObject({ km: expect.closeTo(1.609344, 6), unit: 'ft' });
    closeProx();
    expect(mocks.cancelPairs).toHaveBeenCalled();
    expect(px.proxState()).toBeNull();
    expect(seen.at(-1)).toBeNull();
    expect(proxPanel().childElementCount).toBe(0);
    off();
  });
});

describe('pairs', () => {
  const pairsBtn = () => q<HTMLButtonElement>('.px-views .px-view:last-child');

  it('lists every pair within the threshold, same-id pairs left out', async () => {
    await openWith();
    await vi.waitFor(() => expect(bodyRows()).toHaveLength(5));
    pairsBtn().click();
    await vi.waitFor(() => expect(bodyRows()).toHaveLength(3));
    const rows = bodyRows();
    expect(rows.map(r => [r[1], r[2]])).toEqual(expect.arrayContaining([['1', '2'], ['1', '4'], ['6', '8']]));
    expect(rows.some(r => r[1] === '2' && r[2] === '4')).toBe(false);   // Bravo–Charlie share a site
  });

  it('says where a truncated list stops, with the group and point counts', async () => {
    mocks.runPairs.mockResolvedValue({ ok: true, result: { a: Int32Array.of(0), b: Int32Array.of(1), km: Float64Array.of(0.1), truncated: true } as PairsResult });
    await openWith();
    await vi.waitFor(() => expect(bodyRows()).toHaveLength(5));
    pairsBtn().click();
    await vi.waitFor(() => expect(status()).toMatch(/stops at 1,000,000 pairs\. There are 2 groups holding 5 points; use a smaller threshold/));
  });

  it('shows progress and Cancel; Cancel stops the worker and returns to Groups', async () => {
    let progress: (n: number) => void = () => {};
    mocks.runPairs.mockImplementation((_a, _b, _c, o: { onProgress: (n: number) => void }) => { progress = o.onProgress; return new Promise(() => {}); });
    await openWith();
    await vi.waitFor(() => expect(bodyRows()).toHaveLength(5));
    pairsBtn().click();
    expect(q('.px-prog').hidden).toBe(false);
    progress(50_000);
    expect(q('.px-prog-text').textContent).toBe('50,000 pairs found…');
    mocks.cancelPairs.mockClear();
    q<HTMLButtonElement>('.px-cancel').click();
    expect(mocks.cancelPairs).toHaveBeenCalledOnce();
    expect(q('.px-prog').hidden).toBe(true);
    expect(q<HTMLButtonElement>('.px-views .px-view:first-child').getAttribute('aria-pressed')).toBe('true');
  });

  it('cancels running pairs on a threshold change and drops the stale result', async () => {
    const waiting: Array<(o: unknown) => void> = [];
    mocks.runPairs.mockImplementation(() => new Promise(res => { waiting.push(res); }));
    await openWith();
    await vi.waitFor(() => expect(bodyRows()).toHaveLength(5));
    pairsBtn().click();
    expect(waiting).toHaveLength(1);
    mocks.cancelPairs.mockClear();
    await setThreshold('6000', 'ft');
    expect(mocks.cancelPairs).toHaveBeenCalled();
    expect(waiting).toHaveLength(2);           // pairs re-run for the new threshold
    waiting[0]({ ok: true, result: { a: Int32Array.of(0, 0, 0), b: Int32Array.of(1, 2, 3), km: Float64Array.of(1, 1, 1), truncated: false } });
    await flush();
    expect(bodyRows()).toHaveLength(0);        // the stale answer was dropped
    waiting[1]({ ok: true, result: { a: Int32Array.of(0), b: Int32Array.of(1), km: Float64Array.of(0.1), truncated: false } });
    await vi.waitFor(() => expect(bodyRows()).toHaveLength(1));
  });
});

describe('CSV downloads', () => {
  it('writes row, coordinates, the CSV columns, group, group_size and nearest_<unit>, formula-guarded', async () => {
    await openWith();
    await vi.waitFor(() => expect(bodyRows()).toHaveLength(5));
    q<HTMLButtonElement>('.px-dl-groups').click();
    expect(mocks.downloads).toHaveLength(1);
    expect(mocks.downloads[0].name).toBe('sites-proximity-groups.csv');
    const lines = (await readBlob(mocks.downloads[0].blob)).trim().split('\r\n');
    expect(lines[0]).toBe('row,latitude,longitude,Site,Notes,group,group_size,nearest_ft');
    expect(lines).toHaveLength(6);
    const bravo = lines.find(l => l.includes(',S2,'))!;
    expect(bravo).toMatch(/^2,-?[\d.]+,-?[\d.]+,S2,'=1\+1,1,3,\d/);
    expect(lines.join('\n')).not.toContain('S3');   // the lone point is not listed
  });

  it('writes the pairs CSV with a_/b_ columns and a truncation note', async () => {
    mocks.runPairs.mockResolvedValue({ ok: true, result: { a: Int32Array.of(0, 4), b: Int32Array.of(1, 5), km: Float64Array.of(0.1113, 0.1112), truncated: true } as PairsResult });
    await openWith();
    await vi.waitFor(() => expect(bodyRows()).toHaveLength(5));
    q<HTMLButtonElement>('.px-dl-pairs').click();
    await vi.waitFor(() => expect(mocks.downloads).toHaveLength(1));
    const lines = (await readBlob(mocks.downloads[0].blob)).trim().split('\r\n');
    expect(lines[0]).toBe('group,a_row,b_row,a_id,b_id,a_name,b_name,distance_ft,a_latitude,a_longitude,b_latitude,b_longitude,a_Site,a_Notes,b_Site,b_Notes');
    expect(lines[1]).toMatch(/^1,1,2,S1,S2,Alpha,Bravo,365\.\d+(,-?[\d.]+){4},S1,a,S2,'=1\+1$/);
    expect(lines[2]).toMatch(/^2,6,8,S4,S5,Delta,Echo,/);
    expect(lines[3]).toMatch(/Pairs list stops at 1,000,000 pairs; 2 groups hold 5 points/);
  });
});

describe('review fixes', () => {
  const pairsBtn = () => q<HTMLButtonElement>('.px-views .px-view:last-child');

  it('converts the threshold when the unit changes (5,280 ft is 1 mi)', async () => {
    await openWith();
    await vi.waitFor(() => expect(bodyRows()).toHaveLength(5));
    q<HTMLSelectElement>('.px-unit').value = 'mi';
    q('.px-unit').dispatchEvent(new Event('change'));
    expect(q<HTMLInputElement>('.px-th-input').value).toBe('1');
    await new Promise(r => setTimeout(r, 300));
    await flush();
    expect(q('.px-msg').textContent).toBe('');
    expect(bodyRows()).toHaveLength(5);
  });

  it('asks the picker to refuse over 100,000 rows before it builds anything', async () => {
    await openWith();
    expect(mocks.pick).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ maxRows: 100_000, onTooMany: expect.any(Function) }));
    mocks.pick.mockImplementationOnce(async (_f: unknown, l: { onTooMany: (n: number) => void }) => { l.onTooMany(2_000_000); return null; });
    const input = q<HTMLInputElement>('.px-file');
    Object.defineProperty(input, 'files', { value: [csvFile()], configurable: true });
    input.dispatchEvent(new Event('change'));
    await flush();
    expect(q('.px-msg').textContent).toMatch(/2,000,000 points; the limit is 100,000/);
  });

  it('re-renders the labels, status and buttons when the language changes', async () => {
    await openWith();
    await vi.waitFor(() => expect(bodyRows()).toHaveLength(5));
    expect(q('.px-view').textContent).toBe('Groups');
    await loadDictionary('de');
    setLocale('de');
    try {
      emit('lang:changed', { locale: 'de' });
      expect(q('.px-view').textContent).toBe('Gruppen');
      expect(q('.px-choose').textContent).not.toBe('Choose a CSV file…');
      expect(status()).not.toMatch(/points read/);
      await vi.waitFor(() => {
        const titles = [...proxPanel().querySelectorAll('.px-grid .tabulator-col-title, .px-grid .tabulator-col-content')].map(c => c.textContent).join('|');
        expect(titles).not.toContain('Nearest (ft)');
        expect(titles).toContain('Gruppe');
      });
    } finally {
      setLocale('en');
    }
  });

  it('a row click selects and marks the row and does not fly', async () => {
    const rows: number[] = [], flies: number[] = [];
    const off = px.onProxRow(i => rows.push(i));
    const offFly = px.onProxFly(i => flies.push(i));
    await openWith();
    await vi.waitFor(() => expect(bodyRows()).toHaveLength(5));
    const cell = proxPanel().querySelectorAll<HTMLElement>('.px-grid .tabulator-row')[1].querySelector<HTMLElement>('.tabulator-cell:not(:first-child)')!;
    // jsdom has no layout: Tabulator re-runs a row's formatter only when offsetParent is set.
    Object.defineProperty(HTMLElement.prototype, 'offsetParent', { get() { return document.body; }, configurable: true });
    cell.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    delete (HTMLElement.prototype as { offsetParent?: unknown }).offsetParent;
    expect(rows).toHaveLength(1);
    expect(flies).toEqual([]);
    expect(proxPanel().querySelectorAll('.px-grid .px-focus')).toHaveLength(1);
    off(); offFly();
  });

  it('flies to a point from the row\'s button (keyboard reachable)', async () => {
    const rows: number[] = [], flies: number[] = [];
    const off = px.onProxRow(i => rows.push(i));
    const offFly = px.onProxFly(i => flies.push(i));
    await openWith();
    await vi.waitFor(() => expect(bodyRows()).toHaveLength(5));
    const btn = proxPanel().querySelector<HTMLButtonElement>('.px-grid .px-fly')!;
    expect(btn.tagName).toBe('BUTTON');
    expect(btn.getAttribute('aria-label')).toBe('Zoom to this point');
    btn.click();
    expect(rows).toHaveLength(1);
    expect(flies).toEqual(rows);
    off(); offFly();
  });

  it('a tap on a point brings the Proximity pane forward when another pane is in front', async () => {
    await openWith();
    await vi.waitFor(() => expect(bodyRows()).toHaveLength(5));
    const { openAsk } = await import('./ui-table.js');
    openAsk();
    expect(proxPanel().hidden).toBe(true);
    px.focusPoint(0);
    expect(proxPanel().hidden).toBe(false);
  });

  it('watches the grid for a show or resize so it can redraw', async () => {
    const watched: Element[] = [];
    vi.stubGlobal('ResizeObserver', class { observe(e: Element) { watched.push(e); } unobserve() {} disconnect() {} });
    px.openProximity();
    expect(watched).toContain(q('.px-grid'));
  });

  describe('Pairs CSV', () => {
    it('shows progress and Cancel from the Groups view, and a second click starts nothing', async () => {
      let progress: (n: number) => void = () => {};
      mocks.runCsv.mockImplementation((_i: unknown, o: { onProgress: (n: number) => void }) => { progress = o.onProgress; return new Promise(() => {}); });
      await openWith();
      await vi.waitFor(() => expect(bodyRows()).toHaveLength(5));
      q<HTMLButtonElement>('.px-dl-pairs').click();
      await vi.waitFor(() => expect(mocks.runCsv).toHaveBeenCalledOnce());
      progress(10_000);
      expect(q('.px-prog').hidden).toBe(false);
      expect(q('.px-prog-text').textContent).toMatch(/Building the CSV… 10,000 of 3 rows/);
      expect(q<HTMLButtonElement>('.px-dl-pairs').disabled).toBe(true);
      q<HTMLButtonElement>('.px-dl-pairs').click();
      await flush();
      expect(mocks.runCsv).toHaveBeenCalledOnce();
      expect(mocks.runPairs).toHaveBeenCalledOnce();
      q<HTMLButtonElement>('.px-cancel').click();
      expect(mocks.cancelCsv).toHaveBeenCalled();
      expect(q('.px-prog').hidden).toBe(true);
    });

    it('shows the pairs finder\'s progress while a download waits for the pairs, with Cancel', async () => {
      let stop: (o: unknown) => void = () => {};
      mocks.runPairs.mockImplementation(() => new Promise(r => { stop = r; }));
      mocks.cancelPairs.mockImplementation(() => stop({ ok: false, reason: 'cancelled' }));
      await openWith();
      await vi.waitFor(() => expect(bodyRows()).toHaveLength(5));
      q<HTMLButtonElement>('.px-dl-pairs').click();
      await flush();
      expect(q('.px-prog').hidden).toBe(false);
      q<HTMLButtonElement>('.px-cancel').click();
      expect(mocks.cancelPairs).toHaveBeenCalled();
      expect(q('.px-prog').hidden).toBe(true);
      await vi.waitFor(() => expect(q<HTMLButtonElement>('.px-dl-pairs').disabled).toBe(false));
    });

    it('says the CSV is too big when the worker reports bytes over the limit', async () => {
      mocks.runCsv.mockResolvedValue({ ok: false, reason: 'tooBig', bytes: 300 * 1048576 });
      await openWith();
      await vi.waitFor(() => expect(bodyRows()).toHaveLength(5));
      q<HTMLButtonElement>('.px-dl-pairs').click();
      await vi.waitFor(() => expect(q('.px-msg').textContent).toMatch(/about 300 MB, over the 200 MB limit/));
      expect(mocks.downloads).toHaveLength(0);
    });

    it('labels the download buttons without the arrow for a screen reader', async () => {
      await openWith();
      expect(q('.px-dl-pairs').getAttribute('aria-label')).toBe('Pairs CSV');
    });
  });

  describe('Try a sample', () => {
    const bounds = { getWest: () => -100, getSouth: () => 30, getEast: () => -90, getNorth: () => 40 };
    const ok = {
      kind: 'ok', lon: Float64Array.of(-95, -95.0001, -92), lat: Float64Array.of(35, 35, 36),
      props: [['Alpha', '101', '345', '300-400'], ['Beta', '102', '230', '200-300'], ['Gamma', '103', '138', '100-200']],
    };
    beforeEach(() => { (state as { map: unknown }).map = { getBounds: () => bounds }; });

    it('cuts to the view, feeds the file path at 1 mi with names and ids, and credits HIFLD', async () => {
      mocks.runSample.mockResolvedValue(ok);
      px.openProximity();
      q<HTMLButtonElement>('.px-sample').click();
      await vi.waitFor(() => expect(bodyRows()).toHaveLength(2));
      expect(mocks.runSample).toHaveBeenCalledWith(expect.stringContaining('hifld_substations.geojson.gz'), { w: -100, s: 30, e: -90, n: 40 }, 15_000);
      expect(q<HTMLInputElement>('.px-th-input').value).toBe('1');
      expect(q<HTMLSelectElement>('.px-unit').value).toBe('mi');
      expect(q('.px-filename').textContent).toBe('HIFLD substations (static copy) in the current view');
      expect(bodyRows().map(r => r[3]).sort()).toEqual(['Alpha', 'Beta']);
      expect(bodyRows().map(r => r[4]).sort()).toEqual(['101', '102']);
      const credit = q('.px-credit');
      expect(credit.hidden).toBe(false);
      expect(credit.querySelector('a')!.textContent).toBe('HIFLD');
      expect(credit.querySelector('a')!.getAttribute('href')).toMatch(/^https:/);
      q<HTMLButtonElement>('.px-dl-groups').click();
      expect(mocks.downloads[0].name).toBe('hifld-substations-sample-proximity-groups.csv');
    });

    it('says zoom in above the cap, none in view at zero, and a failure; none loads a file', async () => {
      px.openProximity();
      mocks.runSample.mockResolvedValueOnce({ kind: 'tooMany', n: 20_000 });
      q<HTMLButtonElement>('.px-sample').click();
      await vi.waitFor(() => expect(q('.px-msg').textContent).toMatch(/20,000 substations are in view; zoom in to 15,000 or fewer/));
      mocks.runSample.mockResolvedValueOnce({ kind: 'none' });
      q<HTMLButtonElement>('.px-sample').click();
      await vi.waitFor(() => expect(q('.px-msg').textContent).toBe('No substations in view.'));
      mocks.runSample.mockResolvedValueOnce({ kind: 'failed' });
      q<HTMLButtonElement>('.px-sample').click();
      await vi.waitFor(() => expect(q('.px-msg').textContent).toBe('The sample could not be loaded.'));
      expect(px.proxState()).toBeNull();
      expect(q('.px-credit').hidden).toBe(true);
    });

    it('shows progress with Cancel while loading; Cancel stops the worker and drops its answer', async () => {
      let done: (o: unknown) => void = () => {};
      mocks.runSample.mockImplementation(() => new Promise(r => { done = r; }));
      px.openProximity();
      q<HTMLButtonElement>('.px-sample').click();
      expect(q('.px-prog').hidden).toBe(false);
      expect(q('.px-prog-text').textContent).toBe('Loading the substations in view…');
      expect(q<HTMLButtonElement>('.px-sample').disabled).toBe(true);
      q<HTMLButtonElement>('.px-cancel').click();
      expect(mocks.cancelSample).toHaveBeenCalled();
      expect(q('.px-prog').hidden).toBe(true);
      done(ok);
      await flush();
      expect(px.proxState()).toBeNull();
    });

    it('writes nothing to storage', async () => {
      const set = vi.spyOn(Storage.prototype, 'setItem');
      mocks.runSample.mockResolvedValue(ok);
      px.openProximity();
      q<HTMLButtonElement>('.px-sample').click();
      await vi.waitFor(() => expect(bodyRows()).toHaveLength(2));
      closeProx();
      expect(set).not.toHaveBeenCalled();
    });
  });
});

describe('sort and filter', () => {
  const headBtn = (label: string) => [...proxPanel().querySelectorAll<HTMLButtonElement>('.px-head')].find(b => b.textContent!.trim().startsWith(label))!;
  const filterBox = (label: string) => headBtn(label).parentElement!.querySelector<HTMLInputElement>('.px-filter')!;
  const names = () => bodyRows().map(r => r[3]);
  const type = async (label: string, v: string) => {
    const i = filterBox(label);
    i.value = v;
    i.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 260));
    await flush();
  };
  const ready = async () => { await openWith(); await vi.waitFor(() => expect(bodyRows()).toHaveLength(5)); };

  it('cycles Name ascending, descending, off, with the arrow and aria-sort on the header', async () => {
    await ready();
    const base = names();
    headBtn('Name').click();
    await vi.waitFor(() => expect(names()).toEqual(['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo']));
    expect(headBtn('Name').textContent).toContain('▲');
    expect(headBtn('Name').closest('.tabulator-col')!.getAttribute('aria-sort')).toBe('ascending');
    headBtn('Name').click();
    await vi.waitFor(() => expect(names()).toEqual(['Echo', 'Delta', 'Charlie', 'Bravo', 'Alpha']));
    expect(headBtn('Name').textContent).toContain('▼');
    expect(headBtn('Name').closest('.tabulator-col')!.getAttribute('aria-sort')).toBe('descending');
    headBtn('Name').click();
    await vi.waitFor(() => expect(names()).toEqual(base));
    expect(headBtn('Name').textContent).not.toMatch(/[▲▼]/);
    expect(headBtn('Name').closest('.tabulator-col')!.getAttribute('aria-sort')).toBe('none');
  });

  it('sorts Nearest by number, not text', async () => {
    await ready();
    headBtn('Group size').click();
    await vi.waitFor(() => expect(bodyRows().map(r => r[1])).toEqual(['2', '2', '3', '3', '3']));
    headBtn('Nearest').click();
    await vi.waitFor(() => {
      const v = bodyRows().map(r => Number(r[7]!.replace(/,/g, '')));
      expect(v).toEqual([...v].sort((a, b) => a - b));
    });
    headBtn('Nearest').click();
    await vi.waitFor(() => {
      const v = bodyRows().map(r => Number(r[7]!.replace(/,/g, '')));
      expect(v).toEqual([...v].sort((a, b) => b - a));
    });
  });

  it('filters by contains, says how many rows are shown, and Clear filters restores them', async () => {
    await ready();
    expect(proxPanel().querySelector<HTMLButtonElement>('.px-clear')!.hidden).toBe(true);
    await type('Name', 'brav');
    await vi.waitFor(() => expect(names()).toEqual(['Bravo']));
    expect(status()).toContain('1 of 5 rows shown');
    expect(q<HTMLButtonElement>('.px-clear').hidden).toBe(false);
    await type('Name', 'zzz');
    await vi.waitFor(() => expect(bodyRows()).toHaveLength(0));
    expect(status()).toContain('No rows match the filters');
    q<HTMLButtonElement>('.px-clear').click();
    await vi.waitFor(() => expect(bodyRows()).toHaveLength(5));
    expect(filterBox('Name').value).toBe('');
    expect(q<HTMLButtonElement>('.px-clear').hidden).toBe(true);
    expect(status()).not.toContain('rows shown');
  });

  it('keeps sort and filter across a threshold change and resets them on a new file', async () => {
    await ready();
    await type('Name', 'a');
    headBtn('Name').click();
    await vi.waitFor(() => expect(names()).toEqual(['Alpha', 'Bravo', 'Charlie', 'Delta']));
    await setThreshold('6000', 'ft');
    await vi.waitFor(() => expect(names()).toEqual(['Alpha', 'Bravo', 'Charlie', 'Delta']));
    expect(filterBox('Name').value).toBe('a');
    expect(headBtn('Name').textContent).toContain('▲');
    mocks.pick.mockResolvedValueOnce(csvPoints());
    const input = q<HTMLInputElement>('.px-file');
    Object.defineProperty(input, 'files', { value: [csvFile()], configurable: true });
    input.dispatchEvent(new Event('change'));
    await flush(); await flush();
    await vi.waitFor(() => expect(bodyRows()).toHaveLength(5));
    expect(filterBox('Name').value).toBe('');
    expect(headBtn('Name').textContent).not.toMatch(/[▲▼]/);
  });

  it('keeps the typing focus and text across a render', async () => {
    await ready();
    const i = filterBox('Name');
    i.focus();
    i.value = 'al';
    i.dispatchEvent(new Event('input', { bubbles: true }));
    emit('lang:changed', { locale: 'en' });
    await flush();
    expect(document.activeElement).toBe(i);
    expect(filterBox('Name')).toBe(i);
    expect(i.value).toBe('al');
    await new Promise(r => setTimeout(r, 260));
    await vi.waitFor(() => expect(names()).toEqual(['Alpha']));
    expect(filterBox('Name')).toBe(i);
    expect(document.activeElement).toBe(i);
  });

  it('stops header keys from reaching the drawer; Escape clears a filled box and passes through an empty one', async () => {
    await ready();
    const i = filterBox('Name');
    const seen: string[] = [];
    proxPanel().addEventListener('keydown', e => seen.push(e.key));
    i.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
    expect(seen).toEqual([]);
    await type('Name', 'brav');
    await vi.waitFor(() => expect(names()).toEqual(['Bravo']));
    const esc = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    i.dispatchEvent(esc);
    expect(esc.defaultPrevented).toBe(true);
    expect(seen).toEqual([]);
    expect(i.value).toBe('');
    await vi.waitFor(() => expect(bodyRows()).toHaveLength(5));
    i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(seen).toEqual(['Escape']);
  });

  it('applies every box typed within the debounce window', async () => {
    await ready();
    for (const [l, v] of [['Name', 'ch'], ['Group', '1']] as const) {
      const i = filterBox(l);
      i.value = v;
      i.dispatchEvent(new Event('input', { bubbles: true }));
    }
    await new Promise(r => setTimeout(r, 260));
    await vi.waitFor(() => expect(names()).toEqual(['Charlie']));
    expect(status()).toContain('1 of 5 rows shown');
  });

  it('a filter typed in Groups stays in Groups when Pairs is opened at once', async () => {
    await ready();
    const i = filterBox('Name');
    i.value = 'brav';
    i.dispatchEvent(new Event('input', { bubbles: true }));
    q<HTMLButtonElement>('.px-views .px-view:last-child').click();
    await vi.waitFor(() => expect(bodyRows()).toHaveLength(3));
    await new Promise(r => setTimeout(r, 260));
    expect(bodyRows()).toHaveLength(3);
    expect(q<HTMLButtonElement>('.px-clear').hidden).toBe(true);
    q<HTMLButtonElement>('.px-views .px-view:first-child').click();
    await vi.waitFor(() => expect(names()).toEqual(['Bravo']));
  });

  it('a sort over more than 100,000 pairs is not lost when another render lands before it runs', async () => {
    const n = 100_001;
    const km = Float64Array.from({ length: n }, (_, k) => (n - k) * 0.01);
    mocks.runPairs.mockResolvedValue({ ok: true, result: { a: Int32Array.from({ length: n }, (_, k) => k % 5), b: new Int32Array(n).fill(5), km, truncated: false } as PairsResult });
    await ready();
    q<HTMLButtonElement>('.px-views .px-view:last-child').click();
    await vi.waitFor(() => expect(headBtn('Distance')).toBeTruthy());
    await vi.waitFor(() => expect(bodyRows().length).toBeGreaterThan(0));
    const dist = () => Number(bodyRows()[0].at(-1)!.replace(/,/g, ''));
    const before = dist();
    headBtn('Distance').click();
    q<HTMLButtonElement>('.px-dl-pairs').click();
    await vi.waitFor(() => expect(dist()).toBeLessThan(before), { timeout: 5000 });
    expect(status()).not.toContain('Updating');
  }, 20_000);

  it('a sorted Pairs view over a truncated list says it covers only those pairs', async () => {
    mocks.runPairs.mockResolvedValue({ ok: true, result: { a: Int32Array.of(0, 4), b: Int32Array.of(1, 5), km: Float64Array.of(0.1113, 0.1112), truncated: true } as PairsResult });
    await ready();
    q<HTMLButtonElement>('.px-views .px-view:last-child').click();
    await vi.waitFor(() => expect(bodyRows()).toHaveLength(2));
    expect(status()).not.toContain('Sorting and filtering cover only');
    headBtn('Name A').click();
    await vi.waitFor(() => expect(status()).toContain('Sorting and filtering cover only these 1,000,000 pairs'));
    headBtn('Name A').click();
    headBtn('Name A').click();
    await vi.waitFor(() => expect(status()).not.toContain('Sorting and filtering cover only'));
    await type('Name B', 'echo');
    await vi.waitFor(() => expect(bodyRows()).toHaveLength(1));
    expect(status()).toContain('1 of 2 rows shown');
    expect(status()).toContain('Sorting and filtering cover only');
  });

  it('draws every cell and header as nodes: markup in a CSV value stays text', async () => {
    const rows = ROWS.map((r, i) => i === 0 ? { ...r, note: '<b>x</b>', name: '<i>Alpha</i>' } : r);
    await openWith(csvPoints(rows));
    await vi.waitFor(() => expect(bodyRows()).toHaveLength(5));
    const grid = proxPanel().querySelector('.px-grid')!;
    expect(grid.querySelector('.tabulator-cell b, .tabulator-cell i')).toBeNull();
    expect(grid.textContent).toContain('<b>x</b>');
    expect(grid.querySelectorAll('.tabulator-col .px-head-wrap').length).toBeGreaterThan(5);
    expect(grid.querySelectorAll('.tabulator-col input.px-filter').length).toBe(grid.querySelectorAll('.tabulator-col .px-head').length);
  });

  it('leaves both CSV downloads as the full result in their own order', async () => {
    await ready();
    q<HTMLButtonElement>('.px-dl-groups').click();
    const plain = await readBlob(mocks.downloads[0].blob);
    expect(q('.px-csv-note').textContent).toBe('');
    headBtn('Name').click();
    headBtn('Name').click();
    await type('Name', 'brav');
    await vi.waitFor(() => expect(bodyRows()).toHaveLength(1));
    expect(q('.px-csv-note').textContent).toContain('full result');
    q<HTMLButtonElement>('.px-dl-groups').click();
    expect(await readBlob(mocks.downloads[1].blob)).toBe(plain);
    q<HTMLButtonElement>('.px-dl-pairs').click();
    await vi.waitFor(() => expect(mocks.downloads).toHaveLength(3));
    expect((await readBlob(mocks.downloads[2].blob)).trim().split('\r\n')).toHaveLength(4);
  });
});

describe('range copy', () => {
  const headBtn = (label: string) => [...proxPanel().querySelectorAll<HTMLButtonElement>('.px-head')].find(b => b.textContent!.trim().startsWith(label))!;
  const cellAt = (row: number, f: number) => proxPanel().querySelectorAll('.px-grid .tabulator-row')[row].querySelector<HTMLElement>(`.tabulator-cell[tabulator-field="f${f}"]`)!;
  const mouse = (e: Element, type: string) => e.dispatchEvent(new MouseEvent(type, { bubbles: true, button: 0 }));
  const drag = (r0: number, f0: number, r1: number, f1: number) => {
    mouse(cellAt(r0, f0), 'mousedown'); mouse(cellAt(r1, f1), 'mousemove');
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  };
  const key = (k: string, o: KeyboardEventInit = {}) => proxPanel().querySelector('.px-grid .tabulator-tableholder')!.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...o }));
  const nameField = () => { const b = headBtn('Name'); const c = b.closest('.tabulator-col')!; return Number(c.getAttribute('tabulator-field')!.slice(1)); };
  const ready = async () => { await openWith(); await vi.waitFor(() => expect(bodyRows()).toHaveLength(5)); };

  it('copies a dragged range as a header line and rows, formula-guarded, in view order', async () => {
    await ready();
    const n = nameField();
    headBtn('Name').click();
    headBtn('Name').click();
    await vi.waitFor(() => expect(bodyRows()[0][n - 1]).toBe('Echo'));
    drag(0, n, 2, n);
    key('c', { ctrlKey: true });
    expect(mocks.copied).toHaveLength(1);
    expect(mocks.copied[0].split('\n')).toEqual(['Name', 'Echo', 'Delta', 'Charlie']);
    expect(q('.px-status').textContent).toContain('Copied 3 rows');
  });

  it('guards a formula and keeps full-precision numbers', async () => {
    await ready();
    const lat = [...proxPanel().querySelectorAll('.px-head')].map(b => b.textContent!.trim());
    expect(lat.length).toBeGreaterThan(3);
    drag(0, 1, 4, lat.length);
    key('c', { metaKey: true });
    const lines = mocks.copied[0].split('\n');
    expect(lines).toHaveLength(6);
    expect(lines[0].split('\t')).toHaveLength(lat.length);
    expect(mocks.copied[0]).toContain("'=1+1");
    expect(mocks.copied[0]).toMatch(/\t0\.001\t/);
  });

  it('writes nothing to storage, the URL or the console', async () => {
    const spies = (['log', 'warn', 'error', 'info', 'debug'] as const).map(m => vi.spyOn(console, m).mockImplementation(() => {}));
    const url = location.href;
    await ready();
    drag(0, 1, 1, 2);
    key('c', { ctrlKey: true });
    expect(mocks.copied).toHaveLength(1);
    const secret = mocks.copied[0].split('\n')[1].split('\t')[1];
    for (const st of [localStorage, sessionStorage]) for (let i = 0; i < st.length; i++) expect(st.getItem(st.key(i)!) ?? '').not.toContain(secret || '\u0000x');
    expect(location.href).toBe(url);
    for (const s of spies) expect(s.mock.calls).toEqual([]);
  });

  it('keeps the range through a status change and a resize of a visible grid', async () => {
    let fire: () => void = () => {};
    vi.stubGlobal('ResizeObserver', class { constructor(cb: () => void) { fire = cb; } observe() {} unobserve() {} disconnect() {} });
    await ready();
    fire(); await new Promise(r => setTimeout(r, 50));
    drag(0, 1, 2, 2);
    key('c', { ctrlKey: true });
    expect(mocks.copied).toHaveLength(1);
    fire(); await new Promise(r => setTimeout(r, 50));
    fire(); await new Promise(r => setTimeout(r, 50));
    key('c', { ctrlKey: true });
    expect(mocks.copied).toHaveLength(2);
    expect(mocks.copied[1]).toBe(mocks.copied[0]);
  });

  it('Enter on the grid does not fly or reach the drawer', async () => {
    await ready();
    const fly = vi.fn(), row = vi.fn();
    px.onProxFly(fly); px.onProxRow(row);
    drag(1, 1, 1, 2);
    const outer = vi.fn();
    document.addEventListener('keydown', outer);
    key('Enter');
    document.removeEventListener('keydown', outer);
    expect(fly).not.toHaveBeenCalled();
    expect(outer).not.toHaveBeenCalled();
  });
});
