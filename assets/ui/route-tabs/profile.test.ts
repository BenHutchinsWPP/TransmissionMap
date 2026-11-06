// @vitest-environment jsdom
// ─── Route Profile tab tests ─────────────────────────────────────────────────
// Role: run segments at x proportional to miles, elevation gaps, hover/marker, drag zoom,
//       dispose and the failure text. English comes from src/i18n/route/en.ts and locales/en.ts (the shipped text).
// Deps: ./profile.ts, ./fixture.ts, elevation/terrarium.ts (mocked).

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/i18n/index.js', async () => {
  const en: Record<string, string> = {
    ...(await vi.importActual<{ default: Record<string, string> }>('../../../src/i18n/locales/en.js')).default,
    ...(await vi.importActual<{ default: Record<string, string> }>('../../../src/i18n/route/en.js')).default,
  };
  return { t: (k: string, p?: Record<string, string | number>) => (en[k] ?? k).replace(/\{(\w+)\}/g, (m, n) => (p && n in p ? String(p[n]) : m)) };
});
vi.mock('../../elevation/terrarium.js', () => ({ TERRAIN_CREDIT: 'Terrain Tiles', sampleElevation: vi.fn() }));

import tab, { elevationPath } from './profile.js';
import { sampleElevation } from '../../elevation/terrarium.js';
import { FIXTURE_SESSION, fakeTabContext } from './fixture.js';

const sample = vi.mocked(sampleElevation);
const flush = () => new Promise((r) => setTimeout(r, 0));
const LEFT = 124, W = 800, PLOT = W - LEFT - 12;

function setup() {
  const session = FIXTURE_SESSION();
  session.result = { ...session.result!, profile: { ...session.result!.profile! } };   // fresh object: the elevation cache is per profile
  const markers: [number | null, string | undefined][] = [];
  const fits: [number, number][] = [];
  const ctx = Object.assign(fakeTabContext(session), {
    setProfileMarker: (mi: number | null, label?: string) => { markers.push([mi, label]); },
    fitMiles: (a: number, b: number) => { fits.push([a, b]); },
  });
  const el = document.createElement('div');
  document.body.append(el);
  tab.render(el, ctx);
  const svg = el.querySelector('svg')!;
  svg.getBoundingClientRect = () => ({ left: 0, top: 0, width: W, height: 300, right: W, bottom: 300, x: 0, y: 0, toJSON() {} });
  return { el, svg, ctx, markers, fits, len: session.result!.profile!.runs.at(-1)!.mi1 };
}
const mouse = (type: string, x: number) => new MouseEvent(type, { clientX: x, bubbles: true, button: 0 });

beforeEach(() => { document.body.replaceChildren(); sample.mockReset(); sample.mockResolvedValue([]); });

describe('profile tab', () => {
  it('places run segments proportionally to miles', () => {
    sample.mockReturnValue(new Promise(() => {}));
    const { el, len } = setup();
    const rects = [...el.querySelectorAll<SVGRectElement>('[data-track="cost"] rect')];
    expect(rects.length).toBeGreaterThan(2);
    for (const r of rects) {
      const mi0 = Number(r.dataset.mi0);
      expect(Number(r.getAttribute('x'))).toBeCloseTo(LEFT + (mi0 / len) * PLOT, 0);
    }
  });

  it('labels the mile axis with its unit', () => {
    sample.mockReturnValue(new Promise(() => {}));
    const { el } = setup();
    expect(el.querySelector('.rpf-unit')!.textContent).toBe('mi');
  });

  it('restarts the path with M after a null elevation', () => {
    expect(elevationPath([0, 1, 2, 3], [5, null, 7, 8])).toBe('M0,5M2,7L3,8');
  });

  it('draws a gap for null samples in the chart', async () => {
    sample.mockImplementation(async (pts) => pts.map((_, i) => (i === 5 ? null : 100 + i)));
    const { el } = setup();
    await flush();
    const d = el.querySelector('.rpf-elev-line')!.getAttribute('d')!;
    expect(d.match(/M/g)!.length).toBe(2);
  });

  it('hover moves the marker to the mile under the pointer', () => {
    sample.mockReturnValue(new Promise(() => {}));
    const { svg, markers, len, el } = setup();
    svg.dispatchEvent(mouse('mousemove', LEFT + PLOT / 2));
    const last = markers.at(-1)!;
    expect(last[0]).toBeCloseTo(len / 2, 3);
    expect(last[1]).toContain('mi ');
    expect(el.querySelector('.rpf-read')!.textContent).toContain('Mile');
    svg.dispatchEvent(new MouseEvent('mouseleave'));
    expect(markers.at(-1)![0]).toBeNull();
  });

  it('does not touch the marker with sync off', () => {
    sample.mockReturnValue(new Promise(() => {}));
    const { svg, markers, el } = setup();
    const box = el.querySelector<HTMLInputElement>('input[type=checkbox]')!;
    box.checked = false;
    box.dispatchEvent(new Event('change'));
    svg.dispatchEvent(mouse('mousemove', 300));
    expect(markers.filter((m) => m[0] !== null)).toHaveLength(0);
  });

  it('arrow keys move the crosshair by a mile', () => {
    sample.mockReturnValue(new Promise(() => {}));
    const { svg, markers, len } = setup();
    svg.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    svg.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(markers.at(-1)![0]).toBeCloseTo(len / 2 + 2, 3);
  });

  it('drag zooms and fits the map; double-click resets', () => {
    sample.mockReturnValue(new Promise(() => {}));
    const { svg, fits, len } = setup();
    svg.dispatchEvent(mouse('mousedown', LEFT + PLOT * 0.2));
    svg.dispatchEvent(mouse('mousemove', LEFT + PLOT * 0.4));
    window.dispatchEvent(mouse('mouseup', LEFT + PLOT * 0.4));
    expect(fits).toHaveLength(1);
    expect(fits[0][0]).toBeCloseTo(len * 0.2, 2);
    expect(fits[0][1]).toBeCloseTo(len * 0.4, 2);
    svg.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    expect(fits.at(-1)![0]).toBe(0);
  });

  it('dispose aborts the fetch and clears the marker', () => {
    let signal: AbortSignal | undefined;
    sample.mockImplementation((_p, o) => { signal = o?.signal; return new Promise(() => {}); });
    const { markers } = setup();
    tab.dispose!();
    expect(signal!.aborted).toBe(true);
    expect(markers.at(-1)![0]).toBeNull();
  });

  it('shows the failure text but still draws tracks', async () => {
    sample.mockRejectedValue(new Error('net'));
    const { el } = setup();
    await flush();
    expect(el.textContent).toContain('Elevation unavailable');
    expect(el.querySelectorAll('[data-track="landcover"] rect').length).toBeGreaterThan(0);
  });
});
