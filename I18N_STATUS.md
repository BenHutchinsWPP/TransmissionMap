# Internationalization (i18n) Implementation Status

**Branch**: `feat/i18n` (local only, never to be pushed)  
**Last Updated**: 2026-08-25  
**Current Phase**: Phase 1, Phase 2, Phase 3 & Phase 4 Complete (Full UI Internationalization Across All 15 Locales)

---

## Progress Overview

| Phase | Description | Status |
|---|---|---|
| **Phase 1** | Baseline i18n Engine, Store, URL State, Basemap Labels, Core Menus & Units | ✅ Completed & Audited |
| **Phase 2** | Full Expansion: Feature Popups, Layer Titles, Tools, Staleness & Disclaimers | ✅ Completed & Verified |
| **Phase 3** | Language Expansion: 15 Locales (Korean, Italian, Hindi, Navajo, Vietnamese, Tagalog) | ✅ Completed & Verified |
| **Phase 4** | Administrative Boundary Layers + Registry Coverage Guard | ✅ Completed & Verified |

---

## Phase 1 Completed Deliverables

- [x] Zero-dependency i18n core engine (`src/i18n/index.ts`, `src/i18n/types.ts`)
- [x] Complete dictionary packs for 9 initial locales (`en`, `es`, `fr`, `de`, `zh`, `pt`, `ru`, `ja`, `ar`)
- [x] RTL document layout handling (`dir="rtl"`) for Arabic
- [x] Storage hierarchy (`URL query > localStorage > navigator.language > 'en'`) in `assets/i18n-store.ts`
- [x] URL hash serialization & syncing (`lang=<locale>`) in `assets/url-state-codec.ts` & `assets/url-state.ts`
- [x] Language selector in `File ▸ Settings…` (`assets/ui/ui-settings.ts`) with live switching
- [x] OpenFreeMap vector basemap symbol label localization in `assets/map.ts`
- [x] Dynamic units options, menubar toggles, and legend headers

---

## Phase 2 Completed Deliverables

- [x] **Package 1: Feature Popups Localization** (`assets/popup-format.ts`, `assets/popup.ts`, `assets/popup-format.test.ts`)
  - All field label headers, titles, status strings, table headers, and footers wrapped in `t()`.
  - Dynamic properties fall back seamlessly to raw key names.
- [x] **Package 2: Layer Registry Titles & Dynamic Layer Panel** (`src/types.ts`, `src/registry/*.ts`, `assets/ui/ui-layer-rows.ts`, `assets/ui/ui.ts`)
  - `titleKey` added to `LayerDef` interface (required — every layer has one).
  - All 43+ layer definitions annotated with `titleKey`.
  - Layer panel row titles, tooltips, buttons (download, source, filter, year filter, display modes, weather variable selector) fully localized.
  - Layer panel and legends dynamically re-render on `'lang:changed'` state bus event.
- [x] **Package 3: Measurement, Tools & Weather Variable Selector** (`assets/measure.ts`, `src/registry/conditions.ts`, `assets/user-data/user-data.ts`, `assets/user-data/user-data-csv.ts`)
  - Measurement readout localized (`measure.clickToStart`).
  - Weather variable selector localized across all 9 variables.
  - My Data tab, Loaded Files, My Drawings, and CSV column mapper dialog localized.
- [x] **Package 4: Disclaimers & Staleness Modals** (`index.html`, `src/i18n/index.ts`, `src/i18n/locales/*.ts`)
  - Added `data-i18n-html` processing to `updateDomTranslations()`.
  - First-visit disclaimer (`#disclaimerDialog`) and Tribal layer context dialog (`#tribalDisclaimerDialog`) annotated with `data-i18n` and `data-i18n-html`.
  - Feed staleness kill-switch dialogs (`#wildfireStaleDialog`, `#nwsStaleDialog`) annotated.
  - Governing Language Clause added to disclaimers for non-English locales:
    > *"This translation is provided for convenience only. In the event of any discrepancy, the English version shall govern."*

---

## Phase 3 Completed Deliverables (Language Tier Expansion)

