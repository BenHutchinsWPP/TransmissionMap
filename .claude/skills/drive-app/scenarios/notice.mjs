// .claude/skills/drive-app/scenarios/notice.mjs
// The `notice` scenario of drive.mjs (see SKILL.md); helpers come from ../harness.mjs.
import { check, open, st, hashFor, shot, visibleNotices } from '../harness.mjs';

  // A link with three bad entries shows one top-centre notice counting 3,
  // keeps the valid entry, and rewrites the link without the bad ones.
export default async function notice(ctx) {
    const probe = await open(ctx);
    const linked = await hashFor(probe.page, {
      where: {
        'no-such-layer': [{ field: 'x', op: '==', value: 1 }],                        // unknown layer
        'osm-transmission-lines': [{ field: 'nominal_kv', op: '>=', value: '345' }], // wrong value type
      },
      style: { 'osm-generators': { color: '#00ff00', opacity: 0.5 } },                // colour on an icon layer
    });
    await probe.page.close();
    // open() settles first; the notice stays up for 8 s, so read it straight away.
    const { page, errors } = await open(ctx, linked);
    const notices = await visibleNotices(page);
    check('exactly one visible notice', notices.length === 1, JSON.stringify(notices));
    check('notice counts 3', /\(3\)/.test(notices[0]?.text ?? ''), notices[0]?.text);
    check('notice sits at the top', (notices[0]?.top ?? 999) < 150);
    check('valid opacity kept, bad colour dropped',
      JSON.stringify(await st(page, 'state.styleOverrides')) === '{"osm-generators":{"opacity":0.5}}');
    await shot(page, 'notice-1');
    check('no console errors', errors.length === 0, errors.join(' | '));
}
