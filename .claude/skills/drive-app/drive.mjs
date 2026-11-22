// .claude/skills/drive-app/drive.mjs
//
// CLI for driving TransmissionMap headless with named
// scenarios. See SKILL.md. The shared helpers live in harness.mjs and each scenario in
// scenarios/<name>.mjs. Copy this file, harness.mjs, scenarios/ and fixtures/ into the session
// scratchpad and run it from there (`node drive.mjs <scenario>`), so `playwright-core` resolves
// from the scratchpad's node_modules, never the repo's.
//
// Env: TM_URL (default http://localhost:5199/, or http://localhost:4173/ with
// --preview), TM_WORK (screenshots and downloads; default ./shots), TM_CHROME
// (Chromium binary; default the newest cached Playwright Chromium); for the line
// scenarios on a preview build, TM_DATA_HOST (the stand-in data host) and TM_DEV_URL
// (the dev-server twin, default http://localhost:5199/).
import { OUT, log, check, launch, failures } from './harness.mjs';
export * from './harness.mjs';
import labels from './scenarios/labels.mjs';
import vx from './scenarios/vx.mjs';
import notice from './scenarios/notice.mjs';
import viewfile from './scenarios/viewfile.mjs';
import weather from './scenarios/weather.mjs';
import area from './scenarios/area.mjs';
import table from './scenarios/table.mjs';
import chat from './scenarios/chat.mjs';
import csp from './scenarios/csp.mjs';
import chart from './scenarios/chart.mjs';
import vega from './scenarios/vega.mjs';
import canvas from './scenarios/canvas.mjs';
import sandbox from './scenarios/sandbox.mjs';
import restore from './scenarios/restore.mjs';
import templates from './scenarios/templates.mjs';
import columns from './scenarios/columns.mjs';
import route from './scenarios/route.mjs';
import lines from './scenarios/lines.mjs';
import linesAbsent from './scenarios/lines-absent.mjs';
import proximity from './scenarios/proximity.mjs';
import drawer from './scenarios/drawer.mjs';
import legends from './scenarios/legends.mjs';
import stale from './scenarios/stale.mjs';

const SCENARIOS = {
  labels: labels,
  vx: vx,
  notice: notice,
  viewfile: viewfile,
  weather: weather,
  area: area,
  table: table,
  chat: chat,
  csp: csp,
  chart: chart,
  vega: vega,
  canvas: canvas,
  sandbox: sandbox,
  restore: restore,
  templates: templates,
  columns: columns,
  route: route,
  lines: lines,
  'lines-absent': linesAbsent,
  proximity: proximity,
  drawer: drawer,
  legends: legends,
  stale: stale,
};

// Scenarios that need a production build; `all` leaves them out.
const PREVIEW_ONLY = new Set(['csp', 'route']);
// The reference scenarios write dump sets for byte comparison; `all` leaves them out too.
const REFERENCE = new Set(['drawer', 'legends', 'stale']);

// ── CLI ─────────────────────────────────────────────────────────────────────

if (import.meta.url === `file://${process.argv[1]}`) {
  const names = process.argv.slice(2).filter(a => a !== '--preview' && !a.startsWith('--dump='));
  const run = names.length === 0 || names[0] === 'all' ? Object.keys(SCENARIOS).filter(n => !PREVIEW_ONLY.has(n) && !REFERENCE.has(n)) : names;
  const unknown = run.filter(n => !SCENARIOS[n]);
  if (unknown.length) {
    console.error(`unknown scenario: ${unknown.join(', ')}. Known: ${Object.keys(SCENARIOS).join(', ')}, all`);
    process.exit(2);
  }
  const { browser, context } = await launch();
  try {
    for (const n of run) {
      log(`\n── ${n}`);
      try { await SCENARIOS[n](context); }
      catch (e) { check(`${n} ran to its end`, false, String(e?.message ?? e).split('\n')[0]); }
    }
  } finally {
    await browser.close();
  }
  log(`\n${failures ? `${failures} check(s) FAILED` : 'all checks passed'} · screenshots in ${OUT}`);
  process.exit(failures ? 1 : 0);
}
