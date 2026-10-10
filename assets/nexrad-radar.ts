// ─── NEXRAD live radar: frame poll ────────────────────────────────────────────
// Role: keep the radar on one consistent, current scan. IEM's "-0" latest-frame
//       alias resolves per tile inside their cache, so during a frame rollover
//       adjacent tiles can come from different volume scans (visible seams).
//       tms.json names the current frame atomically (ridge::USCOMP-N0Q-
//       YYYYMMDDHHMM); polling it and swapping in the timestamped layer name
//       keeps every tile on the same scan. New frames land ~5 min apart; the 60s
//       poll of the tiny JSON keeps swap lag low, and setTiles only fires on a
//       frame change. Polls only while the layer is on, refreshes at once when
//       it is switched on and when the page is shown again.
//       Also owns the Canada GeoMet source table (GEOMET_RADAR, geometTiles),
//       which layers/map-layers-conditions.ts (planNexradRadar) builds from.
// Deps: state (map, layerVisibility), constants (radar URLs), live-poll.ts
//       (pollWhileVisible), state-bus.ts (on 'layer:visibility' — switch-on refresh).
// Started from layers/add-all-layers.ts via startNexradRadar(), once the
// radar sources and layers exist.

import type { RasterTileSource } from 'maplibre-gl';
import { state } from './state.js';
import { RADAR_TILE_TEMPLATE, RADAR_TMS_JSON_URL, GEOMET_RADAR_TILE_TEMPLATE } from './constants.js';
import { pollWhileVisible } from './live-poll.js';
import { on } from './state-bus.js';

const REGISTRY_ID = "nexrad-radar";
let started = false;
let radarFrame = "";   // last applied timestamped layer name

// Canada: ECCC GeoMet WMS, one source per product (GeoMet rejects multi-layer
// GetMap). Both toggle with the nexrad-radar row via the registry mapLayerIds.
export const GEOMET_RADAR = [
  ["geomet-radar-rain", "RADAR_1KM_RRAI"],
  ["geomet-radar-snow", "RADAR_1KM_RSNO"],
] as const;

export const geometTiles = (wmsLayer: string, bust: string) =>
  [GEOMET_RADAR_TILE_TEMPLATE.replace("{layer}", wmsLayer).replace("{bust}", bust)];

async function refreshRadarFrame() {
  const map = state.map;
  if (!map?.getLayer(REGISTRY_ID)) return;
  if (map.getLayoutProperty(REGISTRY_ID, "visibility") !== "visible") return;
  try {
    const res = await fetch(RADAR_TMS_JSON_URL);
    if (!res.ok) return;
    const tms = await res.json() as { services?: { id: string; layername: string }[] };
    const layername = tms.services?.find(s => s.id === "ridge_uscomp_n0q")?.layername;
    if (!layername || layername <= radarFrame || !map.getSource(REGISTRY_ID)) return;  // names end in the scan's YYYYMMDDHHMM
    radarFrame = layername;
    (map.getSource(REGISTRY_ID) as RasterTileSource)
      .setTiles([RADAR_TILE_TEMPLATE.replace("{layer}", layername)]);
    // GeoMet has no frame index we poll; TIME-less GetMap always serves the
    // latest frame, so cache-busting on the IEM frame change (~5 min) is enough.
    for (const [srcId, wmsLayer] of GEOMET_RADAR) {
      const src = map.getSource(srcId) as RasterTileSource | undefined;
      src?.setTiles(geometTiles(wmsLayer, layername));
    }
  } catch {
    // transient network failure — keep showing the current frame
  }
}

export function startNexradRadar() {
  void refreshRadarFrame();
  if (started) return;
  started = true;
  pollWhileVisible({
    intervalMs: 60_000,
    active: () => !!state.layerVisibility[REGISTRY_ID],
    run: refreshRadarFrame,
  });
  // Switching the radar on shows the current scan, not whichever frame was
  // last applied before it was switched off.
  on('layer:visibility', ({ id, visible }) => {
    if (visible && id === REGISTRY_ID) void refreshRadarFrame();
  });
}
