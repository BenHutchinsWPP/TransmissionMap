import { describe, it, expect, beforeEach } from 'vitest';

import { recordDiagEvent, getDiagLog, clearDiagLog } from './diag-log.js';

beforeEach(() => {
  clearDiagLog();
});

describe('recordDiagEvent / getDiagLog', () => {
  it('returns entries in insertion order', () => {
    recordDiagEvent('map', 'first');
    recordDiagEvent('layer', 'second');
    recordDiagEvent('basemap', 'third');

    const log = getDiagLog();
    expect(log.map((e) => e.detail)).toEqual(['first', 'second', 'third']);
  });

  it('caps the buffer at 50 entries, dropping the oldest', () => {
    for (let i = 0; i < 60; i++) {
      recordDiagEvent('live', `event-${i}`);
    }

    const log = getDiagLog();
    expect(log.length).toBe(50);
    expect(log[0].detail).toBe('event-10');
    expect(log[log.length - 1].detail).toBe('event-59');
  });

  it('returns a copy, so mutating the result does not affect later reads', () => {
    recordDiagEvent('map', 'original');

    const log = getDiagLog();
    log.push({ ts: 0, source: 'live', detail: 'injected' });

    expect(getDiagLog()).toEqual([expect.objectContaining({ detail: 'original' })]);
  });

  it('clearDiagLog empties the buffer', () => {
    recordDiagEvent('map', 'something');
    clearDiagLog();

    expect(getDiagLog()).toEqual([]);
  });

  it('stringifies a non-string detail', () => {
    recordDiagEvent('map', new Error('boom'));
    expect(getDiagLog()[0].detail).toBe('Error: boom');
  });

  it('does not throw when the detail cannot be stringified', () => {
    const hostile = { toString() { throw new Error('nope'); } };
    expect(() => recordDiagEvent('map', hostile)).not.toThrow();
    expect(getDiagLog()[0].detail).toBe('(undescribable error)');
  });
});
