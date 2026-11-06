// --- pies-per-region (html template): one pie per region on a map ---------------
// Role: the catalogue's `pies-per-region` template, run in the canvas frame after
//       kit.js. The rows are one per (`by` group, region): `by` is the category
//       whose groups are the slices, `split` (roles.by[1]) the region field —
//       states, countries or admin1 — and each row carries a count or the
//       measure's sum. payload.features holds the regions' simplified outlines
//       (id = the region code) and payload.centres each region's pie centre
//       [lon, lat] (per-region.ts regionCentre); a region with no outline or
//       centre gets no pie.
//       Slices: the groups are summed over all regions and ranked by |value|; the
//       first params.top are kept, the rest become one "Other" slice (the same
//       cut topGroups makes); a slice's colour is payload.colours[by][key], else
//       the kit's palette, grey for Other and none. A slice's size is its share
//       of the region's total, clockwise from 12 o'clock, largest group first.
//       Pie size: area-proportional, radius = RMAX * sqrt(total / largest total)
//       (at least RMIN px), and the side panel's size legend draws three circles
//       on the same scale (the largest total, a quarter, a sixteenth).
//       Layout: a MapLibre mini-map (OpenFreeMap Positron; a plain background if
//       the style does not load) with the outlines in light grey, the pies in an
//       SVG layer above it (repositioned with map.project on every move; pointer
//       events go to the map), beside a panel with the total, the size legend and
//       the group legend. Hover a pie: its region, total and largest slices.
//       Click a pie: "Show only this on the map" (where: {field: region, bin:
//       code}) and "Zoom the map here" (fly: {id: code}). Click a legend row:
//       "Show only “{name}” on the map" (where on `by`; never Other or none).
//       Without outlines (pie.noMap) the panel alone is shown.
//       The PNG download draws the map canvas and the pies onto one canvas.
//       Kit.drawn() after the map's first 'idle' (or at once without a map).
//       Labels read beyond the kit's: other, none, value.<field>.<key> (group and
//       region names), pie.size, pie.only, pie.more, pie.noMap, pie.overlap,
//       act.where, act.fly. The header total and the shares are of
//       payload.totalOnce (each feature once) when given.
//
// Deps: the frame globals TM, TM_INPUT and Kit (kit.js), maplibregl through
//       Kit.libs; the payload shape is assets/templates/payload.ts. Network: the
//       library and the OpenFreeMap style, tiles, glyphs and sprite (the frame's CSP).

