// ─── URL + localStorage state persistence ─────────────────────────────────────
// Side-effectful functions that link global state to the browser URL.

import { state } from './state.js';
import { parseUrlState, formatUrlState, type UrlStateData } from './url-state-codec.js';

function _hashParams() {
  const hash = location.hash.slice(1);
  const q = hash.indexOf('?');
  return new URLSearchParams(q >= 0 ? hash.slice(q + 1) : '');
}

export function readUrlState() {
  const params = _hashParams();
  const data = parseUrlState(params);

  if (data.layerVisibility) {
    Object.assign(state.layerVisibility, data.layerVisibility);
  }
  if (data.legendFilters) {
    Object.assign(state.legendFilters, data.legendFilters);
  }
  if (data.layerFilters) {
    Object.assign(state.layerFilters, data.layerFilters);
  }
  if (data.mwFilter) state.mwFilter = data.mwFilter;
  if (data.yearFilter) {
    state.yearFilter.enabled = data.yearFilter.enabled;
    state.yearFilter.year = data.yearFilter.year;
  }
  if (data.genMode) {
    Object.assign(state.genMode, data.genMode);
  }
  if (data.ogfColorBy) state.ogfColorBy = data.ogfColorBy as typeof state.ogfColorBy;
  if (data.westtecColorBy) state.westtecColorBy = data.westtecColorBy as typeof state.westtecColorBy;
  if (data.weatherVar) state.weatherVar = data.weatherVar;
  if (data.basemap) state.basemap = data.basemap;
  if (data.projection) state.projection = data.projection;
  if (data.terrain3d) state.terrain3d = true;
  if (data.buildings3d) state.buildings3d = true;
}

export function writeUrlState() {
  if (!state.mapReady || !state.map) return;

  const data: UrlStateData = {
    layerVisibility: state.layerVisibility,
    legendFilters: state.legendFilters,
    layerFilters: state.layerFilters,
    mwFilter: state.mwFilter,
    yearFilter: state.yearFilter,
    genMode: state.genMode,
    ogfColorBy: state.ogfColorBy,
    westtecColorBy: state.westtecColorBy,
    weatherVar: state.weatherVar,
    basemap: state.basemap,
    projection: state.projection,
    terrain3d: state.terrain3d,
    buildings3d: state.buildings3d,
  };

  const parts = formatUrlState(data);
  const stateStr = parts.length ? '?' + parts.join('&') : '';
  const { lat, lng } = state.map.getCenter();
  const zoom = state.map.getZoom().toFixed(2);
  let posStr = zoom + '/' + lat.toFixed(4) + '/' + lng.toFixed(4);
  // Rotation/tilt are appended only when non-zero, so the common flat/north-up
  // view keeps today's short "#zoom/lat/lng" link.
  const bearing = state.map.getBearing().toFixed(1);
  const pitch = state.map.getPitch().toFixed(1);
  if (Number(bearing) !== 0 || Number(pitch) !== 0) posStr += '/' + bearing + '/' + pitch;
  history.replaceState(null, '', location.pathname + '#' + posStr + stateStr);
}

// ─── Bus subscription ─────────────────────────────────────────────────────────
import { on } from './state-bus.js';
on('url:write', writeUrlState);
