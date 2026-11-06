// --- buildout-map (html template): a point layer appearing over time --------
// Role: the catalogue's `buildout-map` template, run in the canvas frame after
//       kit.js. A MapLibre map (OpenFreeMap Positron; a plain background if
//       the style does not load) of the payload's point features, each shown
//       from its time step on: the `time` field's year, or its month when the
//       page read it by month (roles.time.bin; month keys "YYYY-MM"). Steps run
//       from the first to the last dated one with no gaps. Colour: the `by`
//       group's legend colour (payload.colours, else the kit palette); size:
//       the measure (area ∝ value) when there is one. The step's own additions
//       are drawn full strength with a dark ring, earlier ones lighter.
//         Play / Pause   steps forward (an interval sized to the span); at the
//                        end it stops, and Play starts again from the first.
//         scrub          a range input and a sparkline of each step's added
//                        count or sum (click or drag a bar to jump there);
//                        either pauses playback.
//       It plays by itself once the map is drawn, from the first step; under
//       prefers-reduced-motion it never does: it opens on the last step, and
//       Play is the visitor's choice. The running total and the step's own
//       additions sit beside the step label; features with no usable time
//       are left out and counted (labels undated / undatedDate).
//       Actions (the page checks and applies them, with Undo): a shown dot
//       offers Select (its id), Show in table and Zoom the map here (fly).
//       The table and CSV list the page's rows per step and group, by name.
//       The map canvas is the PNG of the current step (after a fresh frame).
//       Kit.drawn() after the map's first 'idle'. Frames ≤ 520 px: map 340 px,
//       controls under it, the legend wrapping.
//       Labels read beyond the kit's: field.<time>, value.<time>.<month>,
//       value.<by>.<key>, measure, count, bo.play, bo.pause, bo.total ({n}),
//       bo.added ({n}), template.undated as undated ({n}), act.select ({n}),
//       act.fly, act.table.
//
// Deps: the frame globals TM, TM_INPUT and Kit (kit.js), maplibregl through
//       Kit.libs; the payload shape is assets/templates/payload.ts. Network:
//       the library and the OpenFreeMap style, tiles, glyphs and sprite.

