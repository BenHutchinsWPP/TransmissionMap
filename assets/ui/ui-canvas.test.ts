// @vitest-environment jsdom
// The canvas card: the model's title as text, the page-drawn label, a Save
// button per validated download (nothing saved without its click), a PNG
// button on a vega card, a page-built CSV button when given one, Re-run after
// eviction and a notice after navigation, × that removes the card and its
// frame, and a partial-data note per partial layer; a template card with the
// app's label, a template frame (drawn on TM.drawn(), actions forwarded) and a
// scroll into view before the frame starts.
// Deps: ui-canvas.js over the real canvas-host.js; user-data-export.js mocked.

import { describe, it, expect, vi, afterEach } from 'vitest';

const saved = vi.hoisted(() => [] as [unknown, string, string][]);
vi.mock('../user-data/user-data-export.js', () => ({
  downloadFile: (d: unknown, n: string, m: string) => { saved.push([d, n, m]); },
}));

import { canvasCard, claimRestoreSlots, releaseRestoreSlot, TABLE_MAX } from './ui-canvas.js';
import { disposeAllCanvases, liveCanvases } from '../sandbox/canvas-host.js';

function mount(kind: 'html' | 'vega', title = '<b>t</b>') {
  const card = canvasCard(title, { kind, payload: kind === 'html' ? '<p>x</p>' : { mark: 'bar' } });
  document.body.append(card.el);
  const frame = card.el.querySelector('iframe')!;
  const win = frame.contentWindow!;
  const posted = vi.spyOn(win, 'postMessage').mockImplementation(() => {});
  const from = (data: unknown) => window.dispatchEvent(new MessageEvent('message', { data, source: win }));
  frame.dispatchEvent(new Event('load'));
  from({ type: 'ready' });
  const nonce = (posted.mock.calls[0][0] as { nonce: string }).nonce;
  return { ...card, frame, from, nonce, posted };
}

afterEach(() => { disposeAllCanvases(); document.body.replaceChildren(); saved.length = 0; });

