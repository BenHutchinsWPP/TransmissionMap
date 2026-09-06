// ─── URL hash state persistence ─────────────────────────────────────────────
// Side-effectful functions that link global state to the browser URL.

import { state, rebaselineExperience } from './state.js';
import { parseUrlState, formatUrlState, type UrlStateData } from './url-state-codec.js';
import { getLocale, setLocale, type SupportedLocale } from '../src/i18n/index.js';
import { on, emit } from './state-bus.js';

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
  if (data.smokeOpacity !== undefined) state.smokeOpacity = data.smokeOpacity;
  if (data.basemap) state.basemap = data.basemap;
  if (data.projection) state.projection = data.projection;
  if (data.terrain3d) state.terrain3d = true;
  if (data.buildings3d) state.buildings3d = true;
  if (data.hillshade) state.hillshade = true;
  if (data.lang) setLocale(data.lang as SupportedLocale);
  if (data.region) state.regionScope = data.region;
  // Only the id is restored here. Applying the preset needs the map, so
  // assets/experiences.ts picks it up once the style has finished loading.
  if (data.experienceId) {
    state.experienceId = data.experienceId;
    state.experienceDirty = false;
    state.experiencePristine = null;
  }
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
    smokeOpacity: state.smokeOpacity,
    basemap: state.basemap,
    projection: state.projection,
    terrain3d: state.terrain3d,
    buildings3d: state.buildings3d,
    hillshade: state.hillshade,
    lang: getLocale(),
    region: state.regionScope,
  };

  // `exp` is the one param the codec can't decide on its own: whether the link
  // still names the experience depends on runtime dirty tracking. So the rest
  // is formatted first and diffed against the snapshot the preset left behind,
  // and only a still-pristine id is handed back to the codec.
  //
  // Pristine-vs-edited: an experience owns every param here, but not the camera
  // — panning and zooming inside a story keeps the link on the story. The first
  // write after a preset lands records the snapshot; any later write that
  // differs is the user's own edit, and `exp` drops off the link.
  const parts = formatUrlState(data);
  if (state.experienceId && !state.experienceDirty) {
    const snapshot = parts.join('&');
    if (state.experiencePristine === null) state.experiencePristine = snapshot;
    else if (snapshot !== state.experiencePristine) {
      state.experienceDirty = true;
      emit('exp:dirty');
    }
  }
  const stateParts = state.experienceId && !state.experienceDirty
    ? formatUrlState({ ...data, experienceId: state.experienceId })
    : parts;
  const stateStr = stateParts.length ? '?' + stateParts.join('&') : '';
  const { lat, lng } = state.map.getCenter();
  const zoom = state.map.getZoom().toFixed(2);
  let posStr = zoom + '/' + lat.toFixed(4) + '/' + lng.toFixed(4);
  // Rotation/tilt are appended only when non-zero, so the common flat/north-up
  // view keeps today's short "#zoom/lat/lng" link.
  const bearing = state.map.getBearing().toFixed(1);
  const pitch = state.map.getPitch().toFixed(1);
  if (Number(bearing) !== 0 || Number(pitch) !== 0) posStr += '/' + bearing + '/' + pitch;
  // Browsers rate-limit replaceState (Safari: ~100 calls per 30 s) and throw on
  // the excess. Applying a Map Experience issues one write per layer it switches,
  // so a fast run through several stories can reach that ceiling — losing the
  // link update is survivable, throwing out of the middle of an apply is not.
  try {
    history.replaceState(null, '', location.pathname + '#' + posStr + stateStr);
  } catch (err) {
    console.warn('[TransmissionMap] URL update skipped:', err);
  }
}

// ─── Bus subscription ─────────────────────────────────────────────────────────
on('url:write', writeUrlState);
// Both scope the panel rather than the map, so they rebaseline: without it the
// changed param reads as the user editing their way out of an active experience.
on('lang:changed',   () => { rebaselineExperience(); emit('url:write'); });
on('region:changed', () => { rebaselineExperience(); emit('url:write'); });
