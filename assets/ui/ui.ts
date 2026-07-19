// ─── UI bootstrap + event wiring ──────────────────────────────────────────────
// Top-level init() + the delegated event wiring (wireUI). Layer-row HTML lives
// in ui-layer-rows.js; menubar wiring in ui-menubar.js; My Data tab handlers in
// ui-mydata.js.

import { state } from '../state.js';
import { LAYERS, LAYER_SOURCES } from '../../src/registry/index.js';
import { YEAR_FILTER_MIN, YEAR_FILTER_MAX, YEAR_FILTER_DEFAULT } from '../../src/colors/ramps.js';
import { MW_SLIDER_MAX, mwToPos } from '../filters.js';
import { setLayerVisibility, applyAllGenModes } from '../visibility.js';
import { ensureLayerData } from '../layers/layer-init.js';
import { initMap, switchBasemap, switchProjection, setBasemapLabels } from '../map.js';
import { setTerrain3d, setBuildings3d } from '../terrain.js';
import {
  LEGEND_FILTERS, legendAllIds,
  buildLegends, updateLegends,
} from './ui-legends.js';
import {
  wireLayerFilterPanels, wireLegendFilters, wireMwFilter,
  wireGenModeToggle, wireOgfColorByToggle, wireWestTECColorByToggle, wireWeatherVarSelect, wireYearFilter,
  updateMwSliderUI, updateYearSliderUI, updateYearPlayBtn,
  stopYearPlayback,
} from './ui-filters.js';
import { wireFeatureSearch } from './ui-search.js';
import { wireGeocoder } from './ui-geocoder.js';
import { wireOpenWith } from './ui-openwith.js';
import { readUrlState } from '../url-state.js';
import { emit } from '../state-bus.js';
import { renderMyDataTab } from '../user-data/user-data.js';
import { buildLayersPanel } from './ui-layer-rows.js';
import { wireMenubar } from './ui-menubar.js';
import { wireMyData } from './ui-mydata.js';
import { initWildfireStaleness } from '../wildfire-staleness.js';
import { initNwsStaleness } from '../nws-staleness.js';
import { initOdinOutages } from '../odin-outages.js';
import { initWeatherLive, syncWeatherLiveVisibility } from '../weather-live.js';
import { initNwsZoneJoin, syncZoneVisibility } from '../nws-zone-join.js';
import { TRIBAL_LAYER_IDS, showTribalDisclaimer } from '../tribal-disclaimer.js';
import { RASTER_PROBES, updateRasterArrow } from '../raster-probes.js';

function resetLayerState() {
  for (const entry of LAYERS) {
    state.layerVisibility[entry.id] = entry.defaultOn;
    if (entry.filterBuckets) {
      state.layerFilters[entry.id] = new Set(
        entry.filterBuckets.filter(b => b.default !== false).map(b => b.id)
      );
    }
    if (entry.heatLayerId) state.genMode[entry.id] = "icons";
  }
  for (const cfg of LEGEND_FILTERS) {
    state.legendFilters[cfg.key] = new Set(cfg.defaultActive ?? legendAllIds(cfg));
  }
}

// ─── Entry point ─────────────────────────────────────────────────────────────
export function init() {
  resetLayerState();
  state.yearFilter.min  = YEAR_FILTER_MIN;
  state.yearFilter.max  = YEAR_FILTER_MAX;
  state.yearFilter.year = YEAR_FILTER_DEFAULT;

  readUrlState();

  initMap();
  buildLayersPanel();
  buildLegends();
  wireUI();
  if (TRIBAL_LAYER_IDS.some(id => state.layerVisibility[id])) showTribalDisclaimer();
  initWildfireStaleness();
  initNwsStaleness();
  initOdinOutages();
  initWeatherLive();
  initNwsZoneJoin();

  // Bandwidth tracking system
  const toggle = document.getElementById("dataCounterToggle") as HTMLInputElement | null;
  if (toggle) {
    toggle.checked = window.innerWidth <= 768; // On by default for mobile, off for desktop
  }
  updateLegends();

  let totalBytes = 0;
  const updateCounter = (bytes: number) => {
    totalBytes += bytes;
    const el = document.getElementById("dataUsageVal");
    if (el) {
      el.textContent = totalBytes < 1048576
        ? `${(totalBytes / 1024).toFixed(2)} KB`
        : `${(totalBytes / 1048576).toFixed(2)} MB`;
    }
  };

  // 1. Intercept static assets (images, CSS, JS, fonts)
  try {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries() as PerformanceResourceTiming[]) {
        if (entry.initiatorType === "fetch" || entry.initiatorType === "xmlhttprequest") {
          continue; // Handled by fetch wrapper to bypass CORS size masking
        }
        const size = entry.transferSize || entry.decodedBodySize || 0;
        if (size > 0) updateCounter(size);
      }
    });
    observer.observe({ type: "resource", buffered: true });
  } catch (e) {
    console.warn("PerformanceObserver failed:", e);
  }

  // 2. Intercept dynamic API, tiles, and layers (fetch calls)
  const originalFetch = window.fetch;
  window.fetch = async function(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const response = await originalFetch(input, init);
    // ponytail: count only when content-length is present; skip body-buffering
    // fallback (clone().blob()) — it bought a few unlabeled responses at the
    // cost of buffering every response body on the hot path.
    const contentLength = response.headers.get("content-length");
    // Service-worker cache hits cost zero network bytes — don't count them.
    if (contentLength && response.headers.get("x-sw-cache") !== "hit") {
      updateCounter(parseInt(contentLength, 10));
    }
    return response;
  };
}

