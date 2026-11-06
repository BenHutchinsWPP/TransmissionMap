// --- density (html template): where a point layer's features cluster ---------
// Role: the catalogue's `density` template, run in the canvas frame after
//       kit.js. deck.gl drawn inside a MapLibre map (OpenFreeMap Positron; a
//       plain background if the style does not load; MapboxOverlay
//       interleaved, so the map canvas — preserveDrawingBuffer — is the PNG
//       export with the hexagons in it). Two views of the payload's point
//       features (polygon layers arrive as centres):
//         3D hex   HexagonLayer columns, height and colour the count or the
//                  sum of the measure per hexagon; the hexagon size follows
//                  the zoom; hover a column: count, sum and its largest
//                  feature in a text-only tooltip.
//         2D heat  HeatmapLayer weighted the same way, flat camera.
//       Controls: the view toggle, Count / measure when the payload carries
//       an additive measure, Orbit (a slow turn; hidden under reduced motion,
//       where the camera never moves by itself), and MapLibre's navigation
//       control (drag the compass to tilt and turn). A legend states the
//       colour ramp and its range. Kit.drawn() after deck's first render
//       (onAfterRender) and the map's first 'idle'. The PNG waits for the
//       map's next fresh frame (Kit.registerExport beforeExport). The kit's
//       table and CSV list the features (fields, longitude, latitude).
//       Actions (the page checks and applies them, with Undo): clicking a
//       column offers Select (its features, when ≤ 500 — the page's selection
//       cap — and all carry an id), Show in table (the same ids) and Zoom the
//       map here (fly to the features' bbox). The same menu opens from the
//       keyboard with the "Densest area: actions" button (the densest cell of
//       about one hexagon in the current view, by the current metric), and the
//       menu takes arrow keys, Home / End, Escape (focus returns to the button).
//       Labels read beyond the kit's: measure, count, none, act.select ({n}),
//       act.fly, act.table, and optional
//       density.hex, density.heat, density.orbit, density.low, density.high,
//       density.largest, density.top (English fallbacks).
//
// Deps: the frame globals TM, TM_INPUT and Kit (kit.js), maplibregl and deck
//       through Kit.libs; the payload shape is assets/templates/payload.ts.
//       Network: the libraries and the OpenFreeMap style, tiles, glyphs and
//       sprite (the frame's CSP).

