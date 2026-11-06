// @vitest-environment jsdom
// Tests for the Batch view: a refused file and skipped rows are said in words; the options reach runBatch (alternatives,
// exact points, snap radius, cube version and sha256 from grid.json); progress rows land as the runner reports them with
// worded reasons; Cancel and Back reach the runner; the busy refusal is worded; Download ZIP builds the archive on click;
// ui-route.ts never imports this module statically (the production bundle takes no batch/jsPDF chunk).
// Deps: route-batch.js; route-batch-run.js (runBatch mocked, wording real), route-batch-map.js / substation-index.js /
//       route-batch-pdf.js / user-data-export.js (downloadFile) mocked; i18n.
import { describe, it, expect, beforeEach, vi, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { t, loadRouteStrings } from '../../src/i18n/index.js';
import type { BatchOptions, BatchDeps, BatchOutcome, RowReport } from './route-batch-run.js';

const run = vi.hoisted(() => ({
  opts: null as null | BatchOptions, deps: null as null | BatchDeps,
  finish: null as null | ((o: BatchOutcome) => void), cancel: vi.fn(), calls: 0,
}));
vi.mock('./route-batch-run.js', async (orig) => ({
  ...(await orig<typeof import('./route-batch-run.js')>()),
  workerSolver: () => ({}),
  runBatch: (o: BatchOptions, d: BatchDeps) => {
    run.opts = o; run.deps = d; run.calls++;
    return { cancel: run.cancel, done: new Promise<BatchOutcome>((res) => { run.finish = res; }) };
  },
}));
const capClose = vi.hoisted(() => vi.fn());
vi.mock('./route-batch-map.js', () => ({ createBatchCapture: () => Object.assign(async () => ({ note: 'x' }), { close: capClose }) }));
const index = vi.hoisted(() => ({ ok: true }));
vi.mock('./substation-index.js', () => ({
  ensureSubstationIndex: async () => index.ok ? { ok: true, result: { subs: [] } } : { ok: false, reason: 'nope' },
}));
vi.mock('./route-batch-pdf.js', () => ({ renderPdf: async () => new Uint8Array() }));
const dl = vi.hoisted(() => vi.fn());
vi.mock('../user-data/user-data-export.js', async (orig) => ({ ...(await orig<typeof import('../user-data/user-data-export.js')>()), downloadFile: dl }));

import { mountBatch, cubeInfo } from './route-batch.js';

beforeAll(() => loadRouteStrings());

const CSV = 'key,a_lat,a_lon,b_lat,b_lon\nReno,39.5,-119.8,40.0,-119.0\nBoise,43.6,-116.2,44.0,-116.0\nBad,99,-119.8,40.0,-119.0\n';
const flush = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0)); };
let root: HTMLElement;
let closed: number;

function mount() {
  root = document.createElement('div');
  document.body.append(root);
  closed = 0;
  return mountBatch(root, {
    presetId: 'tm-default', patch: null, lineType: 'ac345', snapKm: 5, methodLabel: 'Default', saved: () => [], close: () => { closed++; },
  });
}
async function choose(text: string, name = 'pairs.csv') {
  const input = root.querySelector<HTMLInputElement>('input[type=file]')!;
  const file = new File([text], name, { type: 'text/csv' });
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  input.dispatchEvent(new Event('change'));
  await flush();
}
const msg = () => root.querySelector('.rb-msg')!.textContent;
const click = (sel: string) => root.querySelector<HTMLButtonElement>(sel)!.click();
const okRow = (key: string): RowReport => ({ line: 2, key, status: 'ok', folder: `rows/001-${key}`, pictures: [{ picture: 'cost', note: 'not available (area too large)', code: 'no-window' }] });

beforeEach(() => {
  document.body.replaceChildren();
  Object.assign(run, { opts: null, deps: null, finish: null, calls: 0 });
  run.cancel.mockClear(); dl.mockClear(); capClose.mockClear();
  index.ok = true;
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ version: 8, crs: 'EPSG:5070' }))));
});

