// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  DIAG_CHECKS, DIAG_ENV, PROBE_TIMEOUT_MS,
  fetchProbe, imgProbe, runDiagnostics, buildDiagReport,
  type DiagCheck, type DiagResult,
} from './diagnostics.js';
import { recordDiagEvent, clearDiagLog } from './diag-log.js';

// live-staleness.ts (fmtAge/feedIssue) and nws-staleness.ts pull the map,
// registry and layer-init chains behind them; the diagnostics logic needs
// neither at runtime.
vi.mock('./visibility.js', () => ({ setLayerVisibility: vi.fn() }));
vi.mock('./ui/ui-legends.js', () => ({ updateLegends: vi.fn() }));
vi.mock('./nws-zone-join.js', () => ({
  pruneExpiredZoneAlerts: vi.fn(),
  clearZoneAlerts: vi.fn(),
  refetchZoneAlerts: vi.fn(),
}));

// ODIN and weather hold their own snapshot; these stand in for it so the
// freshness branches are testable without a loaded map.
const freshness = vi.hoisted(() => ({
  odin:    { ageMs: null as number | null, maxAgeMs: 6 * 60 * 60_000 },
  weather: { ageMs: null as number | null, maxAgeMs: 12 * 60 * 60_000 },
}));
vi.mock('./odin-outages.js', () => ({ odinFreshness: () => freshness.odin }));
vi.mock('./weather-live.js', () => ({ weatherFreshness: () => freshness.weather }));

// The geocoder check short-circuits to `skip` without a key.
vi.mock('./constants.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./constants.js')>()),
  ESRI_TOKEN: 'test-token',
}));

const byId = (id: string): DiagCheck => {
  const c = DIAG_CHECKS.find(x => x.id === id);
  if (!c) throw new Error(`no diagnostics check with id "${id}"`);
  return c;
};

// Minimal Response stand-ins — the checks only read ok/status/headers/body.
function fakeResponse(init: {
  ok?: boolean;
  status?: number;
  headers?: Record<string, string>;
  body?: unknown;
  json?: () => Promise<unknown>;
}): Response {
  const status = init.status ?? 200;
  return {
    ok: init.ok ?? (status >= 200 && status < 300),
    status,
    headers: { get: (k: string) => init.headers?.[k] ?? null },
    body: init.body ?? { cancel: vi.fn(() => Promise.resolve()) },
    json: init.json ?? (async () => ({})),
  } as unknown as Response;
}

function gzipBody(bytes: number[]) {
  let sent = false;
  return {
    cancel: vi.fn(() => Promise.resolve()),
    getReader: () => ({
      read: async () => {
        if (sent) return { value: undefined, done: true };
        sent = true;
        return { value: new Uint8Array(bytes), done: false };
      },
      cancel: vi.fn(() => Promise.resolve()),
    }),
  };
}

// Resolves imgProbe through onerror on the next microtask, so no test ever
// waits on the real 5 s timer.
class FailingImage {
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  set src(_v: string) { queueMicrotask(() => this.onerror?.()); }
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  clearDiagLog();
});

describe('DIAG_ENV', () => {
  it('names the build the probes ran against', () => {
    expect(['production', 'dev']).toContain(DIAG_ENV);
  });
});

describe('fetchProbe', () => {
  it('resolves rather than hanging when the request outlives the timeout, and reports it as a timeout', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal!.addEventListener('abort', () => {
        const err = new Error('aborted');
        err.name = 'AbortError';
        reject(err);
      });
    })));

    const pending = fetchProbe('https://example.com/slow');
    await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS);
    const r = await pending;

    expect(r.response).toBeNull();
    expect(r.detail).toMatch(/timed out/i);
  });

  it('reports a TypeError distinctly from a timeout, without naming a cause', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));

    const r = await fetchProbe('https://example.com/blocked');

    expect(r.response).toBeNull();
    expect(r.detail).not.toMatch(/timed out/i);
    // The wording must keep block / down / CORS as indistinguishable options.
    expect(r.detail).toMatch(/could not connect/i);
    expect(r.detail).toMatch(/can't tell these apart/i);
  });

  it('hands back the response and status when the host answers', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse({ status: 404 })));

    const r = await fetchProbe('https://example.com/missing');

    expect(r.response).not.toBeNull();
    expect(r.status).toBe(404);
    expect(r.detail).toMatch(/HTTP 404/);
  });
});

