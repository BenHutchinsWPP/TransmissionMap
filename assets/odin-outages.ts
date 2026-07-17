// ─── ODIN live county-outage feature-state join + refresh ─────────────────────
// Role: fetch the geometry-less ODIN snapshot (FIPS → [customers_out,
//       incident_count, utilities?]) and join it onto the SHARED
//       `county_boundaries` vector source (owned by layers/layer-init.ts,
//       promoteId=GEOID) via MapLibre feature-state, under the namespaced keys
//       `odin_out`/`odin_n`/`odin_utils` so other county-keyed layers can share
//       the same per-feature state bag. Feature-state only sticks to features in currently-loaded
//       tiles, so we keep the parsed snapshot in module scope and RE-APPLY it on
//       the source's `sourcedata` event, so panning/zooming into new tiles paints.
//       Refreshes every 15 min while the layer is visible; a snapshot older than
//       6 h is not painted (console warning only — no modal, unlike
//       wildfire-staleness.ts).
// Source of truth for age = the snapshot's `generated_utc` (the legend chip too).
// Deps: state (map, DATA, layerVisibility). Legend age chip = #odinAge in index.html.
//       The map source/layers are built by layers/map-layers-conditions.ts
//       (addOdinOutages); the click popup reads numbers from odinSnapshot().
//       Also owns the popup's incident-report ‹ › pager: the per-outage records
//       ride in the SAME snapshot (`records` map, keyed by FIPS), derived
//       server-side from the same fetch as the county aggregates, so the cards
//       and the header/utility totals always reconcile. Rendered as standard
//       cards into the .odin-raw shell that popup-format.ts emits — no live call
//       to ODIN from the browser.
// Wired from ui/ui.ts init() via initOdinOutages().

import { state, DATA } from './state.js';
import { COUNTY_SRC as SRC, COUNTY_SRC_LAYER as SRC_LAYER } from './layers/layer-init.js';
import { escapeHtml } from './utils/utils.js';

const REGISTRY_ID = "odin-outages";

// 15-minute poll — the CI feed refreshes on a similar cadence; picks up a new
// snapshot within a quarter-hour without hammering raw.githubusercontent.com.
const REFRESH_MS = 15 * 60_000;
// Above this pull age the snapshot is treated as unsafe and NOT painted.
const MAX_AGE_MS = 6 * 60 * 60_000;   // 6 hours

// A single utility's rollup within a county:
// [displayName, customers_out, incident_count, earliest_start_iso?].
// The 4th slot is null/absent when no incident in the group reported a start time.
type OdinUtil = [string, number, number, (string | null)?];

// Parsed snapshot kept in module scope so `sourcedata` can re-apply it.
// Third tuple slot (per-utility breakdown) is absent in older snapshots.
let snapshot: Record<string, [number, number, OdinUtil[]?]> = {};
// Per-county incident records for the popup pager, shipped in the SAME snapshot
// so the cards and the choropleth/utility totals come from one instant and can
// never disagree (they're derived from the same upstream fetch, server-side).
// Keyed by FIPS, in metersaffected-desc order. Absent in older snapshots.
let records: Record<string, Record<string, unknown>[]> = {};
// FIPS we currently have feature-state on, so a refresh can clear counties that
// dropped out of the new snapshot (else restored counties stay lit forever).
let appliedFips = new Set<string>();
let generatedUtc: string | undefined;
let inflight = false;

// Popup (popup-format.ts) reads the numbers for a clicked county from here as a
// fallback; the primary path merges feature-state in popup.ts.
export function odinSnapshot(): Record<string, [number, number, OdinUtil[]?]> {
  return snapshot;
}

// Apply the whole in-memory snapshot as feature-state. Idempotent + cheap
// (~few hundred counties), safe to call on every relevant tile load.
function applyJoin() {
  if (!state.map) return;
  if (!state.map.getSource(SRC)) return;
  for (const fips in snapshot) {
    const v = snapshot[fips];
    state.map.setFeatureState(
      { source: SRC, sourceLayer: SRC_LAYER, id: fips },
      { odin_out: v[0], odin_n: v[1], odin_utils: v[2] ?? null },
    );
  }
}

// Drop only OUR keys — the county's feature-state bag is shared with any other
// county-keyed layer, so a bare removeFeatureState(target) would wipe theirs too.
function clearFips(fips: string) {
  if (!state.map) return;
  const target = { source: SRC, sourceLayer: SRC_LAYER, id: fips };
  state.map.removeFeatureState(target, "odin_out");
  state.map.removeFeatureState(target, "odin_n");
  state.map.removeFeatureState(target, "odin_utils");
}

// Unpaint everything we've painted (used when a snapshot goes stale).
function clearJoin() {
  for (const fips of appliedFips) clearFips(fips);
  appliedFips = new Set();
  snapshot = {};
  records = {};
}

