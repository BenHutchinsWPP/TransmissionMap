// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { clipValue, tsvOf, copyText, GRID_RANGE_DEFAULTS, isCopyKey, keepFromGrid } from './grid-copy.js';

afterEach(() => { vi.restoreAllMocks(); });

describe('clipValue', () => {
  it('keeps numbers whole, blanks the non-finite', () => {
    expect(clipValue(0.30000000000000004)).toBe(0.30000000000000004);
    expect(clipValue(NaN)).toBe('');
    expect(clipValue(Infinity)).toBe('');
    expect(clipValue(null)).toBe('');
    expect(clipValue(undefined)).toBe('');
  });
  it('guards formulas, flattens breaks, stringifies objects', () => {
    expect(clipValue('=SUM(A1)')).toBe("'=SUM(A1)");
    expect(clipValue('@x')).toBe("'@x");
    expect(clipValue('-1+2')).toBe("'-1+2");
    expect(clipValue('a\tb\r\nc')).toBe('a b c');
    expect(clipValue({ a: 1 })).toBe('{"a":1}');
    expect(clipValue(true)).toBe('true');
  });
});

describe('tsvOf', () => {
  it('writes the header line, then one line per row', () => {
    expect(tsvOf(['a', 'b'], [[1, 'x'], [2.5, '']])).toBe('a\tb\n1\tx\n2.5\t');
  });
  it('header only when there are no rows', () => {
    expect(tsvOf(['a'], [])).toBe('a');
  });
});

describe('copyText', () => {
  it('puts the text on the copy event and reports done', () => {
    document.execCommand = vi.fn(() => {
      const ev = new Event('copy', { cancelable: true }) as unknown as ClipboardEvent;
      Object.defineProperty(ev, 'clipboardData', { value: { setData: (t: string, v: string) => { got.push(t, v); } } });
      document.dispatchEvent(ev);
      return true;
    });
    const got: string[] = [];
    const done = vi.fn();
    copyText('a\tb', done);
    expect(got).toEqual(['text/plain', 'a\tb']);
    expect(done).toHaveBeenCalledTimes(1);
  });
  it('falls back to the async clipboard when the command fails', async () => {
    document.execCommand = vi.fn(() => false);
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const done = vi.fn();
    copyText('hi', done);
    await Promise.resolve(); await Promise.resolve();
    expect(writeText).toHaveBeenCalledWith('hi');
    expect(done).toHaveBeenCalledTimes(1);
  });
});

describe('isCopyKey', () => {
  const key = (init: KeyboardEventInit) => new KeyboardEvent('keydown', init);
  it('takes Ctrl/Cmd+C of either case, nothing with Alt or Shift', () => {
    expect(isCopyKey(key({ key: 'c', ctrlKey: true }))).toBe(true);
    expect(isCopyKey(key({ key: 'C', metaKey: true }))).toBe(true);
    expect(isCopyKey(key({ key: 'c' }))).toBe(false);
    expect(isCopyKey(key({ key: 'c', ctrlKey: true, shiftKey: true }))).toBe(false);
    expect(isCopyKey(key({ key: 'c', ctrlKey: true, altKey: true }))).toBe(false);
    expect(isCopyKey(key({ key: 'v', ctrlKey: true }))).toBe(false);
  });
});

describe('keepFromGrid', () => {
  it('stops the four press events at the control', () => {
    const outer = document.createElement('div'), inner = document.createElement('button');
    outer.append(inner);
    keepFromGrid(inner);
    const seen: string[] = [];
    for (const type of ['mousedown', 'pointerdown', 'click', 'dblclick']) {
      outer.addEventListener(type, () => seen.push(type));
      inner.dispatchEvent(new Event(type, { bubbles: true }));
    }
    expect(seen).toEqual([]);
  });
});

describe('GRID_RANGE_DEFAULTS', () => {
  it('holds the range options the three grids share', () => {
    expect(GRID_RANGE_DEFAULTS).toMatchObject({
      renderVertical: 'virtual', selectableRange: 1, selectableRangeColumns: false, selectableRangeRows: true,
      selectableRangeAutoFocus: false, keybindings: { navNext: false, navPrev: false }, columnDefaults: { resizable: 'header' },
    });
  });
});
