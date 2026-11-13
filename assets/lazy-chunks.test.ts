// Lazy-chunk guard: the boot bundle (the static, value-import graph from
// src/main.ts) never reaches the Parquet readers. hyparquet, fzstd and the
// modules that import them load only through dynamic import(), so they stay
// out of the first paint. Type-only imports and dynamic import() are not edges.
import { describe, it, expect } from 'vitest';
import ts from 'typescript';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const ENTRY = resolve(ROOT, 'src/main.ts');
const FORBIDDEN_FILES = [
  'assets/columns/columns-read.ts',
  'assets/columns/columns-decode.ts',
  'assets/columns/columns-worker.ts',
  'assets/parquet/range-io.ts',
  'assets/lines/line-read.ts',
].map(f => resolve(ROOT, f));
const FORBIDDEN_PKGS = ['hyparquet', 'fzstd'];

const isForbiddenPkg = (spec: string) => FORBIDDEN_PKGS.some(p => spec === p || spec.startsWith(p + '/'));

function staticSpecs(file: string): string[] {
  const sf = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const out: string[] = [];
  for (const s of sf.statements) {
    if (ts.isImportDeclaration(s)) {
      const c = s.importClause;
      if (c?.isTypeOnly) continue;
      const b = c?.namedBindings;
      if (c && !c.name && b && ts.isNamedImports(b) && b.elements.length > 0 && b.elements.every(e => e.isTypeOnly)) continue;
      out.push((s.moduleSpecifier as ts.StringLiteral).text);
    } else if (ts.isExportDeclaration(s) && s.moduleSpecifier && !s.isTypeOnly) {
      out.push((s.moduleSpecifier as ts.StringLiteral).text);
    }
  }
  return out;
}

function bootViolations(): string[] {
  const rel = (f: string) => relative(ROOT, f);
  const parent = new Map<string, string | null>([[ENTRY, null]]);
  const chain = (f: string, last: string) => {
    const path = [last];
    for (let c: string | null | undefined = f; c; c = parent.get(c)) path.unshift(rel(c));
    return path.join(' -> ');
  };
  const out: string[] = [];
  const queue = [ENTRY];
  while (queue.length) {
    const f = queue.shift()!;
    for (const spec of staticSpecs(f)) {
      if (isForbiddenPkg(spec)) { out.push(chain(f, spec)); continue; }
      if (!spec.startsWith('.')) continue;
      const p = resolve(dirname(f), spec).replace(/\.js$/, '.ts');
      if (!p.endsWith('.ts') || !existsSync(p)) continue;
      if (FORBIDDEN_FILES.includes(p)) { out.push(chain(f, rel(p))); continue; }
      if (parent.has(p)) continue;
      parent.set(p, f);
      queue.push(p);
    }
  }
  return out;
}

describe('lazy chunks', () => {
  it('the boot import graph never reaches the Parquet readers', () => {
    expect(bootViolations()).toEqual([]);
  });
});
