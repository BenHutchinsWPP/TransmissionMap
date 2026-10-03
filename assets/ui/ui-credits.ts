// ─── Data Credits dialog — manifest-driven rendering ──────────────────────────
// Role: fetches the per-layer provenance manifest (DATA.data_manifest, built by
//       scripts/build_data_manifest.py) and, once it validates, adds the
//       measured per-layer detail to the Data Credits dialog's hand-written
//       entries from index.html. Layers are grouped by their manifest
//       `source_id` (a LAYER_SOURCES key; several tile-manifest layers share
//       one), and each group's detail list is appended to the <li> holding
//       the matching data-source-credit anchor — the anchor itself may sit on
//       a nested <span> of an umbrella entry. A group with no hand-written
//       anchor gets a new <li data-source-credit="<id>"> at the end of the
//       list, so assets/ui/ui-layer-rows.ts's per-layer "source" button
//       (openSourceCredit() in ui.ts) can land on it. Every hand-written entry,
//       note and disclaimer stays in the dialog as shipped. An entry whose
//       source_id is UNKNOWN, missing, or not a real LAYER_SOURCES key is left
//       out. A failed fetch, a non-JSON response, or a malformed payload leave
//       the markup untouched. Each member layer's line carries its label
//       (linked only for an http(s) url), licence, row count (with the built
//       artifact's size alongside when known), retrieval date, and a short
//       per-field join-quality summary ("14,806 with state, 13,427 with
//       county") — the top few fields by count, skipping any field with full
//       coverage. Lazy chunk: loaded when the info button first opens the
//       dialog (see ui.ts), matching the ui-diagnostics.ts / ui-settings.ts
//       pattern.
// Deps: constants.js (DATA.data_manifest), ../../src/registry/index.js
//       (LAYER_SOURCES — the anchor id space and group display labels),
//       utils/utils.js (escapeHtml, isHttpUrl — every manifest-derived string
//       is untrusted input and is escaped before it reaches the DOM; this
//       module treats the fetched JSON as hostile).

import { DATA } from '../constants.js';
import { LAYER_SOURCES } from '../../src/registry/index.js';
import { escapeHtml, isHttpUrl } from '../utils/utils.js';

interface ManifestLayerEntry {
  label: string;
  source: string;
  url: string;
  licence: string;
  source_id?: string;
  source_rows: number | null;
  coverage: Record<string, number> | null;
  retrieved: string | null;
  bytes: number | null;
}

interface DataManifest {
  generated_utc: string;
  note: string;
  layers: Record<string, ManifestLayerEntry>;
}

const UNKNOWN = 'UNKNOWN';