describe('canvasCard', () => {
  it('shows the title as text and the sandbox label', () => {
    const c = mount('html');
    expect(c.el.querySelector('.chat-canvas-title')!.textContent).toBe('<b>t</b>');
    expect(c.el.querySelector('b')).toBeNull();
    expect(c.el.querySelector('.chat-canvas-label')!.textContent).toMatch(/sandbox/);
  });

  it('a download becomes a Save button; clicking it saves', () => {
    const c = mount('html');
    c.from({ type: 'download', nonce: c.nonce, name: 'data', mime: 'text/csv', data: 'a,b' });
    expect(saved).toHaveLength(0);
    const b = c.el.querySelector<HTMLButtonElement>('.chat-canvas-save')!;
    expect(b.textContent).toBe('Save data.csv');
    b.click();
    expect(saved).toEqual([['a,b', 'data.csv', 'text/csv']]);
  });

  it('a vega card asks the frame for its PNG and saves what comes back', () => {
    const c = mount('vega');
    c.el.querySelector<HTMLButtonElement>('.chat-canvas-png')!.click();
    expect(c.posted).toHaveBeenLastCalledWith({ type: 'png', nonce: c.nonce }, '*');
    const png = new ArrayBuffer(4);
    c.from({ type: 'download', nonce: c.nonce, name: 'chart.png', mime: 'image/png', data: png });
    // Named from the title, as the CSV is.
    expect(saved).toEqual([[png, 'b-t-b.png', 'image/png']]);
  });

  it("the card's actions sit in its header row, above the frame", () => {
    const c = mount('vega');
    const head = c.el.querySelector('.chat-canvas-head')!;
    expect(head.querySelector('.chat-canvas-png')).not.toBeNull();
    expect(c.el.firstElementChild).toBe(head);
  });

  it('a vega template card toggles a text-only table of its rows, capped at TABLE_MAX', async () => {
    const rows = Array.from({ length: TABLE_MAX + 5 }, (_, i) => ({ fuel: i ? `F${i}` : '<img src=x onerror=alert(1)>', sum: i * 1.5 }));
    const card = canvasCard('Fuel', { kind: 'vega', payload: { mark: 'bar' } },
      { template: true, table: { columns: [['fuel', 'Fuel'], ['sum', 'Capacity (MW)']], rows } });
    document.body.append(card.el);
    const btn = card.el.querySelector<HTMLButtonElement>('.chat-canvas-table-btn')!;
    expect(card.el.querySelector('table')).toBeNull();
    btn.click();
    expect(btn.getAttribute('aria-pressed')).toBe('true');
    expect([...card.el.querySelectorAll('th')].map(t => t.textContent)).toEqual(['Fuel', 'Capacity (MW)']);
    expect(card.el.querySelectorAll('tbody tr')).toHaveLength(TABLE_MAX);
    expect(card.el.querySelector('img')).toBeNull();
    expect(card.el.querySelector('tbody td')!.textContent).toBe('<img src=x onerror=alert(1)>');
    expect(card.el.querySelector('.chat-canvas-table-box')!.textContent).toMatch(/First 1,000 of 1,005 rows/);
    btn.click();
    expect(card.el.querySelector<HTMLElement>('.chat-canvas-table-slot')!.hidden).toBe(true);
    expect(canvasCard('x', { kind: 'vega', payload: { mark: 'bar' } }).el.querySelector('.chat-canvas-table-btn')).toBeNull();
  });

  it("a template card's Save button takes focus; a model card's does not", () => {
    const t = canvasCard('T', { kind: 'html', payload: '<p>x</p>' }, { template: true });
    document.body.append(t.el);
    const frame = t.el.querySelector('iframe')!;
    const win = frame.contentWindow!;
    const posted = vi.spyOn(win, 'postMessage').mockImplementation(() => {});
    const from = (data: unknown) => window.dispatchEvent(new MessageEvent('message', { data, source: win }));
    from({ type: 'ready' });
    const nonce = (posted.mock.calls[0][0] as { nonce: string }).nonce;
    from({ type: 'download', nonce, name: 'd', mime: 'text/csv', data: 'a' });
    expect(document.activeElement).toBe(t.el.querySelector('.chat-canvas-save'));
    const m = mount('html');
    m.from({ type: 'download', nonce: m.nonce, name: 'd', mime: 'text/csv', data: 'a' });
    expect(document.activeElement).not.toBe(m.el.querySelector('.chat-canvas-save'));
  });

  it('a CSV button saves the page-built CSV on click; no csv, no button', () => {
    const csv = vi.fn(() => 'group,count\r\n');
    const card = canvasCard('Gas & solar', { kind: 'vega', payload: { mark: 'bar' } }, { csv });
    expect(csv).not.toHaveBeenCalled();
    card.el.querySelector<HTMLButtonElement>('.chat-canvas-csv')!.click();
    expect(saved).toEqual([['group,count\r\n', 'gas-solar.csv', 'text/csv;charset=utf-8']]);
    expect(mount('vega').el.querySelector('.chat-canvas-csv')).toBeNull();
  });

  it('a refused vega spec hides the PNG and CSV buttons; a shown one keeps them', async () => {
    const c = mount('vega');
    c.from({ type: 'error', nonce: c.nonce, category: 'invalid-spec', message: 'bad' });
    await c.done;
    await Promise.resolve();
    expect(c.el.querySelector<HTMLButtonElement>('.chat-canvas-png')!.hidden).toBe(true);
    const ok = mount('vega');
    ok.from({ type: 'rendered', nonce: ok.nonce });
    await ok.done;
    await Promise.resolve();
    expect(ok.el.querySelector<HTMLButtonElement>('.chat-canvas-png')!.hidden).toBe(false);
  });

  it('an error before rendered is shown with its message', async () => {
    const c = mount('html');
    c.from({ type: 'error', nonce: c.nonce, category: 'syntax', message: 'Unexpected token' });
    expect(await c.done).toEqual({ error: 'syntax', message: 'Unexpected token' });
    expect(c.el.querySelector('.chat-canvas-error')!.textContent).toMatch(/Syntax error.*Unexpected token/);
  });

  it('× removes the card and disposes its frame; a run still starting answers unavailable', async () => {
    const card = canvasCard('t', { kind: 'html', payload: '<p>x</p>' });
    document.body.append(card.el);
    const close = card.el.querySelector<HTMLButtonElement>('.chat-canvas-close')!;
    expect(close.getAttribute('aria-label')).toBe('Close canvas');
    expect(close.classList.contains('td-icon')).toBe(true);
    expect(liveCanvases()).toBe(1);
    close.click();
    expect(card.el.isConnected).toBe(false);
    expect(card.el.querySelector('iframe')).toBeNull();
    expect(liveCanvases()).toBe(0);
    expect(await card.done).toEqual({ error: 'unavailable' });
  });

  it('one partial-data note per partial layer, as text; none without', () => {
    const card = canvasCard('t', { kind: 'html', payload: '' }, { partial: ['EIA Power Plants', '<b>x</b>'] });
    const notes = [...card.el.querySelectorAll('.chat-canvas-partial')].map(n => n.textContent);
    expect(notes).toHaveLength(2);
    expect(notes[0]).toMatch(/^EIA Power Plants: partial data \(loaded tiles only/);
    expect(card.el.querySelector('b')).toBeNull();
    expect(mount('html').el.querySelector('.chat-canvas-partial')).toBeNull();
  });

  it('an evicted card offers Re-run; a navigated one shows a notice', () => {
    const first = mount('html');
    const nav = mount('vega');
    mount('html');
    nav.frame.dispatchEvent(new Event('load'));
    expect(nav.el.querySelector('.chat-canvas-closed')!.textContent).toMatch(/another page/);
    mount('html'); mount('html');
    expect(first.frame.isConnected).toBe(false);
    const rerun = first.el.querySelector<HTMLButtonElement>('.chat-canvas-rerun')!;
    expect(first.el.textContent).toMatch(/closed to save memory/);
    rerun.click();
    expect(first.el.querySelector('iframe')).not.toBeNull();
  });

  it('Re-run after a stopped turn starts a live frame and clears old errors', async () => {
    const ctl = new AbortController();
    const card = canvasCard('t', { kind: 'html', payload: '' }, { signal: ctl.signal });
    document.body.append(card.el);
    const win = card.el.querySelector('iframe')!.contentWindow!;
    const posted = vi.spyOn(win, 'postMessage').mockImplementation(() => {});
    const from = (data: unknown) => window.dispatchEvent(new MessageEvent('message', { data, source: win }));
    card.el.querySelector('iframe')!.dispatchEvent(new Event('load'));
    from({ type: 'ready' });
    const nonce = (posted.mock.calls[0][0] as { nonce: string }).nonce;
    from({ type: 'error', nonce, category: 'runtime', message: 'boom' });
    from({ type: 'rendered', nonce });
    await card.done;
    ctl.abort();
    disposeAllCanvases();
    expect(card.el.querySelector('.chat-canvas-errors')!.textContent).toMatch(/boom/);
    card.el.querySelector<HTMLButtonElement>('.chat-canvas-rerun')!.click();
    await Promise.resolve();
    expect(card.el.querySelector('iframe')).not.toBeNull();
    expect(liveCanvases()).toBe(1);
    expect(card.el.querySelector('.chat-canvas-errors')!.textContent).toBe('');
  });
  it('a template card carries the app\'s label, a template frame and its actions, and scrolls into view first', async () => {
    const actions: unknown[] = [];
    const scrolled = vi.fn();
    const card = canvasCard('Fuel mix', { kind: 'html', payload: '<p>x</p>' }, { template: true, onAction: a => actions.push(a) });
    card.el.scrollIntoView = scrolled;
    document.body.append(card.el);
    expect(card.el.querySelector('.chat-canvas-label')!.textContent).toBe('TransmissionMap template');
    expect(card.el.querySelector('iframe')!.title).toBe('TransmissionMap template');
    expect(card.el.hasAttribute('data-template')).toBe(true);
    await Promise.resolve();
    expect(scrolled).toHaveBeenCalledWith({ block: 'nearest' });
    const frame = card.el.querySelector('iframe')!;
    const win = frame.contentWindow!;
    const posted = vi.spyOn(win, 'postMessage').mockImplementation(() => {});
    const from = (data: unknown) => window.dispatchEvent(new MessageEvent('message', { data, source: win }));
    frame.dispatchEvent(new Event('load'));
    from({ type: 'ready' });
    const nonce = (posted.mock.calls[0][0] as { nonce: string }).nonce;
    from({ type: 'rendered', nonce });
    from({ type: 'action', nonce, kind: 'fly', payload: { bbox: [0, 0, 1, 1] } });
    from({ type: 'drawn', nonce });
    await expect(card.done).resolves.toEqual({ shown: true });
    expect(actions).toEqual([{ kind: 'fly', payload: { bbox: [0, 0, 1, 1] } }]);
  });

  it('a template frame is 420 px tall, a free-form one 320, and a request\'s own height wins', () => {
    const h = (req: object, opts = {}) => (canvasCard('T', { kind: 'html', payload: '<p>x</p>', ...req }, opts).el.querySelector('iframe') as HTMLIFrameElement).style.height;
    expect(h({}, { template: true })).toBe('420px');
    expect(h({})).toBe('320px');
    expect(h({ height: 500 }, { template: true })).toBe('500px');
    disposeAllCanvases();
  });
  it('a free-form card keeps the sandbox label and shows a template error category as text', async () => {
    const c = mount('html');
    expect(c.el.querySelector('.chat-canvas-label')!.textContent).toMatch(/sandbox/);
    expect(c.el.hasAttribute('data-template')).toBe(false);
    const t = canvasCard('T', { kind: 'html', payload: '<p>x</p>' }, { template: true });
    document.body.append(t.el);
    const frame = t.el.querySelector('iframe')!;
    const win = frame.contentWindow!;
    const posted = vi.spyOn(win, 'postMessage').mockImplementation(() => {});
    frame.dispatchEvent(new Event('load'));
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'ready' }, source: win }));
    const nonce = (posted.mock.calls[0][0] as { nonce: string }).nonce;
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'error', nonce, category: 'invalid-data', message: 'no rows' }, source: win }));
    await expect(t.done).resolves.toEqual({ error: 'invalid-data', message: 'no rows' });
    expect(t.el.querySelector('.chat-canvas-error')!.textContent).toBe('The template could not read this data: no rows');
  });

  it('an evicted template card with rerun drops its payload, CSV and table, and Re-runs through the caller', async () => {
    const rerun = vi.fn(async (card: HTMLElement) => { card.replaceWith(document.createElement('figure')); return null as string | null; });
    const card = canvasCard('Mix', { kind: 'vega', payload: { mark: 'bar', data: { values: [{ a: 1 }] } } },
      { template: true, csv: () => 'a\n1', table: { columns: [['a', 'A']], rows: [{ a: 1 }] }, rerun });
    document.body.append(card.el);
    expect(card.el.querySelector('.chat-canvas-csv')).not.toBeNull();
    mount('html'); mount('html'); mount('html');          // MAX_LIVE: the template frame is evicted
    expect(card.el.querySelector('iframe')).toBeNull();
    expect(card.el.querySelector('.chat-canvas-csv, .chat-canvas-png, .chat-canvas-table-btn')).toBeNull();
    expect(card.el.querySelector('.chat-canvas-table-slot')!.childElementCount).toBe(0);
    card.el.querySelector<HTMLButtonElement>('.chat-canvas-rerun')!.click();
    expect(rerun).toHaveBeenCalledWith(card.el);
    expect(card.el.querySelector('iframe')).toBeNull();     // the card's own payload is gone: no local re-run
    await vi.waitFor(() => expect(card.el.isConnected).toBe(false));
  });

  it("a rerun that fails shows the caller's reason and keeps Re-run", async () => {
    const card = canvasCard('Mix', { kind: 'vega', payload: { mark: 'bar' } }, { template: true, rerun: async () => 'the map is not ready' });
    document.body.append(card.el);
    mount('html'); mount('html'); mount('html');
    const again = card.el.querySelector<HTMLButtonElement>('.chat-canvas-rerun')!;
    again.click();
    await vi.waitFor(() => expect(card.el.querySelector('.chat-canvas-errors')!.lastElementChild!.textContent).toBe('the map is not ready'));
    expect(again.disabled).toBe(false);
  });

  it('claimRestoreSlots grants only free frame slots, shared, and never more than MAX_LIVE', () => {
    mount('html');                                          // one live frame
    expect(claimRestoreSlots(5)).toBe(2);
    expect(claimRestoreSlots(1)).toBe(0);
    releaseRestoreSlot();
    expect(claimRestoreSlots(3)).toBe(1);
    releaseRestoreSlot(); releaseRestoreSlot();
    expect(claimRestoreSlots(0)).toBe(0);
  });
});
