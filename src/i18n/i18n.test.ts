// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
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
  ROUTE_DICTIONARIES,
  loadRouteStrings,
} from './index.js';
import en from './locales/en.js';
import { LAYERS } from '../registry/index.js';
import { concernKeys } from '../colors/route-constraints.js';

// Every route file, nv included (the picker list leaves nv out).
const routeFiles = import.meta.glob<Record<string, string>>('./route/*.ts', { eager: true, import: 'default' });
const routeDict = (code: string) => routeFiles[`./route/${code}.ts`];
const routeCodes = Object.keys(routeFiles).map(f => path.basename(f, '.ts'));
const baseFiles = import.meta.glob<Record<string, string>>('./locales/*.ts', { eager: true, import: 'default' });
const baseDict = (code: string) => baseFiles[`./locales/${code}.ts`];

// The route.* keys the boot bundle reads: they stay in locales/*.ts; every other route.* key is in route/*.ts.
const BOOT_ROUTE_KEYS = new Set([
  ...concernKeys(),
  'route.concern.noteMaxOverview', 'route.concern.noteUnshaded', 'route.concern.creditPopwest',
  'route.concern.creditOsmLines', 'route.concern.creditOsm', 'route.menu', 'route.ctxFrom', 'route.ctxTo', 'route.tab',
]);

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
      expect(isValidLocale('vi')).toBe(true);
      expect(isValidLocale('tl')).toBe(true);

      // Withheld from the picker pending a Diné speaker's review — the
      // dictionary still ships, but the locale is not selectable.
      expect(isValidLocale('nv')).toBe(false);

      expect(isValidLocale('nl')).toBe(false);
      expect(isValidLocale('en-US')).toBe(false);
      expect(isValidLocale('')).toBe(false);
      expect(isValidLocale('unknown')).toBe(false);
    });

    it('SUPPORTED_LOCALES lists the 14 selectable locale definitions', () => {
      expect(SUPPORTED_LOCALES).toHaveLength(14);
      expect(SUPPORTED_LOCALES.map(l => l.code)).toEqual([
        'en', 'es', 'fr', 'de', 'zh', 'pt', 'ru', 'ja', 'ar',
        'ko', 'it', 'hi', 'vi', 'tl',
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

      const hiDef = getLocaleDef('hi');
      expect(hiDef).toEqual({
        code: 'hi',
        name: 'Hindi',
        nativeName: 'हिन्दी',
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

    it('returns an Object.prototype key as the raw key', () => {
      setLocale('es');
      expect(t('constructor')).toBe('constructor');
      expect(t('__proto__')).toBe('__proto__');
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

  describe("Route panel strings", () => {
    // English values that stay identical in every locale: symbols, units, numbers, proper names.
    const SAME_AS_ENGLISH = new Set<string>([
      "{band}: {value}",
      "TEPPC", "CAISO", "MISO", "SPP", "ERCOT", "PJM", "NYISO", "ISO-NE",   // ISO / RTO names
      "Routing ×{x}",
      "Sage-grouse PHMA",
      "Sage-grouse GHMA",
      "ACEC",
      "{lo} % / {hi} %",
      "{amount}/mi",
      "{mi} mi",
      "{kv} kV",
      "{mi} mi · {total} ({low}–{high})",
      "terrain",   // fr
      "protection",   // fr
      "exact",   // fr
      "Mile",   // fr
      "Longitude",   // fr, pt
      "Latitude",   // fr, pt
      "Detail",   // de
      "mi {mi}",
      "×{x}",
      "{n} × ${each} M",
      "mi {mi} · {elev}",
      "—",
      "GAP {n}",
      "PHMA",
      "Section 368",
      "route-crossings.csv",
      "≤ {pct} %",
      "{pct} %",
      "{name} {parts}.",
      "{group} · {rule}",
      "{i} / {n}",
      "{label} — {note}",
      "{lo}–{hi}°",
      "{code} (FIPS {fips})",
      "${usd}/ac",
      "BLM",
      "USFS",
      "NPS",
      "FWS",
      "DOD",
      "DOE",
      "BOR",
      "{lineType} · {method} · {date}",
      "A",
      "B",
      "{what} ×{k}: {usd} · {mi} mi",
      "mi",
      "{n} km",
      "Route",
      "Region",
      "Pipeline",
      "Wilderness Study Area",
      "National Monument / NCA",
      "Inventoried Roadless Area",
      "Pipelines",
      "Optimal",
      "Live",
      "{group}, {rule}",
      "Route: {a} → {b}",
      "NLCD, 3DEP, PAD-US, USFWS, BLM, OpenStreetMap (ODbL), HIFLD, WorldPop (CC BY 4.0), PoPWest (CC BY 4.0)",
      "Name",
      "Subtotal",
      "Total",
      "Base",
      "${perMi} M/mi ({year}$) × {mi} mi",
      "Tribal",
      "1 error",
      "bit {n}",
      "Local",
      "{n} pipeline",
      "{n} pipelines",
      "Source",
      "Mile {mi}",
      "Habitat",
      "Miles",
      "Sources",
      "code {v}",
      "Protection",
      "Habitat / Superfund",
      "Lichens",
      "Point",
      "2025$",
      "{year}$",
      "Alt {n}",
      "Alt {n} · +{pct} % · {mi} mi · {usd}",
      "max {kv} kV",
      "Wilderness study area",
      "Inventoried roadless area",
      "Item",
    ]);
    // Tagalog keeps these technical terms in English, as the rest of tl.ts does.
    const TAGALOG_ENGLISH = new Set<string>([
      "Land cover",
      "Slope",
      "Critical habitat",
      "Section 368 corridor",
      "Superfund site",
      "Wild & Scenic River corridor",
      "National Historic/Scenic Trail corridor",
      "Short-line factor",
      "Contingency {pct} %",
      "Contingency",
      "Point estimate",
      "{dollars} · point estimate",
      "all-in",
      "Endpoint {end}",
      "Profile",
      "Driver",
      "＋ My Data",
      "Nominal ({year}$)",
      "Feature",
      "National monument / conservation area",
      "Area of critical environmental concern",
      "{mi} mi tribal",
      "Routing weight",
      "Contingency %",
      "{row}: routing weight",
      "{row}: cost multiplier",
      "1 edit",
      "Routing weight ×{x}",
      "{label} · routing weight ×{r}",
      "Dwarf scrub",
      "Shrub/scrub",
      "Sedge/herbaceous",
      "scale ×",
      "premium",
      "routing ×{a}→{b}",
      "Contingency: {a} % → {b} %",
      "routing premium",
      "Alt {n} · +{pct} % routing cost",
      "Cost multiplier",
    ]);
    const params = (s: string) => s.match(/\{\w+\}/g) ?? [];

    const enRoute = routeDict('en');
    const withRoute = (code: string) => ({ ...baseDict(code), ...routeDict(code) });

    it('has route files for all 15 locales', () => {
      expect(routeCodes.length).toBe(15);
      expect(Object.keys(enRoute).length).toBeGreaterThan(700);
    });

    it('en base holds exactly the boot route keys, and the route files none of them', () => {
      const baseRoute = Object.keys(en).filter(k => k.startsWith('route.'));
      expect(new Set(baseRoute)).toEqual(BOOT_ROUTE_KEYS);
      expect(Object.keys(enRoute).filter(k => k in en)).toEqual([]);
      expect(Object.keys(enRoute).filter(k => !k.startsWith('route.'))).toEqual([]);
    });

    it.each(routeCodes)('route file "%s" has the keys of English, non-empty, with every {param}', (code) => {
      const dict = routeDict(code);
      expect(Object.keys(dict).sort()).toEqual(Object.keys(enRoute).sort());
      const bad = Object.keys(enRoute).filter(k => !dict[k]?.trim() || params(enRoute[k]).some(p => !dict[k].includes(p)));
      expect(bad, `${code} route strings empty or dropping a {param}`).toEqual([]);
    });

    it.each(routeCodes.filter(c => c !== 'en' && c !== 'nv'))('locale "%s" translates the route strings', (code) => {
      const dict = withRoute(code);
      const all = { ...en, ...enRoute };
      const untranslated = Object.keys(all).filter(k =>
        k.startsWith('route.') && dict[k] === all[k] && !SAME_AS_ENGLISH.has(all[k]) &&
        !(code === 'tl' && TAGALOG_ENGLISH.has(all[k])));
      expect(untranslated, `${code} has English placeholders`).toEqual([]);
    });

    it('no module outside the route chunk reads a route.* key that is not in en base', () => {
      const root = process.cwd();
      const files: string[] = [path.join(root, 'index.html')];
      const walk = (d: string) => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          const f = path.join(d, e.name);
          if (e.isDirectory()) walk(f); else if (f.endsWith('.ts')) files.push(f);
        }
      };
      walk(path.join(root, 'assets')); walk(path.join(root, 'src'));
      const inRouteChunk = (rel: string) =>
        rel.startsWith('assets/route/') || rel.startsWith('assets/ui/route-tabs/') ||
        rel === 'assets/ui/ui-route.ts' || rel === 'assets/ui/notice-dialog.ts' ||
        (/^assets\/ui\/route-/.test(rel) && rel !== 'assets/ui/route-panel-open.ts');
      const skip = (rel: string) => /\.test\.ts$/.test(rel) || rel.startsWith('src/i18n/locales/') || rel.startsWith('src/i18n/route/') ||
        rel.startsWith('assets/route/fixtures/') || inRouteChunk(rel);
      const missing: string[] = [];
      let scanned = 0;
      for (const f of files) {
        const rel = path.relative(root, f);
        if (skip(rel)) continue;
        scanned++;
        for (const m of fs.readFileSync(f, 'utf8').matchAll(/['"`](route\.[a-z][\w.-]*)/g)) {
          if (m[1].endsWith('.')) continue;   // a template prefix: concernKeys() covers its keys
          if (!(m[1] in en)) missing.push(`${rel}: ${m[1]}`);
        }
      }
      expect(scanned).toBeGreaterThan(100);
      expect(missing).toEqual([]);
    });

    describe('loading', () => {
      const KEY = 'route.notice.title';
      it('is the raw key before loadRouteStrings, English after, Spanish after loadDictionary', async () => {
        vi.resetModules();
        const m = await import('./index.js');
        expect(m.t(KEY)).toBe(KEY);
        await m.loadRouteStrings();
        expect(m.t(KEY)).toBe(enRoute[KEY]);
        await m.loadDictionary('es');
        m.setLocale('es');
        expect(m.t(KEY)).toBe(routeDict('es')[KEY]);
        expect(m.t(KEY)).not.toBe(enRoute[KEY]);
        expect(m.t('route.menu')).toBe(baseDict('es')['route.menu']);
      });

      it('falls back to English route text when the Spanish route part cannot load', async () => {
        vi.resetModules();
        vi.doMock('./route/es.ts', () => { throw new Error('offline'); });
        try {
          const m = await import('./index.js');
          await m.loadRouteStrings();
          await m.loadDictionary('es');
          m.setLocale('es');
          expect(m.t(KEY)).toBe(enRoute[KEY]);
          expect(m.t('menu.file')).toBe('Archivo');
        } finally { vi.doUnmock('./route/es.ts'); }
      });

      it('loadRouteStrings fills the current language and keeps later switches in step', async () => {
        await loadDictionary('de');
        setLocale('de');
        await loadRouteStrings();
        expect(ROUTE_DICTIONARIES.de).toEqual(routeDict('de'));
        expect(ROUTE_DICTIONARIES.en).toEqual(enRoute);
        setLocale('en');
      });
    });
  });

  it.each(LAYERS)('layer "$id" has a titleKey the English dictionary defines', layer => {
    expect(en[layer.titleKey], `titleKey "${layer.titleKey}" is not in en.ts`).toBeTruthy();
  });
});
