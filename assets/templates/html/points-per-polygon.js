// --- points-per-polygon (html template): a layer's count or sum per region ---
// Role: the catalogue's `points-per-polygon` template, run in the canvas frame
//       after kit.js. The rows are one per region tag (the `by` region field:
//       states, counties, ba, nerc, retail, countries, admin1) with the count
//       or the measure's sum; payload.colours[by] gives each region its
//       quantile-class colour and colours.class / value.class.<i> the classes,
//       so the frame, its legend and the main map agree.
//       Two layouts:
//         map    payload.features (the regions' simplified outlines, id = the
//                code): a MapLibre mini-map (OpenFreeMap Positron; a plain
//                background if the style does not load) with the regions
//                filled by class, beside the ranked list. Hover a region or
//                a row: both lit. Click a region (or a row, or Enter on it):
//                "Show only this on the map" (where: {field, bin: code}) and
//                "Zoom the map here" (fly: {id: code}).
//         list   no features (counties: the page paints the main map instead,
//                label ppp.onMap; retail, or outlines that did not load:
//                ppp.noMap): the ranked list and the class legend only, no
//                library loaded; a row offers "Show only this on the map".
//       The list holds the first params.top regions by value; the rest are
//       summed into "Other". The table and CSV list every region by name.
//       Kit.drawn() after the map's first 'idle' (map) or once the list is in
//       the page (list).
//       The header total and each row's share are of payload.totalOnce (each
//       feature once) when given: a feature tagged with several regions counts
//       in each row, and the page then sends ppp.overlap, shown as a note.
//       No values (ppp.noValues): that line, no classes, an empty list.
//       Labels read beyond the kit's: other, none, value.<by>.<code> (region
//       names), value.class.<i>, ppp.onMap, ppp.noMap, ppp.noValues,
//       ppp.overlap, act.where, act.fly.
//
// Deps: the frame globals TM, TM_INPUT and Kit (kit.js), maplibregl through
//       Kit.libs (map layout only); the payload shape is
//       assets/templates/payload.ts. Network: the library and the
//       OpenFreeMap style, tiles, glyphs and sprite (the frame's CSP).