describe('imgProbe', () => {
  it('resolves on an image error instead of throwing', async () => {
    vi.stubGlobal('Image', FailingImage);
    const r = await imgProbe('https://tiles.example.com/4/3/6.png');
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/could not connect/i);
  });

  it('resolves ok when the image loads', async () => {
    class LoadingImage {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(_v: string) { queueMicrotask(() => this.onload?.()); }
    }
    vi.stubGlobal('Image', LoadingImage);
    const r = await imgProbe('https://tiles.example.com/4/3/6.png');
    expect(r.ok).toBe(true);
  });
});

describe('pmtiles-range check', () => {
  it('accepts a 206 partial response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse({ status: 206 })));
    const r = await byId('pmtiles-range').run();
    expect(r.status).toBe('ok');
    expect(r.detail).toMatch(/206/);
  });

  it('flags a 200 full-body response as the Range-stripped case and names the symptom', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse({ status: 200 })));
    const r = await byId('pmtiles-range').run();
    expect(r.status).toBe('fail');
    expect(r.detail).toMatch(/whole file/i);
    expect(r.detail).toMatch(/Range/);
    expect(r.detail).toMatch(/GeoJSON/i);
  });

  it('sends the Range request header', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect((init?.headers as Record<string, string>).Range).toBe('bytes=0-127');
      return fakeResponse({ status: 206 });
    });
    vi.stubGlobal('fetch', fetchMock);
    await byId('pmtiles-range').run();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('reports a connection failure without claiming a cause', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    const r = await byId('pmtiles-range').run();
    expect(r.status).toBe('fail');
    expect(r.detail).toMatch(/can't tell these apart/i);
  });
});

describe('gzip-integrity check', () => {
  it('accepts a body starting with the gzip magic 1f 8b', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse({ body: gzipBody([0x1f, 0x8b, 0x08, 0x00]) })));
    const r = await byId('gzip-integrity').run();
    expect(r.status).toBe('ok');
  });

  it('flags a body that does not start with the gzip magic', async () => {
    // '{' — what a transparently decompressed .geojson.gz would start with.
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse({ body: gzipBody([0x7b, 0x22, 0x74, 0x79]) })));
    const r = await byId('gzip-integrity').run();
    expect(r.status).toBe('fail');
    expect(r.detail).toMatch(/7b 22/);
    expect(r.detail).toMatch(/1f 8b/);
  });

  it('reads only the leading chunk and cancels the stream', async () => {
    const body = gzipBody([0x1f, 0x8b]);
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse({ body })));
    const readerSpy = vi.spyOn(body, 'getReader');
    await byId('gzip-integrity').run();
    const reader = readerSpy.mock.results[0].value as { cancel: ReturnType<typeof vi.fn> };
    expect(reader.cancel).toHaveBeenCalled();
  });

  it('flags a non-ok response instead of reading a body', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse({ status: 403 })));
    const r = await byId('gzip-integrity').run();
    expect(r.status).toBe('fail');
    expect(r.detail).toMatch(/HTTP 403/);
  });
});

describe('geocoder check', () => {
  it('warns when the service answers but rejects the key', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse({
      json: async () => ({ error: { code: 498, message: 'Invalid Token' } }),
    })));
    const r = await byId('geocoder').run();
    // Reachable, so not a fail — but place search is broken, so not an ok.
    expect(r.status).toBe('warn');
    expect(r.detail).toMatch(/498/);
    expect(r.detail).toMatch(/Invalid Token/);
  });

  it('passes when the service returns candidates', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse({
      json: async () => ({ candidates: [{ address: 'Denver, CO' }] }),
    })));
    expect((await byId('geocoder').run()).status).toBe('ok');
  });
});

