// --- flow (html template): how one grouping splits across another -----------
// Role: the catalogue's `flow` template, run in the canvas frame after kit.js.
//       A sankey (d3 + d3-sankey, loaded in that order) from the payload rows,
//       one per pair of the `by` group (sources, left) and the `split` group
//       (targets, right), each link the count or the measure's sum. Each side
//       keeps its params.top largest groups (at most MAX_SIDE - 1) and sums
//       the rest into "Other", so ≤ 2 × MAX_SIDE = 40 nodes; a feature with no
//       value is its own "(none)" group. Colours: the legend's (payload.colours,
//       else the kit palette); a link takes its source's colour.
//       Hover or focus a node: its links lit, the rest dimmed, a text-only
//       tooltip with its value and share; hover a link: "A → B" with its value.
//       Click a node (or Enter / Space on it): "Show only this on the map"
//       (where: {field, bin: its key}); click a link: one such item per end.
//       "Other" ("Smaller groups" when a group of that side is already
//       called Other) and "(none)" offer nothing; a label that would overlap
//       its side's previous one is left out (the node keeps its name in its
//       aria-label and tooltip). Frames ≤ 480 px wide draw the
//       sankey top to bottom (x and y swapped), labels turned upright and
//       truncated with the full name in a <title>; Expand gives the full width.
//       Every SVG style is an attribute (the PNG draws the SVG on its own).
//       The table and CSV list every pair by name (count, sum). Kit.drawn()
//       once the sankey is in the page. A region list counts a feature in
//       each of its regions: the page sends flow.overlap, shown as a note.
//       Labels read beyond the kit's: other, none, value.<field>.<key>,
//       field.<field>, measure, count, smaller, act.where, flow.only ({name}),
//       flow.hint, flow.overlap, noData.
//
// Deps: the frame globals TM, TM_INPUT and Kit (kit.js), d3 and d3-sankey
//       through Kit.libs; the payload shape is assets/templates/payload.ts.