(function () {
  'use strict';
  var STYLE = 'https://tiles.openfreemap.org/styles/positron';
  var BLANK = { version: 8, sources: {}, layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#f2f3f0' } }] };
  var GREY = '#9ca3af';
  var OTHER = '\u0000other';
  var CSS = [
    '.ppp{display:grid;grid-template-columns:minmax(0,1.5fr) minmax(220px,1fr);gap:10px;position:absolute;inset:0}',
    '.ppp-list-only{grid-template-columns:minmax(0,1fr)}',
    '.ppp-map{position:relative;min-height:200px;border:1px solid #d0d7de;border-radius:6px;overflow:hidden}',
    '.ppp-side{display:flex;flex-direction:column;gap:6px;min-height:0;overflow:auto}',
    '.ppp-total{font-size:12px;color:#57606a;display:flex;justify-content:space-between;gap:8px}',
    '.ppp-total b{color:#1f2328;font-variant-numeric:tabular-nums}',
    '.ppp-note{margin:0;font-size:12px;color:#57606a}',
    '.ppp-legend{display:flex;flex-wrap:wrap;gap:4px 10px;font-size:11px;color:#57606a}',
    '.ppp-legend span{display:inline-flex;align-items:center;gap:4px}',
    '.ppp-sw{display:inline-block;width:14px;height:10px;border-radius:2px;border:1px solid rgba(0,0,0,.15)}',
    '.ppp-rows{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:3px;font-size:12px}',
    '.ppp-row{display:grid;grid-template-columns:minmax(80px,38%) 1fr;align-items:center;gap:6px;padding:2px 4px;border-radius:4px;cursor:pointer;outline:none}',
    '.ppp-row.off{cursor:default}',
    '.ppp-row:focus-visible,.ppp-row.on{background:#eaeef2}',
    '.ppp-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:end}',
    '.ppp-barbox{display:flex;align-items:center;gap:6px;min-width:0}',
    '.ppp-bar{height:12px;border-radius:2px;flex:none;transition:width .35s ease}',
    '.ppp-val{color:#57606a;font-variant-numeric:tabular-nums;white-space:nowrap}',
    '.ppp-tip{position:absolute;z-index:5;pointer-events:none;max-width:240px;padding:6px 8px;background:rgba(255,255,255,.96);border:1px solid #d0d7de;border-radius:6px;box-shadow:0 2px 8px rgba(0,0,0,.15);font-size:12px}',
    '.ppp-tip b{display:block;font-weight:600}',
    '@media (max-width:520px){.ppp{position:static;display:flex;flex-direction:column}.ppp-map{height:240px;flex:none}.ppp-side{overflow:visible}}',
    '@media (prefers-reduced-motion:reduce){.ppp-bar{transition:none}}',
  ].join('\n');

  var p = Kit.input();
  if (!p) return;
  var by = p.roles.by[0] ? p.roles.by[0].field : null;
  var measure = p.roles.measure.name;
  var unit = measure === 'count' ? '' : (p.roles.measure.unit || '');
  var top = typeof p.params.top === 'number' && p.params.top >= 1 ? Math.floor(p.params.top) : 10;

  function L(key, fallback) { var v = p.labels[key]; return typeof v === 'string' && v ? v : fallback; }
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = String(text);
    return e;
  }
  function nameOf(k) { return k === OTHER ? L('other', 'Other') : k === 'none' ? L('none', '—') : L('value.' + by + '.' + k, k); }
  function colourOf(k) { return k === OTHER || k === 'none' ? GREY : Kit.colour(by, k); }
  function valueText(v) { return Kit.fmt(v, unit); }

  // -- regions from the rows ---------------------------------------------------------
  var sums = {}, keys = [];
  p.rows.forEach(function (r) {
    var raw = by ? r[by] : null;
    var k = raw === null || raw === undefined || raw === '' ? 'none' : String(raw);
    if (!sums[k]) { sums[k] = { value: 0, count: 0 }; keys.push(k); }
    sums[k].value += typeof r.sum === 'number' ? r.sum : r.count;
    sums[k].count += r.count;
  });
  var ranked = keys.slice().sort(function (a, b) { return sums[b].value - sums[a].value; });
  var named = ranked.filter(function (k) { return k !== 'none'; });
  var LIST = named.slice(0, top).map(function (k) { return { key: k, value: sums[k].value }; });
  var rest = named.slice(top).concat(sums.none ? ['none'] : []);
  if (rest.length) LIST.push({ key: rest.length === 1 && rest[0] === 'none' ? 'none' : OTHER, value: rest.reduce(function (s, k) { return s + sums[k].value; }, 0) });
  // The header total and the shares: each feature once (payload.totalOnce); the rows count a
  // feature in every region it is tagged with, so their sum can be larger.
  var once = p.totalOnce ? (measure === 'count' ? p.totalOnce.count : p.totalOnce.sum) : undefined;
  var total = typeof once === 'number' ? once : ranked.reduce(function (s, k) { return s + sums[k].value; }, 0);
  var tableRows = ranked.map(function (k) {
    var row = {};
    row[by] = nameOf(k);
    row.count = sums[k].count;
    if (measure !== 'count') row.sum = sums[k].value;
    return row;
  });

  var ui = Kit.mount({ rows: tableRows });
  if (!ui) return;

  // -- features ------------------------------------------------------------------------
  var fc = { type: 'FeatureCollection', features: [] };
  var boxes = {};
  var bounds = [Infinity, Infinity, -Infinity, -Infinity];
  var centres = [];
  function grow(c, b) {
    if (Array.isArray(c[0])) { c.forEach(function (x) { grow(x, b); }); return; }
    if (!isFinite(c[0]) || !isFinite(c[1])) return;
    b[0] = Math.min(b[0], c[0]); b[1] = Math.min(b[1], c[1]); b[2] = Math.max(b[2], c[0]); b[3] = Math.max(b[3], c[1]);
  }
  (Array.isArray(p.features) ? p.features : []).forEach(function (f) {
    var g = f && f.geometry;
    if (!g || (g.type !== 'Polygon' && g.type !== 'MultiPolygon') || typeof f.id !== 'string' || !sums[f.id]) return;
    var b = [Infinity, Infinity, -Infinity, -Infinity];
    grow(g.coordinates, b);
    boxes[f.id] = b;
    if (b[2] - b[0] <= 180) centres.push({ b: b, x: (b[0] + b[2]) / 2, y: (b[1] + b[3]) / 2 });
    fc.features.push({ type: 'Feature', geometry: g, properties: { k: f.id, c: colourOf(f.id) } });
  });
  // The first view: the regions whose centres sit in the bulk of them (10th–90th percentile, widened),
  // so a far territory or an outline across the antimeridian does not zoom the map out to the world.
  function pct(xs, q) { var s = xs.slice().sort(function (a, b) { return a - b; }); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; }
  if (centres.length) {
    var xs = centres.map(function (c) { return c.x; }), ys = centres.map(function (c) { return c.y; });
    var x0 = pct(xs, 0.1), x1 = pct(xs, 0.9), y0 = pct(ys, 0.1), y1 = pct(ys, 0.9);
    var px = (x1 - x0) * 0.5 + 5, py = (y1 - y0) * 0.5 + 5;
    centres.forEach(function (c) {
      if (c.x >= x0 - px && c.x <= x1 + px && c.y >= y0 - py && c.y <= y1 + py) grow([[c.b[0], c.b[1]], [c.b[2], c.b[3]]], bounds);
    });
  }
  var withMap = fc.features.length > 0;

  // -- layout -------------------------------------------------------------------------
  var style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);
  var grid = ui.body.appendChild(el('div', withMap ? 'ppp' : 'ppp ppp-list-only'));
  var mapBox = withMap ? grid.appendChild(el('div', 'ppp-map')) : null;
  var side = grid.appendChild(el('div', 'ppp-side'));
  var head = side.appendChild(el('div', 'ppp-total'));
  head.appendChild(el('span', null, L('measure', measure)));
  head.appendChild(el('b', null, valueText(total)));
  var note = L('ppp.noValues', '') || L('ppp.onMap', '') || L('ppp.noMap', '');
  if (note) side.appendChild(el('p', 'ppp-note', note));
  if (L('ppp.overlap', '')) side.appendChild(el('p', 'ppp-note ppp-overlap', L('ppp.overlap', '')));
  var legend = side.appendChild(el('div', 'ppp-legend'));
  for (var ci = 0; p.labels['value.class.' + ci]; ci++) {
    var item = legend.appendChild(el('span'));
    item.appendChild(el('i', 'ppp-sw')).style.background = Kit.colour('class', String(ci));
    item.appendChild(document.createTextNode(p.labels['value.class.' + ci]));
  }
  var list = side.appendChild(el('ul', 'ppp-rows'));
  list.setAttribute('aria-label', L('measure', measure));

  // -- highlight -----------------------------------------------------------------------
  var map = null, mapReady = false, hovered = null, rowNodes = {};
  function paint() {
    for (var k in rowNodes) if (Object.prototype.hasOwnProperty.call(rowNodes, k)) rowNodes[k].classList.toggle('on', k === hovered);
    if (mapReady) {
      map.setPaintProperty('regions', 'fill-opacity', hovered === null ? 0.75 : ['case', ['==', ['get', 'k'], hovered], 0.9, 0.35]);
      map.setFilter('hover', ['==', ['get', 'k'], hovered === null ? '' : hovered]);
    }
  }

  // -- actions ------------------------------------------------------------------------
  function regionMenu(k, x, y) {
    if (!by || k === OTHER || k === 'none') return;
    var items = [{ label: L('act.where', 'Show only this on the map'), run: function () { Kit.action('where', { field: by, bin: k }); } }];
    if (boxes[k]) items.push({ label: L('act.fly', 'Zoom the map here'), run: function () { Kit.action('fly', { id: k }); } });
    Kit.menu(x, y, items);
  }

  // -- list ----------------------------------------------------------------------------
  // Bars scale to the largest named region; "Other" (the rest summed) is capped at the full width.
  var max = LIST.reduce(function (m, c) { return c.key === OTHER ? m : Math.max(m, c.value); }, 0) || 1;
  function drawList() {
    while (list.firstChild) list.removeChild(list.firstChild);
    rowNodes = {};
    var room = Math.max(40, (list.clientWidth || 300) * 0.62 - 130);
    LIST.forEach(function (c) {
      var off = c.key === OTHER || c.key === 'none';
      var li = list.appendChild(el('li', off ? 'ppp-row off' : 'ppp-row'));
      var share = total > 0 ? ' · ' + Kit.fmt(Math.round((c.value / total) * 1000) / 10) + '%' : '';
      li.setAttribute('aria-label', nameOf(c.key) + ': ' + valueText(c.value) + share);
      li.title = nameOf(c.key);
      li.appendChild(el('span', 'ppp-name', nameOf(c.key)));
      var bar = li.appendChild(el('span', 'ppp-barbox'));
      var fill = bar.appendChild(el('span', 'ppp-bar'));
      fill.style.width = Math.max(c.value > 0 ? 2 : 0, Math.round(Math.min(1, c.value / max) * room)) + 'px';
      fill.style.background = colourOf(c.key);
      bar.appendChild(el('span', 'ppp-val', valueText(c.value) + share));
      if (off) return;
      li.tabIndex = 0;
      li.setAttribute('role', 'button');
      li.addEventListener('mouseenter', function () { hovered = c.key; paint(); });
      li.addEventListener('mouseleave', function () { hovered = null; paint(); });
      li.addEventListener('focus', function () { hovered = c.key; paint(); });
      li.addEventListener('blur', function () { hovered = null; paint(); });
      li.addEventListener('click', function (e) { regionMenu(c.key, e.clientX, e.clientY); });
      li.addEventListener('keydown', function (e) {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        var r = li.getBoundingClientRect();
        regionMenu(c.key, r.left + 24, r.bottom);
      });
      rowNodes[c.key] = li;
    });
    paint();
  }
  drawList();

  if (!withMap) {
    if (typeof ResizeObserver === 'function') new ResizeObserver(function () { drawList(); }).observe(list);
    Kit.drawn();
    return;
  }

  // -- map ------------------------------------------------------------------------------
  var tip = el('div', 'ppp-tip');
  tip.hidden = true;
  function showTip(k, x, y) {
    while (tip.firstChild) tip.removeChild(tip.firstChild);
    tip.appendChild(el('b', null, nameOf(k)));
    tip.appendChild(el('div', null, valueText(sums[k] ? sums[k].value : 0)));
    tip.hidden = false;
    var w = tip.offsetWidth || 160;
    tip.style.left = Math.max(4, Math.min(x + 12, mapBox.clientWidth - w - 4)) + 'px';
    tip.style.top = Math.max(4, y + 12) + 'px';
  }
  function pick(point) {
    var hits = map.queryRenderedFeatures(point, { layers: ['regions'] });
    return hits.length ? String(hits[0].properties.k) : null;
  }
  var userMoved = false;
  function fit() { if (bounds[0] > bounds[2]) return; map.fitBounds([[bounds[0], bounds[1]], [bounds[2], bounds[3]]], { padding: 20, maxZoom: 8, animate: false }); }

  function start(styleSpec) {
    map = new maplibregl.Map({
      container: mapBox, style: styleSpec, center: [-98, 39], zoom: 2,
      attributionControl: { compact: true }, cooperativeGestures: true, fadeDuration: 0,
      preserveDrawingBuffer: true, canvasContextAttributes: { preserveDrawingBuffer: true, antialias: true },
    });
    map.on('error', function () { /* a tile or glyph that did not load: the regions still draw */ });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    mapBox.appendChild(tip);
    fit();
    map.on('movestart', function (e) { if (e && e.originalEvent) userMoved = true; });
    map.on('load', function () {
      var firstSymbol = (map.getStyle().layers || []).filter(function (l) { return l.type === 'symbol'; })[0];
      var before = firstSymbol ? firstSymbol.id : undefined;
      map.addSource('regions', { type: 'geojson', data: fc });
      map.addLayer({ id: 'regions', type: 'fill', source: 'regions', paint: { 'fill-color': ['get', 'c'], 'fill-opacity': 0.75 } }, before);
      map.addLayer({ id: 'edges', type: 'line', source: 'regions', paint: { 'line-color': '#475569', 'line-width': 0.6, 'line-opacity': 0.7 } }, before);
      map.addLayer({ id: 'hover', type: 'line', source: 'regions', filter: ['==', ['get', 'k'], ''], paint: { 'line-color': '#1f2328', 'line-width': 2.2 } }, before);
      mapReady = true;
      paint();
      map.on('mousemove', function (e) {
        var k = pick(e.point);
        if (k !== hovered) { hovered = k; paint(); }
        map.getCanvas().style.cursor = k ? 'pointer' : '';
        if (k) showTip(k, e.point.x, e.point.y); else tip.hidden = true;
      });
      map.on('mouseout', function () { hovered = null; tip.hidden = true; paint(); });
      map.on('click', function (e) {
        var k = pick(e.point), oe = e.originalEvent;
        if (k) regionMenu(k, oe ? oe.clientX : e.point.x, oe ? oe.clientY : e.point.y);
      });
      map.once('idle', function () { Kit.drawn(); });
    });
    Kit.registerExport(map.getCanvas(), { beforeExport: function () {
      return new Promise(function (resolve) { map.once('idle', function () { resolve(); }); map.triggerRepaint(); });
    } });
    if (typeof ResizeObserver === 'function') {
      new ResizeObserver(function () { map.resize(); if (!userMoved) fit(); drawList(); }).observe(grid);
    }
  }

  Kit.libs('maplibre-gl', 'maplibre-gl.css').then(function () {
    var timer;
    return new Promise(function (resolve) {
      timer = setTimeout(function () { resolve(BLANK); }, 8000);
      fetch(STYLE).then(function (r) { return r.ok ? r.json() : BLANK; }).then(resolve, function () { resolve(BLANK); });
    }).then(function (s) {
      clearTimeout(timer);
      start(s && typeof s === 'object' && s.version === 8 ? s : BLANK);
    });
  }).catch(function (e) {
    TM.fail('runtime', e && e.message ? e.message : 'points-per-polygon failed');
    ui.showTable(true);
  });
})();
