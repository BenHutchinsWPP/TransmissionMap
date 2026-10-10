// ─── Layer + legend filter wiring, MW/year/smoke controls ──────────────────────
// Each handler writes state, applies it and commits with 'url:write'. A range
// slider paints live on 'input' and commits once on 'change' (drag end, or one
// keyboard step), so one drag is one undo step however slow it is; a year
// drag that switched the filter on or stopped playback also commits on
// pointer release, since one released at its start value fires no 'change'. Smoke
// paint comes from map-layers-conditions.js. The controls' values (active
// buttons, the year, MW and smoke sliders, the play button) are painted from
// state by panel-mirror.js — syncPanel and its one-control helpers — which
// also sets them all at init, before this wiring runs.
import { state } from '../state.js';
import { LEGEND_FILTERS_BY_KEY, legendAllIds, syncLegendMaster, updateLegends } from './ui-legends.js';
import { emit } from '../state-bus.js';
import { MW_SLIDER_MAX, mwPosToMw, mwToPos, applyGeneratorFilters, applyLayerFilter } from '../filters.js';
import { setWeatherVar } from '../weather-live.js';
import { setNriHazard } from '../fema-nri.js';
import { refreshWeatherRampBlock } from './ui-legends.js';
import { applySmokeOpacity } from '../layers/map-layers-conditions.js';
import { setColorBy } from '../style-overrides.js';
import { applyGenMode } from '../visibility.js';
import {
  syncPanel, updateYearSliderUI, updateYearPlayBtn, updateMwSliderUI, updateSmokeOpacityUI, MW_POS_GAP,
} from './panel-mirror.js';

export function wireLayerFilterPanels() {
  document.addEventListener("change", (e) => {
    const cb = (e.target as Element)?.closest<HTMLInputElement>("input[type=checkbox][data-filter-layer]");
    if (!cb) return;
    const active = state.layerFilters[cb.dataset.filterLayer!];
    if (!active) return;
    cb.checked ? active.add(cb.dataset.bucketId!) : active.delete(cb.dataset.bucketId!);
    applyLayerFilter(cb.dataset.filterLayer!);
    emit('url:write');
  });

  document.addEventListener("click", (e) => {
    const btn = (e.target as Element)?.closest<HTMLElement>(".filter-btn");
    if (!btn) return;
    const panel = document.getElementById(`filter-panel-${btn.dataset.filterLayer}`);
    if (!panel) return;
    panel.hidden = !panel.hidden;
    btn.classList.toggle("filter-btn--open", !panel.hidden);
  });
}

export function wireLegendFilters() {
  document.addEventListener("change", (e) => {
    const cb = (e.target as Element)?.closest<HTMLInputElement>("input.legend-filter-cb[data-legend-key]");
    if (!cb) return;
    const cfg = LEGEND_FILTERS_BY_KEY[cb.dataset.legendKey!];
    if (!cfg) return;
    const set = state.legendFilters[cfg.key];
    cb.checked ? set.add(cb.dataset.bucketId!) : set.delete(cb.dataset.bucketId!);
    syncLegendMaster(cfg);
    cfg.apply();
    emit('url:write');
  });

  document.addEventListener("change", (e) => {
    const cb = (e.target as Element)?.closest<HTMLInputElement>("input.legend-master-cb[data-legend-key]");
    if (!cb) return;
    const cfg = LEGEND_FILTERS_BY_KEY[cb.dataset.legendKey!];
    if (!cfg) return;
    state.legendFilters[cfg.key] = cb.checked ? new Set(legendAllIds(cfg)) : new Set();
    document.querySelectorAll<HTMLInputElement>(`input.legend-filter-cb[data-legend-key="${cfg.key}"]`)
      .forEach(c => { c.checked = cb.checked; });
    cfg.apply();
    emit('url:write');
  });
}

