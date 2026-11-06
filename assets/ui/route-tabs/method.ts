// ─── Route panel: Method sub-tab ─────────────────────────────────────────────
// Role: edit the shown route's method. Header: "Based on: {preset}", edit/error chip, the
//       "vs before" delta chip, a Live toggle, Reset to preset, Save as custom… (an inline name
//       form → custom-presets.ts, then `route:presets` on document and the session switches to
//       `custom:<id>`), Rename and Delete (a saved method only; Delete asks a second click, both
//       announce `route:presets`), Save to file (a `*.tmroute.json`, custom-presets.ts
//       buildMethodFile) and Re-solve. Body: the weights editor for the preset — the Tabulator
//       grid (method-grid.ts) on a screen over 520 px, the stacked weights table
//       (weights-table.ts) at 520 px or less (matchMedia; none = the table). The grid's Map
//       column highlights rows through ctx.highlightRows, enabled only while the shown result was
//       solved on the same base method (canHighlight). Then the fixed-in-the-tiles note and the
//       sensitivity card: 7 rows × {×0.5, ×1.5} on each factor's premium over 1 (a
//       `cost_by_region` row on its routing premium only), 14 solves through ctx.runSolves,
//       ranked by max |Δ total 2025$|; a run cut short by another solve shows as stopped.
//       A patch reaches session.inputs.patch only when validatePresetPatch accepts it; an invalid
//       edit never solves. Live tuning: 600 ms after the last valid edit that differs from the
//       solved patch, ghost the shown path and ctx.resolve(patch); every valid edit also goes to
//       ctx.previewPatch (the shell's debounced cell-weight repaint).
//       Per-session state (debounce, sensitivity run, delta rows) lives in a WeakMap keyed by the
//       RouteSession; new route ends drop the run and the delta. A re-solve that lands while the
//       tab is mounted only refreshes the header and the sensitivity card (`update`), so the
//       focused weight input and an open cell editor keep their state.
//       "Uploaded layers": "Add a layer row…" reads a GeoJSON file through `validateUpload`,
//       keeps its geometry in the module's `uploads` map (`dropUploads()` when the pane closes),
//       hands it to `registerUpload` and writes a whole `add_rows` entry into the session patch
//       (hash, label, weights; never geometry). A saved row whose hash is not loaded says "needs
//       its file" and accepts the file only when its hash matches. Saving or exporting merges the
//       entries by hash (route-request.ts `mergePatch`); `hold()` refuses a layer that takes the
//       session past UPLOAD_TOTAL_VERTICES. The invalid-cell count goes to the input column
//       (ctx.setMethodErrors). Tall drawer while mounted.
// Deps: route-tabs/method-grid.ts, route-tabs/method-rows.ts, route-tabs/weights-table.ts, route/preset-patch.ts, route/upload-layer.ts, route/route-open.ts (registerUpload, unregisterUpload), ui/route-request.ts (mergePatch), route/custom-presets.ts, user-data/user-data-export.ts (downloadFile),
//       registry/route-presets.ts, route/route.ts (types), route-tabs/types.ts (types),
//       i18n (t), ./method.css.

import './method.css';
import { getLocale, t } from '../../../src/i18n/index.js';
import { routePreset, type CostRow, type Factor, type RoutePreset } from '../../../src/registry/route-presets.js';
import { COST_X_RANGE, ROUTE_W_RANGE, validatePresetPatch, type PresetPatch, type RowPatch } from '../../route/preset-patch.js';
import { buildMethodFile, createCustomPresetStore, methodFileName, presetLabel, MAX_NAME_LENGTH } from '../../route/custom-presets.js';
import { downloadFile } from '../../user-data/user-data-export.js';
import type { RouteResult } from '../../route/route.js';
import { mountWeightsTable, rowLabel, type WeightsTable } from './weights-table.js';
import { dropUpload, uploadRowsOf, upsertUpload, UPLOAD_DEFAULTS, uploadTotalRefusal, type Edit } from './method-rows.js';
import { MAX_UPLOAD_LABEL, UPLOAD_TOTAL_VERTICES, uploadLabel } from '../../route/preset-patch.js';
import { UPLOAD_MAX_BYTES, validateUpload, type UploadLayer } from '../../route/upload-layer.js';
import { registerUpload, unregisterUpload } from '../../route/route-open.js';
import { mergePatch } from '../route-request.js';
import { mountMethodGrid, type MethodGrid } from './method-grid.js';
import type { RouteSession, RouteTab, RouteTabContext, SolveSpec } from './types.js';
import { h } from '../../utils/utils-dom.js';

export const LIVE_DEBOUNCE_MS = 600;
export const SENS_ROWS = 7;
export const SENS_FACTORS = [0.5, 1.5] as const;

const store = createCustomPresetStore({
  getItem: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  setItem: (k, v) => localStorage.setItem(k, v),   // the store catches a refused write
});

function btn(cls: string, text: string, onClick: () => void): HTMLButtonElement {
  const b = h('button', cls, text);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}
const plural = (key: string, n: number) => t(`${key}.${n === 1 ? 'one' : 'other'}`, { n });
const sameJson = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

// ─── the method in play ──────────────────────────────────────────────────────

export interface Method { preset: RoutePreset; base: string; stored: PresetPatch | null; label: string; customId?: string }

/** The table's preset for the session: a built-in, or a custom's base with its stored patch applied. */
export const methodFor = (s: RouteSession): Method | null => methodOf(s.inputs.presetId);

