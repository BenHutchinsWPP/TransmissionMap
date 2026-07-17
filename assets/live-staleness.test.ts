// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fmtAge, fmtAgeShort, initLiveStaleness } from './live-staleness.js';
import { state } from './state.js';

vi.mock('./visibility.js', () => ({
  setLayerVisibility: vi.fn((id: string, on: boolean) => { state.layerVisibility[id] = on; }),
}));
vi.mock('./ui/ui-legends.js', () => ({
  updateLegends: vi.fn(),
}));

// jsdom's HTMLDialogElement doesn't implement showModal/close — stub them.
if (!HTMLDialogElement.prototype.showModal) {
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) { this.open = true; };
}
if (!HTMLDialogElement.prototype.close) {
  HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) { this.open = false; };
}

let seq = 0;
function uniqueKey(): string {
  seq += 1;
  return `test-src-${seq}`;
}

interface Setup {
  sourceKey: string;
  layerId: string;
  dialogId: string;
  ageElId: string;
  reenableId: string;
  dismissId: string;
  src: { setData: ReturnType<typeof vi.fn> };
  refreshMs: number;
  maxAgeMs: number;
  init: (extra?: Partial<Parameters<typeof initLiveStaleness>[0]>) => void;
}

function setupTest(): Setup {
  const sourceKey = uniqueKey();
  const layerId = `${sourceKey}-layer`;
  const dialogId = `${sourceKey}-dlg`;
  const ageElId = `${sourceKey}-age`;
  const reenableId = `${sourceKey}-re`;
  const dismissId = `${sourceKey}-dis`;

  document.body.innerHTML =
    `<dialog id="${dialogId}"><span id="${ageElId}"></span>` +
    `<button id="${reenableId}"></button><button id="${dismissId}"></button></dialog>` +
    `<input type="checkbox" data-layer-id="${layerId}">`;

  state.layerVisibility = { [layerId]: true };
  state.sourcesData = {};
  state.liveFcMeta = {};

  const src = { setData: vi.fn() };
  state.map = { getSource: vi.fn(() => src) } as unknown as typeof state.map;

  const refreshMs = 15 * 60_000;
  const maxAgeMs = 6 * 60 * 60_000;

  const init = (extra?: Partial<Parameters<typeof initLiveStaleness>[0]>) => {
    initLiveStaleness({
      sourceKey,
      layerIds: [layerId],
      dataUrl: () => 'https://example.com/feed.json',
      refreshMs,
      maxAgeMs,
      dialogId,
      ageElId,
      reenableId,
      dismissId,
      ...extra,
    });
  };

  return { sourceKey, layerId, dialogId, ageElId, reenableId, dismissId, src, refreshMs, maxAgeMs, init };
}

function fireLayerData(sourceKey: string) {
  window.dispatchEvent(new CustomEvent('tm:layerdata', { detail: { registryId: sourceKey } }));
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-07-16T12:00:00Z'));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('fmtAge', () => {
  it('renders minutes only under an hour', () => {
    expect(fmtAge(42 * 60_000)).toBe('42m');
  });
  it('renders hours + minutes', () => {
    expect(fmtAge((3 * 60 + 5) * 60_000)).toBe('3h 5m');
  });
  it('renders days + hours past 24h', () => {
    expect(fmtAge(49 * 60 * 60_000)).toBe('2d 1h');
  });
});

describe('fmtAgeShort', () => {
  it('renders minutes under an hour', () => {
    expect(fmtAgeShort(42 * 60_000)).toBe('42m');
  });
  it('rounds up to hours', () => {
    expect(fmtAgeShort(90 * 60_000)).toBe('2h');
  });
  it('rounds to days past 24h', () => {
    expect(fmtAgeShort(25 * 60 * 60_000)).toBe('1d');
  });
});

