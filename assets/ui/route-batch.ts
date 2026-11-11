// ─── Route panel: the Batch view ─────────────────────────────────────────────
// Role: the batch view, shown in the pane's `.rp-main` by ui-route.ts's Batch… action: choose a CSV
//       (route/batch-csv.ts checks it; a refused file or skipped row is said in words), options (alternatives per
//       route, "use the exact points"), Run → route-batch-run.ts `runBatch` under the solver lock with the worker
//       solver, the hidden-map capture, the dynamically imported PDF renderer and a ZIP sink; a progress bar and a
//       table row per finished row (reason codes worded through `reasonText`); Cancel keeps the finished rows;
//       Download ZIP builds the archive on click. A second batch, or any other holder of the lock, is refused with
//       the `busy` wording. Ends snap as a map click (the HIFLD index from substation-index.ts, the pane's snap
//       radius) unless "Use the exact points" is on; the cube version and sha256 come from grid.json (fetched
//       here, hashed with Web Crypto). Text-only DOM, no
//       innerHTML. Session only: nothing goes in the link, storage or the undo stack.
//       Lazy chunk: ui-route.ts imports this module dynamically only; jsPDF stays behind route-batch-pdf.ts's own
//       dynamic import, so neither reaches the boot bundle.
// Deps: route-batch.css, route-batch-run.ts (runBatch, workerSolver, reasonText, noteText), route-batch-map.ts
//       (createBatchCapture), route-batch-zip.ts (createZipSink), route-batch-pdf.ts (dynamic), substation-index.ts,
//       route/batch-csv.ts, route/custom-presets.ts (type), route/preset-patch.ts (type), user-data-export.ts
//       (downloadFile), i18n (t).

import './route-batch.css';
import { t } from '../../src/i18n/index.js';
import { DATA } from '../constants.js';
import { MAX_BATCH_BYTES, parseBatchCsv, type BatchParse } from '../route/batch-csv.js';
import type { CustomPreset } from '../route/custom-presets.js';
import type { PresetPatch } from '../route/preset-patch.js';
import type { SubstationIndex } from '../route/snap.js';
import { downloadFile } from '../user-data/user-data-export.js';
import { ensureSubstationIndex } from './substation-index.js';
import { createBatchCapture } from './route-batch-map.js';
import { createZipSink } from './route-batch-zip.js';
import { reasonText, runBatch, workerSolver, type BatchOutcome, type RowReport } from './route-batch-run.js';
import { h } from '../utils/utils-dom.js';

export interface BatchHost {
  presetId: string;
  patch: PresetPatch | null;
  lineType: string;
  snapKm: number;
  methodLabel: string;
  saved: () => CustomPreset[];
  /** Leave the view (the pane shows its own again). */
  close: () => void;
}

const CUBE_URL = DATA.route_cube + 'grid.json';
const MAX_SKIP_LINES = 50;

/** The cube's grid.json version and the sha256 of its bytes; null when it cannot be read. */
export async function cubeInfo(): Promise<{ version: number; sha256: string } | null> {
  try {
    const res = await fetch(new URL(CUBE_URL, document.baseURI).href);
    if (!res.ok) return null;
    const bytes = new Uint8Array(await res.arrayBuffer());
    const version = (JSON.parse(new TextDecoder().decode(bytes)) as { version?: unknown }).version;
    if (typeof version !== 'number') return null;
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    return { version, sha256: [...digest].map((b) => b.toString(16).padStart(2, '0')).join('') };
  } catch { return null; }
}

