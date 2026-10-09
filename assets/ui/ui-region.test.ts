// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';

import { state } from '../state.js';
import { emit } from '../state-bus.js';
// Importing ui.ts registers its 'view:applied' subscriber.
import './ui.js';

beforeEach(() => {
  document.body.innerHTML = `
    <div id="regionDropdown">
      <button id="regionDropdownBtn"></button>
      <span id="regionActiveIcon"></span><span id="regionActiveText"></span>
      <div id="regionMenu" hidden>
        <button class="region-menu-item" data-region="usa"><span class="region-menu-label">USA</span></button>
        <button class="region-menu-item" data-region="global"><span class="region-menu-label">Global</span></button>
      </div>
    </div>
  `;
});

describe('region dropdown', () => {
  it('resyncs to the scope an applied view carries', () => {
    state.regionScope = 'global';
    emit('view:applied');
    const active = document.querySelectorAll<HTMLElement>('.region-menu-item--active');
    expect(active).toHaveLength(1);
    expect(active[0].dataset.region).toBe('global');
    expect(document.getElementById('regionActiveText')!.textContent).toBe('Global');
  });
});
