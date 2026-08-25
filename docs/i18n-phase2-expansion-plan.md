# Phase 2: Full UI Internationalization Expansion Plan

## 1. Scope & Objective

Expand TransmissionMap's internationalization (i18n) coverage across all high-value interactive UI elements, layer registry titles, feature popups, tools, and user disclaimers, complete with a legal governing-language clause for non-English locales.

---

## 2. Work Breakdown & Packages

### Package 1: Feature Popups Localization
- **Target Files**: `assets/popup-format.ts`, `assets/popup.ts`, `src/i18n/locales/*.ts`, `assets/popup-format.test.ts`
- **Scope**:
  - Localize all field label headers (e.g. *Operating Voltage*, *Capacity (MW)*, *Primary Fuel*, *Status*, *Owner / Operator*, *Line Placement*, *Interconnection Queue*, *Pipeline Diameter*, *Commodity*, *Depth*, *Fire Name*, *Contained*, *Smoke Level*, *Alert Severity*, *Effective / Expired Time*, *Critical Habitat ESA Status*).
  - Wrap label generation in `t(fieldKey)` with English fallback.
  - Keep entity proper names (e.g., station names, company names) intact.

### Package 2: Layer Registry Titles & Layer Panel
- **Target Files**: `src/types.ts`, `src/registry/*.ts`, `assets/ui/ui-layer-rows.ts`, `src/i18n/locales/*.ts`
- **Scope**:
  - Add optional `titleKey` and `subLabelKey` to `LayerDef` interface.
  - Add translation keys for layer titles and sub-labels across all 9 locale dictionaries.
  - Update `buildLayersPanel()` in `assets/ui/ui-layer-rows.ts` to render localized titles using `t(entry.titleKey, ...)` falling back to `entry.label`.
  - Subscribe `buildLayersPanel()` to `'lang:changed'` so the panel re-renders dynamically when language changes.

### Package 3: Measurement, Tools & Weather Variable Selector
- **Target Files**: `assets/measure.ts`, `assets/weather-live.ts`, `src/registry/conditions.ts`, `assets/ui/ui-mydata.ts`, `src/i18n/locales/*.ts`
- **Scope**:
  - Localize distance measurement readout strings in `assets/measure.ts` (*"Click map to place vertex"*, *"Double-click to finish"*, *"Total distance"*).
  - Localize Weather variable dropdown labels in `src/registry/conditions.ts` (*"Temperature & Wind"*, *"Wind Gust"*, *"Relative Humidity"*, *"Dew Point"*, *"Cloud Cover"*, *"Surface Pressure"*).
  - Localize My Data import instructions and CSV column mapper dialog prompts in `assets/ui/ui-mydata.ts`.

### Package 4: Disclaimers & Staleness Modals (with Governing Language Clause)
- **Target Files**: `index.html`, `src/i18n/locales/*.ts`, `assets/ui/ui.ts`
- **Scope**:
  - **First-Visit Disclaimer** (`#disclaimerDialog`): Annotate paragraphs and buttons with `data-i18n` attributes.
  - **Governing Language Clause**: Add a localized notice at the bottom of non-English disclaimers:
    > *"This translation is provided for convenience only. In the event of any discrepancy, the English version shall govern."*
  - **Tribal Layer Context Dialog** (`#tribalDisclaimerDialog`): Annotate paragraphs and button with `data-i18n` attributes.
  - **Feed Staleness Kill-Switch Modals** (`#wildfireStaleDialog`, `#nwsStaleDialog`): Annotate warning headers, body copy, and action buttons with `data-i18n` attributes.

### Package 5: Verification & Quality Gates
- **Checks**:
  - `npm run typecheck` (0 errors)
  - `npm run lint` (0 errors)
  - `npm test` (all Vitest suites passing)
  - `npm run build` (Vite production bundle build passing)

---

## 3. Implementation Invariants & Repo Rules
- Strict adherence to `AGENTS.md`: Every TypeScript import uses `.js` extension (e.g. `import { t } from '../../src/i18n/index.js'`).
- Zero external runtime dependencies.
- No AI authorship in commits.
- All 9 supported locales (`en`, `es`, `fr`, `de`, `zh`, `pt`, `ru`, `ja`, `ar`) must maintain 100% dictionary key parity.