- [x] **Package 1: Type System & Core Registry Registration** (`src/i18n/types.ts`, `src/i18n/index.ts`)
  - Expanded `SupportedLocale` type union to 15 languages: `'en' | 'es' | 'fr' | 'de' | 'zh' | 'pt' | 'ru' | 'ja' | 'ar' | 'ko' | 'it' | 'hi' | 'nv' | 'vi' | 'tl'`.
  - Added metadata to `SUPPORTED_LOCALES` (code, English name, native name, direction).
  - Imported and registered all 6 new locale dictionaries in `DICTIONARIES` registry.
- [x] **Package 2: 6 New Locale Dictionaries with 100% Key Parity** (`src/i18n/locales/*.ts`)
  - `src/i18n/locales/ko.ts` (Korean — 한국어)
  - `src/i18n/locales/it.ts` (Italian — Italiano)
  - `src/i18n/locales/hi.ts` (Hindi — हिन्दी)
  - `src/i18n/locales/nv.ts` (Navajo — Diné Bizaad)
  - `src/i18n/locales/vi.ts` (Vietnamese — Tiếng Việt)
  - `src/i18n/locales/tl.ts` (Tagalog — Wikang Tagalog)
  - All 204 keys populated across all dictionaries matching `src/i18n/locales/en.ts`.
  - Governing Language Clause (`disclaimer.governing`) included across all non-English dictionaries.
- [x] **Package 3: Basemap Labels & Font Rendering Validation** (`assets/map.ts`, `assets/ui/ui-settings.ts`)
  - Verified OpenFreeMap fallback expression chain (`name:<locale>` -> `name:en` -> `name`) for all new locales.
  - Settings language dropdown dynamically populates all 15 language options with native labels.
- [x] **Package 4: Testing, Verification & Quality Gates** (`src/i18n/i18n.test.ts`, `assets/ui/ui-settings.test.ts`)
  - `npm run typecheck`: 0 errors
  - `npm run lint`: 0 errors
  - `npm test`: 503 tests passing across 24 test suites with 100% key parity across all 15 locales
  - `npm run build`: Clean production bundle built in `dist/`
  - `make test-pipeline`: 64 tests passing with 0 errors

---

## Phase 4 Completed Deliverables (Administrative Boundaries)

Covers the Regions-group boundary layers that arrived on `main` after Phase 3
(Countries, States / Provinces, Census States, Census Counties, Census ZCTA).

- [x] **Package 1: Layer Titles** (`src/registry/regions.ts`, `src/i18n/locales/*.ts`)
  - `titleKey` added to all five boundary layers (`layer.countries`,
    `layer.admin1`, `layer.usStates`, `layer.usCounties`, `layer.usZcta`).
- [x] **Package 2: Boundary Popups** (`assets/popup-format.ts`)
  - Country / admin-1 / state / county / ZCTA popup titles, row labels and the
    ZCTA display note routed through `t()`; the note is `escapeHtml`-wrapped
    now that its text comes from a dictionary.
  - New keys: `popup.country`, `popup.isoCode`, `popup.geoid`, `popup.zctaNote`.
    Existing `popup.state`, `popup.county` and `popup.abbreviation` are reused.
- [x] **Package 3: Coverage Guard** (`src/i18n/i18n.test.ts`)
  - A per-layer test asserts every `LAYERS` entry carries a `titleKey` that
    `en.ts` defines, so a layer added upstream shows up as a test failure
    instead of an English title inside a translated panel.
- [x] **Package 4: Quality Gates**
  - `npm run typecheck`: 0 errors
  - `npm test`: 560 tests passing across 25 suites, key parity intact across all 15 locales
  - `npm run build`: clean production bundle

### Notes for translation review

- Navajo (`nv`) keeps the new administrative-boundary strings in English,
  matching the existing `popup.county` / `popup.state` entries in that
  dictionary. A native-speaker pass is the right way to settle them.
- Data-credit body text in `index.html` stays English for every source,
  including the new geoBoundaries and US Census entries — only the
  “Data Credits” heading is localized. Unchanged by this phase.
- Boundary label layers render the `name` field baked into the PMTiles, which
  is English-only upstream. Localizing those needs a pipeline change
  (`scripts/extract_cgaz_boundaries.py`,
  `scripts/extract_us_census_boundaries.py`), not a dictionary change.
