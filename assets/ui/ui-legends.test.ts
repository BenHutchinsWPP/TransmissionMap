// @vitest-environment jsdom
// url-state.js must be imported before ui-legends.js. They sit in an import
// cycle (ui-legends → visibility → url-state → url-state-codec → ui-legends),
// and entering it from ui-legends leaves LEGEND_FILTERS in its TDZ when
// url-state-codec.ts reads it at module scope. url-state.test.ts primes the
// graph the same way.
import { describe, it, expect, beforeEach } from 'vitest';
import './../url-state.js';
import { rampLegendHtml } from './ui-legends.js';
import { setUnits, DEFAULT_UNITS, fmtTemp, fmtSpeed } from '../../src/units.js';

beforeEach(() => setUnits(DEFAULT_UNITS));

const STOPS: [number, string][] = [[0, '1,2,3'], [10, '4,5,6']];
const ends = (html: string) => {
  const m = html.match(/ramp-min">([^<]*)<[\s\S]*ramp-max">([^<]*)</);
  return m ? [m[1], m[2]] : [];
};

describe('rampLegendHtml', () => {
  it('renders nothing without a ramp', () => {
    expect(rampLegendHtml({ id: 'x' })).toBe('');
  });

  it('derives both ends from max + unit when no labels are given', () => {
    expect(ends(rampLegendHtml({ id: 'x', ramp: { stops: STOPS, max: 10, unit: 'g' } })))
      .toEqual(['0', '10+ g']);
  });

  it('prefers static minLabel/maxLabel over the derived form', () => {
    expect(ends(rampLegendHtml({ id: 'x', ramp: { stops: STOPS, max: 10, unit: 'g', minLabel: 'low', maxLabel: 'high' } })))
      .toEqual(['low', 'high']);
  });

  // The "+" must reach the label through fmt's mark parameter. If fmt is ever
  // called with one argument the clamp marker vanishes silently — typecheck
  // can't see it, because both arities are mutually assignable.
  it('formats both ends through fmt and marks the top end as clamped', () => {
    expect(ends(rampLegendHtml({ id: 'x', ramp: { stops: STOPS, min: -30, max: 45, fmt: fmtTemp } })))
      .toEqual(['-22°F', '113+°F']);
  });

  it('lets minLabel win at the bottom end while fmt still drives the top', () => {
    expect(ends(rampLegendHtml({ id: 'x', ramp: { stops: STOPS, max: 12, minLabel: '0.0', fmt: fmtSpeed } })))
      .toEqual(['0.0', '26.8+ mph']);
  });

  it('follows the display-unit preference on both ends', () => {
    setUnits({ temp: 'C' });
    expect(ends(rampLegendHtml({ id: 'x', ramp: { stops: STOPS, min: -30, max: 45, fmt: fmtTemp } })))
      .toEqual(['-30°C', '45+°C']);
  });
});
