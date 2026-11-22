// A fixed EIA-930 hour for the drive-app `drawer` scenario: stands in for
// assets/grid-ops/eia930-read.ts (served in its place by context.route), so no
// PUDL request is made. Hour-ending epoch ms of 2026-11-20T09:00:00Z.
const HOUR = 3_600_000;
const LAST = Date.UTC(2026, 10, 20, 9);
const bas = new Map([
  ['ERCO', { load: 52000, gen: 54000, net: 2000, fuels: { gas: 30000, wind: 14000, solar: 3000, nuclear: 5000, coal: 2000 } }],
  ['CISO', { load: 28000, gen: 25000, net: -3000, fuels: { solar: 9000, gas: 9000, hydro: 3000, wind: 2000, nuclear: 2000 } }],
  ['PJM', { load: 98000, gen: 99000, net: 1000, fuels: { gas: 40000, nuclear: 32000, coal: 17000, wind: 4000, solar: 3000, hydro: 3000 } }],
  ['MISO', { load: 74000, gen: 73000, net: -1000, fuels: { gas: 25000, coal: 24000, wind: 14000, nuclear: 7000, solar: 3000 } }],
  ['SWPP', { load: 36000, gen: 37000, net: 1000, fuels: { wind: 20000, gas: 11000, coal: 5000, solar: 1000 } }],
]);
const pairs = [
  { ba: 'ERCO', adj: 'SWPP', mw: 800 }, { ba: 'SWPP', adj: 'ERCO', mw: -790 },
  { ba: 'MISO', adj: 'PJM', mw: -600 }, { ba: 'PJM', adj: 'MISO', mw: 610 },
  { ba: 'CISO', adj: 'ERCO', mw: 0 },
];
export async function hourRange() { return { ok: true, first: LAST - 48 * HOUR, last: LAST }; }
export async function readHour(at) { return { ok: true, hour: { at, bas, pairs } }; }
