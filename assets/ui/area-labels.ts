// ─── Area labels: the lazy name table behind the Area filter ─────────────────
// Region names ("Texas", "Harris County, TX", "Bavaria — Germany") live in the
// generated src/registry/region-labels.json (~90 KB gzip), which only this
// module imports, through one memoised dynamic import(), so it stays its own
// chunk. Labels are display-only: the filter itself runs on codes
// (area-filter.ts), so nothing waits on them.
//   loadAreaLabels()   the table, or null when the chunk fails to load (first
//                      offline open, a stale deploy). A failure is recorded
//                      in the diagnostics log and the next call retries.
//   areaLabelsNow()    the table if already loaded, else null (no load).
//   areaLabel()        one code's display name; the code itself without a table.
// Reads the seven kind keys only (the file's `_generated` header is skipped).
// Deps: src/registry/area-filter.ts (AREA_KINDS, AreaKind), diag-log.ts.
// Consumed by: panel-mirror.ts (the chips), ui-area.ts (the typeahead),
//              ui-table.ts (the drawer's Area pill).

import { AREA_KINDS, type AreaKind } from '../../src/registry/area-filter.js';
import { recordDiagEvent } from '../diag-log.js';

/** Kind → code → label; admin-1 labels are [name, country code]. */
export type AreaLabels = Record<AreaKind, Record<string, string | [string, string]>>;

let labels: AreaLabels | null = null;
let loading: Promise<AreaLabels | null> | null = null;

export function loadAreaLabels(): Promise<AreaLabels | null> {
  return loading ??= import('../../src/registry/region-labels.json')
    .then(m => {
      const raw = m.default as unknown as Record<string, AreaLabels[AreaKind] | undefined>;
      labels = Object.fromEntries(AREA_KINDS.map(k => [k, raw[k] ?? {}])) as AreaLabels;
      return labels;
    })
    .catch(err => {
      loading = null;
      recordDiagEvent('layer', `area labels chunk: ${err}`);
      return null;
    });
}

export const areaLabelsNow = (): AreaLabels | null => labels;

/** The display name of one code: admin-1 as "Bavaria — Germany". */
export function areaLabel(table: AreaLabels | null, kind: AreaKind, code: string): string {
  const v = table && Object.hasOwn(table[kind], code) ? table[kind][code] : undefined;
  if (v === undefined) return code;
  if (typeof v === 'string') return v;
  const [name, iso3] = v;
  const country = Object.hasOwn(table!.countries, iso3) ? table!.countries[iso3] : iso3;
  return `${name} — ${typeof country === 'string' ? country : iso3}`;
}