export function mountBatch(root: HTMLElement, host: BatchHost): { dispose(): void } {
  const wrap = h('div', 'rb');
  root.replaceChildren(wrap);
  let parsed: Extract<BatchParse, { ok: true }> | null = null;
  let handle: { cancel(): void; done: Promise<BatchOutcome> } | null = null;
  let zip: ReturnType<typeof createZipSink> | null = null;
  let running = false;
  let gone = false;

  const back = h('button', 'rp-btn rb-back', t('route.batch.back'));
  back.type = 'button';
  back.addEventListener('click', () => { api.dispose(); host.close(); });
  const head = h('div', 'rb-head');
  head.append(h('h3', 'rb-title', t('route.batch.title')), back);

  const pick = h('button', 'rp-btn rb-pick', t('route.batch.choose'));
  pick.type = 'button';
  const input = h('input');
  input.type = 'file';
  input.accept = '.csv,text/csv,text/plain';
  input.hidden = true;
  pick.addEventListener('click', () => input.click());
  const msg = h('p', 'rb-msg');
  msg.setAttribute('role', 'status');
  const say = (text: string, bad = false): void => { msg.textContent = text; msg.dataset.tone = bad ? 'bad' : ''; };

  const opts = h('div', 'rb-opts');
  opts.hidden = true;
  const altsSel = h('select', 'rb-alts');
  for (let n = 0; n <= 3; n++) altsSel.append(new Option(String(n), String(n), n === 1, n === 1));
  const altsLabel = h('label');
  altsLabel.append(h('span', '', t('route.batch.alts')), altsSel);
  const exact = h('input');
  exact.type = 'checkbox';
  const exactLabel = h('label');
  exactLabel.append(exact, h('span', '', t('route.batch.exact')));
  opts.append(altsLabel, exactLabel);

  const skips = h('ul', 'rb-skips');
  skips.hidden = true;
  const method = h('p', 'rb-note');
  method.hidden = true;
  const run = h('button', 'rp-btn rb-go', t('route.batch.run'));
  run.type = 'button';
  run.hidden = true;
  const cancel = h('button', 'rp-btn rb-cancel', t('route.batch.cancel'));
  cancel.type = 'button';
  cancel.hidden = true;
  const actions = h('div', 'rb-opts');
  actions.append(run, cancel);

  const bar = h('progress', 'rb-bar');
  bar.hidden = true;
  const progress = h('p', 'rb-msg');
  progress.setAttribute('aria-live', 'polite');
  const keep = h('p', 'rb-note', t('route.batch.keepOpen'));
  keep.hidden = true;
  const table = h('table', 'rb-table');
  const tbody = h('tbody');
  const trh = h('tr');
  for (const k of ['key', 'status', 'detail']) trh.append(h('th', '', t(`route.batch.col.${k}`)));
  table.append(h('thead'), tbody);
  table.tHead!.append(trh);
  const tableWrap = h('div', 'rb-table-wrap');
  tableWrap.hidden = true;
  tableWrap.append(table);
  const download = h('button', 'rp-btn rb-download', t('route.batch.download'));
  download.type = 'button';
  download.hidden = true;

  wrap.append(head, h('p', 'rb-intro', t('route.batch.intro')), pick, input, msg, skips, method, opts, actions, bar, progress, keep, tableWrap, download);

  function setRunning(on: boolean): void {
    running = on;
    back.disabled = on;
    pick.disabled = on;
    run.disabled = on;
    altsSel.disabled = on;
    exact.disabled = on;
    cancel.hidden = !on;
    bar.hidden = !on && bar.value === 0;
    keep.hidden = !on;
  }

  function detailOf(r: RowReport): string {
    const notes = (r.pictures ?? []).filter((p) => p.note).map((p) => `${t(`route.batch.pic.${p.picture}`)}: ${p.note}`);
    return [...(r.reason ? [reasonText(r.reason, r.params)] : []), ...notes].join('; ');
  }
  function addRow(r: RowReport): void {
    const tr = h('tr');
    tr.append(h('td', '', r.key), h('td', `rb-st--${r.status}`, t(`route.batch.st.${r.status}`)), h('td', '', detailOf(r)));
    tbody.append(tr);
  }

  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    input.value = '';
    if (!file || running) return;
    parsed = null;
    for (const e of [skips, method, opts, run]) e.hidden = true;
    skips.replaceChildren();
    if (file.size > MAX_BATCH_BYTES) { say(t('route.batch.refused', { reason: t('route.batch.csv.tooBig') }), true); return; }
    let text: string;
    try { text = await file.text(); } catch { say(t('route.batch.refused', { reason: file.name.slice(0, 60) }), true); return; }
    if (gone) return;
    const res = parseBatchCsv(text, { savedNames: host.saved().map((c) => c.name) });
    if (!res.ok) { say(t('route.batch.refused', { reason: t(res.reason, res.params) }), true); return; }
    for (const s of res.skipped.slice(0, MAX_SKIP_LINES)) skips.append(h('li', '', t('route.batch.skipLine', { line: s.line, reason: t(s.reason, s.params) })));
    skips.hidden = !res.skipped.length;
    if (!res.rows.length) { say(t('route.batch.noRows'), true); return; }
    parsed = res;
    say(t('route.batch.ready', { n: res.rows.length, s: res.skipped.length }));
    method.textContent = t('route.batch.method', { name: host.methodLabel });
    method.hidden = false;
    opts.hidden = false;
    run.hidden = false;
  });

  cancel.addEventListener('click', () => { cancel.disabled = true; handle?.cancel(); });

  run.addEventListener('click', async () => {
    if (!parsed || running) return;
    const { rows, skipped } = parsed;
    setRunning(true);
    tbody.replaceChildren();
    tableWrap.hidden = false;
    download.hidden = true;
    cancel.disabled = false;
    bar.max = rows.length;
    bar.value = 0;
    progress.textContent = t('route.batch.progress', { done: 0, total: rows.length });
    let index: SubstationIndex | null = null;
    if (!exact.checked) {
      const r = await ensureSubstationIndex();
      if (gone) return;
      if (!r.ok) { setRunning(false); say(t('route.batch.noIndex'), true); progress.textContent = ''; return; }
      index = r.result;
    }
    const cube = await cubeInfo();
    if (gone) return;
    const sink = createZipSink();
    zip = sink;
    const capture = createBatchCapture();
    const { renderPdf } = await import('./route-batch-pdf.js');
    if (gone) { capture.close(); return; }
    handle = runBatch({
      rows, skipped, presetId: host.presetId, patch: host.patch, lineType: host.lineType,
      snapKm: exact.checked ? null : host.snapKm, index, alternatives: Number(altsSel.value), saved: host.saved, cube,
    }, {
      solver: workerSolver(), capture, renderPdf, zip: sink,
      onRow(r, done, total) { if (gone) return; addRow(r); bar.value = done; progress.textContent = t('route.batch.progress', { done, total }); },
    });
    const out = await handle.done;
    handle = null;
    if (gone) return;
    setRunning(false);
    const ok = out.rows.filter((r) => r.status === 'ok').length;
    progress.textContent = '';
    if (out.status === 'busy') { say(t('route.batch.why.busy'), true); tableWrap.hidden = true; return; }
    const total = rows.length;
    say(out.status === 'cancelled' ? t('route.batch.cancelledDone', { ok, total })
      : out.status === 'stopped' ? t('route.batch.stopped', { ok, total, why: out.reason ? reasonText(out.reason) : '' })
        : t('route.batch.done', { ok, total }), out.status !== 'done');
    download.hidden = ok === 0;
  });

  download.addEventListener('click', async () => {
    if (!zip) return;
    download.disabled = true;
    say(t('route.batch.building'));
    try {
      const bytes = await zip.generate();
      downloadFile(bytes as BlobPart, 'route-batch.zip', 'application/zip');
      say('');
    } catch { say(t('route.batch.zipFail'), true); }
    download.disabled = false;
  });

  const api = {
    dispose(): void {
      gone = true;
      handle?.cancel();
      zip = null;
      if (wrap.parentElement === root) root.replaceChildren();
    },
  };
  return api;
}
