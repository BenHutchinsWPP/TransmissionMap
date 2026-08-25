// ─── Settings dialog (display units & language) ──────────────────────────────
// Role: renders and drives the Settings dialog — language selector plus one
//       <select> per UNIT_OPTIONS dimension plus US/Metric presets. Every
//       change writes through setUnits/setLocale -> saveUnits/saveLanguage ->
//       emit('units:changed' / 'lang:changed') so formatters and UI across
//       the app pick up the new preferences and live subscribers can re-render.
//       Lazy chunk: loaded only on File > Settings… (see ui-menubar.ts), so it
//       stays out of the initial bundle, matching the ui-diagnostics.ts and
//       draw-chunk.ts pattern. It owns only #settingsBody; the dialog chrome
//       (#settingsDialog, #closeSettings, backdrop click) lives in
//       index.html / ui.ts.
// Deps: src/units.js (UnitPrefs, UNIT_OPTIONS, DEFAULT_UNITS, getUnits, setUnits),
//       units-store.js (saveUnits), state-bus.js (emit), utils/utils.js
//       (escapeHtml — any user-visible string injected as HTML gets escaped),
//       src/i18n/index.js (getLocale, setLocale, loadDictionary, SUPPORTED_LOCALES,
//       updateDomTranslations, t, SupportedLocale),
//       i18n-store.js (saveLanguage).

import { UNIT_OPTIONS, DEFAULT_UNITS, getUnits, setUnits, type UnitPrefs } from '../../src/units.js';
import { saveUnits } from '../units-store.js';
import { emit } from '../state-bus.js';
import { escapeHtml } from '../utils/utils.js';
import {
  getLocale,
  setLocale,
  loadDictionary,
  SUPPORTED_LOCALES,
  updateDomTranslations,
  t,
  type SupportedLocale,
} from '../../src/i18n/index.js';
import { saveLanguage } from '../i18n-store.js';

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

  const languageRow = `
    <div class="settings-row">
      <span class="settings-row-label" data-i18n="settings.language">${escapeHtml(t('settings.language'))}</span>
      <select class="settings-select" id="settingsLanguageSelect">
        ${SUPPORTED_LOCALES.map(loc => `<option value="${loc.code}">${escapeHtml(loc.nativeName)} (${escapeHtml(loc.name)})</option>`).join('')}
      </select>
    </div>
  `;

  const rows = dims.map(dim => {
    const { labelKey, label: defaultLabel, options } = UNIT_OPTIONS[dim];
    const label = labelKey ? t(labelKey) : defaultLabel;
    const opts = options.map(o => {
      const optLabel = o.optLabelKey ? t(o.optLabelKey) : o.label;
      return `<option value="${escapeHtml(o.value)}">${escapeHtml(optLabel)}</option>`;
    }).join('');
    return `
      <div class="settings-row">
        <span class="settings-row-label">${escapeHtml(label)}</span>
        <select class="settings-select" data-unit-dim="${escapeHtml(dim)}">${opts}</select>
      </div>`;
  }).join('');

  body.innerHTML = `
    <div class="settings-rows">
      ${languageRow}
    </div>
    <div class="settings-presets">
      <button id="settingsPresetUs" type="button">${escapeHtml(t('settings.us'))}</button>
      <button id="settingsPresetMetric" type="button">${escapeHtml(t('settings.metric'))}</button>
    </div>
    <div class="settings-rows">${rows}</div>
  `;
  syncControls(body as HTMLElement);
}

// Reflects current prefs onto the existing controls in place. Replacing the
// body's innerHTML here would destroy the <select> that is mid-`change`,
// dropping keyboard focus part-way through an arrow-key selection.
function syncControls(body: HTMLElement): void {
  const langSelect = body.querySelector<HTMLSelectElement>('#settingsLanguageSelect');
  if (langSelect) {
    langSelect.value = getLocale();
  }

  const units = getUnits();
  const dims = Object.keys(UNIT_OPTIONS) as (keyof UnitPrefs)[];

  body.querySelectorAll<HTMLSelectElement>('.settings-select[data-unit-dim]').forEach(sel => {
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

  body.onchange = async (e: Event) => {
    const select = e.target as HTMLSelectElement;
    if (select.id === 'settingsLanguageSelect') {
      const newLocale = select.value as SupportedLocale;
      await loadDictionary(newLocale);
      setLocale(newLocale);
      saveLanguage(newLocale);
      updateDomTranslations();
      emit('lang:changed', { locale: newLocale });
      render(dialog);
      return;
    }
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