// ─── Reset all layer settings to defaults ────────────────────────────────────
function resetLayersToDefaults() {
  resetLayerState();
  state.mwFilter = { min: 0, max: MW_SLIDER_MAX };
  stopYearPlayback();
  state.yearFilter.enabled = false;
  state.yearFilter.year = YEAR_FILTER_DEFAULT;

  for (const entry of LAYERS) {
    const vis = entry.defaultOn ? "visible" : "none";
    if (entry.defaultOn) ensureLayerData(entry.id);
    for (const mlId of entry.mapLayerIds) {
      if (state.map?.getLayer(mlId)) state.map.setLayoutProperty(mlId, "visibility", vis);
    }
    // setLayerVisibility() clears a hidden layer's hover-probe bubble line;
    // this loop bypasses that, so do it by hand or a parked cursor keeps
    // showing a stale reading for a probe that's now off.
    if (vis === "none" && RASTER_PROBES[entry.id]) updateRasterArrow(entry.id, null);
  }
  // This loop flips map visibility directly rather than through
  // setLayerVisibility(), so weather-live.ts's and nws-zone-join.ts's
  // checkbox-change listeners never fire — sync their own hidden state by
  // hand or a Reset leaves wind particles animating / alert zones painted.
  syncWeatherLiveVisibility();
  syncZoneVisibility();

  emit('filter:all');

  if (state.basemap !== "light") switchBasemap("light");
  const lightRadio = document.querySelector<HTMLInputElement>('input[type=radio][name=basemap][value="light"]');
  if (lightRadio) lightRadio.checked = true;

  if (state.projection !== "mercator") switchProjection("mercator");
  const flatRadio = document.querySelector<HTMLInputElement>('input[type=radio][name=projection][value="mercator"]');
  if (flatRadio) flatRadio.checked = true;

  if (state.terrain3d) setTerrain3d(false);
  if (state.buildings3d) setBuildings3d(false);
  const terrainToggle = document.getElementById("terrain3dToggle") as HTMLInputElement | null;
  if (terrainToggle) terrainToggle.checked = false;
  const buildingsToggle = document.getElementById("buildings3dToggle") as HTMLInputElement | null;
  if (buildingsToggle) buildingsToggle.checked = false;

  buildLayersPanel();
  buildLegends();
  applyAllGenModes();

  const mwMin = document.getElementById("mwSliderMin") as HTMLInputElement | null;
  const mwMax = document.getElementById("mwSliderMax") as HTMLInputElement | null;
  if (mwMin) mwMin.value = String(mwToPos(state.mwFilter.min));
  if (mwMax) mwMax.value = String(mwToPos(state.mwFilter.max));
  updateMwSliderUI();
  updateYearSliderUI();
  updateYearPlayBtn();

  emit('url:write');
}

// ─── Data-credits source focus helpers ───────────────────────────────────────
let creditHighlightTimer: number | null = null;

function clearCreditHighlight() {
  if (creditHighlightTimer) {
    window.clearTimeout(creditHighlightTimer);
    creditHighlightTimer = null;
  }
  document.querySelectorAll(".credit-highlight")
    .forEach(node => node.classList.remove("credit-highlight"));
}

