// ─── File import (GeoJSON / KML / KMZ) ───────────────────────────────────────
// Deps: togeojson, jszip, state, utils, user-data (no url-state)

import * as toGeoJSON from '@tmcw/togeojson';
import JSZip from 'jszip';
import { state } from '../state.js';
import { ensureGeoJsonFeatureUids } from '../utils/utils-uid.js';
import { renderMyDataTab, addUserLayer } from './user-data.js';

export function handleFileOpen(file: File) {
  const ext = (file.name.split('.').pop() ?? '').toLowerCase();
  if (ext === 'geojson' || ext === 'json') {
    file.text().then((text: string) => loadGeoJSON(JSON.parse(text), file.name))
      .catch(err => alert(`Could not import ${file.name}: ${(err as Error).message}`));
  } else if (ext === 'kml') {
    file.text().then((text: string) => loadKML(text, file.name))
      .catch(err => alert(`Could not import ${file.name}: ${(err as Error).message}`));
  } else if (ext === 'kmz') {
    loadKMZ(file);
  } else if (ext === 'csv') {
    import('./user-data-csv.js').then(m => m.handleCSV(file));
  }
}

function loadGeoJSON(geojson: GeoJSON.GeoJSON & { _tmSource?: string }, filename: string) {
  if (geojson._tmSource === 'TransmissionMap') {
    if (state.draw) {
      state.draw.add(geojson as GeoJSON.FeatureCollection);
      renderMyDataTab();
    }
    return;
  }
  let fc: GeoJSON.FeatureCollection;
  if (geojson.type === 'Feature') {
    fc = { type: 'FeatureCollection', features: [geojson] };
  } else if (geojson.type === 'FeatureCollection') {
    fc = geojson;
  } else {
    return; // Ignore other GeoJSON types for now or handle them
  }
  ensureGeoJsonFeatureUids(fc, filename);
  addUserLayer(filename, fc);
}

function loadKML(text: string, filename: string) {
  const dom = new DOMParser().parseFromString(text, 'text/xml');
  const geojson = toGeoJSON.kml(dom);
  ensureGeoJsonFeatureUids(geojson as unknown as GeoJSON.GeoJSON, filename);
  addUserLayer(filename, geojson as GeoJSON.FeatureCollection);
}

function loadKMZ(file: File) {
  JSZip.loadAsync(file).then(zip => {
    const kmlEntry = zip.files['doc.kml'] ?? Object.values(zip.files).find(f => f.name.endsWith('.kml'));
    if (!kmlEntry) { alert('No KML found inside KMZ'); return; }
    kmlEntry.async('string').then(text => loadKML(text, file.name))
      .catch(err => alert(`Could not import ${file.name}: ${(err as Error).message}`));
  }).catch(err => alert(`Could not import ${file.name}: ${(err as Error).message}`));
}

