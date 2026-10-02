// ─── URL hash state persistence ─────────────────────────────────────────────
// Side-effectful functions that link global state to the browser URL.
// Which fields make up a view, and their defaults, live in view-state.ts and
// url-state-codec.ts, as does the hash layout (camera segment + params); this
// module reads and writes location.hash, and owns the language and the Map
// Experience pristine/edited tracking.

import { state, rebaselineExperience } from './state.js';
import { parseUrlState, formatUrlState, splitHash, formatCameraSegment, type UrlStateData } from './url-state-codec.js';
import { getLocale, setLocale, type SupportedLocale } from '../src/i18n/index.js';
import { on, emit } from './state-bus.js';
import { seedView, currentView } from './view-state.js';

// Cold boot: seeds `state` from the hash before the map exists. Every view
// field the hash leaves out lands at its default (see view-state.ts).
export function readUrlState() {
  const data = parseUrlState(splitHash(location.hash).params);
  seedView(data);
  if (data.lang) setLocale(data.lang as SupportedLocale);
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

  const data: UrlStateData = { ...currentView(), lang: getLocale() };

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
  const { lng, lat } = state.map.getCenter();
  const posStr = formatCameraSegment({
    center: [lng, lat],
    zoom: state.map.getZoom(),
    bearing: state.map.getBearing(),
    pitch: state.map.getPitch(),
  });
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
