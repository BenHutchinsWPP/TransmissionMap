// --- Template kit (concatenated before every html template's own code) -------
// Role: the chrome every page-owned html template gets inside its canvas frame:
//       light theme, header, scope/partial banner, body, credit footer, an
//       accessible Table toggle over the payload rows, a Download menu (CSV of
//       the rows, PNG of a registered canvas/SVG), library loading with a
//       visible fallback, legend colours and number formatting. Defines one
//       frozen global, Kit; plain browser JS, no imports, DOM built with
//       createElement/textContent only (eslint.config.js's template block
//       forbids every HTML sink here and in the templates).
//       The page loads it with `?raw` and puts it before a template's code in
//       the html payload; the libraries come from TM.lib.
//       API:
//         Kit.input()           the frozen TM_INPUT if its shape is v1, else
//                               TM.fail('invalid-data') and null
//         Kit.mount(opts?)      builds the chrome once into document.body;
//                               opts {title?, table?: true to open the table,
//                               rows?: the rows the table and CSV show instead
//                               of payload.rows (density: one per feature)};
//                               returns {root, body, showTable(on)} or null
//         Kit.libs(...names)    Promise of TM.lib(name) for each; on a failure:
//                               TM.fail('library'), labels.unavailable in
//                               the body, the table opened, and the promise
//                               never settles (the template's chain stops)
//         Kit.registerExport(el, opts?) the canvas or SVG the PNG download
//                               draws; opts.beforeExport() → a promise the
//                               PNG waits for (≤ 5 s), e.g. a map's next
//                               fresh frame after a resize cleared its canvas
//         Kit.downloadPng()     what the menu's PNG button runs (SVG drawn
//                               onto a canvas first; never an SVG download)
//         Kit.csv(rows?)        the CSV text of the rows (BOM, CRLF, a text cell
//                               starting = + - @ tab CR gets a leading '), then
//                               the credit and any partial/truncation note
//         Kit.colour(field, value) payload.colours, else a neutral palette
//         Kit.fmt(n, unit?)     Intl number in labels.locale, unit appended
//         Kit.drawn()           TM.drawn(), once
//         Kit.action(kind, payload) TM.action passthrough (the page checks
//                               and applies it: select / fly / table / where);
//                               an object payload gets kb:true when the visitor's
//                               latest input was the keyboard (the page then
//                               moves focus to the Undo it offers)
//         Kit.menu(x, y, items) a small text-only menu at client point (x, y)
//                               in the body, one button per {label, run};
//                               arrow keys, Home and End move between the buttons;
//                               a choice or Escape closes it and returns focus to
//                               where it was opened; a press elsewhere closes it
//         Kit.reducedMotion     prefers-reduced-motion: reduce
//       Labels read (all optional, page-translated): title, summary, locale,
//       dir, scopeView, scopeArea, partial, truncated, tiersHidden, tier.<id>
//       (a hidden voltage tier's name; the id when absent), table,
//       download, csv, png, unavailable, tableCapped, measure (its unit may be
//       in the name; the heading adds roles.measure.unit only when absent),
//       count, field.<name>.
//
// Deps: the frame globals TM and TM_INPUT (sandbox/canvas-runner.js header);
//       the payload shape is assets/templates/payload.ts.

