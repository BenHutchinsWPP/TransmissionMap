// @vitest-environment jsdom
// A chip offers Undo only when its own call changed the view: a committing call
// that changes nothing (a layer already on) pushes no undo step, so an Undo on
// its chip would revert an older step.
// Deps: ui-chat.js; ui-table.js, agent/loop.js, agent/local-commands.js,
//       view-state.js, url-state-codec.js and undo.js are mocked; so is
//       agent/openrouter.js's catalogue (a test never calls OpenRouter).
// The model picker groups by provider and labels each model with its
// intelligence index and $ per million tokens once the catalogue lands.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const m = vi.hoisted(() => ({
  view: 'l=a',
  /** The calls the mocked model makes for the next message: [tool, view after]. */
  calls: [] as [string, string][],
  undo: vi.fn(() => true),
  /** A runAnalysis call the mocked model makes next: its code and outcome. */
  analysis: null as null | { code: string; outcome: { ok: boolean; result?: unknown; reason?: string } },
  /** The next message's model call renders a canvas (DispatchOpts.render) before its chip. */
  render: false,
  rendered: [] as unknown[][],
}));

vi.mock('./ui-canvas.js', () => ({
  canvasCard: (...a: unknown[]) => {
    m.rendered.push(a);
    const el = document.createElement('figure');
    el.className = 'chat-canvas';
    return { el, done: Promise.resolve({ shown: true }) };
  },
  closeAllCanvases: () => {},
}));

vi.mock('./ui-table.js', () => {
  const p = document.createElement('div');
  document.body.append(p);
  return { askPanel: () => p, openAsk: () => {} };
});
vi.mock('../agent/local-commands.js', () => ({ LOCAL_EXAMPLES: [], localContext: async () => ({}) }));
vi.mock('../view-state.js', () => ({ currentView: () => m.view }));
vi.mock('../url-state-codec.js', () => ({ formatUrlState: (v: string) => [v] }));
vi.mock('../undo.js', () => ({ undo: m.undo }));
vi.mock('../agent/openrouter.js', async (orig) => {
  const real = await orig<typeof import('../agent/openrouter.js')>();
  const info = (id: string, provider: string, name: string, iq: number | null, i: number, o: number) =>
    ({ id, provider, name, intelligence: iq, promptPrice: i / 1e6, completionPrice: o / 1e6, free: false });
  const list = [
    info('anthropic/claude-haiku-5.5', 'Anthropic', 'Claude Haiku 5.5', 43.4, 0.1, 0.5),
    info('openai/gpt-6-luna', 'OpenAI', 'GPT-6 Luna', 38.1, 0.1, 0.5),
    info('anthropic/claude-3-haiku', 'Anthropic', 'Claude 3 Haiku', null, 0.257, 1.029),
    info('amazon/nova-micro-v1', 'Amazon', 'Nova Micro', 5.9, 0.035, 0.14),
  ];
  return { ...real, listToolModels: async () => list };
});
vi.mock('../agent/loop.js', () => ({
  newSession: () => ({ messages: [], cost: 0 }),
  runLocal: async () => ({ kind: 'answer', text: '', runs: [] }),
  ask: async (_s: unknown, _t: string, opts: { onRun: (r: unknown) => void; onCall: (n: string, a: unknown) => void;
    render: (k: string, t: string, p: unknown, i?: unknown, x?: unknown) => Promise<unknown> }) => {
    if (m.render) {
      opts.onCall('showCanvas', { title: 'A page', html: '<p>x</p><img src=x onerror="window.pwned=1">' });
      const outcome = await opts.render('html', 'A page', '<p>x</p>', { n: 1 }, { partial: ['EIA Power Plants'] });
      opts.onRun({ name: 'showCanvas', args: {}, source: 'model', outcome: { ok: true, result: outcome } });
    }
    if (m.analysis) {
      const args = { code: m.analysis.code, inputs: [{ layer: 'eia-generators' }] };
      opts.onCall('runAnalysis', args);
      opts.onRun({ name: 'runAnalysis', args, source: 'model', outcome: m.analysis.outcome });
    }
    for (const [name, after] of m.calls) {
      m.view = after;
      opts.onRun({ name, args: {}, source: 'model', outcome: { ok: true, result: null } });
    }
    return { kind: 'answer', text: '', runs: [] };
  },
}));

import { openChat } from './ui-chat.js';
import { setKey } from '../agent/key-store.js';

async function send(text: string) {
  const form = document.querySelector<HTMLFormElement>('.chat-form')!;
  document.querySelector<HTMLInputElement>('.chat-input')!.value = text;
  form.dispatchEvent(new Event('submit', { cancelable: true }));
  await vi.waitFor(() => expect(document.querySelector('.chat-send')!.hasAttribute('hidden')).toBe(false));
}
const lastChip = () => [...document.querySelectorAll('.chat-chip')].at(-1)!;

beforeEach(() => localStorage.setItem('tm-notice-chat', '1'));

describe('chip Undo', () => {
  beforeEach(() => {
    setKey('sk-or-v1-' + 'x'.repeat(40), false);
    openChat();
    m.undo.mockClear();
  });

  it('is offered on a call that changed the view', async () => {
    m.view = 'l=a';
    m.calls = [['setLayerVisible', 'l=a,b']];
    await send('turn on b');
    expect(lastChip().querySelector('.chat-undo')).not.toBeNull();
  });

  it('is not offered on a committing call that changed nothing', async () => {
    m.calls = [['setLayerVisible', m.view]];
    await send('turn on b again');
    expect(lastChip().querySelector('.chat-undo')).toBeNull();
  });

  it('compares each chip with the one before it in the same answer', async () => {
    m.view = 'l=a';
    m.calls = [['setLayerVisible', 'l=a,c'], ['setLayerVisible', 'l=a,c']];
    await send('turn on c twice');
    const chips = [...document.querySelectorAll('.chat-chip')].slice(-2);
    expect(chips.map(c => !!c.querySelector('.chat-undo'))).toEqual([true, false]);
  });
});