(function () {
  'use strict';
  var STYLE = 'https://tiles.openfreemap.org/styles/positron';
  var BLANK = { version: 8, sources: {}, layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#f2f3f0' } }] };
  var GREY = '#9ca3af';
  var OTHER = '\u0000other';
  var NONE = '\u0000none';
  var RMAX = 34, RMIN = 4;
  var SVGNS = 'http://www.w3.org/2000/svg';
  var CSS = [
    '.pr{display:grid;grid-template-columns:minmax(0,1.6fr) minmax(200px,1fr);gap:10px;position:absolute;inset:0}',
    '.pr-solo{grid-template-columns:minmax(0,1fr)}',
    '.pr-map{position:relative;min-height:200px;border:1px solid #d0d7de;border-radius:6px;overflow:hidden}',
    '.pr-pies{position:absolute;left:0;top:0;width:100%;height:100%;z-index:1;pointer-events:none;overflow:hidden}',
    '.pr-pie.on circle,.pr-pie.on path{stroke:#1f2328;stroke-width:1.6}',
    '.pr-side{display:flex;flex-direction:column;gap:8px;min-height:0;overflow:auto}',
    '.pr-total{font-size:12px;color:#57606a;display:flex;justify-content:space-between;gap:8px}',
    '.pr-total b{color:#1f2328;font-variant-numeric:tabular-nums}',
    '.pr-note{margin:0;font-size:12px;color:#57606a}',
    '.pr-size{font-size:11px;color:#57606a}',
    '.pr-size svg{display:block;margin-top:4px}',
    '.pr-rows{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:3px;font-size:12px}',
    '.pr-row{display:flex;align-items:center;gap:6px;padding:2px 4px;border-radius:4px;cursor:pointer;outline:none}',
    '.pr-row.off{cursor:default}',
    '.pr-row:focus-visible,.pr-row:hover{background:#eaeef2}',
    '.pr-sw{flex:none;width:12px;height:12px;border-radius:2px;border:1px solid rgba(0,0,0,.15)}',
    '.pr-name{flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.pr-val{color:#57606a;font-variant-numeric:tabular-nums;white-space:nowrap}',
    '.pr-tip{position:absolute;z-index:5;pointer-events:none;max-width:240px;padding:6px 8px;background:rgba(255,255,255,.96);border:1px solid #d0d7de;border-radius:6px;box-shadow:0 2px 8px rgba(0,0,0,.15);font-size:12px}',
    '.pr-tip b{display:block;font-weight:600}',
    '@media (max-width:520px){.pr{position:static;display:flex;flex-direction:column}.pr-map{height:260px;flex:none}.pr-side{overflow:visible}}',
  ].join('\n');

  var p = Kit.input();
  if (!p) return;
  var by = p.roles.by[0] ? p.roles.by[0].field : null;
  var region = p.roles.by[1] ? p.roles.by[1].field : null;
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
  function svg(tag, attrs) {
    var e = document.createElementNS(SVGNS, tag);
    for (var k in attrs) if (Object.prototype.hasOwnProperty.call(attrs, k)) e.setAttribute(k, attrs[k]);
    return e;
  }
  function valueText(v) { return Kit.fmt(v, unit); }
  function groupName(k) { return k === OTHER ? L('other', 'Other') : k === NONE ? L('none', '—') : L('value.' + by + '.' + k, k); }
  function regionName(k) { return L('value.' + region + '.' + k, k); }
  function groupColour(k) { return k === OTHER || k === NONE ? GREY : Kit.colour(by, k); }
  function amount(r) { return Math.abs(typeof r.sum === 'number' ? r.sum : r.count); }
  function rawKey(v) { return v === null || v === undefined || v === '' ? NONE : String(v); }

  // -- groups: the slices, top + Other ------------------------------------------------------
  var gsum = {}, gkeys = [];
  p.rows.forEach(function (r) {
    var k = rawKey(by ? r[by] : null);
    if (!(k in gsum)) { gsum[k] = 0; gkeys.push(k); }
    gsum[k] += amount(r);
  });
  var granked = gkeys.slice().sort(function (a, b) { return gsum[b] - gsum[a]; });
  var kept = granked.slice(0, top);
  var slot = {}; // group key -> its slice key (itself, or OTHER)
  granked.forEach(function (k) { slot[k] = kept.indexOf(k) >= 0 ? k : OTHER; });
  var order = kept.slice();
  if (granked.length > kept.length) order.push(OTHER);
  var legendSum = {};
  granked.forEach(function (k) { legendSum[slot[k]] = (legendSum[slot[k]] || 0) + gsum[k]; });

  // -- regions: one pie each --------------------------------------------------------------------
  var reg = {}, rkeys = [];
  p.rows.forEach(function (r) {
    var raw = region ? r[region] : null;
    if (raw === null || raw === undefined || raw === '' || raw === 'none') return;
    var k = String(raw);
    if (!reg[k]) { reg[k] = { total: 0, by: {} }; rkeys.push(k); }
    var s = slot[rawKey(by ? r[by] : null)];
    var v = amount(r);
    reg[k].total += v;
    reg[k].by[s] = (reg[k].by[s] || 0) + v;
  });
  var once = p.totalOnce ? (measure === 'count' ? p.totalOnce.count : p.totalOnce.sum) : undefined;
  var grand = rkeys.reduce(function (s, k) { return s + reg[k].total; }, 0);
  var total = typeof once === 'number' ? once : grand;
  var tableRows = p.rows.map(function (r) {
    var row = {};
    row[region] = region && r[region] !== null && r[region] !== undefined && r[region] !== 'none' ? regionName(String(r[region])) : L('none', '—');
    row[by] = groupName(rawKey(by ? r[by] : null));
    row.count = r.count;
    if (measure !== 'count') row.sum = r.sum;
    return row;
  });

  var ui = Kit.mount({ rows: tableRows });
  if (!ui) return;

  // -- outlines and centres ---------------------------------------------------------------------
  var fc = { type: 'FeatureCollection', features: [] };
  var boxes = {}, centres = [];
  var bounds = [Infinity, Infinity, -Infinity, -Infinity];
  function grow(c, b) {
    if (Array.isArray(c[0])) { c.forEach(function (x) { grow(x, b); }); return; }
    if (!isFinite(c[0]) || !isFinite(c[1])) return;
    b[0] = Math.min(b[0], c[0]); b[1] = Math.min(b[1], c[1]); b[2] = Math.max(b[2], c[0]); b[3] = Math.max(b[3], c[1]);
  }
  (Array.isArray(p.features) ? p.features : []).forEach(function (f) {
    var g = f && f.geometry;
    if (!g || (g.type !== 'Polygon' && g.type !== 'MultiPolygon') || typeof f.id !== 'string' || !reg[f.id]) return;
    var b = [Infinity, Infinity, -Infinity, -Infinity];
    grow(g.coordinates, b);
    boxes[f.id] = b;
    if (b[2] - b[0] <= 180) centres.push({ x: (b[0] + b[2]) / 2, y: (b[1] + b[3]) / 2, b: b });
    fc.features.push({ type: 'Feature', geometry: g, properties: { k: f.id } });
  });
  var pies = [];
  var maxTotal = 0;
  rkeys.forEach(function (k) {
    var c = p.centres && p.centres[k];
    if (!boxes[k] || !Array.isArray(c) || !isFinite(c[0]) || !isFinite(c[1]) || reg[k].total <= 0) return;
    maxTotal = Math.max(maxTotal, reg[k].total);
    pies.push({ k: k, ll: [c[0], c[1]], total: reg[k].total, r: 0 });
  });
  // Area-proportional: radius grows with the square root of the total.
  function radius(v) { return maxTotal > 0 ? Math.max(RMIN, RMAX * Math.sqrt(v / maxTotal)) : RMIN; }
  pies.forEach(function (x) { x.r = radius(x.total); });
  pies.sort(function (a, b) { return b.total - a.total; }); // large first: small pies stay on top
  var withMap = pies.length > 0;

  // The first view: the regions whose centres sit in the bulk of them, so a far territory does not zoom out to the world.
  function pct(xs, q) { var s = xs.slice().sort(function (a, b) { return a - b; }); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; }
  if (centres.length) {
    var xs = centres.map(function (c) { return c.x; }), ys = centres.map(function (c) { return c.y; });
    var x0 = pct(xs, 0.1), x1 = pct(xs, 0.9), y0 = pct(ys, 0.1), y1 = pct(ys, 0.9);
    var px = (x1 - x0) * 0.5 + 5, py = (y1 - y0) * 0.5 + 5;
    centres.forEach(function (c) {
      if (c.x >= x0 - px && c.x <= x1 + px && c.y >= y0 - py && c.y <= y1 + py) grow([[c.b[0], c.b[1]], [c.b[2], c.b[3]]], bounds);
    });
  }

  // -- layout -------------------------------------------------------------------------------------
  var style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);
  var grid = ui.body.appendChild(el('div', withMap ? 'pr' : 'pr pr-solo'));
  var mapBox = withMap ? grid.appendChild(el('div', 'pr-map')) : null;
  var side = grid.appendChild(el('div', 'pr-side'));
  var head = side.appendChild(el('div', 'pr-total'));
  head.appendChild(el('span', null, L('measure', measure)));
  head.appendChild(el('b', null, valueText(total)));
  ['pie.noMap', 'pie.more', 'pie.overlap'].forEach(function (key) { if (L(key, '')) side.appendChild(el('p', 'pr-note', L(key, ''))); });
  if (!order.length) side.appendChild(el('p', 'pr-note', L('noData', '')));

  // The size legend: three circles on the pies' own scale, bottoms aligned.
  if (withMap) {
    var box = side.appendChild(el('div', 'pr-size'));
    box.appendChild(document.createTextNode(L('pie.size', 'Pie area shows the total')));
    var W = RMAX * 2 + 90, H = RMAX * 2 + 12;
    var sz = box.appendChild(svg('svg', { width: W, height: H, viewBox: '0 0 ' + W + ' ' + H, 'aria-hidden': 'true' }));
    [1, 0.25, 0.0625].forEach(function (f) {
      var rr = radius(maxTotal * f);
      sz.appendChild(svg('circle', { cx: RMAX + 1, cy: H - 2 - rr, r: rr, fill: 'none', stroke: '#6b7280', 'stroke-width': 1 }));
      sz.appendChild(svg('line', { x1: RMAX + 1, y1: H - 2 - 2 * rr, x2: RMAX * 2 + 8, y2: H - 2 - 2 * rr, stroke: '#9ca3af', 'stroke-width': 0.8 }));
      var tx = svg('text', { x: RMAX * 2 + 11, y: H - 2 - 2 * rr + 4, 'font-size': 11, fill: '#57606a' });
      tx.textContent = valueText(maxTotal * f);
      sz.appendChild(tx);
    });
  }

  // The group legend: each slice's colour, name, value and share; a row offers "show only this".
  var list = side.appendChild(el('ul', 'pr-rows'));
  list.setAttribute('aria-label', L('field.' + by, by || ''));
  order.forEach(function (k) {
    var v = legendSum[k] || 0;
    var share = grand > 0 ? ' · ' + Kit.fmt(Math.round((v / grand) * 1000) / 10) + '%' : '';
    var off = k === OTHER || k === NONE;
    var li = list.appendChild(el('li', off ? 'pr-row off' : 'pr-row'));
    li.setAttribute('aria-label', groupName(k) + ': ' + valueText(v) + share);
    li.appendChild(el('span', 'pr-sw')).style.background = groupColour(k);
    li.appendChild(el('span', 'pr-name', groupName(k))).title = groupName(k);
    li.appendChild(el('span', 'pr-val', valueText(v) + share));
    if (off) return;
    li.tabIndex = 0;
    li.setAttribute('role', 'button');
    var menu = function (x, y) {
      Kit.menu(x, y, [{ label: L('pie.only', 'Show only “{name}” on the map').replace('{name}', groupName(k)), run: function () { Kit.action('where', { field: by, bin: k }); } }]);
    };
    li.addEventListener('click', function (e) { menu(e.clientX, e.clientY); });
    li.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      var r = li.getBoundingClientRect();
      menu(r.left + 24, r.bottom);
    });
  });

  if (!withMap) { Kit.drawn(); return; }

  // -- pies ----------------------------------------------------------------------------------------
  var layer = mapBox.appendChild(svg('svg', { class: 'pr-pies', 'aria-hidden': 'true' }));
  function slicePath(r, a0, a1) {
    var x0 = r * Math.sin(a0), y0 = -r * Math.cos(a0), x1 = r * Math.sin(a1), y1 = -r * Math.cos(a1);
    return 'M0,0L' + x0.toFixed(2) + ',' + y0.toFixed(2) + 'A' + r.toFixed(2) + ',' + r.toFixed(2) + ' 0 ' + (a1 - a0 > Math.PI ? 1 : 0) + ' 1 ' + x1.toFixed(2) + ',' + y1.toFixed(2) + 'Z';
  }
  pies.forEach(function (x) {
    var slices = order.filter(function (k) { return reg[x.k].by[k] > 0; }).map(function (k) { return { k: k, v: reg[x.k].by[k] }; });
    x.slices = slices;
    var g = layer.appendChild(svg('g', { class: 'pr-pie', 'data-k': x.k, 'data-r': x.r.toFixed(2) }));
    var a = 0;
    slices.forEach(function (s) {
      var a1 = a + (s.v / x.total) * Math.PI * 2;
      var attrs = { fill: groupColour(s.k), stroke: '#fff', 'stroke-width': 0.8, 'fill-opacity': 0.92 };
      g.appendChild(slices.length === 1 ? svg('circle', Object.assign({ r: x.r }, attrs)) : svg('path', Object.assign({ d: slicePath(x.r, a, a1) }, attrs)));
      a = a1;
    });
    x.node = g;
  });
  var map = null, hovered = null;
  function place() {
    pies.forEach(function (x) {
      var pt = map.project(x.ll);
      x.px = pt.x; x.py = pt.y;
      x.node.setAttribute('transform', 'translate(' + pt.x.toFixed(1) + ',' + pt.y.toFixed(1) + ')');
    });
  }

  // -- tooltip, hover and actions ------------------------------------------------------------------
  var tip = el('div', 'pr-tip');
  tip.hidden = true;
  function pick(pt) {
    var best = null;
    pies.forEach(function (x) {
      var dx = pt.x - x.px, dy = pt.y - x.py;
      if (dx * dx + dy * dy <= x.r * x.r && (!best || x.r < best.r)) best = x;
    });
    return best;
  }
  function setHover(x) {
    if (hovered === x) return;
    if (hovered) hovered.node.classList.remove('on');
    hovered = x;
    if (x) x.node.classList.add('on');
  }
  function showTip(x, mx, my) {
    while (tip.firstChild) tip.removeChild(tip.firstChild);
    tip.appendChild(el('b', null, regionName(x.k)));
    tip.appendChild(el('div', null, valueText(x.total)));
    x.slices.slice(0, 5).forEach(function (s) {
      tip.appendChild(el('div', null, groupName(s.k) + ': ' + valueText(s.v) + ' · ' + Kit.fmt(Math.round((s.v / x.total) * 1000) / 10) + '%'));
    });
    tip.hidden = false;
    var w = tip.offsetWidth || 180;
    tip.style.left = Math.max(4, Math.min(mx + 12, mapBox.clientWidth - w - 4)) + 'px';
    tip.style.top = Math.max(4, my + 12) + 'px';
  }
  function pieMenu(x, cx, cy) {
    Kit.menu(cx, cy, [
      { label: L('act.where', 'Show only this on the map'), run: function () { Kit.action('where', { field: region, bin: x.k }); } },
      { label: L('act.fly', 'Zoom the map here'), run: function () { Kit.action('fly', { id: x.k }); } },
    ]);
  }

  // -- map -------------------------------------------------------------------------------------------
  var userMoved = false;
  function fit() { if (bounds[0] > bounds[2]) return; map.fitBounds([[bounds[0], bounds[1]], [bounds[2], bounds[3]]], { padding: 40, maxZoom: 8, animate: false }); }

  // The PNG: the map's canvas with the pies drawn over it.
  var exp = document.createElement('canvas');
  function compose() {
    var src = map.getCanvas();
    exp.width = src.width; exp.height = src.height;
    var ctx = exp.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(src, 0, 0);
    var k = src.width / (mapBox.clientWidth || src.width);
    pies.forEach(function (x) {
      var pt = map.project(x.ll), r = x.r * k, a = -Math.PI / 2;
      x.slices.forEach(function (s) {
        var a1 = a + (s.v / x.total) * Math.PI * 2;
        ctx.beginPath();
        ctx.moveTo(pt.x * k, pt.y * k);
        ctx.arc(pt.x * k, pt.y * k, r, a, a1);
        ctx.closePath();
        ctx.fillStyle = groupColour(s.k);
        ctx.fill();
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 0.8 * k;
        ctx.stroke();
        a = a1;
      });
    });
  }

  function start(styleSpec) {
    map = new maplibregl.Map({
      container: mapBox, style: styleSpec, center: [-98, 39], zoom: 2,
      attributionControl: { compact: true }, cooperativeGestures: true, fadeDuration: 0,
      preserveDrawingBuffer: true, canvasContextAttributes: { preserveDrawingBuffer: true, antialias: true },
    });
    map.on('error', function () { /* a tile or glyph that did not load: the pies still draw */ });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    mapBox.appendChild(tip);
    fit();
    place();
    map.on('move', place);
    map.on('resize', place);
    map.on('movestart', function (e) { if (e && e.originalEvent) userMoved = true; });
    map.on('load', function () {
      var firstSymbol = (map.getStyle().layers || []).filter(function (l) { return l.type === 'symbol'; })[0];
      var before = firstSymbol ? firstSymbol.id : undefined;
      map.addSource('regions', { type: 'geojson', data: fc });
      map.addLayer({ id: 'regions', type: 'fill', source: 'regions', paint: { 'fill-color': '#cbd5e1', 'fill-opacity': 0.45 } }, before);
      map.addLayer({ id: 'edges', type: 'line', source: 'regions', paint: { 'line-color': '#64748b', 'line-width': 0.6, 'line-opacity': 0.7 } }, before);
      place();
      map.on('mousemove', function (e) {
        var x = pick(e.point);
        setHover(x);
        map.getCanvas().style.cursor = x ? 'pointer' : '';
        if (x) showTip(x, e.point.x, e.point.y); else tip.hidden = true;
      });
      map.on('mouseout', function () { setHover(null); tip.hidden = true; });
      map.on('click', function (e) {
        var x = pick(e.point), oe = e.originalEvent;
        if (x) pieMenu(x, oe ? oe.clientX : e.point.x, oe ? oe.clientY : e.point.y);
      });
      map.once('idle', function () { Kit.drawn(); });
    });
    Kit.registerExport(exp, { beforeExport: function () {
      return new Promise(function (resolve) {
        var t = setTimeout(resolve, 3000);
        map.once('idle', function () { clearTimeout(t); resolve(); });
        map.triggerRepaint();
      }).then(compose);
    } });
    if (typeof ResizeObserver === 'function') {
      new ResizeObserver(function () { map.resize(); if (!userMoved) fit(); place(); }).observe(grid);
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
    TM.fail('runtime', e && e.message ? e.message : 'pies-per-region failed');
    ui.showTable(true);
  });
})();
