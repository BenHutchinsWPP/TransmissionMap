// ─── Linked services in My Data, and the pending-link card (lazy chunk) ──────
// Role: renders `state.services` as rows under My Data ▸ Linked services
//       (#linkedServicesBody): title, host, an "unvetted" badge worked out at
//       render time by isVetted (never stored), the live load status, a
//       show/hide toggle and Remove (both setServices commits, so Undo steps
//       them). A service that may not fetch yet (pendingServices) shows its
//       host with Load / Skip. The same module owns the small card a link
//       opens with when it names such services. Every external string — a
//       title, a host, a service's status text — is set as text only.
//       Lazy chunk: ui-mydata.ts imports it when the view holds a service, and
//       ui-services.ts after an add, so a visit with no service never loads it.
// Deps: state.js, state-bus.js, view-state.js (setServices, skipService,
//       pendingServices, approveAndLoad), services/service-hosts.js (isVetted),
//       services/service-load.js (onServiceStatus, serviceStatus,
//       serviceStatusText), services-dom.ts, src/i18n/index.js (t),
//       ui-services.css.
// Consumed by ui-mydata.ts and ui-services.ts.

import { state } from '../state.js';
import { on } from '../state-bus.js';
import { setServices, skipService, pendingServices, approveAndLoad } from '../view-state.js';
import { isVetted } from '../services/service-hosts.js';
import { onServiceStatus, serviceStatus, serviceStatusText } from '../services/service-load.js';
import { t } from '../../src/i18n/index.js';
import { el } from './services-dom.js';
import './ui-services.css';

let wired = false;
let dismissedKey = '';

function statusEl(id: string): HTMLElement | null {
  return [...document.querySelectorAll<HTMLElement>('[data-svc-status]')].find(n => n.dataset.svcStatus === id) ?? null;
}

function row(s: typeof state.services[number], pending: boolean): HTMLElement {
  const badge = !isVetted(s.url, s.kind) ? el('span', { class: 'svc-badge' }, t('services.unvetted')) : '';
  const head = el('div', { class: 'svc-row-main' },
    el('span', { class: 'svc-row-title' }, s.title || s.host),
    el('span', { class: 'svc-row-host' }, s.host),
    badge,
  );
  const status = el('div', { class: 'svc-row-status', 'data-svc-status': s.id });
  status.textContent = pending ? t('services.status.pending') : serviceStatusText(serviceStatus(s.id));
  const actions = el('div', { class: 'svc-row-actions' });
  if (pending) {
    actions.append(
      el('button', { type: 'button', class: 'svc-btn', 'data-svc-act': 'load', 'data-svc-id': s.id }, t('services.load')),
      el('button', { type: 'button', class: 'svc-btn', 'data-svc-act': 'skip', 'data-svc-id': s.id }, t('services.skip')),
    );
  } else {
    actions.append(
      el('button', { type: 'button', class: 'svc-btn', 'data-svc-act': 'toggle', 'data-svc-id': s.id }, s.visible ? t('mydata.hide') : t('mydata.show')),
      el('button', { type: 'button', class: 'svc-btn', 'data-svc-act': 'remove', 'data-svc-id': s.id }, t('mydata.remove')),
    );
  }
  return el('div', { class: 'svc-row' }, head, status, actions);
}

function onRowClick(e: Event) {
  const btn = (e.target as Element).closest<HTMLElement>('[data-svc-act]');
  if (!btn) return;
  const svc = state.services.find(s => s.id === btn.dataset.svcId);
  if (!svc) return;
  switch (btn.dataset.svcAct) {
    case 'load': approveAndLoad(svc.url); break;
    case 'skip': skipService(svc.id); break;
    case 'toggle': setServices(state.services.map(s => s.id === svc.id ? { ...s, visible: !s.visible } : s)); break;
    case 'remove': setServices(state.services.filter(s => s.id !== svc.id)); break;
  }
  renderLinkedServices();
}

/** Redraw the rows and the pending card from the view. */
export function renderLinkedServices(): void {
  wire();
  const body = document.getElementById('linkedServicesBody');
  if (body) {
    const pendingIds = new Set(pendingServices().map(s => s.id));
    body.replaceChildren();
    if (state.services.length) {
      body.append(el('div', { class: 'section-title' }, t('mydata.linkedServices')));
      for (const s of state.services) body.append(row(s, pendingIds.has(s.id)));
    }
    body.hidden = !state.services.length;
  }
  renderCard();
}

function renderCard() {
  const pending = pendingServices();
  const key = pending.map(s => s.id).join(',');
  document.getElementById('servicesCard')?.remove();
  if (!pending.length || key === dismissedKey) return;
  const hosts = [...new Set(pending.map(s => s.host))].join(', ');
  const card = el('div', { id: 'servicesCard', class: 'rotate-hint-toast rotate-hint-toast--top svc-card', role: 'status' },
    el('span', { class: 'svc-card-text' }, t('services.card.text', { hosts })),
    el('button', { type: 'button', class: 'svc-btn', 'data-card-act': 'load' }, t('services.load')),
    el('button', { type: 'button', class: 'svc-btn', 'data-card-act': 'skip' }, t('services.skip')),
    el('button', { type: 'button', 'aria-label': t('common.close'), 'data-card-act': 'dismiss' }, '×'),
  );
  card.addEventListener('click', e => {
    const act = (e.target as Element).closest<HTMLElement>('[data-card-act]')?.dataset.cardAct;
    if (!act) return;
    if (act === 'load') for (const s of pending) approveAndLoad(s.url);
    else if (act === 'skip') for (const s of pending) skipService(s.id);
    else dismissedKey = key;
    renderLinkedServices();
  });
  (document.getElementById('rotateHintToast')?.parentElement ?? document.body).append(card);
}

function wire() {
  if (wired) return;
  wired = true;
  document.getElementById('linkedServicesBody')?.addEventListener('click', onRowClick);
  // Status text can be a remote server's message: textContent, never markup.
  onServiceStatus((id, status) => {
    const node = statusEl(id);
    if (node) node.textContent = serviceStatusText(status);
  });
  on('url:write', renderLinkedServices);
  on('view:applied', renderLinkedServices);
  on('lang:changed', renderLinkedServices);
}
