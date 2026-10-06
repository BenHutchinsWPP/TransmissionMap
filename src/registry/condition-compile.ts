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
// validateConditions() is also the trust-boundary check for a view's `where`
// (view-validate.ts's validateWhere(), reached from share links and setWhere).

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
  | 'malformed-condition'
  | 'unknown-field'
  | 'unsupported-op'
  | 'value-type'
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

const isRecord = (x: unknown): x is Record<string, unknown> =>
  !!x && typeof x === 'object' && !Array.isArray(x);
const isScalar = (x: unknown) =>
  typeof x === 'string' || typeof x === 'boolean' || (typeof x === 'number' && Number.isFinite(x));
const LIST_OPS = new Set(['in', 'not_in']);

// Shape of one untrusted condition: exactly field/op/value, and a value that
// is a literal (a list of literals for in/not_in; none for has), never an
// expression.
function shapeError(c: unknown): string | null {
  if (!isRecord(c)) return 'a condition must be an object';
  for (const k of Object.keys(c)) {
    if (k !== 'field' && k !== 'op' && k !== 'value') return `unknown condition key "${k}"`;
  }
  if (typeof c.field !== 'string' || typeof c.op !== 'string') return 'a condition needs a string field and op';
  if (c.op === 'has') return Object.hasOwn(c, 'value') ? '"has" takes no value' : null;
  const ok = LIST_OPS.has(c.op)
    ? Array.isArray(c.value) && c.value.every(isScalar)
    : isScalar(c.value);
  return ok ? null : `bad value for "${c.op}"`;
}

// Returns the first problem found, or null when every condition is a literal
// {field, op, value} that targets a declared field with an operator that field
// allows, values of the field's type and, for a closed domain, values drawn
// from it. Never throws: the input may be untrusted (a share link).
export function validateConditions(dataset: string, conditions: unknown): ConditionError | null {
  if (!Object.hasOwn(FIELD_SCHEMA, dataset)) {
    return new ConditionError('unknown-dataset', null, `no field schema for dataset "${dataset}"`);
  }
  if (!Array.isArray(conditions)) {
    return new ConditionError('malformed-condition', null, 'conditions must be a list');
  }
  const schema = FIELD_SCHEMA[dataset];
  for (const raw of conditions) {
    const shape = shapeError(raw);
    if (shape) return new ConditionError('malformed-condition', null, shape);
    const cond = raw as Condition;
    if (!Object.hasOwn(schema, cond.field)) {
      return new ConditionError('unknown-field', cond, `"${cond.field}" is not a declared field of "${dataset}"`);
    }
    const def = schema[cond.field];
    if (!def.ops.includes(cond.op)) {
      return new ConditionError('unsupported-op', cond, `"${cond.op}" is not available on "${dataset}.${cond.field}"`);
    }
    if (cond.op === 'has') continue;
    const vals: unknown[] = LIST_OPS.has(cond.op) ? cond.value as unknown[] : [cond.value];
    for (const v of vals) {
      if (typeof v !== def.type) {
        return new ConditionError('value-type', cond, `${JSON.stringify(v)} is not a ${def.type}, the type of "${dataset}.${cond.field}"`);
      }
      if (def.values && !def.values.includes(v as string)) {
        return new ConditionError('value-out-of-domain', cond, `"${String(v)}" is outside the declared domain of "${dataset}.${cond.field}"`);
      }
    }
  }
  return null;
}

function assertValid(dataset: string, conditions: Condition[]) {
  const err = validateConditions(dataset, conditions);
  if (err) throw err;
}

function conditionExpr(dataset: string, c: Condition): FilterExpr {
  // A number field may be stored as a string in tiles; to-number reads either.
  const raw = ['get', c.field];
  const get = FIELD_SCHEMA[dataset][c.field].type === 'number' ? ['to-number', raw] : raw;
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
  const parts = conditions.map(c => conditionExpr(dataset, c));
  return parts.length === 1 ? parts[0] : ['all', ...parts];
}