/** A preset id (built-in or `custom:<id>`) → its method, or null when unknown / needs review. */
export function methodOf(id: string): Method | null {
  if (id.startsWith('custom:')) {
    const c = store.list().find((x) => `custom:${x.id}` === id);
    if (c?.status !== 'ok' || !c.preset) return null;
    // Uploaded-layer rows are the Uploaded layers section's, not grid rows: the table's preset has the stored patch without them.
    const stored = c.patch as PresetPatch, base = routePreset(c.base);
    let preset = c.preset;
    if (stored.add_rows && base) {
      const rest = { ...stored };
      delete rest.add_rows;
      const v = validatePresetPatch(base, Object.keys(rest).length ? rest : undefined);
      if (v.ok) preset = v.result;
    }
    return { preset, base: c.base, stored, label: c.name, customId: c.id };
  }
  const p = routePreset(id);
  return p ? { preset: p, base: p.id, stored: null, label: presetLabel(p) } : null;
}

/** `top` over `base`, row by row (a row's fields in `top` win). */
function merge(base: PresetPatch | null, top: PresetPatch | null): PresetPatch {
  const rows = new Map((base?.rows ?? []).map((r) => [r.row, { ...r }]));
  for (const r of top?.rows ?? []) rows.set(r.row, { ...rows.get(r.row), ...r });
  const out: PresetPatch = { ...base, ...top };
  if (rows.size) out.rows = [...rows.values()].sort((a, b) => a.row - b.row);
  if (base?.combine || top?.combine) out.combine = { ...base?.combine, ...top?.combine };
  return out;
}

/** A saved method's patch with the session's on top: rows by index, uploaded-layer rows by hash (mergePatch, no `remove` left). */
function combined(stored: PresetPatch | null, session: PresetPatch | null): PresetPatch {
  const out = merge(stored, session);
  const add = mergePatch(stored, session)?.add_rows;
  if (add?.length) out.add_rows = add; else delete out.add_rows;
  return out;
}
const dropRemove = (p: PresetPatch | null): PresetPatch | undefined =>
  !p ? undefined : p.add_rows?.some((r) => r.remove) ? { ...p, add_rows: p.add_rows.filter((r) => !r.remove) } : p;
const withoutAdd = (p: PresetPatch | null): PresetPatch | null => {
  if (!p?.add_rows) return p;
  const rest = { ...p };
  delete rest.add_rows;
  return Object.keys(rest).length ? rest : null;
};

export const countEdits = (p: PresetPatch | null) =>
  (p?.rows ?? []).reduce((n, r) => n + (r.route_w !== undefined ? 1 : 0) + (r.cost_x !== undefined ? 1 : 0) + (r.except ? 1 : 0), 0)
  + (p?.contingency !== undefined ? 1 : 0) + (p?.add_rows?.length ?? 0);

/** Labels of the rows (and contingency) whose patch entry differs between a and b. */
function changedRows(preset: RoutePreset, a: PresetPatch | null, b: PresetPatch | null): string[] {
  const ra = new Map((a?.rows ?? []).map((r) => [r.row, r])), rb = new Map((b?.rows ?? []).map((r) => [r.row, r]));
  const out = [...new Set([...ra.keys(), ...rb.keys()])].sort((x, y) => x - y)
    .filter((i) => !sameJson(ra.get(i), rb.get(i)) && preset.rows[i]).map((i) => rowLabel(preset.rows[i]));
  if (a?.contingency !== b?.contingency) out.push(t('route.meth.contingency'));
  return out;
}

// ─── sensitivity ─────────────────────────────────────────────────

const logW = (f: Factor) => (typeof f === 'number' ? Math.abs(Math.log(f)) : Math.max(Math.abs(Math.log(f.ramp[0])), Math.abs(Math.log(f.ramp[1]))));

const isOne = (f: Factor) => (typeof f === 'number' ? f === 1 : f.ramp[0] === 1 && f.ramp[1] === 1);
/** What a sensitivity step scales on a row: its routing premium and its cost premium. A
 *  `cost_by_region` row's cost scale is never varied (routing only). */
function tested(row: CostRow): { route: boolean; cost: boolean } {
  return { route: !isOne(row.route_w), cost: !row.cost_by_region && !isOne(row.cost_x) };
}
const testable = (row: CostRow) => { const x = tested(row); return x.route || x.cost; };

