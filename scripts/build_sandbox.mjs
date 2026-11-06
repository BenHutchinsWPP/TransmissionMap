#!/usr/bin/env node
// Builds the two sandboxed frame documents:
// - public/sandbox.html, the analysis sandbox's document: one inline script
//   (the geo kit's source as a string, then assets/sandbox/runner.js) and a meta
//   Content Security Policy that admits exactly that script by its sha256.
//   The geo kit is assets/sandbox/geo-kit.ts with its types erased by the repo's
//   own TypeScript (a devDependency; nothing new) and its `export`s dropped, so
//   its functions are plain globals inside the analysis worker.
// - public/canvas.html, the visible canvas's document: assets/sandbox/canvas-runner.js
//   inline (its LIBS placeholder filled with the pinned library URLs and SRI
//   hashes of src/registry/template-libs.json) under a meta CSP that admits inline code, eval, the three CDNs,
//   Google Fonts and the tile hosts in src/registry/canvas-hosts.json. It
//   carries no hash or nonce: either would switch 'unsafe-inline' off.
//   The frame protocol is in canvas-runner.js's header and in the file's comment.
// Usage: node scripts/build_sandbox.mjs          (writes both files)
//        node scripts/build_sandbox.mjs --check  (exit 1 when either file is stale
//                                                 or template-libs.json is malformed)
// assets/sandbox/sandbox.test.ts and canvas.test.ts hold the committed files to
// generate() / generateCanvas().
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import ts from 'typescript';

const ROOT = path.join(import.meta.dirname, '..') + '/';
export const OUT = ROOT + 'public/sandbox.html';

/** geo-kit.ts → plain script: types erased, `export` dropped. Throws on anything else module-shaped. */
export function stripKit(src) {
  const js = ts.transpileModule(src, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, removeComments: true },
    reportDiagnostics: false,
  }).outputText.replace(/^export (?=(?:function|const|let) )/gm, '');
  if (/^\s*(?:import|export)\b/m.test(js)) throw new Error('build_sandbox: geo-kit.ts must have no imports and only `export function|const|let`');
  return js;
}

export const policy = hash => `default-src 'none'; script-src 'sha256-${hash}'; worker-src blob:`;

/** The sandbox document, from the two sources' text. */
export function generate(kitTs = readFileSync(ROOT + 'assets/sandbox/geo-kit.ts', 'utf8'),
  runnerJs = readFileSync(ROOT + 'assets/sandbox/runner.js', 'utf8')) {
  const script = `const GEO_KIT = ${JSON.stringify(stripKit(kitTs))};\n${runnerJs}`;
  if (/<\/script|<!--/i.test(script)) throw new Error('build_sandbox: the inline script may not contain "</script" or "<!--"');
  const hash = createHash('sha256').update(script, 'utf8').digest('base64');
  return '<!doctype html>\n<meta charset="utf-8">\n'
    + `<meta http-equiv="Content-Security-Policy" content="${policy(hash)}">\n`
    + '<title>Analysis sandbox</title>\n'
    + `<script>${script}</script>\n`;
}

export const CANVAS_OUT = ROOT + 'public/canvas.html';
export const CANVAS_CDNS = ['https://cdnjs.cloudflare.com', 'https://cdn.jsdelivr.net', 'https://unpkg.com'];

// The libraries the canvas may load, one table for the Vega path and for
// templates' TM.lib(name): src/registry/template-libs.json, package files on
// jsDelivr (not its on-the-fly minified or +esm copies), so the bytes never
// change. Re-hash after a version bump:
//   curl -sL <url> | openssl dgst -sha384 -binary | openssl base64 -A
export const LIBS_FILE = ROOT + 'src/registry/template-libs.json';
export const TEMPLATE_LIBS = JSON.parse(readFileSync(LIBS_FILE, 'utf8'));
const LIB_KINDS = ['script', 'module', 'style'];
const LIB_KEYS = 'integrity,kind,name,url,version';
const VEGA_LIBS = ['vega', 'vega-lite', 'vega-interpreter'];

