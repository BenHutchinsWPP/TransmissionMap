import { describe, it, expect } from 'vitest';
import {
  row, websiteRow, title,
  renderEiaGen, renderOgfPlanned, renderHifldNatgasPts, renderGeoHydroPts,
  renderBa, renderRetail, buildUserFeatureHtml, buildPopupHtml,
} from './popup-format.js';

// ─── row() ───────────────────────────────────────────────────────────────────

describe('row', () => {
  it('renders key-value pair', () => {
    const out = row('Fuel', 'Solar');
    expect(out).toContain('Fuel');
    expect(out).toContain('Solar');
  });

  it('returns empty string for null', () => expect(row('X', null)).toBe(''));
  it('returns empty string for undefined', () => expect(row('X', undefined)).toBe(''));
  it('returns empty string for empty string', () => expect(row('X', '')).toBe(''));
  it('returns empty string for string "0"', () => expect(row('X', '0')).toBe(''));
  it('returns empty string for number 0', () => expect(row('X', 0)).toBe(''));

  it('renders number 42', () => expect(row('MW', 42)).toContain('42'));

  it('escapes HTML in value', () => {
    const out = row('Name', '<script>');
    expect(out).not.toContain('<script>');
    expect(out).toContain('&lt;script&gt;');
  });

  it('escapes HTML in key', () => {
    const out = row('<img onerror=x>', 'value');
    expect(out).not.toContain('<img');
    expect(out).toContain('&lt;img');
  });
});

// ─── websiteRow() ─────────────────────────────────────────────────────────────

describe('websiteRow', () => {
  it('returns link for valid URL', () => {
    const out = websiteRow('https://example.com');
    expect(out).toContain('href="https://example.com"');
    expect(out).toContain('Website');
  });

  it('returns empty string for empty URL', () => expect(websiteRow('')).toBe(''));

  it('returns empty string for javascript: URI', () => {
    expect(websiteRow('javascript:alert(1)')).toBe('');
  });
});

// ─── title() ─────────────────────────────────────────────────────────────────

describe('title', () => {
  it('wraps text in title div', () => {
    const out = title('My Plant');
    expect(out).toContain('My Plant');
    expect(out).toContain('popup-title');
  });

  it('escapes HTML', () => {
    const out = title('<b>bold</b>');
    expect(out).not.toContain('<b>');
    expect(out).toContain('&lt;b&gt;');
  });
});

// ─── renderEiaGen() ───────────────────────────────────────────────────────────

describe('renderEiaGen', () => {
  const base = {
    plant_name: 'Sunny Farm', technology: 'Solar PV', energy_source: 'SUN',
    nameplate_mw: 100, nerc_region: 'WECC', ba_code: 'CISO',
    state: 'CA', gen_status: 'existing', op_year: 2019,
  };

  it('shows plant name as title', () => {
    expect(renderEiaGen(base)).toContain('Sunny Farm');
  });

  it('shows capacity in MW', () => {
    expect(renderEiaGen(base)).toContain('100 MW');
  });

  it('uses "EIA Plant" when no plant_name', () => {
    expect(renderEiaGen({ ...base, plant_name: null })).toContain('EIA Plant');
  });

  it('uses "Online" label for existing status', () => {
    expect(renderEiaGen(base)).toContain('Online');
  });

  it('uses "Est. Online" label for proposed status', () => {
    expect(renderEiaGen({ ...base, gen_status: 'proposed' })).toContain('Est. Online');
  });

  it('shows Retires row when retirement status + year', () => {
    const out = renderEiaGen({ ...base, gen_status: 'retirement', retirement_year: 2030 });
    expect(out).toContain('Retires');
    expect(out).toContain('2030');
  });

  it('shows Retired row when retired status + year', () => {
    const out = renderEiaGen({ ...base, gen_status: 'retired', retirement_year: 2020 });
    expect(out).toContain('Retired');
  });
});

// ─── renderOgfPlanned() ───────────────────────────────────────────────────────

