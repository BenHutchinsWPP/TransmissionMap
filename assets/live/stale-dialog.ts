// ─── Stale-data dialog builder ────────────────────────────────────────────────
// Role: builds the "live data is stale" <dialog> of one feed (wildfire, NWS, ODIN) from nodes and
//       places it where index.html kept it (wildfire, odin, nws, then #creditsDialog) when the
//       feed's init function runs (called from ui.ts init()), so a
//       new live layer adds a config line instead of a block of index.html. The title, the two body
//       paragraphs, the buttons and the dialog's link all come from the `stale.<feed>.*` and
//       `stale.dismiss/reenable` strings; body 1 carries the age element (`ageElId`) inside its
//       string, so the translation runs here, once, before the feed's wiring looks the ids up.
//       ui.ts's lang:changed handler re-translates the page, these dialogs included.
// Deps: src/i18n/index.ts (updateDomTranslations), utils/utils-dom.ts (h).
// Used by: wildfire-staleness.ts, nws-staleness.ts, odin-outages.ts.

import { updateDomTranslations } from '../../src/i18n/index.js';
import { h } from '../utils/utils-dom.js';

const ORDER = ['wildfire', 'odin', 'nws'] as const;
const built = new Map<StaleDialogCfg['feed'], HTMLDialogElement>();

export interface StaleDialogCfg {
  feed: 'wildfire' | 'nws' | 'odin';   // the `stale.<feed>.*` string family
  dialogId: string;
  ageElId: string;                     // lives in the translated body 1
  reenableId: string;
  dismissId: string;
}

export function staleDialog(cfg: StaleDialogCfg): HTMLDialogElement {
  const dlg = h('dialog', 'disclaimer-dialog wildfire-stale-dialog');
  dlg.id = cfg.dialogId;

  const head = h('div', 'disclaimer-header');
  const title = h('h2');
  title.dataset.i18n = `stale.${cfg.feed}.title`;
  head.append(title);

  const body = (n: 1 | 2) => {
    const p = h('p', 'disclaimer-body');
    p.dataset.i18nHtml = `stale.${cfg.feed}.body${n}`;
    return p;
  };

  const button = (cls: string, id: string, key: string) => {
    const b = h('button', cls);
    b.id = id;
    b.type = 'button';
    b.dataset.i18n = key;
    return b;
  };
  const foot = h('div', 'disclaimer-footer wildfire-stale-footer');
  foot.append(
    button('disclaimer-dismiss', cfg.dismissId, 'stale.dismiss'),
    button('disclaimer-accept disclaimer-danger', cfg.reenableId, 'stale.reenable'),
  );

  const content = h('div', 'disclaimer-content');
  content.append(head, body(1), body(2), foot);
  dlg.append(content);
  const later = ORDER.slice(ORDER.indexOf(cfg.feed) + 1).map(f => built.get(f)).find(d => d?.isConnected);
  const next = later ?? document.getElementById('creditsDialog');
  if (next) next.before(dlg); else document.body.append(dlg);
  built.set(cfg.feed, dlg);
  updateDomTranslations(dlg);
  return dlg;
}
