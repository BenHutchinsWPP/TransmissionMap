// ─── Map Experiences UI (lazy chunk) ─────────────────────────────────────────
// Role: the two surfaces of Map Experiences — the gallery dialog behind
//       File ▸ Experiences…, and the floating story card that narrates the
//       active story. Owns #experiencesDialog's body and #storyCard; the dialog
//       chrome lives in index.html and its close/backdrop wiring in ui.ts.
//       Lazy chunk: pulled in on the first File ▸ Experiences… click, or on load
//       when the hash carries an `exp` param — so the 16 narratives and the
//       controller stay out of the initial bundle, matching ui-diagnostics.ts
//       and ui-settings.ts.
// Deps: experiences.js (the controller — all map/state mutation goes there),
//       registry/experiences.js (catalogue + category labels), state.js,
//       state-bus.js (exp:dirty / exp:ended / lang:changed), utils/utils.js
//       (escapeHtml — every catalogue string is injected as HTML),
//       src/i18n/index.js (t — the chrome is translated; the catalogue's own
//       narratives stay in English).
// Consumed by ui-menubar.ts (openExperiences) and ui.ts (restoreFromUrl).

import { state } from '../state.js';
import {
  EXPERIENCES, EXPERIENCE_CATEGORY_LABELS, EXPERIENCE_CATEGORY_ORDER,
  type MapExperience,
} from '../../src/registry/experiences.js';
import {
  applyExperience, activeExperience, endExperience, restoreExperience,
  neighbourExperience, experienceIndex, experienceTags, flyToHighlight,
} from '../experiences.js';
import { on } from '../state-bus.js';
import { escapeHtml } from '../utils/utils.js';
import { t } from '../../src/i18n/index.js';

let minimized = false;
let wired = false;
let mapWired = false;

// ─── Gallery dialog ───────────────────────────────────────────────────────────

export function openExperiences() {
  const dialog = document.getElementById('experiencesDialog') as HTMLDialogElement | null;
  if (!dialog) return;
  wire();
  const search = dialog.querySelector<HTMLInputElement>('#experiencesSearch');
  if (search) search.value = '';
  renderGallery('');
  dialog.showModal();
  // Pointer devices get the type-ahead focused; touch devices open the gallery
  // with the keyboard down, so the cards are what greets you.
  if (window.matchMedia('(hover: hover)').matches) search?.focus();
}

function matches(exp: MapExperience, q: string): boolean {
  if (!q) return true;
  const haystack = [
    exp.title, exp.summary, exp.narrative, EXPERIENCE_CATEGORY_LABELS[exp.category],
    ...(exp.keywords ?? []), ...exp.takeaways,
  ].join(' ').toLowerCase();
  // Every word has to land somewhere, so "wind plains" narrows rather than widens.
  return q.toLowerCase().split(/\s+/).filter(Boolean).every(term => haystack.includes(term));
}

function renderGallery(query: string) {
  const body = document.getElementById('experiencesBody');
  if (!body) return;

  const hits = EXPERIENCES.filter(exp => matches(exp, query));
  if (!hits.length) {
    body.innerHTML = `<p class="exp-empty">${escapeHtml(t('experiences.noMatch', { query }))}</p>`;
    return;
  }

  body.innerHTML = EXPERIENCE_CATEGORY_ORDER.map(category => {
    const inCategory = hits.filter(e => e.category === category);
    if (!inCategory.length) return '';
    return `
      <section class="exp-section">
        <h3 class="exp-section-title">${escapeHtml(EXPERIENCE_CATEGORY_LABELS[category])}</h3>
        <div class="exp-grid">${inCategory.map(galleryCardHtml).join('')}</div>
      </section>`;
  }).join('');
}

function galleryCardHtml(exp: MapExperience): string {
  const tags = experienceTags(exp)
    .map(tag => `<span class="exp-tag">${escapeHtml(tag)}</span>`).join('');
  const active = state.experienceId === exp.id ? ' exp-card--active' : '';
  return `
    <article class="exp-card${active}">
      <h4 class="exp-card-title">${escapeHtml(exp.title)}</h4>
      <p class="exp-card-summary">${escapeHtml(exp.summary)}</p>
      <div class="exp-card-tags">${tags}</div>
      <button class="exp-explore" type="button" data-exp-id="${escapeHtml(exp.id)}">${escapeHtml(t('experiences.explore'))}</button>
    </article>`;
}

// ─── Floating story card ──────────────────────────────────────────────────────

export function startExperience(id: string) {
  wire();
  if (!applyExperience(id)) return;
  (document.getElementById('experiencesDialog') as HTMLDialogElement | null)?.close();
  minimized = startsCollapsed();
  renderCard();
}

// On a phone the expanded card would own most of the map, so a story opens as
// the compact banner and the reader expands it when they want the detail.
function startsCollapsed(): boolean {
  return window.matchMedia('(max-width: 640px)').matches;
}

// Called by ui.ts once the map is ready and the hash named a story. The camera
// jumps rather than flies: there is nothing to fly from on a cold load.
export function restoreFromUrl() {
  const id = state.experienceId;
  if (!id) return;
  wire();
  if (!applyExperience(id, 'jump')) return;
  minimized = startsCollapsed();
  renderCard();
}

