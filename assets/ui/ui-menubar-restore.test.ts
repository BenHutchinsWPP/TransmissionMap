// @vitest-environment jsdom
// The session boot hook (wireMenubar → wireSessionRestore): the drawer restore
// (table-open.js restoreDrawer, which loads the table chunk) runs only for a
// restorable tm-drawer, once, after map:ready, and its resumeAsk imports
// ui-chat.js; a snapshot that may not restore here is removed; one that may is
// kept current with the link while its chunk stays unloaded.
// Deps: ui-menubar.js (table-open.js, ui-chat.js and undo.js mocked),
//       session-snapshot.js, state-bus.js; fresh modules per page load.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const m = vi.hoisted(() => ({ imported: 0, resumed: 0, restored: 0 }));
vi.mock('./ui-chat.js', () => { m.imported++; return { resumeChat: () => { m.resumed++; } }; });
vi.mock('./table-open.js', () => ({
  restoreDrawer: async (resumeAsk: () => Promise<void>) => { m.restored++; await resumeAsk(); },
}));
vi.mock('../undo.js', () => ({ undo: vi.fn(), redo: vi.fn(), canUndo: () => false, canRedo: () => false }));

async function boot(nav: string) {
  vi.resetModules();
  vi.spyOn(performance, 'getEntriesByType').mockReturnValue([{ type: nav } as unknown as PerformanceEntry]);
  m.imported = 0; m.resumed = 0; m.restored = 0;
  const { wireMenubar } = await import('./ui-menubar.js');
  const { emit } = await import('../state-bus.js');
  wireMenubar();
  emit('map:ready');
  emit('map:ready');
  await new Promise(r => setTimeout(r, 0));
}

const put = (key: string, data: unknown, hash = location.hash) =>
  sessionStorage.setItem(key, JSON.stringify({ v: 1, hash, at: 1, data }));
const chat = { entries: [{ t: 'user', text: 'x' }] };
const drawer = { v: 1, ask: true, table: null, pane: 'ask', frac: 0, collapsed: false };

// Handlers of earlier page loads in this file stay on window; drop them so one load's restamp is the only one.
const hooks: [EventTarget, string, EventListener][] = [];
for (const target of [window, document]) {
  const add = target.addEventListener.bind(target);
  target.addEventListener = ((type: string, fn: EventListener, o?: unknown) => { hooks.push([target, type, fn]); add(type, fn, o as never); }) as typeof target.addEventListener;
}

beforeEach(() => {
  for (const [target, type, fn] of hooks.splice(0)) target.removeEventListener(type, fn); sessionStorage.clear(); history.replaceState(null, '', '#3/40/-100?l=a'); vi.restoreAllMocks(); });

describe('session boot hook', () => {
  it('imports nothing without a drawer snapshot', async () => {
    put('tm-chat', chat);
    await boot('reload');
    expect(m.restored).toBe(0);
    expect(m.imported).toBe(0);
  });

  it('restores a drawer once, on a reload of the same link, with the chat when Ask was open', async () => {
    put('tm-chat', chat);
    put('tm-drawer', drawer);
    await boot('reload');
    expect(m.restored).toBe(1);
    expect(m.resumed).toBe(1);
  });

  it('removes snapshots a fresh navigation or another link may not restore', async () => {
    put('tm-chat', chat);
    put('tm-drawer', drawer);
    await boot('navigate');
    expect(m.restored).toBe(0);
    expect(sessionStorage.getItem('tm-chat')).toBeNull();
    expect(sessionStorage.getItem('tm-drawer')).toBeNull();
    put('tm-drawer', drawer, '#other');
    await boot('reload');
    expect(m.restored).toBe(0);
    expect(sessionStorage.getItem('tm-drawer')).toBeNull();
  });

  it('leaves a closed chat unloaded, and restamps its snapshot when the view moved on', async () => {
    put('tm-chat', chat);
    await boot('reload');
    expect(m.imported).toBe(0);
    history.replaceState(null, '', '#5/41/-101?l=b');
    window.dispatchEvent(new Event('pagehide'));
    expect(JSON.parse(sessionStorage.getItem('tm-chat')!).hash).toBe('#5/41/-101?l=b');
  });

  it('stops restamping a snapshot once its chunk has claimed it', async () => {
    put('tm-chat', chat);
    await boot('reload');
    (await import('../session-snapshot.js')).claimSnapshot('tm-chat');
    history.replaceState(null, '', '#5/41/-101?l=b');
    window.dispatchEvent(new Event('pagehide'));
    expect(JSON.parse(sessionStorage.getItem('tm-chat')!).hash).toBe('#3/40/-100?l=a');
  });
});
