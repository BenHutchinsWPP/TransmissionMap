// ─── Route weights table ─────────────────────────────────────────────────────
// Role: the one editor for a route method's numbers, shared by the drawer's Method tab. One line per preset row — category, applies to (the row's note and its match in words, + a group
//       badge naming the combine rule), routing weight, cost ×, source — with the row's
//       `except` entries as checkboxes under it and the contingency % at the bottom.
//       Every input builds a PresetPatch (rows addressed by index + band + note, values
//       only where they differ from `preset`) and runs it through validatePresetPatch, the
//       trust boundary; a cheap local range check per cell only places the error text.
//       Edited cells are highlighted with "was {orig}". On a `cost_by_region` row the cost
//       cell is a "scale ×" onto every regional set: in a full-width sub-row under the row the effective per-set values
//       (set value × scale) update live, the sets the shown route was costed with in bold
//       (`regionM`, from CostResult), and "was" names the per-set values too.
//       A row with `excludable` gets an Excl. checkbox in its routing-weight cell: ticking sets that cell (and the
//       cells of rows sharing its `link`) to EXCLUDED_W, unticking to method-rows.ts's setExcluded value (needs
//       `base`, the registry preset); it writes the inputs and fires `input`, so the edit is read like a typed one.
//       All text goes in through textContent.
// Deps: route/preset-patch.ts, route/categories.ts, route/inspect.ts (matchText), registry/route-presets.ts, route-tabs/method-rows.ts (setExcluded),
//       route-tabs/widgets.ts (sourceInfo), i18n (t), ./weights-table.css.

import './weights-table.css';
import { t } from '../../../src/i18n/index.js';
import { COST_X_RANGE, ROUTE_W_RANGE, validatePresetPatch, type PresetPatch, type RowPatch } from '../../route/preset-patch.js';
import { categoryLabelKey, routeCategory } from '../../route/categories.js';
import { matchText, textOf } from '../../route/inspect.js';
import { EXCLUDED_W, type CostRow, type Factor, type RoutePreset } from '../../../src/registry/route-presets.js';
import { sourceInfo } from './widgets.js';
import { setExcluded } from './method-rows.js';
import { h } from '../../utils/utils-dom.js';

export interface WeightsTableOpts {
  preset: RoutePreset;
  /** The registry preset an Excl. untick falls back to (default: `preset`). */
  base?: RoutePreset;
  patch: PresetPatch | null;
  /** Every edit: the patch the inputs describe (null = no edits) and how many errors it has. */
  onChange(patch: PresetPatch | null, errors: number): void;
  readOnly?: boolean;
  /** Metres the shown route was costed with each regional set (CostResult.regionM): those sets go bold. */
  regionM?: Record<string, number>;
}
export interface WeightsTable {
  setPatch(p: PresetPatch | null): void;
  /** A new result: re-bold the regional sets it crossed. */
  setRegionM(m: Record<string, number> | undefined): void;
  destroy(): void;
}

type Field = 'route_w' | 'cost_x';
type Val = number | [number, number];
interface Cell { row: number; field: Field; input: HTMLInputElement; td: HTMLElement; was: HTMLElement; err: HTMLElement; sets: HTMLElement | null }

export const fmtFactor = (f: Factor | Val): string =>
  typeof f === 'number' ? String(f) : Array.isArray(f) ? `${f[0]}, ${f[1]}` : `${f.ramp[0]}, ${f.ramp[1]}`;

/** Input text → a number, or [from, to] for a ramp row; anything else stays NaN for the checks. */
function parse(text: string, like: Factor): Val {
  const n = (s: string) => (s.trim() === '' ? NaN : Number(s));
  if (typeof like === 'number') return n(text);
  const parts = text.split(',');
  return parts.length === 2 ? [n(parts[0]), n(parts[1])] : [NaN, NaN];
}
const same = (v: Val, f: Factor) =>
  typeof f === 'number' ? v === f : Array.isArray(v) && v[0] === f.ramp[0] && v[1] === f.ramp[1];