describe('renderOgfPlanned', () => {
  const base: Record<string, unknown> = {
    Project: 'Desert Wind Link', Owner: 'APS', Status: 'Permitted',
    Type: 'AC', MinVolt: 230, MaxVolt: 500,
    CapacityMW: 1200, EstYear: 2028, ACDC: 'AC',
    FromSub: 'Alpha', ToSub: 'Beta', StatesFull: 'AZ, NV',
    ISO_RTO: 'WECC', Length_mi: 185.7, Link: '',
  };

  it('shows project name as title', () => {
    expect(renderOgfPlanned(base)).toContain('Desert Wind Link');
  });

  it('defaults title to "Planned Transmission"', () => {
    expect(renderOgfPlanned({ ...base, Project: null })).toContain('Planned Transmission');
  });

  it('renders voltage range when min ≠ max', () => {
    const out = renderOgfPlanned(base);
    expect(out).toContain('230–500 kV');
  });

  it('renders single voltage when min = max', () => {
    const out = renderOgfPlanned({ ...base, MinVolt: 345, MaxVolt: 345 });
    expect(out).toContain('345 kV');
  });

  it('renders project link when provided', () => {
    const out = renderOgfPlanned({ ...base, Link: 'https://horizonenergy.org/project' });
    expect(out).toContain('Project page');
    expect(out).toContain('horizonenergy.org');
  });

  it('renders OGF attribution footer', () => {
    expect(renderOgfPlanned(base)).toContain('Our Grid Future');
  });

  it('formats length to 1 decimal', () => {
    expect(renderOgfPlanned(base)).toContain('185.7 mi');
  });
});

// ─── renderHifldNatgasPts() ───────────────────────────────────────────────────

describe('renderHifldNatgasPts', () => {
  it('shows facility name', () => {
    const out = renderHifldNatgasPts({ name: 'Compressor 1', fac_type: 'compressor_station', state: 'TX', status: 'active', operator: 'Kinder Morgan', detail: null });
    expect(out).toContain('Compressor 1');
  });

  it('falls back to type label when no name', () => {
    const out = renderHifldNatgasPts({ name: null, fac_type: 'lng_terminal', state: 'TX', status: null, operator: null, detail: null });
    expect(out).toContain('LNG Terminal');
  });
});

// ─── renderGeoHydroPts() ─────────────────────────────────────────────────────

describe('renderGeoHydroPts', () => {
  it('shows name and temperature', () => {
    const out = renderGeoHydroPts({ name: 'Hot Spring', temp_c: 180, state: 'NV', county: 'Nye', min_depth_m: null, max_depth_m: null, heat_mwt: null, reference: null });
    expect(out).toContain('Hot Spring');
    expect(out).toContain('180 °C');
  });

  it('renders depth range when both bounds present', () => {
    const out = renderGeoHydroPts({ name: null, min_depth_m: 200, max_depth_m: 800, temp_c: null, state: null, county: null, heat_mwt: null, reference: null });
    expect(out).toContain('200–800 m');
  });

  it('renders single depth when only min present', () => {
    const out = renderGeoHydroPts({ name: null, min_depth_m: 300, max_depth_m: null, temp_c: null, state: null, county: null, heat_mwt: null, reference: null });
    expect(out).toContain('300 m');
  });

  it('formats heat_mwt to 2 decimals', () => {
    const out = renderGeoHydroPts({ name: null, heat_mwt: 1.5, min_depth_m: null, max_depth_m: null, temp_c: null, state: null, county: null, reference: null });
    expect(out).toContain('1.50 MWt');
  });
});

// ─── renderBa() ──────────────────────────────────────────────────────────────

describe('renderBa', () => {
  it('shows BA name and stats', () => {
    const out = renderBa({ name: 'CAISO', state: 'CA', tot_cap: 50000, peak_ld: 30000, year: 2023, website: '' });
    expect(out).toContain('CAISO');
    expect(out).toContain('50,000 MW');
    expect(out).toContain('30,000 MW');
  });

  it('omits capacity when zero', () => {
    const out = renderBa({ name: 'BA', state: null, tot_cap: 0, peak_ld: 0, year: null, website: '' });
    expect(out).not.toContain('MW');
  });

  it('includes website link', () => {
    const out = renderBa({ name: 'BA', state: null, tot_cap: 0, peak_ld: 0, year: null, website: 'https://caiso.com' });
    expect(out).toContain('Website');
  });
});

