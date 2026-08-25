# Phase 3: Language Tier Expansion Plan

## 1. Scope & Objective

Expand TransmissionMap's internationalization (i18n) support from 9 to 15 languages, adding major global grid and renewable energy hubs, high-representation demographic communities across Western US service territories, and indigenous North American language representation.

---

## 2. Target Locales

| Locale Code | Language | Native Label | Category / Rationale | Basemap Label Support |
|---|---|---|---|---|
| `ko` | Korean | 한국어 | Major BESS (battery energy storage), solar manufacturing, and grid tech hub | Native `name:ko` in OpenFreeMap |
| `it` | Italian | Italiano | Major European transmission & renewable development market (Terna, Enel) | Native `name:it` in OpenFreeMap |
| `hi` | Hindi | हिन्दी | Major synchronous power grid & massive renewable expansion | Native `name:hi` in OpenFreeMap |
| `nv` | Navajo | Diné Bizaad | Sovereign tribal land alignment (Navajo Nation, Four Corners transmission hub) | Native fallback to `name` / `name:en` |
| `vi` | Vietnamese | Tiếng Việt | High demographic representation across CAISO/WECC service areas (CA, WA) | Native fallback to `name` / `name:en` |
| `tl` | Tagalog | Wikang Tagalog | High demographic representation across CAISO/WECC service areas (CA, NV) | Native fallback to `name` / `name:en` |

---

## 3. Work Breakdown Packages

### Package 1: Type System & Core Registry Registration
- **Target Files**: `src/i18n/types.ts`, `src/i18n/index.ts`
- **Tasks**:
  - Extend the `SupportedLocale` type union: `'en' | 'es' | 'fr' | 'de' | 'zh' | 'pt' | 'ru' | 'ja' | 'ar' | 'ko' | 'it' | 'hi' | 'nv' | 'vi' | 'tl'`.
  - Add metadata definitions to `SUPPORTED_LOCALES` array (code, English label, native label, text direction `ltr`).
  - Import new locale dictionaries and register them in `dictionaries` map in `src/i18n/index.ts`.

### Package 2: Locale Dictionaries Creation (100% Key Parity)
- **Target Files**:
  - `src/i18n/locales/ko.ts` (Korean)
  - `src/i18n/locales/it.ts` (Italian)
  - `src/i18n/locales/hi.ts` (Hindi)
  - `src/i18n/locales/nv.ts` (Navajo / Diné Bizaad)
  - `src/i18n/locales/vi.ts` (Vietnamese)
  - `src/i18n/locales/tl.ts` (Tagalog)
- **Key Categories to Populate (matching `src/i18n/locales/en.ts` exactly)**:
  1. `menu.*` — File, Edit, View, Add, Measure, Open With, Settings, Diagnostics
  2. `tabs.*`, `panel.*`, `geocoder.*` — Search placeholders, reset layers, tab headers
  3. `basemap.*` — Styles (Light, Dark, Street, Topo, Hydro, Aerial), 3D Terrain, 3D Buildings, Hillshade
  4. `groups.*` — 12 layer group titles
  5. `layer.*` — 43+ layer titles, action button tooltips, download, source link, filter
  6. `weather.*` — 9 weather variables
  7. `mode.*`, `colorby.*`, `year.*` — Display modes, color-by attributes, year filter playback
  8. `measure.*` — Distance measurement readout
  9. `mydata.*`, `csv.*` — My Data tabs, feature counts, CSV column mapper dialog
  10. `popup.*` — Field headers, project statuses, facility types, table headers, footers
  11. `disclaimer.*`, `tribal.*`, `stale.*` — First-visit disclaimer, Tribal context dialog, feed staleness dialogs
  12. `disclaimer.governing` — Legal Governing Language Clause for all non-English locales:
      > *"This translation is provided for convenience only. In the event of any discrepancy, the English version shall govern."*

### Package 3: Basemap Labels & Font Rendering Validation
- **Target Files**: `assets/map.ts`, `assets/ui/ui-settings.ts`
- **Tasks**:
  - Verify that `setMapLabelLanguage` in `assets/map.ts` correctly applies the fallback chain:
    `['coalesce', ['get', 'name:' + locale], ['get', 'name:en'], ['get', 'name']]`.
  - Ensure Devanagari (Hindi), Hangul (Korean), and Navajo diacritics render smoothly in MapLibre GL glyph PBFs.

### Package 4: Automated Testing & Verification
- **Target Files**: `src/i18n/i18n.test.ts`, `assets/popup-format.test.ts`, `I18N_STATUS.md`
- **Tasks**:
  - Update `src/i18n/i18n.test.ts` to test all 15 locales for 100% key parity and non-empty values.
  - Verify that `npm run typecheck` passes with 0 errors.
  - Verify that `npm run lint` passes with 0 errors.
  - Verify that `npm test` runs all Vitest suites cleanly.
  - Verify that `npm run build` succeeds with a clean production bundle.
  - Update `I18N_STATUS.md` with the new 15-locale support status.

---

## 4. Invariants & Repo Rules (from `AGENTS.md`)
- Imports must use `.js` extension even though source is `.ts`.
- Zero external runtime dependencies.
- No AI authorship in git commits / PR messages.
- 100% dictionary key parity across all locales.