export function wireMwFilter() {
  const genMwBtn   = document.getElementById("genMwFilterBtn");
  const genMwPanel = document.getElementById("genMwFilterPanel");
  if (genMwBtn && genMwPanel) {
    genMwBtn.addEventListener("click", () => {
      genMwPanel.hidden = !genMwPanel.hidden;
      genMwBtn.classList.toggle("section-filter-btn--open", !genMwPanel.hidden);
    });
  }

  const mwSliderMin = document.getElementById("mwSliderMin") as HTMLInputElement | null;
  const mwSliderMax = document.getElementById("mwSliderMax") as HTMLInputElement | null;
  if (mwSliderMin && mwSliderMax) {
    for (const el of [mwSliderMin, mwSliderMax]) {
      el.addEventListener("input", onMwSliderInput);
      el.addEventListener("change", () => emit('url:write'));
    }
  }

  const mwMinInput = document.getElementById("mwMinInput");
  const mwMaxInput = document.getElementById("mwMaxInput");
  if (mwMinInput && mwMaxInput) {
    mwMinInput.addEventListener("change", onMwTextChange);
    mwMaxInput.addEventListener("change", onMwTextChange);
  }
}

export function wireSmokeOpacity() {
  const slider = document.getElementById("smokeOpacitySlider") as HTMLInputElement | null;
  if (!slider) return;
  slider.addEventListener("input", () => {
    state.smokeOpacity = parseInt(slider.value, 10) / 100;
    updateSmokeOpacityUI();
    applySmokeOpacity();
  });
  slider.addEventListener("change", () => emit('url:write'));
}

function onMwSliderInput(e: Event) {
  const minEl = document.getElementById("mwSliderMin") as HTMLInputElement;
  const maxEl = document.getElementById("mwSliderMax") as HTMLInputElement;
  let minPos  = parseInt(minEl.value, 10);
  let maxPos  = parseInt(maxEl.value, 10);

  if (e.target === minEl) {
    minPos = Math.min(minPos, maxPos - MW_POS_GAP);
    minEl.value = String(minPos);
  } else {
    maxPos = Math.max(maxPos, minPos + MW_POS_GAP);
    maxEl.value = String(maxPos);
  }

  state.mwFilter.min = mwPosToMw(minPos);
  state.mwFilter.max = mwPosToMw(maxPos);

  updateMwSliderUI();
  applyGeneratorFilters();
}

function onMwTextChange(e: Event) {
  const minInput  = document.getElementById("mwMinInput") as HTMLInputElement;
  const maxInput  = document.getElementById("mwMaxInput") as HTMLInputElement;
  const minSlider = document.getElementById("mwSliderMin") as HTMLInputElement;
  const maxSlider = document.getElementById("mwSliderMax") as HTMLInputElement;
  const POS_MAX   = parseInt(minSlider.max, 10); // 4000

  let minMw = parseInt(minInput.value, 10);
  let maxMw = parseInt(maxInput.value, 10);
  if (isNaN(minMw) || minInput.value === "") minMw = 0;
  if (isNaN(maxMw) || maxInput.value === "") maxMw = MW_SLIDER_MAX;

  minMw = Math.max(0, Math.min(minMw, MW_SLIDER_MAX));
  maxMw = Math.max(0, Math.min(maxMw, MW_SLIDER_MAX));

  // Enforce handle separation in position (log) space, then snap state to it.
  let minPos = mwToPos(minMw);
  let maxPos = mwToPos(maxMw);
  if (e.target === minInput) {
    if (minPos >= maxPos) maxPos = Math.min(minPos + MW_POS_GAP, POS_MAX);
  } else {
    if (maxPos <= minPos) minPos = Math.max(maxPos - MW_POS_GAP, 0);
  }

  minSlider.value = String(minPos);
  maxSlider.value = String(maxPos);
  state.mwFilter.min = mwPosToMw(minPos);
  state.mwFilter.max = mwPosToMw(maxPos);

  updateMwSliderUI();
  applyGeneratorFilters();
  emit('url:write');
}

export function wireGenModeToggle() {
  document.addEventListener("click", (e) => {
    const btn = (e.target as Element)?.closest<HTMLElement>(".gen-mode-btn[data-gen-mode-layer]");
    if (!btn) return;
    const id   = btn.dataset.genModeLayer!;
    const mode = btn.dataset.genMode!;
    if (state.genMode[id] === mode) return;
    state.genMode[id] = mode;
    applyGenMode(id);
    syncPanel(id);
    updateLegends();
    emit('url:write');
  });
}

export function wireOgfColorByToggle() {
  document.addEventListener("click", (e) => {
    const btn = (e.target as Element)?.closest<HTMLElement>(".gen-mode-btn[data-ogf-colorby]");
    if (!btn) return;
    const mode = btn.dataset.ogfColorby!;
    if (state.ogfColorBy === mode || setColorBy("ogf-planned-transmission", mode)) return;
    syncPanel("ogf-planned-transmission");
    updateLegends();
    emit('url:write');
  });
}

