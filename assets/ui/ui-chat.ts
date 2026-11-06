// ─── Map chat: the Ask tab of the table drawer (lazy chunk) ──────────────────
// Role: the visitor's side of the map agent, built into ui-table.ts's Ask pane
//       (askPanel / openAsk / closeAsk), so an answer and the table it opens
//       share the drawer, one tab at a time.
//         openChat(from?)  open the Ask pane (File ▸ Ask the map…), building
//                      the chat on first use — after the usage notice (notice-gate.ts,
//                      notice-dialog.ts) is accepted: until then nothing is built, no
//                      model list is fetched, and Cancel leaves the drawer as it was.
//         resumeChat()     (same notice first) after a reload of this tab whose drawer had Ask open
//                      (ui-table.ts restoreDrawer, from ui-menubar.ts's boot
//                      hook): rebuilt from the snapshot (empty when it fails
//                      validation) and opened without focus and without
//                      fetching the catalogue until the visitor touches the pane.
//       The conversation lasts the tab: sessionStorage `tm-chat`
//       (session-snapshot.ts) holds structured entries only, never markup, and
//       never the key (a pasted key is redacted). Validated on read
//       (validSnapshot, loop.ts validateHistory) and restored only on a reload
//       of the same link. A restore sends no request, writes no link and adds no
//       undo step. Vega and canvas cards come back as Re-run; a template card
//       re-validates its params (validateTemplateArgs) and an html one comes
//       back as Re-run, so a per-county card never repaints the main map on its
//       own. Whether Ask is open is ui-table.ts's `tm-drawer`, not this key's.
//       Each message goes to agent/loop.ts ask(): a local command runs at once
//       with no key and no network; anything else goes to the model with the
//       visitor's own OpenRouter key. A confirm card shows before a model's
//       place name goes to the geocoder; the call runs only on Search.
//       Everything the model or a tool returns is set as text (textContent,
//       append(string), attributes) — never as HTML; eslint.config.js holds
//       this module and assets/agent/ to it. Strings: data-i18n* for fixed
//       ones (ui.ts re-translates them), data-chat-key (+ params) for the rest,
//       redrawn here on lang:changed. Esc closes the chat (ui-table.ts) and
//       stops a request in flight; focus returns to what opened it.
//
// Deps: ui-table.ts (askPanel, openAsk), ui-chart.ts (chartCard), ui-canvas.ts
//       (canvasCard, closeAllCanvases; dynamic import), agent/loop.ts (ask, runLocal,
//       newSession, history, validateHistory), agent/local-commands.ts (localContext,
//       LOCAL_EXAMPLES), agent/openrouter.ts (models), agent/key-store.ts,
//       agent/tools.ts (dispatch: a restored canvas's Re-run), chart-spec.ts
//       (validateChart) + vega-spec.ts (validateVegaLite, vegaWithData,
//       rowsFromValue) + registry (layerById): a restored card's checks,
//       templates/show-template.ts (showTemplate, validateTemplateArgs) +
//       templates/catalogue.ts (templateById): template cards,
//       session-snapshot.ts (saveSnapshot, readSnapshot, clearSnapshot, onHidden), undo.ts (undo),
//       notice-gate.ts (noticeAccepted) + notice-dialog.ts (showNotice): the usage notice,
//       view-state.ts (currentView) + url-state-codec.ts (formatUrlState): the
//       view a chip's Undo compares, state-bus.ts (on), i18n (t).
// Loaded by: ui-menubar.ts (dynamic import: File ▸ Ask the map…, or its boot
//       hook when a restorable tm-drawer snapshot had Ask open — resumeChat).

import { askPanel, openAsk } from './ui-table.js';
import { chartCard } from './ui-chart.js';
import { renderMarkdown } from './chat-markdown.js';
import { validateChart, type Chart } from '../chart-spec.js';
import { validateVegaLite, vegaWithData, rowsFromValue, type Row } from '../vega-spec.js';
import { ask, runLocal, newSession, history, validateHistory, type ToolRun, type AskResult } from '../agent/loop.js';
import { localContext, LOCAL_EXAMPLES, type LocalContext, type LocalOption } from '../agent/local-commands.js';
import { DEFAULT_MODEL, RECOMMENDED_MODELS, listToolModels, providerOf, type ModelInfo, type ChatMessage } from '../agent/openrouter.js';
import { getKey, setKey, forgetKey, isRemembered } from '../agent/key-store.js';
import { dispatch, type OffPageRequest, type RenderExtra } from '../agent/tools.js';
import type { CopyDownload } from '../user-data/copy-fit.js';
import { layerById } from '../../src/registry/index.js';
import { showTemplate, validateTemplateArgs, TEMPLATE_ARGS } from '../templates/show-template.js';
import { templateById } from '../templates/catalogue.js';
import { saveSnapshot, readSnapshot, clearSnapshot, claimSnapshot, onHidden } from '../session-snapshot.js';
import type { CanvasKind, CanvasOutcome } from '../sandbox/canvas-host.js';
import { undo } from '../undo.js';
import { currentView } from '../view-state.js';
import { formatUrlState } from '../url-state-codec.js';
import { on } from '../state-bus.js';
import { t } from '../../src/i18n/index.js';
import { noticeAccepted, CHAT_NOTICE_VERSION } from './notice-gate.js';
import { showNotice } from './notice-dialog.js';

const KEY_URL = 'https://openrouter.ai/keys';
const MORE = '__more';
/** Tools whose success is a step on the undo stack. */
const COMMITTING = new Set(['setLayerVisible', 'setWhere', 'setArea', 'setStyle', 'clearStyle', 'setBasemap', 'setSelection', 'reset']);
/** The transcript snapshot in this tab's sessionStorage (session-snapshot.ts). */
export const CHAT_SNAPSHOT = 'tm-chat';
const MAX_SNAPSHOT_CHARS = 1_000_000;
const MAX_VEGA_CHARS = 200_000;
const MAX_TEXT = 100_000;
const MAX_ARGS_TEXT = 2_000;
const KEY_PATTERN = /sk-or-v1-[0-9a-f]{64}/g;
const MODEL_ID = /^[a-z0-9._-]+\/[a-z0-9._:-]+$/;

