// Boot-order guard: no module directly reads (outside a function body), at load
// time, a const/let/class binding
// owned by another module in the same import cycle. In a browser such a read
// throws (TDZ) whenever the reader's body runs first — which depends on which
// cycle member the dev server loads first — while the vitest module runner
// hands back a partial exports object and reads `undefined`, so an import
// test cannot see it. This walks every assets/ and src/ module with the
// TypeScript parser instead: import graph → cycles (Tarjan SCC) → module-level
// identifier reads (function bodies skipped) resolved through re-exports to
// their owning module. A function declaration is hoisted, so it is safe.
import { describe, it, expect } from 'vitest';
import ts from 'typescript';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

type Ref = { from: string; name: string };
interface Mod {
  sf: ts.SourceFile;
  deps: Set<string>;
  imports: Map<string, Ref>;                  // local name → (module, exported name | '*')
  locals: Map<string, 'fn' | 'value'>;        // module-level declarations
  exports: Map<string, Ref | { local: string }>;
  stars: string[];
}

function resolveSpec(file: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null;
  const p = resolve(dirname(file), spec).replace(/\.js$/, '.ts');
  return existsSync(p) ? p : null;
}

const hasMod = (n: ts.Node, k: ts.SyntaxKind) =>
  ts.canHaveModifiers(n) && !!ts.getModifiers(n)?.some(m => m.kind === k);

function parse(file: string): Mod {
  const sf = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const m: Mod = { sf, deps: new Set(), imports: new Map(), locals: new Map(), exports: new Map(), stars: [] };
  const declare = (name: string, kind: 'fn' | 'value', exported: boolean, as = name) => {
    m.locals.set(name, kind);
    if (exported) m.exports.set(as, { local: name });
  };
  for (const s of sf.statements) {
    const exported = hasMod(s, ts.SyntaxKind.ExportKeyword);
    const isDefault = hasMod(s, ts.SyntaxKind.DefaultKeyword);
    if (ts.isImportDeclaration(s)) {
      if (s.importClause?.isTypeOnly) continue;
      const from = resolveSpec(file, (s.moduleSpecifier as ts.StringLiteral).text);
      if (!from) continue;
      m.deps.add(from);
      const c = s.importClause;
      if (c?.name) m.imports.set(c.name.text, { from, name: 'default' });
      const b = c?.namedBindings;
      if (b && ts.isNamespaceImport(b)) m.imports.set(b.name.text, { from, name: '*' });
      if (b && ts.isNamedImports(b)) for (const e of b.elements) {
        if (!e.isTypeOnly) m.imports.set(e.name.text, { from, name: (e.propertyName ?? e.name).text });
      }
    } else if (ts.isExportDeclaration(s)) {
      if (s.isTypeOnly) continue;
      const from = s.moduleSpecifier ? resolveSpec(file, (s.moduleSpecifier as ts.StringLiteral).text) : null;
      if (s.moduleSpecifier && !from) continue;
      if (from) m.deps.add(from);
      if (!s.exportClause) { if (from) m.stars.push(from); continue; }
      if (!ts.isNamedExports(s.exportClause)) continue;
      for (const e of s.exportClause.elements) {
        if (e.isTypeOnly) continue;
        const name = (e.propertyName ?? e.name).text;
        m.exports.set(e.name.text, from ? { from, name } : { local: name });
      }
    } else if (ts.isFunctionDeclaration(s) && s.name) {
      declare(s.name.text, 'fn', exported, isDefault ? 'default' : s.name.text);
    } else if ((ts.isClassDeclaration(s) || ts.isEnumDeclaration(s)) && s.name) {
      declare(s.name.text, 'value', exported, isDefault ? 'default' : s.name.text);
    } else if (ts.isVariableStatement(s)) {
      for (const d of s.declarationList.declarations) {
        if (ts.isIdentifier(d.name)) declare(d.name.text, 'value', exported);
      }
    }
  }
  return m;
}

const files = ['assets', 'src'].flatMap(dir =>
  readdirSync(resolve(ROOT, dir), { recursive: true, encoding: 'utf8' })
    .filter(f => f.endsWith('.ts') && !f.endsWith('.test.ts') && !f.endsWith('.d.ts'))
    .map(f => resolve(ROOT, dir, f)));
