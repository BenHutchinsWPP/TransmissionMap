// Role: small aviation observation fixture for Crossings, CSV and print tests.
// Deps: route/screening.ts types only. No production imports.
import type { RouteScreening } from '../route/screening.js';

export function observationFixture(): RouteScreening {
  const provenance = { source: 'https://source.example.test/', sha256: 'a'.repeat(64), fetchedAt: '2026-10-31', credit: 'Example source', license: 'CC BY 4.0' };
  return {
    aviation: { status: 'ok', cycle: '2026/10/01', scope: 'FAA NTAD airports and runways within 10 km of the route', provenance,
      facilities: [{ id: 'RNO', name: '=SUM(1,2)', type: 'A', use: 'PU', operationalStatus: 'O', distanceM: 200, runwayCoverage: 'sampled' },
        { id: 'NV57', name: '<img src=x onerror=alert(1)>', type: 'H', use: 'PR', operationalStatus: 'O', distanceM: 100, runwayCoverage: 'not-queried' }],
      runways: [{ airport: 'RNO', runway: '08/26', centrelineM: 50, endM: 75, airportPointM: 200, elevationsFt: [4000, 4001], surveyDates: ['2014/10/08', null] }] },
  };
}