async function refetch(): Promise<void> {
  if (!state.map || !state.map.getSource(SRC) || inflight) return;
  inflight = true;
  try {
    const resp = await fetch(DATA.odin_outages, { cache: "no-cache" });
    if (!resp.ok) throw new Error(`${resp.status} ${resp.statusText}`);
    const data = await resp.json();
    const gen = data.generated_utc as string | undefined;

    // Staleness gate: stale data is never painted. If a feed dies while the tab
    // is open we must also UNPAINT what's already there — otherwise the map goes
    // on showing hours-old outages while the legend quietly says "stale".
    const then = gen ? Date.parse(gen) : NaN;
    if (!Number.isNaN(then) && Date.now() - then > MAX_AGE_MS) {
      console.warn("[TransmissionMap] ODIN snapshot is stale (>6h) — not painting", gen);
      clearJoin();
      generatedUtc = gen;
      renderOdinAge();
      return;
    }

    const next = (data.counties || {}) as Record<string, [number, number, OdinUtil[]?]>;
    // Clear feature-state for counties that dropped out of the new snapshot.
    for (const fips of appliedFips) {
      if (!(fips in next)) clearFips(fips);
    }
    snapshot = next;
    records = (data.records || {}) as Record<string, Record<string, unknown>[]>;
    appliedFips = new Set(Object.keys(next));
    generatedUtc = gen;
    applyJoin();
    renderOdinAge();
  } catch (err) {
    console.warn("[TransmissionMap] ODIN refresh failed", err);
    // Re-evaluate staleness of last-known data; if older than MAX_AGE_MS, unpaint.
    const then = generatedUtc ? Date.parse(generatedUtc) : NaN;
    if (!Number.isNaN(then) && Date.now() - then > MAX_AGE_MS) {
      clearJoin();
    }
    renderOdinAge();
  } finally {
    inflight = false;
  }
}

// ── Legend age chip ("updated 12 min ago") ────────────────────────────────────
function renderOdinAge() {
  const el = document.getElementById("odinAge");
  if (!el) return;
  if (!generatedUtc) { el.textContent = ""; return; }
  const then = Date.parse(generatedUtc);
  if (Number.isNaN(then)) { el.textContent = ""; return; }
  const min = Math.max(0, Math.round((Date.now() - then) / 60_000));
  el.textContent =
    min < 1    ? "updated just now"
    : min < 60   ? `updated ${min} min ago`
    : min < 1440 ? `updated ${Math.round(min / 60)}h ago`
    :              `updated ${Math.round(min / 1440)}d ago`;
  const stale = Date.now() - then > MAX_AGE_MS;
  el.className = "legend-age legend-age--" + (stale ? "stale" : min <= 60 ? "fresh" : "aging");
}

// ── Per-outage incident reports (popup ‹ › pager) ─────────────────────────────
// The per-outage records (cause, metersaffected, ERT…) ride along in the SAME
// snapshot as the county rollups (see `records`), fetched once server-side by
// scripts/fetch_odin_outages.py. So expanding "View incident reports" in a
// county popup reads already-loaded, same-instant data — no per-browser call to
// ODIN, and the card totals always reconcile with the header/utility totals
// (both derived from these records). The pager shell (.odin-raw / .odin-raw-btn
// / .odin-raw-body) is emitted by popup-format.ts; clicks land here via
// document-level delegation.
//
// The shipped fields (from CARD_FIELDS in the fetch script): name, cause,
// causekind, metersaffected, customersrestored, reportedstarttime,
// estimatedrestorationtime, statuskind.

// "cause" is free text from each utility's outage system; these placeholder
// values carry no information and are hidden (the row is omitted instead).
const JUNK_CAUSE = /^(null|not available)$/i;