const mods = new Map(files.map(f => [f, parse(f)]));

// Owner module and kind of an exported binding, following re-exports.
function owner(file: string, name: string, seen = new Set<string>()): { file: string; kind: 'fn' | 'value' } | null {
  const m = mods.get(file);
  const key = file + '#' + name;
  if (!m || seen.has(key)) return null;
  seen.add(key);
  const e = m.exports.get(name);
  if (e && 'from' in e) return owner(e.from, e.name, seen);
  if (e) {
    const imp = m.imports.get(e.local);
    if (imp) return owner(imp.from, imp.name, seen);
    const kind = m.locals.get(e.local);
    return kind ? { file, kind } : null;
  }
  for (const s of m.stars) { const r = owner(s, name, seen); if (r) return r; }
  return null;
}

// Tarjan: module → id of its strongly connected component.
const scc = new Map<string, number>();
const sccSize = new Map<number, number>();
{
  let index = 0;
  const idx = new Map<string, number>(), low = new Map<string, number>(), stack: string[] = [], on = new Set<string>();
  const visit = (v: string) => {
    idx.set(v, index); low.set(v, index); index++; stack.push(v); on.add(v);
    for (const w of mods.get(v)!.deps) {
      if (!idx.has(w)) { visit(w); low.set(v, Math.min(low.get(v)!, low.get(w)!)); }
      else if (on.has(w)) low.set(v, Math.min(low.get(v)!, idx.get(w)!));
    }
    if (low.get(v) === idx.get(v)) {
      let w: string, n = 0;
      do { w = stack.pop()!; on.delete(w); scc.set(w, idx.get(v)!); n++; } while (w !== v);
      sccSize.set(idx.get(v)!, n);
    }
  };
  for (const f of mods.keys()) if (!idx.has(f)) visit(f);
}

function loadTimeCycleReads(): string[] {
  const out: string[] = [];
  const rel = (f: string) => relative(ROOT, f);
  for (const [file, m] of mods) {
    const id = scc.get(file)!;
    if (sccSize.get(id)! < 2) continue;
    const report = (node: ts.Node, ref: Ref, name: string) => {
      const o = owner(ref.from, ref.name);
      if (!o || o.kind !== 'value' || scc.get(o.file) !== id) return;
      const line = m.sf.getLineAndCharacterOfPosition(node.getStart()).line + 1;
      out.push(`${rel(file)}:${line} reads ${name} (owned by ${rel(o.file)})`);
    };
    const walk = (node: ts.Node): void => {
      if (ts.isFunctionLike(node) || ts.isTypeNode(node) || ts.isInterfaceDeclaration(node) ||
          ts.isTypeAliasDeclaration(node) || ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return;
      if (ts.isPropertyDeclaration(node) && !hasMod(node, ts.SyntaxKind.StaticKeyword)) return;
      if (ts.isIdentifier(node)) {
        const p = node.parent;
        if ((ts.isPropertyAccessExpression(p) || ts.isPropertyAssignment(p) || ts.isQualifiedName(p)) &&
            (p as { name?: ts.Node }).name === node) return;
        const imp = m.imports.get(node.text);
        if (!imp) return;
        if (imp.name !== '*') report(node, imp, node.text);
        else if (ts.isPropertyAccessExpression(p) && p.expression === node) {
          report(node, { from: imp.from, name: p.name.text }, `${node.text}.${p.name.text}`);
        }
        return;
      }
      ts.forEachChild(node, walk);
    };
    for (const s of m.sf.statements) walk(s);
  }
  return out.sort();
}

describe('boot order', () => {
  it('finds the layer-init / filters / nws-zone-join cycle (the scan sees cycles)', () => {
    const f = (p: string) => resolve(ROOT, p);
    expect(scc.get(f('assets/nws-zone-join.ts'))).toBe(scc.get(f('assets/layers/layer-init.ts')));
  });

  it('no module reads a cycle partner\'s const/let/class binding at load time', () => {
    expect(loadTimeCycleReads()).toEqual([]);
  });
});
