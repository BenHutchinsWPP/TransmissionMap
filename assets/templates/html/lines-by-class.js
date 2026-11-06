// --- lines-by-class (html template): a line layer's length by class ----------
// Role: the catalogue's `lines-by-class` template, run in the canvas frame
//       after kit.js. A MapLibre mini-map (OpenFreeMap Positron; a plain
//       background if the style does not load) draws the payload's line
//       features coloured by the `by` class (the legend's colours from
//       payload.colours, else the kit palette), beside a bar chart of the
//       measure (length_km, any other measure, or count) per class from the
//       payload rows. Hover or focus a bar: that class is lit on the map and
//       the rest dimmed; click it (Enter / Space) to keep it lit. Hover or tap
//       a line: a text-only tooltip with its label, class and length, and its
//       bar lit. Classes past params.top are summed into "Other". Wide frames
//       put the bars beside the map, ≤ 520 px under it. The map canvas is
//       the PNG export (preserveDrawingBuffer; it waits for the map's next
//       fresh frame, beforeExport). Kit.drawn() after the map's
//       first 'idle' with the bars drawn.
//       Actions (the page checks and applies them, with Undo): clicking a bar
//       (or Enter) offers "Show only this on the map" (where: {field, bin});
//       clicking a line offers Select (its id), Zoom the map to it (fly) and
//       Show in table. "Other" and "none" offer nothing.
//       A feature whose class is not a row key (a facet field the page folded
//       in the rows but not in the features) is drawn grey under "Other".
//       Labels read beyond the kit's: other, none, value.<by>.<key>,
//       act.where, act.select ({n}), act.fly, act.table.
//
// Deps: the frame globals TM, TM_INPUT and Kit (kit.js), maplibregl and d3
//       (scales only) through Kit.libs; the payload shape is
//       assets/templates/payload.ts. Network: the libraries and the
//       OpenFreeMap style, tiles, glyphs and sprite (the frame's CSP).

