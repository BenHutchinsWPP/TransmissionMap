Map of this folder; each file's header comment is the source of truth.

# assets/utils

- **`assets/utils/`** — pure utilities
  - `utils.ts` string helpers, `csvCell` (the one CSV cell: RFC 4180 quoting, formula guard) and `isGzipUrl` (a data URL's `.gz`, before any `?v=`); zero imports, worker-safe; `utils-dom.ts` DOM helpers, incl. the `h`/`ht`/`hx` element builders; `utils-uid.ts` UID generation
