// ─── Pure CSV helpers (no map/DOM deps, unit-testable) ───────────────────────

// Minimal RFC-4180-ish parser: handles quoted fields, escaped quotes, CRLF.
export function parseCSV(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.length > 1 || (r.length === 1 && r[0] !== ''));
}

export const LAT_NAMES  = ['latitude', 'lat', 'y', 'ycoord', 'lat_dd', 'lat_deg'];
export const LNG_NAMES  = ['longitude', 'long', 'lng', 'lon', 'x', 'xcoord', 'lon_dd', 'lng_deg'];
export const NAME_NAMES = ['name', 'label', 'title', 'site_name', 'facility_name', 'station_name', 'description'];

export function guessColumn(headers: string[], names: string[]): number {
  const lower = headers.map(h => h.trim().toLowerCase());
  for (const n of names) { const i = lower.indexOf(n); if (i !== -1) return i; }
  return -1;
}
