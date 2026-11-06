// @vitest-environment jsdom
// The layer row's ⋯ menu: open/close, aria-expanded, keyboard (arrows, Home/End,
// Esc returns focus, Tab closes), a pick closes it, a download group's summary
// keeps it open and its links join the arrow order only while the group is open.
// Deps: layer-menu.js, ui-layer-rows.js (real row HTML), registry.

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { wireLayerMenus, menuItems } from './layer-menu.js';
import { panelRows } from './ui-layer-rows.js';
import { LAYERS } from '../../src/registry/index.js';

const GEN = 'eia-generators';
const q = <T extends HTMLElement = HTMLElement>(s: string) => document.querySelector<T>(s)!;
const key = (el: Element, k: string) => el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));

beforeAll(() => { wireLayerMenus(); });

beforeEach(() => {
  document.body.innerHTML = Object.values(panelRows(LAYERS, { scope: 'usa', visible: {} }))
    .map(r => r.html).join('') + '<button id="outside">x</button>';
});

describe('layer row menu', () => {
  it('opens on click with focus on the first item, closes on a second click', () => {
    const btn = q(`#layer-menu-btn-${GEN}`);
    const menu = q(`#layer-menu-${GEN}`);
    expect(menu.hidden).toBe(true);
    btn.click();
    expect(menu.hidden).toBe(false);
    expect(btn.getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe(menuItems(menu)[0]);
    btn.click();
    expect(menu.hidden).toBe(true);
    expect(btn.getAttribute('aria-expanded')).toBe('false');
  });

  it('keeps one menu open at a time and closes on an outside click', () => {
    const other = [...document.querySelectorAll<HTMLElement>('.layer-menu-btn')].find(b => b.id !== `layer-menu-btn-${GEN}`)!;
    q(`#layer-menu-btn-${GEN}`).click();
    other.click();
    expect(q(`#layer-menu-${GEN}`).hidden).toBe(true);
    expect(document.getElementById(other.getAttribute('aria-controls')!)!.hidden).toBe(false);
    q('#outside').click();
    expect(document.querySelectorAll('.layer-menu:not([hidden])').length).toBe(0);
  });

  it('moves with the arrow keys (wrapping), Home and End; Esc closes and refocuses the button', () => {
    const btn = q(`#layer-menu-btn-${GEN}`);
    const menu = q(`#layer-menu-${GEN}`);
    key(btn, 'ArrowUp');
    const items = menuItems(menu);
    expect(items.length).toBeGreaterThan(2);
    expect(document.activeElement).toBe(items[items.length - 1]);
    key(document.activeElement!, 'ArrowDown');
    expect(document.activeElement).toBe(items[0]);
    key(document.activeElement!, 'ArrowUp');
    expect(document.activeElement).toBe(items[items.length - 1]);
    key(document.activeElement!, 'Home');
    expect(document.activeElement).toBe(items[0]);
    key(document.activeElement!, 'End');
    expect(document.activeElement).toBe(items[items.length - 1]);
    key(document.activeElement!, 'Escape');
    expect(menu.hidden).toBe(true);
    expect(document.activeElement).toBe(btn);
  });

  it('closes on Tab without taking focus back', () => {
    key(q(`#layer-menu-btn-${GEN}`), 'ArrowDown');
    key(document.activeElement!, 'Tab');
    expect(q(`#layer-menu-${GEN}`).hidden).toBe(true);
  });

  it('closes when an item is picked, returning focus to the button', () => {
    const btn = q(`#layer-menu-btn-${GEN}`);
    btn.click();
    q(`[data-filter-toggle="${GEN}"]`).click();
    expect(q(`#layer-menu-${GEN}`).hidden).toBe(true);
    expect(document.activeElement).toBe(btn);
  });

  it('counts a download group\'s links only while the group is open, and its summary keeps the menu open', () => {
    const summary = document.querySelector<HTMLElement>('.layer-menu .dl-group > summary');
    expect(summary).not.toBeNull();
    if (!summary) return;
    const menu = summary.closest<HTMLElement>('.layer-menu')!;
    const btn = q(`#${menu.getAttribute('aria-labelledby')}`);
    btn.click();
    const closed = menuItems(menu).length;
    summary.click();
    expect(menu.hidden).toBe(false);
    (summary.parentElement as HTMLDetailsElement).open = true;
    expect(menuItems(menu).length).toBeGreaterThan(closed);
  });
});
