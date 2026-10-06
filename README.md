# Data center moratoriums — tracked dataset

The working copy of the `data-moratoriums` orphan branch. That branch is only
ever appended to and never force-pushed, so its commit history records how US
data center moratoriums changed over time.

| File | What it is | Edited by |
|---|---|---|
| `moratoriums.csv` | Current state: one row per measure, sorted by `id` | `sync.py` |
| `events.csv` | Change log, appended to and never rewritten | `sync.py` |
| `dc_moratoriums.geojson` | The map file, one feature per jurisdiction, one feature per line | `build_layer.py` |

## Two kinds of time

- **When something happened** is `events.csv:event_date`, plus the
  `date_adopted`/`date_expires` columns: adoption, extension, expiry.
- **When we recorded it** is `events.csv:recorded_at`, and the git commit
  that wrote it.

A "new this week" feed filters on `recorded_at`. A timeline of how
moratoriums spread filters on `event_date`. Seeded events (`note=seed`)
carry the history already known on the first sync. Their `recorded_at` is
the seed day, so a feed of newly recorded changes should skip them.

## `events.csv`

| Column | Meaning |
|---|---|
| `recorded_at` | Sync date that detected the change |
| `id` | `moratoriums.csv` id |
| `event` | `proposed`, `adopted`, `banned`, `extended`, `expired`, `lifted`, `replaced`, `added` (newly tracked), `removed` (dropped from the source), `corrected` (a material field changed) |
| `event_date` | Real-world date, when known |
| `field` / `old` / `new` | The column that changed, for `corrected`/`extended`/status changes |
| `note` | `seed` for history found on the first sync |

Edits to `summary`, `source_urls`, `scope`, `verify`, `upstream_id` and
`last_verified` update the row but log no event.

## `moratoriums.csv`

`level` is one of `state`, `county`, `city`, `town`, `township`, `village`,
`tribal`, `utility`. It decides the map geometry:

- a state measure paints the state;
- a county measure paints the county;
- every other level is a point.

`status` is the status as reported. `build_layer.py` shows a past-due
`active`/`extended` row as expired, and never writes that back, so a quiet
week produces no commit. `verify=true` marks a row whose facts are not yet
confirmed against a primary source.

## Rebuild

```
python sync.py --as-of YYYY-MM-DD          # research CSVs → moratoriums.csv + events.csv
python build_layer.py --as-of YYYY-MM-DD   # → dc_moratoriums.geojson (needs geopandas)
```

## Attribution

Local measures come from **Moratorium Nation** (Michael Bommarito, Alea
Institute), <https://github.com/mjbommar/moratorium-data-2026>, licensed
CC BY 4.0, commit `dbaab04d84f8d679ba5a3d57bf45f32186109222` (2026-09-23).
TransmissionMap added and normalised rows, matched each to its county, moved
mislocated points to their Census place, and added measures found after that
date. Statewide measures come from the same source's state-bill table,
filtered to enacted measures that pause something.