const session = newSession();
let model = DEFAULT_MODEL;
/** The tool-calling catalogue once it lands; whether the picker lists all of it. */
let catalogue: ModelInfo[] | null = null;
let allShown = false;
let pane: HTMLElement | null = null;
let busy: AbortController | null = null;
let ctx: Promise<LocalContext> | null = null;
/** The view before the next chip's call: a chip offers Undo only when its call changed it. */
let lastView = '';
/** ui-canvas.ts once a tool has rendered; canvas cards waiting for their call's chip. */
let canvasMod: typeof import('./ui-canvas.js') | null = null;
let unchipped: HTMLElement[] = [];
/** Restored Vega template cards waiting for a frame slot, and the claim of those slots. */
let redraws: (() => Promise<void>)[] = [];
let restoredDraws: Promise<void> = Promise.resolve();
/** A restore in progress (no saves). */
let restoring = false;
/** The next showCanvas render's code chip and layers, from onCall. */
let pendingCanvas: { code: number; layers?: unknown[] } | null = null;
let codeIds = 0;

// ─── DOM, as text only ───────────────────────────────────────────────────────
type Kid = Node | string | null | undefined | false;
function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...kids: Kid[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else e.setAttribute(k, v);
  }
  for (const k of kids) if (k) e.append(k);
  return e;
}

/** An element showing t(key, params), redrawn on lang:changed. */
function tx<K extends keyof HTMLElementTagNameMap>(tag: K, key: string, params?: Record<string, string | number>, attrs: Record<string, string> = {}) {
  const e = el(tag, attrs);
  setTx(e, key, params);
  return e;
}
function setTx(e: HTMLElement, key: string, params?: Record<string, string | number>) {
  e.dataset.chatKey = key;
  if (params) e.dataset.chatParams = JSON.stringify(params); else delete e.dataset.chatParams;
  e.textContent = t(key, params);
}

const q = <T extends HTMLElement = HTMLElement>(sel: string) => pane!.querySelector<T>(sel)!;
const viewKey = () => formatUrlState(currentView()).join('&');
const costText = () => `$${session.cost.toFixed(4)}`;

// ─── The transcript as data ──────────────────────────────────────────────────
// Each element in the log that a reload should bring back carries its entry
// (entryOf); a save reads them in DOM order, so cards placed before their
// chip, a closed canvas or a settled confirm are saved as they now stand.
type Params = Record<string, string | number>;
type Entry =
  | { t: 'user' | 'bot'; text: string }
  | { t: 'note'; key: string; params?: Params; cls: string }
  | { t: 'chip'; name: string; args: string; source: 'local' | 'model'; ok: boolean; reason?: string; dl?: true }
  | { t: 'code'; id: number; tool: string; code: string }
  | { t: 'chart'; chart: Chart }
  | { t: 'vega'; title: string; spec: Record<string, unknown>; rows: Row[]; csv?: string }
  | { t: 'canvas'; title: string; code: number; layers?: unknown[]; partial: string[] }
  | { t: 'template'; kind: CanvasKind; title: string; templateId: string; layer: string; params: Record<string, unknown> }
  | { t: 'confirm'; svc: boolean; text: string; host: string; vetNote: boolean; ok: boolean | null; copy?: true }
  | { t: 'choose'; labels: string[] };
type Card = Extract<Entry, { t: 'vega' | 'canvas' }>;
type TemplateEntry = Extract<Entry, { t: 'template' }>;
interface ChatSnapshot { busy: boolean; model: string; cost: number; messages: ChatMessage[]; entries: Entry[] }

const entryOf = new WeakMap<Element, Entry>();
function track<T extends Element>(node: T, e: Entry): T { entryOf.set(node, e); return node; }

// ─── Public entry points ─────────────────────────────────────────────────────
/** `from`: where focus returns when the chat closes (default: the focused element). */
export function openChat(from?: HTMLElement | null): void {
  if (!pane && !noticeAccepted('chat', CHAT_NOTICE_VERSION)) {
    // Nothing is built, opened or fetched until the visitor accepts; Cancel leaves the drawer as it was.
    void showNotice('chat').then((ok) => { if (ok) openChat(from); });
    return;
  }
  build();
  open(from);
  const keyShown = !q('.chat-key').hidden;
  (keyShown ? q('.chat-key-input') : q('.chat-input')).focus();
}

/** After a reload of this tab whose drawer had Ask open (ui-table.ts
 *  restoreDrawer): the chat rebuilt from tm-chat and opened, with no focus (no
 *  phone keyboard) and no catalogue fetch until the visitor touches the pane. */
export async function resumeChat(): Promise<void> {
  if (pane) return;
  if (!noticeAccepted('chat', CHAT_NOTICE_VERSION) && !(await showNotice('chat'))) return;
  if (pane) return;
  build(true);
  open(null);
  // The log was built out of view; show its end, as the live chat does.
  const log = q('.chat-log');
  log.scrollTop = log.scrollHeight;
  // The chat's redraws claim their frame slots before Visualize restores.
  return restoredDraws;
}

function open(from?: HTMLElement | null) {
  openAsk(() => { stop(); canvasMod?.closeAllCanvases(); touched(); }, from);
  touched();
}

function stop() { busy?.abort(); }