/** The `n` non-barrier rows with something to test that matter most: max(|$ share|, |ln route_w| × affected length share). */
export function sensitivityRows(preset: RoutePreset, patch: PresetPatch | null, result: RouteResult, n = SENS_ROWS): number[] {
  const v = validatePresetPatch(preset, dropRemove(patch));
  const eff = v.ok ? v.result : preset;
  const per = result.cost.perRow.filter((r) => r.row < preset.rows.length && eff.rows[r.row] && !eff.rows[r.row].barrier && testable(eff.rows[r.row]));
  const w = (r: { row: number; affectedM: number }) => logW(eff.rows[r.row].route_w) * r.affectedM;
  const usdTot = per.reduce((s, r) => s + Math.abs(r.usd), 0) || 1;
  const wTot = per.reduce((s, r) => s + w(r), 0) || 1;
  return per
    .map((r) => ({ row: r.row, score: Math.max(Math.abs(r.usd) / usdTot, w(r) / wTot) }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || a.row - b.row)
    .slice(0, n).map((r) => r.row);
}

const clamp = (x: number, r: readonly [number, number]) => Math.min(r[1], Math.max(r[0], Number((x).toPrecision(6))));
/** The premium over 1 scaled by k: 1 + (x − 1)·k (clamped), per ramp end. */
const premium = (f: Factor, k: number, r: readonly [number, number]): number | [number, number] => {
  const p = (x: number) => clamp(1 + (x - 1) * k, r);
  return typeof f === 'number' ? p(f) : [p(f.ramp[0]), p(f.ramp[1])];
};

export interface SensMeta { row: number; k: number }

/** The step's label for a row: "routing premium" on a regional cost row, else "premium". */
export const sensWhat = (row: CostRow): string =>
  t(row.cost_by_region ? 'route.meth.sens.what.routing' : 'route.meth.sens.what.premium');

/** For each row, the current patch with that row's premiums over 1 × each factor (route_w and
 *  cost_x: 1 + (x − 1)·k; a factor of exactly 1 stays; a regional row's cost scale stays), clamped;
 *  every spec is checked by validatePresetPatch and a refused one is left out. */
export function sensitivitySpecs(preset: RoutePreset, patch: PresetPatch | null, rows: number[]): { specs: SolveSpec[]; meta: SensMeta[] } {
  const v = validatePresetPatch(preset, dropRemove(patch));
  const eff = v.ok ? v.result : preset;
  const specs: SolveSpec[] = [], meta: SensMeta[] = [];
  for (const i of rows) {
    const r = eff.rows[i], x = tested(r);
    if (!x.route && !x.cost) continue;
    for (const k of SENS_FACTORS) {
      const entry: RowPatch = { row: i, band: r.band, ...(r.note !== undefined ? { note: r.note } : {}) };
      if (x.route) entry.route_w = premium(r.route_w, k, ROUTE_W_RANGE);
      if (x.cost) entry.cost_x = premium(r.cost_x, k, COST_X_RANGE);
      const p = merge(patch, { rows: [entry] });
      if (!validatePresetPatch(preset, dropRemove(p)).ok) continue;
      specs.push({ patch: p, profile: false, alternatives: 0, surface: false });
      meta.push({ row: i, k });
    }
  }
  return { specs, meta };
}

interface SensDelta { usd2025: number; usdNominal: number; mi: number }
interface SensRow { row: number; label: string; what: string; lo: SensDelta | null; hi: SensDelta | null; failed: number }
interface Sens {
  base: RouteResult;
  rows: SensRow[];
  total: number;
  done: number;
  status: 'running' | 'done' | 'cancelled' | 'stopped';   // stopped: another solve cancelled it
  handle: { cancel(): void } | null;
}

/** Rows with at least one answer, largest max |Δ 2025$| first. */
export function rankSensitivity(rows: SensRow[]): SensRow[] {
  const impact = (r: SensRow) => Math.max(Math.abs(r.lo?.usd2025 ?? 0), Math.abs(r.hi?.usd2025 ?? 0));
  return rows.filter((r) => r.lo || r.hi).sort((a, b) => impact(b) - impact(a));
}

// ─── per-session state (survives the shell's re-renders of the same pane) ────

interface St {
  ctx: RouteTabContext;
  ends: string;             // the solved A/B the run and delta belong to
  table: MethodGrid | WeightsTable | null;
  mqOff: (() => void) | null;   // the phone query's change listener
  errors: number;
  edits: number;            // edits in the table, valid or not
  timer: ReturnType<typeof setTimeout> | undefined;
  saving: boolean;
  renaming: boolean;
  sens: Sens | null;
  delta: { result: RouteResult; rows: string[] } | null;
  refreshHead: (() => void) | null;
  sensBody: HTMLElement | null;
  uplBody: HTMLElement | null;
  uplMsg: string;
}
let states = new WeakMap<RouteSession, St>();
let mounted: St | null = null;

const endsOf = (s: RouteSession) => JSON.stringify([s.resultInputs?.a?.lngLat ?? null, s.resultInputs?.b?.lngLat ?? null]);

/** The session's state; new route ends drop the sensitivity run and the delta rows. */
function stateFor(ctx: RouteTabContext): St {
  const s = ctx.session;
  let st = states.get(s);
  if (!st) {
    st = { ctx, ends: endsOf(s), table: null, mqOff: null, errors: 0, edits: 0, timer: undefined, saving: false, renaming: false, sens: null, delta: null, refreshHead: null, sensBody: null, uplBody: null, uplMsg: '' };
    states.set(s, st);
  }
  st.ctx = ctx;
  if (st.ends !== endsOf(s)) {
    st.ends = endsOf(s);
    if (st.sens?.status === 'running') { st.sens.status = 'cancelled'; st.sens.handle?.cancel(); }
    st.sens = null;
    st.delta = null;
  }
  return st;
}

/** Test hook: forget everything between tests. */
export function _resetMethodTab(): void {
  if (mounted) { clearTimeout(mounted.timer); mounted.sens?.handle?.cancel(); }
  mounted = null;
  states = new WeakMap();
}

const PHONE = '(max-width: 520px)';
const baseOf = (id: string) => methodOf(id)?.base ?? null;
/** The Map column works only while the shown result was solved on the method's base preset. */
const canHighlight = (s: RouteSession) =>
  !!s.result && !!s.resultInputs && baseOf(s.inputs.presetId) === baseOf(s.resultInputs.presetId);

const solvedPatch = (s: RouteSession) => s.resultInputs?.patch ?? null;
const dirty = (s: RouteSession) => !sameJson(s.inputs.patch, solvedPatch(s));

async function solveNow(st: St): Promise<void> {
  const ctx = st.ctx, s = ctx.session, m = methodFor(s);
  if (st.errors > 0 || !m) return;
  clearTimeout(st.timer);
  st.timer = undefined;
  const before = solvedPatch(s), patch = s.inputs.patch;
  const rows = changedRows(m.preset, before, patch);
  ctx.setGhost(s.result?.path ?? null);
  await ctx.resolve(patch);
  if (ctx.session.result) st.delta = { result: ctx.session.result, rows };
  st.refreshHead?.();
}

function scheduleLive(st: St): void {
  clearTimeout(st.timer);
  st.timer = undefined;
  const s = st.ctx.session;
  if (!s.liveTuning || st.errors > 0 || st.sens?.status === 'running' || !dirty(s)) return;
  st.timer = setTimeout(() => { st.timer = undefined; void solveNow(st); }, LIVE_DEBOUNCE_MS);
}

function signedMoney(ctx: RouteTabContext, d2025: number, dNom: number): string {
  return (d2025 < 0 ? '−' : '+') + ctx.money(Math.abs(d2025), Math.abs(dNom));
}
const signedMi = (d: number) => (d < 0 ? '−' : '+') + Math.abs(d).toFixed(1);

// ─── rendering ───────────────────────────────────────────────────────────────

function header(st: St, m: Method): HTMLElement {
  const ctx = st.ctx, s = ctx.session;
  const head = h('div', 'rm-head');
  const title = h('h3', 'rm-based', t('route.meth.basedOn', { name: m.label }));
  const chip = h('span', 'rm-chip');
  const deltaChip = h('span', 'rm-delta');
  deltaChip.setAttribute('role', 'status');
  const live = h('label', 'rm-live');
  live.title = t('route.meth.liveTip');
  const liveBox = h('input');
  liveBox.type = 'checkbox';
  liveBox.checked = s.liveTuning;
  liveBox.addEventListener('change', () => { s.liveTuning = liveBox.checked; refresh(); scheduleLive(st); });
  live.append(liveBox, h('span', undefined, t('route.meth.live')));
  const reset = btn('rp-btn rm-reset', `↺ ${t('route.meth.reset')}`, () => {
    clearTimeout(st.timer);
    st.timer = undefined;
    s.inputs.patch = null;
    st.errors = 0;
    st.edits = 0;
    st.table?.setPatch(null);
    syncUploads(m, s);
    st.uplMsg = '';
    paintUploads(st);
    ctx.setGhost(null);
    ctx.setMethodErrors(0);
    ctx.previewPatch?.(null);
    refresh();
    scheduleLive(st);
  });
  const save = btn('rp-btn rm-save', t('route.meth.save'), () => { st.saving = !st.saving; refresh(); if (st.saving) form.querySelector('input')?.focus(); });
  const toFile = btn('rp-btn rm-tofile', t('route.meth.toFile'), () => {
    const patch = combined(m.stored, s.inputs.patch);
    const name = st.edits > 0 ? t('route.meth.editedName', { name: m.label }) : m.label;
    downloadFile(buildMethodFile(name, m.base, patch), methodFileName(name), 'application/json');
  });
  let confirmDelete = false;
  const rename = btn('rp-btn rm-rename', t('route.meth.rename'), () => { st.renaming = !st.renaming; refresh(); if (st.renaming) renameForm.querySelector('input')?.focus(); });
  const del = btn('rp-btn rm-delete', t('route.meth.delete'), () => {
    if (!confirmDelete) { confirmDelete = true; refresh(); return; }
    store.remove(m.customId!);
    document.dispatchEvent(new CustomEvent('route:presets'));
    ctx.rerender();
  });
  rename.hidden = del.hidden = !m.customId;
  const resolveBtn = btn('rp-btn rm-resolve', t('route.meth.resolve'), () => { void solveNow(st); });

  const form = h('form', 'rm-saveform');
  const name = h('input', 'rm-name');
  name.type = 'text';
  name.maxLength = 60;
  name.setAttribute('aria-label', t('route.meth.saveName'));
  name.placeholder = t('route.meth.saveName');
  const ok = h('button', 'rp-btn', t('route.meth.saveBtn'));
  ok.type = 'submit';
  const msg = h('span', 'rm-savemsg');
  msg.setAttribute('role', 'alert');
  form.append(name, ok, btn('rp-btn', t('route.meth.cancel'), () => { st.saving = false; refresh(); }), msg);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (st.errors > 0) { msg.textContent = t('route.meth.saveFix'); return; }
    const patch = combined(m.stored, s.inputs.patch);
    const r = store.save(name.value, m.base, patch);
    if (!r.ok) { msg.textContent = r.reason; return; }
    st.saving = false;
    s.inputs.presetId = `custom:${r.result.id}`;
    s.inputs.patch = null;
    document.dispatchEvent(new CustomEvent('route:presets'));
    ctx.rerender();
  });

  const renameForm = h('form', 'rm-saveform');
  const newName = h('input', 'rm-name');
  newName.type = 'text';
  newName.maxLength = MAX_NAME_LENGTH;
  newName.value = m.label;
  newName.setAttribute('aria-label', t('route.meth.saveName'));
  const renameMsg = h('span', 'rm-savemsg');
  renameMsg.setAttribute('role', 'alert');
  const renameOk = h('button', 'rp-btn', t('route.meth.saveBtn'));
  renameOk.type = 'submit';
  renameForm.append(newName, renameOk, btn('rp-btn', t('route.meth.cancel'), () => { st.renaming = false; refresh(); }), renameMsg);
  renameForm.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!store.rename(m.customId!, newName.value)) { renameMsg.textContent = t('route.meth.renameBad', { n: MAX_NAME_LENGTH }); return; }
    st.renaming = false;
    document.dispatchEvent(new CustomEvent('route:presets'));
    ctx.rerender();
  });

  const row1 = h('div', 'rm-row');
  row1.append(title, chip, deltaChip, h('span', 'rm-gap'), live, reset, save, rename, del, toFile, resolveBtn);
  head.append(row1, form, renameForm);

  function refresh(): void {
    const { errors, edits, delta } = st;
    toFile.disabled = errors > 0;
    toFile.title = errors > 0 ? t('route.meth.saveFix') : '';
    chip.textContent = errors > 0
      ? `${plural('route.meth.edits', edits)} · ${plural('route.meth.errors', errors)}`
      : plural('route.meth.edits', edits);
    chip.hidden = edits === 0 && errors === 0;
    chip.classList.toggle('rm-chip--bad', errors > 0);
    const r = s.result, p = s.previous;
    deltaChip.hidden = !(r && p);
    if (r && p) {
      deltaChip.textContent = t('route.meth.delta', {
        mi: signedMi(r.lengthMi - p.lengthMi),
        usd: signedMoney(ctx, r.cost.total2025 - p.cost.total2025, r.cost.totalNominal - p.cost.totalNominal),
      });
      deltaChip.title = delta?.result === r && delta.rows.length ? t('route.meth.deltaRows', { rows: delta.rows.join('; ') }) : '';
    }
    resolveBtn.hidden = s.liveTuning && !dirty(s);
    resolveBtn.disabled = errors > 0 || !dirty(s);
    reset.disabled = !s.inputs.patch && errors === 0;
    form.hidden = !st.saving;
    renameForm.hidden = !st.renaming;
    del.textContent = confirmDelete ? t('route.meth.deleteConfirm') : t('route.meth.delete');
  }
  st.refreshHead = refresh;
  refresh();
  return head;
}

