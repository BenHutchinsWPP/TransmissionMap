Map of this folder; each file's header comment is the source of truth.

# assets/parquet

- **`assets/parquet/`** — `range-io.ts`: the shared range reader of `data/analysis/` (lazy chunks only; hyparquet + fzstd): `loadIndex` (`datasets` and/or `columns`; `unavailable` remembered), `openFile` (build_id checked), `readRange` (10 s per request, ≤ 6 in flight, 32 MiB LRU byte cache), `requestLog`, `groupsHolding`, `rowRuns`