function renderCard() {
  const card = document.getElementById('storyCard');
  if (!card) return;
  const exp = activeExperience();
  if (!exp) {
    card.hidden = true;
    card.innerHTML = '';
    document.body.classList.remove('is-experience-active');
    return;
  }

  wireMapAutoMinimize();
  document.body.classList.add('is-experience-active');
  card.hidden = false;
  card.classList.toggle('story-card--min', minimized);

  const position = experienceIndex(exp.id) + 1;
  const header = `
    <div class="story-head">
      <div class="story-head-text">
        <span class="story-badge">${escapeHtml(EXPERIENCE_CATEGORY_LABELS[exp.category])}</span>
        <h2 class="story-title">${escapeHtml(exp.title)}</h2>
        <span class="story-step">${escapeHtml(t('story.step', { n: position, total: EXPERIENCES.length }))}</span>
      </div>
      <div class="story-head-btns">
        <button class="icon-btn story-btn" type="button" data-story-action="toggle"
                aria-label="${escapeHtml(t(minimized ? 'story.expand' : 'story.minimize'))}">${minimized ? '▢' : '—'}</button>
        <button class="icon-btn story-btn" type="button" data-story-action="close"
                aria-label="${escapeHtml(t('story.close'))}">×</button>
      </div>
    </div>`;

  const dirty = state.experienceDirty
    ? `<button class="story-dirty" type="button" data-story-action="restore">${escapeHtml(t('story.modified'))}</button>`
    : '';

  // The card auto-minimizes on the reader's first pan, which is exactly the
  // state they are in when they then toggle a layer — so the restore
  // affordance has to ride along into the collapsed header.
  if (minimized) {
    card.innerHTML = header + dirty;
    return;
  }

  const takeaways = exp.takeaways
    .map(t => `<li>${escapeHtml(t)}</li>`).join('');

  const highlights = (exp.highlights ?? []).map((h, i) => `
    <button class="story-pin" type="button" data-story-action="highlight" data-story-pin="${i}"
            title="${escapeHtml(h.description ?? h.label)}">📍 ${escapeHtml(h.label)}</button>`).join('');

  card.innerHTML = `
    ${header}
    ${dirty}
    <div class="story-body">
      <p class="story-narrative">${escapeHtml(exp.narrative)}</p>
      <h3 class="story-subhead">${escapeHtml(t('story.takeaways'))}</h3>
      <ul class="story-takeaways">${takeaways}</ul>
      ${highlights ? `<div class="story-pins">${highlights}</div>` : ''}
    </div>
    <div class="story-nav">
      <button class="story-nav-btn" type="button" data-story-action="prev">◀ ${escapeHtml(t('story.prev'))}</button>
      <button class="story-nav-btn" type="button" data-story-action="free">${escapeHtml(t('story.free'))}</button>
      <button class="story-nav-btn" type="button" data-story-action="next">${escapeHtml(t('story.next'))} ▶</button>
    </div>`;
}

// ─── Wiring ───────────────────────────────────────────────────────────────────
// Everything is delegated off document (both surfaces re-render their innerHTML
// wholesale) and guarded so a second openExperiences() can't stack handlers.
function wire() {
  if (wired) return;
  wired = true;

  document.addEventListener('input', e => {
    const input = (e.target as Element | null)?.closest<HTMLInputElement>('#experiencesSearch');
    if (input) renderGallery(input.value.trim());
  });

  document.addEventListener('click', e => {
    const target = e.target as Element | null;

    const explore = target?.closest<HTMLElement>('.exp-explore[data-exp-id]');
    if (explore) { startExperience(explore.dataset.expId!); return; }

    const action = target?.closest<HTMLElement>('[data-story-action]');
    if (!action || !action.closest('#storyCard')) return;
    const exp = activeExperience();
    if (!exp) return;

    switch (action.dataset.storyAction) {
      case 'toggle':  minimized = !minimized; renderCard(); break;
      case 'close':   endExperience(); break;
      case 'free':    endExperience(); break;
      case 'restore': restoreExperience(); minimized = false; renderCard(); break;
      case 'prev':
      case 'next': {
        const step = neighbourExperience(exp.id, action.dataset.storyAction === 'next' ? 1 : -1);
        if (step) startExperience(step.id);
        break;
      }
      case 'highlight': {
        const pin = exp.highlights?.[Number(action.dataset.storyPin)];
        if (pin) flyToHighlight(pin);
        break;
      }
    }
  });

  on('exp:dirty', renderCard);
  on('exp:ended', renderCard);
  // Both surfaces bake their chrome strings in at render time.
  on('lang:changed', () => {
    renderCard();
    const dialog = document.getElementById('experiencesDialog') as HTMLDialogElement | null;
    if (dialog?.open) renderGallery(dialog.querySelector<HTMLInputElement>('#experiencesSearch')?.value.trim() ?? '');
  });
}

// Reclaim the viewport as soon as the reader starts exploring by hand.
// A programmatic flyTo carries no originalEvent, so applying a story — or
// jumping to one of its pins — never collapses the card the reader just opened.
//
// Deferred out of wire(): the File menu is clickable before the map's `load`
// fires, so state.map can still be null there, and wire()'s own guard would
// then never let a second attempt through. A card is only ever rendered after
// applyExperience() has checked mapReady, so by here the map exists.
function wireMapAutoMinimize() {
  if (mapWired || !state.map) return;
  mapWired = true;
  for (const evt of ['dragstart', 'zoomstart', 'rotatestart'] as const) {
    state.map.on(evt, (e: { originalEvent?: unknown }) => {
      if (!e.originalEvent || minimized || !state.experienceId) return;
      minimized = true;
      renderCard();
    });
  }
}
