// ─── Panel mirror — the one writer of panel control values ───────────────────
// The layer-row templates (ui-layer-rows.ts) and index.html render structure;
// this module writes every control value that comes from `state`, so a view
// applied in code (Reset, a story, Undo, a view file) and a re-render
// (language, region) leave the panel showing what the map shows.
//   renderPanel()       rebuild the layer rows (ui-layer-rows.ts panelRows() over
//                       state's scope and switched-on layers — the one module
//                       that reads state for the rows and writes them), then syncPanel().
//   syncPanel(layerId?) values only — creates or removes no node but the Area chips; safe to
//                       repeat, and needs no map (init() renders before it
//                       exists). With an id, that layer's row controls; without,
//                       every control the state drives (layer checkboxes, row
//                       chips and notes, ramps, buttons, selects, filter chips,
//                       sliders, basemap radios and toggles, the region dropdown,
//                       the Area row and the Selection row). The Area chips are
//                       the one place it rebuilds nodes, since they are the
//                       control's value.
//   commitArea(area)    setArea() + one 'url:write' + syncPanel(): the one
//                       commit path for an Area change (picker, dev console).
//   commitSelection(sel) setSelection() + one 'url:write' + syncPanel(): the
//                       same for the selection (chip menu, table, dev console).
//   commitWhere(id, conds) setWhere() + one 'url:write' + that row's syncPanel:
//                       the same for a layer's `where` (map-api.ts setWhere —
//                       the table's column filters, templates, the chat, each
//                       inside asOwnStep — and the row chip's ×).
//   conditionLabel(c) / whereLabel(conds)  a condition, and a layer's `where`,
//                       in a few words ("nominal_kv ≥ 230", "2 filters"): the
//                       row chip and the table's pills and header marks.
//   updateYearSliderUI() / updateYearPlayBtn() / updateMwSliderUI() /
//   updateSmokeOpacityUI()  one control on its own, for ui-filters.ts's input
//                       handlers and playback. updateMwSliderUI() paints the
//                       range and inputs from the slider positions, so a drag
//                       never snaps through the MW rounding.
// Subscriptions: 'layer:visibility' (visibility.ts's setLayerVisibility)
// repaints that layer's row, so the app must import this module (ui.ts does);
// 'view:applied' repaints every value, and rebuilds the rows first only when
// the key (locale | the row ids panelRows() returns — which follow the region
// scope and the switched-on layers outside it, which keep a row) differs from
// the last render — so an Undo keeps open filter panels and the focused control. A checkbox toggle never rebuilds: an
// out-of-scope layer switched off keeps its row until the next rebuild, and
// only one switched on with no row rebuilds them. A language change
// is not subscribed here: ui.ts's one 'lang:changed' handler runs
// updateDomTranslations() and then renderPanel(), since the region label is
// copied from the freshly translated menu item.
// Deps: state.js, registry/index.js (LAYERS, layerById), visibility.js
//       (heatRampShown, modeOf), filters.js (mwToPos, mwPosToMw, setArea, setSelection,
//       setWhere), ui-layer-rows.js (panelRows, hasPanelRow), state-bus.js, src/i18n/index.js
//       (t, getLocale), src/registry/area-filter.js (areaFlag),
//       src/registry/view-validate.js (selectionSize), area-labels.js
//       (chip names; loads the lazy label table when an area is set).
// Imported by: ui.ts (init, language and region changes), ui-area.ts and
//              dev-console.ts (commitArea), ui-selection.ts, ui-table.ts and
//              dev-console.ts (commitSelection), ui-filters.ts
//              (syncPanel after a mode or colour-by click; the one-control helpers;
//              commitWhere for the row chip's ×), map-api.ts (commitWhere).

import { state } from '../state.js';
import { LAYERS, layerById } from '../../src/registry/index.js';
import type { LayerDef, Selection } from '../../src/types.js';
import type { Condition } from '../../src/registry/condition-compile.js';
import { heatRampShown, modeOf } from '../visibility.js';
import { mwToPos, mwPosToMw, setArea, setSelection, setWhere } from '../filters.js';
import { selectionSize } from '../../src/registry/view-validate.js';
import { panelRows, hasPanelRow } from './ui-layer-rows.js';
import { emit, on } from '../state-bus.js';
import { numbersShown } from '../grid-ops/ba-graph.js';
import { humanise } from '../utils/field-label.js';
import { t, getLocale } from '../../src/i18n/index.js';
import { areaFlag, type AreaFilter } from '../../src/registry/area-filter.js';
import { areaLabel, areaLabelsNow, loadAreaLabels } from './area-labels.js';

