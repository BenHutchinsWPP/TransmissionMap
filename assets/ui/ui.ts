// ─── UI bootstrap + event wiring ──────────────────────────────────────────────
// Top-level init() + the delegated event wiring (wireUI). The Reset button is
// view-state.ts's applyView({}); panel-mirror.js repaints every panel control
// from state after any applied view, and renders the layer rows (renderPanel)
// at init and on a language or region change; the 'view:applied' subscriber
// below keeps the rest (year playback, legends). Menubar wiring lives in
// ui-menubar.js; My Data tab handlers in ui-mydata.js. Smoke opacity is painted by map-layers-conditions.js. The
// Data Credits dialog opens its hand-written index.html markup immediately,
// then lazily loads ui-credits.js once to add the generated manifest's detail.
// undo.js: its bus subscriptions keep the view's undo history; resetHistory
// re-baselines it once a ?exp= deep link's story has applied. The region
// dropdown is painted by panel-mirror.js; its click writes the scope, re-renders
// the panel and writes the URL.

import { state } from '../state.js';
import { activeExperienceId, endExperienceLink, rebaselineExperience } from '../experience-link.js';
import { LAYER_SOURCES } from '../../src/registry/index.js';
import type { LayerScope } from '../../src/types.js';
import { YEAR_FILTER_MIN, YEAR_FILTER_MAX } from '../../src/colors/ramps.js';
import { setLayerVisibility } from '../visibility.js';
import { initMap } from '../map.js';
import { switchBasemap, switchProjection, setBasemapLabels } from '../basemap.js';
import { setTerrain3d, setBuildings3d, setHillshade } from '../terrain.js';
import { maybeShowRotateHint } from '../terrain-hint.js';
import { buildLegends } from './ui-legends.js';
import {
  wireLayerFilterPanels, wireLegendFilters, wireMwFilter, wireSmokeOpacity,
  wireGenModeToggle, wireOgfColorByToggle, wireWestTECColorByToggle, wireWeatherVarSelect, wireNriHazardSelect, wireYearFilter,
  stopYearPlayback,
} from './ui-filters.js';
import { wireFeatureSearch } from './ui-search.js';
import { wireGeocoder } from './ui-geocoder.js';
import { wireOpenWith } from './ui-openwith.js';
import { readUrlState } from '../url-state.js';
import { splitHash } from '../url-state-codec.js';
import { applyView } from '../view-state.js';
import { resetHistory } from '../undo.js';
import { emit, on } from '../state-bus.js';
import { loadUnits } from '../units-store.js';
import { loadLanguage } from '../i18n-store.js';
import { updateDomTranslations } from '../../src/i18n/index.js';
import { renderMyDataTab } from '../user-data/user-data.js';
import { clearFeatureInfo } from '../user-data/user-data-geom.js';
import { onMapTap } from '../map-input.js';
import { updateMeasureReadout } from '../measure.js';
import { renderPanel } from './panel-mirror.js';
import { wireMenubar } from './ui-menubar.js';
import { wireMyData } from './ui-mydata.js';
import { initWildfireStaleness } from '../wildfire-staleness.js';
import { initNwsStaleness } from '../nws-staleness.js';
import { initOdinOutages } from '../odin-outages.js';
import { initFemaNri } from '../fema-nri.js';
import { initWeatherLive } from '../weather-live.js';
import { initNwsZoneJoin } from '../nws-zone-join.js';
import { TRIBAL_LAYER_IDS, showTribalDisclaimer } from '../tribal-disclaimer.js';
// Static import is deliberate: diag-log.js is a zero-import leaf module (just
// an array), so reading it here costs nothing. ui-diagnostics.js and
// diagnostics.js are NOT imported here — pulling either in statically would
// defeat their lazy-chunk split (see ui-menubar.ts).
import { getDiagLog, DIAG_EVENT, recordDiagEvent } from '../diag-log.js';

// ─── Entry point ─────────────────────────────────────────────────────────────
export async function init() {
  await loadLanguage(splitHash(location.hash).params.get('lang'));
  updateDomTranslations();
  loadUnits();
  state.yearFilter.min  = YEAR_FILTER_MIN;
  state.yearFilter.max  = YEAR_FILTER_MAX;

  readUrlState();

  initMap();
  renderPanel();
  buildLegends();
  wireUI();
  if (TRIBAL_LAYER_IDS.some(id => state.layerVisibility[id])) showTribalDisclaimer();
  initWildfireStaleness();
  initNwsStaleness();
  initOdinOutages();
  initFemaNri();
  initWeatherLive();
  initNwsZoneJoin();
}

// The panel mirror (panel-mirror.js) repaints the controls on 'view:applied';
// what is left here is not a control value.
on('view:applied', () => {
  stopYearPlayback();
  buildLegends();
});

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

let creditsRender: Promise<void> | null = null;