// ─── Building the pane (once) ────────────────────────────────────────────────
function build(quiet = false) {
  if (pane) return;
  pane = askPanel();
  const btn = (cls: string, key: string, attrs: Record<string, string> = {}) =>
    tx('button', key, undefined, { type: 'button', class: `td-btn ${cls}`, ...attrs });

  const select = el('select', { class: 'chat-model', 'aria-label': t('chat.model'), 'data-i18n-aria-label': 'chat.model' });
  fillModels(select);
  select.addEventListener('change', () => { void pickModel(select); });
  const loadCatalogue = () => { void listToolModels().then(list => { if (list) { catalogue = list; fillModels(select); } }); };
  if (quiet) {
    const kinds = ['pointerdown', 'focusin', 'keydown'] as const;
    const once = () => { for (const k of kinds) pane!.removeEventListener(k, once); loadCatalogue(); };
    for (const k of kinds) pane.addEventListener(k, once);
  } else loadCatalogue();

  const keyBtn = btn('chat-key-btn', 'chat.key', { 'aria-expanded': 'false', 'aria-controls': 'chat-key' });
  keyBtn.addEventListener('click', () => showKeyForm(q('.chat-key').hidden === true));

  const bar = el('div', { class: 'chat-bar' }, select, tx('span', 'chat.cost', { cost: costText() }, { class: 'chat-cost' }), keyBtn);

  const keyInput = el('input', {
    class: 'chat-key-input', type: 'password', autocomplete: 'off', spellcheck: 'false',
    placeholder: 'sk-or-v1-…', 'aria-describedby': 'chat-key-status',
  });
  const remember = el('input', { type: 'checkbox', class: 'chat-remember-box' });
  remember.addEventListener('change', () => {
    const k = getKey();
    if (k) { setKey(k, remember.checked); syncKey(); }
  });
  const connect = btn('chat-connect', 'chat.connect');
  const forget = btn('chat-forget', 'chat.forget');
  const keyForm = el('div', { class: 'chat-key', id: 'chat-key', hidden: '' },
    tx('p', 'chat.keyIntro'),
    el('label', {}, tx('span', 'chat.keyLabel'), keyInput),
    el('label', { class: 'chat-remember' }, remember, tx('span', 'chat.remember')),
    el('div', { class: 'chat-key-actions' }, connect, forget,
      tx('a', 'chat.getKey', undefined, { href: KEY_URL, target: '_blank', rel: 'noopener noreferrer' })),
    el('p', { class: 'chat-key-status', id: 'chat-key-status', role: 'status' }),
    tx('p', 'chat.keyNote'));
  const doConnect = () => {
    if (!setKey(keyInput.value, remember.checked)) { setTx(q('.chat-key-status'), 'chat.keyBad'); q('.chat-key-status').dataset.bad = ''; return; }
    keyInput.value = '';
    syncKey();
    showKeyForm(false);
    q('.chat-input').focus();
  };
  connect.addEventListener('click', doConnect);
  keyInput.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); doConnect(); } });
  forget.addEventListener('click', () => {
    forgetKey();
    keyInput.value = '';
    remember.checked = false;
    syncKey('chat.keyForgotten');
    keyInput.focus();
  });

  const log = el('div', { class: 'chat-log', role: 'log', 'aria-live': 'polite', 'aria-label': t('chat.log'), 'data-i18n-aria-label': 'chat.log', tabindex: '0' },
    tx('p', 'chat.welcome', { examples: LOCAL_EXAMPLES.map(x => `“${x}”`).join(', ') }, { class: 'chat-msg chat-hint' }));
  // A log at its end stays there when the pane narrows (the table opening beside it).
  let atEnd = true;
  log.addEventListener('scroll', () => { atEnd = log.scrollHeight - log.scrollTop - log.clientHeight < 4; });
  if (globalThis.ResizeObserver) new ResizeObserver(() => { if (atEnd) log.scrollTop = log.scrollHeight; }).observe(log);

  const input = el('input', {
    class: 'chat-input', type: 'text', autocomplete: 'off', maxlength: '2000',
    'aria-label': t('chat.input'), 'data-i18n-aria-label': 'chat.input',
    placeholder: t('chat.placeholder'), 'data-i18n-placeholder': 'chat.placeholder',
  });
  const send = tx('button', 'chat.send', undefined, { type: 'submit', class: 'td-btn chat-send' });
  const stopBtn = btn('chat-stop', 'chat.stop', { hidden: '' });
  stopBtn.addEventListener('click', stop);
  const form = el('form', { class: 'chat-form' }, input, send, stopBtn);
  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const text = input.value.trim();
    if (!text || busy) return;
    input.value = '';
    void submit(text);
  });

  pane.replaceChildren(bar, keyForm, log, form, tx('p', 'chat.disclaimer', undefined, { class: 'chat-note' }));
  remember.checked = isRemembered();
  syncKey();
  const snap = readSnapshot(CHAT_SNAPSHOT, validSnapshot);
  if (snap) restore(snap);
  // A restored conversation stays readable; the next model question asks for the key.
  if (!getKey() && !snap?.entries.length) showKeyForm(true, false);

  on('undo:changed', syncUndo);
  on('lang:changed', () => {
    ctx = null;
    pane!.querySelectorAll<HTMLElement>('[data-chat-key]').forEach(e => {
      e.textContent = t(e.dataset.chatKey!, e.dataset.chatParams ? JSON.parse(e.dataset.chatParams) : undefined);
    });
    fillModels(q<HTMLSelectElement>('.chat-model'));
  });
  claimSnapshot(CHAT_SNAPSHOT);
  onHidden(save);
}

// ─── Key ─────────────────────────────────────────────────────────────────────
function showKeyForm(show: boolean, focus = true) {
  q('.chat-key').hidden = !show;
  q('.chat-log').hidden = show;
  q('.chat-key-btn').setAttribute('aria-expanded', String(show));
  if (show && focus) q('.chat-key-input').focus();
}

function syncKey(override?: string) {
  const s = q('.chat-key-status');
  delete s.dataset.bad;
  setTx(s, override ?? (!getKey() ? 'chat.keyNone' : isRemembered() ? 'chat.keyRemembered' : 'chat.keySet'));
  q('.chat-forget').hidden = !getKey() && !isRemembered();
}

// ─── Model picker ────────────────────────────────────────────────────────────
// One group per provider: the recommended set's providers first, in its order,
// then the rest A–Z; in a group the recommended models first, then by price.
const usd = (perToken: number) => { const v = perToken * 1e6; return `$${v.toFixed(v < 1 ? 2 : 1)}`; };

function modelLabel(id: string, m: ModelInfo | undefined): string {
  if (!m) return id;
  const iq = m.intelligence === null ? '–' : String(Math.round(m.intelligence));
  return `${m.name} · ${iq} · ${usd(m.promptPrice)}/${usd(m.completionPrice)}${m.free ? ` (${t('chat.free')})` : ''}`;
}