/** Minimum separation between the MW slider handles, in slider position units. */
export const MW_POS_GAP = 1;

let renderedKey = "";
let renderedIds = new Set<string>();
const panelView = () => ({ scope: state.regionScope, visible: state.layerVisibility });
const keyOf = (ids: Iterable<string>) => `${getLocale()}|${[...ids].sort().join(',')}`;

// A layer switched by anyone — its checkbox, a stale-feed kill switch, an
// applied view — gets its row repainted here. One switched on with no row (out
// of scope, its row dropped by a rebuild) rebuilds the rows so it gets one.
// Before the first render there are no rows to add to, only values to paint.
on('layer:visibility', ({ id, visible }) => {
  const entry = layerById(id);
  if (visible && renderedKey !== "" && entry && !renderedIds.has(id) && hasPanelRow(entry, panelView())) renderPanel();
  else syncPanel(id);
});
on('view:applied', () => {
  const ids = LAYERS.filter(l => hasPanelRow(l, panelView())).map(l => l.id);
  if (keyOf(ids) !== renderedKey) renderPanel();
  else syncPanel();
});

export function renderPanel() {
  const rows = panelRows(LAYERS, panelView());
  for (const [group, { html }] of Object.entries(rows)) {
    const container = document.getElementById(`layer-rows-${group}`);
    if (container) container.innerHTML = html;
  }
  // Hide a collapsible section whose row containers are all empty.
  document.querySelectorAll<HTMLElement>('.layers-body .layer-section[data-collapsible]').forEach(section => {
    const rowContainers = section.querySelectorAll('[id^="layer-rows-"]');
    if (rowContainers.length > 0) {
      section.style.display = Array.from(rowContainers).some(c => c.children.length > 0) ? '' : 'none';
    }
  });
  renderedIds = new Set(Object.values(rows).flatMap(r => r.ids));
  renderedKey = keyOf(renderedIds);
  syncPanel();
}

export function syncPanel(layerId?: string) {
  if (layerId) {
    const entry = layerById(layerId);
    if (entry) syncRow(entry);
    syncAreaSummary();
    return;
  }
  for (const entry of LAYERS) syncRow(entry);
  syncAreaControl();
  syncSelection();
  updateYearSliderUI();
  updateYearPlayBtn();
  const mwMin = document.getElementById("mwSliderMin") as HTMLInputElement | null;
  const mwMax = document.getElementById("mwSliderMax") as HTMLInputElement | null;
  if (mwMin) mwMin.value = String(mwToPos(state.mwFilter.min));
  if (mwMax) mwMax.value = String(mwToPos(state.mwFilter.max));
  updateMwSliderUI();
  updateSmokeOpacityUI();
  syncBasemapControls();
  syncRegionSelect();
}

function setActive(sel: string, isActive: (b: HTMLElement) => boolean) {
  document.querySelectorAll<HTMLElement>(sel).forEach(b => b.classList.toggle("gen-mode-btn--active", isActive(b)));
}

