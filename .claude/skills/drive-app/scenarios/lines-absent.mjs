// .claude/skills/drive-app/scenarios/lines-absent.mjs
// The `lines-absent` scenario of drive.mjs (see SKILL.md); helpers come from ../harness.mjs.
import { PREVIEW, CAM, check, open, st, hashFor, shot, lineRig, pickLine, tapAt, tableCopyShown } from '../harness.mjs';

  // The production-hide rule: a host without data/analysis/ (index.json 404, with the
  // CORS header the real host sends on a 404) shows no Length row, Copy or Line tools in
  // the popup and no "Copy N checked lines" in the table, asks for index.json once and
  // logs nothing but the browser's own 404 line. Dev: data/analysis/ answered 404 by
  // context.route. Preview: TM_DATA_HOST a stand-in that has no data/analysis/.
export default async function linesAbsent(ctx) {
    const OSM = 'osm-transmission-lines';
    const rig = await lineRig(ctx, { viewport: { width: 1400, height: 1000 } }, async c => {
      if (!PREVIEW) await c.route(/\/data\/analysis\//, r => r.fulfill({ status: 404, body: '404: Not Found', headers: { 'access-control-allow-origin': '*' } }));
    });
    if (!rig) return;
    const { page, O } = rig;
    await rig.go(CAM);
    const layers = { ...(await st(O, 'state.layerVisibility')), [OSM]: true };
    await rig.go(await hashFor(O, { layerVisibility: layers }, '9.5/39.70/-104.85'));
    const osm = await pickLine(O, OSM);
    check('an OSM line to click', !!osm);
    if (!osm) { await rig.close(); return; }
    const popupState = () => page.evaluate(() => {
      const p = document.querySelector('.maplibregl-popup');
      const slot = p?.querySelector('.popup-line-length');
      return p && { text: p.textContent.slice(0, 80), length: !!slot && !slot.hidden, copy: !!p.querySelector('.popup-copy-btn'), tools: !!p.querySelector('.popup-line-tools-btn') };
    });
    for (const n of [1, 2]) {
      await tapAt(page, osm);
      await page.waitForSelector('.maplibregl-popup', { timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(3000);   // time for a lookup to answer, were there one
      const s = await popupState();
      check(`popup ${n}: open, with no Length row, Copy or Line tools`, !!s && !s.length && !s.copy && !s.tools, JSON.stringify(s));
      if (n === 1) await shot(page, 'lines-absent-1-popup');
      await page.keyboard.press('Escape');
      await page.evaluate(() => document.querySelector('.maplibregl-popup-close-button')?.click());
      await page.waitForTimeout(300);
    }
    check('table: no "Copy N checked lines" on OSM lines', !(await tableCopyShown(page, OSM, false)));
    await shot(page, 'lines-absent-2-table');
    const idx = rig.reads.filter(([u]) => /index\.json$/.test(u));
    check('index.json asked for once (the 404 is remembered) and answered 404; no other line file asked for',
      idx.length === 1 && idx[0][1] === 404 && rig.reads.length === 1, rig.reads.map(r => r.join(' ')).join(' , '));
    const csp = await page.evaluate(() => window.__csp ?? []);
    check('no CSP violation', csp.length === 0, csp.join(' | '));
    const loud = rig.errors.filter(e => !/status of 404/.test(e));
    check('nothing errors loudly (only the browser\'s own 404 line for index.json)', loud.length === 0 && rig.errors.length <= 1, rig.errors.join(' | '));
    await rig.close();
}
