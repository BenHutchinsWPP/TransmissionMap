Map of this folder; each file's header comment is the source of truth.

- `ui-proximity.ts` — the Proximity tab's panel (lazy chunk; registers its own Tabulator modules): CSV picker, threshold in ft/mi/m/km, Groups and Pairs grids, both CSVs; `docs/proximity.md`
- `proximity-map.ts` — the Proximity tool's map half (lazy chunk): `px-` sources and layers, fit once per file, row click selects (`onRow`), ↗ flies (`onFly`), tap → focus