describe('snapshot freshness checks (ODIN, weather)', () => {
  it('skips a feed that has not loaded this session', async () => {
    freshness.odin = { ageMs: null, maxAgeMs: 6 * 60 * 60_000 };
    expect((await byId('odin-outages').run()).status).toBe('skip');
  });

  it('passes a snapshot inside its cutoff', async () => {
    freshness.odin = { ageMs: 60_000, maxAgeMs: 6 * 60 * 60_000 };
    expect((await byId('odin-outages').run()).status).toBe('ok');
  });

  it('fails a snapshot past the cutoff the owning module set', async () => {
    freshness.weather = { ageMs: 13 * 60 * 60_000, maxAgeMs: 12 * 60 * 60_000 };
    const r = await byId('weather-live').run();
    expect(r.status).toBe('fail');
    expect(r.detail).toMatch(/cutoff/);
  });
});

describe('runDiagnostics', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    vi.stubGlobal('Image', FailingImage);
  });

  it('turns a check that throws into a fail result instead of rejecting the run', async () => {
    const exploding: DiagCheck = {
      id: 'exploding-check',
      label: 'Exploding check',
      group: 'capability',
      run: async () => { throw new Error('boom'); },
    };
    DIAG_CHECKS.push(exploding);
    try {
      const seen: DiagResult[] = [];
      const results = await runDiagnostics(r => seen.push(r));

      const row = results.find(r => r.id === 'exploding-check')!;
      expect(row.status).toBe('fail');
      expect(row.detail).toMatch(/boom/);
      expect(row.label).toBe('Exploding check');
      expect(seen).toHaveLength(DIAG_CHECKS.length);
      expect(results).toHaveLength(DIAG_CHECKS.length);
    } finally {
      DIAG_CHECKS.pop();
    }
  });

  it('streams every check to onResult and returns them in catalogue order', async () => {
    const seen: DiagResult[] = [];
    const results = await runDiagnostics(r => seen.push(r));

    expect(results.map(r => r.id)).toEqual(DIAG_CHECKS.map(c => c.id));
    expect(seen).toHaveLength(DIAG_CHECKS.length);
    expect(results.every(r => ['ok', 'warn', 'fail', 'skip'].includes(r.status))).toBe(true);
  });

  it('reports optional hosts as warn, not fail, when they do not answer', async () => {
    const results = await runDiagnostics(() => {});
    const optional = results.filter(r => r.group === 'optional');
    expect(optional.length).toBeGreaterThan(0);
    expect(optional.every(r => r.status !== 'fail')).toBe(true);
  });
});

describe('buildDiagReport', () => {
  const results: DiagResult[] = [
    { id: 'webgl2', label: 'WebGL2 rendering', group: 'capability', status: 'ok', detail: 'available' },
    {
      id: 'esri-aerial', label: 'Esri aerial imagery', group: 'optional', status: 'warn',
      detail: 'https://ibasemaps-api.arcgis.com/tile/4/6/3?token=SUPERSECRETKEY — no tile',
    },
  ];

  it('redacts an Esri token from a probe URL', () => {
    const report = buildDiagReport(results);
    expect(report).not.toContain('SUPERSECRETKEY');
    expect(report).toContain('token=REDACTED');
  });

  it('never emits token=undefined in the keyless case', () => {
    const report = buildDiagReport([
      { id: 'esri-aerial', label: 'Esri aerial imagery', group: 'optional', status: 'warn',
        detail: 'https://example.com/tile?token=undefined&f=json — no tile' },
    ]);
    expect(report).not.toContain('token=undefined');
    expect(report).toContain('token=REDACTED');
    expect(report).toContain('f=json');
  });

  it('redacts tokens inside recorded runtime errors too', () => {
    recordDiagEvent('layer', 'load failed https://host/x?token=LEAKYVALUE');
    const report = buildDiagReport(results);
    expect(report).not.toContain('LEAKYVALUE');
    expect(report).toContain('[layer]');
  });

  it('includes the environment, user agent, and every result grouped', () => {
    const report = buildDiagReport(results);
    expect(report).toContain(`Build: ${DIAG_ENV}`);
    expect(report).toContain(navigator.userAgent);
    expect(report).toContain('Browser capabilities');
    expect(report).toContain('Optional hosts');
    expect(report).toContain('WebGL2 rendering');
    expect(report).toContain('[WARN]');
  });

  it('notes when no runtime errors were recorded', () => {
    expect(buildDiagReport(results)).toContain('none recorded this session');
  });
});