describe('staleness gate', () => {
  it('fresh data: no layers disabled, modal stays closed', () => {
    const t = setupTest();
    t.init();
    state.sourcesData[t.sourceKey] = [
      { type: 'Feature', properties: { generated_utc: new Date().toISOString() }, geometry: null } as unknown as GeoJSON.Feature,
    ];
    fireLayerData(t.sourceKey);

    expect(state.layerVisibility[t.layerId]).toBe(true);
    const dlg = document.getElementById(t.dialogId) as HTMLDialogElement;
    expect(dlg.open).toBeFalsy();
  });

  it('stale data with a visible layer disables it and opens the modal', () => {
    const t = setupTest();
    t.init();
    const old = new Date(Date.now() - 7 * 60 * 60_000).toISOString();
    state.sourcesData[t.sourceKey] = [
      { type: 'Feature', properties: { generated_utc: old }, geometry: null } as unknown as GeoJSON.Feature,
    ];
    fireLayerData(t.sourceKey);

    expect(state.layerVisibility[t.layerId]).toBe(false);
    const dlg = document.getElementById(t.dialogId) as HTMLDialogElement;
    expect(dlg.open).toBe(true);
    expect(document.getElementById(t.ageElId)!.textContent).toMatch(/h/);
  });

  it('stale data with no visible layers disables nothing and does not open the modal', () => {
    const t = setupTest();
    state.layerVisibility[t.layerId] = false;
    t.init();
    const old = new Date(Date.now() - 7 * 60 * 60_000).toISOString();
    state.sourcesData[t.sourceKey] = [
      { type: 'Feature', properties: { generated_utc: old }, geometry: null } as unknown as GeoJSON.Feature,
    ];
    fireLayerData(t.sourceKey);

    const dlg = document.getElementById(t.dialogId) as HTMLDialogElement;
    expect(dlg.open).toBeFalsy();
  });

  it('re-enable button restores layers, closes modal, and suppresses re-prompting on the next stale tick', () => {
    const t = setupTest();
    t.init();
    const old = new Date(Date.now() - 7 * 60 * 60_000).toISOString();
    state.sourcesData[t.sourceKey] = [
      { type: 'Feature', properties: { generated_utc: old }, geometry: null } as unknown as GeoJSON.Feature,
    ];
    fireLayerData(t.sourceKey);
    expect(state.layerVisibility[t.layerId]).toBe(false);

    document.getElementById(t.reenableId)!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(state.layerVisibility[t.layerId]).toBe(true);
    const dlg = document.getElementById(t.dialogId) as HTMLDialogElement;
    expect(dlg.open).toBe(false);

    // Manually re-hide to observe whether a subsequent stale tick reopens the modal.
    state.layerVisibility[t.layerId] = true;
    fireLayerData(t.sourceKey);
    expect(dlg.open).toBe(false); // acknowledged suppression — modal does not reopen
  });

  it('falls back to liveFcMeta.generated_utc when features are empty', () => {
    const t = setupTest();
    t.init();
    state.sourcesData[t.sourceKey] = [];
    state.liveFcMeta[t.sourceKey] = { generated_utc: new Date(Date.now() - 7 * 60 * 60_000).toISOString() };
    fireLayerData(t.sourceKey);

    expect(state.layerVisibility[t.layerId]).toBe(false);
    const dlg = document.getElementById(t.dialogId) as HTMLDialogElement;
    expect(dlg.open).toBe(true);
  });
});

