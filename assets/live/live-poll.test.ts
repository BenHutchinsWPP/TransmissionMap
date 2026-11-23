// @vitest-environment jsdom
// The shared live-feed poll loop: the interval runs only while active, and a
// return to the page (visibilitychange → visible, bfcache pageshow) refetches
// at once unless the last run was within the return gap.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { pollWhileVisible } from './live-poll.js';

const show = () => {
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
  document.dispatchEvent(new Event('visibilitychange'));
};
const pageshow = (persisted: boolean) =>
  window.dispatchEvent(Object.assign(new Event('pageshow'), { persisted }));

describe('pollWhileVisible', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('runs on the interval only while active', () => {
    let on = false;
    const run = vi.fn();
    pollWhileVisible({ intervalMs: 1000, active: () => on, run });
    vi.advanceTimersByTime(3000);
    expect(run).not.toHaveBeenCalled();
    on = true;
    vi.advanceTimersByTime(2000);
    expect(run).toHaveBeenCalledTimes(2);
    on = false;
    show();
    pageshow(true);
    expect(run).toHaveBeenCalledTimes(2);   // inactive: no return-to-page run either
  });

  it('refetches on return to the page only after the return gap', () => {
    const run = vi.fn();
    pollWhileVisible({ intervalMs: 10 * 60_000, active: () => true, run, returnGapMs: 60_000 });
    show();
    expect(run).toHaveBeenCalledTimes(1);   // first return: nothing ran yet
    vi.advanceTimersByTime(30_000);
    show();
    expect(run).toHaveBeenCalledTimes(1);   // within the gap
    vi.advanceTimersByTime(31_000);
    show();
    expect(run).toHaveBeenCalledTimes(2);   // past the gap
  });

  it('counts an interval run toward the return gap', () => {
    const run = vi.fn();
    pollWhileVisible({ intervalMs: 5 * 60_000, active: () => true, run });
    vi.advanceTimersByTime(5 * 60_000);
    expect(run).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(10_000);
    show();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('refetches on a bfcache restore (pageshow persisted) only', () => {
    const run = vi.fn();
    pollWhileVisible({ intervalMs: 10 * 60_000, active: () => true, run });
    pageshow(false);
    expect(run).not.toHaveBeenCalled();
    pageshow(true);
    expect(run).toHaveBeenCalledTimes(1);
  });
});
