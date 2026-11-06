// @vitest-environment jsdom
// Tests for color-picker menu positioning, z-index, and dismissal behaviors,
// and the Undo / Redo keys and File menu items.
// Deps: ui-menubar.js, user-data-colors.js, state.js, state-bus.js; undo.js is mocked.

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';

const undoMock = vi.hoisted(() => ({
  undo: vi.fn(() => true),
  redo: vi.fn(() => true),
  canUndo: vi.fn(() => false),
  canRedo: vi.fn(() => false),
}));
vi.mock('../undo.js', () => undoMock);

import { positionColorMenu, wireMenubar } from './ui-menubar.js';
import { colorPickerInner } from '../user-data/user-data-colors.js';
import { state } from '../state.js';
import { emit } from '../state-bus.js';

// Its handlers are delegated on document and window, so wire once: a wire per
// test would stack a keydown listener per test.
beforeAll(() => { wireMenubar(); });

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

describe('ui-menubar undo / redo', () => {
  const key = (init: KeyboardEventInit, target: EventTarget = document.body) => {
    const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
    target.dispatchEvent(e);
    return e;
  };

  beforeEach(() => {
    document.body.innerHTML = `
      <button class="menu-btn tb-btn" data-action="undo" type="button" disabled>Undo</button>
      <button class="menu-btn tb-btn" data-action="redo" type="button" disabled>Redo</button>
      <button class="menu-item" data-action="undo" id="mu" type="button" disabled>Undo</button>
      <input id="field" type="text">
      <input id="check" type="checkbox">
      <input id="range" type="range">
      <select id="pick"><option>a</option></select>
      <textarea id="area"></textarea>
      <div id="editable" contenteditable="true"></div>
    `;
    Object.values(undoMock).forEach(f => f.mockClear());
    undoMock.canUndo.mockReturnValue(false);
    undoMock.canRedo.mockReturnValue(false);
    state.editMode = 'view';
    state.measure.active = false;
  });

  it('Ctrl+Z on the page undoes and claims the key', () => {
    const e = key({ key: 'z', ctrlKey: true });
    expect(undoMock.undo).toHaveBeenCalledTimes(1);
    expect(undoMock.redo).not.toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(true);
  });

  it('Cmd+Z undoes too', () => {
    key({ key: 'z', metaKey: true });
    expect(undoMock.undo).toHaveBeenCalled();
  });

  it('Ctrl+Shift+Z and Ctrl+Y redo', () => {
    key({ key: 'Z', ctrlKey: true, shiftKey: true });
    expect(undoMock.redo).toHaveBeenCalled();
    undoMock.redo.mockClear();
    key({ key: 'y', ctrlKey: true });
    expect(undoMock.redo).toHaveBeenCalled();
    expect(undoMock.undo).not.toHaveBeenCalled();
  });

  it('leaves Ctrl+Z to a focused input', () => {
    const e = key({ key: 'z', ctrlKey: true }, document.getElementById('field')!);
    expect(undoMock.undo).not.toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(false);
  });

  it('undoes from a focused checkbox, range or select, which keep no Ctrl+Z of their own', () => {
    for (const id of ['check', 'range', 'pick']) {
      undoMock.undo.mockClear();
      const e = key({ key: 'z', ctrlKey: true }, document.getElementById(id)!);
      expect(undoMock.undo, id).toHaveBeenCalledTimes(1);
      expect(e.defaultPrevented, id).toBe(true);
    }
  });

  it('leaves Ctrl+Z to a textarea and a contenteditable', () => {
    key({ key: 'z', ctrlKey: true }, document.getElementById('area')!);
    key({ key: 'z', ctrlKey: true }, document.getElementById('editable')!);
    expect(undoMock.undo).not.toHaveBeenCalled();
  });

  it('reads the physical key on a non-Latin layout', () => {
    key({ key: 'я', code: 'KeyZ', ctrlKey: true });   // Russian layout, Z key
    expect(undoMock.undo).toHaveBeenCalledTimes(1);
    key({ key: 'н', code: 'KeyY', ctrlKey: true });
    expect(undoMock.redo).toHaveBeenCalledTimes(1);
  });

  it('does nothing while a dialog is open', () => {
    document.body.insertAdjacentHTML('beforeend', '<dialog open></dialog>');
    key({ key: 'z', ctrlKey: true });
    expect(undoMock.undo).not.toHaveBeenCalled();
  });

  it('does nothing in edit mode or while measuring', () => {
    state.editMode = 'edit';
    key({ key: 'z', ctrlKey: true });
    state.editMode = 'view';
    state.measure.active = true;
    key({ key: 'z', ctrlKey: true });
    expect(undoMock.undo).not.toHaveBeenCalled();
  });

  it('ignores a plain Z', () => {
    const e = key({ key: 'z' });
    expect(undoMock.undo).not.toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(false);
  });

  it('buttons follow canUndo / canRedo on undo:changed', () => {
    const undoItem = document.querySelector<HTMLButtonElement>('[data-action="undo"]')!;
    const redoItem = document.querySelector<HTMLButtonElement>('[data-action="redo"]')!;
    expect(undoItem.disabled).toBe(true);
    expect(redoItem.disabled).toBe(true);
    undoMock.canUndo.mockReturnValue(true);
    emit('undo:changed');
    expect(undoItem.disabled).toBe(false);
    expect(redoItem.disabled).toBe(true);
    expect((document.getElementById('mu') as HTMLButtonElement).disabled).toBe(false);
  });

  it('clicking the Undo button undoes', async () => {
    undoMock.canUndo.mockReturnValue(true);
    emit('undo:changed');
    document.querySelector<HTMLButtonElement>('[data-action="undo"]')!.click();
    await Promise.resolve();
    expect(undoMock.undo).toHaveBeenCalled();
  });
});

