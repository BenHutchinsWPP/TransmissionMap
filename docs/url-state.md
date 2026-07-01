# URL State — the shareable map link

> *Read this if you're touching how the map link is built, or adding any new
> piece of state that should survive a page reload / be shareable. The one
> thing you must not skip: the **reserved-char rule** below — getting a param
> code wrong fails silently, with no error to tell you.*

The map serializes its whole view into the URL hash so a link reproduces it
exactly. Format:

```
#<zoom>/<lat>/<lng>?<param>=<val>&<param>=<val>…
```

e.g. `#5.20/39.8283/-98.5795?l=-SUB.WND&v=550+&bm=d`

Everything after `?` is a compact param string. State that equals the default
is **omitted** — a default view has a bare `#zoom/lat/lng` and no query.

Two files, split by side effects:

- **`assets/url-state-codec.ts`** — pure parse/format. No globals, no
  `location`/`history`. `parseUrlState(params)` → partial state object;
  `formatUrlState(state)` → array of `key=val` strings.
- **`assets/url-state.ts`** — side-effectful glue. `readUrlState()` reads the
  hash into `state`; `writeUrlState()` writes `state` back to the hash via
  `history.replaceState`. Subscribes to the `url:write` bus event — anything
  that changes shareable state emits `url:write` and the URL updates.

---

## The reserved-char rule (read before adding any param)

Every param is a **single char** (a few are two). They live in one flat
`URLSearchParams` namespace, so **a new code must not collide with an existing
one** — `params.get("l")` can only return one thing.

This bit us once: a PAD-US legend filter was given `groupCode: "l"`, the same
char as the layer-visibility param. `get("l")` returned the layer string, the
filter never saved or restored, silently. No error — just broken state.

### Currently taken

| Code | Meaning | Defined in |
|---|---|---|
| `l`  | layer visibility delta | codec, `formatUrlState` |
| `mw` | MW range | codec |
| `y`  | generator year filter | codec |
| `gm` | generator display mode (icons/heat/both) | codec, via `genModeCode` |
| `bm` | basemap | codec, `BM_*_CODE` maps |
| `pj` | projection (`g` = globe) | codec |
| `s`  | generator status filter | `filterGroupCode` in `registry/generators.ts` |
| `v f p h j t n r c e g u` | legend-filter `groupCode`s | `LEGEND_FILTERS` in `ui-legends.ts` |

Per-layer bucket filters use `filterGroupCode` (currently only `s`), read as a
top-level param the same way — so they share the same key namespace as
everything above.

Legend-filter `groupCode` assignments: `v`=voltage, `f`=fuel, `p`=pipeline,
`h`=crithab, `j`=padus, `t`=tribal, `n`=natgasLine, `r`=natgasPts, `c`=nerc,
`e`=retail, `g`=ogfStatus, `u`=substance (OSM pipeline commodity).

> **Pick a code in none of the rows above.** When you take one, add it here and
> to the table the same commit, or the next person re-collides.

Within a single param the **values** are also coded chars (e.g. basemap
`l/d/v/t/a`, gen mode `i/h/b`, each bucket's `urlCode`). Those share no
namespace with the param keys, so a bucket `urlCode: "l"` is fine — only the
top-level param keys must be globally unique.

---

## How each kind of state round-trips

| State | Param | Default that gets omitted |
|---|---|---|
| Layer on/off | `l` | layer at its `defaultOn` — only the **delta** is encoded (`-CODE` = forced off, `CODE` = forced on) |
| Legend filter | `groupCode` | all buckets active (or the filter's `defaultActive`) |
| Per-layer bucket filter | `filterGroupCode` | all buckets with `default !== false` |
| MW range | `mw` | `0-MW_SLIDER_MAX` |
| Year | `y` | filter disabled |
| Gen mode | `gm` | `icons` |
| Basemap | `bm` | `street` |
| Projection | `pj` | mercator |

The "omit the default" rule is what keeps links short. It also means **both
sides must agree on the default** — `formatUrlState` skips a value when it
equals the default, `parseUrlState` leaves state untouched when the param is
absent. If they disagree, a freshly-shared link drifts from what the sharer saw.

---

## Adding a new shareable param — checklist

```
[ ] Pick an unused key char (see reserved table above)
[ ] url-state-codec.ts: parse it in parseUrlState()  (params.get → state)
[ ] url-state-codec.ts: emit it in formatUrlState()  (state → key=val), skipping the default
[ ] url-state.ts: copy it in readUrlState() and writeUrlState() if it's a new state field
[ ] Emit 'url:write' wherever the value changes (usually assets/ui/ui-*.ts)
[ ] Add the char to the reserved table in this doc
```

Bucket/legend filters need none of the codec edits — they're data-driven from
`LEGEND_FILTERS` / `filterBuckets`. You only pick a `groupCode` and give each
bucket a `urlCode`; the codec loops over the registry. See
[adding-a-filter.md](adding-a-filter.md).