describe('Batch view', () => {
  it('says why a file is refused and lists skipped rows in words', async () => {
    mount();
    await choose('key,nope\n1,2\n');
    expect(msg()).toBe(t('route.batch.refused', { reason: t('route.batch.csv.unknownCol', { name: 'nope' }) }));
    expect(root.querySelector<HTMLElement>('.rb-go')!.hidden).toBe(true);
    await choose(CSV);
    expect(msg()).toBe(t('route.batch.ready', { n: 2, s: 1 }));
    expect(root.querySelector('.rb-skips li')!.textContent).toContain('Line 4');
    expect(root.querySelector<HTMLElement>('.rb-go')!.hidden).toBe(false);
    await choose('key,a_lat,a_lon,b_lat,b_lon\n');
    expect(msg()).toBe('The file has no usable rows.');
  });

  it('runs with the pane\'s method, snap radius, chosen alternatives and the cube identity from grid.json', async () => {
    mount();
    await choose(CSV);
    root.querySelector<HTMLSelectElement>('.rb-alts')!.value = '2';
    click('.rb-go');
    await flush();
    expect(run.opts).toMatchObject({ presetId: 'tm-default', lineType: 'ac345', snapKm: 5, alternatives: 2 });
    expect(run.opts!.rows.map((r) => r.key)).toEqual(['Reno', 'Boise']);
    expect(run.opts!.skipped).toHaveLength(1);
    expect(run.opts!.index).not.toBeNull();
    expect(run.opts!.cube?.version).toBe(8);
    expect(run.opts!.cube?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(root.querySelector<HTMLButtonElement>('.rb-pick')!.disabled).toBe(true);
    expect(root.querySelector<HTMLButtonElement>('.rb-back')!.disabled).toBe(true);
    expect(root.querySelector<HTMLElement>('.rb-note:not(.rb-intro)')).not.toBeNull();
    run.finish!({ status: 'done', rows: [] });
  });

  it('"Use the exact points" passes a null snap radius and no index', async () => {
    mount();
    await choose(CSV);
    root.querySelector<HTMLInputElement>('.rb-opts input[type=checkbox]')!.click();
    click('.rb-go');
    await flush();
    expect(run.opts).toMatchObject({ snapKm: null, index: null });
    run.finish!({ status: 'done', rows: [] });
  });

  it('a substation list that cannot load stops before the runner', async () => {
    index.ok = false;
    mount();
    await choose(CSV);
    click('.rb-go');
    await flush();
    expect(run.calls).toBe(0);
    expect(msg()).toBe(t('route.batch.noIndex'));
    expect(root.querySelector<HTMLButtonElement>('.rb-go')!.disabled).toBe(false);
  });

  it('shows a row per report with worded reasons, finishes with Download ZIP and builds the archive on click', async () => {
    mount();
    await choose(CSV);
    click('.rb-go');
    await flush();
    run.deps!.onRow!(okRow('Reno'), 1, 2);
    run.deps!.onRow!({ line: 3, key: 'Boise', status: 'failed', reason: 'upload not loaded' }, 2, 2);
    const cells = [...root.querySelectorAll('.rb-table tbody tr')].map((tr) => [...tr.children].map((c) => c.textContent));
    expect(cells[0]).toEqual(['Reno', t('route.batch.st.ok'), `${t('route.batch.pic.cost')}: not available (area too large)`]);
    expect(cells[1]).toEqual(['Boise', t('route.batch.st.failed'), t('route.batch.why.upload')]);
    expect(root.querySelector('progress')!.value).toBe(2);
    run.deps!.zip.add('summary.csv', 'a');
    run.finish!({ status: 'done', rows: [okRow('Reno')] });
    await flush();
    expect(msg()).toBe('Finished: 1 of 2 routes.');
    const btn = root.querySelector<HTMLButtonElement>('.rb-download')!;
    expect(btn.hidden).toBe(false);
    btn.click();
    await flush();
    expect(dl).toHaveBeenCalledOnce();
    expect(dl.mock.calls[0][1]).toBe('route-batch.zip');
    expect(dl.mock.calls[0][0].byteLength ?? dl.mock.calls[0][0].length).toBeGreaterThan(20);
  });

  it('Cancel reaches the runner and the finished rows can still be downloaded', async () => {
    mount();
    await choose(CSV);
    click('.rb-go');
    await flush();
    click('.rb-cancel');
    expect(run.cancel).toHaveBeenCalledOnce();
    run.finish!({ status: 'cancelled', reason: 'cancelled', rows: [okRow('Reno'), { line: 3, key: 'Boise', status: 'cancelled', reason: 'cancelled' }] });
    await flush();
    expect(msg()).toBe(t('route.batch.cancelledDone', { ok: 1, total: 2 }));
    expect(root.querySelector<HTMLElement>('.rb-download')!.hidden).toBe(false);
  });

  it('a busy engine is refused with the worded string and no download', async () => {
    mount();
    await choose(CSV);
    click('.rb-go');
    await flush();
    run.finish!({ status: 'busy', reason: 'busy', rows: [] });
    await flush();
    expect(msg()).toBe(t('route.batch.why.busy'));
    expect(root.querySelector<HTMLElement>('.rb-download')!.hidden).toBe(true);
  });

  it('a stopped batch names the reason; Back leaves the view and disposing cancels a running batch', async () => {
    const view = mount();
    await choose(CSV);
    click('.rb-go');
    await flush();
    run.finish!({ status: 'stopped', reason: 'zip-over-1gib', rows: [okRow('Reno')] });
    await flush();
    expect(msg()).toBe(t('route.batch.stopped', { ok: 1, total: 2, why: t('route.batch.why.zip') }));
    click('.rb-back');
    expect(closed).toBe(1);
    expect(root.children).toHaveLength(0);
    const v2 = mount();
    await choose(CSV);
    click('.rb-go');
    await flush();
    v2.dispose();
    expect(run.cancel).toHaveBeenCalled();
    void view;
  });

  it('cubeInfo is null when grid.json cannot be read', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('x', { status: 404 })));
    expect(await cubeInfo()).toBeNull();
  });
});

describe('validator reasons (real wording)', () => {
  it('carry their numbers', async () => {
    const { uploadReason } = await import('./route-tabs/method.js');
    expect(uploadReason('uploaded layer: more than 1000 polygon parts')).toBe('More than 1000 polygon parts.');
    expect(uploadReason('presetPatch.add_rows[0].label must be 1–60 characters')).toBe('The layer name must be 1–60 characters.');
    expect(uploadReason('presetPatch.add_rows[1].route_w must be a number in [0.1, 1000]')).toBe('Routing weight must be a number from 0.1 to 1000.');
    expect(uploadReason('presetPatch.add_rows[1].cost_x must be a number in [0.5, 5]')).toBe('Cost × must be a number from 0.5 to 5.');
  });
});

describe('lazy only', () => {
  it('ui-route.ts reaches the batch view only through a dynamic import; nothing else imports it', () => {
    const src = readFileSync('assets/ui/ui-route.ts', 'utf8');
    expect(src).not.toMatch(/^\s*import\b[^\n]*['"]\.\/route-batch[\w-]*\.js['"]/m);
    expect(src).not.toMatch(/^\s*export\b[^\n]*from\s+['"]\.\/route-batch/m);
    expect(src).toMatch(/import\('\.\/route-batch\.js'\)/);
  });
});
