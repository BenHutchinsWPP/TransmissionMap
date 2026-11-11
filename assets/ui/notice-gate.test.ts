// @vitest-environment jsdom
// The usage-notice gate: acceptance is per notice and per version. The chat's is
// kept in localStorage (memory for the page when storage is blocked); the route's
// lives in memory only and is forgotten when the Route pane closes.
// Deps: notice-gate.js (re-imported per test for a fresh memory).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const fresh = async () => { vi.resetModules(); return import('./notice-gate.js'); };

beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

describe('notice gate', () => {
  it('is unaccepted until accepted, per notice', async () => {
    const g = await fresh();
    expect(g.noticeAccepted('chat', 1)).toBe(false);
    g.acceptNotice('chat', 1);
    expect(g.noticeAccepted('chat', 1)).toBe(true);
    expect(g.noticeAccepted('route', 1)).toBe(false);
    expect(localStorage.getItem('tm-notice-chat')).toBe('1');
  });

  it('asks for the route notice every time: memory only, forgotten on close, never read from storage', async () => {
    localStorage.setItem('tm-notice-route', '9');
    const g = await fresh();
    expect(g.noticeAccepted('route', 1)).toBe(false);
    g.acceptNotice('route', 1);
    expect(g.noticeAccepted('route', 1)).toBe(true);
    expect(localStorage.getItem('tm-notice-route')).toBe('9');
    g.forgetNotice('route');
    expect(g.noticeAccepted('route', 1)).toBe(false);
    expect((await fresh()).noticeAccepted('route', 1)).toBe(false);
  });

  it('forgetting the chat notice keeps its stored acceptance', async () => {
    const g = await fresh();
    g.acceptNotice('chat', 1);
    g.forgetNotice('chat');
    expect(g.noticeAccepted('chat', 1)).toBe(true);
  });

  it('reads an earlier acceptance from storage, and a version bump asks again', async () => {
    localStorage.setItem('tm-notice-chat', '1');
    const g = await fresh();
    expect(g.noticeAccepted('chat', 1)).toBe(true);
    expect(g.noticeAccepted('chat', 2)).toBe(false);
    g.acceptNotice('chat', 2);
    expect(g.noticeAccepted('chat', 2)).toBe(true);
  });

  it('ignores a garbled stored value', async () => {
    localStorage.setItem('tm-notice-chat', 'yes');
    expect((await fresh()).noticeAccepted('chat', 1)).toBe(false);
  });

  it('holds acceptance in memory for the page when storage throws', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    const g = await fresh();
    expect(g.noticeAccepted('chat', 1)).toBe(false);
    g.acceptNotice('chat', 1);
    expect(g.noticeAccepted('chat', 1)).toBe(true);
    expect(g.noticeAccepted('chat', 2)).toBe(false);
  });
});