function fixedNote(): HTMLElement {
  const p = h('p', 'rm-fixed');
  p.append(h('b', undefined, t('route.meth.fixed.h')), document.createTextNode(t('route.meth.fixed')));
  return p;
}

function paintSens(st: St): void {
  const ctx = st.ctx, body = st.sensBody;
  if (!body) return;
  const s = ctx.session, m = methodFor(s);
  const nodes: Node[] = [];
  const run = st.sens;
  const current = !!run && run.base === s.result;
  if (!run || (!current && run.status !== 'running')) {
    if (run && !current) nodes.push(h('p', 'rm-sens-note', t('route.meth.sens.stale')));
    nodes.push(h('p', 'rm-sens-intro', t('route.meth.sens.intro', { rows: SENS_ROWS })), h('p', 'rm-sens-regional', t('route.meth.sens.regionalNote')));
    if (!s.result) nodes.push(h('p', 'rm-sens-note', t('route.meth.sens.none')));
    const go = btn('rp-btn rm-sens-run', t('route.meth.sens.run', { n: SENS_ROWS * SENS_FACTORS.length }), () => startSens(st));
    go.disabled = !s.result || !m || st.errors > 0;
    nodes.push(go);
    body.replaceChildren(...nodes);
    return;
  }
  const top = h('div', 'rm-sens-top');
  if (run.status === 'running') {
    const prog = h('progress', 'rm-sens-prog');
    prog.max = run.total;
    prog.value = run.done;
    top.append(prog, h('span', 'rm-sens-count', t('route.meth.sens.progress', { i: run.done, n: run.total })),
      btn('rp-btn rm-sens-cancel', t('route.meth.sens.cancel'), () => {
        run.status = 'cancelled';
        run.handle?.cancel();
        paintSens(st);
      }));
  } else {
    if (run.status === 'cancelled') top.append(h('span', 'rm-sens-note', t('route.meth.sens.cancelled', { i: run.done, n: run.total })));
    if (run.status === 'stopped') top.append(h('span', 'rm-sens-note', t('route.meth.sens.stopped', { i: run.done, n: run.total })));
    top.append(btn('rp-btn rm-sens-run', t('route.meth.sens.again'), () => startSens(st)));
  }
  nodes.push(top, h('p', 'rm-sens-regional', t('route.meth.sens.regionalNote')));
  const ranked = rankSensitivity(run.rows);
  const max = Math.max(1, ...ranked.flatMap((r) => [Math.abs(r.lo?.usd2025 ?? 0), Math.abs(r.hi?.usd2025 ?? 0)]));
  const list = h('ol', 'rm-tornado');
  for (const r of ranked) {
    const li = h('li', 'rm-tor-row');
    li.dataset.row = String(r.row);
    const lab = h('span', 'rm-tor-lab', r.label);
    lab.title = r.label;
    const track = h('span', 'rm-tor-track');
    track.setAttribute('aria-hidden', 'true');
    for (const [d, cls] of [[r.lo, 'rm-tor-bar--lo'], [r.hi, 'rm-tor-bar--hi']] as const) {
      if (!d) continue;
      const bar = h('span', `rm-tor-bar ${cls}`);
      const w = (Math.abs(d.usd2025) / max) * 50;
      bar.style.width = `${Math.max(w, 0.5)}%`;
      bar.style.left = d.usd2025 < 0 ? `${50 - w}%` : '50%';
      track.append(bar);
    }
    const txt = h('span', 'rm-tor-val');
    const line = (d: SensDelta | null, k: number) =>
      d ? t('route.meth.sens.line', { what: r.what, k, usd: signedMoney(ctx, d.usd2025, d.usdNominal), mi: signedMi(d.mi) })
        : t('route.meth.sens.lineFailed', { what: r.what, k });
    txt.append(h('span', undefined, line(r.lo, SENS_FACTORS[0])), h('span', undefined, line(r.hi, SENS_FACTORS[1])));
    li.append(lab, track, txt);
    list.append(li);
  }
  nodes.push(list);
  body.replaceChildren(...nodes);
}

