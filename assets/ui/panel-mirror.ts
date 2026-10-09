// ─── Panel mirror — the one writer of panel control values ───────────────────
// The layer-row templates (ui-layer-rows.ts) and index.html render structure;
// this module writes every control value that comes from `state`, so a view
// applied in code (Reset, a story, Undo, a view file) and a re-render
// (language, region) leave the panel showing what the map shows.
//   renderPanel()       rebuild the layer rows, then syncPanel().
//   syncPanel(layerId?) values only — never creates or removes a node, safe to
//                       repeat, and needs no map (init() renders before it
//                       exists). With an id, that layer's row controls; without,
//                       every control: layer checkboxes, heat ramps, mode and
//                       colour-by buttons, the weather and hazard selects,
//                       filter chips, the year, MW and smoke sliders, the
//                       basemap and projection radios, the labels / 3D /
//                       hillshade toggles and the region dropdown.
//   updateYearSliderUI() / updateYearPlayBtn() / updateMwSliderUI() /
//   updateSmokeOpacityUI()  one control on its own, for ui-filters.ts's input
//                       handlers and playback. updateMwSliderUI() paints the
//                       range and inputs from the slider positions, so a drag
//                       never snaps through the MW rounding.
// Subscriptions: 'layer:visibility' (visibility.ts's setLayerVisibility)
// repaints that layer's row, so the app must import this module (ui.ts does);
// 'view:applied' repaints every value, and rebuilds the rows first only when
// the structure key (region scope | locale | the switched-on layers outside the
// scope, which keep a row) differs from the last render — so an Undo keeps open
// filter panels and the focused control. A checkbox toggle never rebuilds: an
// out-of-scope layer switched off keeps its row until the next rebuild, and
// only one switched on with no row rebuilds them. A language change
// is not subscribed here: ui.ts's one 'lang:changed' handler runs
// updateDomTranslations() and then renderPanel(), since the region label is
// copied from the freshly translated menu item.
// Deps: state.js, registry/index.js (LAYERS, layerById), visibility.js
//       (heatRampShown, modeOf), filters.js (mwToPos, mwPosToMw),
//       ui-layer-rows.js (buildLayersPanel, isLayerInRegion), state-bus.js, src/i18n/index.js
//       (t, getLocale).
// Imported by: ui.ts (init, language and region changes), ui-filters.ts
//              (syncPanel after a mode or colour-by click; the one-control helpers).

import { state } from '../state.js';
import { LAYERS, layerById } from '../../src/registry/index.js';
import type { LayerDef } from '../../src/types.js';
import { heatRampShown, modeOf } from '../visibility.js';
import { mwToPos, mwPosToMw } from '../filters.js';
import { buildLayersPanel, isLayerInRegion } from './ui-layer-rows.js';
import { on } from '../state-bus.js';
import { t, getLocale } from '../../src/i18n/index.js';

/** Minimum separation between the MW slider handles, in slider position units. */
export const MW_POS_GAP = 1;

let renderedKey = "";
const structureKey = () => {
  const outOfScopeOn = LAYERS.filter(l => !l.hidden && !isLayerInRegion(l) && state.layerVisibility[l.id]).map(l => l.id);
  return `${state.regionScope}|${getLocale()}|${outOfScopeOn.join(',')}`;
};

// A layer switched by anyone — its checkbox, a stale-feed kill switch, an
// applied view — gets its row repainted here. One switched on with no row (out
// of scope, its row dropped by a rebuild) rebuilds the rows so it gets one.
on('layer:visibility', ({ id, visible }) => {
  const entry = layerById(id);
  if (visible && entry && !isLayerInRegion(entry) && !document.querySelector(`[data-layer-id="${id}"]`)) renderPanel();
  else syncPanel(id);
});
on('view:applied', () => {
  if (structureKey() !== renderedKey) renderPanel();
  else syncPanel();
});

export function renderPanel() {
  buildLayersPanel();
  renderedKey = structureKey();
  syncPanel();
}

export function syncPanel(layerId?: string) {
  if (layerId) {
    const entry = layerById(layerId);
    if (entry) syncRow(entry);
    return;
  }
  for (const entry of LAYERS) syncRow(entry);
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
  if (entry.filterBuckets) {
    document.querySelectorAll<HTMLInputElement>(`input[data-filter-layer="${id}"][data-bucket-id]`)
      .forEach(c => { c.checked = !!state.layerFilters[id]?.has(c.dataset.bucketId!); });
  }
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
