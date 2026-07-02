// ─── Layer + legend filter wiring, MW range filter ───────────────────────────

import { state } from '../state.js';
import { LEGEND_FILTERS_BY_KEY, legendAllIds, syncLegendMaster } from './ui-legends.js';
import { emit } from '../state-bus.js';
import { MW_SLIDER_MAX, mwPosToMw, mwToPos } from '../filters.js';

export function wireLayerFilterPanels() {
  document.addEventListener("change", (e) => {
    const cb = (e.target as Element)?.closest<HTMLInputElement>("input[type=checkbox][data-filter-layer]");
    if (!cb) return;
    const active = state.layerFilters[cb.dataset.filterLayer!];
    if (!active) return;
    cb.checked ? active.add(cb.dataset.bucketId!) : active.delete(cb.dataset.bucketId!);
    emit('filter:layer', { id: cb.dataset.filterLayer! });
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
    mwSliderMin.value = String(mwToPos(state.mwFilter.min));
    mwSliderMax.value = String(mwToPos(state.mwFilter.max));
    updateMwSliderUI();
    mwSliderMin.addEventListener("input", onMwSliderInput);
    mwSliderMax.addEventListener("input", onMwSliderInput);
  }

  const mwMinInput = document.getElementById("mwMinInput");
  const mwMaxInput = document.getElementById("mwMaxInput");
  if (mwMinInput && mwMaxInput) {
    mwMinInput.addEventListener("change", onMwTextChange);
    mwMaxInput.addEventListener("change", onMwTextChange);
  }
}

const MW_POS_GAP = 1; // min separation between handles, in slider position units

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
  emit('filter:generators');
  emit('url:write');
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
  emit('filter:generators');
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
    btn.parentElement?.querySelectorAll<HTMLElement>(".gen-mode-btn").forEach(b =>
      b.classList.toggle("gen-mode-btn--active", b.dataset.genMode === mode));
    emit('gen:mode', { id });
    emit('url:write');
  });
}

export function wireOgfColorByToggle() {
  document.addEventListener("click", (e) => {
    const btn = (e.target as Element)?.closest<HTMLElement>(".gen-mode-btn[data-ogf-colorby]");
    if (!btn) return;
    const mode = btn.dataset.ogfColorby as typeof state.ogfColorBy;
    if (state.ogfColorBy === mode) return;
    state.ogfColorBy = mode;
    btn.parentElement?.querySelectorAll<HTMLElement>("[data-ogf-colorby]").forEach(b =>
      b.classList.toggle("gen-mode-btn--active", b.dataset.ogfColorby === mode));
    emit('ogf:colorby');
    emit('url:write');
  });
}

export function wireYearFilter() {
  // ponytail: delegate on document — the panel HTML gets re-rendered by
  // buildLayersPanel() (e.g. Reset all layers), which would orphan any
  // listener bound directly to the button/slider elements.
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

  updateYearSliderUI();
  updateYearPlayBtn();
}

function onYearSliderInput(e: Event) {
  state.yearFilter.year    = parseInt((e.target as HTMLInputElement).value, 10);
  state.yearFilter.enabled = true;
  stopYearPlayback();
  updateYearSliderUI();
  emit('filter:generators');
  emit('url:write');
}

export function updateYearSliderUI() {
  const slider  = document.getElementById("yearSlider") as HTMLInputElement | null;
  const readout = document.getElementById("yearReadout");
  if (!slider) return;
  const yf = state.yearFilter;
  slider.value = String(yf.year);
  slider.classList.toggle("year-slider--off", !yf.enabled);
  if (readout) readout.textContent = yf.enabled ? String(yf.year) : "All years";
}

function clearYearFilter() {
  stopYearPlayback();
  state.yearFilter.enabled = false;
  updateYearSliderUI();
  emit('filter:generators');
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
  emit('filter:generators');
  emit('url:write');
  pb.interval = setInterval(() => {
    let y = state.yearFilter.year + 1;
    if (y > state.yearFilter.max) y = state.yearFilter.min;
    state.yearFilter.year = y;
    updateYearSliderUI();
    emit('filter:generators');
  }, pb.speedMs);
}

export function updateYearPlayBtn() {
  const btn = document.getElementById("yearPlayBtn");
  if (!btn) return;
  btn.textContent = state.yearPlayback.active ? "⏸" : "▶";
  btn.title       = state.yearPlayback.active ? "Pause playback" : "Play through years";
}