function fillModels(select: HTMLSelectElement) {
  const byId = new Map((catalogue ?? []).map(m => [m.id, m]));
  const rest = allShown ? (catalogue ?? []).filter(m => !RECOMMENDED_MODELS.includes(m.id)).map(m => m.id) : [];
  const ids = [...RECOMMENDED_MODELS, ...rest];
  // A model picked before a reload stays listed before the catalogue is fetched.
  if (!ids.includes(model)) ids.push(model);
  // Grouped by the id's provider; the group shows the catalogue's name for it.
  const label = new Map((catalogue ?? []).map(m => [providerOf(m.id), m.provider]));
  const groups = new Map<string, string[]>();
  for (const id of ids) groups.set(providerOf(id), [...(groups.get(providerOf(id)) ?? []), id]);
  // Map order is first appearance, so the recommended set's providers lead.
  const first = new Set(RECOMMENDED_MODELS.map(providerOf));
  const name = (g: string) => label.get(g) ?? g;
  const order = [...first, ...[...groups.keys()].filter(g => !first.has(g)).sort((x, y) => name(x).localeCompare(name(y)))];
  const kids: HTMLElement[] = [];
  if (catalogue) kids.push(Object.assign(new Option(t('chat.modelHint'), ''), { disabled: true }));
  for (const g of order) {
    const group = el('optgroup', { label: name(g) });
    for (const id of groups.get(g)!) group.append(new Option(modelLabel(id, byId.get(id)), id));
    kids.push(group);
  }
  if (!allShown) kids.push(new Option(t('chat.moreModels'), MORE));
  select.replaceChildren(...kids);
  select.value = model;
}

async function pickModel(select: HTMLSelectElement) {
  if (select.value !== MORE) { model = select.value; touched(); return; }
  select.value = model;
  const more = select.querySelector<HTMLOptionElement>(`option[value="${MORE}"]`)!;
  more.text = t('chat.loadingModels');
  select.disabled = true;
  const list = await listToolModels();
  select.disabled = false;
  if (!list) { more.text = t('chat.moreModels'); addNote('chat.modelsFailed', undefined, 'chat-err'); return; }
  catalogue = list;
  allShown = true;
  fillModels(select);
  select.focus();
}

// ─── The conversation ────────────────────────────────────────────────────────
function append(node: HTMLElement) {
  const log = q('.chat-log');
  log.append(node);
  log.scrollTop = log.scrollHeight;
  touched();
  return node;
}

/** A note; `keep` false for one a reload should not bring back (the working line). */
function addNote(key: string, params?: Record<string, string | number>, cls = 'chat-hint', keep = true) {
  const e: Entry = { t: 'note', key, ...(params && { params }), cls };
  return append(keep ? renderEntry(e) : tx('p', key, params, { class: `chat-msg ${cls}` }));
}

/** A chip without its Undo: where the call ran, what it was asked, how it went. */
function chipEl(e: Extract<Entry, { t: 'chip' }>, summary = `${e.name} ${e.args}`.trim()) {
  const chip = el('div', { class: 'chat-chip', 'data-source': e.source, 'data-ok': String(e.ok), 'data-tool': e.name },
    tx('span', e.source === 'local' ? 'chat.local' : 'chat.modelBadge', undefined, { class: 'chat-chip-src' }),
    el('details', { class: 'chat-chip-text' }, el('summary', { title: summary }, summary)));
  if (!e.ok && e.reason !== undefined) chip.append(el('span', { class: 'chat-chip-why', title: e.reason }, e.reason));
  const state = e.ok ? 'chat.done' : 'chat.failed';
  if (e.dl) chip.append(tx('span', 'chat.copyDownloadGone', undefined, { class: 'chat-chip-why' }));
  chip.append(el('span', { class: 'chat-chip-state', role: 'img', 'aria-label': t(state), 'data-i18n-aria-label': state }, e.ok ? '✓' : '✕'));
  return chip;
}

/** A tool call as a chip, with Undo on a call that changed the view. */
function addChip(run: ToolRun) {
  const now = viewKey();
  const changed = now !== lastView;
  lastView = now;
  const e: Entry = {
    t: 'chip', name: run.name, args: argsText(withoutCode(run.name, run.args)).slice(0, MAX_ARGS_TEXT), source: run.source, ok: run.outcome.ok,
    ...(!run.outcome.ok && { reason: run.outcome.reason.slice(0, MAX_ARGS_TEXT) }),
  };
  // A copy that could not be saved offers its GeoJSON once; the file itself is never stored (a restored chip says so).
  const dl = run.outcome.ok && run.name === 'copyToMyData'
    ? (run.outcome.result as { outcome?: string; download?: CopyDownload } | null) : null;
  const download = dl?.outcome === 'download-offered' ? dl.download : undefined;
  if (download) e.dl = true;
  const chip = track(chipEl(download ? { ...e, dl: undefined } : e, `${run.name} ${argsText(run.args)}`.trim()), e);
  if (download) {
    const b = tx('button', 'chat.copyDownload', { size: (download.chars / 1e6).toFixed(1) }, { type: 'button', class: 'td-link chat-copy-download' });
    b.addEventListener('click', () => { void import('../user-data/copy-fit.js').then(m => m.downloadCopy(download)); });
    chip.querySelector('.chat-chip-state')!.before(b);
  }
  if (run.outcome.ok && COMMITTING.has(run.name) && changed) {
    const b = tx('button', 'chat.undo', undefined, { type: 'button', class: 'td-link chat-undo', 'data-view': now });
    b.addEventListener('click', () => { if (b.dataset.view === viewKey()) undo(); });
    chip.querySelector('.chat-chip-state')!.before(b);
  }
  // A canvas card shown during the call goes after the call's chip.
  if (unchipped[0]?.isConnected) { unchipped[0].before(chip); touched(); } else append(chip);
  unchipped = [];
  const chart = run.outcome.ok ? (run.outcome.result as { chart?: Chart } | null)?.chart : undefined;
  if (chart) append(renderEntry({ t: 'chart', chart }));
}

/** A chip's Undo works while the view is still the one its call left. */
function syncUndo() {
  if (!pane) return;
  const now = viewKey();
  pane.querySelectorAll<HTMLButtonElement>('.chat-undo').forEach(b => { b.disabled = b.dataset.view !== now; });
}

/** `{layerId: "railroads", on: false}` → `layerId=railroads on=false`;
 *  nested values as JSON without the quotes. */
function argsText(args: unknown): string {
  if (!args || typeof args !== 'object') return args === undefined ? '' : String(args);
  return Object.entries(args as Record<string, unknown>)
    .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)?.replace(/"/g, '')}`).join(' ');
}

/** Which argument of which tool is model-written code, its chip's label and cap. */
const CODE_CHIPS: Record<string, { arg: string; label: string; max: number }> = {
  runAnalysis: { arg: 'code', label: 'chat.analysisCode', max: 20_000 },
  showCanvas: { arg: 'html', label: 'chat.canvasCode', max: 60_000 },
};
const codeChip = (name: string) => (Object.hasOwn(CODE_CHIPS, name) ? CODE_CHIPS[name] : undefined);