function syncRow(entry: LayerDef) {
  const id = entry.id;
  const on = !!state.layerVisibility[id];
  const cb = document.querySelector<HTMLInputElement>(`input[type=checkbox][data-layer-id="${id}"]`);
  if (cb) cb.checked = on;
  // The Area-filter note of a visible row: a small button (ui-area.ts shows its
  // text on tap) whose label says why the area does not reach the layer, or
  // the EIA NERC vintage note.
  const flagEl = document.querySelector<HTMLElement>(`[data-area-flag="${id}"]`);
  if (flagEl) {
    const flag = on ? areaFlag(entry, state.area, modeOf(entry)) : null;
    flagEl.hidden = !flag;
    flagEl.dataset.flag = flag ?? "";
    if (flag) flagEl.setAttribute("aria-label", `${t(flagTitle(flag))}: ${t(flag)}`);
    else flagEl.removeAttribute("aria-label");
  }
  // The `where` chip: the layer's conditions in a few words, × clears them.
  const chip = document.querySelector<HTMLElement>(`[data-where-chip="${id}"]`);
  if (chip) {
    const where = state.where[id] ?? [];
    chip.hidden = !where.length;
    chip.title = where.length ? t('table.filtered', { list: where.map(conditionLabel).join(' · ') }) : '';
    chip.querySelector('.layer-where-text')!.textContent = where.length ? whereLabel(where) : '';
    chip.querySelector('.layer-where-clear')!.setAttribute('aria-label', t('layer.whereClear', { layer: t(entry.titleKey) }));
  }
  if (entry.heatLayerId || entry.modes) {
    const mode = modeOf(entry);
    const ramp = document.getElementById(`${id}-heat-ramp`);
    if (ramp) ramp.hidden = !heatRampShown(entry, on, mode);
    setActive(`.gen-mode-btn[data-gen-mode-layer="${id}"]`, b => b.dataset.genMode === mode);
  }
  if (entry.ogfStatusLayer) setActive("[data-ogf-colorby]", b => b.dataset.ogfColorby === state.ogfColorBy);
  if (entry.westtecColorLayer) setActive("[data-westtec-colorby]", b => b.dataset.westtecColorby === state.westtecColorBy);
  const select = (sel: string, value: string) => {
    const el = document.querySelector<HTMLSelectElement>(sel);
    if (el) el.value = value;
  };
  if (entry.weatherVarLayer) select("select[data-weather-var-select]", state.weatherVar);
  if (entry.nriHazardLayer) select("select[data-nri-hazard-select]", state.nriHazard);
  if (entry.gridOpsLayer) {
    select("select[data-grid-group-select]", state.gridGroup);
    select("select[data-grid-glyph-select]", state.gridGlyph);
    const gn = document.querySelector<HTMLInputElement>("input[data-grid-numbers-toggle]");
    if (gn) gn.checked = numbersShown(state.gridNumbers, state.gridGroup);
  }
  if (entry.routeConcernLayer) select("select[data-route-concern-select]", state.routeConcern);
  if (entry.filterBuckets) {
    document.querySelectorAll<HTMLInputElement>(`input[data-filter-layer="${id}"][data-bucket-id]`)
      .forEach(c => { c.checked = !!state.layerFilters[id]?.has(c.dataset.bucketId!); });
  }
}

/** Commit an Area change the way a control does: setArea(), then one
 *  'url:write' (one undo step), then the panel repaints from state (a pick is
 *  not a 'view:applied', so nothing else repaints the chips and row notes).
 *  Returns why the area was refused, or null. The picker (ui-area.ts) and the
 *  dev console's tm.setArea both commit through here. */
export function commitArea(area: AreaFilter | null): string | null {
  const err = setArea(area);
  if (err) return err;
  emit('url:write');
  syncPanel();
  return null;
}

/** Commit a selection the way a control does: setSelection(), then one
 *  'url:write' (one undo step), then the panel repaints from state. Returns
 *  why the selection was refused, or null. */
export function commitSelection(sel: Selection | null): string | null {
  const err = setSelection(sel);
  if (err) return err;
  emit('url:write');
  syncPanel();
  return null;
}

/** Commit a layer's `where` the way a control does: setWhere(), then one
 *  'url:write', then that row repaints (its chip). Returns why the conditions
 *  were refused, or null. map-api.ts wraps it in undo.ts asOwnStep. */
export function commitWhere(layerId: string, conditions: Condition[]): string | null {
  const err = setWhere(layerId, conditions);
  if (err) return err;
  emit('url:write');
  syncPanel(layerId);
  return null;
}

const OP_SIGN: Record<string, string> = { '=': '=', '!=': '≠', '<': '<', '<=': '≤', '>': '>', '>=': '≥', not_in: '≠' };

/** One condition in a few words: "Nominal (kV) ≥ 230", "fuel: SUN, WND +2 more". */
export function conditionLabel(c: Condition): string {
  const name = humanise(c.field);
  if (c.op === 'has') return name;
  const vals = (Array.isArray(c.value) ? c.value : [c.value]).map(String);
  const list = vals.length > 3 ? `${vals.slice(0, 3).join(', ')} ${t('table.more', { n: vals.length - 3 })}` : vals.join(', ');
  return OP_SIGN[c.op] ? `${name} ${OP_SIGN[c.op]} ${list}` : `${name}: ${list}`;
}

/** A layer's `where` in a few words: one field's conditions ("nominal_kv
 *  230–500" for a ≥ and ≤ pair), else "{n} filters". */
