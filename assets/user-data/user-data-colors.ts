// ─── Draw color constants and color-picker UI helpers ─────────────────────────
// Holds the draw color helpers separately from user-data-draw.ts: user-data.ts
// needs drawnFeatureColor/colorPickerInner, and user-data-draw.ts needs
// renderMyDataTab from user-data.ts — importing them directly would cycle.

import { escapeHtml } from '../utils/utils.js';

const DRAW_DEFAULT_COLOR = '#f97316';

const DRAW_PALETTE = [
  '#f97316', '#ef4444', '#eab308', '#22c55e', '#14b8a6', '#3b82f6',
  '#6366f1', '#a855f7', '#ec4899', '#78716c', '#0f172a', '#ffffff',
];

export function drawnFeatureColor(feature: GeoJSON.Feature) {
  return feature.properties?.color
      || feature.properties?.stroke
      || feature.properties?.['marker-color']
      || DRAW_DEFAULT_COLOR;
}

export function colorPickerInner(current: string) {
  const cur = String(current).toLowerCase();
  const opts = DRAW_PALETTE.map(c =>
    `<button class="color-opt${c.toLowerCase() === cur ? ' color-opt--sel' : ''}"
             data-color="${c}" style="background:${c}" type="button" title="${c}"></button>`
  ).join('');
  return `<button class="color-swatch-btn" type="button" style="background:${escapeHtml(current)}"
                  aria-haspopup="true" aria-label="Choose color"></button>
          <div class="dropdown color-menu" hidden>${opts}<input class="color-custom" type="color"
               value="${escapeHtml(current)}" title="Custom color" aria-label="Custom color"></div>`;
}