// ─── renderRetail() ───────────────────────────────────────────────────────────

describe('renderRetail', () => {
  it('shows territory name and fields', () => {
    const out = renderRetail({ name: 'PG&E', type: 'IOU', state: 'CA', customers: 5000000, retail_mwh: 80000000, sumr_peak: 20000, ctrl_area: 'CAISO', website: '' });
    expect(out).toContain('PG&amp;E');
    expect(out).toContain('5,000,000');
  });
});

// ─── OSM Data Centers (osm-dc-circles) ────────────────────────────────────────

describe('Data Center popup (osm-dc-circles)', () => {
  const base = {
    name: 'Equinix DC5', operator: 'Equinix', website: '', addr_city: 'Ashburn',
    addr_state: 'Virginia', start_date: '2010', osm_type: 'way' as const, osm_id: 123456,
  };

  it('renders IM3 size when im3_sqft present and > 0', () => {
    const out = buildPopupHtml('osm-dc-circles', { ...base, im3_sqft: 158463 });
    expect(out).toContain('158,463 sq ft (IM3)');
  });

  it('renders IM3 size from a string value (CSV-built GeoJSON props are strings)', () => {
    const out = buildPopupHtml('osm-dc-circles', { ...base, im3_sqft: '103663' });
    expect(out).toContain('103,663 sq ft (IM3)');
  });

  it('omits size row when im3_sqft is an empty string', () => {
    const out = buildPopupHtml('osm-dc-circles', { ...base, im3_sqft: '' });
    expect(out).not.toContain('sq ft');
  });

  it('omits size row when im3_sqft is absent', () => {
    const out = buildPopupHtml('osm-dc-circles', { ...base });
    expect(out).not.toContain('sq ft');
  });

  it('omits size row when im3_sqft is 0', () => {
    const out = buildPopupHtml('osm-dc-circles', { ...base, im3_sqft: 0 });
    expect(out).not.toContain('sq ft');
  });

  it('renders site code when im3_ref present', () => {
    const out = buildPopupHtml('osm-dc-circles', { ...base, im3_ref: 'IAD69' });
    expect(out).toContain('Site code');
    expect(out).toContain('IAD69');
  });

  it('omits site code row when im3_ref absent', () => {
    const out = buildPopupHtml('osm-dc-circles', base);
    expect(out).not.toContain('Site code');
  });
});

// ─── buildUserFeatureHtml() ───────────────────────────────────────────────────

describe('buildUserFeatureHtml', () => {
  it('uses name property as title', () => {
    const out = buildUserFeatureHtml({ name: 'My Marker', description: 'test', __uid: 'abc' });
    expect(out).toContain('My Marker');
  });

  it('falls back to Name, label, title', () => {
    expect(buildUserFeatureHtml({ Name: 'Alt Name' })).toContain('Alt Name');
    expect(buildUserFeatureHtml({ label: 'Lab' })).toContain('Lab');
    expect(buildUserFeatureHtml({ title: 'Tit' })).toContain('Tit');
  });

  it('uses "Feature" when no name field', () => {
    expect(buildUserFeatureHtml({})).toContain('Feature');
  });

  it('skips __uid and style fields', () => {
    const out = buildUserFeatureHtml({ __uid: 'abc', 'stroke-width': 2, fill: '#fff' });
    expect(out).not.toContain('__uid');
    expect(out).not.toContain('stroke-width');
  });

  it('renders extra properties as rows', () => {
    const out = buildUserFeatureHtml({ name: 'Pin', capacity: 500 });
    expect(out).toContain('capacity');
    expect(out).toContain('500');
  });
});

// ─── odin-outages-fill renderer ──────────────────────────────────────────────