(function () {
  'use strict';
  var STYLE = 'https://tiles.openfreemap.org/styles/positron';
  var BLANK = { version: 8, sources: {}, layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#f2f3f0' } }] };
  var NS = 'http://www.w3.org/2000/svg';
  var INK = '#1f2328', MUTED = '#57606a', BAR = '#8c959f', NOW = '#0969da';
  var CSS = [
    '.bo{display:flex;flex-direction:column;gap:8px;position:absolute;inset:0}',
    '.bo-map{position:relative;flex:1 1 auto;min-height:240px;border:1px solid #d0d7de;border-radius:6px;overflow:hidden}',
    '.bo-ctl{flex:none;display:flex;flex-wrap:wrap;align-items:center;gap:8px;font-size:12px}',
    '.bo-step{font-size:20px;font-weight:600;font-variant-numeric:tabular-nums;min-width:4.5em}',
    '.bo-ctl input[type=range]{flex:1 1 160px}',
    '.bo-stat{color:#57606a;font-variant-numeric:tabular-nums}',
    '.bo-stat b{color:#1f2328}',
    '.bo-spark{flex:none;display:block;width:100%;cursor:pointer;touch-action:none}',
    '.bo-leg{flex:none;display:flex;flex-wrap:wrap;gap:4px 10px;font-size:11px;color:#57606a}',
    '.bo-leg span{display:inline-flex;align-items:center;gap:4px}',
    '.bo-leg i{display:inline-block;width:10px;height:10px;border-radius:50%}',
    '@media (max-width:520px){.bo{position:static}.bo-map{height:340px;flex:none}}',
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
  var timeField = p.roles.time ? p.roles.time.field : null;
  var monthly = !!(p.roles.time && p.roles.time.bin === 'month');
  var byField = p.roles.by[0] ? p.roles.by[0].field : null;
  var measure = p.roles.measure.name;
  var unit = measure === 'count' ? '' : (p.roles.measure.unit || '');
  function valueText(v) { return Kit.fmt(v, unit); }

  // -- steps: every year (or month) from the first to the last dated feature ----------
  function ord(k) {
    if (monthly) { var m = /^(\d{4})-(\d{2})$/.exec(String(k)); return m ? Number(m[1]) * 12 + Number(m[2]) - 1 : null; }
    return typeof k === 'number' && isFinite(k) ? Math.floor(k) : null;
  }
  function keyOf(o) { return monthly ? Math.floor(o / 12) + '-' + String(o % 12 + 1).padStart(2, '0') : o; }
  // A month with no feature has no page label: the frame names it in the payload's locale.
  var monthFmt = null;
  try { monthFmt = new Intl.DateTimeFormat(L('locale', undefined), { month: 'short', year: 'numeric', timeZone: 'UTC' }); } catch (_) { /* the key as it is */ }
  function stepText(k) {
    if (!monthly) return String(k);
    var m = /^(\d{4})-(\d{2})$/.exec(String(k));
    return L('value.' + timeField + '.' + k, monthFmt && m ? monthFmt.format(Date.UTC(Number(m[1]), Number(m[2]) - 1, 15)) : String(k));
  }

  var feats = Array.isArray(p.features) ? p.features : [];
  var lo = Infinity, hi = -Infinity, undated = 0, maxW = 0;
  var PTS = [];
  feats.forEach(function (f) {
    var c = f && f.geometry && f.geometry.type === 'Point' ? f.geometry.coordinates : null;
    if (!c || !isFinite(c[0]) || !isFinite(c[1])) return;
    var props = f.properties || {};
    var o = timeField ? ord(props[timeField]) : null;
    if (o === null) { undated++; return; }
    lo = Math.min(lo, o); hi = Math.max(hi, o);
    var w = measure !== 'count' ? Number(props[measure]) : NaN;
    if (isFinite(w) && w > maxW) maxW = w;
    PTS.push({ p: [c[0], c[1]], o: o, w: isFinite(w) && w > 0 ? w : 0, by: byField ? props[byField] : null,
      id: typeof f.id === 'string' || typeof f.id === 'number' ? f.id : null });
  });
  var N = PTS.length ? hi - lo + 1 : 0;
  var added = [];
  for (var s = 0; s < N; s++) added.push(0);
  PTS.forEach(function (x) { x.s = x.o - lo; added[x.s] += measure !== 'count' ? x.w : 1; });

  var tableRows = (Array.isArray(p.rows) ? p.rows : []).map(function (r) {
    var o = {};
    if (timeField) o[timeField] = r[timeField] === null || r[timeField] === undefined ? '' : stepText(r[timeField]);
    if (byField) o[byField] = r[byField] === null || r[byField] === undefined ? L('none', '') : L('value.' + byField + '.' + r[byField], String(r[byField]));
    o.count = r.count;
    if (typeof r.sum === 'number') o.sum = r.sum;
    return o;
  });
  var ui = Kit.mount({ rows: tableRows });
  if (!ui) return;
  var style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);

  // -- layout -------------------------------------------------------------------------
  var box = ui.body.appendChild(el('div', 'bo'));
  var mapBox = box.appendChild(el('div', 'bo-map'));
  var ctl = box.appendChild(el('div', 'bo-ctl'));
  var playBtn = ctl.appendChild(el('button', 'kit-btn'));
  playBtn.type = 'button';
  var stepEl = ctl.appendChild(el('span', 'bo-step'));
  stepEl.setAttribute('aria-live', 'polite');
  var range = ctl.appendChild(el('input'));
  range.type = 'range';
  range.min = '0';
  range.max = String(Math.max(0, N - 1));
  range.step = '1';
  range.setAttribute('aria-label', L('field.' + timeField, timeField || ''));
  var stat = ctl.appendChild(el('span', 'bo-stat'));
  var spark = svgEl('svg', { class: 'bo-spark', role: 'img' }, box);
  spark.setAttribute('aria-label', L('summary', L('title', '')));
  var leg = box.appendChild(el('div', 'bo-leg'));
  if (undated) box.appendChild(el('p', 'bo-stat', L('undated', 'Left out: {n} without a usable year.').replace('{n}', Kit.fmt(undated))));
  if (byField) {
    Object.keys(p.colours && p.colours[byField] || {}).slice(0, 12).forEach(function (k) {
      var it = leg.appendChild(el('span'));
      it.appendChild(el('i')).style.background = Kit.colour(byField, k);
      it.appendChild(document.createTextNode(L('value.' + byField + '.' + k, k)));
    });
  }

  // -- state ---------------------------------------------------------------------------
  var cur = Kit.reducedMotion ? N - 1 : 0, timer = null, map = null, mapReady = false;
  var stepMs = Math.min(700, Math.max(150, Math.round(9000 / Math.max(1, N))));
  function totals() {
    var n = 0, v = 0;
    for (var i = 0; i <= cur; i++) v += added[i] || 0;
    PTS.forEach(function (x) { if (x.s <= cur) n++; });
    return { n: n, v: v };
  }
  function drawSpark() {
    while (spark.firstChild) spark.removeChild(spark.firstChild);
    var W = Math.max(200, box.clientWidth || 600), H = 44;
    spark.setAttribute('width', W); spark.setAttribute('height', H); spark.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
    svgEl('rect', { x: 0, y: 0, width: W, height: H, fill: '#ffffff' }, spark);
    var max = Math.max.apply(null, added.concat([1e-9])), bw = W / Math.max(1, N);
    added.forEach(function (v, i) {
      var h = Math.max(v > 0 ? 1.5 : 0, (v / max) * (H - 14));
      svgEl('rect', { x: i * bw + bw * 0.1, y: H - 12 - h, width: Math.max(1, bw * 0.8), height: h, fill: i === cur ? NOW : i < cur ? INK : BAR, 'fill-opacity': i <= cur ? 0.85 : 0.45 }, spark);
    });
    if (N) {
      svgEl('text', { x: 0, y: H - 1, 'font-size': 10, fill: MUTED, 'font-family': 'system-ui,sans-serif' }, spark).textContent = stepText(keyOf(lo));
      svgEl('text', { x: W, y: H - 1, 'font-size': 10, fill: MUTED, 'text-anchor': 'end', 'font-family': 'system-ui,sans-serif' }, spark).textContent = stepText(keyOf(hi));
    }
  }
  function show(i) {
    cur = Math.max(0, Math.min(N - 1, i));
    range.value = String(cur);
    stepEl.textContent = N ? stepText(keyOf(lo + cur)) : '–';
    var t = totals();
    while (stat.firstChild) stat.removeChild(stat.firstChild);
    var parts = L('bo.total', 'Shown: {n}').split('{n}');
    stat.appendChild(document.createTextNode(parts[0]));
    stat.appendChild(el('b', null, measure !== 'count' ? valueText(t.v) + ' (' + Kit.fmt(t.n) + ')' : Kit.fmt(t.n)));
    stat.appendChild(document.createTextNode(parts.slice(1).join('')));
    stat.appendChild(document.createTextNode(' · ' + L('bo.added', 'added: {n}').replace('{n}', measure !== 'count' ? valueText(added[cur] || 0) : Kit.fmt(added[cur] || 0))));
    drawSpark();
    if (mapReady) {
      map.setFilter('pts', ['<=', ['get', 's'], cur]);
      map.setPaintProperty('pts', 'circle-opacity', ['case', ['==', ['get', 's'], cur], 0.95, 0.55]);
      map.setPaintProperty('pts', 'circle-stroke-width', ['case', ['==', ['get', 's'], cur], 1.4, 0.5]);
    }
  }
  function setPlaying(on) {
    clearInterval(timer);
    timer = null;
    if (on && N > 1) {
      if (cur >= N - 1) show(0);
      timer = setInterval(function () { if (cur >= N - 1) setPlaying(false); else show(cur + 1); }, stepMs);
    }
    playBtn.textContent = timer ? L('bo.pause', 'Pause') : L('bo.play', 'Play');
    playBtn.setAttribute('aria-pressed', timer ? 'true' : 'false');
  }
  playBtn.addEventListener('click', function () { setPlaying(!timer); });
  range.addEventListener('input', function () { setPlaying(false); show(Number(range.value)); });
  function scrubAt(e) {
    var r = spark.getBoundingClientRect();
    if (!r.width || !N) return;
    setPlaying(false);
    show(Math.floor((e.clientX - r.left) / r.width * N));
  }
  spark.addEventListener('pointerdown', function (e) { scrubAt(e); if (spark.setPointerCapture) spark.setPointerCapture(e.pointerId); });
  spark.addEventListener('pointermove', function (e) { if (e.buttons) scrubAt(e); });
  setPlaying(false);
  show(cur);

  // -- map ----------------------------------------------------------------------------
  function radius(x) { return measure !== 'count' && maxW > 0 ? 2 + 9 * Math.sqrt(x.w / maxW) : 3.5; }
  var fc = { type: 'FeatureCollection', features: PTS.map(function (x, i) {
    return { type: 'Feature', geometry: { type: 'Point', coordinates: x.p }, properties: { i: i, s: x.s, r: radius(x), c: byField ? Kit.colour(byField, x.by) : NOW } };
  }) };
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
  function dotMenu(x, cx, cy) {
    if (x.id === null) return;
    Kit.menu(cx, cy, [
      { label: L('act.select', 'Select on the map ({n})').replace('{n}', Kit.fmt(1)), run: function () { Kit.action('select', { ids: [x.id] }); } },
      { label: L('act.table', 'Show in table'), run: function () { Kit.action('table', { ids: [x.id] }); } },
      { label: L('act.fly', 'Zoom the map here'), run: function () { Kit.action('fly', { id: x.id }); } },
    ]);
  }

  function start(styleSpec) {
    map = new maplibregl.Map({
      container: mapBox, style: styleSpec, center: [-98, 39], zoom: 3,
      attributionControl: { compact: true }, cooperativeGestures: true, fadeDuration: 0,
      preserveDrawingBuffer: true, canvasContextAttributes: { preserveDrawingBuffer: true, antialias: true },
    });
    map.on('error', function () { /* a tile or glyph that did not load: the points still draw */ });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    fit();
    map.on('movestart', function (e) { if (e && e.originalEvent) userMoved = true; });
    map.on('load', function () {
      map.addSource('pts', { type: 'geojson', data: fc });
      map.addLayer({ id: 'pts', type: 'circle', source: 'pts', filter: ['<=', ['get', 's'], cur], paint: {
        'circle-radius': ['get', 'r'], 'circle-color': ['get', 'c'], 'circle-opacity': 0.55,
        'circle-stroke-color': INK, 'circle-stroke-width': 0.5, 'circle-stroke-opacity': 0.6,
      } });
      mapReady = true;
      show(cur);
      map.on('mousemove', function (e) { map.getCanvas().style.cursor = map.queryRenderedFeatures(e.point, { layers: ['pts'] }).length ? 'pointer' : ''; });
      map.on('click', function (e) {
        var hit = map.queryRenderedFeatures(e.point, { layers: ['pts'] })[0], oe = e.originalEvent;
        if (hit) dotMenu(PTS[hit.properties.i], oe ? oe.clientX : e.point.x, oe ? oe.clientY : e.point.y);
      });
      map.once('idle', function () {
        Kit.drawn();
        if (!Kit.reducedMotion) setPlaying(true);
      });
    });
    Kit.registerExport(map.getCanvas(), { beforeExport: function () {
      return new Promise(function (resolve) { map.once('idle', function () { resolve(); }); map.triggerRepaint(); });
    } });
    if (typeof ResizeObserver === 'function') {
      new ResizeObserver(function () { map.resize(); if (!userMoved) fit(); drawSpark(); }).observe(box);
    }
  }

  Kit.libs('maplibre-gl', 'maplibre-gl.css').then(function () {
    var timer0;
    return new Promise(function (resolve) {
      timer0 = setTimeout(function () { resolve(BLANK); }, 8000);
      fetch(STYLE).then(function (r) { return r.ok ? r.json() : BLANK; }).then(resolve, function () { resolve(BLANK); });
    }).then(function (st) {
      clearTimeout(timer0);
      start(st && typeof st === 'object' && st.version === 8 ? st : BLANK);
    });
  }).catch(function (e) {
    TM.fail('runtime', e && e.message ? e.message : 'buildout-map failed');
    ui.showTable(true);
  });
})();