/** A call's arguments without its code (the code chip keeps the one stored copy). */
function withoutCode(name: string, args: unknown): unknown {
  const chip = codeChip(name);
  if (!chip || !args || typeof args !== 'object' || Array.isArray(args)) return args;
  return Object.fromEntries(Object.entries(args).filter(([k]) => k !== chip.arg));
}

/** The code a model is about to run, before it runs: collapsed, as text in a <pre>. */
function addCode(name: string, args: unknown) {
  const chip = codeChip(name);
  const a = args as Record<string, unknown> | null;
  const code = chip && a?.[chip.arg];
  if (!chip || typeof code !== 'string') return;
  const e: Entry = { t: 'code', id: ++codeIds, tool: name, code: code.slice(0, chip.max) };
  append(renderEntry(e));
  if (name === 'showCanvas') pendingCanvas = { code: e.id, ...(Array.isArray(a?.layers) && { layers: a.layers as unknown[] }) };
}

function addChoose(r: Extract<AskResult, { kind: 'choose' }>, text: string) {
  const box = track(el('div', { class: 'chat-choose', role: 'group' }), { t: 'choose', labels: r.options.map(o => o.label) });
  const pick = async (o: LocalOption) => {
    box.querySelectorAll('button').forEach(b => { b.disabled = true; });
    lastView = viewKey();
    await runLocal(session, text, o.call, { onRun: addChip });
    syncUndo();
    touched();
  };
  for (const o of r.options) {
    const b = el('button', { type: 'button', class: 'td-btn' }, o.label);
    b.addEventListener('click', () => { void pick(o); });
    box.append(b);
  }
  addNote(r.what === 'area' ? 'chat.chooseArea' : 'chat.chooseLayer');
  append(box);
  if (r.more) addNote('chat.more', { n: r.more });
  box.querySelector('button')?.focus();
}

/** What a reload keeps of a canvas or Vega card, or null. A canvas needs its
 *  code chip (the html) and keeps its call's layers; a Vega card keeps its spec,
 *  rows and the CSV built at render time. */
function cardEntry(kind: CanvasKind, title: string, payload: unknown, extra: RenderExtra | undefined): Card | TemplateEntry | null {
  const tpl = extra?.template;
  if (tpl) return { t: 'template', kind, title, templateId: tpl.templateId, layer: tpl.layer, params: tpl.params };
  if (kind === 'html') {
    const p = pendingCanvas;
    pendingCanvas = null;
    return p ? { t: 'canvas', title, code: p.code, ...(p.layers && { layers: p.layers }), partial: extra?.partial ?? [] } : null;
  }
  if (!isObj(payload) || !isObj(payload.data)) return null;
  const { data, ...spec } = payload;
  const rows = rowsFromValue(data.values);
  if (!rows) return null;
  let csv: string | undefined;
  try { csv = extra?.csv?.(); } catch { csv = undefined; }
  return { t: 'vega', title, spec, rows, ...(csv !== undefined && { csv }) };
}

/** A tool's canvas page or Vega chart, as a card in the conversation; resolves with the frame's outcome. */
async function showCanvas(kind: CanvasKind, title: string, payload: unknown, inputs: unknown, extra: RenderExtra | undefined, signal: AbortSignal): Promise<CanvasOutcome> {
  const e = cardEntry(kind, title, payload, extra);
  try { canvasMod ??= await import('./ui-canvas.js'); } catch { return { error: 'unavailable' }; }
  const card = canvasMod.canvasCard(title, { kind, payload, inputs }, { signal, ...cardOpts(extra, e) });
  unchipped.push(append(e ? track(card.el, e) : card.el));
  return card.done;
}

/** A card's options; a template card (with its entry) re-runs through showTemplate, so an evicted frame lets go of its payload. */
const cardOpts = (extra: RenderExtra | undefined, e?: Card | TemplateEntry | null) => ({
  csv: extra?.csv, partial: extra?.partial, table: extra?.table, ...(extra?.template && { template: true, onAction: extra.onAction, signals: extra.signals, overlay: extra.overlay }),
  ...(extra?.template && e?.t === 'template' && { rerun: (card: HTMLElement) => rerunTemplate(e, card) }),
});

/** A confirm card's question; `result` is its settled line. */
function confirmCard(e: Extract<Entry, { t: 'confirm' }>) {
  const card = track(el('div', { class: 'chat-card', role: 'group' },
    tx('p', e.copy ? 'chat.confirmCopy' : e.svc ? 'chat.confirmService' : 'chat.confirm', { text: e.text, host: e.host }),
    ...(e.vetNote ? [tx('p', 'chat.notVetted')] : [])), e);
  const result = (ok: boolean) => tx('p', e.copy ? (ok ? 'chat.copied' : 'chat.notCopied') : e.svc ? (ok ? 'chat.added' : 'chat.notAdded') : ok ? 'chat.sent' : 'chat.notSent', { host: e.host }, { class: 'chat-card-result' });
  return { card, result };
}

/** Ask the visitor before a model's text leaves the page (the geocoder). */
function confirmOffPage(req: OffPageRequest, signal: AbortSignal): Promise<boolean> {
  return new Promise(resolve => {
    const e: Extract<Entry, { t: 'confirm' }> = { t: 'confirm', svc: req.tool === 'addService', text: req.text, host: req.host, vetNote: !!req.note, ok: null,
      ...(req.tool === 'copyToMyData' && { copy: true as const }) };
    const { card, result } = confirmCard(e);
    const yes = tx('button', e.copy ? 'chat.confirmCopyYes' : e.svc ? 'chat.confirmAdd' : 'chat.confirmYes', undefined, { type: 'button', class: 'td-btn chat-confirm-yes' });
    const no = tx('button', e.copy ? 'chat.confirmCopyNo' : e.svc ? 'chat.confirmNoAdd' : 'chat.confirmNo', undefined, { type: 'button', class: 'td-btn chat-confirm-no' });
    const actions = el('div', { class: 'chat-card-actions' }, yes, no);
    card.append(actions);
    const done = (ok: boolean) => {
      signal.removeEventListener('abort', abort);
      e.ok = ok;
      actions.replaceWith(result(ok));
      touched();
      resolve(ok);
    };
    const abort = () => done(false);
    signal.addEventListener('abort', abort);
    yes.addEventListener('click', () => done(true));
    no.addEventListener('click', () => done(false));
    append(card);
    yes.focus();
  });
}