// Lazy chunk (ui-credits.js), loaded and rendered once per page load by
// whichever credits entry point opens first: adds the generated manifest's
// per-layer detail to the hand-written entries the dialog is already showing.
// A chunk that fails to load is recorded in the diagnostics log and the
// hand-written entries stay as shipped.
function renderCredits(): Promise<void> {
  return creditsRender ??= import("./ui-credits.js")
    .then(m => m.renderDataCredits())
    .catch(err => recordDiagEvent('layer', `credits chunk: ${err}`));
}

async function openSourceCredit(sourceId: string) {
  const source = LAYER_SOURCES[sourceId];
  const creditsDialog = document.getElementById("creditsDialog") as HTMLDialogElement | null;
  if (!source || !creditsDialog) return;

  clearCreditHighlight();
  if (!creditsDialog.open) creditsDialog.showModal();
  // The render may add this source's entry, so look it up afterwards.
  await renderCredits();
  const target = document.querySelector(`[data-source-credit="${sourceId}"]`);
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
  wireDialogs();
  wireFileMenuBadge();
  wireDisclaimerDialog();
  wireCollapseToggles();
  wireMwFilter();
  wireSmokeOpacity();
  wireGenModeToggle();
  wireOgfColorByToggle();
  wireWestTECColorByToggle();
  wireWeatherVarSelect();
  wireNriHazardSelect();
  wireYearFilter();
  wireResetLayers();
  wireRegionSelect();
  wireUnitsChanged();
  wireLangChanged();

  wireExperienceDeepLink();

  wireFeatureSearch();
  wireGeocoder();
  wireOpenWith();
  wireMenubar();
  wirePanelTabs();
  wireMyData();
}

// The region selector scopes what the panel lists: 'usa' lists everything,
// 'global' hides the US-only layers. Which continental download pack a button
// points at is chosen per-download in the menu, not here. Map data is planet-wide
// — one tileset per layer — so changing scope never reloads a source.
export function wireRegionSelect() {
  const dropdown = document.getElementById("regionDropdown");
  const btn = document.getElementById("regionDropdownBtn") as HTMLButtonElement | null;
  const menu = document.getElementById("regionMenu");
  if (!dropdown || !btn || !menu) return;

  const items = () => [...menu.querySelectorAll<HTMLButtonElement>(".region-menu-item")];
  const close = (refocus = false) => {
    menu.hidden = true;
    btn.setAttribute("aria-expanded", "false");
    if (refocus) btn.focus();
  };
  const open = (focusOption = false) => {
    menu.hidden = false;
    btn.setAttribute("aria-expanded", "true");
    if (focusOption) {
      (menu.querySelector<HTMLButtonElement>(".region-menu-item--active") ?? items()[0])?.focus();
    }
  };

  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (menu.hidden) open(); else close();
  });

  // Arrow keys walk the options and wrap, matching the native <select> this
  // replaced; the options are buttons, so Enter and Space already activate.
  btn.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      open(true);
    }
  });

  menu.addEventListener("keydown", (e) => {
    const all = items();
    const i = all.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const step = e.key === "ArrowDown" ? 1 : -1;
      all[(i + step + all.length) % all.length]?.focus();
    } else if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      (e.key === "Home" ? all[0] : all[all.length - 1])?.focus();
    } else if (e.key === "Tab") {
      close();
    }
  });

  menu.addEventListener("click", (e) => {
    const item = (e.target as Element)?.closest<HTMLButtonElement>(".region-menu-item");
    if (!item || !item.dataset.region) return;
    const nextScope = item.dataset.region as LayerScope;
    close(true);
    if (nextScope === state.regionScope) return;
    state.regionScope = nextScope;
    renderPanel();
    // Region scopes the panel, not the map, so the change is not an edit of an
    // active experience: rebaseline before the write the link diff compares.
    rebaselineExperience();
    emit('url:write');
  });

  document.addEventListener("click", (e) => {
    if (!dropdown.contains(e.target as Node)) close();
  });
  onMapTap(() => close());

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !menu.hidden) close(true);
  });
}

// A hash carrying `exp=<id>` restores a curated story. readUrlState() has
// already named the story (experience-link.ts); applying it needs a finished
// map, and the catalogue plus the story controller live in the ui-experiences lazy chunk —
// so this is the one place besides the File menu that pulls that chunk in.
function wireExperienceDeepLink() {
  if (!activeExperienceId()) return;
  on('map:ready', async () => {
    try {
      const m = await import('./ui-experiences.js');
      m.restoreFromUrl();
      resetHistory();
    } catch (err) {
      // The chunk didn't load, so nothing applied the preset. Drop the id or
      // every later write would keep claiming a story the map isn't showing.
      console.warn('[TransmissionMap] Map Experiences chunk failed to load:', err);
      recordDiagEvent('layer', `experiences chunk: ${err}`);
      endExperienceLink();
      emit('url:write');
    }
  });
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
  });
}

function wireResetLayers() {
  const btn = document.getElementById("resetLayersBtn");
  if (!btn) return;
  btn.addEventListener("click", () => {
    if (window.confirm("Reset all layers, filters and basemap to their defaults?\n(Your imported and drawn data is kept.)")) {
      applyView({});
    }
  });
}

