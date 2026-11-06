// service-hosts.ts: exact-host vetting, segment-boundary path prefixes, and
// every look-alike that must stay unvetted.
import { describe, it, expect } from 'vitest';
import { isVetted } from './service-hosts.js';
import VETTED from '../../src/registry/service-hosts.json';

const WIND = 'https://services.arcgis.com/P3ePLMYs2RVChkJx/arcgis/rest/services/US_Wind_Turbine_Database/FeatureServer';

describe('isVetted', () => {
  it('the list is lower-case hosts or host/path entries', () => {
    for (const e of VETTED as string[]) expect(e).toMatch(/^[a-z0-9.-]+(\/[^?#\s]+)?$/i);
  });

  it.each([
    'https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer',
    'https://HAZARDS.FEMA.GOV/arcgis/rest/services/public/NFHL/MapServer/28/query?f=geojson',
    'https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/State_County/MapServer',
    'https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/{z}/{y}/{x}',
    WIND,
    WIND + '/0',
    WIND + '/0/query?where=1%3D1',
    WIND.replace('/arcgis/rest/services', '/ArcGIS/rest/services'),
    WIND.toLowerCase(),
    'https://hazards.fema.gov:443/arcgis/rest/services/public/NFHL/MapServer',
  ])('vets %s', url => {
    expect(isVetted(url)).toBe(true);
  });

  it.each([
    ['http, not https', 'http://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer'],
    ['suffix look-alike', 'https://evil-hazards.fema.gov.example/x.geojson'],
    ['prefix look-alike host', 'https://evil-arcgis.com/arcgis/rest/services/A/FeatureServer'],
    ['vetted host as a subdomain of another', 'https://hazards.fema.gov.evil.net/arcgis/rest/services/A/MapServer'],
    ['subdomain of a vetted host', 'https://x.hazards.fema.gov/a.geojson'],
    ['userinfo naming a vetted host', 'https://hazards.fema.gov@evil.net/arcgis/rest/services/A/MapServer'],
    ['userinfo on a vetted host', 'https://user@hazards.fema.gov/arcgis/rest/services/A/MapServer'],
    ['shared host outside the vetted service', 'https://services.arcgis.com/P3ePLMYs2RVChkJx/arcgis/rest/services/Other/FeatureServer/0'],
    ['segment boundary /abc vs /abcd', WIND.replace('Database/FeatureServer', 'Database/FeatureServerX')],
    ['segment boundary on the service name', WIND.replace('US_Wind_Turbine_Database', 'US_Wind_Turbine_Database2')],
    ['another org on the shared host', 'https://services.arcgis.com/EVILORG/arcgis/rest/services/US_Wind_Turbine_Database/FeatureServer'],
    ['%2e in the path', 'https://services.arcgis.com/P3ePLMYs2RVChkJx/arcgis/rest/services/US_Wind_Turbine_Database/FeatureServer/%2e%2e/%2e%2e/Other/FeatureServer'],
    ['%2f in the path', 'https://services.arcgis.com/P3ePLMYs2RVChkJx/arcgis/rest/services/US_Wind_Turbine_Database%2fFeatureServer'],
    ['%2E upper-case', 'https://hazards.fema.gov/a/%2E%2E/b.geojson'],
    ['%2f split by a tab', WIND + '/%2\tf..%2\tfOther'],
    ['%2f split by a line break', WIND + '/%2\nf..%2\r\nfOther'],
    ['a tab anywhere', 'https://hazards.fema.gov/arcgis/rest/services/public/NFHL/Map\tServer'],
    ['%5c in the path', 'https://hazards.fema.gov/a%5c..%5cb.geojson'],
    ['a port', 'https://hazards.fema.gov:8443/arcgis/rest/services/public/NFHL/MapServer'],
    ['a port on the shared host', WIND.replace('services.arcgis.com', 'services.arcgis.com:8443')],
    ['a token param', WIND + '/0/query?token=abc'],
    ['an unsniffable path', 'https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer//0'],
    ['not a URL', 'hazards.fema.gov'],
    ['empty', ''],
  ])('refuses %s', (_, url) => {
    expect(isVetted(url)).toBe(false);
  });

  it('passes a kind hint through for a path that cannot tell', () => {
    expect(isVetted('https://hazards.fema.gov/some/endpoint')).toBe(false);
    expect(isVetted('https://hazards.fema.gov/some/endpoint', 'wms')).toBe(true);
  });
});
