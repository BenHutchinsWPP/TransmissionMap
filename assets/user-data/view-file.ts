// ─── View files (*.tmview.json) ──────────────────────────────────────────────
// A view file wraps the address-bar hash of a view: save builds one from
// url-state.ts's currentHash(); open runs the hash through the same codec a
// link takes (splitHash, parseUrlState, parseCameraSegment) and applies it
// with applyView(). A file's hash may run to 16 KB, so its `vx` cap is that
// size rather than a link's. Deps: url-state-codec, url-state, view-state, experiences
// (registry + story controller; a hash's `exp` restores the story via the
// ui-experiences chunk), i18n, user-data-export (download helper).

import { state } from '../state.js';
import { splitHash, parseUrlState, parseCameraSegment } from '../url-state-codec.js';
import { currentHash, showDroppedNotice } from '../url-state.js';
import { applyView } from '../view-state.js';
import { endExperience } from '../experiences.js';
import type { DroppedStyle } from '../style-overrides.js';
import { experienceById } from '../../src/registry/experiences.js';
import { t } from '../../src/i18n/index.js';
import { downloadFile } from './user-data-export.js';

const MAX_HASH_CHARS = 16 * 1024;
const SUFFIX = '.tmview.json';

interface ViewFile { format: 'tmview'; v: 1; title: string; note: string; hash: string }

export function buildViewFile(title: string, hash: string, note = ''): string {
  const f: ViewFile = { format: 'tmview', v: 1, title, note, hash };
  return JSON.stringify(f, null, 2);
}

export function saveView() {
  const hash = currentHash();
  if (hash === null) return;
  const title = (state.experienceId && experienceById(state.experienceId)?.title) || 'Map view';
  downloadFile(buildViewFile(title, hash), 'map-view' + SUFFIX, 'application/json');
}

/** Returns the hash, an error message, or null when `j` (the parsed file) is not a view file. */
export function readViewFile(j: unknown, filename: string): { hash: string } | { error: string } | null {
  const o = (j && typeof j === 'object' ? j : {}) as Record<string, unknown>;
  const named = filename.toLowerCase().endsWith(SUFFIX);
  if (o.format !== 'tmview' && !named) return null;
  if (o.format !== 'tmview') return { error: t('viewFile.invalid') };
  if (o.v !== 1) return { error: t('viewFile.version') };
  if (typeof o.hash !== 'string' || o.hash.length > MAX_HASH_CHARS) return { error: t('viewFile.invalid') };
  return { hash: o.hash };
}

/** True when the file was a view file (applied or rejected); false to fall through.
 *  `lang` in the hash is ignored: language stays the viewer's choice. */
export function openViewFile(j: unknown, filename: string): boolean {
  const r = readViewFile(j, filename);
  if (!r) return false;
  if ('error' in r) { alert(r.error); return true; }
  if (!state.mapReady) { alert(t('viewFile.notReady')); return true; }
  const { camera, params } = splitHash(r.hash);
  const { dropped, ...data } = parseUrlState(params, { vxMaxChars: MAX_HASH_CHARS });
  const cam = parseCameraSegment(camera) ?? undefined;
  const notice = (applied: DroppedStyle[]) => {
    const all = [...(dropped ?? []), ...applied.map(d => `vx.s.${d.id}.${d.key}: ${d.reason}`)];
    if (all.length) showDroppedNotice(all);
  };
  if (data.experienceId && experienceById(data.experienceId)) {
    state.experienceId = data.experienceId;
    import('../ui/ui-experiences.js').then(m => {
      m.restoreFromUrl();
      if (cam) state.map?.jumpTo({ center: cam.center, zoom: cam.zoom, bearing: cam.bearing, pitch: cam.pitch });
      notice([]);
    }).catch(err => {
      state.experienceId = null;
      alert(`Could not open view: ${(err as Error).message}`);
    });
    return true;
  }
  endExperience();
  notice(applyView(data, cam));
  return true;
}
