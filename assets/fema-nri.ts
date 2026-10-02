// ─── FEMA National Risk Index county feature-state join ──────────────────────
// Role: fetch the geometry-less NRI table (FIPS → [score, rating] per hazard,
//       built by scripts/extract_fema_nri.py) once, and join the SELECTED
//       hazard onto the SHARED `county_boundaries` vector source (owned by
//       layers/layer-init.ts, promoteId=GEOID) via MapLibre feature-state,
//       under the namespaced keys `nri_r`/`nri_s` (selected hazard rating code
//       and score) and `nri_cr`/`nri_cs` (the composite, for the popup). Other
//       county-keyed layers (ODIN, NWS) share the same per-feature state bag, so
//       only these keys are ever written.
//       Feature-state only sticks to features in loaded tiles, so the join is
//       re-applied after new county tiles load (`sourcedata` marks it dirty, the
//       next `idle` applies it while the layer is visible). The first `idle`
//       with the layer visible — from a checkbox, a shared link, a story or
//       Reset — triggers the one fetch, so no caller needs to know about it.
//       Static data: no refresh, no staleness gate.
// Deps: state (map, DATA, layerVisibility, nriHazard), layers/layer-init.ts
//       (COUNTY_SRC), src/registry/conditions.ts (NRI_HAZARDS),
//       diag-log.ts (recordDiagEvent). The source/layers are built by
//       layers/map-layers-conditions.ts (addFemaNri); the picker is rendered by
//       ui/ui-layer-rows.ts and wired by ui/ui-filters.ts (setNriHazard); the
//       popup (popup-format.ts) reads the merged feature-state and nriVersion().
// Wired from ui/ui.ts init() via initFemaNri().

import { state, DATA } from './state.js';
import { COUNTY_SRC as SRC, COUNTY_SRC_LAYER as SRC_LAYER } from './layers/layer-init.js';
import { NRI_HAZARDS, DEFAULT_NRI_HAZARD } from '../src/registry/conditions.js';
import { recordDiagEvent } from './diag-log.js';

const REGISTRY_ID = "fema-nri";

interface NriTable {
  version: string | null;
  hazards: string[];
  counties: Record<string, (number | null)[]>;   // [score, rating] × hazards
}

let table: NriTable | null = null;
let loading: Promise<void> | null = null;
let dirty = true;

function isVisible(): boolean {
  return !!state.layerVisibility[REGISTRY_ID];
}

export function nriHazard(): string {
  return state.nriHazard;
}

export function nriHazardLabel(id: string = state.nriHazard): string {
  return (NRI_HAZARDS.find(h => h.id === id) ?? NRI_HAZARDS[0]).label;
}

// NRI data version for the popup footer ("December 2025"); null before load.
export function nriVersion(): string | null {
  return table?.version ?? null;
}

function applyJoin() {
  if (!state.map || !table || !state.map.getSource(SRC)) return;
  const hi = Math.max(0, table.hazards.indexOf(state.nriHazard));
  const ci = Math.max(0, table.hazards.indexOf(DEFAULT_NRI_HAZARD));
  for (const fips in table.counties) {
    const v = table.counties[fips];
    // Rating code 0 = not applicable → null, which the paint leaves transparent
    // and popup.ts's hit test treats as unlit.
    state.map.setFeatureState(
      { source: SRC, sourceLayer: SRC_LAYER, id: fips },
      { nri_r: v[2 * hi + 1] || null, nri_s: v[2 * hi], nri_cr: v[2 * ci + 1] || null, nri_cs: v[2 * ci] },
    );
  }
  dirty = false;
}

function ensureLoaded(): Promise<void> {
  loading ??= (async () => {
    try {
      const resp = await fetch(DATA.fema_nri);
      if (!resp.ok) throw new Error(`${resp.status} ${resp.statusText}`);
      table = await resp.json() as NriTable;
      if (isVisible()) applyJoin();
    } catch (err) {
      console.warn("[TransmissionMap] FEMA NRI load failed", err);
      recordDiagEvent('layer', `fema-nri: ${err}`);
      loading = null;   // let the next idle retry
    }
  })();
  return loading;
}

function renderLegendHazard() {
  const el = document.getElementById("femaNriHazard");
  if (el) el.textContent = nriHazardLabel();
}

// Picker, shared link, story and Reset all land here. An unknown id falls back
// to the composite rather than painting nothing.
export function setNriHazard(id: string) {
  state.nriHazard = NRI_HAZARDS.some(h => h.id === id) ? id : DEFAULT_NRI_HAZARD;
  dirty = true;
  if (isVisible()) applyJoin();
  renderLegendHazard();
}

export function initFemaNri() {
  if (!state.map) return;
  renderLegendHazard();
  state.map.on("sourcedata", (e) => {
    const ev = e as { sourceId?: string; isSourceLoaded?: boolean };
    if (ev.sourceId === SRC && ev.isSourceLoaded) dirty = true;
  });
  state.map.on("idle", () => {
    if (!isVisible()) return;
    if (!table) { void ensureLoaded(); return; }
    if (dirty) applyJoin();
  });
}
