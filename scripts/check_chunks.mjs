// Chunk-closure report for the lazy panes: what opening each pane loads, and whether Tabulator is in it.
// Reads dist/.vite/manifest.json; build first with `npx vite build --manifest` (this script does not build).
// For each pane (the one manifest key under assets/ui/ ending in /<name>.ts) it walks the manifest's static `imports`, drops chunks already in
// the boot closure (the entry's static imports), and reports the rest with raw and gzip bytes; the boot
// chunks the pane also needs are listed apart. Tabulator is found by content, not by manifest `src`.
// Usage: node scripts/check_chunks.mjs [--json] [--assert-has-tabulator a,b] [--assert-no-tabulator a,b]
//   names are short: ui-table, ui-chat, ui-line, ui-grid-ops, ui-templates, ui-proximity, ui-route
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { join } from 'node:path';

// A class name only tabulator-tables' core writes (app code never names it); it survives minification.
const TABULATOR_NEEDLE = 'tabulator-placeholder-contents';
const PANES = ['ui-table', 'ui-chat', 'ui-line', 'ui-grid-ops', 'ui-templates', 'ui-proximity', 'ui-route'];

const argv = process.argv.slice(2);
const json = argv.includes('--json');
const listArg = flag => {
  const i = argv.indexOf(flag);
  if (i < 0) return [];
  const names = (argv[i + 1] ?? '').split(',').filter(Boolean);
  const bad = names.filter(n => !PANES.includes(n));
  if (names.length === 0 || bad.length) { console.error(`${flag}: unknown or missing entry ${bad.join(',')} (known: ${PANES.join(', ')})`); process.exit(2); }
  return names;
};
const wantHas = listArg('--assert-has-tabulator');
const wantNo = listArg('--assert-no-tabulator');

const dist = new URL('../dist/', import.meta.url).pathname;
let manifest;
try { manifest = JSON.parse(readFileSync(join(dist, '.vite/manifest.json'), 'utf8')); }
catch { console.error('no dist/.vite/manifest.json: run `npx vite build --manifest` first'); process.exit(2); }

const closure = (key, seen = new Set()) => {
  if (seen.has(key)) return seen;
  seen.add(key);
  for (const k of manifest[key]?.imports ?? []) closure(k, seen);
  return seen;
};
const files = keys => [...new Set([...keys].map(k => manifest[k].file))];
const entryKey = manifest['index.html'] ? 'index.html' : Object.keys(manifest).find(k => manifest[k].isEntry);
const bootFiles = new Set(files(closure(entryKey)));

const size = new Map();
const info = f => {
  if (!size.has(f)) {
    const buf = readFileSync(join(dist, f));
    size.set(f, { file: f, raw: buf.length, gzip: gzipSync(buf).length, tabulator: buf.includes(TABULATOR_NEEDLE) });
  }
  return size.get(f);
};
const sum = (list, k) => list.reduce((a, c) => a + c[k], 0);

const report = PANES.map(name => {
  const hits = Object.keys(manifest).filter(k => k.startsWith('assets/ui/') && k.endsWith(`/${name}.ts`));
  if (hits.length !== 1) { console.error(`${name}: expected exactly one manifest key under assets/ui/ ending in /${name}.ts, found ${hits.length}${hits.length ? ': ' + hits.join(', ') : ''}`); process.exit(2); }
  const key = hits[0];
  const all = files(closure(key)).map(info);
  const added = all.filter(c => !bootFiles.has(c.file));
  const boot = all.filter(c => bootFiles.has(c.file));
  return { entry: name, chunks: added, bootShared: boot.map(c => c.file),
    raw: sum(added, 'raw'), gzip: sum(added, 'gzip'),
    tabulator: added.some(c => c.tabulator), tabulatorIn: added.filter(c => c.tabulator).map(c => c.file) };
});

const failures = [];
for (const r of report) {
  if (wantHas.includes(r.entry) && !r.tabulator) failures.push(`${r.entry}: expected Tabulator in its open closure, found none`);
  if (wantNo.includes(r.entry) && r.tabulator) failures.push(`${r.entry}: Tabulator in its open closure (${r.tabulatorIn.join(', ')})`);
}

if (json) console.log(JSON.stringify({ needle: TABULATOR_NEEDLE, boot: [...bootFiles], report, failures }, null, 2));
else {
  console.log(`boot closure: ${bootFiles.size} chunks; Tabulator needle "${TABULATOR_NEEDLE}"`);
  for (const r of report) {
    console.log(`\n${r.entry}: +${r.chunks.length} chunks, ${r.raw} B raw, ${r.gzip} B gzip, Tabulator ${r.tabulator ? 'YES' : 'no'}`);
    for (const c of r.chunks) console.log(`  ${c.file}  ${c.raw} / ${c.gzip}${c.tabulator ? '  [tabulator]' : ''}`);
    if (r.bootShared.length) console.log(`  (${r.bootShared.length} more already in boot; --json lists them)`);
  }
  for (const f of failures) console.error(`FAIL: ${f}`);
  if (!failures.length && (wantHas.length || wantNo.length)) console.log('\nOK: assertions hold');
}
process.exit(failures.length ? 1 : 0);