(function () {
  'use strict';
  var STYLE = 'https://tiles.openfreemap.org/styles/positron';
  var BLANK = { version: 8, sources: {}, layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#f2f3f0' } }] };
  // Sequential ramp (light → dark), legible on the light basemap.
  var RAMP = ['#fff3b0', '#fed976', '#feb24c', '#fd8d3c', '#f03b20', '#bd0026', '#6b0021'];
  var MAX_SELECT = 500;     // the page's selection cap (MAX_SELECTION_IDS)
  var HEX_PX = 11;          // a hexagon's radius on screen, in pixels at the zoom it was sized for
  var M_PER_DEG = 111320;
  var CSS = [
    '.dn{position:absolute;inset:0;border:1px solid #d0d7de;border-radius:6px;overflow:hidden}',
    '.dn-ctl{position:absolute;z-index:3;top:8px;left:8px;display:flex;flex-wrap:wrap;gap:6px;max-width:calc(100% - 56px)}',
    '.dn-seg{display:inline-flex;border:1px solid #d0d7de;border-radius:6px;overflow:hidden;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.08)}',
    '.dn-seg button{font:inherit;font-size:12px;padding:4px 9px;border:0;background:#fff;color:#1f2328;cursor:pointer}',
    '.dn-seg button+button{border-inline-start:1px solid #d0d7de}',
    '.dn-seg button[aria-pressed="true"]{background:#1f2328;color:#fff}',
    '.dn-seg button:focus-visible{outline:2px solid #0969da;outline-offset:-2px}',
    '.dn-leg{position:absolute;z-index:3;left:8px;bottom:8px;min-width:150px;max-width:calc(100% - 16px);padding:6px 8px;background:rgba(255,255,255,.94);border:1px solid #d0d7de;border-radius:6px;font-size:11px}',
    '.dn-leg b{display:block;font-size:12px;margin-bottom:3px;font-weight:600}',
    '.dn-ramp{height:8px;border-radius:2px}',
    '.dn-ends{display:flex;justify-content:space-between;gap:8px;color:#57606a;font-variant-numeric:tabular-nums}',
    '.dn-tip{position:absolute;z-index:4;pointer-events:none;max-width:240px;padding:6px 8px;background:rgba(255,255,255,.96);border:1px solid #d0d7de;border-radius:6px;box-shadow:0 2px 8px rgba(0,0,0,.15);font-size:12px;line-height:1.35}',
    '.dn-tip b{font-variant-numeric:tabular-nums}',
    '.dn-tip .dn-big{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#57606a}',
    '@media (max-width:480px){.dn{position:relative;height:340px}.dn-seg button{padding:4px 7px}}',
  ].join('\n');

  var p = Kit.input();
  if (!p) return;
  // The table and CSV list the features (the rows hold only the totals): their fields, then the point.
  var ui = Kit.mount({ rows: (Array.isArray(p.features) ? p.features : []).flatMap(function (f) {
    var c = f && f.geometry && f.geometry.type === 'Point' ? f.geometry.coordinates : null;
    if (!c) return [];
    return [Object.assign({}, f.properties || {}, { longitude: c[0], latitude: c[1] })];
  }) });
  if (!ui) return;

  function L(key, fallback) { var v = p.labels[key]; return typeof v === 'string' && v ? v : fallback; }
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = String(text);
    return e;
  }
  function rgb(hex) { return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)]; }

  var measure = p.roles.measure.name;
  var unit = p.roles.measure.unit || '';
  var byField = p.roles.by[0] ? p.roles.by[0].field : null;
  var timeField = p.roles.time ? p.roles.time.field : null;

  // -- points ----------------------------------------------------------------------
  var DATA = [];
  var bounds = [Infinity, Infinity, -Infinity, -Infinity];
  var hasMeasure = false;
  (Array.isArray(p.features) ? p.features : []).forEach(function (f) {
    var g = f && f.geometry;
    if (!g || g.type !== 'Point') return;
    var c = g.coordinates;
    if (!isFinite(c[0]) || !isFinite(c[1]) || Math.abs(c[1]) > 85) return;
    var props = f.properties || {};
    var labelField = null;
    for (var k in props) {
      if (Object.prototype.hasOwnProperty.call(props, k) && k !== measure && k !== byField && k !== timeField) { labelField = k; break; }
    }
    var w = measure !== 'count' ? Number(props[measure]) : NaN;
    if (isFinite(w)) hasMeasure = true;
    DATA.push({ p: [c[0], c[1]], w: isFinite(w) && w > 0 ? w : 0, label: labelField ? props[labelField] : null,
      id: typeof f.id === 'string' || typeof f.id === 'number' ? f.id : null });
  });
  // The camera frames the 2.5th–97.5th percentile of each axis (plus 8 %), so a few far-off
  // points (Alaska, Hawaii, an island) do not shrink the bulk to a speck.
  if (DATA.length) {
    var xs = DATA.map(function (d) { return d.p[0]; }).sort(function (a, b) { return a - b; });
    var ys = DATA.map(function (d) { return d.p[1]; }).sort(function (a, b) { return a - b; });
    var q = function (a, f) { return a[Math.min(a.length - 1, Math.max(0, Math.round((a.length - 1) * f)))]; };
    var cut = DATA.length >= 200 ? 0.025 : 0;
    bounds = [q(xs, cut), q(ys, cut), q(xs, 1 - cut), q(ys, 1 - cut)];
    var padX = cut ? (bounds[2] - bounds[0]) * 0.08 : 0, padY = cut ? (bounds[3] - bounds[1]) * 0.08 : 0;
    bounds = [Math.max(-180, bounds[0] - padX), Math.max(-85, bounds[1] - padY), Math.min(180, bounds[2] + padX), Math.min(85, bounds[3] + padY)];
  }

  // -- view state ----------------------------------------------------------------------
  var S = { mode: 'hex', metric: hasMeasure ? 'sum' : 'count', orbit: false, radius: 20000, height: 200000, domain: null };
  function weight(d) { return S.metric === 'sum' ? d.w : 1; }
  function metricLabel() { return S.metric === 'sum' ? L('measure', measure) : L('count', 'Count'); }
  function metricText(v) { return S.metric === 'sum' ? Kit.fmt(v, unit) : Kit.fmt(v); }

  /** Count, sum and the largest feature of a picked hexagon. */
  function binStats(o) {
    var count = 0, sum = 0, big = null;
    if (o && o.pointIndices) {
      o.pointIndices.forEach(function (i) {
        var d = DATA[i];
        if (!d) return;
        count++; sum += d.w;
        if (!big || d.w > big.w) big = d;
      });
    } else if (o && o.points) {
      o.points.forEach(function (pt) {
        var d = pt && pt.source ? pt.source : pt;
        count++; sum += d.w || 0;
        if (!big || (d.w || 0) > big.w) big = d;
      });
    } else if (o) {
      count = typeof o.count === 'number' ? o.count : 0;
      sum = S.metric === 'sum' && typeof o.colorValue === 'number' ? o.colorValue : 0;
    }
    return { count: count, sum: sum, big: big };
  }
  /** The tooltip's lines for a hexagon: count, sum (when a measure), largest feature. */
  function tipLines(st) {
    var out = [[L('count', 'Count'), Kit.fmt(st.count)]];
    if (hasMeasure) out.push([L('measure', measure), Kit.fmt(st.sum, unit)]);
    if (st.big && st.big.label !== null && st.big.label !== undefined && st.big.label !== '' && (st.count > 1 || hasMeasure)) {
      out.push([L('density.largest', st.count > 1 ? 'Largest' : ''), String(st.big.label)]);
    }
    return out;
  }

  // -- layout ------------------------------------------------------------------------
  var style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);
  var box = ui.body.appendChild(el('div', 'dn'));
  var mapBox = box.appendChild(el('div'));
  mapBox.style.position = 'absolute';
  mapBox.style.inset = '0';
  var ctl = box.appendChild(el('div', 'dn-ctl'));
  var tip = box.appendChild(el('div', 'dn-tip'));
  tip.hidden = true;
  tip.setAttribute('role', 'status');
  var leg = box.appendChild(el('div', 'dn-leg'));
  box.addEventListener('mouseleave', function () { tip.hidden = true; });

  function segment(options, current, onPick) {
    var seg = ctl.appendChild(el('div', 'dn-seg'));
    seg.setAttribute('role', 'group');
    var buttons = options.map(function (o) {
      var b = seg.appendChild(el('button', null, o[1]));
      b.type = 'button';
      b.dataset.value = o[0];
      b.addEventListener('click', function () {
        buttons.forEach(function (x) { x.setAttribute('aria-pressed', x === b ? 'true' : 'false'); });
        onPick(o[0]);
      });
      b.setAttribute('aria-pressed', o[0] === current ? 'true' : 'false');
      return b;
    });
    return seg;
  }

  function legend() {
    while (leg.firstChild) leg.removeChild(leg.firstChild);
    leg.appendChild(el('b', null, metricLabel()));
    var ramp = leg.appendChild(el('div', 'dn-ramp'));
    ramp.style.background = 'linear-gradient(to right,' + RAMP.join(',') + ')';
    var ends = leg.appendChild(el('div', 'dn-ends'));
    if (S.mode === 'hex' && S.domain) {
      ends.appendChild(el('span', null, metricText(S.domain[0])));
      ends.appendChild(el('span', null, metricText(S.domain[1])));
    } else {
      ends.appendChild(el('span', null, L('density.low', 'Low')));
      ends.appendChild(el('span', null, L('density.high', 'High')));
    }
  }

  // -- deck layers ---------------------------------------------------------------------
  var overlay = null, map = null;
  function layers() {
    var colorRange = RAMP.map(rgb);
    if (S.mode === 'heat') {
      return [new deck.HeatmapLayer({
        id: 'heat', data: DATA, getPosition: function (d) { return d.p; }, getWeight: weight,
        radiusPixels: 26, intensity: 1, threshold: 0.04, colorRange: colorRange, aggregation: 'SUM',
        updateTriggers: { getWeight: S.metric },
      })];
    }
    return [new deck.HexagonLayer({
      id: 'hex', data: DATA, getPosition: function (d) { return d.p; },
      radius: S.radius, coverage: 0.86, extruded: true, elevationRange: [0, S.height], elevationScale: 1,
      colorRange: colorRange, getColorWeight: weight, colorAggregation: 'SUM',
      getElevationWeight: weight, elevationAggregation: 'SUM', gpuAggregation: false,
      pickable: true, autoHighlight: true, highlightColor: [31, 35, 40, 90],
      material: { ambient: 0.62, diffuse: 0.6, shininess: 28, specularColor: [60, 64, 70] },
      onSetColorDomain: function (d) {
        if (!d || (S.domain && S.domain[0] === d[0] && S.domain[1] === d[1])) return;
        S.domain = [d[0], d[1]];
        legend();
      },
      onHover: onHover,
      onClick: onClick,
      updateTriggers: { getColorWeight: S.metric, getElevationWeight: S.metric },
    })];
  }
  function redraw() { if (overlay) overlay.setProps({ layers: layers() }); legend(); }

  function onHover(info) {
    if (!info || !info.object) { tip.hidden = true; return; }
    var lines = tipLines(binStats(info.object));
    while (tip.firstChild) tip.removeChild(tip.firstChild);
    lines.forEach(function (l, i) {
      if (i === 2) { tip.appendChild(el('span', 'dn-big', (l[0] ? l[0] + ': ' : '') + l[1])); return; }
      var row = tip.appendChild(el('div'));
      row.appendChild(document.createTextNode(l[0] + ': '));
      row.appendChild(el('b', null, l[1]));
    });
    tip.hidden = false;
    var bw = box.clientWidth, tw = tip.offsetWidth || 160;
    tip.style.left = Math.max(4, Math.min(info.x + 12, bw - tw - 4)) + 'px';
    tip.style.top = Math.max(40, info.y + 12) + 'px';
  }

  /** The points of a picked hexagon. */
  function binPoints(o) {
    if (o && o.pointIndices) return o.pointIndices.map(function (i) { return DATA[i]; }).filter(Boolean);
    if (o && o.points) return o.points.map(function (pt) { return pt && pt.source ? pt.source : pt; }).filter(function (d) { return d && d.p; });
    return [];
  }
  function onClick(info) {
    var pts = info && info.object ? binPoints(info.object) : [];
    if (!pts.length) return;
    var r = mapBox.getBoundingClientRect();
    tip.hidden = true;
    actionsMenu(pts, r.left + info.x, r.top + info.y);
  }
  /** The actions for the points of one hexagon (or one keyboard-picked area), as a menu at a client point. */
  function actionsMenu(pts, x, y) {
    var ids = pts.map(function (d) { return d.id; }).filter(function (id) { return id !== null && id !== undefined; });
    var b = pts.reduce(function (a, d) { return [Math.min(a[0], d.p[0]), Math.min(a[1], d.p[1]), Math.max(a[2], d.p[0]), Math.max(a[3], d.p[1])]; }, [Infinity, Infinity, -Infinity, -Infinity]);
    var items = [];
    if (ids.length === pts.length && ids.length <= MAX_SELECT) {
      items.push({ label: L('act.select', 'Select on the map ({n})').replace('{n}', Kit.fmt(ids.length)), run: function () { Kit.action('select', { ids: ids }); } });
      items.push({ label: L('act.table', 'Show in table'), run: function () { Kit.action('table', { ids: ids }); } });
    }
    items.push({ label: L('act.fly', 'Zoom the map here'), run: function () { Kit.action('fly', { bbox: b }); } });
    Kit.menu(x, y, items);
  }
  /** Keyboard route to the same menu: the densest area of the view (cells of about one hexagon, by the current metric). */
  function densestMenu() {
    if (!map || !DATA.length) return;
    var cell = HEX_PX * 2, cells = {}, best = null;
    DATA.forEach(function (d) {
      var q = map.project(d.p);
      if (!q || !isFinite(q.x) || !isFinite(q.y)) return;
      var k = Math.floor(q.x / cell) + ':' + Math.floor(q.y / cell);
      var c = cells[k] || (cells[k] = { pts: [], w: 0 });
      c.pts.push(d);
      c.w += weight(d);
      if (!best || c.w > best.w) best = c;
    });
    if (!best) return;
    var r = mapBox.getBoundingClientRect();
    tip.hidden = true;
    actionsMenu(best.pts, r.left + 16, r.top + 48);
  }

  /** Hexagon radius and column height from the current view: ~HEX_PX on screen, the tallest ≈ 9 % of the view's width. */
  function sizeFor() {
    var b = map.getBounds(), lat = map.getCenter().lat;
    var widthM = Math.max(1, (b.getEast() - b.getWest()) * M_PER_DEG * Math.cos(lat * Math.PI / 180));
    var px = Math.max(1, mapBox.clientWidth || 600);
    return { radius: Math.min(250000, Math.max(150, widthM / px * HEX_PX)), height: widthM * 0.09 };
  }
  function resize(force) {
    var s = sizeFor();
    if (S.mode !== 'hex' || (!force && Math.abs(Math.log(s.radius / S.radius)) < 0.35)) return;
    S.radius = s.radius; S.height = s.height; S.domain = null;
    redraw();
  }

  // -- camera --------------------------------------------------------------------------
  var orbitBtn = null;
  function setOrbit(on) {
    S.orbit = on && !Kit.reducedMotion;
    if (orbitBtn) orbitBtn.setAttribute('aria-pressed', S.orbit ? 'true' : 'false');
    if (S.orbit) spin();
  }
  function spin() {
    if (!S.orbit || !map) return;
    var m = map;
    m.easeTo({ bearing: m.getBearing() + 30, duration: 4000, easing: function (t) { return t; } });
    m.once('moveend', function () { if (S.orbit && m === map) spin(); });
  }
  function camera() {
    var to = S.mode === 'hex' ? { pitch: 50, bearing: -18 } : { pitch: 0, bearing: 0 };
    if (Kit.reducedMotion) map.jumpTo(to); else map.easeTo(Object.assign({ duration: 700 }, to));
  }

  // -- start ---------------------------------------------------------------------------
  var userMoved = false, styleSpec = BLANK, sentDrawn = false;
  function fit() {
    if (!(bounds[0] <= bounds[2])) return;
    map.fitBounds([[bounds[0], bounds[1]], [bounds[2], bounds[3]]], { padding: 30, maxZoom: 10, animate: false, pitch: map.getPitch(), bearing: map.getBearing() });
  }
  /** The map and its interleaved deck at `cam` (a camera to keep; pitch and bearing alone: fitted to the points), or fitted and then tilted. */
  function start(cam) {
    var built = mapBox.clientWidth + 'x' + mapBox.clientHeight;
    map = new maplibregl.Map({
      container: mapBox,
      style: styleSpec,
      center: cam && cam.center ? cam.center : [-98, 39],
      zoom: cam && cam.center ? cam.zoom : 3,
      pitch: cam ? cam.pitch : 0,
      bearing: cam ? cam.bearing : 0,
      maxPitch: 70,
      attributionControl: { compact: true },
      cooperativeGestures: true,
      preserveDrawingBuffer: true,
      canvasContextAttributes: { preserveDrawingBuffer: true, antialias: true },
      fadeDuration: 0,
    });
    map.on('error', function () { /* a tile or glyph that did not load: the density still draws */ });
    map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');
    if (!cam || !cam.center) fit();
    map.on('movestart', function (e) { if (e && e.originalEvent) userMoved = true; });
    var s = sizeFor();
    S.radius = s.radius; S.height = s.height; S.domain = null;
    var rendered = false, idle = false;
    function ready() { if (rendered && idle && !sentDrawn) { sentDrawn = true; Kit.drawn(); } }
    overlay = new deck.MapboxOverlay({
      interleaved: true,
      layers: [],
      onAfterRender: function () { if (!rendered) { rendered = true; ready(); } },
    });
    map.on('load', function () {
      map.addControl(overlay);
      redraw();
      map.once('idle', function () {
        idle = true;
        // deck draws inside the map's frame; one idle after the layers are in means they were drawn.
        setTimeout(function () { rendered = true; ready(); }, 1500);
        ready();
        if (S.mode === 'hex' && !cam) camera();
      });
    });
    map.on('moveend', function () { if (!S.orbit) resize(); });
    map.on('dragstart', function () { if (S.orbit) setOrbit(false); });
    map.on('mouseout', function () { tip.hidden = true; });
    Kit.registerExport(map.getCanvas(), { beforeExport: freshFrame });
    // An interleaved deck keeps drawing at the size the GL context was made
    // at, so a frame that changes size (Expand / Collapse, a rotated phone)
    // gets a new map and deck, on the same camera unless it was never moved.
    if (typeof ResizeObserver === 'function') {
      var again;
      var ro = new ResizeObserver(function () {
        clearTimeout(again);
        again = setTimeout(function () {
          if (built === mapBox.clientWidth + 'x' + mapBox.clientHeight) return;
          ro.disconnect();
          var keep = { center: map.getCenter(), zoom: map.getZoom(), pitch: map.getPitch(), bearing: map.getBearing() };
          setOrbit(false);
          map.remove();
          start(userMoved ? keep : { pitch: keep.pitch, bearing: keep.bearing });
        }, 200);
      });
      ro.observe(box);
    }
  }

  /** The PNG waits for a pending rebuild (the resize debounce) and the map's next fresh frame:
   *  a canvas that just changed size (the Table toggle) holds nothing until it is drawn again. */
  function freshFrame() {
    return new Promise(function (resolve) {
      setTimeout(function () {
        if (!map) { resolve(); return; }
        map.once('idle', function () { resolve(); });
        map.triggerRepaint();
      }, 260);
    });
  }

  segment([['hex', L('density.hex', '3D hex')], ['heat', L('density.heat', '2D heat')]], S.mode, function (v) {
    S.mode = v;
    tip.hidden = true;
    if (map) { if (v === 'heat') setOrbit(false); camera(); if (v === 'hex') resize(true); }
    redraw();
  });
  if (hasMeasure) {
    segment([['sum', L('measure', measure)], ['count', L('count', 'Count')]], S.metric, function (v) {
      S.metric = v; S.domain = null; tip.hidden = true; redraw();
    });
  }
  if (!Kit.reducedMotion) {
    orbitBtn = segment([['orbit', L('density.orbit', 'Orbit')]], '', function () { setOrbit(!S.orbit); }).firstChild;
  }
  var topBtn = segment([['top', L('density.top', 'Densest area: actions')]], '', function () { topBtn.removeAttribute('aria-pressed'); densestMenu(); }).firstChild;
  topBtn.removeAttribute('aria-pressed');
  legend();

  Kit.libs('maplibre-gl', 'maplibre-gl.css', 'deck.gl').then(function () {
    var timer;
    return new Promise(function (resolve) {
      timer = setTimeout(function () { resolve(BLANK); }, 8000);
      fetch(STYLE).then(function (r) { return r.ok ? r.json() : BLANK; }).then(resolve, function () { resolve(BLANK); });
    }).then(function (s) {
      clearTimeout(timer);
      styleSpec = s && typeof s === 'object' && s.version === 8 ? s : BLANK;
      start(null);
    });
  }).catch(function (e) {
    TM.fail('runtime', e && e.message ? e.message : 'density failed');
    ui.showTable(true);
  });
})();