const effRow = (preset: RoutePreset, patch: PresetPatch | null, i: number): CostRow => {
  const v = validatePresetPatch(preset, dropRemove(patch));
  return (v.ok ? v.result : preset).rows[i];
};

function startSens(st: St): void {
  const ctx = st.ctx, s = ctx.session, m = methodFor(s), base = s.result;
  if (!m || !base || st.errors > 0 || st.sens?.status === 'running') return;
  clearTimeout(st.timer);
  st.timer = undefined;
  const rows = sensitivityRows(m.preset, s.inputs.patch, base);
  const { specs, meta } = sensitivitySpecs(m.preset, s.inputs.patch, rows);
  const run: Sens = {
    base, total: specs.length, done: 0, status: 'running', handle: null,
    rows: rows.map((row) => ({ row, label: rowLabel(m.preset.rows[row]), what: sensWhat(effRow(m.preset, s.inputs.patch, row)), lo: null, hi: null, failed: 0 })),
  };
  st.sens = run;
  paintSens(st);
  const handle = ctx.runSolves(specs, (i, r, reason) => {
    if (st.sens !== run || run.status !== 'running') return;
    if (reason === 'cancelled') { run.status = 'stopped'; paintSens(st); return; }
    const mm = meta[i], row = run.rows.find((x) => x.row === mm.row)!;
    run.done = i + 1;
    if (r) {
      const d: SensDelta = {
        usd2025: r.cost.total2025 - base.cost.total2025, usdNominal: r.cost.totalNominal - base.cost.totalNominal, mi: r.lengthMi - base.lengthMi,
      };
      if (mm.k < 1) row.lo = d; else row.hi = d;
    } else {
      row.failed++;
    }
    paintSens(st);
  });
  run.handle = handle;
  void handle.done.then(() => {
    if (st.sens === run && run.status === 'running') { run.status = 'done'; paintSens(st); }
  });
}