function setBusy(on: boolean) {
  q('.chat-send').hidden = on;
  q('.chat-stop').hidden = !on;
}

async function submit(text: string) {
  showKeyForm(false);
  append(renderEntry({ t: 'user', text }));
  const ctl = new AbortController();
  busy = ctl;
  setBusy(true);
  const working = addNote('chat.working', undefined, 'chat-hint chat-working', false);
  lastView = viewKey();
  ctx ??= localContext();
  let r: AskResult;
  try {
    r = await ask(session, text, {
      key: getKey(), model, signal: ctl.signal, local: await ctx,
      confirm: req => confirmOffPage(req, ctl.signal), onRun: addChip, onCall: addCode,
      render: (kind, title, payload, inputs, extra) => showCanvas(kind, title, payload, inputs, extra, ctl.signal),
    });
  } catch {
    r = { kind: 'error', code: 'server', runs: [] };
  }
  working.remove();
  busy = null;
  setBusy(false);
  if (r.kind === 'answer') { if (r.text) append(renderEntry({ t: 'bot', text: r.text })); }
  else if (r.kind === 'choose') addChoose(r, text);
  else if (r.code === 'no-key') {
    addNote('chat.error.no-key', undefined, 'chat-err');
    showKeyForm(true);
    setTx(q('.chat-key-status'), 'chat.error.no-key');
  } else addNote(`chat.error.${r.code}`, undefined, 'chat-err');
  setTx(q('.chat-cost'), 'chat.cost', { cost: costText() });
  syncUndo();
  touched();
  if (r.kind !== 'choose' && !(r.kind === 'error' && r.code === 'no-key')) q('.chat-input').focus();
}

// ─── One builder per entry: the live chat and a restore share it ─────────────
function renderEntry(e: Entry): HTMLElement {
  switch (e.t) {
    case 'user': return track(el('p', { class: 'chat-msg chat-user' }, e.text), e);
    case 'bot': return track(el('div', { class: 'chat-msg chat-bot' }, renderMarkdown(e.text)), e);
    case 'note': return track(tx('p', e.key, e.params, { class: `chat-msg ${e.cls}` }), e);
    case 'chip': return track(chipEl(e), e);   // a restored copy-download chip says "copy again": no button
    case 'code': return track(el('details', { class: 'chat-chip chat-code', 'data-tool': e.tool },
      tx('summary', CODE_CHIPS[e.tool].label), el('pre', {}, e.code)), e);
    case 'chart': return track(chartCard(e.chart), e);
    case 'vega': case 'canvas': return track(placeholder(e), e);
    case 'template': return track(templatePlaceholder(e), e);
    case 'confirm': { const { card, result } = confirmCard(e); card.append(result(e.ok === true)); return card; }
    case 'choose': return track(el('div', { class: 'chat-choose', role: 'group' },
      ...e.labels.map(l => Object.assign(el('button', { type: 'button', class: 'td-btn' }, l), { disabled: true }))), e);
  }
}

/** A restored canvas or Vega card: its title and Re-run; no frame and no model
 *  code runs until the visitor clicks. */
function placeholder(e: Card): HTMLElement {
  const again = tx('button', 'canvas.rerun', undefined, { type: 'button', class: 'td-btn chat-canvas-rerun' });
  const why = el('p', { class: 'chat-canvas-error', role: 'status' });
  const card = el('figure', { class: 'chat-canvas chat-canvas-restored', 'data-kind': e.t === 'vega' ? 'vega' : 'html' },
    el('figcaption', { class: 'chat-canvas-title' }, e.title),
    el('p', { class: 'chat-canvas-closed' }, tx('span', e.t === 'vega' ? 'chat.restore.vega' : 'chat.restore.canvas'), ' ', again), why);
  again.addEventListener('click', () => { void rerun(e, card, again, why); });
  return card;
}

/** Re-run a restored card. A canvas goes through dispatch('showCanvas') as the
 *  model's call did — checkArgs, the stored layers read again by layerRows
 *  (the layers' current data) and the input caps — with the html from its code
 *  chip; a Vega card redraws its stored rows after validateVegaLite. */
async function rerun(e: Card, card: HTMLElement, btn: HTMLButtonElement, why: HTMLElement) {
  btn.disabled = true;
  why.replaceChildren();
  const failed = (reason: string) => { if (card.isConnected) { why.textContent = reason; btn.disabled = false; } };
  try { canvasMod ??= await import('./ui-canvas.js'); } catch { failed(t('canvas.error.unavailable')); return; }
  const mod = canvasMod;
  const show = (kind: CanvasKind, title: string, payload: unknown, inputs?: unknown, extra?: RenderExtra): Promise<CanvasOutcome> => {
    if (!card.isConnected) return Promise.resolve({ error: 'unavailable' });
    const c = mod.canvasCard(title, { kind, payload, inputs }, { csv: extra?.csv, partial: extra?.partial });
    if (kind === 'html') c.el.append(tx('p', 'chat.restore.current', undefined, { class: 'chat-canvas-partial' }));
    // The live card keeps the entry, so a later save stores it as a placeholder again.
    card.replaceWith(track(c.el, e));
    return c.done;
  };
  if (e.t === 'vega') {
    const spec = validateVegaLite(e.spec);
    if (!spec.ok) { failed(spec.reason); return; }
    const csv = e.csv;
    void show('vega', e.title, vegaWithData(spec.result, e.rows), undefined, csv !== undefined ? { csv: () => csv } : undefined);
    return;
  }
  const code = [...q('.chat-log').children].map(c => entryOf.get(c)).find(x => x?.t === 'code' && x.id === e.code);
  if (code?.t !== 'code') { failed(t('canvas.error.unavailable')); return; }
  const r = await dispatch('showCanvas', { title: e.title, html: code.code, ...(e.layers && { layers: e.layers }) }, { render: show });
  if (!r.ok) failed(r.reason);
}

/** A restored template card: Re-run shows it again through showTemplate with
 *  its stored params; a Vega one is queued for redrawRestored (drawn again at
 *  once when a frame slot is free, like a chart card). */
