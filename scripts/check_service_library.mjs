#!/usr/bin/env node
// Re-probes every entry of src/registry/service-library.json and writes docs/library-hosts.md (the table and the whole-host vetted hosts list).
// Per kind: ArcGIS layer metadata / MapServer export / ImageServer exportImage, WMS GetCapabilities
// (the layer must be listed), an XYZ tile, a GeoJSON head, or (PMTiles) a range read plus an OPTIONS
// preflight asking for the `range` header. Each probe sends `Origin: https://example.org` and the
// response must allow it (Access-Control-Allow-Origin `*` or that origin).
// Usage: node scripts/check_service_library.mjs [--prune]   (--prune drops failing entries from the JSON)
// Exit status 1 when any entry fails. No dependencies.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderLibraryHosts } from './library_hosts_doc.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const LIB = ROOT + 'src/registry/service-library.json';
const OUT = ROOT + 'docs/library-hosts.md';
const ORIGIN = 'https://example.org';
const TIMEOUT_MS = 30000;
const WORLD = '-20037508,-20037508,20037508,20037508';
const US = '-13100000,3900000,-12900000,4100000';

async function get(url, init = {}) {
  const headers = { Origin: ORIGIN, ...(init.headers ?? {}) };
  return fetch(url, { ...init, headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
}
const corsOk = r => { const a = r.headers.get('access-control-allow-origin'); return a === '*' || a === ORIGIN; };
const isImage = r => /^image\//i.test(r.headers.get('content-type') ?? '');

/** Returns { ok, cors, note } for one entry. */
async function probe(e) {
  const k = e.kind;
  let r, note = '';
  if (k === 'arcgis-feature') {
    r = await get(`${e.url}/${e.layer}?f=json`);
    const j = await r.json().catch(() => ({}));
    note = j.error ? 'service error ' + (j.error.code ?? '') : j.type === 'Feature Layer' || j.geometryType ? '' : 'not a feature layer';
  } else if (k === 'arcgis-export') {
    r = await get(`${e.url}/export?bbox=${US}&bboxSR=3857&imageSR=3857&size=256,256&format=png32&transparent=true&f=image&layers=show:${e.layer}`);
    if (!isImage(r)) note = 'no image returned';
  } else if (k === 'arcgis-image') {
    r = await get(`${e.url}/exportImage?bbox=${US}&bboxSR=3857&imageSR=3857&size=256,256&format=png&f=image`);
    if (!isImage(r)) note = 'no image returned';
  } else if (k === 'wms') {
    const v = e.version ?? '1.3.0';
    r = await get(`${e.url}?SERVICE=WMS&REQUEST=GetCapabilities&VERSION=${v}`);
    const t = await r.text();
    if (!/<(WMS_Capabilities|WMT_MS_Capabilities)/.test(t)) note = 'no capabilities';
    else if (!e.layer.split(',').every(l => t.includes(`<Name>${l}</Name>`))) note = 'layer not listed';
  } else if (k === 'xyz') {
    const u = e.url.replace('{z}', '5').replace('{x}', '7').replace('{y}', '12');
    r = await get(u);
    if (!isImage(r)) note = 'no image returned';
  } else if (k === 'geojson') {
    r = await get(e.url);
    const t = await r.text();
    if (!/^\s*\{/.test(t) || !t.includes('"features"')) note = 'not GeoJSON';
  } else if (k === 'pmtiles-raster') {
    r = await get(e.url, { headers: { Range: 'bytes=0-16383' } });
    const b = Buffer.from(await r.arrayBuffer());
    if (r.status !== 206 || b.subarray(0, 7).toString() !== 'PMTiles') note = 'range read failed';
    else {
      const p = await get(e.url, { method: 'OPTIONS', headers: { 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'range' } });
      const h = (p.headers.get('access-control-allow-headers') ?? '').toLowerCase();
      if (!(p.ok && corsOk(p) && (h.includes('range') || h === '*'))) note = 'preflight rejects range';
    }
  }
  const httpOk = r.ok || r.status === 206;
  const cors = corsOk(r);
  const ok = httpOk && !note && cors;
  if (!httpOk) note = `HTTP ${r.status}`;
  else if (!cors && !note) note = 'no CORS for a foreign origin';
  return { ok, cors, note };
}

async function check(e) {
  for (let attempt = 0; ; attempt++) {
    try { return await probe(e); }
    catch (err) { if (attempt) return { ok: false, cors: false, note: String(err.cause?.code ?? err.name ?? err) }; }
  }
}

const lib = JSON.parse(readFileSync(LIB, 'utf8'));
const results = new Array(lib.length);
let next = 0;
await Promise.all(Array.from({ length: 4 }, async () => {
  while (next < lib.length) { const i = next++; results[i] = await check(lib[i]); }
}));

const today = new Date().toISOString().slice(0, 10);
const hosts = JSON.parse(readFileSync(ROOT + 'src/registry/service-hosts.json', 'utf8'));
writeFileSync(OUT, renderLibraryHosts({ lib, results, hosts, today, origin: ORIGIN }));

const failed = lib.filter((_, i) => !results[i].ok);
for (const e of failed) console.log(`FAIL ${e.id} (${e.host}): ${results[lib.indexOf(e)].note}`);
console.log(`${lib.length - failed.length}/${lib.length} entries ok; wrote docs/library-hosts.md`);
if (process.argv.includes('--prune') && failed.length)
  writeFileSync(LIB, JSON.stringify(lib.filter((_, i) => results[i].ok), null, 1) + '\n');
process.exit(failed.length ? 1 : 0);
