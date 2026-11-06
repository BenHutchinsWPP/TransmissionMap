// ─── Usage notices: the modal ────────────────────────────────────────────────
// Role: `showNotice(id)` builds the route or chat usage notice as a modal
//       <dialog> (existing disclaimer-dialog styles) from DOM nodes, text only
//       through t(); the only anchors are the chat notice's two OpenRouter links,
//       built as nodes. Resolves true on "I understand and accept" (and records
//       it through notice-gate.ts), false on Cancel or Esc. Not live-translated:
//       the dialog is open briefly.
// Deps: notice-gate.ts, services-dom.ts (el), i18n.
// Consumed by ui-route.ts and ui-chat.ts (lazy chunks only). It reads the route.notice.* strings
// (src/i18n/route/), which is safe only because showNotice('route') is called from ui-route.ts alone.
import { acceptNotice, CHAT_NOTICE_VERSION, ROUTE_NOTICE_VERSION, type NoticeId } from './notice-gate.js';
import { el } from './services-dom.js';
import { t } from '../../src/i18n/index.js';

const OR = 'https://openrouter.ai';
const link = (href: string, key: string) =>
  el('a', { href, target: '_blank', rel: 'noopener noreferrer' }, t(key));
const para = (...kids: (string | Node)[]) => el('p', { class: 'disclaimer-body' }, ...kids);
const first = (p: HTMLElement, id: string) => { p.id = id; return p; };

function body(id: NoticeId): Node[] {
  if (id === 'route') return ['p1', 'p2', 'p3'].map((k, i) => { const p = para(t(`route.notice.${k}`)); return i ? p : first(p, 'route-notice-body'); });
  return [
    first(para(t('chat.notice.p1a'), link(`${OR}/privacy`, 'chat.notice.privacy'), t('chat.notice.p1b'),
      link(`${OR}/terms`, 'chat.notice.terms'), t('chat.notice.p1c')), 'chat-notice-body'),
    para(t('chat.notice.listIntro')),
    el('ul', { class: 'disclaimer-body disclaimer-list' }, ...['li1', 'li2', 'li3'].map((k) => el('li', {}, t(`chat.notice.${k}`)))),
    ...['p2', 'p3', 'p4'].map((k) => para(t(`chat.notice.${k}`))),
  ];
}

const showing: Partial<Record<NoticeId, { dlg: HTMLElement; answer: Promise<boolean> }>> = {};

/** A second call while the notice is open gets the same answer, never a second dialog. */
export function showNotice(id: NoticeId): Promise<boolean> {
  const open = showing[id];
  if (open?.dlg.isConnected) return open.answer;
  const shown = build(id);
  showing[id] = shown;
  return shown.answer;
}

function build(id: NoticeId): { dlg: HTMLElement; answer: Promise<boolean> } {
  const version = id === 'route' ? ROUTE_NOTICE_VERSION : CHAT_NOTICE_VERSION;
  const cancel = el('button', { type: 'button', class: 'disclaimer-dismiss' }, t(`${id}.notice.cancel`));
  const accept = el('button', { type: 'button', class: 'disclaimer-accept' }, t(`${id}.notice.accept`));
  const dlg = el('dialog', { class: 'disclaimer-dialog', 'aria-labelledby': `${id}-notice-title`, 'aria-describedby': `${id}-notice-body` },
    el('div', { class: 'disclaimer-content' },
      el('div', { class: 'disclaimer-header' }, el('h2', { id: `${id}-notice-title` }, t(`${id}.notice.title`))),
      ...body(id),
      el('div', { class: 'disclaimer-footer wildfire-stale-footer' }, cancel, accept)));
  const answer = new Promise<boolean>((resolve) => {
    let ok = false;
    const shut = () => {
      if (typeof dlg.close === 'function') dlg.close();
      else { dlg.removeAttribute('open'); dlg.dispatchEvent(new Event('close')); }
    };
    accept.addEventListener('click', () => { ok = true; acceptNotice(id, version); shut(); });
    cancel.addEventListener('click', shut);
    dlg.addEventListener('close', () => { dlg.remove(); resolve(ok); });
    dlg.addEventListener('cancel', () => { ok = false; });
    document.body.append(dlg);
    if (typeof dlg.showModal === 'function') dlg.showModal(); else dlg.setAttribute('open', '');
    cancel.focus();
  });
  return { dlg, answer };
}
