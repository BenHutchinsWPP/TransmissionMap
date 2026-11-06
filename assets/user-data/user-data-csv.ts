// ─── CSV import (point data) ─────────────────────────────────────────────────
// Parses a CSV, auto-detects lat/long columns, and shows a picker dialog so the
// user can confirm/override before importing. Non-coordinate columns become
// feature properties. `pickCsvPoints` is the reusable picker (caller-supplied
// title/submit text, optional ID-column select, each feature's data-row index);
// `handleCSV` is My Data's import over it. Deps: state, utils-uid, user-data,
// src/i18n (no url-state).

import { ensureGeoJsonFeatureUids } from '../utils/utils-uid.js';
import { addImportedLayer } from './user-data.js';
import { parseCSV, guessColumn, LAT_NAMES, LNG_NAMES, NAME_NAMES } from './csv-parse.js';
import { escapeHtml } from '../utils/utils.js';
import { t } from '../../src/i18n/index.js';

/** Already-translated dialog strings; `idLabel` present adds an optional ID-column select (default None).
 *  `maxRows` refuses a file with more data rows right after parsing, before the dialog and any feature is
 *  built, calling `onTooMany(rows)` instead of alerting. */
export interface CsvPickLabels {
  title: string; submit: string; idLabel?: string; idNone?: string;
  maxRows?: number; onTooMany?: (rows: number) => void;
}

export interface CsvPoints {
  fileName: string;
  headers: string[];
  features: GeoJSON.Feature<GeoJSON.Point>[];
  skipped: number;
  latCol: number;
  lngCol: number;
  nameCols: number[];
  idCol: number | null;
  /** Per feature: its 0-based data row (header excluded) in the CSV. */
  dataRowIndex: Int32Array;
}

export function handleCSV(file: File) {
  pickCsvPoints(file, { title: t('csv.importTitle'), submit: t('csv.import') }).then(r => {
    if (!r) return;
    const fc: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: r.features };
    ensureGeoJsonFeatureUids(fc, r.fileName);
    addImportedLayer(r.fileName, fc);
    if (r.skipped) alert(t('csv.importSuccessSkipped', { count: r.features.length, skipped: r.skipped }));
  });
}

/** Resolves null when the visitor cancels or the file is refused (after its alert). */
export async function pickCsvPoints(file: File, labels: CsvPickLabels): Promise<CsvPoints | null> {
  const rows = parseCSV(await file.text());
  if (labels.maxRows !== undefined && rows.length - 1 > labels.maxRows) { labels.onTooMany?.(rows.length - 1); return null; }
  if (rows.length < 2) { alert(t('csv.noDataRows')); return null; }
  const headers = rows[0];
  return showPicker(file.name, headers, rows.slice(1), labels,
    guessColumn(headers, LAT_NAMES), guessColumn(headers, LNG_NAMES), guessColumn(headers, NAME_NAMES));
}

function buildFeatures(
  headers: string[], dataRows: string[][], latCol: number, lngCol: number,
  nameCols: number[], delimiter: string,
) {
  const features: GeoJSON.Feature<GeoJSON.Point>[] = [];
  const rowIdx: number[] = [];
  let skipped = 0;
  for (const [n, r] of dataRows.entries()) {
    const lat = parseFloat(r[latCol]);
    const lng = parseFloat(r[lngCol]);
    if (!isFinite(lat) || !isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) { skipped++; continue; }
    const props: Record<string, string> = {};
    headers.forEach((h, i) => { if (i !== latCol && i !== lngCol) props[h || `col${i}`] = r[i] ?? ''; });
    if (nameCols.length > 0) {
      props.name = nameCols.map(c => r[c] ?? '').filter(Boolean).join(delimiter);
    }
    features.push({ type: 'Feature', properties: props, geometry: { type: 'Point', coordinates: [lng, lat] } });
    rowIdx.push(n);
  }
  return { features, skipped, dataRowIndex: Int32Array.from(rowIdx) };
}

