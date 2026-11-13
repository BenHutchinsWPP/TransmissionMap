// Compiles a declarative condition array — {field, op, value} triples read
// against a dataset's FIELD_SCHEMA entry — into a MapLibre filter expression
// for the map to evaluate.
//
// Region fields (FieldDef.list) hold `|code|code|` lists: `contains v` matches
// the exact code (`|v|` inside the list, so USA1 never matches USA10) and
// `contains_any` any of up to MAX_LIST_VALUES codes; `none` also matches a
// feature without the key.
//
// A range op on a text field (dc_moratoriums last_event, ISO dates) compares
// text of the value's own length (fixed-width text orders as it reads), so,
// like every number test, it never matches a feature without a value.
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
// (view-validate.ts's validateWhere(), reached from share links and setWhere);
// its per-value valueError() also checks a view's Area filter codes
// (view-validate.ts's validateArea()). assets/dataset-query.ts compiles a
// query's `where` through toMapLibreFilter(); assets/ui/ui-area.ts reads
// MAX_LIST_VALUES.

import { FIELD_SCHEMA, type FieldDef, type FieldOp } from './field-schema.js';

export interface Condition {
  field: string;
  op: FieldOp;
  value?: unknown;   // an array for 'in'/'not_in'/'contains_any'; absent for 'has'
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
const LIST_OPS = new Set(['in', 'not_in', 'contains_any']);
const CODE_OPS = new Set(['contains', 'contains_any']);
export const MAX_LIST_VALUES = 100;

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
  if (!ok) return `bad value for "${c.op}"`;
  if (c.op === 'contains_any' && ((c.value as unknown[]).length < 1 || (c.value as unknown[]).length > MAX_LIST_VALUES)) {
    return `"contains_any" takes 1–${MAX_LIST_VALUES} values`;
  }
  return null;
}

/** One untrusted value against a field def: its type, then its closed domain
 *  or pattern. Null when it fits. Also checks an Area filter's codes
 *  (view-validate.ts's validateArea()). */
export function valueError(def: FieldDef, v: unknown): 'value-type' | 'value-out-of-domain' | null {
  if (typeof v !== def.type) return 'value-type';
  if ((def.values && !def.values.includes(v as string)) || (def.pattern && !def.pattern.test(v as string))) {
    return 'value-out-of-domain';
  }
  return null;
}

// Returns the first problem found, or null when every condition is a literal
// {field, op, value} that targets a declared field with an operator that field
// allows, values of the field's type and, for a closed domain, values drawn
// from it (or matching its pattern). Never throws: the input may be untrusted (a share link).
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
    if (!def.ops.includes(cond.op) || CODE_OPS.has(cond.op) !== !!def.list) {
      return new ConditionError('unsupported-op', cond, `"${cond.op}" is not available on "${dataset}.${cond.field}"`);
    }
    if (cond.op === 'has') continue;
    const vals: unknown[] = LIST_OPS.has(cond.op) ? cond.value as unknown[] : [cond.value];
    for (const v of vals) {
      const bad = valueError(def, v);
      if (bad) {
        return new ConditionError(bad, cond, bad === 'value-type'
          ? `${JSON.stringify(v)} is not a ${def.type}, the type of "${dataset}.${cond.field}"`
          : `"${String(v)}" is outside the declared domain of "${dataset}.${cond.field}"`);
      }
    }
  }
  return null;
}

function assertValid(dataset: string, conditions: Condition[]) {
  const err = validateConditions(dataset, conditions);
  if (err) throw err;
}

// One exact code in a `|…|` list. to-string reads an absent key as "" (false,
// with no console warning); `none` also matches the absent key.
function codeExpr(field: string, code: string): FilterExpr {
  const test = ['in', `|${code}|`, ['to-string', ['get', field]]];
  return code === 'none' ? ['any', ['!', ['has', field]], test] : test;
}

function conditionExpr(dataset: string, c: Condition): FilterExpr {
  // A number field may be stored as a string in tiles; to-number reads either.
  // It also reads a missing, null or '' value as 0, so a number test first
  // asks for a value (to-string reads all three as ''); != and not_in still
  // match a feature without one. A kV of 0 or less is the data's "unknown"
  // (OSM writes -1), so a kV test asks for a value above 0.
  const raw = ['get', c.field];
  const def = FIELD_SCHEMA[dataset][c.field];
  const num = def.type === 'number';
  const get = num ? ['to-number', raw] : raw;
  const valued = (e: FilterExpr): FilterExpr => !num ? e
    : def.unit === 'kV' ? ['all', ['!=', ['to-string', raw], ''], ['>', get, 0], e]
    : ['all', ['!=', ['to-string', raw], ''], e];
  switch (c.op) {
    case '=':        return valued(['==', get, c.value]);
    case '!=':       return ['!=', get, c.value];
    case 'in':       return valued(['in', get, ['literal', c.value]]);
    case 'not_in':   return ['!', ['in', get, ['literal', c.value]]];
    case 'contains': return codeExpr(c.field, c.value as string);
    case 'contains_any': return ['any', ...(c.value as string[]).map(v => codeExpr(c.field, v))];
    case 'has':      return ['has', c.field];
    // A text range (ISO dates) compares text of the value's own length, so it never matches a feature without one.
    default:         return num ? valued([c.op, get, c.value])
      : ['all', ['==', ['length', ['to-string', raw]], (c.value as string).length], [c.op, ['to-string', raw], c.value]];
  }
}

// The conjunction of every condition: one condition on its own, any other
// count wrapped in ['all', …].
export function toMapLibreFilter(dataset: string, conditions: Condition[]): FilterExpr {
  assertValid(dataset, conditions);
  const parts = conditions.map(c => conditionExpr(dataset, c));
  return parts.length === 1 ? parts[0] : ['all', ...parts];
}