function openSourceCredit(sourceId: string) {
  const source = LAYER_SOURCES[sourceId];
  const creditsDialog = document.getElementById("creditsDialog") as HTMLDialogElement | null;
  if (!source || !creditsDialog) return;

  const target = document.querySelector(`[data-source-credit="${sourceId}"]`);
  clearCreditHighlight();
  if (!creditsDialog.open) creditsDialog.showModal();
  if (!target) return;

  window.requestAnimationFrame(() => {
    target.scrollIntoView({ block: "center", behavior: "smooth" });
    target.classList.add("credit-highlight");
    creditHighlightTimer = window.setTimeout(() => {
      target.classList.remove("credit-highlight");
      creditHighlightTimer = null;
    }, 2400);
  });
}

// ─── Wire all UI events ───────────────────────────────────────────────────────
function wireUI() {
  wireLayerVisibility();
  wireLayerFilterPanels();
  wireLegendFilters();
  wireBasemap();
  wireSourceButtons();
  wireDownloadMenus();
  wirePanelToggle();
  wireCreditsDialog();
  wireDisclaimerDialog();
  wireCollapseToggles();
  wireMwFilter();
  wireGenModeToggle();
  wireOgfColorByToggle();
  wireWestTECColorByToggle();
  wireWeatherVarSelect();
  wireYearFilter();
  wireResetLayers();

  wireFeatureSearch();
  wireGeocoder();
  wireOpenWith();
  wireMenubar();
  wirePanelTabs();
  wireMyData();
}

function wirePanelTabs() {
  document.addEventListener('click', e => {
    const tab = (e.target as Element)?.closest<HTMLElement>('.layers-tab[data-tab]');
    if (!tab) return;
    const tabName = tab.dataset.tab!;
    document.querySelectorAll<HTMLElement>('.layers-tab').forEach(t =>
      t.classList.toggle('layers-tab--active', t.dataset.tab === tabName));
    document.querySelectorAll<HTMLElement>('.tab-pane').forEach(p => {
      p.hidden = p.id !== 'tab-' + tabName;
    });
    if (tabName === 'my-data') renderMyDataTab();
  });
}

function wireLayerVisibility() {
  document.addEventListener("change", (e) => {
    const cb = (e.target as Element)?.closest<HTMLInputElement>("input[type=checkbox][data-layer-id]");
    if (!cb) return;
    const id = cb.dataset.layerId!;
    setLayerVisibility(id, cb.checked);
    updateLegends();
  });
}

function wireResetLayers() {
  const btn = document.getElementById("resetLayersBtn");
  if (!btn) return;
  btn.addEventListener("click", () => {
    if (window.confirm("Reset all layers, filters and basemap to their defaults?\n(Your imported and drawn data is kept.)")) {
      resetLayersToDefaults();
    }
  });
}

function wireBasemap() {
  const active = document.querySelector<HTMLInputElement>(`input[type=radio][name=basemap][value="${state.basemap}"]`);
  if (active) active.checked = true;
  const activeProj = document.querySelector<HTMLInputElement>(`input[type=radio][name=projection][value="${state.projection}"]`);
  if (activeProj) activeProj.checked = true;
  // URL restore (readUrlState) runs before this wiring, so the checkboxes need
  // an explicit initial sync — unlike the radios above, there's no shared
  // `name` to select an "active" one from.
  const terrainToggle = document.getElementById("terrain3dToggle") as HTMLInputElement | null;
  if (terrainToggle) terrainToggle.checked = state.terrain3d;
  const buildingsToggle = document.getElementById("buildings3dToggle") as HTMLInputElement | null;
  if (buildingsToggle) buildingsToggle.checked = state.buildings3d;

  document.addEventListener("change", (e) => {
    const el = e.target as Element;
    const basemap = el?.closest<HTMLInputElement>("input[type=radio][name=basemap]");
    if (basemap) { switchBasemap(basemap.value); emit('url:write'); return; }
    const proj = el?.closest<HTMLInputElement>("input[type=radio][name=projection]");
    if (proj) { switchProjection(proj.value); emit('url:write'); return; }
    const labelsToggle = el?.closest<HTMLInputElement>("input[id=basemapLabelsToggle]");
    if (labelsToggle) { setBasemapLabels(labelsToggle.checked); return; }
    const dataToggle = el?.closest<HTMLInputElement>("input[id=dataCounterToggle]");
    if (dataToggle) { updateLegends(); return; }
    const terrain = el?.closest<HTMLInputElement>("input[id=terrain3dToggle]");
    if (terrain) { setTerrain3d(terrain.checked); emit('url:write'); return; }
    const buildings = el?.closest<HTMLInputElement>("input[id=buildings3dToggle]");
    if (buildings) { setBuildings3d(buildings.checked); emit('url:write'); return; }
  });
}

