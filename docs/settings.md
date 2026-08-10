# Settings — display-unit preferences

> *Read this if you're touching how the map formats temperature, wind speed,
> distance, area, elevation, or pressure — or adding a new display-unit
> dimension. The one thing you must not skip: a convertible ramp's legend
> label needs `RampDef.fmt`, not `unit`/`maxLabel` — those are static text,
> fixed at module load.*

The File ▸ Settings… dialog (`assets/ui/ui-settings.ts`) lets a user set each
unit dimension independently — temperature, wind speed, distance, area,
elevation, pressure. It's **per-dimension**, not a single US/Metric system
field: a user can hold mixed preferences (wind in mph while distances stay
metric), and the US/Metric buttons in the dialog are write-only shortcuts
that set all six dimensions at once, not a stored mode.

---

## Where prefs live

- **`src/units.ts`** — the preferences themselves, as ambient module state
  (`getUnits()`/`setUnits()`), plus the SI-in/display-string-out formatters
  (`fmtTemp`, `fmtSpeed`, `fmtDistance`, `fmtArea`, `fmtElevation`,
  `fmtElevationRange`, `fmtPressure`, `fmtDensity`, and the already-non-SI
  variants `fmtDistanceMi`/`fmtAreaAcres`/`fmtAreaSqFt`), raw converters, and
  `unitLabel`/`UNIT_OPTIONS`. It's a leaf module — imports nothing — which is
  what keeps it safe to import from `src/registry/` and `src/colors/` without
  creating a cycle.
- **`assets/units-store.ts`** — `loadUnits()`/`saveUnits()`, the only code
  that touches `localStorage`. Kept separate from `src/units.ts` on purpose:
  the formatters stay importable from anywhere without dragging in a browser
  storage dependency.

Because formatters read ambient state rather than taking a prefs argument,
any test that exercises them must reset it: call `setUnits(DEFAULT_UNITS)` in
`beforeEach` so one test's preference doesn't leak into the next.

---

## Persistence

Preferences persist to `localStorage` under key `tm-units`, validated against
`UNIT_OPTIONS` on load — an unrecognized or stale value for a dimension is
dropped rather than applied. Unit preferences are **not** part of the URL
hash (see [url-state.md](url-state.md)): a shared map link carries the view,
layers, and filters, but not the sender's units.

---

## Adding a new unit dimension — checklist

```
[ ] src/units.ts        — add the dimension to UnitPrefs, DEFAULT_UNITS, and UNIT_OPTIONS
[ ] src/units.ts        — add its raw converter (convX) and formatter (fmtX)
[ ] Route every display call site for that quantity through the new fmtX
[ ] Any RampDef whose `unit` is now convertible must switch to `fmt` — the
    static `unit`/`maxLabel` fields are read once at import time and hold
    whatever the preference was then. A ramp whose unit never converts
    (kWh/kWp, mW/m², g, %) is right to keep `unit`/`maxLabel`.
```

`fmt: (v, mark?) => string` renders **both** ends of the bar, which is the
point: a ramp states its unit once, so the two ends cannot drift apart. The
legend passes `mark = "+"` for the top end only, to mark the clamp. Build the
mark into the string between the number and the unit suffix rather than
splicing it into the finished result — the suffix trails the number, so
there is no safe way to append afterwards, and any pattern-match over the
numeric run breaks under a locale whose `toLocaleString()` groups digits with
a non-breaking space. `fmtTemp`, `fmtSpeed` and `fmtPressure` take `mark`
because they are used as a `fmt`; give any new one the same parameter.

`minLabel` still wins at the bottom end, for ramps where a bare `0` reads
better than `0.0 mph` — the unit is already on the other end.

A ramp constant is not always in display units — check before wrapping one in
a converter. `src/registry/regions.ts`'s population-density ramp stores its
stops log10(1+x)-transformed (baked into the tile data), so its `fmt` first
inverts the transform to recover the real people-per-km² value, and rounds to
the nearest thousand *after* converting, because `POP_LOG_MAX` is itself an
approximate clamp:

```ts
fmt: (v, mark = "") =>
  `${(Math.round(convDensity(10 ** v - 1) / 1000) * 1000).toLocaleString()}${mark} ${densityLabel()}`,
```

Passing `POP_LOG_MAX` straight into `convDensity()` would convert the
exponent, not the density.

---

## The re-render contract

Every change calls `setUnits()` → `saveUnits()` → `emit('units:changed')`.
`assets/ui/ui.ts` holds the **single** subscriber, which rebuilds legends
(picking up new `fmt` output) and settles `#featureInfo`. It's a single
subscriber because `#featureInfo` is written by both `assets/measure.ts` and
`assets/user-data/user-data-geom.ts` — two subscribers each trying to
reformat the same node would race. Having one owner also lets it pick per
case: an active measurement repaints via `updateMeasureReadout()`, since
`state.measure.points` is enough to recompute it; a My Data feature's
length/area is cleared, because `showFeatureInfo(geom)` takes its geometry as
a parameter and no module retains a copy. An open popup is dismissed rather than
reformatted, since its HTML was baked with the old units at render time and
there's no stored feature to redraw from. Accepted staleness: a parked hover
cursor keeps showing its previous reading until the next `mousemove`.

---

## Checklist (changing an existing unit's behavior)

```
[ ] src/units.ts        — edit the converter/formatter for the dimension
[ ] Any RampDef in that unit — confirm it uses fmt, not unit/maxLabel
[ ] npm test          — assets/ui/ui-legends.test.ts covers the label paths
[ ] npm run typecheck
[ ] npm test            — if you touched a formatter with a *.test.ts sibling
```

---

## `WEATHER_VARIABLES[].format` and `RampDef.fmt` stay separate

`src/registry/conditions.ts` gives each weather variable both a `format` (the
hover readout, `raster-probes.ts`) and a `ramp` that may carry `fmt` (the
legend ends). For temperature, wind and pressure these are the same function
reference, which looks like duplication worth collapsing. It isn't: Humidity
and Cloud Cover have a `format` but their ramps deliberately have no `fmt`,
because 0–100% is a hard bound rather than a clamp and `fmt` would render the
top end as `100%+`. Keep both fields.
