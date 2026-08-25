# GUI Internationalization (i18n) & Language Support Implementation Plan

## 1. Objective & Architecture Overview

Enable full, zero-dependency internationalization (i18n) for TransmissionMap with instant client-side language switching, URL persistence, localStorage caching, browser language auto-detection, RTL layout support, and vector basemap label re-targeting.

### Core Architectural Decisions & Fixes (Post-Adversarial Review)
1. **Strict Initialization Hierarchy**:
   - URL parameter (`#...&lang=es`) strictly overrides `localStorage['tm-lang']`.
   - `localStorage['tm-lang']` overrides `navigator.language`.
   - Fallback is `'en'`.
2. **Dynamic UI & Popups Lifecycle**:
   - Dynamic renderers (`ui-legends.ts`, `ui-layer-rows.ts`, `popup-format.ts`, `ui-settings.ts`) use `t()` directly at call-time.
   - On `'lang:changed'`, static elements update via `updateDomTranslations()`, active legends re-render, and any open MapLibre popup is closed or refreshed.
3. **`UNIT_OPTIONS` Key Indirection**:
   - `src/units.ts` stores translation keys (`labelKey`, `optLabelKey`) or resolves labels at call-time, preventing frozen module-load strings.
4. **Vector Basemap Label Synchronization**:
   - `addOfmBasemaps()` applies the language `coalesce` expression upon grafting layers.
   - `setMapLabelLanguage(map, locale)` iterates through symbol layers to update `text-field` dynamically on `lang:changed`.
5. **URL State Synchronization**:
   - When language changes via UI or store, `'lang:changed'` triggers `'url:write'` so the hash updates immediately.
6. **Zero-Dependency & `.js` Import Rule**:
   - Pure TypeScript dictionaries in `src/i18n/locales/`.
   - All imports explicitly use `.js` extensions (e.g. `import { t } from '../src/i18n/index.js'`).

---

## 2. Supported Locales

| Code | Language | Native Name | Text Direction |
|---|---|---|---|
| `en` | English (Default) | English | LTR |
| `es` | Spanish | Español | LTR |
| `fr` | French | Français | LTR |
| `de` | German | Deutsch | LTR |
| `zh` | Chinese (Simplified) | 简体中文 | LTR |
| `pt` | Portuguese | Português | LTR |
| `ru` | Russian | Русский | LTR |
| `ja` | Japanese | 日本語 | LTR |
| `ar` | Arabic | العربية | RTL |

---

## 3. Module Design & Contracts

### 3.1 Core i18n Engine (`src/i18n/`)
- `src/i18n/types.ts`:
  - `SupportedLocale`: `'en' | 'es' | 'fr' | 'de' | 'zh' | 'pt' | 'ru' | 'ja' | 'ar'`
  - `LocaleDef`: `{ code: SupportedLocale; name: string; nativeName: string; dir: 'ltr' | 'rtl' }`
  - `LocaleDictionary`: `Record<string, string>`
- `src/i18n/locales/`:
  - `en.ts`: Complete master dictionary (~150 keys covering menubar, tabs, search, basemap, tools, layer groups, units, settings, legends, diagnostics)
  - `es.ts`, `fr.ts`, `de.ts`, `zh.ts`, `pt.ts`, `ru.ts`, `ja.ts`, `ar.ts`: Translated dictionaries
- `src/i18n/index.ts`:
  - `t(key: string, params?: Record<string, string | number>): string`
  - `getLocale(): SupportedLocale`
  - `setLocale(locale: SupportedLocale): void`
  - `getSupportedLocales(): LocaleDef[]`
  - `getLocaleDef(locale: SupportedLocale): LocaleDef`
  - `updateDomTranslations(root?: HTMLElement | Document): void`
  - `applyDocumentDirection(locale: SupportedLocale): void` (toggles `document.documentElement.dir = 'rtl' | 'ltr'`)

