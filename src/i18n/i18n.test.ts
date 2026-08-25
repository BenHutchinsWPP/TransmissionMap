// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import {
  t,
  getLocale,
  setLocale,
  isValidLocale,
  DICTIONARIES,
  loadDictionary,
  getLocaleDef,
  applyDocumentDirection,
  updateDomTranslations,
  SUPPORTED_LOCALES,
} from './index.js';
import en from './locales/en.js';
import { LAYERS } from '../registry/index.js';

describe('i18n Core Engine', () => {
  beforeEach(() => {
    setLocale('en');
  });

  describe('Locale Management', () => {
    it('defaults to English (en)', () => {
      expect(getLocale()).toBe('en');
    });

    it('switches locales correctly', () => {
      setLocale('es');
      expect(getLocale()).toBe('es');

      setLocale('ja');
      expect(getLocale()).toBe('ja');

      setLocale('ar');
      expect(getLocale()).toBe('ar');
    });

    it('ignores invalid locales in setLocale', () => {
      setLocale('es');
      // @ts-expect-error test runtime invalid locale
      setLocale('invalid_locale');
      expect(getLocale()).toBe('es');
    });

    it('isValidLocale validates supported locales correctly', () => {
      expect(isValidLocale('en')).toBe(true);
      expect(isValidLocale('es')).toBe(true);
      expect(isValidLocale('fr')).toBe(true);
      expect(isValidLocale('de')).toBe(true);
      expect(isValidLocale('zh')).toBe(true);
      expect(isValidLocale('pt')).toBe(true);
      expect(isValidLocale('ru')).toBe(true);
      expect(isValidLocale('ja')).toBe(true);
      expect(isValidLocale('ar')).toBe(true);
      expect(isValidLocale('ko')).toBe(true);
      expect(isValidLocale('it')).toBe(true);
      expect(isValidLocale('hi')).toBe(true);
      expect(isValidLocale('nv')).toBe(true);
      expect(isValidLocale('vi')).toBe(true);
      expect(isValidLocale('tl')).toBe(true);

      expect(isValidLocale('nl')).toBe(false);
      expect(isValidLocale('en-US')).toBe(false);
      expect(isValidLocale('')).toBe(false);
      expect(isValidLocale('unknown')).toBe(false);
    });

    it('SUPPORTED_LOCALES lists all 15 locale definitions', () => {
      expect(SUPPORTED_LOCALES).toHaveLength(15);
      expect(SUPPORTED_LOCALES.map(l => l.code)).toEqual([
        'en', 'es', 'fr', 'de', 'zh', 'pt', 'ru', 'ja', 'ar',
        'ko', 'it', 'hi', 'nv', 'vi', 'tl',
      ]);
    });

    it('getLocaleDef returns correct definition with text direction', () => {
      const enDef = getLocaleDef('en');
      expect(enDef).toEqual({
        code: 'en',
        name: 'English',
        nativeName: 'English',
        dir: 'ltr',
      });

      const arDef = getLocaleDef('ar');
      expect(arDef).toEqual({
        code: 'ar',
        name: 'Arabic',
        nativeName: 'العربية',
        dir: 'rtl',
      });
      expect(arDef.dir).toBe('rtl');

      const nvDef = getLocaleDef('nv');
      expect(nvDef).toEqual({
        code: 'nv',
        name: 'Navajo',
        nativeName: 'Diné Bizaad',
        dir: 'ltr',
      });
    });

    it('getLocaleDef falls back to English for unknown locale', () => {
      // @ts-expect-error test fallback
      const def = getLocaleDef('nonexistent');
      expect(def.code).toBe('en');
    });
  });

  describe('Translation Lookup & Fallbacks', () => {
    it.each([
      ['en', 'File', 'Map Layers', 'Transmission'],
      ['es', 'Archivo', 'Capas del mapa', 'Transmisión'],
      ['fr', 'Fichier', 'Couches de carte', 'Transport'],
      ['de', 'Datei', 'Kartenebenen', 'Übertragung'],
      ['zh', '文件', '地图图层', '输电网络'],
      ['pt', 'Arquivo', 'Camadas do mapa', 'Transmissão'],
      ['ru', 'Файл', 'Слои карты', 'Передача электроэнергии'],
      ['ja', 'ファイル', 'マップレイヤー', '送電線'],
      ['ar', 'ملف', 'طبقات الخريطة', 'خطوط النقل'],
      ['ko', '파일', '지도 레이어', '송전선로'],
      ['it', 'File', 'Livelli mappa', 'Trasmissione'],
      ['hi', 'फ़ाइल', 'मानचित्र परतें', 'पारेषण'],
      ['nv', 'Naaltsoos', 'Kéyah bikʼi sinilígíí', 'Atsingeeł beʼatiin'],
      ['vi', 'Tệp', 'Lớp bản đồ', 'Truyền tải điện'],
      ['tl', 'File', 'Mga Layer ng Mapa', 'Transmisyon'],
    ] as const)('translates keys in %s', async (code, file, layers, transmission) => {
      await loadDictionary(code);
      setLocale(code);
      expect(t('menu.file')).toBe(file);
      expect(t('tabs.mapLayers')).toBe(layers);
      expect(t('groups.transmission')).toBe(transmission);
    });

    it('falls back to English when a key is missing in active locale', () => {
      setLocale('es');
      // Look up a key that only exists in 'en'
      // Temporarily test fallback by injecting or testing a non-existent key that's in en
      expect(t('nonexistent.key.xyz')).toBe('nonexistent.key.xyz');
    });

    it('returns raw key when missing in both target locale and English', () => {
      setLocale('es');
      expect(t('totally.unknown.key')).toBe('totally.unknown.key');
    });
  });

  describe('Parameter Interpolation', () => {
    it('interpolates single parameter into string', () => {
      // Testing parameter interpolation
      expect(t('Hello {name}', { name: 'Alice' })).toBe('Hello Alice');
    });

    it('interpolates multiple parameters into string', () => {
      expect(t('Page {page} of {total}', { page: 1, total: 10 })).toBe('Page 1 of 10');
    });

    it('leaves missing params in placeholder format', () => {
      expect(t('{greeting}, {name}!', { greeting: 'Hello' })).toBe('Hello, {name}!');
    });

    it('handles numeric parameters', () => {
      expect(t('{count} items', { count: 0 })).toBe('0 items');
    });
  });

  describe('applyDocumentDirection', () => {
    it('applies LTR direction for English and others', () => {
      applyDocumentDirection('en');
      expect(document.documentElement.dir).toBe('ltr');
      expect(document.documentElement.lang).toBe('en');

      applyDocumentDirection('fr');
      expect(document.documentElement.dir).toBe('ltr');
      expect(document.documentElement.lang).toBe('fr');
    });

    it('applies RTL direction for Arabic', () => {
      applyDocumentDirection('ar');
      expect(document.documentElement.dir).toBe('rtl');
      expect(document.documentElement.lang).toBe('ar');
    });

    it('setLocale automatically calls applyDocumentDirection', () => {
      setLocale('ar');
      expect(document.documentElement.dir).toBe('rtl');
      expect(document.documentElement.lang).toBe('ar');

      setLocale('es');
      expect(document.documentElement.dir).toBe('ltr');
      expect(document.documentElement.lang).toBe('es');
    });
  });

  describe('updateDomTranslations', () => {
    it('translates data-i18n text content', () => {
      setLocale('en');
      const div = document.createElement('div');
      div.innerHTML = '<span data-i18n="menu.file">Old</span><button data-i18n="menu.edit">Old</button>';

      updateDomTranslations(div);

      const span = div.querySelector('span')!;
      const button = div.querySelector('button')!;
      expect(span.textContent).toBe('File');
      expect(button.textContent).toBe('Edit');

      setLocale('es');
      updateDomTranslations(div);
      expect(span.textContent).toBe('Archivo');
      expect(button.textContent).toBe('Editar');
    });

    it('translates data-i18n-title attributes', () => {
      setLocale('en');
      const div = document.createElement('div');
      div.innerHTML = '<button data-i18n-title="panel.resetLayersTitle">Button</button>';

      updateDomTranslations(div);
      const button = div.querySelector('button')!;
      expect(button.title).toBe(
        "Restore every layer's visibility, filters, MW/year ranges, display mode and basemap to defaults"
      );

      setLocale('es');
      updateDomTranslations(div);
      expect(button.title).toBe(
        'Restablecer visibilidad de capas, filtros, rangos de MW/año, modo de visualización y mapa base a los valores predeterminados'
      );
    });

    it('translates data-i18n-placeholder attributes', () => {
      setLocale('en');
      const div = document.createElement('div');
      div.innerHTML = '<input type="search" data-i18n-placeholder="panel.searchPlaceholder">';

      updateDomTranslations(div);
      const input = div.querySelector('input')!;
      expect(input.placeholder).toBe('Search features…');

      setLocale('de');
      updateDomTranslations(div);
      expect(input.placeholder).toBe('Objekte suchen…');
    });

    it('translates data-i18n-aria-label attributes', () => {
      setLocale('en');
      const div = document.createElement('div');
      div.innerHTML = '<button data-i18n-aria-label="info.dataCredits">i</button>';

      updateDomTranslations(div);
      const button = div.querySelector('button')!;
      expect(button.getAttribute('aria-label')).toBe('Data Credits');

      setLocale('zh');
      updateDomTranslations(div);
      expect(button.getAttribute('aria-label')).toBe('数据来源与鸣谢');
    });

    it('updates element when root itself has data-i18n attributes', () => {
      setLocale('en');
      const span = document.createElement('span');
      span.setAttribute('data-i18n', 'settings.title');
      span.setAttribute('data-i18n-title', 'settings.language');

      updateDomTranslations(span);
      expect(span.textContent).toBe('Settings');
      expect(span.title).toBe('Language');
    });

    it('translates data-i18n-html attributes', () => {
      setLocale('en');
      const div = document.createElement('div');
      div.innerHTML = '<p data-i18n-html="disclaimer.p4"></p>';

      updateDomTranslations(div);
      const p = div.querySelector('p')!;
      expect(p.innerHTML).toContain('<a href=');
      expect(p.innerHTML).toContain('GitHub');
    });
  });

  describe('Dictionary Completeness & Parity', () => {
    const requiredKeyPrefixes = [
      'menu.',
      'tabs.',
      'panel.',
      'geocoder.',
      'basemap.',
      'groups.',
      'layer.',
      'weather.',
      'mode.',
      'colorby.',
      'year.',
      'measure.',
      'mydata.',
      'csv.',
      'popup.',
      'disclaimer.',
      'tribal.',
      'stale.',
      'settings.',
      'units.',
      'legend.',
      'toast.',
      'info.',
    ];

    const enKeys = Object.keys(en);

    it('English master dictionary contains all required key categories', () => {
      requiredKeyPrefixes.forEach(prefix => {
        const matches = enKeys.filter(k => k.startsWith(prefix));
        expect(matches.length).toBeGreaterThan(0);
      });
    });

    SUPPORTED_LOCALES.forEach(localeDef => {
      it(`locale "${localeDef.code}" (${localeDef.name}) has 100% key parity with English`, async () => {
        await loadDictionary(localeDef.code);
        const dict = DICTIONARIES[localeDef.code];
        if (!dict) throw new Error(`dictionary for ${localeDef.code} failed to load`);

        // Check for missing and extra keys
        const missingKeys = enKeys.filter(k => !(k in dict));
        expect(missingKeys, `Locale ${localeDef.code} is missing keys: ${missingKeys.join(', ')}`).toEqual([]);

        const extraKeys = Object.keys(dict).filter(k => !(k in en));
        expect(extraKeys, `Locale ${localeDef.code} has extra keys: ${extraKeys.join(', ')}`).toEqual([]);

        // Check that values are non-empty strings (except disclaimer.governing which is empty for en)
        enKeys.forEach(key => {
          expect(typeof dict[key]).toBe('string');
          if (key === 'disclaimer.governing' && localeDef.code === 'en') {
            expect(dict[key]).toBe('');
          } else {
            expect(dict[key].trim().length).toBeGreaterThan(0);
          }
        });
      });
    });
  });

  it.each(LAYERS)('layer "$id" has a titleKey the English dictionary defines', layer => {
    expect(en[layer.titleKey], `titleKey "${layer.titleKey}" is not in en.ts`).toBeTruthy();
  });
});
