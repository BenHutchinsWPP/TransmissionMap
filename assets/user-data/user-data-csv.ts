// ─── CSV import (point data) ─────────────────────────────────────────────────
// Parses a CSV, auto-detects lat/long columns, and shows a picker dialog so the
// user can confirm/override before importing. Non-coordinate columns become
// feature properties. Deps: state, utils-uid, user-data (no url-state).

import { ensureGeoJsonFeatureUids } from '../utils/utils-uid.js';
import { addUserLayer } from './user-data.js';
import { parseCSV, guessColumn, LAT_NAMES, LNG_NAMES, NAME_NAMES } from './csv-parse.js';
import { escapeHtml } from '../utils/utils.js';

export function handleCSV(file: File) {
  file.text().then(text => {
    const rows = parseCSV(text);
    if (rows.length < 2) { alert('CSV has no data rows.'); return; }
    const headers = rows[0];
    const latGuess  = guessColumn(headers, LAT_NAMES);
    const lngGuess  = guessColumn(headers, LNG_NAMES);
    const nameGuess = guessColumn(headers, NAME_NAMES);
    showPicker(file.name, headers, rows.slice(1), latGuess, lngGuess, nameGuess);
  });
}

function buildFeatures(
  headers: string[], dataRows: string[][], latCol: number, lngCol: number,
  nameCols: number[], delimiter: string,
) {
  const features: GeoJSON.Feature[] = [];
  let skipped = 0;
  for (const r of dataRows) {
    const lat = parseFloat(r[latCol]);
    const lng = parseFloat(r[lngCol]);
    if (!isFinite(lat) || !isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) { skipped++; continue; }
    const props: Record<string, string> = {};
    headers.forEach((h, i) => { if (i !== latCol && i !== lngCol) props[h || `col${i}`] = r[i] ?? ''; });
    if (nameCols.length > 0) {
      props.name = nameCols.map(c => r[c] ?? '').filter(Boolean).join(delimiter);
    }
    features.push({ type: 'Feature', properties: props, geometry: { type: 'Point', coordinates: [lng, lat] } });
  }
  return { features, skipped };
}

function showPicker(
  filename: string, headers: string[], dataRows: string[][],
  latGuess: number, lngGuess: number, nameGuess: number,
) {
  const dlg = document.createElement('dialog');
  dlg.className = 'disclaimer-dialog';
  const coordOpts = (sel: number) => headers
    .map((h, i) => `<option value="${i}"${i === sel ? ' selected' : ''}>${escapeHtml(h || `(column ${i + 1})`)}</option>`)
    .join('');
  const nameChecks = headers
    .map((h, i) => `<label style="display:flex;gap:.3rem;align-items:center;white-space:nowrap">` +
      `<input type="checkbox" name="csvName" value="${i}"${i === nameGuess ? ' checked' : ''}>` +
      ` ${escapeHtml(h || `col${i + 1}`)}</label>`)
    .join('');
  dlg.innerHTML = `
    <div class="disclaimer-content">
      <div class="disclaimer-header"><h2>Import CSV</h2></div>
      <p class="disclaimer-body">${dataRows.length} data row(s). Pick coordinate columns and optionally name fields.</p>
      <div class="disclaimer-body" style="display:grid;grid-template-columns:auto 1fr;gap:.5rem .75rem;align-items:center">
        <label for="csvLatSel">Latitude</label><select id="csvLatSel">${coordOpts(latGuess)}</select>
        <label for="csvLngSel">Longitude</label><select id="csvLngSel">${coordOpts(lngGuess)}</select>
        <label for="csvDelim">Name delimiter</label>
        <input id="csvDelim" type="text" value=" — " style="width:5rem;font-family:inherit">
      </div>
      <div class="disclaimer-body">
        <div style="margin-bottom:.35rem;font-size:.875em;opacity:.8">Name fields <em>(optional — checked fields are joined by the delimiter above)</em></div>
        <div style="display:flex;flex-wrap:wrap;gap:.25rem .75rem;max-height:7rem;overflow-y:auto;font-size:.875em">
          ${nameChecks}
        </div>
      </div>
      <div class="disclaimer-footer">
        <button class="disclaimer-dismiss" id="csvCancel" type="button">Cancel</button>
        <button class="disclaimer-accept" id="csvImport" type="button">Import</button>
      </div>
    </div>`;
  document.body.appendChild(dlg);
  const cleanup = () => { dlg.close(); dlg.remove(); };
  dlg.querySelector('#csvCancel')!.addEventListener('click', cleanup);
  dlg.querySelector('#csvImport')!.addEventListener('click', () => {
    const latCol  = +(dlg.querySelector('#csvLatSel') as HTMLSelectElement).value;
    const lngCol  = +(dlg.querySelector('#csvLngSel') as HTMLSelectElement).value;
    if (latCol === lngCol) { alert('Latitude and longitude must be different columns.'); return; }
    const nameCols = [...dlg.querySelectorAll<HTMLInputElement>('input[name="csvName"]:checked')]
      .map(cb => +cb.value);
    const delimiter = (dlg.querySelector('#csvDelim') as HTMLInputElement).value;
    const { features, skipped } = buildFeatures(headers, dataRows, latCol, lngCol, nameCols, delimiter);
    cleanup();
    if (!features.length) { alert('No valid coordinates found in the selected columns.'); return; }
    const fc: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features };
    ensureGeoJsonFeatureUids(fc, filename);
    addUserLayer(filename, fc);
    if (skipped) alert(`Imported ${features.length} point(s); skipped ${skipped} row(s) with invalid coordinates.`);
  });
  dlg.showModal();
}