function sensCard(st: St): HTMLElement {
  const card = h('section', 'rm-sens');
  card.append(h('h4', 'rm-sens-h', t('route.meth.sens.h')));
  st.sensBody = h('div', 'rm-sens-body');
  card.append(st.sensBody);
  return card;
}

// ─── uploaded layers ───────────────────────────────────────────────────

/** The uploaded layers held in this tab, by hash: the geometry the worker's registry also holds (route-open.ts). */
export const uploads = new Map<string, UploadLayer>();

/** The pane closed: forget every uploaded layer here and in the worker's registry. */
export function dropUploads(): void {
  for (const h of uploads.keys()) unregisterUpload(h);
  uploads.clear();
}

/** Keep only the layers the merged method still names. */
function syncUploads(m: Method, s: RouteSession): void {
  const need = new Set(uploadRowsOf(m.stored, s.inputs.patch).map((r) => r.layer));
  for (const h of [...uploads.keys()]) if (!need.has(h)) { unregisterUpload(h); uploads.delete(h); }
}

/** A file name as a row label: no extension, no control characters, at most 60 characters. */
function labelOf(name: string): string {
  const base = uploadLabel(name.replace(/\.[^.]*$/, ''));
  return [...(base || t('route.cat.upload'))].slice(0, MAX_UPLOAD_LABEL).join('');
}

/** An upload or patch validator's English reason as a locale string; text that matches none passes through. */
const UPLOAD_REASONS: [RegExp, string][] = [
  [/not UTF-8/, 'utf8'], [/did not parse/, 'json'], [/not a GeoJSON object/, 'obj'], [/has no features/, 'nofeat'],
  [/member is not a Feature/, 'member'], [/no polygons/, 'nopoly'], [/more than (\d+) polygon parts/, 'parts'],
  [/polygon has no rings/, 'norings'], [/fewer than 4 positions/, 'ring4'], [/more than (\d+) positions/, 'verts'],
  [/not \[lng, lat\]/, 'pos'], [/two finite numbers/, 'finite'], [/outside lng/, 'range'], [/not closed/, 'closed'],
  [/outside the routing grid/, 'grid'], [/over 10 MiB/, 'big'],
];
export function uploadReason(reason: string): string {
  for (const [re, key] of UPLOAD_REASONS) {
    const m = re.exec(reason);
    if (m) return key === 'big' ? t('route.meth.upl.big') : t(`route.meth.upl.r.${key}`, { n: m[1] ?? '' });
  }
  const label = /\.label must be 1.(\d+) characters/.exec(reason);
  if (label) return t('route.meth.upl.r.label', { n: label[1] });
  const range = /\.(route_w|cost_x) must be .* in \[([-\d.e+]+), ([-\d.e+]+)\]/.exec(reason);
  if (range) return t(range[1] === 'route_w' ? 'route.meth.upl.r.routeW' : 'route.meth.upl.r.costX', { lo: range[2], hi: range[3] });
  return reason;
}

