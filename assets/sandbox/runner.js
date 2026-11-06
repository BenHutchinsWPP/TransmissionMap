// ─── Analysis sandbox runner (inline in public/sandbox.html) ────────────────
// Role: runs one piece of model-written code at a time in a blob Worker inside
//       the sandbox frame, and answers the page. The frame is an opaque-origin
//       <iframe sandbox="allow-scripts"> whose own meta CSP (default-src 'none';
//       script-src 'sha256-…'; worker-src blob:) the worker inherits: no
//       network, no eval, no storage, no page DOM.
//       It runs only when its origin is opaque ('null') and it is framed: the
//       same file opened top-level, or framed without the sandbox attribute,
//       has the app's origin and stays inert (no listener, no worker, no post).
//       Protocol:
//         on load       → parent {type:'ready', worker: bool}  (a probe worker ran?)
//         parent {id, nonce, code, inputs: JSON string}
//                       → parent {type:'result', id, nonce, ok, value | error, ms}
//       Only messages whose source is window.parent are read. The worker sees
//       the geo kit's functions as globals, `input` (the parsed inputs) and
//       `done(value)`; the code's return value, when not undefined, is the
//       result. The worker is terminated after 10 s; a result over 1 MB of
//       JSON is refused.
//       Plain JS, no imports: scripts/build_sandbox.mjs prepends
//       `const GEO_KIT = "<geo-kit.ts, types erased>";` and hashes the whole.
//
// Deps: none (GEO_KIT is defined by the build).

/* global GEO_KIT */
(function () {
  'use strict';
  if (self.origin !== 'null' || window.parent === window) return;
  var TIMEOUT_MS = 10000;
  var MAX_RESULT_CHARS = 1024 * 1024;
  var MAX_ERROR_CHARS = 2000;

  var PRELUDE = [
    ';var __post = self.postMessage.bind(self), __sent = false;',
    'function done(value) {',
    '  if (__sent) return; __sent = true;',
    '  var json;',
    '  try { json = JSON.stringify(value === undefined ? null : value); }',
    "  catch (err) { __post({ ok: false, error: 'The result could not be serialised: ' + (err && err.message) }); return; }",
    "  __post({ ok: true, json: json === undefined ? 'null' : json });",
    '}',
    'function __fail(err) {',
    '  if (__sent) return; __sent = true;',
    "  __post({ ok: false, error: err && err.name ? err.name + ': ' + err.message : String(err) });",
    '}',
    'self.onmessage = function (e) {',
    '  self.onmessage = null;',
    '  var r;',
    '  try { r = __analysis(JSON.parse(e.data), done); } catch (err) { __fail(err); return; }',
    '  Promise.resolve(r).then(function (v) { if (v !== undefined) done(v); }, __fail);',
    '};',
    'async function __analysis(input, done) {',
    '',
  ].join('\n');
  var EPILOGUE = '\n}\n';

  function clip(s) { s = String(s); return s.length > MAX_ERROR_CHARS ? s.slice(0, MAX_ERROR_CHARS) + '…' : s; }

  function blobWorker(parts) {
    var url = URL.createObjectURL(new Blob(parts, { type: 'text/javascript' }));
    var w = new Worker(url);
    var terminate = w.terminate.bind(w);
    w.terminate = function () { terminate(); URL.revokeObjectURL(url); };
    return w;
  }

  // Feature detection: the page shows "not available" when no worker runs here.
  function probe() {
    var sent = false;
    function ready(ok) { if (!sent) { sent = true; window.parent.postMessage({ type: 'ready', worker: ok }, '*'); } }
    var w;
    try { w = blobWorker(['postMessage(1)']); } catch (_) { ready(false); return; }
    var t = setTimeout(function () { w.terminate(); ready(false); }, 3000);
    w.onmessage = function () { clearTimeout(t); w.terminate(); ready(true); };
    w.onerror = function (e) { e.preventDefault(); clearTimeout(t); w.terminate(); ready(false); };
  }

  var busy = false;

  addEventListener('message', function (ev) {
    if (ev.source !== window.parent) return;
    var m = ev.data;
    if (!m || typeof m !== 'object' || typeof m.nonce !== 'string' || m.nonce.length < 16) return;
    function reply(r) {
      r.type = 'result'; r.id = m.id; r.nonce = m.nonce;
      window.parent.postMessage(r, '*');
    }
    if (typeof m.code !== 'string' || typeof m.inputs !== 'string') { reply({ ok: false, error: 'Malformed request', ms: 0 }); return; }
    if (busy) { reply({ ok: false, error: 'Another analysis is running', ms: 0 }); return; }
    busy = true;
    var t0 = performance.now(), w, timer, finished = false;
    function finish(r) {
      if (finished) return;
      finished = true; busy = false;
      clearTimeout(timer);
      if (w) w.terminate();
      r.ms = Math.round(performance.now() - t0);
      reply(r);
    }
    try { w = blobWorker([GEO_KIT, PRELUDE, m.code, EPILOGUE]); } catch (_) {
      finish({ ok: false, error: "Analysis isn't available in this browser" });
      return;
    }
    timer = setTimeout(function () {
      finish({ ok: false, timeout: true, error: 'Stopped after 10 s: return a value (or call done(value)) sooner' });
    }, TIMEOUT_MS);
    w.onmessage = function (e) {
      var d = e.data;
      if (!d || d.ok !== true || typeof d.json !== 'string') {
        finish({ ok: false, error: clip(d && typeof d.error === 'string' ? d.error : 'The analysis sent an unexpected message') });
      } else if (d.json.length > MAX_RESULT_CHARS) {
        finish({ ok: false, error: 'The result is over 1 MB of JSON: return a smaller summary' });
      } else {
        try { finish({ ok: true, value: JSON.parse(d.json) }); } catch (_) { finish({ ok: false, error: 'The result is not JSON' }); }
      }
    };
    w.onmessageerror = function () { finish({ ok: false, error: 'The result could not be read' }); };
    w.onerror = function (e) { e.preventDefault(); finish({ ok: false, error: clip(e.message || 'The analysis failed') }); };
    w.postMessage(m.inputs);
  });

  probe();
})();