export function whereLabel(where: readonly Condition[]): string {
  const fields = new Set(where.map(c => c.field));
  if (fields.size > 1) return t('layer.whereN', { n: fields.size });
  const lo = where.find(c => c.op === '>=' || c.op === '>');
  const hi = where.find(c => c.op === '<=' || c.op === '<');
  if (where.length === 2 && lo && hi && lo.op === '>=' && hi.op === '<=') return `${humanise(lo.field)} ${lo.value}–${hi.value}`;
  return where.map(conditionLabel).join(' · ');
}

/** The Selection row (index.html #selRow) from state.sel: hidden without a
 *  selection; else "{n} selected", a tooltip naming each layer's count, and
 *  the mode on the menu button (ui-selection.ts opens the menu). */
function syncSelection() {
  const row = document.getElementById("selRow");
  if (!row) return;
  const sel = state.sel;
  const counts = Object.entries(sel?.ids ?? {}).filter(([, ids]) => ids.length);
  row.hidden = !counts.length;
  if (!sel || !counts.length) return;
  const n = selectionSize(sel.ids);
  const label = document.getElementById("selChipLabel");
  if (label) {
    label.textContent = t("sel.count", { n });
    label.title = counts.map(([id, ids]) => `${ids.length} · ${t(layerById(id)?.titleKey ?? id)}`).join("\n");
  }
  const mode = document.getElementById("selModeText");
  if (mode) mode.textContent = t(sel.mode === "keep" ? "sel.keep" : "sel.isolate");
}

/** The heading a row flag's note goes under. */
export const flagTitle = (flag: string) => flag === "area.nercVintage" ? "area.vintageTitle" : "area.notFiltered";

// Past this many codes the field shows one "{n} selected" chip, not one each.
const MAX_AREA_CHIPS = 6;

/** The Area row (index.html #areaRow) from state.area: one chip per code
 *  (labelled once region-labels.json has loaded, the code until then), the
 *  Clear link, the placeholder and the "not filtered" summary. The chips are
 *  the control's value, so they are rebuilt here; nothing else is. */
function syncAreaControl() {
  const chips = document.getElementById("areaChips");
  if (!chips) return;
  const area = state.area;
  const table = areaLabelsNow();
  const chip = (label: string, code: string | null, title = label) => {
    const el = document.createElement("span");
    el.className = "area-chip";
    el.title = title;
    const name = document.createElement("span");
    name.className = "area-chip-label";
    name.textContent = label;
    const x = document.createElement("button");
    x.type = "button";
    x.className = "area-chip-x";
    x.dataset.areaAction = code === null ? "clear" : "remove";
    if (code !== null) x.dataset.areaCode = code;
    x.setAttribute("aria-label", t("area.removeAria", { name: label }));
    x.textContent = "×";
    el.append(name, x);
    return el;
  };
  if (!area) chips.replaceChildren();
  else if (area.codes.length > MAX_AREA_CHIPS) {
    const names = area.codes.map(c => areaLabel(table, area.kind, c));
    chips.replaceChildren(chip(`${t("area.selected", { n: area.codes.length })} · ${t(`area.kind.${area.kind}`)}`, null, names.join("\n")));
  } else {
    chips.replaceChildren(...area.codes.map(c => chip(areaLabel(table, area.kind, c), c)));
  }
  chips.dataset.areaKind = area?.kind ?? "";
  const clear = document.getElementById("areaClear");
  if (clear) clear.hidden = !area;
  document.getElementById("areaBox")?.classList.toggle("area-box--on", !!area);
  const input = document.getElementById("areaInput") as HTMLInputElement | null;
  if (input) input.placeholder = t(area ? "area.addMore" : "area.search");
  if (area && !table) void loadAreaLabels().then(l => { if (l) syncAreaControl(); });
  syncAreaSummary();
}

/** "Layers not filtered: N · Show" under the Area field: the visible rows
 *  carrying a flag, counted after syncRow() painted them. */
function syncAreaSummary() {
  const summary = document.getElementById("areaSummary");
  if (!summary) return;
  const n = document.querySelectorAll("[data-area-flag]:not([hidden])").length;
  summary.hidden = !n;
  const text = document.getElementById("areaSummaryText");
  if (text) text.textContent = n ? t("area.summary", { n }) : "";
}