export function wireWestTECColorByToggle() {
  document.addEventListener("click", (e) => {
    const btn = (e.target as Element)?.closest<HTMLElement>(".gen-mode-btn[data-westtec-colorby]");
    if (!btn) return;
    const mode = btn.dataset.westtecColorby!;
    if (state.westtecColorBy === mode || setColorBy("westtec-10yr", mode)) return;
    syncPanel("westtec-10yr");
    updateLegends();
    emit('url:write');
  });
}

export function wireWeatherVarSelect() {
  document.addEventListener("change", (e) => {
    const sel = (e.target as Element)?.closest<HTMLSelectElement>("select[data-weather-var-select]");
    if (!sel) return;
    setWeatherVar(sel.value);
    refreshWeatherRampBlock();
    emit('url:write');
  });
}

export function wireNriHazardSelect() {
  document.addEventListener("change", (e) => {
    const sel = (e.target as Element)?.closest<HTMLSelectElement>("select[data-nri-hazard-select]");
    if (!sel) return;
    setNriHazard(sel.value);
    emit('url:write');
  });
}

export function wireYearFilter() {
  // Delegated on document: panel-mirror.ts's renderPanel() re-renders the rows
  // (a language or region change), which would orphan any listener bound
  // directly to the button/slider elements.
  document.addEventListener("click", (e) => {
    const t = e.target as Element | null;
    if (t?.closest("#genYearFilterBtn")) {
      const panel = document.getElementById("genYearFilterPanel");
      if (!panel) return;
      panel.hidden = !panel.hidden;
      document.getElementById("genYearFilterBtn")?.classList.toggle("filter-btn--open", !panel.hidden);
    } else if (t?.closest("#yearPlayBtn")) {
      toggleYearPlayback();
    } else if (t?.closest("#yearAllBtn")) {
      clearYearFilter();
    }
  });
  document.addEventListener("input", (e) => {
    if ((e.target as Element | null)?.id === "yearSlider") onYearSliderInput(e);
  });
  document.addEventListener("change", (e) => {
    if ((e.target as Element | null)?.id === "yearSlider") commitYearDrag();
  });
  // A drag released at its start value fires no `change`, but one that switched
  // the filter on or stopped playback still changed the view: the release
  // commits it. When `change` does fire too, undo folds the two into one step.
  for (const type of ["pointerup", "pointercancel"]) {
    document.addEventListener(type, () => { if (yearDragPending) commitYearDrag(); });
  }
}

let yearDragPending = false;

function commitYearDrag() {
  yearDragPending = false;
  emit('url:write');
}

function onYearSliderInput(e: Event) {
  if (!state.yearFilter.enabled || state.yearPlayback.active) yearDragPending = true;
  state.yearFilter.year    = parseInt((e.target as HTMLInputElement).value, 10);
  state.yearFilter.enabled = true;
  stopYearPlayback();
  updateYearSliderUI();
  applyGeneratorFilters();
}

function clearYearFilter() {
  stopYearPlayback();
  state.yearFilter.enabled = false;
  updateYearSliderUI();
  applyGeneratorFilters();
  emit('url:write');
}

export function stopYearPlayback() {
  const pb = state.yearPlayback;
  if (!pb.active) return;
  clearInterval(pb.interval ?? undefined);
  pb.interval = null;
  pb.active   = false;
  updateYearPlayBtn();
}

function toggleYearPlayback() {
  const pb = state.yearPlayback;
  if (pb.active) { stopYearPlayback(); emit('url:write'); return; }
  state.yearFilter.enabled = true;
  if (state.yearFilter.year >= state.yearFilter.max) state.yearFilter.year = state.yearFilter.min;
  pb.active = true;
  updateYearPlayBtn();
  updateYearSliderUI();
  applyGeneratorFilters();
  emit('url:write');
  pb.interval = setInterval(() => {
    let y = state.yearFilter.year + 1;
    if (y > state.yearFilter.max) y = state.yearFilter.min;
    state.yearFilter.year = y;
    updateYearSliderUI();
    applyGeneratorFilters();
  }, pb.speedMs);
}
