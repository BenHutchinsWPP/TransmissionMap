// ─── Canvas host: the page's side of the canvas frame ───────────────────────
// Role: shows one model-written HTML page or one Vega-Lite chart in an
//       <iframe sandbox="allow-scripts" src="canvas.html"> (opaque origin; the
//       frame's own meta CSP, protocol in sandbox/canvas-runner.js's header).
//         runCanvas(container, req, opts?) → Promise<CanvasOutcome> & {handle}
//           resolves on the first `rendered` ({shown:true}), an `error` before it
//           ({error, message?}: category from CANVAS_ERRORS, else 'runtime';
//           a 'csp' error — a blocked request — never settles it and only
//           goes to opts.onError, as 'runtime' with its message;
//           message ≤ 300 chars, for the visitor — a caller decides whether a
//           model sees it), 10 s after the render with neither ('timeout', the
//           frame stays), 10 s without `ready` ('unavailable', frame removed),
//           a navigation ('runtime', 'navigated') or a dispose ('unavailable');
//           'library' is the frame's own report that a pinned library did not load.
//           opts.template marks a frame the page made for one of its own
//           templates (assets/templates/): an html one resolves on the
//           runner's `drawn` (TM.drawn(), the template's real first paint)
//           instead of `rendered`, with a 15 s watchdog ('timeout'); a vega one
//           on `rendered` as before. Only a template frame's `action` messages
//           ({kind: select|fly|table|where, payload}) reach opts.onAction (with a
//           FrameControl: reset() tells a vega bridge to forget its last value,
//           release() blurs the frame so the page's keys work again), ≤ 50
//           per frame, after the source and nonce checks; the payload is
//           unchecked here (the caller validates it: templates/template-actions.ts).
//           opts.signals (vega template frames only) goes out as the render
//           message's `actions`: the Vega signals whose changes the runner
//           forwards as actions. Every other frame's `drawn` and `action` are
//           ignored, it is never sent `actions`, and its 'invalid-data' error
//           reads as 'runtime'.
//         requestPng(handle)   asks a vega frame for its PNG (comes back as a
//                              download marked `requested`).
//         disposeAllCanvases()   removes every frame.
//       Every message is matched by event.source === the frame's contentWindow
//       (never by origin: an opaque origin is "null") and, after the render, by
//       the 32-hex nonce. Model code shares the runner's realm, so every message
//       after the render may be forged: each field is type-checked, a forged
//       `rendered` only means "shown", and downloads are validated (mime set,
//       ≤ 20 MB, ≤ 5 per frame but asked-for PNGs — each frame, so a Re-run starts again —, CSV cells formula-guarded, name sanitised and its extension
//       forced from the mime) and handed to opts.onDownload — never saved here.
//       A download is marked `requested` (the card saves it at once) when the
//       page asked for it (a vega PNG, uncounted) or when it comes from a
//       template frame during the visitor's own gesture in that frame
//       (frameGesture: transient user activation AND the frame is
//       document.activeElement), at most one such save per focus of the frame,
//       still counted toward MAX_DOWNLOADS; else the card shows a Save button.
//       Navigation guard: the frame loads once, plus once more at document.close()
//       for kind 'html' (none for 'vega'); a further load or a second `ready` is
//       the frame navigating: it is removed and opts.onClosed('navigated') runs.
//       At most MAX_LIVE frames page-wide: a new one disposes the oldest
//       (onClosed('evicted')). opts.signal aborting disposes the frame only
//       before its first `rendered`; a drawn frame survives the turn's Stop
//       (removed by disposeAllCanvases, eviction or close).
//
// Deps: none; public/canvas.html (built from sandbox/canvas-runner.js by
//       scripts/build_sandbox.mjs).
// Loaded by: ui/ui-canvas.ts (chat chunk only).

export const CANVAS_URL = `${import.meta.env.BASE_URL}canvas.html`;
export const MAX_LIVE = 3;
export const READY_MS = 10_000;
export const RENDER_MS = 10_000;
export const DRAWN_MS = 15_000;
export const MAX_ACTIONS = 50;
export const TEMPLATE_ACTIONS = ['select', 'fly', 'table', 'where'] as const;
/** What a template frame's action handler may do back to its frame: make a Vega bridge forget its last value;
 *  release() moves keyboard focus from the frame back to the page (keys typed in a frame never reach the page's Ctrl+Z). */