async function readLayer(file: File): Promise<{ ok: true; layer: UploadLayer } | { ok: false; reason: string }> {
  if (file.size > UPLOAD_MAX_BYTES) return { ok: false, reason: t('route.meth.upl.big') };
  const r = await validateUpload(new Uint8Array(await file.arrayBuffer()));
  return r.ok ? { ok: true, layer: r.result } : { ok: false, reason: uploadReason(r.reason) };
}

/** A session patch the Uploaded layers section made: shown, counted, previewed, solved live. */
function applyUploadEdit(st: St, m: Method, patch: PresetPatch | null): void {
  const s = st.ctx.session;
  s.inputs.patch = patch;
  st.edits = countEdits(patch);
  syncUploads(m, s);
  st.ctx.previewPatch?.(patch);
  scheduleLive(st);
  st.refreshHead?.();
  paintSens(st);
}

function numberInput(label: string, value: number, onCommit: () => void): { el: HTMLLabelElement; input: HTMLInputElement } {
  const el = h('label', 'rm-upl-field');
  const input = h('input');
  input.type = 'number';
  input.step = 'any';
  input.value = String(value);
  input.addEventListener('change', onCommit);
  el.append(h('span', undefined, label), input);
  return { el, input };
}

function pickFile(onFile: (f: File) => void): void {
  const i = h('input');
  i.type = 'file';
  i.accept = '.geojson,.json,application/geo+json,application/json';
  i.hidden = true;
  i.className = 'rm-upl-file';
  i.addEventListener('change', () => { const f = i.files?.[0]; i.remove(); if (f) onFile(f); });
  document.body.append(i);
  i.click();
}

function paintUploads(st: St): void {
  const body = st.uplBody;
  if (!body) return;
  const s = st.ctx.session, m = methodFor(s), base = m && routePreset(m.base);
  if (!m || !base) { body.replaceChildren(); return; }
  const rows = uploadRowsOf(m.stored, s.inputs.patch);
  const msg = h('p', 'rm-upl-msg', st.uplMsg);
  msg.setAttribute('role', 'alert');
  const say = (text: string) => { st.uplMsg = text; msg.textContent = text; };
  const totalMsg = () => t('route.meth.upl.total', { n: UPLOAD_TOTAL_VERTICES.toLocaleString(getLocale()) });
  /** Registers a layer unless it passes the session total (a waiting file or a new one alike). */
  const hold = (layer: UploadLayer): boolean => {
    if (uploadTotalRefusal(uploads, layer)) { say(totalMsg()); return false; }
    uploads.set(layer.hash, layer);
    registerUpload(layer.hash, layer.geometry);
    return true;
  };
  const take = (e: Edit, after?: () => void): boolean => {
    if (!e.ok) { say(uploadReason(e.reason)); return false; }
    say('');
    applyUploadEdit(st, m, e.patch);
    after?.();
    return true;
  };
  const list = h('ul', 'rm-upl-list');
  for (const r of rows) {
    const li = h('li', 'rm-upl-row');
    li.dataset.layer = r.layer;
    // Every edit reads all the row's controls, so a second edit never undoes the first.
    const edit = () => take(upsertUpload(base, m.stored, s.inputs.patch, {
      layer: r.layer, label: name.value, route_w: Number(w.input.value), cost_x: Number(c.input.value), barrier: box.checked,
    }));
    const name = h('input', 'rm-upl-label');
    name.type = 'text';
    name.maxLength = MAX_UPLOAD_LABEL;
    name.value = r.label;
    name.setAttribute('aria-label', t('route.meth.upl.label'));
    name.addEventListener('change', edit);
    const barrier = h('label', 'rm-upl-field');
    const box = h('input');
    box.type = 'checkbox';
    box.checked = r.barrier;
    box.addEventListener('change', edit);
    barrier.append(box, h('span', undefined, t('route.meth.upl.barrier')));
    const remove = btn('rp-btn rm-upl-remove', t('route.meth.upl.remove'), () => {
      take(dropUpload(base, m.stored, s.inputs.patch, r.layer), () => paintUploads(st));
    });
    const w = numberInput(t('route.meth.upl.routeW'), r.route_w, edit), c = numberInput(t('route.meth.upl.costX'), r.cost_x, edit);
    li.append(name, w.el, c.el, barrier, remove);
    if (!uploads.has(r.layer)) {
      const need = h('span', 'rm-upl-needs', t('route.meth.upl.needs'));
      const open = btn('rp-btn rm-upl-open', t('route.meth.upl.open'), () => pickFile((f) => {
        void readLayer(f).then((got) => {
          if (!got.ok) { say(got.reason); return; }
          if (got.layer.hash !== r.layer) { say(t('route.meth.upl.other')); return; }
          if (!hold(got.layer)) return;
          say('');
          paintUploads(st);
          scheduleLive(st);
        });
      }));
      li.append(need, open);
    }
    li.append(h('span', 'rm-upl-from', t('route.meth.upl.from', { label: r.label })));
    list.append(li);
  }
  const add = btn('rp-btn rm-upl-add', t('route.meth.upl.add'), () => pickFile((f) => {
    void readLayer(f).then((got) => {
      if (!got.ok) { say(got.reason); return; }
      const cur = uploadRowsOf(m.stored, s.inputs.patch);
      if (cur.some((x) => x.layer === got.layer.hash)) {
        if (uploads.has(got.layer.hash)) { say(t('route.meth.upl.dup')); return; }
        if (!hold(got.layer)) return;          // the file a row is waiting for: load it, as Open the file… does
        say('');
        paintUploads(st);
        scheduleLive(st);
        return;
      }
      const e = upsertUpload(base, m.stored, s.inputs.patch, { layer: got.layer.hash, label: labelOf(f.name), ...UPLOAD_DEFAULTS, barrier: false });
      if (!e.ok) { say(uploadReason(e.reason)); return; }
      if (!hold(got.layer)) return;
      say('');
      applyUploadEdit(st, m, e.patch);
      paintUploads(st);
    });
  }));
  body.replaceChildren(h('p', 'rm-upl-intro', t('route.meth.upl.intro')), list, add, msg);
}