function wireSourceButtons() {
  document.addEventListener("click", (e) => {
    const btn = (e.target as Element)?.closest<HTMLElement>(".source-btn[data-source-id]");
    if (!btn) return;
    e.preventDefault();
    openSourceCredit(btn.dataset.sourceId!);
  });
}

function wireDownloadMenus() {
  document.addEventListener("click", (e) => {
    const t = e.target as Element;
    const btn = t?.closest<HTMLElement>(".dl-btn");
    if (btn) {
      e.stopPropagation();
      const menu = btn.nextElementSibling as HTMLElement | null;
      if (!menu) return;
      document.querySelectorAll<HTMLElement>(".dl-menu:not([hidden])").forEach(m => {
        if (m !== menu) m.hidden = true;
      });
      menu.hidden = !menu.hidden;
      return;
    }
    if (!t?.closest(".dl-menu") && !t?.closest(".dl-btn")) {
      document.querySelectorAll<HTMLElement>(".dl-menu:not([hidden])").forEach(m => { m.hidden = true; });
    }
  });
}

function wirePanelToggle() {
  const closeBtn  = document.getElementById("closeLayers");
  const toggleBtn = document.getElementById("layersToggleBtn");
  const panel     = document.getElementById("layersPanel");

  if (closeBtn) {
    closeBtn.addEventListener("click", () => {
      if (panel) panel.hidden = true;
      if (toggleBtn) toggleBtn.hidden = false;
    });
  }
  if (toggleBtn) {
    toggleBtn.addEventListener("click", () => {
      if (panel) panel.hidden = false;
      toggleBtn.hidden = true;
    });
  }
}

function wireCreditsDialog() {
  const infoBtn       = document.getElementById("infoButton");
  const creditsDialog = document.getElementById("creditsDialog") as HTMLDialogElement | null;
  const closeCredits  = document.getElementById("closeCredits");

  if (infoBtn && creditsDialog) {
    infoBtn.addEventListener("click", () => {
      clearCreditHighlight();
      creditsDialog.showModal();
    });
  }
  if (closeCredits && creditsDialog) {
    closeCredits.addEventListener("click", () => creditsDialog.close());
  }
  if (creditsDialog) {
    creditsDialog.addEventListener("click", (e) => {
      if (e.target === creditsDialog) creditsDialog.close();
    });
    creditsDialog.addEventListener("close", clearCreditHighlight);
  }
}

function wireDisclaimerDialog() {
  const dialog    = document.getElementById("disclaimerDialog") as HTMLDialogElement | null;
  const acceptBtn = document.getElementById("disclaimerAccept");
  if (dialog && !localStorage.getItem("tm_disclaimer_accepted")) {
    dialog.showModal();
  }
  if (acceptBtn && dialog) {
    acceptBtn.addEventListener("click", () => {
      localStorage.setItem("tm_disclaimer_accepted", "1");
      dialog.close();
    });
  }
  const tribalDialog = document.getElementById("tribalDisclaimerDialog") as HTMLDialogElement | null;
  const tribalAcceptBtn = document.getElementById("tribalDisclaimerAccept");
  if (tribalAcceptBtn && tribalDialog) {
    tribalAcceptBtn.addEventListener("click", () => tribalDialog.close());
  }
}

function wireCollapseToggles() {
  document.addEventListener("click", (e) => {
    const btn = (e.target as Element)?.closest<HTMLElement>(".collapse-btn");
    if (!btn) return;
    const section = btn.closest("[data-collapsible]");
    if (!section) return;
    const wasCollapsed = section.classList.contains("collapsed");
    section.classList.toggle("collapsed");
    btn.setAttribute("aria-expanded", String(wasCollapsed));
    btn.textContent = wasCollapsed ? "▾" : "▸";
  });

  document.querySelectorAll("[data-collapsible].collapsed .collapse-btn").forEach(btn => {
    btn.setAttribute("aria-expanded", "false");
    btn.textContent = "▸";
  });
}