describe('ui-menubar submenus and keys', () => {
  const key = (k: string, target: Element) => {
    const e = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true });
    target.dispatchEvent(e);
    return e;
  };
  const q = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;

  beforeEach(() => {
    document.body.innerHTML = `
      <div class="menu-wrap">
        <button class="menu-btn" id="fb" aria-haspopup="true" aria-expanded="false">File</button>
        <div class="menu-dropdown" hidden>
          <div class="menu-sub" id="s1">
            <button class="menu-item menu-sub-btn" id="sb1" aria-haspopup="true" aria-expanded="false">Open</button>
            <div class="menu-submenu" hidden>
              <button class="menu-item" id="i1">A</button>
              <button class="menu-item" id="i2">B</button>
            </div>
          </div>
          <button class="menu-item" id="top2">Settings</button>
        </div>
      </div>`;
  });

  it('opens a submenu on click and closes everything on Escape, returning focus', () => {
    q('#fb').click();
    q('#sb1').click();
    expect(q('#sb1').getAttribute('aria-expanded')).toBe('true');
    expect(q('.menu-submenu').hidden).toBe(false);
    q('#i1').focus();
    key('Escape', q('#i1'));
    expect(q('.menu-dropdown').hidden).toBe(true);
    expect(q('#sb1').getAttribute('aria-expanded')).toBe('false');
    expect(q('.menu-submenu').hidden).toBe(true);
    expect(document.activeElement).toBe(q('#fb'));
  });

  it('opens with ArrowRight, walks with ArrowDown and leaves with ArrowLeft', () => {
    q('#fb').focus();
    key('ArrowDown', q('#fb'));
    expect(q('.menu-dropdown').hidden).toBe(false);
    expect(document.activeElement).toBe(q('#sb1'));
    key('ArrowRight', q('#sb1'));
    expect(document.activeElement).toBe(q('#i1'));
    key('ArrowDown', q('#i1'));
    expect(document.activeElement).toBe(q('#i2'));
    key('ArrowLeft', q('#i2'));
    expect(q('.menu-submenu').hidden).toBe(true);
    expect(document.activeElement).toBe(q('#sb1'));
  });
});

describe('ui-menubar compact-view swap in style.css', () => {
  // The rule bodies run from their @media header to the closing brace at column 0.
  const css = readFileSync('assets/style.css', 'utf8');
  const bodyOf = (header: string, at: number) => css.slice(at + header.length, css.indexOf('\n}\n', at));

  it('hides .tb-btn and shows the phone-only menu items in the shared compact query', () => {
    const header = '@media (max-width: 640px), (max-height: 500px) {';
    const at = css.indexOf('.tb-btn { display: none; }');
    expect(at).toBeGreaterThan(-1);
    expect(css.lastIndexOf('@media', at)).toBe(css.lastIndexOf(header, at));
    const block = bodyOf(header, css.lastIndexOf(header, at));
    expect(block).toMatch(/\.menu-item\.menu-phone-only[^{]*\{\s*display:\s*block/);
  });

  it('keeps .tb-btn visible under the 480 px query', () => {
    const header = '@media (max-width: 480px) {';
    expect(bodyOf(header, css.indexOf(header))).not.toMatch(/\.tb-btn\s*\{\s*display:\s*none/);
  });
});
