// .claude/skills/drive-app/scenarios/lines.mjs
// The `lines` scenario of drive.mjs (see SKILL.md); helpers come from ../harness.mjs.
import fs from 'node:fs';
import path from 'node:path';
import { PREVIEW, URL_BASE, OUT, CAM, log, check, open, settle, mod, st, hashFor, shot, CORS, DATA_HOST, PROD_DATA, lineRig, pickLine, tapAt, openTools, myDataCopies, tableCopyShown } from '../harness.mjs';

  // The transmission line tools. On the dev server the line GeoParquet under
  // data/analysis/ comes from the page's own origin. On a preview build the page reads
  // it from the data host: TM_DATA_HOST names a stand-in (SKILL.md § Line tools on a
  // preview build) and lineRig sends every data-host request there, the page's URL
  // and CSP unchanged; the checks that read app state run on a dev-server twin at the
  // same viewport and link (TM_DEV_URL), which reads the same local files. USGS 3DEP is
  // answered by context.route from a synthetic surface, Terrain Tiles are refused (and
  // counted), so nothing leaves for elevation.
export default async function lines(ctx) {
    const OSM = 'osm-transmission-lines', HIFLD = 'hifld-transmission-lines';
    const usgs = { posts: [], gets: 0 }, terrain = [];
    const elev = i => 1500 + 40 * Math.sin(i / 60) + i * 0.05;   // metres, by locationId
    const rig = await lineRig(ctx, { viewport: { width: 1400, height: 1000 }, acceptDownloads: true }, async c => {
      await c.route('https://elevation.nationalmap.gov/**', async route => {
        const req = route.request();
        const CORS = { 'access-control-allow-origin': '*' };
        if (req.method() !== 'POST') { usgs.gets++; return route.fulfill({ json: { name: '3DEPElevation' }, headers: CORS }); }
        const form = new URLSearchParams(req.postData() ?? '');
        usgs.posts.push({ pixelSize: form.get('pixelSize'), n: JSON.parse(form.get('geometry') ?? '{}').points?.length ?? 0 });
        const pts = JSON.parse(form.get('geometry') ?? '{"points":[]}').points;
        return route.fulfill({ headers: CORS, json: { samples: pts.map((p, i) => ({ locationId: i, value: String(elev(i)), location: { x: p[0], y: p[1] } })) } });
      });
      await c.route('https://elevation-tiles-prod.s3.amazonaws.com/**', route => { terrain.push(route.request().url()); return route.fulfill({ status: 404, body: '' }); });
    });
    if (!rig) return;
    const { page, O, errors } = rig;
    await rig.go(CAM);
    const layers = { ...(await st(O, 'state.layerVisibility')), [OSM]: true, [HIFLD]: false };
    const link = await hashFor(O, { layerVisibility: layers }, '9.5/39.70/-104.85');
    await rig.go(link);
    const unit = await mod(O, '/src/units.ts', m => m.getUnits().distance);
    const U = unit === 'mi' ? 1609.344 : 1000;
    const num = s => Number(String(s).replace(/[^\d.-]/g, ''));

    // ── OSM: the popup's exact length, then Copy to My Data with the full geometry.
    const osm = await pickLine(O, OSM);
    check('an OSM line to click', !!osm, osm ? `fid ${osm.fid}` : 'none found in view');
    if (!osm) { await rig.close(); return; }
    await tapAt(page, osm);
    await page.waitForSelector('.maplibregl-popup .popup-line-length:not([hidden])', { timeout: 20000 }).catch(() => {});
    const lenTxt = await page.$eval('.maplibregl-popup .popup-line-length', e => e.hidden ? null : e.textContent).catch(() => null);
    const look = await mod(O, '/assets/lines/line-read.ts', (m, [l, f]) => m.lookup(l, f), [OSM, osm.fid]);
    check('popup shows the exact length from the line files', !!lenTxt && look.ok && Math.abs(num(lenTxt) - look.result.length_km * 1000 / U) < 0.006,
      `${lenTxt} vs lookup ${look.ok && (look.result.length_km * 1000 / U).toFixed(3)} ${unit}`);
    await shot(page, 'lines-1-popup');
    const before = (await myDataCopies(page))?.n ?? 0;
    await page.click('.maplibregl-popup .popup-copy-btn');
    await page.waitForFunction(() => /✓/.test(document.querySelector('.maplibregl-popup .popup-copy-btn')?.textContent ?? ''), null, { timeout: 20000 }).catch(() => {});
    const copied = await myDataCopies(page);
    const full = await mod(O, '/assets/lines/line-read.ts', (m, [l, f]) => m.lineGeometry(l, f), [OSM, osm.fid]);
    const verts = g => JSON.stringify(g?.coordinates ?? []).split('],[').length;
    check('copy adds one feature carrying the full GeoParquet geometry', copied?.n === before + 1 && full.ok
      && JSON.stringify(copied.f.geometry) === JSON.stringify(full.result) && !copied.f.properties.geometry_source,
      `features ${before}→${copied?.n}; vertices copy ${verts(copied?.f.geometry)} vs tile ${osm.tileVerts}`);
    check('the copy credits OSM (attribution, ODbL, osm link)', /OpenStreetMap/.test(copied?.f.properties.attribution ?? '')
      && /ODbL/.test(copied?.f.properties.licence ?? '') && /^https:\/\/www\.openstreetmap\.org\/way\//.test(copied?.f.properties.osm ?? ''),
      JSON.stringify({ a: copied?.f.properties.attribution, l: copied?.f.properties.licence, o: copied?.f.properties.osm }));

    // ── The fault locator on the same line, from the same popup (a second tap would now
    //    also hit the copy in My Data and open the picker).
    await page.waitForSelector('.maplibregl-popup .popup-line-tools-btn', { timeout: 20000 });
    await page.click('.maplibregl-popup .popup-line-tools-btn');
    await page.waitForSelector('#td-line:not([hidden]) .lt-grid', { timeout: 60000 })   // the first open compiles the chunk
      .catch(async e => { log('Line tab:', await page.$eval('#td-line', x => `hidden=${x.hidden} ${x.textContent}`).catch(() => 'none')); throw e; });
    await page.waitForTimeout(1500);   // the substation names (lines/osm-substation.ts)
    const facts = () => page.$$eval('#td-line .lt-info .lt-facts dt', dts => Object.fromEntries(dts.map(d => [d.textContent, d.nextElementSibling.textContent])));
    const f0 = await facts();
    const L = num(f0.Length);
    log('OSM line facts', JSON.stringify(f0));
    check('the Line tab shows the line length', L > 0, f0.Length);
    const chain = await mod(O, '/assets/lines/line-read.ts', (m, [l, f]) => m.chainGeometry(l, f), [OSM, osm.fid]);
    log('chain', chain.ok ? `${chain.result.ways.length} ways, subs ${chain.result.startSub},${chain.result.endSub}` : chain.reason);
    const setIn = async (sel, v) => { await page.fill(sel, v === null ? '' : String(v)); };
    const locate = async (a, b) => {
      await setIn('#lt-da', a); await setIn('#lt-db', b);
      await page.click('#td-line .lt-locate');
      await page.waitForTimeout(300);
    };
    const d = +(L / 3).toFixed(3);
    await locate(d, +(L - d).toFixed(3));
    const pins = await page.$$eval('#td-line .lt-pin', ps => ps.map(p => ({ coords: p.querySelector('code').textContent, along: p.querySelector('.lt-along').textContent })));
    const gap = await page.$eval('#td-line .lt-gap', e => e.textContent).catch(() => '');
    check('two pins, one from each end', pins.length === 2, JSON.stringify(pins));
    const sums = pins.map(p => { const [a, b] = p.along.split('·').map(num); return a + b; });
    check('each pin: distance from A + distance from B = the line length', sums.length === 2 && sums.every(s => Math.abs(s - L) <= 0.011), `${sums.join(', ')} vs ${L}`);
    check('d from A and L − d from B meet: the gap is 0', Math.abs(num(gap.split(':').at(-1))) <= 0.011, gap);
    const onLine = await O.evaluate(async ([pins, ways]) => {
      const { haversineKm } = await import('/assets/sandbox/geo-kit.ts');
      const segs = ways.flatMap(w => (w.geometry.type === 'LineString' ? [w.geometry.coordinates] : w.geometry.coordinates));
      return pins.map(p => {
        const [lat, lon] = p.coords.split(',').map(Number);
        let best = Infinity;
        for (const part of segs) for (let i = 0; i + 1 < part.length; i++) {
          const [a, b] = [part[i], part[i + 1]];
          for (let k = 0; k <= 200; k++) {
            const q = [a[0] + (b[0] - a[0]) * k / 200, a[1] + (b[1] - a[1]) * k / 200];
            best = Math.min(best, haversineKm([lon, lat], q) * 1000);
          }
        }
        return Math.round(best * 100) / 100;
      });
    }, [pins, chain.ok ? chain.result.ways : []]);
    check('each pin lies on the true geometry (≤ 1 m, 6-decimal coordinates)', onLine.length === 2 && onLine.every(m => m <= 1), `metres off the line: ${onLine.join(', ')}`);
    await settle(page);
    await shot(page, 'lines-2-locator-pins');
    await locate(+(L * 1.5).toFixed(2), null);
    const refuse = await page.$eval('#td-line .lt-results .lt-refuse', e => e.textContent).catch(() => '');
    const nPins = await page.$$eval('#td-line .lt-pin', p => p.length);
    check('a distance beyond the line is refused in words, no pin', /longer than the line/.test(refuse) && nPins === 0, refuse);
    await locate(d, null);

    // ── Profile from the USGS mock.
    const intro = await page.$eval('#td-line .lt-profile .lt-hint', e => e.textContent).catch(() => '');
    check('the profile intro says points go to USGS (a Colorado line)', /USGS/.test(intro) && /sends/.test(intro), intro);
    check('nothing sent to USGS before Show', usgs.posts.length === 0);
    await page.click('#td-line .lt-prof-show');
    await page.waitForSelector('#td-line .lt-prof-chart', { timeout: 30000 });
    await page.waitForTimeout(500);
    const prof = await page.evaluate(() => {
      const q = s => document.querySelector('#td-line ' + s);
      const cv = q('.lt-prof-chart');
      const g = cv.getContext('2d'), px = g.getImageData(0, 0, cv.width, cv.height).data;
      let blue = 0;
      for (let i = 0; i < px.length; i += 4) if (px[i + 2] > 180 && px[i] < 90) blue++;
      const facts = Object.fromEntries([...document.querySelectorAll('#td-line .lt-prof-stats dt')].map(d => [d.textContent, d.nextElementSibling.textContent]));
      return { blue, legend: q('.lt-prof-legend')?.textContent, credit: q('.lt-prof-credit')?.textContent, facts, aria: cv.getAttribute('aria-label') };
    });
    log('profile', JSON.stringify(prof.facts));
    check('the chart is drawn from the mock (3DEP-blue ink)', prof.blue > 300, `${prof.blue} blue px`);
    check('source labels: legend and source row name USGS 3DEP, 100 %', /USGS 3DEP/.test(prof.legend ?? '') && /USGS 3DEP 100/.test(prof.facts['Elevation source'] ?? ''), `${prof.legend} | ${prof.facts['Elevation source']}`);
    check('the USGS credit is shown', /U\.S\. Geological Survey/.test(prof.credit ?? ''), prof.credit);
    const nSamples = num((prof.facts.Samples ?? '').split(',')[0]);
    check('requests: ≤ 1,000 points each, pixelSize always sent, all samples asked', usgs.posts.length > 0 && usgs.posts.every(p => p.n <= 1000 && /"x":(10|30)/.test(p.pixelSize ?? ''))
      && usgs.posts.reduce((n, p) => n + p.n, 0) === nSamples, JSON.stringify(usgs.posts) + ` samples ${nSamples}`);
    const lowExpected = Math.min(...Array.from({ length: Math.min(1000, nSamples) }, (_, i) => elev(i)));
    check('no Terrain Tiles request (every sample answered by the mock)', terrain.length === 0, terrain.slice(0, 2).join(' '));
    const [csvDl] = await Promise.all([page.waitForEvent('download'), page.click('#td-line .lt-prof-csv')]);
    const csvFile = path.join(OUT, csvDl.suggestedFilename());
    await csvDl.saveAs(csvFile);
    const csv = fs.readFileSync(csvFile, 'utf8');
    const eu = await mod(O, '/src/units.ts', m => m.unitLabel('elevation'));
    const rows = csv.replace(/^﻿/, '').split('\r\n').filter(Boolean);
    check('CSV: BOM and the header distance_<unit>,lon,lat,elev_<unit>,source', csv.startsWith('﻿') && rows[0] === `distance_${unit},lon,lat,elev_${eu},source`, rows[0]);
    const data = rows.slice(1).filter(r => /^\d/.test(r));
    check('CSV: one row per sample, from USGS 3DEP, first elevation from the mock', data.length === nSamples && data.every(r => r.endsWith(',USGS 3DEP'))
      && Math.abs(num(data[0].split(',')[3]) - (eu === 'ft' ? elev(0) * 3.28084 : elev(0))) < 0.2, `${data.length} rows; first ${data[0]}; low ≈ ${lowExpected.toFixed(1)} m`);
    check('CSV: no unguarded = + @ cell; the datum and credit rows', !rows.some(r => /(^|,)[=+@]/.test(r)) && /NAVD88/.test(csv) && /ODbL/.test(csv), rows.slice(-4).join(' / '));
    // hover syncs a map marker (dev: read from the map; a build has no module to ask)
    const cvBox = await page.$eval('#td-line .lt-prof-chart', e => { const r = e.getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; });
    await page.mouse.move(cvBox[0] + cvBox[2] * 0.5, cvBox[1] + cvBox[3] * 0.5);
    await page.waitForTimeout(200);
    if (!PREVIEW) {
      const hoverN = await page.evaluate(async () => (await (await import('/assets/state.ts')).state.map.getSource('lt-hover')?.getData())?.features.length ?? 0);
      check('hovering the chart puts the marker on the map', hoverN === 1, `lt-hover features ${hoverN}`);
    }
    await page.$eval('#td-line .lt-profile', e => e.scrollIntoView({ block: 'end' }));
    await settle(page);
    await shot(page, 'lines-3-profile');

    // ── OSM chain ends named from the substation archive with the substation layers off.
    const subLines = await O.evaluate(async () => {
      const { state } = await import('/assets/state.ts');
      const { layerById } = await import('/src/registry/index.ts');
      const { featureId } = await import('/assets/feature-id.ts');
      const { chainGeometry } = await import('/assets/lines/line-read.ts');
      const m = state.map, id = 'osm-transmission-lines';
      const seen = new Set(), out = [];
      for (const f of m.queryRenderedFeatures({ layers: layerById(id).mapLayerIds.filter(l => m.getLayer(l)) })) {
        const fid = featureId(id, f);
        if (fid === undefined || seen.has(fid) || seen.size >= 60) continue;
        seen.add(fid);
        const c = await chainGeometry(id, fid);
        if (c.ok && c.result.startSub != null) out.push({ fid, props: f.properties, subs: [c.result.startSub, c.result.endSub], ways: c.result.ways.map(w => w.fid),
          mid: (g => (g.type === 'LineString' ? g.coordinates : g.coordinates.flat())[0])(c.result.ways[0].geometry) });
        if (out.length >= 20) break;
      }
      return out;
    });
    const subLayerOn = await st(O, "!!state.layerVisibility['osm-substations-points'] || !!state.layerVisibility['osm-substations-polygons']");
    // A build opens it as a visitor does (a tap, then Line tools), on a fresh load of the link so the twin's camera matches.
    let subLine = subLines[0] ?? null;
    if (PREVIEW) {
      // Any way of the chain will do (the tab names the chain's ends). These are often stubs
      // inside a substation, so look closer: z17 on the chain's first vertex.
      subLine = null;
      for (const s of subLines.slice(0, 4)) {
        await rig.go(await hashFor(O, { layerVisibility: layers }, `17/${s.mid[1].toFixed(5)}/${s.mid[0].toFixed(5)}`));
        for (const w of s.ways) {
          const at = await pickLine(O, OSM, { fid: w, box: [60, 60, 260, 0.6] });
          if (at) { subLine = { ...s, fid: at.fid, props: at.props, at }; break; }
        }
        if (subLine) break;
      }
    }
    if (subLine && (await openTools(rig, OSM, subLine.fid, subLine.props, subLine.at))) {
      await page.waitForFunction(() => !/substation \(OSM/.test(document.querySelector('#td-line .lt-facts')?.textContent ?? ''), null, { timeout: 15000 }).catch(() => {});
      const f2 = await facts();
      check('OSM ends: a substation end reads its name with the substation layers off; an open end its coordinates',
        !subLayerOn && ['End A', 'End B'].every((k, i) => subLine.subs[i] == null ? /line end at/.test(f2[k]) : !!f2[k] && !/OSM (way|node|relation)|line end/.test(f2[k])),
        `${f2['End A']} | ${f2['End B']} (subs ${subLine.subs.join(', ')}; substation layers on: ${subLayerOn})`);
      await settle(page);
      await shot(page, 'lines-3b-osm-substation-ends');
    } else check('an OSM line in view whose chain ends at a substation, opened', false, `${subLines.length} candidates`);

    // ── HIFLD: end A is SUB_1 at the end nearest the HIFLD substation of that name.
    if (await page.isVisible('.td-tab-x[data-pane="line"]')) await page.click('.td-tab-x[data-pane="line"]');
    await page.waitForTimeout(300);
    if (!PREVIEW) {
      const left = await st(page, "[...state.map.getStyle().layers.map(l => l.id), ...Object.keys(state.map.getStyle().sources)].filter(id => id.startsWith('lt-'))");
      check('closing the Line tab removes every lt- layer and source', left.length === 0, left.join(','));
    }
    const hl = { ...layers, [OSM]: false, [HIFLD]: true };
    await rig.go(await hashFor(O, { layerVisibility: hl }, '9.5/39.70/-104.85'));
    const real = "p.SUB_1 && p.SUB_2 && !/^(UNKNOWN|TAP|NOT AVAILABLE)/i.test(p.SUB_1) && !/^(UNKNOWN|TAP|NOT AVAILABLE)/i.test(p.SUB_2)";
    const hifld = await pickLine(O, HIFLD, { accept: real }) ?? await pickLine(O, HIFLD, { accept: 'p.SUB_1 && p.SUB_2' });
    if (hifld && hifld.props.SUB_1 && hifld.props.SUB_2 && (await openTools(rig, HIFLD, hifld.fid, hifld.props, hifld))) {
      await page.waitForFunction(() => !/Checking which end/.test(document.querySelector('#td-line .lt-notes')?.textContent ?? 'Checking which end'), null, { timeout: 30000 }).catch(() => {});
      const f1 = await facts();
      const note = await page.$eval('#td-line .lt-notes', e => e.textContent);
      const matched = /End A is SUB_1/.test(note);
      const named = f1['End A'] === String(hifld.props.SUB_1) && f1['End B'] === String(hifld.props.SUB_2);
      if (PREVIEW) {
        check('HIFLD: End A is SUB_1, End B SUB_2 (which end sits where: the dev run measures it)', named, `${f1['End A']} / ${f1['End B']}; ${matched ? 'matched' : 'unknown order'}`);
      } else {
        const ends = await page.evaluate(async () => {
          const { state } = await import('/assets/state.ts');
          const d = await state.map.getSource('lt-pts').getData();
          return Object.fromEntries(d.features.filter(f => f.properties.kind === 'end').map(f => [f.properties.label, f.geometry.coordinates]));
        });
        const near = await page.evaluate(async ([ends, s1, s2]) => {
          const { state } = await import('/assets/state.ts');
          const { layerSourceId } = await import('/assets/layers/layer-source.ts');
          const { haversineKm } = await import('/assets/sandbox/geo-kit.ts');
          const pts = state.sourcesData[layerSourceId('hifld-substations')] ?? [];
          const key = v => String(v ?? '').trim().replace(/\s+/g, ' ').toUpperCase();
          const dist = (name, at) => Math.min(Infinity, ...pts.filter(f => key(f.properties?.name) === key(name)).map(f => haversineKm(f.geometry.coordinates, at) * 1000));
          return { a1: dist(s1, ends.A), b1: dist(s1, ends.B), a2: dist(s2, ends.A), b2: dist(s2, ends.B) };
        }, [ends, hifld.props.SUB_1, hifld.props.SUB_2]);
        check('HIFLD: End A is SUB_1, End B SUB_2, and (when matched) A sits nearer SUB_1', named && (!matched || Math.min(near.a1, near.b2) <= Math.min(near.b1, near.a2)),
          `${f1['End A']} / ${f1['End B']}; ${matched ? 'matched' : 'unknown order'}; m: ${JSON.stringify(Object.fromEntries(Object.entries(near).map(([k, v]) => [k, Math.round(v)])))}`);
      }
      await settle(page);
      await shot(page, 'lines-4-hifld-ends');
      await page.click('.td-tab-x[data-pane="line"]');
    } else check('a HIFLD line with SUB_1 and SUB_2 to open', false, JSON.stringify(hifld?.props ?? null));

    // ── The table: "Copy N checked lines" shows once the layer's files answer.
    check('table: "Copy N checked lines" is offered on HIFLD lines', await tableCopyShown(page, HIFLD, true));
    await shot(page, 'lines-4b-table-copy');
    // A build's reads are reported at the stand-in's URL (the route rewrote them in the network layer).
    const own = PREVIEW ? [PROD_DATA, DATA_HOST] : [URL_BASE];
    const bad = rig.reads.filter(([u, s]) => !own.some(o => u.startsWith(o)) || (s !== 200 && s !== 206));
    check(`the line files are read from ${PREVIEW ? 'the data host' : 'the page origin'} (index 200, parts by range 206)`,
      rig.reads.length > 0 && !bad.length && rig.reads.some(([u, s]) => /index\.json(\?|$)/.test(u) && s === 200) && rig.reads.some(([, s]) => s === 206),
      `${rig.reads.length} reads, ${rig.reads.filter(([, s]) => s === 206).length} × 206; bad: ${bad.slice(0, 3).map(r => r.join(' ')).join(' , ')}`);
    const csp = await page.evaluate(() => window.__csp ?? []);
    check('no CSP violation', csp.length === 0, csp.join(' | '));
    check('no console errors', errors.length === 0, errors.join(' | '));
    await rig.close();

    // ── A 390×844 touch phone: the Line tab on an OSM line.
    const prig = await lineRig(ctx, { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }, async c => {
      await c.route('https://elevation.nationalmap.gov/**', r => r.fulfill({ json: { samples: [] }, headers: { 'access-control-allow-origin': '*' } }));
    });
    const pp = prig.page;
    await prig.go(link);
    for (const p of [pp, prig.O]) if (await p.isVisible('#closeLayers')) await p.click('#closeLayers');
    await pp.waitForTimeout(500);
    const PHONE_BOX = [30, 30, 300, 0.6];
    const pOsm = PREVIEW ? await pickLine(prig.O, OSM, { fid: osm.fid, box: PHONE_BOX }) ?? await pickLine(prig.O, OSM, { box: PHONE_BOX }) : osm;
    if (pOsm && (await openTools(prig, OSM, pOsm.fid, pOsm.props, pOsm, true))) {
      const pL = num((await pp.$$eval('#td-line .lt-info .lt-facts dt', dts => Object.fromEntries(dts.map(d => [d.textContent, d.nextElementSibling.textContent])))).Length);
      await pp.fill('#lt-da', String(+(pL / 3).toFixed(3)));
      await pp.click('#td-line .lt-locate');
      await pp.waitForTimeout(800);
      const geo = await pp.evaluate(() => {
        const small = [...document.querySelectorAll('#td-line button, #td-line input')].filter(e => e.offsetParent && e.getBoundingClientRect().height < 40)
          .map(e => `${e.className || e.id}:${Math.round(e.getBoundingClientRect().height)}`);
        const cols = getComputedStyle(document.querySelector('#td-line .lt-grid')).gridTemplateColumns.split(' ').length;
        const wide = [...document.querySelectorAll('#td-line *')].filter(e => e.getBoundingClientRect().right > innerWidth + 1).map(e => e.className).slice(0, 5);
        return { small, cols, wide, scroll: document.documentElement.scrollWidth, w: innerWidth, pins: document.querySelectorAll('#td-line .lt-pin').length };
      });
      check('phone: one column, nothing wider than the screen, no page scroll, a pin placed', geo.cols === 1 && geo.wide.length === 0 && geo.scroll <= geo.w && geo.pins === 1, JSON.stringify(geo));
      check('phone: every Line tab button and input ≥ 40 px', geo.small.length === 0, geo.small.join(', '));
      await settle(pp);
      await shot(pp, 'lines-5-phone');
    } else check('phone: an OSM line to open the Line tab on', false);
    check('no console errors (phone)', prig.errors.length === 0, prig.errors.join(' | '));
    await prig.close();
}
