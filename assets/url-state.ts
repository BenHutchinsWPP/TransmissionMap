// ─── URL hash state persistence ─────────────────────────────────────────────
// Side-effectful functions that link global state to the browser URL.
// Which fields make up a view, and their defaults, live in view-state.ts and
// url-state-codec.ts, as does the hash layout (camera segment + params); this
// module reads and writes location.hash, and owns the language, feeding each
// write to experience-link.ts (which decides whether `exp` stays on the link),
// the one notice a write shows when the view's vx is too large for a link, and
// the one notice a cold boot shows when the link carried settings that were
// dropped — by the codec, or by the map when paintLinkedView() repaints the
// view (view-state.ts's repaintView()).
// currentHash() is the one builder of the hash, shared with view files.

import { recordDiagEvent } from './diag-log.js';
import { state } from './state.js';
import { beginExperience, noteUrlWrite, rebaselineExperience, activeExperienceId, experienceIsDirty } from './experience-link.js';
import { parseUrlState, formatUrlState, VX_LINK_MAX_CHARS, splitHash, formatCameraSegment, type UrlStateData } from './url-state-codec.js';
import { getLocale, setLocale, t, type SupportedLocale } from '../src/i18n/index.js';
import { on, emit } from './state-bus.js';
import { seedView, currentView, repaintView } from './view-state.js';

// Cold boot: seeds `state` from the hash before the map exists. Every view
// field the hash leaves out lands at its default (see view-state.ts).
export function readUrlState() {
  const { dropped, ...data } = parseUrlState(splitHash(location.hash).params);
  seedView(data);
  if (data.lang) setLocale(data.lang as SupportedLocale);
  linkDropped = dropped ?? [];
  // Only the id is restored here. Applying the preset needs the map, so
  // assets/experiences.ts picks it up once the style has finished loading.
  if (data.experienceId) beginExperience(data.experienceId);
}

// Decode drops, held until paintLinkedView() adds the map's and shows one notice.
let linkDropped: string[] = [];

// Cold boot, from map.ts's load handler once layers and filters are on the map.
// An `exp` link is repainted by its story moments later, so it shows no notice.
export function paintLinkedView() {
  const styles = repaintView();
  for (const d of styles) recordDiagEvent('link', `link style ${d.id}.${d.key}: ${d.reason}`);
  const dropped = [...linkDropped, ...styles.map(d => `vx.s.${d.id}.${d.key}: ${d.reason}`)];
  linkDropped = [];
  if (dropped.length && !activeExperienceId()) showDroppedNotice(dropped);
}

const DROPPED_NOTICE_MS = 8000;

// Non-blocking, in the rotate-hint toast's style but top centre, clear of the
// hint; click or wait to dismiss.
export function showDroppedNotice(dropped: string[]) {
  console.warn('[TransmissionMap] link settings skipped:', dropped);
  showTopToast(t('toast.linkDropped', { count: dropped.length }));
}

function showTopToast(text: string) {
  const el = document.createElement('div');
  el.className = 'rotate-hint-toast rotate-hint-toast--top';
  el.setAttribute('role', 'status');
  el.textContent = text;
  el.addEventListener('click', () => el.remove());
  setTimeout(() => el.remove(), DROPPED_NOTICE_MS);
  (document.getElementById('rotateHintToast')?.parentElement ?? document.body).append(el);
}

// What the address bar holds for the live view: `<camera>?<params>`, no `#`.
// Null before the map is ready.
export function currentHash(): string | null {
  const live = liveParts();
  return live && hashOf(live, !!activeExperienceId() && !experienceIsDirty());
}

function liveParts() {
  if (!state.mapReady || !state.map) return null;
  const data: UrlStateData = { ...currentView(), lang: getLocale() };
  return { data, parts: formatUrlState(data) };
}

function hashOf({ data, parts }: NonNullable<ReturnType<typeof liveParts>>, named: boolean): string {
  const stateParts = named ? formatUrlState({ ...data, experienceId: activeExperienceId()! }) : parts;
  const stateStr = stateParts.length ? '?' + stateParts.join('&') : '';
  const { lng, lat } = state.map!.getCenter();
  const posStr = formatCameraSegment({
    center: [lng, lat],
    zoom: state.map!.getZoom(),
    bearing: state.map!.getBearing(),
    pitch: state.map!.getPitch(),
  });
  return posStr + stateStr;
}

// One notice per session when the view's vx is longer than a link reopens with.
let oversizeShown = false;

export function writeUrlState() {
  const live = liveParts();
  if (!live) return;
  if (!oversizeShown && (live.parts.find(p => p.startsWith('vx='))?.length ?? 0) - 3 > VX_LINK_MAX_CHARS) {
    oversizeShown = true;
    showTopToast(t('toast.linkTooLarge'));
  }
  // `exp` is the one param the codec can't decide on its own: whether the link
  // still names the experience depends on runtime dirty tracking. So the rest
  // is formatted first and diffed against the snapshot the preset left behind,
  // and only a still-pristine id is handed back to the codec.
  //
  // Pristine-vs-edited: an experience owns every param here, but not the camera
  // — panning and zooming inside a story keeps the link on the story. The first
  // write after a preset lands records the snapshot; any later write that
  // differs is the user's own edit, and `exp` drops off the link. That
  // bookkeeping lives in experience-link.ts's noteUrlWrite().
  const hash = hashOf(live, noteUrlWrite(live.parts.join('&')));
  // Browsers rate-limit replaceState (Safari: ~100 calls per 30 s) and throw on
  // the excess. Every map move and panel click writes, so a busy session can
  // reach that ceiling — losing the link update is survivable, throwing out of
  // the middle of an apply is not.
  try {
    history.replaceState(null, '', location.pathname + '#' + hash);
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