export interface FrameControl { reset: () => void; release: () => void }
export type TemplateAction = { kind: typeof TEMPLATE_ACTIONS[number]; payload: unknown };
/** A Vega template's signal the runner forwards as TM.action(kind, {layer, field, bin}): `bin` is
 *  the last value of the selection's `read` field (canvas-runner.js header). */
export interface SignalAction { signal: string; kind: TemplateAction['kind']; layer: string; field: string; read: string }
export const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;
export const MAX_DOWNLOADS = 5;
const MAX_MESSAGE = 300;

export type CanvasKind = 'html' | 'vega';
export const CANVAS_ERRORS = ['syntax', 'runtime', 'timeout', 'too-large', 'unavailable', 'library', 'invalid-spec', 'invalid-data'] as const;
export type CanvasError = typeof CANVAS_ERRORS[number];
export type CanvasOutcome = { shown: true } | { error: CanvasError; message?: string };

export interface CanvasRequest { kind: CanvasKind; payload: unknown; inputs?: unknown; width?: number; height?: number }
export interface CanvasDownload { name: string; mime: string; data: string | ArrayBuffer; requested: boolean }

/** Whether `frame` holds the visitor's gesture now: the page has transient user activation
 *  (false where the API is missing) and the frame has focus (a click inside an iframe focuses it). */
export function frameGesture(frame: HTMLIFrameElement): boolean {
  const active = (navigator as Navigator & { userActivation?: { isActive: boolean } }).userActivation?.isActive === true;
  return active && document.activeElement === frame;
}
export type CanvasClose = 'navigated' | 'evicted' | 'closed';
export interface CanvasOptions {
  signal?: AbortSignal;
  /** The page's own template code: an html frame resolves on `drawn`, and its actions reach onAction. */
  template?: boolean;
  /** A template frame's action, kind checked, payload not (≤ MAX_ACTIONS per frame). */
  onAction?: (a: TemplateAction, frame: FrameControl) => void;
  /** A vega template frame's signal bridge (sent only when `template`). */
  signals?: SignalAction[];
  onDownload?: (d: CanvasDownload) => void;
  /** An error after the outcome was settled (the card shows it). */
  onError?: (e: { error: CanvasError; message?: string }) => void;
  /** The frame was removed by the page: navigated, evicted (a 4th frame) or closed (disposeAllCanvases). */
  onClosed?: (why: CanvasClose) => void;
}

export interface CanvasHandle {
  readonly frame: HTMLIFrameElement;
  readonly kind: CanvasKind;
  readonly nonce: string;
  readonly template: boolean;
  alive: boolean;
  /** PNG requests awaiting their download. */
  pngWanted: number;
  close: (why?: CanvasClose) => void;
}

/** Mime → the only extension a saved file may carry. */
export const DOWNLOAD_TYPES: Readonly<Record<string, string>> = {
  'image/png': 'png', 'text/csv': 'csv', 'application/json': 'json',
  'application/geo+json': 'geojson', 'model/gltf-binary': 'glb', 'text/plain': 'txt',
};

const live: CanvasHandle[] = [];

function newNonce(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
}

const isBuffer = (x: unknown): x is ArrayBuffer => Object.prototype.toString.call(x) === '[object ArrayBuffer]';

/** `name` cut to [A-Za-z0-9 ._-], ≤ 80 chars, ending in `.ext`. */
export function safeName(name: string, ext: string): string {
  const stem = name.replace(/\.[A-Za-z0-9]{1,8}$/, '').replace(/[^A-Za-z0-9 ._-]+/g, '-').replace(/^[ .-]+|[ .-]+$/g, '');
  return `${stem.slice(0, 79 - ext.length).replace(/[ .]+$/, '') || 'download'}.${ext}`;
}

const FORMULA_START = /[=+\-@\t]/;

