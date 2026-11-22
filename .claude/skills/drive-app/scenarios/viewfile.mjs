// .claude/skills/drive-app/scenarios/viewfile.mjs
// The `viewfile` scenario of drive.mjs (see SKILL.md); helpers come from ../harness.mjs.
import fs from 'node:fs';
import path from 'node:path';
import { OUT, CAM, check, open, settle, mod, st, shot, hashOf, paramsOf } from '../harness.mjs';

  // Save view… downloads a .tmview.json; opening it on a fresh default page
  // restores the identical view.
export default async function viewfile(ctx) {
    const { page, errors } = await open(ctx, CAM + '?lb=0');
    await mod(page, '/assets/visibility.ts', m => m.setLayerVisibility('railroads', true));
    await mod(page, '/assets/style-overrides.ts', m => m.setStyle('railroads', { color: '#ff00ff', size: 2 }));
    await mod(page, '/assets/url-state.ts', m => m.writeUrlState());
    await settle(page);
    const saved = await hashOf(page);
    await shot(page, 'viewfile-1-before-save');
    await page.click('#fileMenuBtn');
    await page.click('.menu-sub-btn:has-text("Save")');
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('[data-action=save-view]')]);
    const file = path.join(OUT, dl.suggestedFilename());
    await dl.saveAs(file);
    const json = JSON.parse(fs.readFileSync(file, 'utf8'));
    check('file is a v1 tmview', json.format === 'tmview' && json.v === 1, dl.suggestedFilename());
    await page.close();

    const fresh = await open(ctx);
    await shot(fresh.page, 'viewfile-2-fresh');
    await fresh.page.setInputFiles('#fileOpenInput', file);
    await settle(fresh.page);
    const opened = await hashOf(fresh.page);
    check('opened link equals saved link', paramsOf(opened) === paramsOf(saved), `${saved}  vs  ${opened}`);
    check('labels off after open', (await st(fresh.page, 'state.basemapLabels')) === false);
    await shot(fresh.page, 'viewfile-3-opened');
    check('no console errors', errors.length === 0 && fresh.errors.length === 0, [...errors, ...fresh.errors].join(' | '));
}