function uploadSection(st: St): HTMLElement {
  const sec = h('section', 'rm-upl');
  sec.append(h('h4', 'rm-upl-h', t('route.meth.upl.h')));
  st.uplBody = h('div', 'rm-upl-body');
  sec.append(st.uplBody);
  return sec;
}

const tab: RouteTab = {
  id: 'method',
  labelKey: 'route.sub.method',
  disabled: () => null,
  render(el, ctx) {
    if (mounted && mounted !== states.get(ctx.session)) tab.dispose!();
    const st = stateFor(ctx);
    st.table?.destroy();
    st.table = null;
    st.mqOff?.();
    st.mqOff = null;
    mounted = st;
    ctx.setTall(true);
    const s = ctx.session, m = methodFor(s);
    const root = h('div', 'rm');
    if (!m) { root.append(h('p', 'rp-hint', t('route.err.preset'))); el.replaceChildren(root); return; }
    syncUploads(m, s);
    const head = header(st, m);
    const host = h('div', 'rm-table');
    const foot = h('div', 'rm-foot');
    foot.append(fixedNote(), h('p', 'rm-fixed', t('route.report.method.class5')), sensCard(st));
    root.append(head, host, uploadSection(st), foot);
    el.replaceChildren(root);
    const onChange = (rowsPatch: PresetPatch | null, n: number) => {
      const add = s.inputs.patch?.add_rows;   // the table knows rows, not uploaded layers: keep the session's
      const patch = add?.length ? { ...rowsPatch, add_rows: add } : rowsPatch;
      st.errors = n;
      st.edits = countEdits(patch);
      ctx.setMethodErrors(n);
      if (n === 0) {
        s.inputs.patch = patch;
        ctx.previewPatch?.(patch);
        scheduleLive(st);
      } else {
        clearTimeout(st.timer);
        st.timer = undefined;
      }
      st.refreshHead?.();
      paintSens(st);
    };
    const mq = typeof matchMedia === 'function' ? matchMedia(PHONE) : null;
    if (mq && !mq.matches) {
      const scroller = el.closest<HTMLElement>('.rp-main');
      st.table = mountMethodGrid(host, {
        preset: m.preset,
        base: routePreset(m.base) ?? m.preset,
        patch: withoutAdd(s.inputs.patch),
        regionM: s.result?.cost.regionM,
        highlight: s.highlight,
        onHighlight: ctx.highlightRows ? (p) => ctx.highlightRows!(p) : null,
        onChange,
        fitIn: scroller ? { scroller, sticky: head } : undefined,
      });
      (st.table as MethodGrid).setHighlight(s.highlight, !!ctx.highlightRows && canHighlight(s));
    } else {
      st.table = mountWeightsTable(host, { preset: m.preset, base: routePreset(m.base) ?? m.preset, patch: withoutAdd(s.inputs.patch), regionM: s.result?.cost.regionM, onChange });
    }
    if (mq) {
      const again = () => { if (mounted === st && el.isConnected) tab.render(el, ctx); };
      mq.addEventListener('change', again);
      st.mqOff = () => mq.removeEventListener('change', again);
    }
    st.errors = 0;
    st.edits = countEdits(s.inputs.patch);
    ctx.setMethodErrors(0);
    st.refreshHead?.();
    paintUploads(st);
    paintSens(st);
  },
  /** A re-solve landed: the header (delta chip, buttons) and the sensitivity card only. */
  update(el, ctx) {
    const st = stateFor(ctx);
    if (mounted !== st || !st.table || !el.querySelector('.rm')) { tab.render(el, ctx); return; }
    st.table.setRegionM(ctx.session.result?.cost.regionM);
    if ('setHighlight' in st.table) st.table.setHighlight(ctx.session.highlight, !!ctx.highlightRows && canHighlight(ctx.session));
    st.refreshHead?.();
    paintSens(st);
  },
  dispose() {
    const st = mounted;
    mounted = null;
    if (!st) return;
    clearTimeout(st.timer);
    st.timer = undefined;
    st.table?.destroy();
    st.table = null;
    st.mqOff?.();
    st.mqOff = null;
    st.refreshHead = null;
    st.sensBody = null;
    st.uplBody = null;
    if (st.errors) { st.errors = 0; st.ctx.setMethodErrors(0); }
    st.ctx.setTall(false);
  },
};

export default tab;