function syncBasemapControls() {
  const basemap = document.querySelector<HTMLInputElement>(`input[type=radio][name=basemap][value="${state.basemap}"]`);
  if (basemap) basemap.checked = true;
  const projection = document.querySelector<HTMLInputElement>(`input[type=radio][name=projection][value="${state.projection}"]`);
  if (projection) projection.checked = true;
  for (const [elId, on] of [
    ['terrain3dToggle', state.terrain3d],
    ['buildings3dToggle', state.buildings3d],
    ['hillshadeToggle', state.hillshade],
    ['basemapLabelsToggle', state.basemapLabels],
  ] as const) {
    const el = document.getElementById(elId) as HTMLInputElement | null;
    if (el) el.checked = on;
  }
}

// The region dropdown: the active item's class and aria-checked, and the
// button's icon and label copied from that item. The label carries no
// data-i18n of its own, so a language change repaints it from the freshly
// translated item.
function syncRegionSelect() {
  const menu = document.getElementById("regionMenu");
  if (!menu) return;
  menu.querySelectorAll<HTMLButtonElement>(".region-menu-item").forEach(item => {
    const active = item.dataset.region === state.regionScope;
    item.classList.toggle("region-menu-item--active", active);
    item.setAttribute("aria-checked", active ? "true" : "false");
  });
  const activeItem = menu.querySelector<HTMLButtonElement>(`.region-menu-item[data-region="${state.regionScope}"]`);
  if (!activeItem) return;
  const iconEl = document.getElementById("regionActiveIcon");
  const svg = activeItem.querySelector("svg");
  if (iconEl && svg) iconEl.innerHTML = svg.outerHTML;
  const textEl = document.getElementById("regionActiveText");
  const label = activeItem.querySelector(".region-menu-label");
  if (textEl && label) textEl.textContent = label.textContent;
}

export function updateYearSliderUI() {
  const slider  = document.getElementById("yearSlider") as HTMLInputElement | null;
  const readout = document.getElementById("yearReadout");
  if (!slider) return;
  const yf = state.yearFilter;
  slider.value = String(yf.year);
  slider.classList.toggle("year-slider--off", !yf.enabled);
  if (readout) readout.textContent = yf.enabled ? String(yf.year) : t('year.allYears');
}

export function updateYearPlayBtn() {
  const btn = document.getElementById("yearPlayBtn");
  if (!btn) return;
  btn.textContent = state.yearPlayback.active ? "⏸" : "▶";
  btn.title       = t(state.yearPlayback.active ? 'year.pauseTitle' : 'year.playTitle');
}

export function updateMwSliderUI() {
  const minEl    = document.getElementById("mwSliderMin") as HTMLInputElement | null;
  const maxEl    = document.getElementById("mwSliderMax") as HTMLInputElement | null;
  const rangeEl  = document.getElementById("mwSliderRange");
  const minInput = document.getElementById("mwMinInput") as HTMLInputElement | null;
  const maxInput = document.getElementById("mwMaxInput") as HTMLInputElement | null;
  if (!minEl || !maxEl) return;

  const SMAX   = parseInt(minEl.max, 10);   // slider position max (4000)
  const minPos = parseInt(minEl.value, 10);
  const maxPos = parseInt(maxEl.value, 10);

  const leftPct  = (minPos / SMAX) * 100;
  const rightPct = (maxPos / SMAX) * 100;
  if (rangeEl) {
    rangeEl.style.left  = leftPct + "%";
    rangeEl.style.width = (rightPct - leftPct) + "%";
  }

  if (minInput && document.activeElement !== minInput) minInput.value = String(mwPosToMw(minPos));
  if (maxInput && document.activeElement !== maxInput) maxInput.value = maxPos >= SMAX ? "" : String(mwPosToMw(maxPos));

  minEl.style.zIndex = (minPos >= maxPos - MW_POS_GAP) ? "2" : "1";
  maxEl.style.zIndex = (minPos >= maxPos - MW_POS_GAP) ? "1" : "2";
}

export function updateSmokeOpacityUI() {
  const slider = document.getElementById("smokeOpacitySlider") as HTMLInputElement | null;
  const readout = document.getElementById("smokeOpacityReadout");
  if (!slider) return;
  const percent = Math.round(state.smokeOpacity * 100);
  slider.value = String(percent);
  slider.setAttribute("aria-valuetext", t('smoke.opacityValueText', { percent }));
  if (readout) readout.textContent = `${percent}%`;
}
