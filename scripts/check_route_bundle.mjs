// Bundle check for the route planner: after `npm run build`, a string literal that only
// assets/ui/ui-route.ts holds (an rp- map layer id) must sit in a lazy chunk and in no
// chunk the page loads at boot (the entry script and every modulepreload in dist/index.html).
// Usage: node scripts/check_route_bundle.mjs [needle]
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const needle = process.argv[2] ?? 'rp-alts-label';
const dist = new URL('../dist/', import.meta.url).pathname;
const html = readFileSync(join(dist, 'index.html'), 'utf8');
const boot = new Set(
  [...html.matchAll(/<script[^>]*type="module"[^>]*src="\/(assets\/[^"]+)"|<link[^>]*rel="modulepreload"[^>]*href="\/(assets\/[^"]+)"/g)]
    .map(m => m[1] ?? m[2]));
const chunks = readdirSync(join(dist, 'assets')).filter(f => f.endsWith('.js')).map(f => `assets/${f}`);
const holds = chunks.filter(f => readFileSync(join(dist, f), 'utf8').includes(needle));
const inBoot = holds.filter(f => boot.has(f));
const lazy = holds.filter(f => !boot.has(f));
console.log(`needle "${needle}": ${boot.size} boot chunks; found in ${holds.length}: ${holds.join(', ') || '(none)'}`);
if (lazy.length === 0) { console.error('FAIL: needle is in no lazy chunk (positive control)'); process.exit(1); }
if (inBoot.length > 0) { console.error(`FAIL: route code reaches the boot bundle: ${inBoot.join(', ')}`); process.exit(1); }
console.log('OK: route code is in a lazy chunk only');
