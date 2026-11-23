// ─── Outcome: the answer shape of the dataset and route calls ────────────────
// Role: the two types a refusable call answers with. `Refusal` is why a call
//       was refused (`code` names the one refusal a caller acts on), and
//       `Outcome<T>` is either `{ok: true, result}` or a `Refusal` with
//       `ok: false`. Types only; no runtime code.
//       Defined here so the callers below can type their results without
//       importing dataset-query.ts (and the query code it pulls in).
// Deps: none.
// Consumers: assets/query/dataset-query.ts (defines query, count, aggregate, shapeRows
//       and describe over these types); type-only imports from assets/agent,
//       assets/route, assets/ui, assets/services, assets/proximity,
//       assets/templates, assets/sandbox, assets/map-api, assets/dev-console,
//       assets/query/spatial-join, assets/chart-spec, assets/vega-spec and
//       src/registry/view-validate.ts.

/** Why a call was refused; `code` names the one refusal a caller acts on. */
export type Refusal = { reason: string; code?: 'area-unreachable' };
export type Outcome<T> = { ok: true; result: T } | ({ ok: false } & Refusal);