(function () {
  'use strict';

  var PALETTE = ['#4e79a7', '#f28e2b', '#59a14f', '#e15759', '#76b7b2', '#edc948', '#b07aa1', '#9c755f'];
  var TABLE_MAX = 1000;
  var CSS = [
    ':root{color-scheme:light}',
    'html,body{margin:0;background:#fff;color:#1f2328;font:14px/1.4 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}',
    '.kit{display:flex;flex-direction:column;gap:8px;padding:10px;box-sizing:border-box;min-height:100vh;max-width:100%}',
    '.kit *{box-sizing:border-box}',
    '.kit-head{display:flex;flex-wrap:wrap;align-items:center;gap:8px}',
    '.kit-title{flex:1 1 200px;margin:0;font-size:16px;font-weight:600}',
    '.kit-tools{display:flex;gap:6px;flex-wrap:wrap}',
    '.kit-btn,.kit-dl>summary{font:inherit;font-size:13px;padding:4px 10px;border:1px solid #d0d7de;border-radius:6px;background:#f6f8fa;color:inherit;cursor:pointer;list-style:none}',
    '.kit-dl>summary::-webkit-details-marker{display:none}',
    '.kit-btn:focus-visible,.kit-dl>summary:focus-visible{outline:2px solid #0969da;outline-offset:1px}',
    '.kit-dl{position:relative}',
    '.kit-dl-menu{position:absolute;right:0;z-index:10;display:flex;flex-direction:column;gap:4px;margin-top:4px;padding:6px;background:#fff;border:1px solid #d0d7de;border-radius:6px;box-shadow:0 4px 12px rgba(0,0,0,.12)}',
    '.kit-banner{font-size:12px;color:#57606a;display:flex;flex-direction:column;gap:2px}',
    '.kit-partial{color:#9a6700;font-weight:600}',
    '.kit-body{flex:1 1 auto;min-height:200px;position:relative;max-width:100%;overflow:hidden}',
    '.kit-fallback{padding:12px;border:1px dashed #d0d7de;border-radius:6px;color:#57606a}',
    '.kit-table-wrap{overflow:auto;max-height:60vh;border:1px solid #d0d7de;border-radius:6px}',
    '.kit-table{border-collapse:collapse;width:100%;font-size:12px;font-variant-numeric:tabular-nums}',
    '.kit-table th,.kit-table td{padding:3px 8px;border-bottom:1px solid #eaeef2;text-align:start;white-space:nowrap}',
    '.kit-table th{position:sticky;top:0;background:#f6f8fa}',
    '.kit-table td.kit-num{text-align:end}',
    '.kit-foot{font-size:11px;color:#57606a}',
    '.kit-menu{position:absolute;z-index:20;display:flex;flex-direction:column;gap:4px;padding:6px;background:#fff;border:1px solid #d0d7de;border-radius:6px;box-shadow:0 4px 12px rgba(0,0,0,.15)}',
    '.kit-menu .kit-btn{text-align:start}',
    '[hidden]{display:none!important}',
    '@media (max-width:480px){.kit{padding:6px}.kit-title{font-size:15px;flex-basis:100%}.kit-dl-menu{right:auto;left:0}}',
    '@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}',
  ].join('\n');

  var input;          // undefined: not read yet; null: invalid
  var ui = null;      // the mounted chrome
  var exportEl = null;
  var beforeExport = null;
  var EXPORT_WAIT_MS = 5000;
  var drawnSent = false;
  var assigned = {};  // field -> value -> fallback colour

  function isObj(x) { return x !== null && typeof x === 'object' && !Array.isArray(x); }

  function readInput() {
    if (input !== undefined) return input;
    var p = typeof TM_INPUT === 'undefined' ? undefined : TM_INPUT;
    var ok = isObj(p) && p.v === 1 && typeof p.template === 'string' && Array.isArray(p.rows)
      && isObj(p.labels) && isObj(p.roles) && (p.scope === 'area' || p.scope === 'view');
    input = ok ? p : null;
    if (!ok) TM.fail('invalid-data', 'TM_INPUT is not a v1 template payload');
    return input;
  }

  function label(key, fallback) {
    var p = readInput();
    var v = p && p.labels[key];
    return typeof v === 'string' && v !== '' ? v : (fallback === undefined ? '' : fallback);
  }

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = String(text);
    return e;
  }

  // -- numbers and colours -------------------------------------------------------
  var nfCache = {};
  function fmt(n, unit) {
    if (typeof n !== 'number' || !isFinite(n)) return '–';
    var a = Math.abs(n), digits = a === 0 || a >= 1000 ? 0 : a >= 10 ? 1 : 2;
    var key = String(digits);
    if (!nfCache[key]) {
      var loc = label('locale') || undefined;
      try { nfCache[key] = new Intl.NumberFormat(loc, { maximumFractionDigits: digits }); }
      catch (_) { nfCache[key] = new Intl.NumberFormat(undefined, { maximumFractionDigits: digits }); }
    }
    var s = nfCache[key].format(n);
    return unit ? s + ' ' + unit : s;
  }

  function colour(field, value) {
    var p = readInput();
    var f = p && isObj(p.colours) ? p.colours[field] : undefined;
    var c = isObj(f) ? f[String(value)] : undefined;
    if (typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c)) return c;
    var m = assigned[field] || (assigned[field] = { n: 0, by: {} });
    var k = String(value);
    if (!(k in m.by)) m.by[k] = PALETTE[m.n++ % PALETTE.length];
    return m.by[k];
  }

  // -- rows as a table and as CSV ------------------------------------------------
  function columns(rows) {
    var cols = [], seen = {};
    for (var i = 0; i < rows.length && i < 50; i++) {
      for (var k in rows[i]) {
        if (Object.prototype.hasOwnProperty.call(rows[i], k) && !seen[k]) { seen[k] = 1; cols.push(k); }
      }
    }
    // the measure columns last: count, then sum
    return cols.filter(function (c) { return c !== 'count' && c !== 'sum'; })
      .concat(seen.count ? ['count'] : [], seen.sum ? ['sum'] : []);
  }

  function heading(col) {
    var p = readInput();
    if (col === 'count') return label('count', 'count');
    if (col === 'sum') {
      var m = p && p.roles.measure;
      var name = label('measure', m && m.name ? m.name : 'sum');
      // the label may already carry its unit ("Length (km)", "Floor area (sq ft)")
      return m && m.unit && name.indexOf('(' + m.unit + ')') < 0 ? name + ' (' + m.unit + ')' : name;
    }
    return label('field.' + col, col);
  }

  function cell(v) {
    if (v === null || v === undefined) return '';
    return Array.isArray(v) ? v.join('; ') : String(v);
  }

  function csvCell(v) {
    var s = cell(v);
    if (typeof v !== 'number' && /^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function csv(rows) {
    var p = readInput();
    rows = rows || (p ? p.rows : []);
    var cols = columns(rows);
    var lines = [cols.map(function (c) { return csvCell(heading(c)); }).join(',')];
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      lines.push(cols.map(function (c) { return csvCell(r[c]); }).join(','));
    }
    if (p && p.credit) lines.push(csvCell(p.credit));
    if (p && p.complete === false) lines.push(csvCell(label('partial')));
    if (p && p.truncated && p.truncation) lines.push(csvCell(p.truncation));
    return '﻿' + lines.join('\r\n') + '\r\n';
  }

  function buildTable(rows) {
    var cols = columns(rows);
    var wrap = el('div', 'kit-table-wrap');
    wrap.tabIndex = 0;
    var table = el('table', 'kit-table');
    if (ui) table.setAttribute('aria-label', ui.titleText);
    var tr = table.appendChild(el('thead')).appendChild(el('tr'));
    cols.forEach(function (c) { tr.appendChild(el('th', null, heading(c))).scope = 'col'; });
    var tbody = table.appendChild(el('tbody'));
    var n = Math.min(rows.length, TABLE_MAX);
    for (var i = 0; i < n; i++) {
      var row = tbody.appendChild(el('tr'));
      for (var j = 0; j < cols.length; j++) {
        var v = rows[i][cols[j]];
        row.appendChild(el('td', typeof v === 'number' ? 'kit-num' : null, typeof v === 'number' ? fmt(v) : cell(v)));
      }
    }
    wrap.appendChild(table);
    var box = el('div');
    box.appendChild(wrap);
    if (rows.length > n) box.appendChild(el('p', 'kit-foot', label('tableCapped', fmt(n) + ' / ' + fmt(rows.length))));
    return box;
  }

  // -- downloads -----------------------------------------------------------------
  function baseName() {
    var p = readInput();
    return (p ? p.template : 'template').replace(/[^\w.-]+/g, '_');
  }

  function downloadCsv() {
    TM.download(baseName() + '.csv', 'text/csv;charset=utf-8', csv(ui ? ui.rows : undefined));
  }

  function canvasToPng(canvas) {
    return new Promise(function (resolve, reject) {
      canvas.toBlob(function (blob) {
        if (!blob) { reject(new Error('PNG export failed')); return; }
        blob.arrayBuffer().then(resolve, reject);
      }, 'image/png');
    });
  }

  function svgToCanvas(svg) {
    var box = svg.getBoundingClientRect();
    var w = Math.max(1, Math.round(box.width || Number(svg.getAttribute('width')) || 600));
    var h = Math.max(1, Math.round(box.height || Number(svg.getAttribute('height')) || 400));
    var copy = svg.cloneNode(true);
    copy.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    copy.setAttribute('width', String(w));
    copy.setAttribute('height', String(h));
    var url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(new XMLSerializer().serializeToString(copy));
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.onload = function () {
        var scale = Math.min(3, Math.max(1, window.devicePixelRatio || 1));
        var c = document.createElement('canvas');
        c.width = w * scale; c.height = h * scale;
        var ctx = c.getContext('2d');
        if (!ctx) { reject(new Error('no 2d context')); return; }
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, c.width, c.height);
        ctx.drawImage(img, 0, 0, c.width, c.height);
        resolve(c);
      };
      img.onerror = function () { reject(new Error('SVG could not be drawn')); };
      img.src = url;
    });
  }

  /** The registered hook's promise, settled after at most EXPORT_WAIT_MS (a failure counts as settled). */
  function waitForExport() {
    if (!beforeExport) return Promise.resolve();
    var hook = beforeExport;
    return new Promise(function (resolve) {
      var t = setTimeout(resolve, EXPORT_WAIT_MS);
      var end = function () { clearTimeout(t); resolve(); };
      try { Promise.resolve(hook()).then(end, end); } catch (_) { end(); }
    });
  }

  function downloadPng() {
    if (!exportEl) return Promise.resolve();
    return waitForExport().then(function () {
      var node = exportEl;
      return typeof node.toBlob === 'function' ? node : svgToCanvas(node);
    }).then(canvasToPng).then(function (buf) {
      TM.download(baseName() + '.png', 'image/png', buf);
    }, function (e) { TM.fail('runtime', e && e.message ? e.message : 'PNG export failed'); });
  }

  function registerExport(node, opts) {
    var tag = node && node.tagName ? String(node.tagName).toLowerCase() : '';
    if (tag !== 'canvas' && tag !== 'svg') throw new TypeError('Kit.registerExport: a canvas or svg element');
    exportEl = node;
    beforeExport = opts && typeof opts.beforeExport === 'function' ? opts.beforeExport : null;
    if (ui) ui.pngBtn.hidden = false;
  }

  // -- the chrome ----------------------------------------------------------------
  function showTable(on) {
    if (!ui) return;
    if (on && !ui.tableBox.firstChild) ui.tableBox.appendChild(buildTable(ui.rows));
    ui.tableBox.hidden = !on;
    ui.tableBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
  }

  function mount(opts) {
    if (ui) return ui.api;
    var p = readInput();
    if (!p) return null;
    opts = opts || {};
    var style = document.createElement('style');
    style.textContent = CSS;
    (document.head || document.documentElement).appendChild(style);
    var loc = label('locale');
    if (loc) document.documentElement.lang = loc;
    if (label('dir') === 'rtl') document.documentElement.dir = 'rtl';

    var paramTitle = typeof p.params.title === 'string' ? p.params.title : '';
    var titleText = opts.title || label('title') || paramTitle || p.template;
    var root = el('main', 'kit');
    root.setAttribute('aria-label', label('summary', titleText));

    var head = root.appendChild(el('header', 'kit-head'));
    head.appendChild(el('h1', 'kit-title', titleText));
    var tools = head.appendChild(el('div', 'kit-tools'));
    var tableBtn = tools.appendChild(el('button', 'kit-btn', label('table', 'Table')));
    tableBtn.type = 'button';
    tableBtn.setAttribute('aria-pressed', 'false');
    var dl = tools.appendChild(el('details', 'kit-dl'));
    dl.appendChild(el('summary', null, label('download', 'Download')));
    var menu = dl.appendChild(el('div', 'kit-dl-menu'));
    var csvBtn = menu.appendChild(el('button', 'kit-btn', label('csv', 'CSV')));
    csvBtn.type = 'button';
    var pngBtn = menu.appendChild(el('button', 'kit-btn', label('png', 'PNG')));
    pngBtn.type = 'button';
    pngBtn.hidden = !exportEl;

    var banner = root.appendChild(el('div', 'kit-banner'));
    banner.setAttribute('role', 'note');
    banner.appendChild(el('span', 'kit-scope', label(p.scope === 'view' ? 'scopeView' : 'scopeArea')));
    if (Array.isArray(p.tiersHidden) && p.tiersHidden.length) {
      var tiers = p.tiersHidden.map(function (id) { return label('tier.' + id, String(id)); });
      banner.appendChild(el('span', 'kit-tiers', label('tiersHidden') + ' ' + tiers.join(', ')));
    }
    if (p.complete === false) banner.appendChild(el('span', 'kit-partial', label('partial')));
    if (p.truncated) {
      banner.appendChild(el('span', 'kit-partial kit-truncated',
        [label('truncated'), typeof p.truncation === 'string' ? p.truncation : ''].filter(Boolean).join(' ')));
    }
    banner.hidden = !banner.textContent;

    var body = root.appendChild(el('div', 'kit-body'));
    var tableBox = root.appendChild(el('section', 'kit-table-box'));
    tableBox.setAttribute('aria-label', label('table', 'Table'));
    tableBox.hidden = true;
    var foot = root.appendChild(el('footer', 'kit-foot',
      [typeof p.credit === 'string' ? p.credit : '', p.template].filter(Boolean).join(' · ')));

    document.body.appendChild(root);
    var api = Object.freeze({ root: root, body: body, showTable: showTable });
    ui = { api: api, rows: Array.isArray(opts.rows) ? opts.rows : p.rows, titleText: titleText, tableBox: tableBox, tableBtn: tableBtn, pngBtn: pngBtn, foot: foot };

    tableBtn.addEventListener('click', function () { showTable(tableBox.hidden); });
    csvBtn.addEventListener('click', function () { dl.open = false; downloadCsv(); });
    pngBtn.addEventListener('click', function () { dl.open = false; downloadPng(); });
    if (opts.table) showTable(true);
    return api;
  }

  // Whether the visitor's latest input was the keyboard: the page then moves focus to the Undo it offers.
  var byKeyboard = false;
  document.addEventListener('keydown', function () { byKeyboard = true; }, true);
  document.addEventListener('pointerdown', function () { byKeyboard = false; }, true);

  // -- action menu ---------------------------------------------------------------
  var menuEl = null, opener = null;
  function closeMenu(restore) {
    if (!menuEl) return;
    menuEl.remove(); menuEl = null;
    if (restore && opener && opener.isConnected) opener.focus();
    opener = null;
  }
  function menu(x, y, items) {
    closeMenu(false);
    var list = Array.isArray(items) ? items.filter(function (it) { return it && typeof it.run === 'function'; }) : [];
    if (!ui || !list.length) return;
    var body = ui.api.body, r = body.getBoundingClientRect();
    opener = document.activeElement && document.activeElement !== document.body ? document.activeElement : null;
    var m = el('div', 'kit-menu');
    m.setAttribute('role', 'menu');
    list.forEach(function (it) {
      var b = m.appendChild(el('button', 'kit-btn', it.label));
      b.type = 'button';
      b.setAttribute('role', 'menuitem');
      b.addEventListener('click', function (e) { e.stopPropagation(); closeMenu(true); it.run(); });
    });
    m.addEventListener('keydown', function (e) {
      var btns = Array.prototype.slice.call(m.querySelectorAll('button')), i = btns.indexOf(document.activeElement);
      if (e.key === 'Escape') { e.preventDefault(); closeMenu(true); return; }
      var to = e.key === 'ArrowDown' ? (i + 1) % btns.length : e.key === 'ArrowUp' ? (i - 1 + btns.length) % btns.length
        : e.key === 'Home' ? 0 : e.key === 'End' ? btns.length - 1 : -1;
      if (to >= 0) { e.preventDefault(); btns[to].focus(); }
    });
    body.appendChild(m);
    m.style.left = Math.max(4, Math.min(x - r.left, body.clientWidth - m.offsetWidth - 4)) + 'px';
    m.style.top = Math.max(4, Math.min(y - r.top, body.clientHeight - m.offsetHeight - 4)) + 'px';
    menuEl = m;
    m.firstChild.focus();
  }
  document.addEventListener('pointerdown', function (e) { if (menuEl && !menuEl.contains(e.target)) closeMenu(false); }, true);

  // -- libraries -----------------------------------------------------------------
  function libs() {
    var names = Array.prototype.slice.call(arguments);
    return Promise.all(names.map(function (n) { return TM.lib(n); })).catch(function (e) {
      TM.fail('library', e && e.message ? e.message : 'a library did not load');
      var m = mount();
      if (m) {
        m.body.textContent = '';
        m.body.appendChild(el('p', 'kit-fallback', label('unavailable', 'The chart library did not load. The data is in the table below.')));
        showTable(true);
      }
      return new Promise(function () {});
    });
  }

  var reducedMotion;
  try { reducedMotion = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); }
  catch (_) { reducedMotion = false; }

  Object.defineProperty(window, 'Kit', {
    value: Object.freeze({
      input: readInput,
      mount: mount,
      libs: libs,
      registerExport: registerExport,
      csv: csv,
      colour: colour,
      fmt: fmt,
      drawn: function () { if (drawnSent) return; drawnSent = true; TM.drawn(); },
      action: function (kind, payload) {
        var o = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : null;
        return TM.action(kind, o && byKeyboard ? Object.assign({}, o, { kb: true }) : payload);
      },
      menu: menu,
      reducedMotion: reducedMotion,
      downloadPng: downloadPng,
    }),
    writable: false,
    configurable: false,
  });
})();