// "Jul 10, 2:51 PM (4h ago)" — compact local time + relative age for card
// rows. Future times (ERTs) read "(in 7h)"; a blown ERT just reads "(2h ago)".
function fmtCardTime(iso: unknown): string | null {
  if (typeof iso !== "string") return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const abs = d.toLocaleString(undefined,
    { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  const min = Math.round((Date.now() - d.getTime()) / 60_000);
  const n = Math.abs(min);
  const span = n < 60 ? `${n}m` : n < 1440 ? `${Math.round(n / 60)}h` : `${Math.round(n / 1440)}d`;
  return `${abs} (${min < 0 ? `in ${span}` : `${span} ago`})`;
}

// estimatedrestorationtime is always the embedded-JSON string {"ert": "<ISO>"}.
function parseErt(v: unknown): string | null {
  if (typeof v !== "string") return null;
  try { return fmtCardTime(JSON.parse(v).ert); } catch { return null; }
}

function renderRaw(wrap: HTMLElement) {
  const body = wrap.querySelector<HTMLElement>(".odin-raw-body");
  const recs = records[wrap.dataset.fips || ""] || [];
  if (!body) return;
  if (!recs.length) {
    body.innerHTML = `<div class="popup-row">No incident records returned.</div>`;
    return;
  }
  const i = Math.min(Number(wrap.dataset.idx) || 0, recs.length - 1);
  const rec = recs[i];

  // Standard card: utility + customers-out header, then rows omitted when the
  // utility didn't report that field (fill rates are 12–64% — sparse is normal).
  const rowIf = (key: string, val: unknown) =>
    val == null || val === "" ? "" :
    `<div class="popup-row"><span class="popup-key">${key}</span> ` +
    `<span class="popup-val">${escapeHtml(val)}</span></div>`;
  const numOrNull = (v: unknown) => typeof v === "number" ? v.toLocaleString() : null;
  const cause = [rec.cause, rec.causekind].find(
    (v): v is string => typeof v === "string" && !!v.trim() && !JUNK_CAUSE.test(v.trim()));
  const util = String(rec.name || "Unknown utility").replace(/,\d+$/, "");
  const rows =
    `<div class="odin-raw-head"><span class="odin-raw-util">${escapeHtml(util)}</span>` +
    `<span class="odin-raw-out">${numOrNull(rec.metersaffected) ?? "?"} out</span></div>` +
    rowIf("Cause", cause) +
    rowIf("Status", rec.statuskind) +
    rowIf("Started", fmtCardTime(rec.reportedstarttime)) +
    rowIf("Est. rest.", parseErt(rec.estimatedrestorationtime)) +
    rowIf("Restored", numOrNull(rec.customersrestored));
  const disabled = recs.length < 2 ? " disabled" : "";
  // Nav sits BELOW the card, and the card area has a CSS min-height, so the
  // ‹ › buttons stay put while paging across cards with more/fewer rows.
  body.innerHTML =
    `<div class="odin-raw-card">${rows}</div>` +
    `<div class="odin-raw-nav">` +
    `<button type="button" class="odin-raw-prev"${disabled} aria-label="Previous report">‹</button>` +
    `<span>Report ${i + 1} / ${recs.length}</span>` +
    `<button type="button" class="odin-raw-next"${disabled} aria-label="Next report">›</button>` +
    `</div>`;
}

// No network: the records already rode in with the snapshot. Just reveal them.
function loadRaw(wrap: HTMLElement, btn: HTMLElement) {
  btn.style.display = "none";
  wrap.dataset.idx = "0";
  renderRaw(wrap);
}

function isVisible(): boolean {
  return !!state.layerVisibility[REGISTRY_ID];
}

export function initOdinOutages() {
  if (!state.map) return;

  // Re-apply the join whenever the source finishes (re)loading tiles — feature
  // state only sticks to features present in currently-loaded tiles. This also
  // covers the first paint: when the layer is enabled (user toggle or URL
  // restore) the source starts loading its tiles → this fires → if we have no
  // snapshot yet and the layer is visible, kick off the first fetch.
  state.map.on("sourcedata", (e) => {
    const ev = e as { sourceId?: string; isSourceLoaded?: boolean };
    if (ev.sourceId !== SRC || !ev.isSourceLoaded) return;
    if (Object.keys(snapshot).length) { applyJoin(); return; }
    if (isVisible() && !inflight) void refetch();
  });

  // Enabling the layer's panel checkbox fetches immediately (in parallel with
  // tile loading) rather than waiting on the first `sourcedata`.
  document.addEventListener("change", (e) => {
    const cb = (e.target as Element | null)?.closest<HTMLInputElement>(
      `input[type=checkbox][data-layer-id="${REGISTRY_ID}"]`);
    if (cb?.checked) void refetch();
  });

  // Raw-report pager inside the county popup (shell emitted by popup-format.ts).
  document.addEventListener("click", (e) => {
    const el = (e.target as Element | null)?.closest<HTMLElement>(
      ".odin-raw-btn, .odin-raw-prev, .odin-raw-next");
    const wrap = el?.closest<HTMLElement>(".odin-raw");
    if (!el || !wrap) return;
    if (el.classList.contains("odin-raw-btn")) { loadRaw(wrap, el); return; }
    const recs = records[wrap.dataset.fips || ""] || [];
    if (recs.length < 2) return;
    const n = recs.length;
    const cur = Number(wrap.dataset.idx) || 0;
    wrap.dataset.idx = String(
      el.classList.contains("odin-raw-next") ? (cur + 1) % n : (cur - 1 + n) % n);
    renderRaw(wrap);
  });

  // URL-restored default-on (or already-visible) at load time.
  if (isVisible()) void refetch();

  // Poll only while something is on screen — no point refetching for a hidden layer.
  setInterval(() => { if (isVisible()) void refetch(); }, REFRESH_MS);
  // Keep the displayed age accurate while the page sits open.
  setInterval(renderOdinAge, 60_000);
}
