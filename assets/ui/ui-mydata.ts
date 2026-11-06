// ─── "My Data" tab interaction handlers ───────────────────────────────────────
// Click / keydown / dblclick wiring for the My Data panel: select & highlight
// user features, inline-rename, toggle/expand/delete layers and features, and
// Delete-key trashing of the selected drawn feature. Also opens the Add layer
// from a service dialog (lazy ui-services.js) and loads the linked-services rows
// (lazy ui-linked-services.js) once the view holds a linked service.
// Deps: state.js, user-data.js (render + selection + mutation helpers; every
// mutation ends in commitUserData, which saves and re-renders).
// Consumed by ui.ts (wireUI).

import { state } from '../state.js';
import { on } from '../state-bus.js';
import {
  renderMyDataTab, clearUserHighlight, removeUserLayer,
  removeUserFeature, toggleUserLayerVisibility, selectUserFeature,
  startInlineEdit, commitUserData,
} from '../user-data/user-data.js';

export function wireMyData() {
  document.addEventListener('keydown', onMyDataKeydown);

  document.addEventListener('dblclick', e => {
    const span = (e.target as Element)?.closest<HTMLElement>('.my-feature-name[data-edit]');
    if (!span || state.editMode !== 'edit') return;
    startInlineEdit(span);
  });

  document.addEventListener('click', onMyDataClick);

  // The rows live in a lazy chunk: fetched only when a service is in the view
  // (a link, a view file, an add) — never for a visit without one.
  const syncServices = () => {
    if (state.services.length) void import('./ui-linked-services.js').then(m => m.renderLinkedServices());
  };
  on('map:ready', syncServices);
  on('view:applied', syncServices);
  on('url:write', syncServices);
  syncServices();
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
    case 'open-services-button':
      void import('./ui-services.js').then(m => m.openServices());
      break;
    case 'toggle-layer': {
      const layer = state.userLayers.find(l => l.id === btn.dataset.layerId);
      if (layer) toggleUserLayerVisibility(layer.id, !layer.visible);
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
      if (state.draw) { state.draw.delete(btn.dataset.featureId!); commitUserData(); }
      break;
  }
}