(function () {
  'use strict';
  var STYLE = 'https://tiles.openfreemap.org/styles/positron';
  var BLANK = { version: 8, sources: {}, layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#f2f3f0' } }] };
  var GREY = '#9ca3af';
  var NONE = '\u0000none', OTHER = '\u0000other';
  var KM_PER_MI = 1.609344;
  var CSS = [
    '.lbc{display:grid;grid-template-columns:minmax(0,1.6fr) minmax(220px,1fr);gap:10px;position:absolute;inset:0}',
    '.lbc-map{position:relative;min-height:200px;border:1px solid #d0d7de;border-radius:6px;overflow:hidden}',
    '.lbc-side{display:flex;flex-direction:column;gap:4px;min-height:0;overflow:auto}',
    '.lbc-total{font-size:12px;color:#57606a;display:flex;justify-content:space-between;gap:8px}',
    '.lbc-total b{color:#1f2328;font-variant-numeric:tabular-nums}',
    '.lbc-bars{display:block;flex:none;width:100%;font-size:12px}',
    '.lbc-bar{cursor:pointer;outline:none}',
    '.lbc-bar rect.lbc-fill{transition:width .35s ease,opacity .15s}',
    '.lbc-bar text{fill:#1f2328}',
    '.lbc-bar .lbc-val{fill:#57606a;font-variant-numeric:tabular-nums}',
    '.lbc-bar .lbc-hit{fill:transparent}',
    '.lbc-bar:focus-visible .lbc-hit,.lbc-bar.on .lbc-hit{fill:#eaeef2}',
    '.lbc-dim rect.lbc-fill{opacity:.3}',
    '.lbc-tip{position:absolute;z-index:5;pointer-events:none;max-width:240px;padding:6px 8px;background:rgba(255,255,255,.96);border:1px solid #d0d7de;border-radius:6px;box-shadow:0 2px 8px rgba(0,0,0,.15);font-size:12px;line-height:1.35}',
    '.lbc-tip b{display:block;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.lbc-sw{display:inline-block;width:10px;height:3px;margin-inline-end:5px;vertical-align:middle;border-radius:1px}',
    '.lbc-empty{position:absolute;z-index:4;top:8px;left:8px;margin:0;padding:4px 8px;background:#fff;border-radius:4px;color:#57606a}',
    '@media (max-width:520px){.lbc{position:static;display:flex;flex-direction:column}.lbc-map{height:240px;flex:none}.lbc-side{overflow:visible}}',
  ].join('\n');

  var p = Kit.input();
  if (!p) return;
  var ui = Kit.mount();
  if (!ui) return;

  function L(key, fallback) { var v = p.labels[key]; return typeof v === 'string' && v ? v : fallback; }
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = String(text);
    return e;
  }
  function svgEl(tag, attrs) {
    var e = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (var k in attrs) if (Object.prototype.hasOwnProperty.call(attrs, k)) e.setAttribute(k, String(attrs[k]));
    return e;
  }

  var by = p.roles.by[0] ? p.roles.by[0].field : null;
  var measure = p.roles.measure.name;
  var unit = p.roles.measure.unit || '';
  var timeField = p.roles.time ? p.roles.time.field : null;
  var top = typeof p.params.top === 'number' && p.params.top >= 1 ? Math.floor(p.params.top) : 10;

  // -- classes from the rows ------------------------------------------------------
  function keyOf(v) { return v === null || v === undefined || v === '' ? NONE : String(v); }
  var sums = {}, order = [];
  p.rows.forEach(function (r) {
    var k = keyOf(by ? r[by] : null);
    if (!sums[k]) { sums[k] = { value: 0, count: 0 }; order.push(k); }
    sums[k].value += typeof r.sum === 'number' ? r.sum : r.count;
    sums[k].count += r.count;
  });
  // The legend's own order (payload.colours keys) first, then the rest by value.
  var legendOrder = by && p.colours[by] ? Object.keys(p.colours[by]) : [];
  var ranked = order.slice().sort(function (a, b) { return sums[b].value - sums[a].value; });
  var kept = ranked.slice(0, top);
  var keptSet = {};
  kept.forEach(function (k) { keptSet[k] = 1; });
  var classes = legendOrder.filter(function (k) { return keptSet[k]; })
    .concat(kept.filter(function (k) { return legendOrder.indexOf(k) < 0 && k !== NONE; }))
    .concat(keptSet[NONE] ? [NONE] : []);
  var lumped = ranked.slice(top);
  var CLASSES = classes.map(function (k) { return { key: k, value: sums[k].value, count: sums[k].count }; });
  if (lumped.length) {
    CLASSES.push({
      key: OTHER,
      value: lumped.reduce(function (s, k) { return s + sums[k].value; }, 0),
      count: lumped.reduce(function (s, k) { return s + sums[k].count; }, 0),
    });
  }
  var classIndex = {};
  CLASSES.forEach(function (c) { classIndex[c.key] = c; });
  var total = CLASSES.reduce(function (s, c) { return s + c.value; }, 0);

  function classLabel(k) {
    if (k === OTHER) return L('other', 'Other');
    if (k === NONE) return L('none', '—');
    return L('value.' + by + '.' + k, k);
  }
  function classColour(k) { return k === OTHER || k === NONE ? GREY : Kit.colour(by, k); }
  /** The class a feature is drawn as: its row key, "Other" when lumped or not a row key. */
  function classOfValue(v) {
    var k = keyOf(v);
    if (classIndex[k]) return k;
    return OTHER;
  }

  // -- features ---------------------------------------------------------------------
  function haversine(a, b) {
    var R = 6371.0088, rad = Math.PI / 180;
    var dLat = (b[1] - a[1]) * rad, dLng = (b[0] - a[0]) * rad;
    var h = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }
  function lineKm(g) {
    var parts = g.type === 'LineString' ? [g.coordinates] : g.type === 'MultiLineString' ? g.coordinates : [];
    var km = 0;
    parts.forEach(function (c) { for (var i = 1; i < c.length; i++) km += haversine(c[i - 1], c[i]); });
    return km;
  }
  var bounds = [Infinity, Infinity, -Infinity, -Infinity];
  function grow(c) {
    if (Array.isArray(c[0])) { c.forEach(grow); return; }
    if (!isFinite(c[0]) || !isFinite(c[1])) return;
    if (c[0] < bounds[0]) bounds[0] = c[0];
    if (c[1] < bounds[1]) bounds[1] = c[1];
    if (c[0] > bounds[2]) bounds[2] = c[0];
    if (c[1] > bounds[3]) bounds[3] = c[1];
  }
  var META = [];
  var fc = { type: 'FeatureCollection', features: [] };
  (Array.isArray(p.features) ? p.features : []).forEach(function (f) {
    var g = f && f.geometry;
    if (!g || (g.type !== 'LineString' && g.type !== 'MultiLineString')) return;
    var props = f.properties || {};
    var labelField = null;
    for (var k in props) {
      if (Object.prototype.hasOwnProperty.call(props, k) && k !== by && k !== measure && k !== timeField) { labelField = k; break; }
    }
    var raw = by ? props[by] : null;
    var cls = classOfValue(raw);
    var km = measure === 'length_km' && typeof props.length_km === 'number' ? props.length_km : lineKm(g);
    var i = META.length;
    META.push({ id: typeof f.id === 'string' || typeof f.id === 'number' ? f.id : null, label: labelField ? props[labelField] : null, raw: raw, cls: cls, km: km });
    grow(g.coordinates);
    fc.features.push({ type: 'Feature', geometry: g, properties: { _i: i, _c: cls } });
  });

  // -- text -------------------------------------------------------------------------
  function kmText(km) {
    var s = Kit.fmt(km, 'km');
    return p.units && p.units.distance === 'mi' ? s + ' (' + Kit.fmt(km / KM_PER_MI, 'mi') + ')' : s;
  }
  function valueText(v) { return measure === 'length_km' ? kmText(v) : Kit.fmt(v, measure === 'count' ? '' : unit); }
  function barValue(v) { return Kit.fmt(v, measure === 'count' ? '' : unit) + ' · ' + shareText(v); }
  function shareText(v) { return total > 0 ? Kit.fmt(Math.round((v / total) * 1000) / 10) + '%' : ''; }
  /** The tooltip's lines for feature i: label, class, length. */
  function tipLines(i) {
    var m = META[i];
    var label = m.label === null || m.label === undefined || m.label === '' ? L('none', '—') : String(m.label);
    var cls = m.cls === OTHER && m.raw !== null && m.raw !== undefined && m.raw !== '' && !classIndex[keyOf(m.raw)]
      ? String(m.raw) : classLabel(m.cls);
    return [label, cls, kmText(m.km)];
  }

  // -- layout -----------------------------------------------------------------------
  var style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);
  var grid = ui.body.appendChild(el('div', 'lbc'));
  var mapBox = grid.appendChild(el('div', 'lbc-map'));
  var side = grid.appendChild(el('div', 'lbc-side'));
  var head = side.appendChild(el('div', 'lbc-total'));
  head.appendChild(el('span', null, L('measure', measure)));
  head.appendChild(el('b', null, valueText(total)));
  var bars = side.appendChild(svgEl('svg', { class: 'lbc-bars', role: 'group' }));
  bars.setAttribute('aria-label', L('measure', measure));
  var tip = el('div', 'lbc-tip');
  tip.hidden = true;
  tip.setAttribute('role', 'status');

  // -- highlight state ----------------------------------------------------------------
  var map = null, mapReady = false;
  var pinned = null, hovered = null, hoverLine = -1;
  var barNodes = {};
  function active() { return hovered !== null ? hovered : pinned; }
  function paint() {
    var a = active();
    bars.classList.toggle('lbc-dim', a !== null);
    for (var k in barNodes) {
      if (!Object.prototype.hasOwnProperty.call(barNodes, k)) continue;
      barNodes[k].classList.toggle('on', k === a);
      barNodes[k].setAttribute('aria-pressed', k === pinned ? 'true' : 'false');
      var fill = barNodes[k].querySelector('.lbc-fill');
      if (fill) fill.style.opacity = a === null || k === a ? '1' : '';
    }
    if (!mapReady) return;
    map.setPaintProperty('lines', 'line-opacity', a === null ? 0.9 : ['case', ['==', ['get', '_c'], a], 1, 0.12]);
    map.setPaintProperty('lines', 'line-width', a === null ? WIDTH : ['case', ['==', ['get', '_c'], a], WIDE, WIDTH]);
    map.setFilter('hover', ['==', ['get', '_i'], hoverLine]);
  }
  var WIDTH = ['interpolate', ['linear'], ['zoom'], 3, 0.8, 7, 1.6, 12, 3];
  var WIDE = ['interpolate', ['linear'], ['zoom'], 3, 2, 7, 3.2, 12, 5];

  // -- bars ---------------------------------------------------------------------------
  var ROW = 24, GAP = 4;
  function drawBars() {
    var w = Math.max(200, Math.round(side.clientWidth || 280));
    while (bars.firstChild) bars.removeChild(bars.firstChild);
    barNodes = {};
    var longest = CLASSES.reduce(function (n, c) { return Math.max(n, barValue(c.value).length); }, 0);
    var labelW = Math.min(130, Math.round(w * 0.36)), valueW = Math.min(Math.round(w * 0.42), longest * 6.6 + 10);
    var x = d3.scaleLinear().domain([0, Math.max(1e-9, d3.max(CLASSES, function (c) { return c.value; }) || 0)])
      .range([0, Math.max(10, w - labelW - valueW - 8)]);
    bars.setAttribute('viewBox', '0 0 ' + w + ' ' + Math.max(ROW, CLASSES.length * (ROW + GAP)));
    bars.setAttribute('height', String(Math.max(ROW, CLASSES.length * (ROW + GAP))));
    CLASSES.forEach(function (c, i) {
      var g = svgEl('g', { class: 'lbc-bar', transform: 'translate(0,' + i * (ROW + GAP) + ')', tabindex: 0, role: 'button' });
      g.setAttribute('aria-label', classLabel(c.key) + ': ' + valueText(c.value) + ' (' + shareText(c.value) + ')');
      g.appendChild(svgEl('rect', { class: 'lbc-hit', x: 0, y: 0, width: w, height: ROW, rx: 4 }));
      var name = svgEl('text', { x: labelW - 6, y: ROW / 2, 'text-anchor': 'end', 'dominant-baseline': 'central' });
      var text = classLabel(c.key);
      var fit = Math.max(4, Math.floor((labelW - 8) / 6.6));
      name.textContent = text.length > fit ? text.slice(0, fit - 1) + '…' : text;
      var title = svgEl('title', {});
      title.textContent = text;
      g.appendChild(title);
      g.appendChild(name);
      var bw = Math.max(c.value > 0 ? 2 : 0, x(c.value));
      g.appendChild(svgEl('rect', { class: 'lbc-fill', x: labelW, y: 4, width: bw, height: ROW - 8, rx: 2, fill: classColour(c.key) }));
      var val = svgEl('text', { class: 'lbc-val', x: labelW + bw + 6, y: ROW / 2, 'dominant-baseline': 'central' });
      val.textContent = barValue(c.value);
      g.appendChild(val);
      g.addEventListener('mouseenter', function () { hovered = c.key; paint(); });
      g.addEventListener('mouseleave', function () { hovered = null; paint(); });
      g.addEventListener('focus', function () { hovered = c.key; paint(); });
      g.addEventListener('blur', function () { hovered = null; paint(); });
      g.addEventListener('click', function (e) { pinned = pinned === c.key ? null : c.key; paint(); classMenu(c.key, e.clientX, e.clientY); });
      g.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault(); pinned = pinned === c.key ? null : c.key; paint();
          var r = g.getBoundingClientRect();
          classMenu(c.key, r.left + labelW, r.bottom);
        }
        if (e.key === 'Escape') { pinned = null; paint(); }
      });
      barNodes[c.key] = g;
      bars.appendChild(g);
    });
    paint();
  }

  // -- actions ----------------------------------------------------------------------------
  function classMenu(k, x, y) {
    if (!by || k === OTHER || k === NONE || pinned !== k) return;
    Kit.menu(x, y, [{ label: L('act.where', 'Show only this on the map'), run: function () { Kit.action('where', { field: by, bin: k }); } }]);
  }
  function lineMenu(i, x, y) {
    var id = META[i].id;
    if (id === null) return;
    Kit.menu(x, y, [
      { label: L('act.select', 'Select on the map ({n})').replace('{n}', Kit.fmt(1)), run: function () { Kit.action('select', { ids: [id] }); } },
      { label: L('act.fly', 'Zoom the map here'), run: function () { Kit.action('fly', { id: id }); } },
      { label: L('act.table', 'Show in table'), run: function () { Kit.action('table', { ids: [id] }); } },
    ]);
  }

  // -- tooltip --------------------------------------------------------------------------
  function showTip(i, x, y) {
    while (tip.firstChild) tip.removeChild(tip.firstChild);
    var lines = tipLines(i);
    tip.appendChild(el('b', null, lines[0]));
    var row = tip.appendChild(el('div'));
    var sw = row.appendChild(el('span', 'lbc-sw'));
    sw.style.background = classColour(META[i].cls);
    row.appendChild(document.createTextNode(lines[1]));
    tip.appendChild(el('div', null, lines[2]));
    tip.hidden = false;
    var bw = mapBox.clientWidth, tw = tip.offsetWidth || 160;
    tip.style.left = Math.max(4, Math.min(x + 12, bw - tw - 4)) + 'px';
    tip.style.top = Math.max(4, y + 12) + 'px';
  }
  function hideTip() { tip.hidden = true; }
  function pick(point) {
    var r = 5;
    var hits = map.queryRenderedFeatures([[point.x - r, point.y - r], [point.x + r, point.y + r]], { layers: ['lines'] });
    return hits.length ? Number(hits[0].properties._i) : -1;
  }
  function onPoint(e) {
    var i = pick(e.point);
    if (i === hoverLine) { if (i >= 0) showTip(i, e.point.x, e.point.y); return; }
    hoverLine = i;
    if (i >= 0) {
      hovered = META[i].cls;
      showTip(i, e.point.x, e.point.y);
      map.getCanvas().style.cursor = 'pointer';
    } else {
      hovered = null;
      hideTip();
      map.getCanvas().style.cursor = '';
    }
    paint();
  }

  // -- map --------------------------------------------------------------------------------
  var userMoved = false;
  function fit() {
    if (!hasBounds()) return;
    map.fitBounds([[bounds[0], bounds[1]], [bounds[2], bounds[3]]], { padding: 24, maxZoom: 11, animate: false });
  }
  function hasBounds() { return bounds[0] <= bounds[2] && bounds[1] <= bounds[3]; }
  function lineColour() {
    if (!CLASSES.length) return GREY;
    var m = ['match', ['get', '_c']];
    CLASSES.forEach(function (c) { m.push(c.key, classColour(c.key)); });
    m.push(GREY);
    return m;
  }

  function start(styleSpec) {
    map = new maplibregl.Map({
      container: mapBox,
      style: styleSpec,
      center: [-98, 39],
      zoom: 3,
      attributionControl: { compact: true },
      cooperativeGestures: true,
      preserveDrawingBuffer: true,
      canvasContextAttributes: { preserveDrawingBuffer: true, antialias: true },
      fadeDuration: 0,
    });
    map.on('error', function () { /* a tile or glyph that did not load: the lines still draw */ });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    mapBox.appendChild(tip);
    fit();
    map.on('movestart', function (e) { if (e && e.originalEvent) userMoved = true; });
    mapBox.addEventListener('mouseleave', function () { hoverLine = -1; hovered = null; hideTip(); paint(); });
    map.on('load', function () {
      map.addSource('lines', { type: 'geojson', data: fc });
      map.addLayer({ id: 'hover', type: 'line', source: 'lines', filter: ['==', ['get', '_i'], -1],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#1f2328', 'line-opacity': 0.35, 'line-width': ['interpolate', ['linear'], ['zoom'], 3, 6, 12, 10] } });
      map.addLayer({ id: 'lines', type: 'line', source: 'lines',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': lineColour(), 'line-width': WIDTH, 'line-opacity': 0.9 } });
      mapReady = true;
      paint();
      map.on('mousemove', onPoint);
      map.on('click', function (e) {
        onPoint(e);
        var i = pick(e.point), oe = e.originalEvent;
        if (i >= 0) lineMenu(i, oe ? oe.clientX : e.point.x, oe ? oe.clientY : e.point.y);
      });
      map.on('mouseout', function () { hoverLine = -1; hovered = null; hideTip(); paint(); });
      map.once('idle', function () { Kit.drawn(); });
    });
    // A canvas that just changed size (the Table toggle) is blank until the map draws again.
    Kit.registerExport(map.getCanvas(), { beforeExport: function () {
      return new Promise(function (resolve) { map.once('idle', function () { resolve(); }); map.triggerRepaint(); });
    } });
    if (typeof ResizeObserver === 'function') {
      var last = 0;
      new ResizeObserver(function () {
        map.resize();
        if (!userMoved) fit();
        var w = side.clientWidth;
        if (Math.abs(w - last) > 8) { last = w; drawBars(); }
      }).observe(grid);
    }
  }

  Kit.libs('maplibre-gl', 'maplibre-gl.css', 'd3').then(function () {
    drawBars();
    if (!fc.features.length) mapBox.appendChild(el('p', 'lbc-empty', Kit.fmt(0) + ' · ' + L('count', 'count')));
    var timer;
    var styleSpec = new Promise(function (resolve) {
      timer = setTimeout(function () { resolve(BLANK); }, 8000);
      fetch(STYLE).then(function (r) { return r.ok ? r.json() : BLANK; }).then(resolve, function () { resolve(BLANK); });
    });
    return styleSpec.then(function (s) {
      clearTimeout(timer);
      start(s && typeof s === 'object' && s.version === 8 ? s : BLANK);
    });
  }).catch(function (e) {
    TM.fail('runtime', e && e.message ? e.message : 'lines-by-class failed');
    ui.showTable(true);
  });
})();