(function () {
  'use strict';
  var MAX_SIDE = 20;                 // nodes per side, "Other" included
  var NS = 'http://www.w3.org/2000/svg';
  var GREY = '#9ca3af', INK = '#1f2328', MUTED = '#57606a', FONT = 'system-ui,-apple-system,"Segoe UI",Roboto,sans-serif';
  var OTHER = '\u0000other', NONE = '\u0000none';
  var CSS = [
    '.fl{position:relative;display:flex;flex-direction:column;gap:6px}',
    '.fl-note{margin:0;font-size:12px;color:#57606a}',
    '.fl svg{display:block;max-width:100%;overflow:visible}',
    '.fl-node{cursor:pointer;outline:none}',
    '.fl-node:focus-visible rect{stroke:#0969da;stroke-width:2px}',
    '.fl-link{cursor:pointer}',
    '.fl-tip{position:absolute;z-index:5;pointer-events:none;max-width:260px;padding:6px 8px;background:rgba(255,255,255,.96);border:1px solid #d0d7de;border-radius:6px;box-shadow:0 2px 8px rgba(0,0,0,.15);font-size:12px;line-height:1.35}',
    '.fl-tip b{display:block;font-weight:600}',
  ].join('\n');

  var p = Kit.input();
  if (!p) return;
  var src = p.roles.by[0] ? p.roles.by[0].field : null;
  var dst = p.roles.by[1] ? p.roles.by[1].field : null;
  var measure = p.roles.measure.name;
  var unit = measure === 'count' ? '' : (p.roles.measure.unit || '');
  var top = typeof p.params.top === 'number' && p.params.top >= 1 ? Math.min(MAX_SIDE - 1, Math.floor(p.params.top)) : 10;

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
  function keyOf(v) { return v === null || v === undefined || v === '' ? NONE : String(v); }
  // The fold is "Other" unless a group of that side is already called so (a legend's own "Other" bucket).
  var clash = {};
  function nameOf(field, k) { return k === OTHER ? (clash[field] ? L('smaller', 'Smaller groups') : L('other', 'Other')) : k === NONE ? L('none', '(none)') : L('value.' + field + '.' + k, k); }
  function colourOf(field, k) { return k === OTHER || k === NONE ? GREY : Kit.colour(field, k); }
  function valueOf(r) { return typeof r.sum === 'number' ? r.sum : (typeof r.count === 'number' ? r.count : 0); }
  function valueText(v) { return Kit.fmt(v, unit); }

  // -- groups and links from the rows ---------------------------------------------
  var rows = Array.isArray(p.rows) ? p.rows : [];
  /** One side's keys, largest first: the first `top` kept, the rest mapped to "Other". */
  function side(field) {
    var tot = {}, keys = [];
    rows.forEach(function (r) {
      var k = keyOf(r[field]);
      if (!(k in tot)) { tot[k] = 0; keys.push(k); }
      tot[k] += valueOf(r);
    });
    keys.sort(function (a, b) { return tot[b] - tot[a]; });
    var keep = {};
    keys.slice(0, keys.length > top + 1 ? top : keys.length).forEach(function (k) { keep[k] = 1; });
    return { map: function (k) { return keep[k] ? k : OTHER; }, keys: keys.filter(function (k) { return keep[k]; }).concat(keys.length > top + 1 ? [OTHER] : []) };
  }
  var S = side(src), T = side(dst);
  [[src, S], [dst, T]].forEach(function (x) { clash[x[0]] = x[1].keys.some(function (k) { return k !== OTHER && nameOf(x[0], k) === L('other', 'Other'); }); });
  var linkVal = {}, total = 0;
  rows.forEach(function (r) {
    var v = valueOf(r);
    if (!(v > 0)) return;
    var id = S.map(keyOf(r[src])) + '\u0001' + T.map(keyOf(r[dst]));
    linkVal[id] = (linkVal[id] || 0) + v;
    total += v;
  });
  var tableRows = rows.map(function (r) {
    var o = {};
    o[src] = nameOf(src, keyOf(r[src]));
    o[dst] = nameOf(dst, keyOf(r[dst]));
    o.count = r.count;
    if (typeof r.sum === 'number') o.sum = r.sum;
    return o;
  });

  var ui = Kit.mount({ rows: tableRows });
  if (!ui) return;
  var style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);
  var box = ui.body.appendChild(el('div', 'fl'));
  if (L('flow.overlap', '')) box.appendChild(el('p', 'fl-note', L('flow.overlap', '')));
  if (L('flow.hint', '')) box.appendChild(el('p', 'fl-note', L('flow.hint', '')));
  var tip = box.appendChild(el('div', 'fl-tip'));
  tip.hidden = true;
  tip.setAttribute('role', 'status');
  var svg = svgEl('svg', { role: 'img', 'font-family': FONT }, box);
  svg.setAttribute('aria-label', L('summary', L('title', 'Flow')));

  function showTip(lines, ev) {
    while (tip.firstChild) tip.removeChild(tip.firstChild);
    lines.forEach(function (l, i) { tip.appendChild(el(i ? 'div' : 'b', null, l)); });
    tip.hidden = false;
    var r = box.getBoundingClientRect(), w = tip.offsetWidth || 180;
    var x = ev && typeof ev.clientX === 'number' ? ev.clientX - r.left : 20, y = ev && typeof ev.clientY === 'number' ? ev.clientY - r.top : 20;
    tip.style.left = Math.max(4, Math.min(x + 12, (box.clientWidth || 600) - w - 4)) + 'px';
    tip.style.top = Math.max(4, y + 12) + 'px';
  }
  function share(v) { return total > 0 ? Kit.fmt(Math.round(v / total * 1000) / 10) + '%' : ''; }

  // -- actions ---------------------------------------------------------------------
  function whereItem(field, k, named) {
    if (k === OTHER || k === NONE) return null;
    var label = named ? L('flow.only', 'Show only “{name}” on the map').replace('{name}', nameOf(field, k)) : L('act.where', 'Show only this on the map');
    return { label: label, run: function () { Kit.action('where', { field: field, bin: k }); } };
  }
  function openMenu(items, x, y) {
    items = items.filter(Boolean);
    if (items.length) Kit.menu(x, y, items);
  }

  // -- drawing -----------------------------------------------------------------------
  var lit = null, linkEls = [], drawn = false;
  function lightUp() {
    linkEls.forEach(function (x) {
      var on = lit === null || x.s === lit || x.t === lit;
      x.el.setAttribute('stroke-opacity', lit === null ? 0.42 : on ? 0.72 : 0.07);
    });
  }
  function clear() { while (svg.firstChild) svg.removeChild(svg.firstChild); linkEls = []; }

  function draw() {
    clear();
    var nodes = S.keys.map(function (k) { return { id: 's\u0001' + k, key: k, field: src, side: 0 }; })
      .concat(T.keys.map(function (k) { return { id: 't\u0001' + k, key: k, field: dst, side: 1 }; }));
    var links = [];
    for (var id in linkVal) {
      if (!Object.prototype.hasOwnProperty.call(linkVal, id)) continue;
      var ab = id.split('\u0001');
      links.push({ source: 's\u0001' + ab[0], target: 't\u0001' + ab[1], value: linkVal[id], s: ab[0], t: ab[1] });
    }
    // Drop nodes no link reaches (every row of theirs had no value).
    var used = {};
    links.forEach(function (l) { used[l.source] = used[l.target] = 1; });
    nodes = nodes.filter(function (n) { return used[n.id]; });
    var W = Math.max(280, box.clientWidth || 640);
    var vertical = W <= 480;
    var per = Math.max(S.keys.length, T.keys.length, 1);
    if (!links.length) {
      svg.setAttribute('width', W); svg.setAttribute('height', 40);
      svgEl('text', { x: 4, y: 20, 'font-size': 13, fill: MUTED }, svg).textContent = L('noData', 'Nothing to show for this selection.');
      return;
    }
    // Flow along u (x when wide, y when narrow), groups across v; labels take the margins beside each column.
    var labelU = vertical ? 96 : Math.min(190, Math.round(W * 0.27));
    var spanV = vertical ? W - 8 : Math.min(860, Math.max(260, per * 30));
    var spanU = vertical ? Math.min(720, Math.max(420, per * 26)) + 2 * labelU : W;
    var u0 = labelU, u1 = spanU - labelU;
    var pad = Math.max(2, Math.min(12, spanV * 0.3 / Math.max(1, per - 1)));
    var graph = d3.sankey().nodeId(function (n) { return n.id; }).nodeWidth(vertical ? 10 : 14).nodePadding(pad)
      .nodeSort(null).extent([[u0, 4], [u1, spanV - 4]])({ nodes: nodes.map(function (n) { return Object.assign({}, n); }), links: links.map(function (l) { return Object.assign({}, l); }) });
    var width = vertical ? spanV : spanU, height = vertical ? spanU : spanV;
    svg.setAttribute('width', width);
    svg.setAttribute('height', height);
    svg.setAttribute('viewBox', '0 0 ' + width + ' ' + height);
    var P = vertical ? function (u, v) { return v + ',' + u; } : function (u, v) { return u + ',' + v; };
    svgEl('rect', { x: 0, y: 0, width: width, height: height, fill: '#ffffff' }, svg);
    var gl = svgEl('g', { fill: 'none' }, svg), gn = svgEl('g', {}, svg);

    graph.links.forEach(function (l) {
      var a = l.source.x1, b = l.target.x0, m = (a + b) / 2;
      var path = svgEl('path', {
        d: 'M' + P(a, l.y0) + 'C' + P(m, l.y0) + ' ' + P(m, l.y1) + ' ' + P(b, l.y1),
        stroke: colourOf(src, l.s), 'stroke-width': Math.max(1, l.width), 'stroke-opacity': 0.42, class: 'fl-link',
      }, gl);
      var lines = [nameOf(src, l.s) + ' → ' + nameOf(dst, l.t), valueText(l.value) + (total ? ' · ' + share(l.value) : '')];
      svgEl('title', {}, path).textContent = lines.join(': ');
      linkEls.push({ el: path, s: 's\u0001' + l.s, t: 't\u0001' + l.t });
      path.addEventListener('mousemove', function (e) { showTip(lines, e); });
      path.addEventListener('mouseleave', function () { tip.hidden = true; });
      path.addEventListener('click', function (e) { openMenu([whereItem(src, l.s, true), whereItem(dst, l.t, true)], e.clientX, e.clientY); });
    });

    var maxChars = Math.max(6, Math.floor((labelU - 10) / 6.4));
    var lastAt = [-Infinity, -Infinity];   // per side: where the previous label sits across the flow
    graph.nodes.forEach(function (n) {
      var name = nameOf(n.field, n.key), v = n.value || 0;
      var g = svgEl('g', { class: 'fl-node', tabindex: 0, role: 'button' }, gn);
      g.setAttribute('aria-label', name + ': ' + valueText(v) + (total ? ' · ' + share(v) : ''));
      var du = n.x1 - n.x0, dv = Math.max(1, n.y1 - n.y0);
      svgEl('rect', vertical ? { x: n.y0, y: n.x0, width: dv, height: du } : { x: n.x0, y: n.y0, width: du, height: dv }, g)
        .setAttribute('fill', colourOf(n.field, n.key));
      var short = name.length > maxChars ? name.slice(0, maxChars - 1) + '…' : name;
      var t, at = (n.y0 + n.y1) / 2;
      // A label that would overlap the previous one of its side is left out; the node keeps its name in
      // its aria-label and tooltip.
      var room = at - lastAt[n.side] >= (vertical ? 12 : 13);
      if (room) lastAt[n.side] = at;
      if (!room) t = null;
      else if (vertical) {
        // Upright text along the column's outer edge: above the sources, below the targets.
        var cx = at + 4, cy = n.side === 0 ? n.x0 - 5 : n.x1 + 5;
        t = svgEl('text', { x: cx, y: cy, 'font-size': 11, fill: INK, 'text-anchor': n.side === 0 ? 'start' : 'end', transform: 'rotate(-90 ' + cx + ' ' + cy + ')' }, g);
      } else {
        t = svgEl('text', { x: n.side === 0 ? n.x0 - 6 : n.x1 + 6, y: at + 4, 'font-size': 12, fill: INK, 'text-anchor': n.side === 0 ? 'end' : 'start' }, g);
      }
      if (t) { t.textContent = short; if (short !== name) svgEl('title', {}, t).textContent = name; }
      var lines = [name, valueText(v) + (total ? ' · ' + share(v) : '')];
      var on = function (e) { lit = n.id; lightUp(); showTip(lines, e); };
      var off = function () { lit = null; lightUp(); tip.hidden = true; };
      g.addEventListener('mouseenter', on);
      g.addEventListener('mouseleave', off);
      g.addEventListener('focus', function () { var r = g.getBoundingClientRect(); on({ clientX: r.left, clientY: r.bottom }); });
      g.addEventListener('blur', off);
      g.addEventListener('click', function (e) { openMenu([whereItem(n.field, n.key, false)], e.clientX, e.clientY); });
      g.addEventListener('keydown', function (e) {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        var r = g.getBoundingClientRect();
        openMenu([whereItem(n.field, n.key, false)], r.left + 8, r.bottom);
      });
    });
    lightUp();
  }

  Kit.libs('d3').then(function () { return Kit.libs('d3-sankey'); }).then(function () {
    draw();
    Kit.registerExport(svg);
    if (!drawn) { drawn = true; Kit.drawn(); }
    if (typeof ResizeObserver === 'function') {
      var last = box.clientWidth, again;
      new ResizeObserver(function () {
        clearTimeout(again);
        again = setTimeout(function () { if (box.clientWidth !== last) { last = box.clientWidth; tip.hidden = true; draw(); } }, 120);
      }).observe(box);
    }
  }).catch(function (e) {
    TM.fail('runtime', e && e.message ? e.message : 'flow failed');
    ui.showTable(true);
  });
})();
