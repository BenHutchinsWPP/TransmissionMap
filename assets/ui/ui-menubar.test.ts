// @vitest-environment jsdom
// Tests for color-picker menu positioning, z-index, and dismissal behaviors.
// Deps: ui-menubar.js, user-data-colors.js.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { positionColorMenu, wireMenubar } from './ui-menubar.js';
import { colorPickerInner } from '../user-data/user-data-colors.js';

describe('ui-menubar color-menu positioning and interaction', () => {
  let picker: HTMLElement;
  let swatch: HTMLElement;
  let menu: HTMLElement;

  beforeEach(() => {
    document.body.innerHTML = `
      <div id="layersPanel" class="layers-panel" style="position: absolute; right: 12px; top: 12px; width: 220px;">
        <div class="tab-pane" id="tab-my-data">
          <div class="my-data-body" id="myDataBody">
            <div class="my-feature-row">
              <span class="color-picker" data-target="feature" data-feature-id="feat-1">
                ${colorPickerInner('#f97316')}
              </span>
            </div>
          </div>
        </div>
      </div>
      <span class="color-picker" id="drawColorPicker" data-target="default">
        ${colorPickerInner('#3b82f6')}
      </span>
    `;

    picker = document.querySelector('.color-picker') as HTMLElement;
    swatch = picker.querySelector('.color-swatch-btn') as HTMLElement;
    menu = picker.querySelector('.color-menu') as HTMLElement;

    wireMenubar();
  });

  it('positionColorMenu applies fixed position and high z-index', () => {
    vi.spyOn(swatch, 'getBoundingClientRect').mockReturnValue({
      top: 100,
      bottom: 122,
      left: 800,
      right: 822,
      width: 22,
      height: 22,
      x: 800,
      y: 100,
      toJSON: () => {},
    });

    Object.defineProperty(menu, 'offsetWidth', { value: 103, configurable: true });
    Object.defineProperty(menu, 'offsetHeight', { value: 92, configurable: true });

    positionColorMenu(menu, swatch);

    expect(menu.style.position).toBe('fixed');
    expect(menu.style.zIndex).toBe('1000');
    expect(menu.style.left).toBe('800px');
    expect(menu.style.top).toBe('127px'); // 122 + 5
  });

  it('positionColorMenu shifts left if menu would overflow right viewport boundary', () => {
    vi.spyOn(swatch, 'getBoundingClientRect').mockReturnValue({
      top: 100,
      bottom: 122,
      left: 1000,
      right: 1022,
      width: 22,
      height: 22,
      x: 1000,
      y: 100,
      toJSON: () => {},
    });

    Object.defineProperty(window, 'innerWidth', { value: 1024, configurable: true });
    Object.defineProperty(menu, 'offsetWidth', { value: 103, configurable: true });
    Object.defineProperty(menu, 'offsetHeight', { value: 92, configurable: true });

    positionColorMenu(menu, swatch);

    // 1024 - 103 - 8 = 913
    expect(menu.style.left).toBe('913px');
  });

  it('positionColorMenu flips above swatch when near bottom of viewport', () => {
    vi.spyOn(swatch, 'getBoundingClientRect').mockReturnValue({
      top: 700,
      bottom: 722,
      left: 500,
      right: 522,
      width: 22,
      height: 22,
      x: 500,
      y: 700,
      toJSON: () => {},
    });

    Object.defineProperty(window, 'innerHeight', { value: 768, configurable: true });
    Object.defineProperty(menu, 'offsetWidth', { value: 103, configurable: true });
    Object.defineProperty(menu, 'offsetHeight', { value: 92, configurable: true });

    positionColorMenu(menu, swatch);

    // 722 + 5 + 92 = 819 > 760 -> flips above: 700 - 5 - 92 = 603
    expect(menu.style.top).toBe('603px');
  });

  it('clicking color-swatch-btn toggles menu and positions it', () => {
    expect(menu.hidden).toBe(true);

    swatch.click();
    expect(menu.hidden).toBe(false);
    expect(menu.style.position).toBe('fixed');
    expect(menu.style.zIndex).toBe('1000');

    swatch.click();
    expect(menu.hidden).toBe(true);
  });

  it('dismisses color-menu on Escape key', () => {
    swatch.click();
    expect(menu.hidden).toBe(false);

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(menu.hidden).toBe(true);
  });

  it('dismisses color-menu on window/container scroll', () => {
    swatch.click();
    expect(menu.hidden).toBe(false);

    window.dispatchEvent(new Event('scroll'));
    expect(menu.hidden).toBe(true);
  });

  it('dismisses color-menu on window resize', () => {
    swatch.click();
    expect(menu.hidden).toBe(false);

    window.dispatchEvent(new Event('resize'));
    expect(menu.hidden).toBe(true);
  });

  it('dismisses color-menu when clicking outside', () => {
    swatch.click();
    expect(menu.hidden).toBe(false);

    document.body.click();
    expect(menu.hidden).toBe(true);
  });
});