function isStringField(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

function isNullableNumber(v: unknown): v is number | null {
  return v === null || typeof v === 'number';
}

function isNullableString(v: unknown): v is string | null {
  return v === null || typeof v === 'string';
}

function isNullableCoverage(v: unknown): v is Record<string, number> | null {
  if (v === null) return true;
  if (typeof v !== 'object' || Array.isArray(v)) return false;
  return Object.values(v as Record<string, unknown>).every(n => typeof n === 'number');
}

function isManifestEntry(v: unknown): v is ManifestLayerEntry {
  if (!v || typeof v !== 'object') return false;
  const e = v as Record<string, unknown>;
  return isStringField(e.label) && isStringField(e.source) &&
    isStringField(e.url) && isStringField(e.licence) &&
    (e.source_id === undefined || typeof e.source_id === 'string') &&
    isNullableNumber(e.source_rows) &&
    isNullableCoverage(e.coverage) &&
    isNullableString(e.retrieved) &&
    isNullableNumber(e.bytes);
}

function isDataManifest(v: unknown): v is DataManifest {
  if (!v || typeof v !== 'object') return false;
  const m = v as Record<string, unknown>;
  if (!isStringField(m.generated_utc) || !isStringField(m.note)) return false;
  if (!m.layers || typeof m.layers !== 'object' || Array.isArray(m.layers)) return false;
  const layers = m.layers as Record<string, unknown>;
  const ids = Object.keys(layers);
  return ids.length > 0 && ids.every(id => isManifestEntry(layers[id]));
}

const BYTE_UNITS = ['bytes', 'KB', 'MB', 'GB'];

// Human-readable size ("2.3 MB") for the built artifact's byte count.
function formatBytes(n: number): string {
  let v = n;
  let i = 0;
  while (v >= 1024 && i < BYTE_UNITS.length - 1) {
    v /= 1024;
    i++;
  }
  return `${i === 0 ? v.toLocaleString() : v.toFixed(1)} ${BYTE_UNITS[i]}`;
}

// Cap on how many coverage fields one layer's line names before falling
// back to a "+N more" tail — a wide `select:` can carry dozens of fields,
// and a credits page line isn't the place to dump all of them.
const MAX_COVERAGE_FIELDS = 5;

// Short join-quality summary ("14,806 with state, 13,427 with county") for
// one layer's coverage map. Empty when coverage is null/empty (nothing was
// measured) or every measured field has full coverage (not news). Fields
// with full coverage (count === source_rows) are dropped, the rest sorted
// by count descending and capped — the field *names* come straight off the
// fetched JSON, so each one is escaped before it reaches the returned
// string same as every other manifest-derived bit.
function renderCoverage(entry: ManifestLayerEntry): string {
  if (!entry.coverage) return '';
  const partial = Object.entries(entry.coverage)
    .filter(([, count]) => count !== entry.source_rows)
    .sort(([, a], [, b]) => b - a);
  if (partial.length === 0) return '';

  const shown = partial
    .slice(0, MAX_COVERAGE_FIELDS)
    .map(([field, count]) => `${count.toLocaleString()} with ${escapeHtml(field)}`)
    .join(', ');
  const remaining = partial.length - MAX_COVERAGE_FIELDS;
  return remaining > 0 ? `${shown} +${remaining} more` : shown;
}

// One member layer's line inside its source group's <li> — label (linked when
// the url is http(s)), licence, row count (with built-artifact size alongside,
// when known), retrieval date, per-field coverage summary. Omits any bit
// whose field is UNKNOWN or null rather than printing the sentinel to a user.
function renderLayerDetail(id: string, entry: ManifestLayerEntry): string {
  const label = entry.label !== UNKNOWN ? entry.label : id;
  const labelHtml = isHttpUrl(entry.url)
    ? `<a href="${escapeHtml(entry.url)}" target="_blank" rel="noopener">${escapeHtml(label)}</a>`
    : escapeHtml(label);

  const bits = [labelHtml];
  if (entry.licence !== UNKNOWN) bits.push(escapeHtml(entry.licence));
  if (entry.source_rows !== null) {
    const size = entry.bytes !== null ? ` (${formatBytes(entry.bytes)})` : '';
    bits.push(`${entry.source_rows.toLocaleString()} rows${size}`);
  } else if (entry.bytes !== null) {
    bits.push(formatBytes(entry.bytes));
  }
  if (entry.retrieved !== null) bits.push(`retrieved ${escapeHtml(entry.retrieved)}`);
  const coverage = renderCoverage(entry);
  if (coverage) bits.push(coverage);

  return `<li>${bits.join(' — ')}</li>`;
}

function layerSortKey(id: string, entry: ManifestLayerEntry): string {
  return entry.label !== UNKNOWN ? entry.label : id;
}

// One source group's nested list of member-layer lines, sorted by label.
function renderGroupLayers(layers: { id: string; entry: ManifestLayerEntry }[]): string {
  const items = layers
    .slice()
    .sort((a, b) => layerSortKey(a.id, a.entry).localeCompare(layerSortKey(b.id, b.entry)))
    .map(({ id, entry }) => renderLayerDetail(id, entry))
    .join('');
  return `<ul class="credits-group-layers">${items}</ul>`;
}

// Fetches and validates the manifest, then adds each source group's layer
// detail to the dialog's <ul>. ui.ts calls it once per page load, the first
// time the Data Credits dialog opens; on any failure it returns without
// touching the DOM.
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

  if (!isDataManifest(payload)) return;

  // Group by source_id, the LAYER_SOURCES key the layer's credit belongs
  // under. An entry whose source_id is UNKNOWN, absent, or not a real
  // LAYER_SOURCES key is left out — rendering it would emit a
  // data-source-credit anchor nothing looks up.
  const groups = new Map<string, { id: string; entry: ManifestLayerEntry }[]>();
  for (const [id, entry] of Object.entries(payload.layers)) {
    const sourceId = entry.source_id;
    // hasOwn, not a bracket truthiness test: a source_id of "__proto__" or
    // "constructor" finds an inherited member of Object.prototype and would
    // otherwise pass for a known anchor.
    if (!sourceId || sourceId === UNKNOWN || !Object.hasOwn(LAYER_SOURCES, sourceId)) continue;
    const bucket = groups.get(sourceId);
    if (bucket) bucket.push({ id, entry });
    else groups.set(sourceId, [{ id, entry }]);
  }

  const anchors = Array.from(list.querySelectorAll<HTMLElement>('[data-source-credit]'));
  for (const [sourceId, layers] of groups) {
    const details = renderGroupLayers(layers);
    const host = anchors.find(el => el.dataset.sourceCredit === sourceId)?.closest('li');
    if (host) host.insertAdjacentHTML('beforeend', details);
    else list.insertAdjacentHTML('beforeend',
      `<li data-source-credit="${escapeHtml(sourceId)}"><strong>${escapeHtml(LAYER_SOURCES[sourceId].label)}</strong>${details}</li>`);
  }
}
