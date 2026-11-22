// .claude/skills/drive-app/scenarios/weather.mjs
// The `weather` scenario of drive.mjs (see SKILL.md); helpers come from ../harness.mjs.
import { check, open, settle, mod, st, shot } from '../harness.mjs';

  // The weather-live opacity override scales the wash and its border lines,
  // and clearing it restores both exactly.
export default async function weather(ctx) {
    const { page, errors } = await open(ctx, '4/38/-97');
    await mod(page, '/assets/visibility.ts', m => m.setLayerVisibility('weather-live', true));
    await settle(page);
    const wash = () => st(page, "Math.max(...['weather-live','weather-live-b'].map(id => state.map.getPaintProperty(id, 'raster-opacity') ?? 0))");
    const border = () => st(page, "JSON.stringify(state.map.getPaintProperty('weather-admin-lines-states', 'line-opacity'))");
    const w0 = await wash(), b0 = await border();
    await shot(page, 'weather-1-default');
    check('setStyle accepted', (await mod(page, '/assets/style-overrides.ts', m => m.setStyle('weather-live', { opacity: 0.25 }))) === null);
    await settle(page);
    const w1 = await wash();
    check('wash scaled x0.25', Math.abs(w1 - w0 * 0.25) < 1e-6, `${w0} → ${w1}`);
    check('border lines scaled too', (await border()) !== b0, `${b0} → ${await border()}`);
    await shot(page, 'weather-2-x0.25');
    await mod(page, '/assets/style-overrides.ts', m => m.clearStyle('weather-live'));
    await settle(page);
    check('clear restores the wash', (await wash()) === w0);
    check('clear restores the borders', (await border()) === b0);
    check('no console errors', errors.length === 0, errors.join(' | '));
}