/** CSV text with a `'` put before every field a spreadsheet would read as a formula (as user-data-export.ts's cells). Quote-aware: a quoted field is guarded inside its quotes. */
export function guardCsv(text: string): string {
  let out = '', start = true, quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      out += c;
      if (c === '"') { if (text[i + 1] === '"') out += text[++i]; else quoted = false; }
      continue;
    }
    if (start) {
      start = false;
      if (c === '"') { quoted = true; out += c; if (FORMULA_START.test(text[i + 1] ?? '')) out += "'"; continue; }
      if (FORMULA_START.test(c)) out += "'";
    }
    if (c === ',' || c === '\n' || c === '\r') start = true;
    out += c;
  }
  return out;
}

/** A frame's download message as a file the visitor may save, or null. */
export function checkDownload(d: Record<string, unknown>): Omit<CanvasDownload, 'requested'> | null {
  if (typeof d.name !== 'string' || typeof d.mime !== 'string') return null;
  const mime = d.mime.split(';')[0].trim().toLowerCase();
  const ext = DOWNLOAD_TYPES[mime];
  if (!ext) return null;
  const data = d.data;
  let size: number;
  if (typeof data === 'string') size = data.length > MAX_DOWNLOAD_BYTES ? Infinity : new Blob([data]).size;
  else if (isBuffer(data)) size = data.byteLength;
  else return null;
  if (size > MAX_DOWNLOAD_BYTES) return null;
  if (mime === 'text/csv') return { name: safeName(d.name, ext), mime, data: guardCsv(typeof data === 'string' ? data : new TextDecoder().decode(data)) };
  return { name: safeName(d.name, ext), mime, data };
}

const category = (c: unknown, template: boolean): CanvasError =>
  (CANVAS_ERRORS as readonly unknown[]).includes(c) && (template || c !== 'invalid-data') ? c as CanvasError : 'runtime';
const clip = (m: unknown) => typeof m === 'string' ? m.slice(0, MAX_MESSAGE) : undefined;
const withMessage = (error: CanvasError, m: unknown): { error: CanvasError; message?: string } => {
  const message = clip(m);
  return message ? { error, message } : { error };
};

