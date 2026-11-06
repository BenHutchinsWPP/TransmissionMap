// ─── Vega-Lite spec: the page's check, and the rows a chat chart is drawn from ─
// Role: a model's Vega-Lite chart (the `chart` object of runAnalysis in
//       agent/tools.ts) before it goes to the canvas frame,
//       which runs Vega (public/canvas.html, never the page) and checks again.
//         validateVegaLite(v)   plain JSON only (own keys, no functions or
//                               symbols, no __proto__/constructor/prototype
//                               key), ≤ MAX_SPEC_BYTES serialised, depth ≤
//                               MAX_DEPTH; no data/datasets/url/href/element/
//                               usermeta key anywhere, no object-valued
//                               `format`; `$schema` absent or vega-lite v5/v6.
//                               Refusals say what to fix, so a model can retry.
//         rowsFromValue(v)      a runAnalysis value as rows: an array of flat
//                               objects (primitive values), ≤ MAX_ROWS; else null.
//         vegaWithData(spec, rows)  the spec with the rows (already ≤ MAX_ROWS:
//                               rowsFromValue) as its top-level data.values.
//         vegaTitle(spec)       the spec's own title, if a string (clipped).
//         rowsCsv(rows, title, layers)  the rows as CSV: a UTF-8 BOM, the title
//                               as a note row and the layers' credit (toCsv
//                               guards formula cells), as chart-spec.ts chartCsv.
//       Pure: no Vega import. Session only. Loaded with the chat chunk
//       (agent/tools.ts).
//
// Deps: dataset-query.ts (Outcome; type only), registry (layerById),
//       user-data-export.ts (toCsv).

import type { Outcome } from './dataset-query.js';
import { layerById } from '../src/registry/index.js';
import { toCsv } from './user-data/user-data-export.js';

export const MAX_SPEC_BYTES = 20 * 1024;
export const MAX_DEPTH = 16;
export const MAX_ROWS = 5_000;
const MAX_TITLE = 120;
const FORBIDDEN = new Set(['data', 'datasets', 'url', 'href', 'element', 'usermeta']);
const UNSAFE = new Set(['__proto__', 'constructor', 'prototype']);
const SCHEMA = /^https:\/\/vega\.github\.io\/schema\/vega-lite\/v[56](\.\d+){0,2}\.json$/;

export type Row = Record<string, string | number | boolean | null>;
const fail = <T = never>(reason: string): Outcome<T> => ({ ok: false, reason });
const isPlain = (v: object) => { const p = Object.getPrototypeOf(v); return p === Object.prototype || p === null; };

/** Why a value inside the spec is not plain JSON / is not allowed, or null. */
function walk(v: unknown, path: string, depth: number): string | null {
  if (depth > MAX_DEPTH) return `the spec nests deeper than ${MAX_DEPTH} levels`;
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? null : `${path} must be a finite number`;
  if (typeof v !== 'object') return `${path} must be JSON (no ${typeof v})`;
  if (Object.getOwnPropertySymbols(v).length) return `${path} must be JSON (no symbols)`;
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) { const e = walk(v[i], `${path}[${i}]`, depth + 1); if (e) return e; }
    return null;
  }
  if (!isPlain(v)) return `${path} must be a plain object`;
  for (const k of Object.getOwnPropertyNames(v)) {
    const at = path ? `${path}.${k}` : k;
    if (UNSAFE.has(k)) return `"${k}" is not allowed (in ${path || 'the spec'})`;
    if (FORBIDDEN.has(k)) {
      return k === 'data' || k === 'datasets'
        ? `remove "${at}": send no data — the page adds the call's rows as data.values`
        : `remove "${at}": a chart may not use "${k}"`;
    }
    const val = (v as Record<string, unknown>)[k];
    if (k === 'format' && val && typeof val === 'object') return `"${at}" must be a format string such as ",.0f"`;
    const e = walk(val, at, depth + 1);
    if (e) return e;
  }
  return null;
}

/** Check a Vega-Lite spec from a model; see the header. */
export function validateVegaLite(v: unknown): Outcome<Record<string, unknown>> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return fail('a Vega-Lite chart must be an object (a spec without data)');
  const e = walk(v, '', 1);
  if (e) return fail(e);
  const s = v as Record<string, unknown>;
  if (s.$schema !== undefined && !(typeof s.$schema === 'string' && SCHEMA.test(s.$schema))) {
    return fail('"$schema" must be a vega-lite v5 or v6 schema URL, or left out');
  }
  if (new TextEncoder().encode(JSON.stringify(s)).length > MAX_SPEC_BYTES) return fail(`the spec is over ${MAX_SPEC_BYTES / 1024} KB: simplify it`);
  return { ok: true, result: s };
}

const isPrimitive = (x: unknown) => x === null || typeof x === 'string' || typeof x === 'boolean' || (typeof x === 'number' && Number.isFinite(x));

/** A runAnalysis value as rows, or null when it is not an array of ≤ MAX_ROWS flat objects. */
export function rowsFromValue(v: unknown): Row[] | null {
  if (!Array.isArray(v) || v.length > MAX_ROWS) return null;
  for (const r of v) {
    if (!r || typeof r !== 'object' || Array.isArray(r) || !isPlain(r)) return null;
    if (Object.keys(r).some(k => UNSAFE.has(k)) || !Object.values(r).every(isPrimitive)) return null;
  }
  return v as Row[];
}

/** The spec with the rows as its top-level data. */
export function vegaWithData(spec: Record<string, unknown>, rows: readonly Row[]): Record<string, unknown> {
  return { ...spec, data: { values: rows } };
}

/** The spec's title when it is a non-empty string, clipped; else undefined. */
export function vegaTitle(spec: Record<string, unknown>): string | undefined {
  const t = typeof spec.title === 'string' ? spec.title.trim() : '';
  return t ? (t.length > MAX_TITLE ? t.slice(0, MAX_TITLE - 1) + '…' : t) : undefined;
}

/** The rows as CSV (with a BOM for Excel), the title as a note and the layers' credit. */
export function rowsCsv(rows: readonly Row[], title: string, layers: readonly string[]): string {
  const fields = [...new Set(rows.flatMap(r => Object.keys(r)))];
  const credit = layers.map(l => layerById(l)?.data?.credit).filter(Boolean).join('; ');
  return '﻿' + toCsv(rows, fields, credit || undefined, [title]);
}