function wireBasemap() {
  document.addEventListener("change", (e) => {
    const el = e.target as Element;
    const basemap = el?.closest<HTMLInputElement>("input[type=radio][name=basemap]");
    if (basemap) { switchBasemap(basemap.value); emit('url:write'); return; }
    const proj = el?.closest<HTMLInputElement>("input[type=radio][name=projection]");
    if (proj) { switchProjection(proj.value); emit('url:write'); return; }
    const labelsToggle = el?.closest<HTMLInputElement>("input[id=basemapLabelsToggle]");
    if (labelsToggle) { setBasemapLabels(labelsToggle.checked); emit('url:write'); return; }
    const terrain = el?.closest<HTMLInputElement>("input[id=terrain3dToggle]");
    if (terrain) { setTerrain3d(terrain.checked); if (terrain.checked) maybeShowRotateHint(); emit('url:write'); return; }
    const buildings = el?.closest<HTMLInputElement>("input[id=buildings3dToggle]");
    if (buildings) { setBuildings3d(buildings.checked); if (buildings.checked) maybeShowRotateHint(); emit('url:write'); return; }
    const hillshade = el?.closest<HTMLInputElement>("input[id=hillshadeToggle]");
    if (hillshade) { setHillshade(hillshade.checked); emit('url:write'); return; }
  });
}

function wireSourceButtons() {
  document.addEventListener("click", (e) => {
    const btn = (e.target as Element)?.closest<HTMLElement>(".source-btn[data-source-id]");
    if (!btn) return;
    e.preventDefault();
    void openSourceCredit(btn.dataset.sourceId!);
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
    if (!t?.closest(".dl-menu") && !t?.closest(".dl-btn")) closeDownloadMenus();
  });
  onMapTap(closeDownloadMenus);
}

function closeDownloadMenus() {
  document.querySelectorAll<HTMLElement>(".dl-menu:not([hidden])").forEach(m => { m.hidden = true; });
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

// Close button + backdrop click for each modal. Diagnostics and Settings are
// opened from ui-menubar.ts's lazy imports, so this module wires only their
// chrome and never pulls in either chunk itself.
function wireDialogs() {
  for (const [dialogId, closeId] of [
    ["creditsDialog", "closeCredits"],
    ["diagnosticsDialog", "closeDiagnostics"],
    ["settingsDialog", "closeSettings"],
    ["experiencesDialog", "closeExperiences"],
  ]) {
    const dialog = document.getElementById(dialogId) as HTMLDialogElement | null;
    if (!dialog) continue;
    document.getElementById(closeId)?.addEventListener("click", () => dialog.close());
    dialog.addEventListener("click", (e) => { if (e.target === dialog) dialog.close(); });
  }

  // Credits alone has an open trigger here (the others live in the menubar) and
  // clears its highlight on the way in and out.
  const credits = document.getElementById("creditsDialog") as HTMLDialogElement | null;
  if (!credits) return;
  document.getElementById("infoButton")?.addEventListener("click", () => {
    clearCreditHighlight();
    credits.showModal();
    void renderCredits();
  });
  credits.addEventListener("close", clearCreditHighlight);
}

// A display-unit change re-renders every unit-bearing string that's already
// on screen. Subscribed once here — not in measure.ts or user-data-geom.ts —
// because both of those modules write #featureInfo and a second subscriber
// per module would race to own the same DOM node. Legend ramp end labels
// (RampDef.fmt) come from buildLegends(); a rendered popup's HTML is a
// static string baked with the old units and has no stored feature to
// re-render from, so it's dismissed rather than reformatted.
function wireUnitsChanged() {
  on('units:changed', () => {
    buildLegends();
    state.popup?.remove();
    // An active measurement owns #featureInfo and can be recomputed from
    // state.measure.points, so it repaints; a finished one would otherwise
    // keep its line on the map with no distance beside it.
    if (state.measure.active) updateMeasureReadout();
    else clearFeatureInfo();
  });
}

// The one language handler for the panel and the legends: translations land in
// the DOM before renderPanel() rebuilds the rows and copies the region label
// from its menu item, and buildLegends() runs after both (ui-legends.ts does
// not subscribe itself, so the legends rebuild once per change).
export function wireLangChanged() {
  on('lang:changed', () => {
    state.popup?.remove();
    updateDomTranslations();
    renderPanel();
    buildLegends();
  });
}

// A quiet dot on the File menu button once a real runtime error has been
// recorded this session. getDiagLog is a plain in-memory read, and DIAG_EVENT
// fires from diag-log.ts on each record, so the badge costs no network traffic
// and no timer.
function wireFileMenuBadge() {
  const badge = document.getElementById("fileMenuBadge");
  if (!badge) return;
  const update = () => { badge.hidden = getDiagLog().length === 0; };
  update();
  window.addEventListener(DIAG_EVENT, update);
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
