// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { openSettings } from './ui-settings.js';
import { getLocale, setLocale, loadDictionary, applyDocumentDirection } from '../../src/i18n/index.js';
import { getUnits, setUnits, DEFAULT_UNITS } from '../../src/units.js';
import { on } from '../state-bus.js';

describe('ui-settings', () => {
  let dialog: HTMLDialogElement;

  beforeEach(() => {
    localStorage.clear();
    setLocale('en');
    applyDocumentDirection('en');
    setUnits(DEFAULT_UNITS);

    document.body.innerHTML = `
      <dialog id="settingsDialog">
        <div class="credits-header">
          <h2 data-i18n="settings.title">Settings</h2>
          <button id="closeSettings" type="button" aria-label="Close">×</button>
        </div>
        <div id="settingsBody"></div>
      </dialog>
    `;
    dialog = document.getElementById('settingsDialog') as HTMLDialogElement;
    dialog.showModal = vi.fn();
  });

  it('renders language selector and unit dimension rows', () => {
    openSettings();

    const langSelect = dialog.querySelector<HTMLSelectElement>('#settingsLanguageSelect');
    expect(langSelect).not.toBeNull();
    expect(langSelect!.options.length).toBe(14);   // nv withheld from the picker
    expect(langSelect!.value).toBe('en');

    const dimSelects = dialog.querySelectorAll<HTMLSelectElement>('.settings-select[data-unit-dim]');
    expect(dimSelects.length).toBe(6);

    const usBtn = dialog.querySelector<HTMLButtonElement>('#settingsPresetUs');
    const metricBtn = dialog.querySelector<HTMLButtonElement>('#settingsPresetMetric');
    expect(usBtn).not.toBeNull();
    expect(metricBtn).not.toBeNull();
    expect(usBtn!.textContent).toBe('US');
    expect(metricBtn!.textContent).toBe('Metric');
  });

  it('switches language, updates document direction, saves preference, and re-renders dialog', async () => {
    const langChangedSpy = vi.fn();
    on('lang:changed', langChangedSpy);

    openSettings();

    const langSelect = dialog.querySelector<HTMLSelectElement>('#settingsLanguageSelect')!;
    langSelect.value = 'es';
    await loadDictionary('es');
    langSelect.dispatchEvent(new Event('change', { bubbles: true }));
    await vi.waitFor(() => expect(getLocale()).toBe('es'));

    expect(getLocale()).toBe('es');
    expect(localStorage.getItem('tm-lang')).toBe('es');
    expect(document.documentElement.lang).toBe('es');
    expect(document.documentElement.dir).toBe('ltr');
    expect(langChangedSpy).toHaveBeenCalledWith({ locale: 'es' });

    // The header h2 in the dialog was updated via updateDomTranslations
    const headerTitle = dialog.querySelector('h2')!;
    expect(headerTitle.textContent).toBe('Configuración');

    // The preset buttons were re-rendered in Spanish
    const usBtn = dialog.querySelector<HTMLButtonElement>('#settingsPresetUs')!;
    const metricBtn = dialog.querySelector<HTMLButtonElement>('#settingsPresetMetric')!;
    expect(usBtn.textContent).toBe('EE. UU.');
    expect(metricBtn.textContent).toBe('Métrico');

    // Dimension labels are translated
    const labels = Array.from(dialog.querySelectorAll('.settings-row-label')).map(el => el.textContent);
    expect(labels).toContain('Idioma');
    expect(labels).toContain('Temperatura');
    expect(labels).toContain('Velocidad del viento');
  });

  it('switches to RTL language like Arabic correctly', async () => {
    openSettings();

    const langSelect = dialog.querySelector<HTMLSelectElement>('#settingsLanguageSelect')!;
    langSelect.value = 'ar';
    await loadDictionary('ar');
    langSelect.dispatchEvent(new Event('change', { bubbles: true }));
    await vi.waitFor(() => expect(getLocale()).toBe('ar'));

    expect(getLocale()).toBe('ar');
    expect(document.documentElement.dir).toBe('rtl');
    expect(document.documentElement.lang).toBe('ar');
  });

  it('applies metric and US presets correctly', () => {
    const unitsChangedSpy = vi.fn();
    on('units:changed', unitsChangedSpy);

    openSettings();

    const metricBtn = dialog.querySelector<HTMLButtonElement>('#settingsPresetMetric')!;
    metricBtn.click();

    expect(getUnits().temp).toBe('C');
    expect(getUnits().speed).toBe('kph');
    expect(getUnits().distance).toBe('km');
    expect(unitsChangedSpy).toHaveBeenCalled();

    const usBtn = dialog.querySelector<HTMLButtonElement>('#settingsPresetUs')!;
    usBtn.click();

    expect(getUnits().temp).toBe('F');
    expect(getUnits().speed).toBe('mph');
    expect(getUnits().distance).toBe('mi');
  });

  it('updates individual unit dimension preference on change', () => {
    openSettings();

    const tempSelect = dialog.querySelector<HTMLSelectElement>('.settings-select[data-unit-dim="temp"]')!;
    tempSelect.value = 'C';
    tempSelect.dispatchEvent(new Event('change', { bubbles: true }));

    expect(getUnits().temp).toBe('C');
  });
});