describe('odin-outages-fill renderer', () => {
  it('renders utility rows with google search link when odin_utils present', () => {
    const out = buildPopupHtml('odin-outages-fill', {
      NAME: 'Sample County', STATE_NAME: 'Ohio',
      odin_out: 1234, odin_n: 2,
      odin_utils: [['AEP Ohio', 1000, 1, '2026-07-08T18:55:00+00:00'], ['Duke Energy', 234, 1, null]],
    });
    expect(out).toContain('google.com/search');
    expect(out).toContain('AEP Ohio');
    expect(out).toContain('Duke Energy');
    expect(out).toContain(encodeURIComponent('AEP Ohio power outage map'));
    // No "Since" column: min(start) across a utility's outages is a
    // worst-case time (1 customer out 8h dominates 1000 out 2min).
    expect(out).not.toContain('Since');
    expect(out).toContain('Total customers affected');
  });

  it('escapes HTML in utility name while still encoding the href', () => {
    const out = buildPopupHtml('odin-outages-fill', {
      NAME: 'Sample County', STATE_NAME: 'Ohio',
      odin_out: 100, odin_n: 1,
      odin_utils: [['<script>evil</script>', 100, 1]],
    });
    expect(out).not.toContain('<script>');
    expect(out).toContain('&lt;script&gt;');
    expect(out).toContain(encodeURIComponent('<script>evil</script> power outage map'));
  });

  it('renders county rows without utility breakdown when odin_utils absent', () => {
    const out = buildPopupHtml('odin-outages-fill', {
      NAME: 'Sample County', STATE_NAME: 'Ohio',
      odin_out: 500, odin_n: 3,
    });
    expect(out).toContain('Sample County, Ohio');
    expect(out).toContain('Customers affected');
    expect(out).toContain('500');
    expect(out).toContain('Active incidents');
    expect(out).not.toContain('google.com/search');
  });
});

// ─── buildPopupHtml() ─────────────────────────────────────────────────────────

describe('buildPopupHtml', () => {
  it('routes eia-gen-circles to EIA renderer', () => {
    const out = buildPopupHtml('eia-gen-circles', { plant_name: 'Test Plant', gen_status: 'existing' });
    expect(out).toContain('Test Plant');
  });

  it('routes osm-transmission-lines-hv', () => {
    const out = buildPopupHtml('osm-transmission-lines-hv', { name: 'HV Line', nominal_kv: 345 });
    expect(out).toContain('HV Line');
    expect(out).toContain('345 kV');
  });

  it('routes hifld-transmission-lines-hv with SUB_1/SUB_2', () => {
    const out = buildPopupHtml('hifld-transmission-lines-hv', { SUB_1: 'Alpha', SUB_2: 'Beta', VOLTAGE: 500 });
    expect(out).toContain('Alpha → Beta');
    expect(out).toContain('500 kV');
  });

  it('routes ogf-planned-lines', () => {
    const out = buildPopupHtml('ogf-planned-lines', { Project: 'Horizon Link', Status: '', Link: '' });
    expect(out).toContain('Horizon Link');
  });

  it('routes hifld-natgas-interstate', () => {
    const out = buildPopupHtml('hifld-natgas-interstate', { name: 'Main Line', operator: 'TC Energy', pipe_type: 'interstate' });
    expect(out).toContain('Main Line');
  });

  it('routes nerc-fill', () => {
    const out = buildPopupHtml('nerc-fill', { sub_nm: 'WECC', code: 'WECC', region: 'West', website: '' });
    expect(out).toContain('WECC');
  });

  it('routes ba-fill', () => {
    const out = buildPopupHtml('ba-fill', { name: 'SPP', state: null, tot_cap: 0, peak_ld: 0, year: null, website: '' });
    expect(out).toContain('SPP');
  });

  it('routes user- prefix to user feature renderer', () => {
    const out = buildPopupHtml('user-layer-123', { name: 'Drawn Point' });
    expect(out).toContain('Drawn Point');
  });

  it('returns null for unknown layer', () => {
    expect(buildPopupHtml('unknown-layer', {})).toBeNull();
  });
});
