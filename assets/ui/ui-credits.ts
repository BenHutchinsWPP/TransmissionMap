// ─── Data Credits dialog — manifest-driven dates ─────────────────────────────
// Role: fetches the per-layer provenance manifest (DATA.data_manifest, built by
//       scripts/build_data_manifest.py) and adds one "data as of" date per
//       source to the Data Credits dialog's hand-written entries from
//       index.html. Layers are grouped by their manifest `source_id` (a
//       LAYER_SOURCES key; several tile-manifest layers share one, e.g. every
//       OSM layer). Each hand-written <li> gets one date, the oldest
//       `data_as_of` among the sources it credits (an umbrella entry credits
//       several through nested <span> anchors), at its end — or before its
//       display note. A group with
//       no hand-written anchor gets a new <li data-source-credit="<id>"> at the
//       end of the list, so assets/ui/ui-layer-rows.ts's per-layer "source"
//       button (openSourceCredit() in ui.ts) can land on it. Every
//       hand-written entry, note and disclaimer stays in the dialog as
//       shipped. An entry whose source_id is UNKNOWN, missing, or not a real
//       LAYER_SOURCES key is left out, as is a date that is not YYYY-MM-DD. A
//       failed fetch, a non-JSON response, or a malformed payload leave the
//       markup untouched. Lazy chunk: loaded when the info button first opens
//       the dialog (see ui.ts), matching the ui-diagnostics.ts /
//       ui-settings.ts pattern.
// Deps: constants.js (DATA.data_manifest), ../../src/registry/index.js
//       (LAYER_SOURCES — the anchor id space and group display labels),
//       utils/utils.js (escapeHtml — every manifest-derived string is
//       untrusted input and is escaped before it reaches the DOM; this module
//       treats the fetched JSON as hostile).

import { DATA } from '../constants.js';
import { LAYER_SOURCES } from '../../src/registry/index.js';
import { escapeHtml } from '../utils/utils.js';

const UNKNOWN = 'UNKNOWN';
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// The manifest's layers map, or null when the payload has the wrong shape.
// Only the two fields this module reads are checked, per entry: one odd entry
// is skipped, not the whole manifest.
function manifestLayers(v: unknown): Record<string, unknown> | null {
  if (!v || typeof v !== 'object') return null;
  const layers = (v as Record<string, unknown>).layers;
  if (!layers || typeof layers !== 'object' || Array.isArray(layers)) return null;
  return layers as Record<string, unknown>;
}

// Fetches the manifest, then writes each source group's date into the dialog.
// ui.ts calls it once per page load, the first time the Data Credits dialog
// opens; on any failure it returns without touching the DOM.
export async function renderDataCredits(): Promise<void> {
  const dialog = document.getElementById('creditsDialog') as HTMLDialogElement | null;
  const list = dialog?.querySelector('ul');
  if (!list) return;

  let payload: unknown;
  try {
    const resp = await fetch(DATA.data_manifest, { cache: 'no-cache' });
    if (!resp.ok) return;
    payload = await resp.json();
  } catch {
    return; // offline, blocked, or non-JSON — keep the shipped list
  }

  const layers = manifestLayers(payload);
  if (!layers) return;

  // source_id -> oldest data_as_of among its layers ('' when none is dated).
  // An entry whose source_id is UNKNOWN, absent, or not a real LAYER_SOURCES
  // key is left out — rendering it would emit a data-source-credit anchor
  // nothing looks up.
  const dates = new Map<string, string>();
  for (const entry of Object.values(layers)) {
    if (!entry || typeof entry !== 'object') continue;
    const { source_id: sourceId, data_as_of: asOf } = entry as Record<string, unknown>;
    // hasOwn, not a bracket truthiness test: a source_id of "__proto__" or
    // "constructor" finds an inherited member of Object.prototype and would
    // otherwise pass for a known anchor.
    if (typeof sourceId !== 'string' || sourceId === UNKNOWN || !Object.hasOwn(LAYER_SOURCES, sourceId)) continue;
    const date = typeof asOf === 'string' && ISO_DATE.test(asOf) ? asOf : '';
    const seen = dates.get(sourceId);
    if (seen === undefined || (date && (!seen || date < seen))) dates.set(sourceId, date);
  }

  // One date per hand-written entry: the oldest date among the sources it
  // credits (an umbrella entry credits several through nested <span>s).
  const anchors = Array.from(list.querySelectorAll<HTMLElement>('[data-source-credit]'));
  const entryDates = new Map<HTMLLIElement, string>();
  for (const [sourceId, date] of dates) {
    const host = anchors.find(el => el.dataset.sourceCredit === sourceId)?.closest('li');
    if (!host) {
      const asOf = date ? ` — data as of ${escapeHtml(date)}` : '';
      list.insertAdjacentHTML('beforeend',
        `<li data-source-credit="${escapeHtml(sourceId)}"><strong>${escapeHtml(LAYER_SOURCES[sourceId].label)}</strong>${asOf}</li>`);
      continue;
    }
    const seen = entryDates.get(host);
    if (date && (!seen || date < seen)) entryDates.set(host, date);
  }
  for (const [host, date] of entryDates) {
    const note = host.querySelector(':scope > strong');
    if (note) note.insertAdjacentHTML('beforebegin', `Data as of ${escapeHtml(date)}. `);
    else host.insertAdjacentHTML('beforeend', ` — data as of ${escapeHtml(date)}`);
  }
}