const inRange = (v: Val, r: readonly [number, number]) =>
  (Array.isArray(v) ? v : [v]).every((x) => Number.isFinite(x) && x >= r[0] && x <= r[1]);

/** A regional row's per-set values at scale k: "TEPPC ×2.25 · SCE ×3 · …". */
export const regionalSets = (row: CostRow, k: number): [string, number][] =>
  Object.entries(row.cost_by_region ?? {}).map(([n, v]) => [n, +(v * k).toPrecision(6)]);
export const fmtSets = (sets: [string, number][]): string => sets.map(([n, v]) => `${n} ×${v}`).join(' · ');

export const rowLabel = (row: CostRow): string => `${t(categoryLabelKey(routeCategory(row)))} — ${row.note ?? row.band}`;

export function mountWeightsTable(el: HTMLElement, opts: WeightsTableOpts): WeightsTable {
  const { preset } = opts;
  const cells: Cell[] = [];
  const excls: { row: number; input: HTMLInputElement }[] = [];
  const checks: { row: number; j: number; input: HTMLInputElement }[] = [];
  const range = (f: Field) => (f === 'route_w' ? ROUTE_W_RANGE : COST_X_RANGE);
  let crossed = opts.regionM;

  const wrap = h('div', 'wt');
  const scroll = h('div', 'wt-scroll');
  const table = h('table', 'wt-table');
  const thead = h('thead');
  const hr = h('tr');
  for (const [k, cls] of [['category', ''], ['applies', ''], ['routeW', 'wt-num'], ['costX', 'wt-num'], ['source', '']] as const) {
    const th = h('th', cls || undefined, t(`route.wt.col.${k}`));
    th.scope = 'col';
    hr.append(th);
  }
  thead.append(hr);
  const tbody = h('tbody');

  function cellInput(i: number, row: CostRow, field: Field): HTMLElement {
    const td = h('td', 'wt-num wt-cell');
    td.dataset.label = t(field === 'route_w' ? 'route.wt.col.routeW' : 'route.wt.col.costX');   // the column name, shown on a stacked (narrow) table
    const input = h('input', 'wt-in');
    input.type = 'text';
    input.inputMode = 'decimal';
    input.autocomplete = 'off';
    input.size = typeof row[field] === 'number' ? 6 : 10;
    input.dataset.row = String(i);
    input.dataset.field = field;
    input.disabled = !!opts.readOnly;
    const regional = field === 'cost_x' && !!row.cost_by_region;
    input.setAttribute('aria-label', t(field === 'route_w' ? 'route.wt.aria.routeW' : regional ? 'route.wt.aria.scale' : 'route.wt.aria.costX', { row: rowLabel(row) }));
    const was = h('span', 'wt-was');
    const err = h('span', 'wt-err');
    err.id = `wt-err-${i}-${field}`;
    input.setAttribute('aria-describedby', err.id);
    let sets: HTMLElement | null = null;
    if (regional) {
      const lab = h('span', 'wt-scale', t('route.wt.scale'));
      lab.title = t('route.wt.regionalTip', { sets: fmtSets(regionalSets(row, 1)) });
      sets = h('span', 'wt-sets');
      td.append(lab, input, was, err);
    } else td.append(input, was, err);
    cells.push({ row: i, field, input, td, was, err, sets });
    return td;
  }

  preset.rows.forEach((row, i) => {
    const tr = h('tr', 'wt-row');
    tr.dataset.row = String(i);
    const applies = h('td', 'wt-applies');
    applies.append(h('span', undefined, row.note ?? row.band), ' ', h('span', 'wt-match', matchText(row.band, row.match).map((x) => textOf(x, t)).join('; ')));
    if (row.group) {
      const rule = preset.combine[row.group] ?? 'multiply';
      const gk = `route.wt.grp.${row.group}`, gt = t(gk), group = gt === gk ? row.group : gt;
      const b = h('span', 'wt-group', t('route.wt.group', { group, rule: t(`route.wt.rule.${rule}`) }));
      b.title = t('route.wt.groupTip', { group, rule: t(`route.wt.rule.${rule}`) });
      applies.append(' ', b);
    }
    const w = row.barrier ? h('td', 'wt-num wt-barrier', t('route.wt.barrier')) : cellInput(i, row, 'route_w');
    if (row.excludable && !row.barrier) {
      const lab = h('label', 'wt-check wt-excl');
      const box = h('input');
      box.type = 'checkbox';
      box.dataset.row = String(i);
      box.dataset.excl = '1';
      box.disabled = !!opts.readOnly;
      box.setAttribute('aria-label', t(row.excludable.link ? 'route.mg.aria.exclLinked' : 'route.mg.aria.excl', { row: rowLabel(row) }));
      lab.append(box, ' ', h('span', undefined, t('route.mg.col.excl')));
      w.append(lab);
      excls.push({ row: i, input: box });
    }
    const c = cellInput(i, row, 'cost_x');
    const src = h('td', 'wt-srccell');
    const srcText = h('span', 'wt-src', row.ref ?? row.src);
    srcText.title = row.src;
    src.append(sourceInfo(row.src), srcText);
    tr.append(h('td', 'wt-cat', t(categoryLabelKey(routeCategory(row)))), applies, w, c, src);
    tbody.append(tr);
    const sets = cells.find((x) => x.row === i && x.sets)?.sets;
    if (sets) {
      const sr = h('tr', 'wt-sets-row');
      sr.dataset.row = String(i);
      const std = h('td');
      std.colSpan = 5;
      std.append(sets);
      sr.append(std);
      tbody.append(sr);
    }
    if (row.except?.length) {
      const xr = h('tr', 'wt-except');
      xr.dataset.row = String(i);
      const td = h('td');
      td.colSpan = 5;
      td.append(h('span', 'wt-except-lab', t('route.wt.except')));
      row.except.forEach((x, j) => {
        const lab = h('label', 'wt-check');
        const input = h('input');
        input.type = 'checkbox';
        input.dataset.row = String(i);
        input.dataset.j = String(j);
        input.disabled = !!opts.readOnly;
        lab.append(input, ' ', h('span', undefined, x.label), ' ', sourceInfo(x.src));
        td.append(lab);
        checks.push({ row: i, j, input });
      });
      xr.append(td);
      tbody.append(xr);
    }
  });
  table.append(thead, tbody);
  scroll.append(table);
  wrap.append(scroll);

  let cont: { input: HTMLInputElement; box: HTMLElement; was: HTMLElement; err: HTMLElement } | null = null;
  const pctText = (x: number) => String(+(x * 100).toFixed(6));
  if (preset.contingency) {
    const box = h('div', 'wt-cont');
    const lab = h('label', 'wt-cont-lab');
    const input = h('input', 'wt-in');
    input.type = 'text';
    input.inputMode = 'decimal';
    input.size = 5;
    input.dataset.field = 'contingency';
    input.disabled = !!opts.readOnly;
    lab.append(h('span', undefined, t('route.wt.contingency')), input);
    const was = h('span', 'wt-was'), err = h('span', 'wt-err');
    box.append(lab, sourceInfo(preset.contingency.src), was, err);
    wrap.append(box);
    cont = { input, box, was, err };
  }
  const general = h('p', 'wt-general');
  general.setAttribute('role', 'alert');
  general.hidden = true;
  wrap.append(general);
  el.replaceChildren(wrap);

  /** The patch the inputs describe, highlights and errors applied; null when nothing differs. */
  function read(): { patch: PresetPatch | null; errors: number } {
    let errors = 0;
    const rows = new Map<number, RowPatch>();
    const entry = (i: number) => {
      const r = preset.rows[i];
      let e = rows.get(i);
      if (!e) { e = { row: i, band: r.band, ...(r.note !== undefined ? { note: r.note } : {}) }; rows.set(i, e); }
      return e;
    };
    for (const c of cells) {
      const orig = preset.rows[c.row][c.field];
      const v = parse(c.input.value, orig);
      const edited = !same(v, orig);
      const bad = !inRange(v, range(c.field));
      if (edited) entry(c.row)[c.field] = v;
      c.td.classList.toggle('wt-edited', edited);
      c.td.classList.toggle('wt-bad', bad);
      c.input.setAttribute('aria-invalid', String(bad));
      const row = preset.rows[c.row];
      const was = c.sets && typeof orig === 'number' ? fmtSets(regionalSets(row, orig)) : fmtFactor(orig);
      c.was.textContent = edited ? t('route.wt.was', { v: was }) : '';
      if (c.sets) paintSets(c.sets, row, v);
      const [lo, hi] = range(c.field);
      c.err.textContent = bad ? t(typeof orig === 'number' ? 'route.wt.err.num' : 'route.wt.err.ramp', { lo, hi }) : '';
      if (bad) errors++;
    }
    const byRow = new Map<number, typeof checks>();
    for (const x of checks) byRow.set(x.row, [...(byRow.get(x.row) ?? []), x]);
    for (const [i, xs] of byRow) {
      const flags = xs.map((x) => x.input.checked);
      const ex = preset.rows[i].except!;
      xs.forEach((x, j) => x.input.parentElement!.classList.toggle('wt-edited', flags[j] !== (ex[j].active !== false)));
      if (flags.some((on, j) => on !== (ex[j].active !== false))) entry(i).except = flags;
    }
    for (const tr of tbody.querySelectorAll<HTMLElement>('tr.wt-row')) {
      const i = Number(tr.dataset.row);
      const bad = cells.some((c) => c.row === i && c.td.classList.contains('wt-bad'));
      tr.classList.toggle('wt-row--edited', rows.has(i));
      tr.classList.toggle('wt-row--bad', bad);
      const sr = tr.nextElementSibling;
      if (sr?.classList.contains('wt-sets-row')) { sr.classList.toggle('wt-row--edited', rows.has(i)); sr.classList.toggle('wt-row--bad', bad); }
    }
    const patch: PresetPatch = {};
    if (rows.size) patch.rows = [...rows.values()].sort((a, b) => a.row - b.row);
    if (cont && preset.contingency) {
      const txt = cont.input.value.trim();
      const pct = txt === '' ? NaN : Number(txt);
      const edited = txt !== pctText(preset.contingency.pct);
      const bad = !(Number.isFinite(pct) && pct >= 0 && pct <= 100);
      if (edited) patch.contingency = pct / 100;
      cont.box.classList.toggle('wt-edited', edited);
      cont.box.classList.toggle('wt-bad', bad);
      cont.input.setAttribute('aria-invalid', String(bad));
      cont.was.textContent = edited ? t('route.wt.was', { v: pctText(preset.contingency.pct) }) : '';
      cont.err.textContent = bad ? t('route.wt.err.pct') : '';
      if (bad) errors++;
    }
    const out = Object.keys(patch).length ? patch : null;
    // validatePresetPatch is the authority: a refusal no local check placed still counts.
    general.hidden = true;
    general.textContent = '';
    if (out && errors === 0) {
      const v = validatePresetPatch(preset, out);
      if (!v.ok) {
        errors = 1;
        const m = /^row (\d+) (route_w|cost_x)/.exec(v.reason);
        const c = m && cells.find((x) => x.row === Number(m[1]) && x.field === m[2]);
        if (c) { c.td.classList.add('wt-bad'); c.err.textContent = v.reason; }
        else { general.hidden = false; general.textContent = v.reason; }
      }
    }
    return { patch: out, errors };
  }

  /** "= TEPPC ×4.5 · SCE ×6 · …" for scale v; the sets the route crossed in <strong>. */
  function paintSets(el: HTMLElement, row: CostRow, v: Val): void {
    if (typeof v !== 'number' || !Number.isFinite(v)) { el.replaceChildren(); return; }
    const nodes: (Node | string)[] = ['= '];
    regionalSets(row, v).forEach(([n, x], j) => {
      if (j) nodes.push(' · ');
      const on = (crossed?.[n] ?? 0) > 0;
      const e = h(on ? 'strong' : 'span', undefined, `${n} ×${x}`);
      if (on) e.title = t('route.wt.setCrossed');
      nodes.push(e);
    });
    el.replaceChildren(...nodes);
  }

  function fill(p: PresetPatch | null): void {
    const byRow = new Map((p?.rows ?? []).map((r) => [r.row, r]));
    for (const c of cells) {
      const e = byRow.get(c.row);
      const v = e?.[c.field];
      c.input.value = fmtFactor(v ?? preset.rows[c.row][c.field]);
    }
    for (const x of checks) {
      const flags = byRow.get(x.row)?.except;
      x.input.checked = flags ? !!flags[x.j] : preset.rows[x.row].except![x.j].active !== false;
    }
    if (cont && preset.contingency) cont.input.value = pctText(p?.contingency ?? preset.contingency.pct);
    read();
    syncExcl();
  }

  /** Excl. ticked: route the row (and its linked rows) through setExcluded, write the inputs, fire `input`. */
  function onExcl(i: number, on: boolean): void {
    const cur = read().patch;
    const r = setExcluded(preset, opts.base ?? preset, cur, i, on);
    if (!r.ok) { general.hidden = false; general.textContent = r.reason; syncExcl(); return; }
    const byRow = new Map((r.patch?.rows ?? []).map((x) => [x.row, x]));
    for (const c of cells) {
      if (c.field !== 'route_w' || !preset.rows[c.row].excludable) continue;
      c.input.value = fmtFactor(byRow.get(c.row)?.route_w ?? preset.rows[c.row].route_w);
    }
    cells.find((c) => c.row === i && c.field === 'route_w')?.input.dispatchEvent(new Event('input', { bubbles: true }));
  }
  /** The Excl. boxes follow the routing-weight inputs. */
  function syncExcl(): void {
    const isEx = (row: number) => {
      const n = Number(cells.find((c) => c.row === row && c.field === 'route_w')?.input.value ?? '');
      return Number.isFinite(n) && n >= EXCLUDED_W;
    };
    for (const x of excls) {
      const link = preset.rows[x.row].excludable?.link;
      x.input.checked = link ? excls.filter((y) => preset.rows[y.row].excludable?.link === link).every((y) => isEx(y.row)) : isEx(x.row);
    }
  }

  const onInput = (e: Event) => {
    if (!(e.target instanceof HTMLInputElement)) return;
    if (e.target.dataset.excl) { if (e.type === 'change') onExcl(Number(e.target.dataset.row), e.target.checked); return; }
    if ((e.target.type === 'checkbox') !== (e.type === 'change')) return;   // text on input, checkboxes on change
    const { patch, errors } = read();
    syncExcl();
    opts.onChange(patch, errors);
  };
  wrap.addEventListener('input', onInput);
  wrap.addEventListener('change', onInput);
  fill(opts.patch);

  return {
    setPatch: fill,
    setRegionM(m) {
      crossed = m;
      for (const c of cells) if (c.sets) paintSets(c.sets, preset.rows[c.row], parse(c.input.value, preset.rows[c.row].cost_x));
    },
    destroy() {
      wrap.removeEventListener('input', onInput);
      wrap.removeEventListener('change', onInput);
      wrap.remove();
    },
  };
}
