import { describe, it, expect, vi, afterEach } from 'vitest';
import { on, emit } from './state-bus.js';

describe('emit', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('runs every handler and reports a throwing one asynchronously', () => {
    const queued: (() => void)[] = [];
    vi.stubGlobal('queueMicrotask', (cb: () => void) => { queued.push(cb); });
    const boom = new Error('boom');
    const after = vi.fn();
    on('exp:ended', () => { throw boom; });
    on('exp:ended', after);

    expect(() => emit('exp:ended')).not.toThrow();
    expect(after).toHaveBeenCalledOnce();
    expect(queued).toHaveLength(1);
    expect(() => queued[0]()).toThrow(boom);
  });
});