function showPicker(
  filename: string, headers: string[], dataRows: string[][], labels: CsvPickLabels,
  latGuess: number, lngGuess: number, nameGuess: number,
): Promise<CsvPoints | null> {
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
  const idRow = labels.idLabel === undefined ? '' :
    `<label for="csvIdSel">${escapeHtml(labels.idLabel)}</label><select id="csvIdSel">` +
    `<option value="-1" selected>${escapeHtml(labels.idNone ?? '—')}</option>` +
    headers.map((h, i) => `<option value="${i}">${escapeHtml(h || `(column ${i + 1})`)}</option>`).join('') +
    `</select>`;
  dlg.innerHTML = `
    <div class="disclaimer-content">
      <div class="disclaimer-header"><h2>${escapeHtml(labels.title)}</h2></div>
      <p class="disclaimer-body">${escapeHtml(t('csv.rowsPrompt', { count: dataRows.length }))}</p>
      <div class="disclaimer-body" style="display:grid;grid-template-columns:auto 1fr;gap:.5rem .75rem;align-items:center">
        <label for="csvLatSel">${escapeHtml(t('csv.latitude'))}</label><select id="csvLatSel">${coordOpts(latGuess)}</select>
        <label for="csvLngSel">${escapeHtml(t('csv.longitude'))}</label><select id="csvLngSel">${coordOpts(lngGuess)}</select>
        <label for="csvDelim">${escapeHtml(t('csv.nameDelimiter'))}</label>
        <input id="csvDelim" type="text" value=" — " style="width:5rem;font-family:inherit">
        ${idRow}
      </div>
      <div class="disclaimer-body">
        <div style="margin-bottom:.35rem;font-size:.875em;opacity:.8">${t('csv.nameFieldsNote')}</div>
        <div style="display:flex;flex-wrap:wrap;gap:.25rem .75rem;max-height:7rem;overflow-y:auto;font-size:.875em">
          ${nameChecks}
        </div>
      </div>
      <div class="disclaimer-footer">
        <button class="disclaimer-dismiss" id="csvCancel" type="button">${escapeHtml(t('csv.cancel'))}</button>
        <button class="disclaimer-accept" id="csvImport" type="button">${escapeHtml(labels.submit)}</button>
      </div>
    </div>`;
  document.body.appendChild(dlg);
  return new Promise(resolve => {
    const cleanup = () => { dlg.close(); dlg.remove(); resolve(null); };
    dlg.addEventListener('close', cleanup);
    dlg.querySelector('#csvCancel')!.addEventListener('click', cleanup);
    dlg.querySelector('#csvImport')!.addEventListener('click', () => {
      const latCol  = +(dlg.querySelector('#csvLatSel') as HTMLSelectElement).value;
      const lngCol  = +(dlg.querySelector('#csvLngSel') as HTMLSelectElement).value;
      if (latCol === lngCol) { alert(t('csv.sameColError')); return; }
      const nameCols = [...dlg.querySelectorAll<HTMLInputElement>('input[name="csvName"]:checked')]
        .map(cb => +cb.value);
      const delimiter = (dlg.querySelector('#csvDelim') as HTMLInputElement).value;
      const idSel = dlg.querySelector<HTMLSelectElement>('#csvIdSel');
      const idCol = idSel && +idSel.value >= 0 ? +idSel.value : null;
      const { features, skipped, dataRowIndex } = buildFeatures(headers, dataRows, latCol, lngCol, nameCols, delimiter);
      dlg.removeEventListener('close', cleanup);
      dlg.close(); dlg.remove();
      if (!features.length) { alert(t('csv.noValidCoords')); resolve(null); return; }
      resolve({ fileName: filename, headers, features, skipped, latCol, lngCol, nameCols, idCol, dataRowIndex });
    });
    dlg.showModal();
  });
}
