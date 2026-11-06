# Proximity check (Tools ▸ Proximity)

The Proximity check takes a CSV of points and tells you which of them lie within a
distance threshold of another point. It runs entirely in the visitor's browser: the
file is read, grouped and listed on the page, and the file is not sent anywhere.

Contributor notes (code layout, tests, benchmarks, checklist) are in
[`internal/proximity-notes.md`](internal/proximity-notes.md).

## What it does

- **Groups.** Two points are *within* the threshold when the distance between them is
  at most the threshold (inclusive). A **group** is a set of points linked together by
  that relation, transitively: A near B and B near C puts A, B and C in one group, even
  when A and C are far apart. Points with no neighbour within the threshold are not in a
  group. Groups are numbered 1, 2, … in the order of their lowest CSV row.
- **Pairs.** Every pair within the threshold, listed once (a < b), with its distance.
  Pairs are enumerated only when the Pairs view is opened or its CSV is downloaded, never
  as part of the grouping pass.
- **Nearest distance.** For each grouped point, the distance to its nearest other point
  that may pair with it (a different id), when that is within the threshold.
- **Same-ID points never pair.** The picker has an optional ID column. Two points whose
  (trimmed, non-empty) IDs are equal are never a pair, for example several buses at one
  substation. They can still share a group through other points: A(id 1) – B(id 2) –
  C(id 1) is one group.

## The measure

Distances are the **WGS84 ellipsoid geodesic**, the length that geopy's `geodesic`
reports. `assets/proximity/geodesic.ts` is a pure port of Karney's inverse-geodesic
distance (GeographicLib's JavaScript `Geodesic.js`, MIT/X11). It converges for every
pair, antipodal included, and has no dependency. A sphere of radius `EARTH_KM` is used
only as a fast filter: a candidate pair is decided by the exact geodesic, and the
sphere bounds (`SPHERE_RATIO_MIN` / `SPHERE_RATIO_MAX`) say how far the two can
differ.

Bubbles are circles of radius threshold/2 around each grouped point, exact at the point to
within 0.7 %; two bubbles touch when their points are a pair.

## Units and range

The threshold is typed in one of **ft, mi, m or km** (`UNITS` in `ui-proximity.ts`).
The value is converted to km once, at the input (`UNIT_KM`); the core takes km only.
The threshold must lie in **0.01–1,000 km**; outside that range the tool refuses. The
distance columns and the "nearest" column show the threshold's unit.

## Limits

| Limit | Value | Where |
|---|---|---|
| CSV file size | 50 MB, refused before it is read | `MAX_FILE_BYTES` in `ui-proximity.ts` |
| Points | 100,000 rows, refused before the column dialog | `MAX_POINTS` in `ui-proximity.ts` |
| Pairs kept | 1,000,000 (`MAX_PAIRS`); enumeration stops there | `proximity.ts` |
| Pairs CSV | refused above an estimated 200 MB (UTF-8 bytes); the refusal gives the estimate | `MAX_CSV_BYTES` in `proximity/pairs-csv.ts` |
| CSV build | chunks of 10,000 rows, built in a worker as a `Blob`, with progress and Cancel; one download at a time | `CSV_CHUNK`, `csv-worker.ts` |
| Sample | HIFLD substations in the current view, at most 15,000; above, "zoom in"; none, "no substations in view" | `SAMPLE_CAP` in `proximity/sample.ts` |

When the pair list is truncated, the Pairs view and the pairs CSV say so and give the
group and point counts. The truncated list is the pairs found first in cell order: it is
not the global top N and not the nearest pairs. A point with invalid coordinates
(non-finite, |lat| > 90, |lon| > 180) is counted in `skipped` and is in no group.

## The table pane

The results open in the bottom drawer's Proximity tab. Closing it releases the file and cancels any pairs run. The pane has two views:

- **Groups**: only points in a group, ordered by group, then nearest distance, then CSV
  row. A row click selects the row and outlines its point and its group on the map; the camera
  does not move. The row's ↗ "Zoom to this point" button (Tab to it, Enter) is the only control
  that flies the map to its point. A tap on a point on the map brings this pane forward and marks its row.
- **Pairs**: every pair, with the progress line and Cancel. A row click marks the pair row and
  outlines point a; ↗ flies to point a.

Each column header has a ▲/▼ sort button (asc, then desc, then off) above a filter box. A filter
is a case-insensitive "contains" match on the cell's shown text or on its raw value (so `1234`
finds `1,234`); all filters must match. Sort and filter are kept across a threshold or unit change and reset on a
new file or sample. A sort or filter over more than 100,000 rows shows a busy status while it
runs, and **Clear filters** appears while any filter is set. On Pairs over a truncated list, the
view says that sort and filter cover only the pairs kept. Enter on a selected range does nothing.

A dragged cell range copies on Ctrl/Cmd+C as TSV with a header line (raw values, formula-guarded,
the same as the table drawer's copy), and the status confirms the copy. Nothing from the range is
stored or put in the URL.

### The two CSVs

Both are built by `toCsv` (`assets/user-data/user-data-export.ts`), which guards against
formula injection. Each CSV is the full result in the order below: the grid's sort and filter
do not change them. Each row carries the CSV's own row number and its latitude and
longitude, because the picker drops those columns from the file's properties.

- **Groups CSV**, `<file>-proximity-groups.csv`: `row`, `latitude`, `longitude`, then every
  column of the file (by its title), then `group`, `group_size`, `nearest_<unit>`.
- **Pairs CSV**, `<file>-proximity-pairs.csv`: `group`, `a_row`, `b_row`, `a_id`, `b_id`,
  `a_name`, `b_name`, `distance_<unit>`, `a_latitude`, `a_longitude`, `b_latitude`,
  `b_longitude`, then every file column for point a (`a_<title>`) and then for point b
  (`b_<title>`). A truncated list adds a note row after the last data row.

The picker is `pickCsvPoints` in `assets/user-data/user-data-csv.ts`, the same parser My
Data uses for CSV import, with its own labels ("Choose columns", "Check proximity"). It
does not import the file into My Data.

## The map

The points and their bubbles are drawn on the map from the first result and removed when the tab closes or Reset runs. Bubbles are hidden past the zoom where the largest one would be cut at tile edges; the points stay. Each new result replaces them, and the first result of a file fits the map to it. A tap on a point marks its row; no feature popup opens.

## Privacy

- The file never leaves the tab: it is not sent to any server, the chat or the link. There
  is no network request for it.
- Flying to a point (only the row's ↗ button) moves the camera, so
  the position goes in the link (4 decimals, about 11 m) like any camera move, and the
  basemap, aerial and terrain tiles are fetched for where the visitor looks.
- No value from the file goes into `localStorage`, `sessionStorage`, the URL, `tm-drawer`,
  a session snapshot or an undo step.
- No value from the file goes into `recordDiagEvent`, an error text, the console or a
  worker reason.
- Closing the tab drops every reference to the file and cancels any pairs, CSV or sample run.

## Try a sample

The tab's **Try a sample** button loads the HIFLD substations (the static copy) inside the current
map view and checks them like a file. At most 15,000 points: above that the tab says how many are in
view and asks for a closer zoom; at zero it says none are in view. The threshold becomes 1 mi. Names come
from the substation `name` and ids from `hifld_id`; `max_kv` and `kv_range` are the extra columns. The tab shows
"HIFLD substations (static copy) in the current view" and the HIFLD credit under the
legend. It is session only, like a file: nothing is stored or put in the link, closing the tab drops it and
Cancel stops the download.