describe('analysis code chip', () => {
  const CODE = '<img src=x onerror="window.pwned=1">\n<script>window.pwned=2</script>';
  beforeEach(() => {
    setKey('sk-or-v1-' + 'x'.repeat(40), false);
    openChat();
    m.calls = [];
  });

  it('shows the code as collapsed text before the result chip', async () => {
    m.analysis = { code: CODE, outcome: { ok: true, result: { value: 1 } } };
    await send('analyse');
    const log = document.querySelector('.chat-log')!;
    const kids = [...log.children];
    const code = kids.findIndex(k => k.classList.contains('chat-code'));
    const result = kids.findIndex(k => k.matches('.chat-chip[data-tool="runAnalysis"]:not(.chat-code)'));
    expect(code).toBeGreaterThan(-1);
    expect(result).toBeGreaterThan(code);
    const d = kids[code] as HTMLDetailsElement;
    expect(d.tagName).toBe('DETAILS');
    expect(d.open).toBe(false);
    expect(d.querySelector('summary')!.textContent).toBe('Analysis code');
    expect(d.querySelector('pre')!.textContent).toBe(CODE);
    expect(d.querySelector('img, script')).toBeNull();
    expect((window as unknown as { pwned?: number }).pwned).toBeUndefined();
    d.open = true;
    expect(d.open).toBe(true);
  });

  it('shows the unavailable text on the failed chip', async () => {
    m.analysis = { code: 'return 1', outcome: { ok: false, reason: "Analysis isn't available in this browser" } };
    await send('analyse again');
    const chip = lastChip();
    expect(chip.getAttribute('data-ok')).toBe('false');
    expect(chip.querySelector('.chat-chip-why')!.textContent).toBe("Analysis isn't available in this browser");
  });

  it('shows no code chip for another tool', async () => {
    m.analysis = null;
    m.calls = [['setLayerVisible', 'l=z']];
    const before = document.querySelectorAll('.chat-code').length;
    await send('turn on z');
    expect(document.querySelectorAll('.chat-code').length).toBe(before);
  });
});

describe('model picker', () => {
  const select = () => document.querySelector<HTMLSelectElement>('.chat-model')!;
  const groups = () => [...select().querySelectorAll('optgroup')].map(g =>
    [g.label, ...[...g.querySelectorAll('option')].map(o => o.value)]);

  beforeEach(() => openChat());

  it('defaults to Claude Haiku 5.5, labelled with its score and price', async () => {
    await vi.waitFor(() => expect(select().querySelector('option[disabled]')).not.toBeNull());
    expect(select().value).toBe('anthropic/claude-haiku-5.5');
    expect(select().selectedOptions[0].text).toBe('Claude Haiku 5.5 · 43 · $0.10/$0.50');
  });

  it('groups by provider, the recommended providers first, and lists the rest on More models…', async () => {
    await vi.waitFor(() => expect(select().querySelector('option[disabled]')).not.toBeNull());
    expect(groups()[0]).toEqual(['Anthropic', 'anthropic/claude-haiku-5.5', 'anthropic/claude-sonnet-5.5']);
    select().value = '__more';
    select().dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(select().querySelector('option[value="__more"]')).toBeNull());
    const g = groups();
    expect(g[0]).toEqual(['Anthropic', 'anthropic/claude-haiku-5.5', 'anthropic/claude-sonnet-5.5', 'anthropic/claude-3-haiku']);
    expect(g.at(-1)![0]).toBe('Amazon');
    expect(select().querySelector<HTMLOptionElement>('option[value="anthropic/claude-3-haiku"]')!.text).toBe('Claude 3 Haiku · – · $0.26/$1.0');
  });
});

describe('canvas render', () => {
  beforeEach(() => {
    setKey('sk-or-v1-' + 'x'.repeat(40), false);
    openChat();
    m.calls = []; m.analysis = null;
  });

  it('shows the card after its call chip and hands the frame outcome back', async () => {
    m.render = true;
    await send('draw something');
    m.render = false;
    expect(m.rendered.at(-1)).toEqual(['A page', { kind: 'html', payload: '<p>x</p>', inputs: { n: 1 } },
      expect.objectContaining({ partial: ['EIA Power Plants'] })]);
    const log = [...document.querySelector('.chat-log')!.children];
    const code = log.findIndex(e => e.matches('.chat-code[data-tool="showCanvas"]'));
    expect(code).toBeGreaterThanOrEqual(0);
    expect(log[code].querySelector('summary')!.textContent).toBe('Canvas code');
    expect(log[code].querySelector('pre')!.textContent).toMatch(/onerror/);
    expect(log[code].querySelector('img')).toBeNull();
    const chip = log.findIndex(e => e.matches('.chat-chip[data-tool="showCanvas"]:not(.chat-code)'));
    const card = log.findIndex(e => e.matches('.chat-canvas'));
    expect(chip).toBeGreaterThan(code);
    expect(card).toBe(chip + 1);
  });
});