### 3.2 Storage & Persistence (`assets/i18n-store.ts`)
- `loadLanguage(urlLang?: string | null): SupportedLocale`:
  1. Validates `urlLang` if provided.
  2. If absent, checks `localStorage.getItem('tm-lang')`.
  3. If absent, checks `navigator.language` (e.g. `navigator.language.slice(0, 2)`).
  4. Defaults to `'en'`.
- `saveLanguage(locale: SupportedLocale): void`: Writes to `localStorage.setItem('tm-lang', locale)`.

### 3.3 Event Bus (`assets/state-bus.ts`)
- Add `'lang:changed': { locale: SupportedLocale }` to `Events`.

### 3.4 URL State (`assets/url-state-codec.ts` & `assets/url-state.ts`)
- Add `lang?: string` to `UrlStateData`.
- `parseUrlState(params)`: `const lang = params.get('lang'); if (lang && isValidLocale(lang)) data.lang = lang;`
- `formatUrlState(state)`: `if (state.lang && state.lang !== 'en') parts.push(`lang=${encodeURIComponent(state.lang)}`);`
- In `url-state.ts`: handle `lang` during initial parse and serialization; subscribe to `'lang:changed'` to trigger `'url:write'`.
- Document `lang` in `docs/url-state.md`.

### 3.5 Settings UI (`assets/ui/ui-settings.ts`)
- Render a "Language" `<select>` row at the top of the Settings dialog.
- Wire selection event -> `setLocale(val)` -> `saveLanguage(val)` -> `emit('lang:changed', { locale: val })` -> `emit('url:write')`.
- Ensure `syncControls` reflects the active language and updates localized unit dimension labels.

### 3.6 DOM Annotations (`index.html`)
- Annotate static elements with:
  - `data-i18n="key"`: updates `el.textContent`
  - `data-i18n-title="key"`: updates `el.title`
  - `data-i18n-placeholder="key"`: updates `el.placeholder`
  - `data-i18n-aria-label="key"`: updates `aria-label`

### 3.7 Dynamic Components & Units
- `src/units.ts`: Refactor `UNIT_OPTIONS` to support localized display via `t()` or localized getters.
- `assets/ui/ui-menubar.ts`: Update toggle item text (e.g. "Hide legends" / "Show legends") with `t()`.
- `assets/ui/ui-legends.ts`: Localize "All", "None", and filter labels.
- `assets/map.ts`:
  - `setMapLabelLanguage(map: maplibregl.Map, locale: SupportedLocale): void`
  - Re-apply label expression on basemap style changes and `lang:changed`.

---

## 4. Implementation Waves & Sub-agent Packaging

### Wave 1: Core i18n Engine & Locales
- **Ownership**: `src/i18n/types.ts`, `src/i18n/locales/*.ts`, `src/i18n/index.ts`, `src/i18n/i18n.test.ts`
- **Output**: Fully typed engine with all 9 locale dictionaries, fallback logic, string interpolation, DOM updater, and 100% test coverage.

### Wave 2: Persistence, Store, URL State & Event Bus
- **Ownership**: `assets/i18n-store.ts`, `assets/i18n-store.test.ts`, `assets/state-bus.ts`, `assets/url-state-codec.ts`, `assets/url-state.ts`, `assets/url-state.test.ts`, `docs/url-state.md`
- **Output**: `localStorage` + URL hash parameter round-trip, bus events, and tests.

### Wave 3: Static DOM Annotations & Settings UI
- **Ownership**: `index.html`, `assets/ui/ui-settings.ts`
- **Output**: All static UI strings marked with `data-i18n*` attributes, Language selector in Settings dialog with live switching.

### Wave 4: Dynamic UI Components, Units & Basemap Labels
- **Ownership**: `src/units.ts`, `assets/ui/ui-menubar.ts`, `assets/ui/ui-legends.ts`, `assets/map.ts`, `src/main.ts`
- **Output**: Units dialog options localized, menubar/legend toggles localized, OpenFreeMap vector labels localized.

### Wave 5: Verification & Full Audit
- **Checks**: `npm run typecheck`, `npm run lint`, `npm test`, clean subagent review.