function templatePlaceholder(e: TemplateEntry): HTMLElement {
  const again = tx('button', 'canvas.rerun', undefined, { type: 'button', class: 'td-btn chat-canvas-rerun' });
  const why = el('p', { class: 'chat-canvas-error', role: 'status' });
  const card = el('figure', { class: 'chat-canvas chat-canvas-restored', 'data-kind': e.kind, 'data-template': '' },
    el('figcaption', { class: 'chat-canvas-title' }, e.title),
    el('p', { class: 'chat-canvas-closed' }, tx('span', 'chat.restore.canvas'), ' ', again), why);
  const run = async () => {
    if (!card.isConnected) return;
    again.disabled = true;
    why.replaceChildren();
    const reason = await rerunTemplate(e, card);
    if (reason !== null && card.isConnected) { why.textContent = reason; again.disabled = false; }
  };
  again.addEventListener('click', () => { void run(); });
  if (e.kind === 'vega' && restoring) redraws.push(run);
  return card;
}

/** The restored Vega template cards drawn again, but only into free frame slots
 *  (ui-canvas.ts claimRestoreSlots, shared with Visualize: ≤ MAX_LIVE, never an
 *  eviction), the newest first — the log's end, where it is scrolled; the rest
 *  stay Re-run. Resolves once the slots are claimed, not when the charts draw. */
async function redrawRestored(runs: (() => Promise<void>)[]): Promise<void> {
  if (!runs.length) return;
  try { canvasMod ??= await import('./ui-canvas.js'); } catch { return; }
  const mod = canvasMod;
  const k = mod.claimRestoreSlots(runs.length);
  for (const run of runs.slice(runs.length - k).reverse()) void run().finally(() => mod.releaseRestoreSlot());
}

/** Show a template card again through showTemplate with its params, in place of
 *  `card`; null when shown, else the reason for the visitor. */
async function rerunTemplate(e: TemplateEntry, card: HTMLElement): Promise<string | null> {
  if (!card.isConnected) return null;
  try { canvasMod ??= await import('./ui-canvas.js'); } catch { return t('canvas.error.unavailable'); }
  const mod = canvasMod;
  const render = (kind: CanvasKind, title: string, payload: unknown, inputs?: unknown, extra?: RenderExtra): Promise<CanvasOutcome> => {
    if (!card.isConnected) return Promise.resolve({ error: 'unavailable' });
    // The live card keeps the entry (with the params it was drawn from), so a later save stores it again.
    const next = extra?.template ? { ...e, title, params: extra.template.params } : e;
    const c = mod.canvasCard(title, { kind, payload, inputs }, cardOpts(extra, next));
    c.el.append(tx('p', 'chat.restore.current', undefined, { class: 'chat-canvas-partial' }));
    card.replaceWith(track(c.el, next));
    return c.done;
  };
  const r = await showTemplate({ ...e.params, template: e.templateId, layer: e.layer }, { render });
  return r.ok ? null : r.reason;
}

// ─── Save and restore (this tab's sessionStorage) ────────────────────────────
// The transcript, the model history as history() would send it next, the model
// and the session's cost; never the key (even pasted into the composer). Saved
// on hidden / pagehide, and again on every change while the page is hidden, so
// a reply landing in the background is kept. The drawer's layout is not here.
function snapshot(): ChatSnapshot {
  const entries = [...q('.chat-log').children].flatMap((c): Entry[] => {
    const e = entryOf.get(c);
    if (!e) return [];
    return e.t === 'vega' && JSON.stringify(e).length > MAX_VEGA_CHARS ? [tooLarge(e.title)] : [e];
  });
  const snap: ChatSnapshot = {
    busy: !!busy, model, cost: session.cost,
    messages: history(session.messages, session.messages.length), entries,
  };
  return JSON.parse(JSON.stringify(snap).replace(KEY_PATTERN, '(key removed)')) as ChatSnapshot;
}

const tooLarge = (title: string): Entry => ({ t: 'note', key: 'chat.restore.tooLarge', params: { title }, cls: 'chat-hint' });

/** The model history restricted to exchanges the transcript still shows: an
 *  exchange (from a visitor message to the next) is kept only when a `user` entry
 *  with the same text is kept, matched latest first, so a message the visitor
 *  never saw is not sent on the next ask. */
export function seenExchanges(messages: ChatMessage[], entries: Entry[]): ChatMessage[] {
  const seen = new Map<string, number>();
  for (const e of entries) if (e.t === 'user') seen.set(e.text, (seen.get(e.text) ?? 0) + 1);
  const starts = messages.flatMap((m, i) => (m.role === 'user' ? [i] : []));
  const keep = new Set<number>();
  for (const i of starts.reverse()) {
    const text = (messages[i] as { content: string }).content;
    const n = seen.get(text) ?? 0;
    if (n > 0) { seen.set(text, n - 1); keep.add(i); }
  }
  let on = false;
  return messages.filter((m, i) => { if (m.role === 'user') on = keep.has(i); return on; });
}

/** Over budget: a canvas or Vega card becomes a note, oldest first; then the oldest entries go. */
function shrinkChat(s: ChatSnapshot): ChatSnapshot | null {
  const i = s.entries.findIndex(e => e.t === 'vega' || e.t === 'canvas');
  if (i >= 0) {
    const entries = [...s.entries];
    entries[i] = tooLarge((entries[i] as Card).title);
    return { ...s, entries };
  }
  if (!s.entries.length) return null;
  // The exchanges of the dropped entries go too. No canvas is left by now (each became a note above), so no code entry is still referenced.
  const entries = s.entries.slice(Math.ceil(s.entries.length / 10));
  return { ...s, entries, messages: seenExchanges(s.messages, entries) };
}

function save() {
  if (!pane || restoring) return;
  const s = snapshot();
  if (!s.entries.length && !s.messages.length) { clearSnapshot(CHAT_SNAPSHOT); return; }
  saveSnapshot(CHAT_SNAPSHOT, s, { shrink: shrinkChat, maxChars: MAX_SNAPSHOT_CHARS });
}

/** A change while the page is hidden is saved at once. */
function touched() {
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') save();
}

