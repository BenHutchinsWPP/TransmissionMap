// ─── Settings dialog (display units) ───────────────────────────────────────
// Role: renders and drives the Settings dialog — one <select> per UNIT_OPTIONS
//       dimension plus US/Metric presets. Every change writes through
//       setUnits -> saveUnits -> emit('units:changed') so formatters across
//       the app (src/units.ts fmt* helpers) pick up the new preference and
//       anything listening for the event (e.g. live popups) can re-render.
//       Lazy chunk: loaded only on File > Settings… (see ui-menubar.ts), so it
//       stays out of the initial bundle, matching the ui-diagnostics.ts and
//       draw-chunk.ts pattern. It owns only #settingsBody; the dialog chrome
//       (#settingsDialog, #closeSettings, backdrop click) lives in
//       index.html / ui.ts.
// Deps: src/units.js (UnitPrefs, UNIT_OPTIONS, getUnits, setUnits),
//       units-store.js (saveUnits), state-bus.js (emit), utils/utils.js
//       (escapeHtml — labels are internal constants today, but any
//       user-visible string injected as HTML gets escaped on principle,
//       matching the ui-diagnostics.ts precedent).

import { UNIT_OPTIONS, DEFAULT_UNITS, getUnits, setUnits, type UnitPrefs } from '../../src/units.js';
import { saveUnits } from '../units-store.js';
import { emit } from '../state-bus.js';
import { escapeHtml } from '../utils/utils.js';

const METRIC_PRESET: UnitPrefs = { temp: 'C', speed: 'kph', distance: 'km', area: 'km2', elevation: 'm', pressure: 'mb' };

export function openSettings(): void {
  const dialog = document.getElementById('settingsDialog') as HTMLDialogElement | null;
  if (!dialog) return;

  render(dialog);
  wireHandlers(dialog);
  dialog.showModal();
}

function render(dialog: HTMLDialogElement): void {
  const body = dialog.querySelector('#settingsBody');
  if (!body) return;

  // No `selected` on the options — syncControls() below sets every value.
  const dims = Object.keys(UNIT_OPTIONS) as (keyof UnitPrefs)[];

  const rows = dims.map(dim => {
    const { label, options } = UNIT_OPTIONS[dim];
    const opts = options.map(o =>
      `<option value="${escapeHtml(o.value)}">${escapeHtml(o.label)}</option>`
    ).join('');
    return `
      <div class="settings-row">
        <span class="settings-row-label">${escapeHtml(label)}</span>
        <select class="settings-select" data-unit-dim="${escapeHtml(dim)}">${opts}</select>
      </div>`;
  }).join('');

  body.innerHTML = `
    <div class="settings-presets">
      <button id="settingsPresetUs" type="button">US</button>
      <button id="settingsPresetMetric" type="button">Metric</button>
    </div>
    <div class="settings-rows">${rows}</div>
  `;
  syncControls(body as HTMLElement);
}

// Reflects current prefs onto the existing controls in place. Replacing the
// body's innerHTML here would destroy the <select> that is mid-`change`,
// dropping keyboard focus part-way through an arrow-key selection.
function syncControls(body: HTMLElement): void {
  const units = getUnits();
  const dims = Object.keys(UNIT_OPTIONS) as (keyof UnitPrefs)[];

  body.querySelectorAll<HTMLSelectElement>('.settings-select').forEach(sel => {
    const dim = sel.dataset.unitDim as keyof UnitPrefs | undefined;
    if (dim) sel.value = units[dim];
  });

  const preset = (id: string, matched: boolean) => {
    const btn = body.querySelector<HTMLButtonElement>(`#${id}`);
    if (btn) btn.className = matched ? 'disclaimer-accept' : 'disclaimer-dismiss';
  };
  preset('settingsPresetUs', dims.every(d => units[d] === DEFAULT_UNITS[d]));
  preset('settingsPresetMetric', dims.every(d => units[d] === METRIC_PRESET[d]));
}

// Assigned rather than addEventListener'd so re-opening the dialog cannot
// stack duplicate handlers, matching ui-diagnostics.ts's wireCopyButton.
function wireHandlers(dialog: HTMLDialogElement): void {
  const body = dialog.querySelector<HTMLElement>('#settingsBody');
  if (!body) return;

  body.onchange = (e: Event) => {
    const select = e.target as HTMLSelectElement;
    const dim = select.dataset.unitDim as keyof UnitPrefs | undefined;
    if (!dim) return;
    applyChange({ [dim]: select.value } as Partial<UnitPrefs>, body);
  };

  body.onclick = (e: MouseEvent) => {
    const target = e.target as HTMLElement;
    if (target.id === 'settingsPresetUs') applyChange(DEFAULT_UNITS, body);
    else if (target.id === 'settingsPresetMetric') applyChange(METRIC_PRESET, body);
  };
}

function applyChange(partial: Partial<UnitPrefs>, body: HTMLElement): void {
  setUnits(partial);
  saveUnits();
  emit('units:changed');
  syncControls(body);
}
