Map of this folder; each file's header comment is the source of truth.

# assets/columns

- **`assets/columns/`** — `columns-read.ts`: the columns files' reader (lazy chunk, imported only by `dataset-query.ts`): `columnsEntry`, `pruneGroups` (row groups by statistics and the footer's region codes), `readGroups`/`readRowsAt`/`readTwoPhase` (each row group's wanted chunks fetched in runs split at gaps over `RANGE_GAP`, decoded columns kept in an LRU of `DECODED_CACHE_BYTES`), `plannedBytes`; `columns-decode.ts` — the pure decode of one column chunk (`groupRange`, `decodeColumn`, `expand`), run by `columns-worker.ts` (a module worker; any worker failure or a reply over `REPLY_TIMEOUT_MS` decodes inline for the session); `columns-data.test.ts` is the data test (`TM_COLUMNS_DATA=1`, skipped otherwise); `docs/pipeline.md` § *Columns files*
