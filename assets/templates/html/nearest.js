// --- nearest (html template): each point's distance to a second layer --------
// Role: the catalogue's `nearest` template, run in the canvas frame after
//       kit.js. The page measured every point of the card's layer to the
//       nearest feature of its second layer (assets/templates/nearest.ts):
//       payload.rows[i] = {id, d_km, to} belongs to payload.features[i] (the
//       points: label, `by`), `to` indexes payload.second.features (only the
//       targets some point is nearest to, each once).
//         map    MapLibre (OpenFreeMap Positron; a plain background if the
//                style does not load): the points coloured within / beyond
//                the threshold (or, with `by`, by its legend colours: the
//                Colour toggle), the targets small and grey. Hover a point:
//                a thin line to its target and a text-only tooltip (its
//                label, distance, the target's label).
//         chart  the share of points within each distance (an ECDF, SVG, its
//                styles as attributes), the threshold as a rule.
//       The threshold slider (params.within km at first, in the visitor's
//       distance unit: payload.units.distance; a log scale from 0.1 to past
//       the 98th percentile) moves the rule, recolours the points and updates
//       the within / beyond counts. The chart reads on a log axis when the
//       distances spread past 100×; when ≥ 5 % of the points are over 500 km
//       from every target, near.far says the second layer may not cover them.
//       Actions (the page checks and applies them, with Undo): a point offers
//       Select (its id), Show in table, Zoom the map here (fly: {id}) and Zoom
//       to its nearest (fly: a bbox around the target); a target offers the
//       zoom only — a target is never selected. "Select the N beyond" selects
//       every point past the threshold (≤ 500, the page's cap; above it the
//       button is disabled and says how many). The table and CSV list each
//       point (id, label, distance, nearest). The map canvas is the PNG
//       (preserveDrawingBuffer, after a fresh frame). Kit.drawn() after the
//       map's first 'idle'. Frames ≤ 520 px: map 300 px over the chart.
//       Labels read beyond the kit's: near.layer2, near.far ({n}, {d}), near.within, near.beyond,
//       near.threshold, near.selectBeyond ({n}), near.tooMany ({n}, {max}),
//       near.ecdf, near.median ({d}), near.none, near.fly2, field.distance,
//       field.nearest, field.id, field.<label / by>, value.<by>.<key>,
//       act.select ({n}), act.fly, act.table.
//
// Deps: the frame globals TM, TM_INPUT and Kit (kit.js), maplibregl through
//       Kit.libs; the payload shape is assets/templates/payload.ts. Network:
//       the library and the OpenFreeMap style, tiles, glyphs and sprite.

