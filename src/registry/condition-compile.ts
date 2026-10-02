// Compiles a declarative condition array — {field, op, value} triples read
// against a dataset's FIELD_SCHEMA entry — into a MapLibre filter expression
// for the map to evaluate.
//
// Pure data plus its compiler: no MapLibre import, no side effects, safe to
// import anywhere.
//
// Deps: src/registry/field-schema.ts (FIELD_SCHEMA, FieldOp).
// Consumed by: assets/filters.ts — compileBucketExpr() builds the legend-bucket
// values expression through toMapLibreFilter() for every field listed in
// BUCKET_FILTER_DATASETS, so the schema is checked on the live filter path.
// toMapLibreFilter throws on an invalid condition; a bucket value drifting out
// of its declared domain surfaces there, and the domains are covered by
// condition-compile.test.ts. compileBucketExpr catches that throw and falls
// back to the pre-schema builder rather than let it reach the map.

import { FIELD_SCHEMA, type FieldOp } from './field-schema.js';

export interface Condition {
  field: string;
  op: FieldOp;
  value?: unknown;   // an array for 'in'/'not_in'; absent for 'has'
}

// A MapLibre filter expression. Cast to FilterSpecification at the map seam.
export type FilterExpr = unknown[];

export type ConditionErrorReason =
  | 'unknown-dataset'
  | 'unknown-field'
  | 'unsupported-op'
  | 'value-out-of-domain';

export class ConditionError extends Error {
  constructor(
    readonly reason: ConditionErrorReason,
    readonly condition: Condition | null,
    message: string,
  ) {
    super(message);
    this.name = 'ConditionError';
  }
}

// Returns the first problem found, or null when every condition targets a
// declared field with an operator that field allows and, for a closed domain,
// values drawn from it.
export function validateConditions(dataset: string, conditions: Condition[]): ConditionError | null {
  const schema = FIELD_SCHEMA[dataset];
  if (!schema) {
    return new ConditionError('unknown-dataset', null, `no field schema for dataset "${dataset}"`);
  }
  for (const cond of conditions) {
    const def = schema[cond.field];
    if (!def) {
      return new ConditionError('unknown-field', cond, `"${cond.field}" is not a declared field of "${dataset}"`);
    }
    if (!def.ops.includes(cond.op)) {
      return new ConditionError('unsupported-op', cond, `"${cond.op}" is not available on "${dataset}.${cond.field}"`);
    }
    if (def.values && cond.op !== 'has') {
      const vals = Array.isArray(cond.value) ? cond.value : [cond.value];
      for (const v of vals) {
        if (!def.values.includes(v as string)) {
          return new ConditionError('value-out-of-domain', cond, `"${String(v)}" is outside the declared domain of "${dataset}.${cond.field}"`);
        }
      }
    }
  }
  return null;
}

function assertValid(dataset: string, conditions: Condition[]) {
  const err = validateConditions(dataset, conditions);
  if (err) throw err;
}

function conditionExpr(c: Condition): FilterExpr {
  const get = ['get', c.field];
  switch (c.op) {
    case '=':        return ['==', get, c.value];
    case 'in':       return ['in', get, ['literal', c.value]];
    case 'not_in':   return ['!', ['in', get, ['literal', c.value]]];
    case 'contains': return ['in', c.value, get];
    case 'has':      return ['has', c.field];
    default:         return [c.op, get, c.value];
  }
}

// The conjunction of every condition: one condition on its own, any other
// count wrapped in ['all', …].
export function toMapLibreFilter(dataset: string, conditions: Condition[]): FilterExpr {
  assertValid(dataset, conditions);
  const parts = conditions.map(conditionExpr);
  return parts.length === 1 ? parts[0] : ['all', ...parts];
}