/** Show `req` in a new frame inside `container`. Never rejects. */
export function runCanvas(container: HTMLElement, req: CanvasRequest, opts: CanvasOptions = {}): Promise<CanvasOutcome> & { handle: CanvasHandle } {
  const frame = document.createElement('iframe');
  frame.setAttribute('sandbox', 'allow-scripts');
  frame.setAttribute('referrerpolicy', 'no-referrer');
  frame.title = 'canvas';
  frame.className = 'canvas-frame';
  frame.src = CANVAS_URL;
  const nonce = newNonce();
  const expectedLoads = 1 + (req.kind === 'html' ? 1 : 0);
  const template = opts.template === true;
  // A template's html page says when it has drawn (TM.drawn()); the window 'load' does not.
  const shownOn = template && req.kind === 'html' ? 'drawn' : 'rendered';
  let loads = 0, readies = 0, sent = false, downloads = 0, actions = 0, rendered = false, armed = false;
  let settle!: (o: CanvasOutcome) => void;
  let settled = false;
  const done = new Promise<CanvasOutcome>(resolve => { settle = resolve; });
  const finish = (o: CanvasOutcome) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    settle(o);
  };

  const handle: CanvasHandle = {
    frame, kind: req.kind, nonce, template, alive: true, pngWanted: 0,
    close(why) {
      if (!handle.alive) return;
      handle.alive = false;
      clearTimeout(timer);
      window.removeEventListener('message', onMessage);
      window.removeEventListener('blur', onBlur);
      opts.signal?.removeEventListener('abort', abort);
      frame.remove();
      const i = live.indexOf(handle);
      if (i >= 0) live.splice(i, 1);
      finish(why === 'navigated' ? { error: 'runtime', message: 'navigated' } : { error: 'unavailable' });
      if (why) opts.onClosed?.(why);
    },
  };
  // The turn's Stop removes a frame still starting; a drawn one stays.
  const abort = () => { if (!rendered) handle.close(); };
  const navigated = () => handle.close('navigated');
  // The page's window blurs as focus moves into a child frame: this frame was focused anew.
  const onBlur = () => { if (document.activeElement === frame) armed = true; };

  let timer = setTimeout(() => {
    finish({ error: 'unavailable' });
    handle.close();
  }, READY_MS);

  function onMessage(e: MessageEvent) {
    if (!handle.alive || e.source !== frame.contentWindow) return;
    const d = e.data as Record<string, unknown> | null;
    if (!d || typeof d !== 'object' || typeof d.type !== 'string') return;
    if (d.type === 'ready') {
      if (++readies > 1) { navigated(); return; }
      if (sent) return;
      sent = true;
      clearTimeout(timer);
      timer = setTimeout(() => finish({ error: 'timeout' }), shownOn === 'drawn' ? DRAWN_MS : RENDER_MS);
      const msg: Record<string, unknown> = { type: 'render', nonce, kind: req.kind, payload: req.payload };
      if (req.inputs !== undefined) msg.inputs = req.inputs;
      if (req.width !== undefined) msg.width = req.width;
      if (req.height !== undefined) msg.height = req.height;
      if (template && req.kind === 'vega' && opts.signals?.length) msg.actions = opts.signals;
      frame.contentWindow!.postMessage(msg, '*');
      return;
    }
    if (!sent || d.nonce !== nonce) return;
    if (d.type === shownOn) {
      if (!rendered) { rendered = true; opts.signal?.removeEventListener('abort', abort); }
      finish({ shown: true });
    } else if (d.type === 'error' && d.category === 'csp') {
      // A blocked request (a font, an image) is the visitor's to see; it never fails a frame that draws.
      opts.onError?.(withMessage('runtime', d.message));
    } else if (d.type === 'error') {
      const err = withMessage(category(d.category, template), d.message);
      if (settled) opts.onError?.(err); else finish(err);
    } else if (d.type === 'download') {
      const asked = handle.kind === 'vega' && handle.pngWanted > 0;
      if (downloads >= MAX_DOWNLOADS && !asked) return;
      const file = checkDownload(d);
      if (!file) return;
      const png = asked && file.mime === 'image/png';
      if (png) handle.pngWanted--;
      else if (++downloads > MAX_DOWNLOADS) return;
      const gesture = !png && template && armed && frameGesture(frame);
      // One direct save per focus: focus leaves the frame, so the next needs the visitor's next click in it.
      if (gesture) { armed = false; frame.blur(); }
      opts.onDownload?.({ ...file, requested: png || gesture });
    } else if (d.type === 'action' && template) {
      if (!(TEMPLATE_ACTIONS as readonly unknown[]).includes(d.kind) || actions >= MAX_ACTIONS) return;
      actions++;
      opts.onAction?.({ kind: d.kind as TemplateAction['kind'], payload: d.payload }, {
        reset: () => { if (handle.alive) frame.contentWindow?.postMessage({ type: 'actions-reset', nonce }, '*'); },
        release: () => { if (document.activeElement === frame) frame.blur(); },
      });
    }
  }

  frame.addEventListener('load', () => { if (++loads > expectedLoads) navigated(); });
  window.addEventListener('message', onMessage);
  window.addEventListener('blur', onBlur);
  if (opts.signal?.aborted) queueMicrotask(abort);
  else opts.signal?.addEventListener('abort', abort);
  live.push(handle);
  while (live.length > MAX_LIVE) live[0].close('evicted');
  container.append(frame);
  return Object.assign(done, { handle });
}

/** Ask a vega frame for its chart as a PNG; it arrives through onDownload with `requested: true`. */
export function requestPng(handle: CanvasHandle): boolean {
  if (!handle.alive || handle.kind !== 'vega' || !handle.frame.contentWindow) return false;
  handle.pngWanted++;
  handle.frame.contentWindow.postMessage({ type: 'png', nonce: handle.nonce }, '*');
  return true;
}

/** Remove every live frame (the chat closing); each card hears onClosed('closed'). */
export function disposeAllCanvases(): void {
  for (const h of [...live]) h.close('closed');
}

/** How many frames are live (tests, diagnostics). */
export const liveCanvases = () => live.length;