(function () {
  'use strict';
  var STYLE = 'https://tiles.openfreemap.org/styles/positron';
  var BLANK = { version: 8, sources: {}, layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#f2f3f0' } }] };
  var NS = 'http://www.w3.org/2000/svg';
  var IN = '#0969da', OUT = '#cf222e', TARGET = '#57606a', INK = '#1f2328', MUTED = '#57606a';
  var MAX_SELECT = 500;
  var KM_PER_MI = 1.609344;
  var CSS = [
    '.nr{display:grid;grid-template-columns:minmax(0,1.4fr) minmax(240px,1fr);gap:10px;position:absolute;inset:0}',
    '.nr-map{position:relative;min-height:220px;border:1px solid #d0d7de;border-radius:6px;overflow:hidden}',
    '.nr-side{display:flex;flex-direction:column;gap:8px;min-height:0;overflow:auto;font-size:12px}',
    '.nr-side>*{flex:none}',
    '.nr-side svg{display:block;width:100%}',
    '.nr-row{display:flex;flex-wrap:wrap;align-items:center;gap:6px}',
    '.nr-row input[type=range]{flex:1 1 140px}',
    '.nr-stat{color:#57606a;font-variant-numeric:tabular-nums}',
    '.nr-stat b{color:#1f2328}',
    '.nr-key{display:inline-flex;align-items:center;gap:4px;color:#57606a}',
    '.nr-key i{display:inline-block;width:10px;height:10px;border-radius:50%}',
    '.nr-seg{display:inline-flex;border:1px solid #d0d7de;border-radius:6px;overflow:hidden}',
    '.nr-seg button{font:inherit;font-size:12px;padding:3px 8px;border:0;background:#fff;color:#1f2328;cursor:pointer}',
    '.nr-seg button[aria-pressed="true"]{background:#1f2328;color:#fff}',
    '.nr-tip{position:absolute;z-index:5;pointer-events:none;max-width:240px;padding:6px 8px;background:rgba(255,255,255,.96);border:1px solid #d0d7de;border-radius:6px;box-shadow:0 2px 8px rgba(0,0,0,.15);font-size:12px;line-height:1.35}',
    '.nr-tip b{display:block;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '@media (max-width:520px){.nr{position:static;display:flex;flex-direction:column}.nr-map{height:300px;flex:none}.nr-side{overflow:visible}}',
  ].join('\n');

  var p = Kit.input();
  if (!p) return;
  function L(key, fallback) { var v = p.labels[key]; return typeof v === 'string' && v ? v : fallback; }
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = String(text);
    return e;
  }
  function svgEl(tag, attrs, parent) {
    var e = document.createElementNS(NS, tag);
    for (var k in attrs) if (Object.prototype.hasOwnProperty.call(attrs, k)) e.setAttribute(k, String(attrs[k]));
    if (parent) parent.appendChild(e);
    return e;
  }
  var mi = p.units && p.units.distance === 'mi';
  var unit = mi ? 'mi' : 'km';
  function disp(km) { return mi ? km / KM_PER_MI : km; }
  function distText(km) { return Kit.fmt(disp(km), unit); }
  var byField = p.roles.by[0] ? p.roles.by[0].field : null;

  // -- points, targets, distances ---------------------------------------------------
  var targets = (p.second && Array.isArray(p.second.features) ? p.second.features : []).map(function (f) {
    var c = f && f.geometry && f.geometry.type === 'Point' ? f.geometry.coordinates : null;
    var props = (f && f.properties) || {};
    var k = Object.keys(props)[0];
    return { p: c, label: k !== undefined && props[k] !== null && props[k] !== undefined ? String(props[k]) : '' };
  });
  var labelKey = null;
  var PTS = [];
  (Array.isArray(p.features) ? p.features : []).forEach(function (f, i) {
    var c = f && f.geometry && f.geometry.type === 'Point' ? f.geometry.coordinates : null;
    var r = p.rows[i] || {};
    if (!c || !isFinite(c[0]) || !isFinite(c[1])) return;
    var props = f.properties || {};
    if (labelKey === null) labelKey = Object.keys(props).filter(function (k) { return k !== byField; })[0] || '';
    var to = typeof r.to === 'number' && targets[r.to] && targets[r.to].p ? r.to : -1;
    PTS.push({
      i: PTS.length, p: [c[0], c[1]], id: typeof f.id === 'string' || typeof f.id === 'number' ? f.id : null,
      label: labelKey && props[labelKey] !== null && props[labelKey] !== undefined ? String(props[labelKey]) : '',
      by: byField ? props[byField] : null, d: typeof r.d_km === 'number' ? r.d_km : NaN, to: to,
    });
  });
  var D = PTS.filter(function (x) { return isFinite(x.d); }).map(function (x) { return x.d; }).sort(function (a, b) { return a - b; });
  function q(f) { return D.length ? D[Math.min(D.length - 1, Math.max(0, Math.ceil(f * D.length) - 1))] : 0; }
  var within = typeof p.params.within === 'number' ? p.params.within : 16.1;

  var tableRows = PTS.map(function (x) {
    var o = { id: x.id };
    if (labelKey) o[labelKey] = x.label;
    if (byField) o[byField] = L('value.' + byField + '.' + x.by, x.by === null || x.by === undefined ? '' : String(x.by));
    o.distance = isFinite(x.d) ? Math.round(disp(x.d) * 100) / 100 : null;
    o.nearest = x.to >= 0 ? targets[x.to].label : '';
    return o;
  });
  var ui = Kit.mount({ rows: tableRows });
  if (!ui) return;
  var style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);

  // -- layout --------------------------------------------------------------------------
  var grid = ui.body.appendChild(el('div', 'nr'));
  var mapBox = grid.appendChild(el('div', 'nr-map'));
  var side = grid.appendChild(el('div', 'nr-side'));
  var tip = el('div', 'nr-tip');
  tip.hidden = true;
  side.appendChild(el('div', 'nr-stat', L('near.median', 'Median {d}').replace('{d}', distText(q(0.5))) + ' · p90 ' + distText(q(0.9))));
  var sliderRow = side.appendChild(el('label', 'nr-row'));
  sliderRow.appendChild(el('span', null, L('near.threshold', 'Threshold')));
  var slider = sliderRow.appendChild(el('input'));
  var sliderText = sliderRow.appendChild(el('b', 'nr-stat'));
  var counts = side.appendChild(el('div', 'nr-row nr-stat'));
  var keyRow = side.appendChild(el('div', 'nr-row'));
  var chart = svgEl('svg', { role: 'img', 'font-family': 'system-ui,sans-serif' }, side);
  chart.setAttribute('aria-label', L('near.ecdf', 'Share of points within each distance'));
  var beyondBtn = side.appendChild(el('button', 'kit-btn'));
  beyondBtn.type = 'button';
  if (!D.length) side.appendChild(el('p', 'nr-stat', L('near.none', 'No point has a nearest feature.')));

  // Distances in display units from LO to a round number past the 98th percentile (and twice the threshold).
  // Wide spreads (a world of points measured to one country's targets) read on a log scale: the slider
  // always (0–SLIDER steps, LO → xMax), the chart when the spread passes 100×.
  function nice(v) { var e = Math.pow(10, Math.floor(Math.log10(Math.max(v, 1e-6)))); var m = v / e; return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * e; }
  var LO = 0.1, SLIDER = 1000;
  var xMax = nice(Math.max(disp(q(0.98)), disp(within) * 2, 1));
  var logX = xMax / Math.max(LO, disp(q(0.1))) > 100;
  function toPos(v) { return Math.round(Math.log(Math.max(LO, Math.min(xMax, v)) / LO) / Math.log(xMax / LO) * SLIDER); }
  function fromPos(i) { var v = LO * Math.pow(xMax / LO, i / SLIDER); return Number(v.toPrecision(v < 10 ? 2 : 3)); }
  slider.type = 'range';
  slider.min = '0';
  slider.max = String(SLIDER);
  slider.step = '1';
  slider.value = String(toPos(disp(within)));
  slider.setAttribute('aria-label', L('near.threshold', 'Threshold'));
  // The threshold: the one asked for until the slider moves, then the slider's.
  var thresh = disp(within);
  var far = D.filter(function (v) { return v > 500; }).length;
  if (far && far >= D.length * 0.05) {
    side.insertBefore(el('p', 'nr-stat', L('near.far', '{n} points are more than {d} from every feature of the second layer: it may not cover where they are. An Area narrows the points.')
      .replace('{n}', Kit.fmt(far)).replace('{d}', distText(500))), sliderRow);
  }

  var colourMode = 'dist';
  function threshKm() { return mi ? thresh * KM_PER_MI : thresh; }
  function beyond(x) { return isFinite(x.d) && x.d > threshKm(); }
  function colourOf(x) { return colourMode === 'by' ? Kit.colour(byField, x.by) : beyond(x) ? OUT : IN; }

  function keyLegend() {
    while (keyRow.firstChild) keyRow.removeChild(keyRow.firstChild);
    var items = colourMode === 'by'
      ? Object.keys(p.colours && p.colours[byField] || {}).slice(0, 8).map(function (k) { return [Kit.colour(byField, k), L('value.' + byField + '.' + k, k)]; })
      : [[IN, L('near.within', 'Within')], [OUT, L('near.beyond', 'Beyond')]];
    items.push([TARGET, L('near.layer2', '')]);
    items.forEach(function (it) {
      var s = keyRow.appendChild(el('span', 'nr-key'));
      s.appendChild(el('i')).style.background = it[0];
      s.appendChild(document.createTextNode(it[1]));
    });
  }
  if (byField) {
    var seg = side.insertBefore(el('div', 'nr-seg'), keyRow);
    seg.setAttribute('role', 'group');
    [['dist', L('field.distance', 'Distance')], ['by', L('field.' + byField, byField)]].forEach(function (o) {
      var b = seg.appendChild(el('button', null, o[1]));
      b.type = 'button';
      b.setAttribute('aria-pressed', o[0] === colourMode ? 'true' : 'false');
      b.addEventListener('click', function () {
        colourMode = o[0];
        Array.prototype.forEach.call(seg.children, function (x) { x.setAttribute('aria-pressed', x === b ? 'true' : 'false'); });
        update();
      });
    });
  }

  // -- the ECDF --------------------------------------------------------------------------
  function drawChart() {
    while (chart.firstChild) chart.removeChild(chart.firstChild);
    var W = Math.max(200, side.clientWidth || 300), H = 150, l = 34, r = 8, t = 8, b = 26;
    chart.setAttribute('width', W); chart.setAttribute('height', H); chart.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
    var X = function (v) {
      var f = logX ? Math.log(Math.max(LO, v) / LO) / Math.log(xMax / LO) : v / xMax;
      return l + Math.max(0, Math.min(1, f)) * (W - l - r);
    }, Y = function (s) { return H - b - s * (H - t - b); };
    svgEl('rect', { x: 0, y: 0, width: W, height: H, fill: '#ffffff' }, chart);
    [0, 0.5, 1].forEach(function (s) {
      svgEl('line', { x1: l, x2: W - r, y1: Y(s), y2: Y(s), stroke: '#eaeef2' }, chart);
      svgEl('text', { x: l - 4, y: Y(s) + 4, 'font-size': 10, fill: MUTED, 'text-anchor': 'end' }, chart).textContent = Math.round(s * 100) + '%';
    });
    var ticks = logX ? [LO, Math.sqrt(LO * xMax), xMax].map(function (v) { return Number(v.toPrecision(1)); }) : [0, xMax / 2, xMax];
    ticks.forEach(function (v, i) {
      svgEl('text', { x: X(v), y: H - 8, 'font-size': 10, fill: MUTED, 'text-anchor': i === 0 ? 'start' : i === 2 ? 'end' : 'middle' }, chart).textContent = Kit.fmt(v, i === 2 ? unit : '');
    });
    if (D.length) {
      var step = Math.max(1, Math.floor(D.length / 400)), d = 'M' + X(0) + ',' + Y(0);
      for (var i = 0; i < D.length; i += step) d += 'H' + X(disp(D[i])).toFixed(1) + 'V' + Y((i + 1) / D.length).toFixed(1);
      d += 'V' + Y(1) + 'H' + X(xMax);
      svgEl('path', { d: d, fill: 'none', stroke: INK, 'stroke-width': 1.5 }, chart);
    }
    var tx = X(thresh);
    svgEl('line', { x1: tx, x2: tx, y1: t, y2: H - b, stroke: OUT, 'stroke-width': 1.5, 'stroke-dasharray': '4 3' }, chart);
  }

  function update() {
    var th = threshKm(), out = PTS.filter(beyond), ids = out.map(function (x) { return x.id; }).filter(function (id) { return id !== null; });
    var inside = D.filter(function (v) { return v <= th; }).length;
    sliderText.textContent = Kit.fmt(thresh, unit);
    while (counts.firstChild) counts.removeChild(counts.firstChild);
    [[L('near.within', 'Within'), inside, D.length ? ' (' + Kit.fmt(Math.round(inside / D.length * 1000) / 10) + '%)' : ''], [L('near.beyond', 'Beyond'), D.length - inside, '']].forEach(function (c) {
      var s = counts.appendChild(el('span', null, c[0] + ': '));
      s.appendChild(el('b', null, Kit.fmt(c[1]) + c[2]));
    });
    var ok = ids.length > 0 && ids.length === out.length && ids.length <= MAX_SELECT;
    beyondBtn.disabled = !ok;
    beyondBtn.textContent = out.length > MAX_SELECT
      ? L('near.tooMany', '{n} beyond: more than {max} to select').replace('{n}', Kit.fmt(out.length)).replace('{max}', Kit.fmt(MAX_SELECT))
      : L('near.selectBeyond', 'Select the {n} beyond').replace('{n}', Kit.fmt(out.length));
    beyondBtn.onclick = ok ? function () { Kit.action('select', { ids: ids }); } : null;
    keyLegend();
    drawChart();
    if (mapReady) map.getSource('pts').setData(pointsFc());
  }
  slider.addEventListener('input', function () { thresh = fromPos(Number(slider.value)); update(); });

  // -- map ----------------------------------------------------------------------------
  var map = null, mapReady = false;
  function pointsFc() {
    return { type: 'FeatureCollection', features: PTS.map(function (x) { return { type: 'Feature', geometry: { type: 'Point', coordinates: x.p }, properties: { i: x.i, c: colourOf(x) } }; }) };
  }
  var targetFc = { type: 'FeatureCollection', features: [] };
  targets.forEach(function (t, k) { if (t.p) targetFc.features.push({ type: 'Feature', geometry: { type: 'Point', coordinates: t.p }, properties: { k: k } }); });
  var EMPTY = { type: 'FeatureCollection', features: [] };
  function lineTo(x) {
    return x && x.to >= 0 ? { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [x.p, targets[x.to].p] } }] } : EMPTY;
  }
  function around(c) { var e = 0.02; return [c[0] - e, c[1] - e, c[0] + e, c[1] + e]; }

  function pointMenu(x, cx, cy) {
    var items = [];
    if (x.id !== null) {
      items.push({ label: L('act.select', 'Select on the map ({n})').replace('{n}', Kit.fmt(1)), run: function () { Kit.action('select', { ids: [x.id] }); } });
      items.push({ label: L('act.table', 'Show in table'), run: function () { Kit.action('table', { ids: [x.id] }); } });
      items.push({ label: L('act.fly', 'Zoom the map here'), run: function () { Kit.action('fly', { id: x.id }); } });
    }
    if (x.to >= 0) items.push({ label: L('near.fly2', 'Zoom to its nearest'), run: function () { Kit.action('fly', { bbox: around(targets[x.to].p) }); } });
    if (items.length) Kit.menu(cx, cy, items);
  }
  function showTip(x, pt) {
    while (tip.firstChild) tip.removeChild(tip.firstChild);
    tip.appendChild(el('b', null, x.label || '—'));
    tip.appendChild(el('div', null, isFinite(x.d) ? distText(x.d) : L('near.none', '')));
    if (x.to >= 0) tip.appendChild(el('div', null, L('field.nearest', 'Nearest') + ': ' + (targets[x.to].label || '—')));
    tip.hidden = false;
    var w = tip.offsetWidth || 160;
    tip.style.left = Math.max(4, Math.min(pt.x + 12, mapBox.clientWidth - w - 4)) + 'px';
    tip.style.top = Math.max(4, pt.y + 12) + 'px';
  }

  var bounds = [Infinity, Infinity, -Infinity, -Infinity];
  if (PTS.length) {
    var xs = PTS.map(function (x) { return x.p[0]; }).sort(function (a, b) { return a - b; });
    var ys = PTS.map(function (x) { return x.p[1]; }).sort(function (a, b) { return a - b; });
    var cut = PTS.length >= 200 ? 0.025 : 0;
    var at = function (a, f) { return a[Math.min(a.length - 1, Math.round((a.length - 1) * f))]; };
    bounds = [at(xs, cut), at(ys, cut), at(xs, 1 - cut), at(ys, 1 - cut)];
  }
  var userMoved = false;
  function fit() { if (bounds[0] <= bounds[2]) map.fitBounds([[bounds[0], bounds[1]], [bounds[2], bounds[3]]], { padding: 24, maxZoom: 10, animate: false }); }

  function start(styleSpec) {
    map = new maplibregl.Map({
      container: mapBox, style: styleSpec, center: [-98, 39], zoom: 3,
      attributionControl: { compact: true }, cooperativeGestures: true, fadeDuration: 0,
      preserveDrawingBuffer: true, canvasContextAttributes: { preserveDrawingBuffer: true, antialias: true },
    });
    map.on('error', function () { /* a tile or glyph that did not load: the points still draw */ });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    mapBox.appendChild(tip);
    fit();
    map.on('movestart', function (e) { if (e && e.originalEvent) userMoved = true; });
    map.on('load', function () {
      map.addSource('tgt', { type: 'geojson', data: targetFc });
      map.addSource('pts', { type: 'geojson', data: pointsFc() });
      map.addSource('link', { type: 'geojson', data: EMPTY });
      map.addLayer({ id: 'link', type: 'line', source: 'link', paint: { 'line-color': INK, 'line-width': 1.5, 'line-dasharray': [2, 1] } });
      map.addLayer({ id: 'tgt', type: 'circle', source: 'tgt', paint: { 'circle-radius': 3, 'circle-color': TARGET, 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 1 } });
      map.addLayer({ id: 'pts', type: 'circle', source: 'pts', paint: { 'circle-radius': 4, 'circle-color': ['get', 'c'], 'circle-opacity': 0.85, 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 0.8 } });
      mapReady = true;
      map.on('mousemove', function (e) {
        var hit = map.queryRenderedFeatures(e.point, { layers: ['pts'] })[0];
        var x = hit ? PTS[hit.properties.i] : null;
        map.getSource('link').setData(lineTo(x));
        map.getCanvas().style.cursor = x || map.queryRenderedFeatures(e.point, { layers: ['tgt'] }).length ? 'pointer' : '';
        if (x) showTip(x, e.point); else tip.hidden = true;
      });
      map.on('mouseout', function () { tip.hidden = true; map.getSource('link').setData(EMPTY); });
      map.on('click', function (e) {
        var oe = e.originalEvent, cx = oe ? oe.clientX : e.point.x, cy = oe ? oe.clientY : e.point.y;
        var hit = map.queryRenderedFeatures(e.point, { layers: ['pts'] })[0];
        if (hit) { tip.hidden = true; pointMenu(PTS[hit.properties.i], cx, cy); return; }
        var t = map.queryRenderedFeatures(e.point, { layers: ['tgt'] })[0];
        if (t) Kit.menu(cx, cy, [{ label: L('act.fly', 'Zoom the map here'), run: function () { Kit.action('fly', { bbox: around(targets[t.properties.k].p) }); } }]);
      });
      map.once('idle', function () { Kit.drawn(); });
    });
    Kit.registerExport(map.getCanvas(), { beforeExport: function () {
      return new Promise(function (resolve) { map.once('idle', function () { resolve(); }); map.triggerRepaint(); });
    } });
    if (typeof ResizeObserver === 'function') {
      new ResizeObserver(function () { map.resize(); if (!userMoved) fit(); drawChart(); }).observe(grid);
    }
  }

  update();
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
    TM.fail('runtime', e && e.message ? e.message : 'nearest failed');
    ui.showTable(true);
  });
})();
