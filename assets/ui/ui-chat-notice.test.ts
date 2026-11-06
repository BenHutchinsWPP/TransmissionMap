// @vitest-environment jsdom
// The map chat's usage notice: nothing is built and nothing goes to openrouter.ai
// before the visitor accepts; Cancel leaves the chat unopened; accepting builds
// the chat and fetches the model catalogue.
// Deps: ui-chat.js, notice-dialog.js (real); ui-table.js, agent/loop.js,
//       agent/local-commands.js mocked; global fetch stubbed (never the network).
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./ui-table.js', () => {
  const p = document.createElement('div');
  document.body.append(p);
  return { askPanel: () => p, openAsk: vi.fn() };
});
vi.mock('../agent/local-commands.js', () => ({ LOCAL_EXAMPLES: [], localContext: async () => ({}) }));
vi.mock('../agent/loop.js', () => ({
  newSession: () => ({ messages: [], cost: 0 }),
  runLocal: async () => ({ kind: 'answer', text: '', runs: [] }),
  ask: async () => ({ kind: 'answer', text: '', runs: [] }),
  history: () => [],
  validateHistory: () => null,
}));

import { openChat } from './ui-chat.js';
import { openAsk } from './ui-table.js';

const fetchMock = vi.fn(async (_u: unknown) => new Response(JSON.stringify({ data: [] })));
const dialog = () => document.querySelector<HTMLDialogElement>('dialog.disclaimer-dialog');
const button = (i: number) => dialog()!.querySelectorAll('button')[i];
const orFetches = () => fetchMock.mock.calls.filter(([u]) => String(u).includes('openrouter.ai'));

beforeEach(() => {
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
  localStorage.clear();
  document.querySelectorAll('dialog').forEach(d => d.remove());
});

describe('chat notice', () => {
  it('shows the notice and contacts nothing before acceptance, even on a click inside it', async () => {
    openChat();
    expect(dialog()).not.toBeNull();
    expect(dialog()!.querySelectorAll('a').length).toBe(2);
    for (const a of dialog()!.querySelectorAll('a')) expect(a.getAttribute('rel')).toBe('noopener noreferrer');
    dialog()!.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    dialog()!.dispatchEvent(new Event('focusin', { bubbles: true }));
    await new Promise(r => setTimeout(r, 0));
    expect(orFetches()).toHaveLength(0);
    expect(openAsk).not.toHaveBeenCalled();
  });

  it('Cancel opens nothing and fetches nothing', async () => {
    openChat();
    button(0).click();
    await new Promise(r => setTimeout(r, 0));
    expect(dialog()).toBeNull();
    expect(openAsk).not.toHaveBeenCalled();
    expect(orFetches()).toHaveLength(0);
    expect(localStorage.getItem('tm-notice-chat')).toBeNull();
  });

  it('accepting records it, opens the chat and then fetches the catalogue', async () => {
    openChat();
    button(1).click();
    await vi.waitFor(() => expect(openAsk).toHaveBeenCalled());
    expect(localStorage.getItem('tm-notice-chat')).toBe('1');
    expect(orFetches().length).toBeGreaterThan(0);
  });
});

describe('chat notice on restore (resumeChat)', () => {
  const fresh = async () => {
    vi.resetModules();
    vi.mocked(openAsk).mockClear();
    return (await import('./ui-chat.js')).resumeChat;
  };

  it('Cancel builds no pane, opens nothing and fetches nothing', async () => {
    const resumeChat = await fresh();
    const done = resumeChat();
    expect(dialog()).not.toBeNull();
    button(0).click();
    await done;
    expect(openAsk).not.toHaveBeenCalled();
    expect(orFetches()).toHaveLength(0);
  });

  it('a click and a focus inside the notice cause no request', async () => {
    const resumeChat = await fresh();
    const done = resumeChat();
    for (const type of ['click', 'pointerdown', 'focusin', 'keydown']) {
      dialog()!.dispatchEvent(new Event(type, { bubbles: true }));
      dialog()!.querySelector('a')!.dispatchEvent(new Event(type, { bubbles: true }));
    }
    await new Promise(r => setTimeout(r, 0));
    expect(orFetches()).toHaveLength(0);
    expect(openAsk).not.toHaveBeenCalled();
    button(0).click();
    await done;
  });

  it('accepting restores the chat quietly, then the first touch fetches the catalogue', async () => {
    const resumeChat = await fresh();
    const done = resumeChat();
    button(1).click();
    await done;
    expect(openAsk).toHaveBeenCalled();
    expect(orFetches()).toHaveLength(0);
    document.querySelector('.chat-model')!.dispatchEvent(new Event('focusin', { bubbles: true }));
    await vi.waitFor(() => expect(orFetches().length).toBeGreaterThan(0));
  });
});