function restore(s: ChatSnapshot) {
  restoring = true;
  try {
    session.messages = s.messages;
    session.cost = s.cost;
    model = s.model;
    fillModels(q<HTMLSelectElement>('.chat-model'));
    for (const e of s.entries) {
      if (e.t === 'code') codeIds = Math.max(codeIds, e.id);
      append(renderEntry(e));
    }
    restoredDraws = redrawRestored(redraws);
    redraws = [];
    // A turn the reload cut off before any reply: say so, neutrally.
    const last = s.entries.map(e => e.t).lastIndexOf('user');
    const replied = s.entries.slice(last + 1).some(e => e.t === 'bot' || (e.t === 'note' && e.cls === 'chat-err'));
    if (s.busy && last >= 0 && !replied) addNote('chat.interrupted');
    setTx(q('.chat-cost'), 'chat.cost', { cost: costText() });
  } finally {
    restoring = false;
  }
}

// ─── Reading a snapshot: untrusted input ─────────────────────────────────────
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown, max = MAX_TEXT): v is string => typeof v === 'string' && v.length <= max;
const NOTE_KEY = /^(chat|canvas)\.[A-Za-z0-9.-]{1,60}$/;
const NOTE_CLS = new Set(['chat-hint', 'chat-err']);

function validParams(v: unknown): Params | undefined | null {
  if (v === undefined) return undefined;
  if (!isObj(v) || Object.keys(v).length > 8) return null;
  for (const [k, x] of Object.entries(v)) {
    if (!/^[A-Za-z]{1,20}$/.test(k) || !(str(x, 2000) || (typeof x === 'number' && Number.isFinite(x)))) return null;
  }
  return v as Params;
}

function validChart(v: unknown): Chart | null {
  if (!isObj(v)) return null;
  const { layers, complete, ...spec } = v;
  const c = validateChart(spec);
  if (!c.ok || typeof complete !== 'boolean' || !Array.isArray(layers) || layers.length > 8
    || !layers.every(l => typeof l === 'string' && layerById(l))) return null;
  return { ...c.result, layers: layers as string[], complete };
}

const strings = (v: unknown, n: number, max: number): v is string[] => Array.isArray(v) && v.length <= n && v.every(x => str(x, max));

function validEntry(v: unknown, codes: Map<number, string>): Entry | null {
  if (!isObj(v)) return null;
  switch (v.t) {
    case 'user': case 'bot': return str(v.text) ? { t: v.t, text: v.text } : null;
    case 'note': {
      const params = validParams(v.params);
      return typeof v.key === 'string' && NOTE_KEY.test(v.key) && typeof v.cls === 'string' && NOTE_CLS.has(v.cls) && params !== null
        ? { t: 'note', key: v.key, ...(params && { params }), cls: v.cls } : null;
    }
    case 'chip':
      return str(v.name, 64) && str(v.args, MAX_ARGS_TEXT) && (v.source === 'local' || v.source === 'model') && typeof v.ok === 'boolean'
        && (v.reason === undefined || str(v.reason, MAX_ARGS_TEXT)) && (v.dl === undefined || v.dl === true)
        ? { t: 'chip', name: v.name, args: v.args, source: v.source, ok: v.ok, ...(v.reason !== undefined && { reason: v.reason }), ...(v.dl && { dl: true as const }) } : null;
    case 'code': {
      const chip = typeof v.tool === 'string' ? codeChip(v.tool) : undefined;
      if (!chip || !Number.isInteger(v.id) || !str(v.code, chip.max) || codes.has(v.id as number)) return null;
      codes.set(v.id as number, v.tool as string);
      return { t: 'code', id: v.id as number, tool: v.tool as string, code: v.code };
    }
    case 'chart': { const chart = validChart(v.chart); return chart ? { t: 'chart', chart } : null; }
    case 'vega': {
      const spec = validateVegaLite(v.spec);
      const rows = rowsFromValue(v.rows);
      return str(v.title, 200) && spec.ok && rows && (v.csv === undefined || str(v.csv, MAX_VEGA_CHARS))
        ? { t: 'vega', title: v.title, spec: spec.result, rows, ...(v.csv !== undefined && { csv: v.csv }) } : null;
    }
    case 'canvas':
      return str(v.title, 200) && Number.isInteger(v.code) && codes.get(v.code as number) === 'showCanvas' && strings(v.partial, 4, 200)
        && (v.layers === undefined || (Array.isArray(v.layers) && v.layers.length <= 4 && v.layers.every(isObj)))
        ? { t: 'canvas', title: v.title, code: v.code as number, partial: v.partial, ...(v.layers !== undefined && { layers: v.layers as unknown[] }) } : null;
    case 'template': {
      const params = v.params;
      if (!str(v.title, 200) || (v.kind !== 'vega' && v.kind !== 'html') || !str(v.templateId, 64) || !str(v.layer, 100)
        || !isObj(params) || templateById(v.templateId)?.kind !== v.kind
        || !Object.keys(params).every(k => k !== 'template' && k !== 'layer' && (TEMPLATE_ARGS as readonly string[]).includes(k))
        || !validateTemplateArgs({ ...params, template: v.templateId, layer: v.layer }).ok) return null;
      return { t: 'template', kind: v.kind, title: v.title, templateId: v.templateId, layer: v.layer, params };
    }
    case 'confirm':
      return typeof v.svc === 'boolean' && str(v.text, 2000) && str(v.host, 300) && typeof v.vetNote === 'boolean'
        && (v.ok === null || typeof v.ok === 'boolean') && (v.copy === undefined || v.copy === true)
        ? { t: 'confirm', svc: v.svc, text: v.text, host: v.host, vetNote: v.vetNote, ok: v.ok as boolean | null, ...(v.copy && { copy: true as const }) } : null;
    case 'choose': return strings(v.labels, 50, 200) ? { t: 'choose', labels: v.labels } : null;
    default: return null;
  }
}

/** A tm-chat snapshot as data the chat may rebuild from, or null. One bad entry
 *  drops only itself; a bad model history drops the history (the transcript stays). */
export function validSnapshot(d: unknown): ChatSnapshot | null {
  if (!isObj(d) || !Array.isArray(d.entries) || d.entries.length > 2000) return null;
  const codes = new Map<number, string>();
  const entries = d.entries.flatMap((x): Entry[] => { const e = validEntry(x, codes); return e ? [e] : []; });
  return {
    busy: d.busy === true,
    model: typeof d.model === 'string' && d.model.length <= 200 && MODEL_ID.test(d.model) ? d.model : DEFAULT_MODEL,
    cost: typeof d.cost === 'number' && Number.isFinite(d.cost) && d.cost >= 0 && d.cost < 1e6 ? d.cost : 0,
    messages: seenExchanges(validateHistory(d.messages) ?? [], entries),
    entries,
  };
}