describe('refetchLive (via the refresh-interval timer)', () => {
  it('successful fetch with a newer generated_utc calls setData, updates state, and dispatches tm:layerdata', async () => {
    const t = setupTest();
    const initial = new Date(Date.now() - 30 * 60_000).toISOString();
    state.sourcesData[t.sourceKey] = [
      { type: 'Feature', properties: { generated_utc: initial }, geometry: null } as unknown as GeoJSON.Feature,
    ];
    const newer = new Date().toISOString();
    const payload = {
      type: 'FeatureCollection',
      generated_utc: newer,
      features: [{ type: 'Feature', properties: { generated_utc: newer }, geometry: null }],
    };
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => payload }));
    vi.stubGlobal('fetch', fetchMock);

    const dispatchSpy = vi.fn();
    window.addEventListener('tm:layerdata', dispatchSpy);

    t.init();
    await vi.advanceTimersByTimeAsync(t.refreshMs);

    expect(t.src.setData).toHaveBeenCalledTimes(1);
    expect(state.sourcesData[t.sourceKey]).toEqual(payload.features);
    expect(state.liveFcMeta[t.sourceKey]?.generated_utc).toBe(newer);
    expect(dispatchSpy).toHaveBeenCalled();

    window.removeEventListener('tm:layerdata', dispatchSpy);
  });

  it('monotonic dedupe: a non-newer generated_utc does not call setData', async () => {
    const t = setupTest();
    const now = new Date().toISOString();
    state.sourcesData[t.sourceKey] = [
      { type: 'Feature', properties: { generated_utc: now }, geometry: null } as unknown as GeoJSON.Feature,
    ];
    const payload = {
      type: 'FeatureCollection',
      generated_utc: now,
      features: [{ type: 'Feature', properties: { generated_utc: now }, geometry: null }],
    };
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => payload })));

    t.init();
    await vi.advanceTimersByTimeAsync(t.refreshMs);

    expect(t.src.setData).not.toHaveBeenCalled();
  });

  it('a rejected fetch does not throw and leaves prior sourcesData intact', async () => {
    const t = setupTest();
    const initialFeatures = [
      { type: 'Feature', properties: { generated_utc: new Date().toISOString() }, geometry: null } as unknown as GeoJSON.Feature,
    ];
    state.sourcesData[t.sourceKey] = initialFeatures;
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down'); }));

    t.init();
    await expect(vi.advanceTimersByTimeAsync(t.refreshMs)).resolves.not.toThrow();

    expect(t.src.setData).not.toHaveBeenCalled();
    expect(state.sourcesData[t.sourceKey]).toBe(initialFeatures);
  });

  it('pruneExpired drops features before setData and sourcesData reflects the pruned list', async () => {
    const t = setupTest();
    const initial = new Date(Date.now() - 30 * 60_000).toISOString();
    state.sourcesData[t.sourceKey] = [
      { type: 'Feature', properties: { generated_utc: initial }, geometry: null } as unknown as GeoJSON.Feature,
    ];
    const newer = new Date().toISOString();
    const payload = {
      type: 'FeatureCollection',
      generated_utc: newer,
      features: [
        { type: 'Feature', properties: { generated_utc: newer, keep: true }, geometry: null },
        { type: 'Feature', properties: { generated_utc: newer, keep: false }, geometry: null },
      ],
    };
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => payload })));

    const pruneExpired = (features: GeoJSON.Feature[]) =>
      features.filter(f => (f.properties as { keep?: boolean })?.keep !== false);

    t.init({ pruneExpired });
    await vi.advanceTimersByTimeAsync(t.refreshMs);

    expect(state.sourcesData[t.sourceKey]).toHaveLength(1);
    const setDataArg = t.src.setData.mock.calls[0][0] as { features: GeoJSON.Feature[] };
    expect(setDataArg.features).toHaveLength(1);
  });
});

describe('DOM-id drift-guard', () => {
  // Ids mirrored from the config shells (not imported — importing them pulls
  // their full dependency chain). Keep these in sync with:
  //   assets/wildfire-staleness.ts (dialogId/ageElId/reenableId/dismissId)
  //   assets/nws-staleness.ts      (dialogId/ageElId/reenableId/dismissId, + nwsStaleReenable listener)
  const expectedIds = [
    'wildfireStaleDialog', 'wildfireStaleAge', 'wildfireStaleReenable', 'wildfireStaleDismiss',
    'nwsStaleDialog', 'nwsStaleAge', 'nwsStaleReenable', 'nwsStaleDismiss',
  ];

  it('every id referenced by the wildfire/nws staleness config shells exists in index.html', () => {
    const html = readFileSync(join(process.cwd(), 'index.html'), 'utf8');
    for (const id of expectedIds) {
      expect(html.includes(`id="${id}"`), `missing id="${id}" in index.html`).toBe(true);
    }
  });
});