/** The libs table as the runner gets it ({name: {url, integrity, kind}}); throws on a malformed table. */
export function libsTable(libs = TEMPLATE_LIBS) {
  if (!Array.isArray(libs)) throw new Error('build_sandbox: template-libs.json must be an array');
  const table = {};
  for (const lib of libs) {
    const where = `build_sandbox: template-libs.json entry ${JSON.stringify(lib && lib.name)}`;
    if (!lib || typeof lib !== 'object' || Object.keys(lib).sort().join() !== LIB_KEYS) throw new Error(`${where} must have exactly ${LIB_KEYS}`);
    const { name, version, kind, url, integrity } = lib;
    if (!/^[a-z0-9][a-z0-9.-]*$/.test(name) || Object.hasOwn(table, name)) throw new Error(`${where}: name must be unique, [a-z0-9.-]`);
    if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`${where}: version must be an exact x.y.z`);
    if (!LIB_KINDS.includes(kind)) throw new Error(`${where}: kind must be ${LIB_KINDS.join('|')}`);
    const re = new RegExp(`^https://cdn\\.jsdelivr\\.net/npm/(?:@[a-z0-9-]+/)?[a-z0-9.-]+@${version.replace(/\./g, '\\.')}/[A-Za-z0-9._/-]+\\.${kind === 'style' ? 'css' : 'js'}$`);
    if (!re.test(url) || url.includes('+esm')) throw new Error(`${where}: url must be a package file on jsDelivr at version ${version}`);
    if (!/^sha384-[A-Za-z0-9+/]{64}$/.test(integrity)) throw new Error(`${where}: integrity must be sha384-<base64>`);
    table[name] = { url, integrity, kind };
  }
  for (const name of VEGA_LIBS) if (!table[name]) throw new Error(`build_sandbox: template-libs.json must list ${name}`);
  return table;
}

export function canvasPolicy(hosts) {
  const cdns = CANVAS_CDNS.join(' ');
  const fetchable = [...CANVAS_CDNS, ...hosts].join(' ');
  return [
    "default-src 'none'",
    `script-src 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' blob: ${cdns}`,
    `worker-src blob: ${cdns}`,
    `style-src 'unsafe-inline' ${cdns} https://fonts.googleapis.com`,
    `font-src data: ${cdns} https://fonts.gstatic.com`,
    `img-src data: blob: ${fetchable}`,
    `connect-src ${fetchable}`,
    "media-src 'none'",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
}

const CANVAS_COMMENT = `<!--
  Canvas frame, generated by scripts/build_sandbox.mjs from
  assets/sandbox/canvas-runner.js; do not edit. Load it only in
  <iframe sandbox="allow-scripts">: elsewhere it stays inert.
  frame -> parent  {type:'ready'}
  parent -> frame  {type:'render', nonce (16-64 chars), kind:'html'|'vega', payload, inputs?, width?, height?}
                   (the first one only; then only {type:'png', nonce} on a vega frame)
  frame -> parent  {type:'rendered', nonce}
                   {type:'drawn', nonce}                 (html: TM.drawn(), once)
                   {type:'error', nonce, category:'syntax'|'runtime'|'csp'|'too-large'|'invalid-spec'|'unavailable'|'library'|'invalid-data', message?}
                   {type:'download', nonce, name, mime, data: string|ArrayBuffer}
                   {type:'action', nonce, kind:'select'|'fly'|'table'|'where', payload}   (html: TM.action)
  html pages also get TM.lib(name): the pinned libraries of src/registry/template-libs.json, with SRI.
  Everything a frame sends after an html write may come from the written page.
-->`;

/** The canvas document, from the runner's text, the tile hosts and the libs table. */
export function generateCanvas(runnerJs = readFileSync(ROOT + 'assets/sandbox/canvas-runner.js', 'utf8'),
  hosts = JSON.parse(readFileSync(ROOT + 'src/registry/canvas-hosts.json', 'utf8')), libs = TEMPLATE_LIBS) {
  const marker = '/*@LIBS@*/null';
  if (runnerJs.split(marker).length !== 2) throw new Error(`build_sandbox: canvas-runner.js must hold ${marker} exactly once`);
  const script = runnerJs.replace(marker, () => JSON.stringify(libsTable(libs)));
  if (/<\/script|<!--/i.test(script)) throw new Error('build_sandbox: the inline script may not contain "</script" or "<!--"');
  if (/[^\x00-\x7f]/.test(script)) throw new Error('build_sandbox: canvas-runner.js must be ASCII (the charset meta follows the CSP)');
  return '<!doctype html>\n<html lang="en">\n<head>\n'
    + `<meta http-equiv="Content-Security-Policy" content="${canvasPolicy(hosts)}">\n`
    + '<meta charset="utf-8">\n'
    + '<meta name="viewport" content="width=device-width, initial-scale=1">\n'
    + '<title>Canvas</title>\n'
    + '<style>html,body{margin:0;background:#fff;color:#1f2328;font:14px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif}</style>\n'
    + '</head>\n<body>\n'
    + CANVAS_COMMENT + '\n'
    + `<script>${script}</script>\n`
    + '</body>\n</html>\n';
}

if (import.meta.filename === process.argv[1]) {
  const files = [[OUT, generate()], [CANVAS_OUT, generateCanvas()]];
  for (const [file, html] of files) {
    const name = path.relative(ROOT, file);
    if (process.argv.includes('--check')) {
      let now = '';
      try { now = readFileSync(file, 'utf8'); } catch { /* missing: stale */ }
      if (now !== html) { console.error(`${name} is stale: run npm run build:sandbox`); process.exitCode = 1; }
    } else {
      writeFileSync(file, html);
      console.log(`wrote ${name}`);
    }
  }
}
