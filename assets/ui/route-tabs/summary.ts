// ─── Route panel: Summary sub-tab ────────────────────────────────────────────
// Role: the first thing a solved route shows — headline KPIs (total, miles, $/mi),
//       the rough-early-estimate range bar, crossing pills, the tribal-land note and the
//       "Colour route by: Cost × | Driver | Plain" radiogroup on the left; a compact
//       "Where the money goes" waterfall (top 8 lines, the rest folded) on the right.
//       Renders from ctx.session only; the colour control calls ctx.setColourMode.
//       The reference tab for the other sub-tabs (RouteTab contract, widgets only).
// Deps: route-tabs/widgets.ts, route-tabs/method.ts (solvedPresetOf), route-tabs/types.ts (types), registry/route-presets.ts,
//       i18n (t), ./summary.css.

import './summary.css';
import { t } from '../../../src/i18n/index.js';
import { ROUTE_PRESETS, routePreset } from '../../../src/registry/route-presets.js';
import { crossingPills, kpis, rangeBar, tribalNote, waterfall, waterfallLines } from './widgets.js';
import { solvedPresetOf } from './method.js';
import type { ColourMode, RouteTab, RouteTabContext } from './types.js';

const MODES: ColourMode[] = ['cost', 'driver', 'plain'];

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, key?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (key) { e.dataset.i18n = key; e.textContent = t(key); }
  return e;
}

function colourControl(ctx: RouteTabContext): HTMLElement {
  const wrap = el('div', 'rs-colour');
  const lab = el('span', 'rs-colour-lab', 'route.sum.colourBy');
  lab.id = 'rs-colour-lab';
  const group = el('div', 'rs-seg');
  group.setAttribute('role', 'radiogroup');
  group.setAttribute('aria-labelledby', lab.id);
  const pick = (m: ColourMode) => {
    if (m !== ctx.session.colour) ctx.setColourMode(m);
    for (const b of group.querySelectorAll<HTMLButtonElement>('button')) {
      const on = b.dataset.mode === ctx.session.colour;
      b.setAttribute('aria-checked', String(on));
      b.tabIndex = on ? 0 : -1;
    }
  };
  for (const m of MODES) {
    const b = el('button', 'rs-seg-btn', `route.colour.${m}`);
    b.type = 'button';
    b.dataset.mode = m;
    b.setAttribute('role', 'radio');
    const on = m === ctx.session.colour;
    b.setAttribute('aria-checked', String(on));
    b.tabIndex = on ? 0 : -1;
    b.addEventListener('click', () => pick(m));
    group.append(b);
  }
  group.addEventListener('keydown', (e) => {
    const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const next = MODES[(MODES.indexOf(ctx.session.colour) + step + MODES.length) % MODES.length];
    pick(next);
    group.querySelector<HTMLElement>(`[data-mode="${next}"]`)?.focus();
  });
  wrap.append(lab, group);
  return wrap;
}

const tab: RouteTab = {
  id: 'summary',
  labelKey: 'route.sub.summary',
  disabled: () => null,
  render(root, ctx) {
    const r = ctx.session.result;
    root.replaceChildren();
    if (!r) return;
    const dollars = ctx.session.dollars;
    const money = (v: number) => ctx.money(v, v);
    const left = el('div', 'rs-left');
    left.append(kpis(r, dollars), rangeBar(r.cost, dollars));
    const crossings = r.profile?.crossings;
    if (crossings) left.append(crossingPills(crossings));
    left.append(tribalNote(r), colourControl(ctx));

    const right = el('div', 'rs-right');
    const preset = (ctx.session.resultInputs ? solvedPresetOf(ctx.session.resultInputs) : null) ?? routePreset(r.preset.id) ?? ROUTE_PRESETS[0];
    right.append(
      el('h4', 'rs-h', 'route.sum.money'),
      waterfall(waterfallLines(r.cost, preset, { dollars }), { money, compact: true, maxLines: 8 }),
    );
    const grid = el('div', 'rs');
    grid.append(left, right);
    root.append(grid);
  },
};

export default tab;
