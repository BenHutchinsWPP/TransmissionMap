// .claude/skills/drive-app/scenarios/labels.mjs
// The `labels` scenario of drive.mjs (see SKILL.md); helpers come from ../harness.mjs.
import { CAM, check, open, st, shot, hashOf, reset } from '../harness.mjs';

  // A labels-off link boots without place names; Reset brings them back.
export default async function labels(ctx) {
    const { page, errors } = await open(ctx, CAM + '?lb=0');
    check('lb=0 sets labels off', (await st(page, 'state.basemapLabels')) === false);
    check('labels toggle unchecked', !(await page.isChecked('#basemapLabelsToggle')));
    await shot(page, 'labels-1-off');
    await reset(page);
    check('Reset turns labels on', (await st(page, 'state.basemapLabels')) === true);
    check('labels toggle checked', await page.isChecked('#basemapLabelsToggle'));
    check('link drops lb', !(await hashOf(page)).includes('lb='), await hashOf(page));
    await shot(page, 'labels-2-after-reset');
    check('no console errors', errors.length === 0, errors.join(' | '));
}
