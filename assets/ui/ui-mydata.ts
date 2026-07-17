// ─── "My Data" tab interaction handlers ───────────────────────────────────────
// Click / keydown / dblclick wiring for the My Data panel: select & highlight
// user features, inline-rename, toggle/expand/delete layers and features, and
// Delete-key trashing of the selected drawn feature.
// Deps: state.js, user-data.js (render + selection + mutation helpers).
// Consumed by ui.ts (wireUI).

import { state } from '../state.js';
import {
  renderMyDataTab, clearUserHighlight, removeUserLayer,
  removeUserFeature, toggleUserLayerVisibility, selectUserFeature,
  startInlineEdit,
} from '../user-data/user-data.js';

export function wireMyData() {
  document.addEventListener('keydown', onMyDataKeydown);

  document.addEventListener('dblclick', e => {
    const span = (e.target as Element)?.closest<HTMLElement>('.my-feature-name[data-edit]');
    if (!span || state.editMode !== 'edit') return;
    startInlineEdit(span);
  });

  document.addEventListener('click', onMyDataClick);
}

function onMyDataKeydown(e: KeyboardEvent) {
  if (e.key !== 'Delete' && e.key !== 'Backspace') return;
  const tag = document.activeElement?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') return;
  if (state.editMode !== 'edit' || !state.draw) return;
  state.draw.trash();
  renderMyDataTab();
}

function onMyDataClick(e: MouseEvent) {
  const t = e.target as Element;
  const nameEl = t?.closest<HTMLElement>('.my-feature-name[data-edit]');
  if (nameEl) {
    const key = nameEl.dataset.edit === 'drawn'
      ? nameEl.dataset.featureId
      : nameEl.dataset.featureUid;
    if (state.userHighlightKey === key) {
      clearUserHighlight();
      if (nameEl.dataset.edit === 'drawn' && state.draw && state.editMode === 'edit') {
        state.draw.changeMode('simple_select', { featureIds: [] });
      }
      document.querySelectorAll('.my-feature-row--active')
        .forEach(r => r.classList.remove('my-feature-row--active'));
      return;
    }
    selectUserFeature(nameEl);
    return;
  }

  const btn = t?.closest<HTMLElement>('[data-action]');
  if (!btn) return;
  switch (btn.dataset.action) {
    case 'toggle-layer': {
      const layer = state.userLayers.find(l => l.id === btn.dataset.layerId);
      if (layer) toggleUserLayerVisibility(layer.id, !layer.visible);
      renderMyDataTab();
      break;
    }
    case 'toggle-expand': {
      const layer = state.userLayers.find(l => l.id === btn.dataset.layerId);
      if (layer) { layer.expanded = !layer.expanded; renderMyDataTab(); }
      break;
    }
    case 'delete-layer':
      clearUserHighlight();
      removeUserLayer(btn.dataset.layerId!);
      break;
    case 'delete-feature':
      clearUserHighlight();
      removeUserFeature(btn.dataset.layerId!, btn.dataset.featureUid!);
      break;
    case 'delete-drawn':
      clearUserHighlight();
      if (state.draw) { state.draw.delete(btn.dataset.featureId!); renderMyDataTab(); }
      break;
  }
}
