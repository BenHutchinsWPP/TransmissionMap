// ─── My Data store: the `tm-user-data` payload and its save lifecycle ─────────
// No DOM, no map: storage arrives as a `getItem`/`setItem` adapter, so tests
// run it over an in-memory Map. user-data.ts builds the one production store
// over window.localStorage.
// Payload shape: { userLayers: [{filename, geojson, color, visible}], drawnFeatures }.
// `parsePayload` is a trust boundary: bad JSON yields an empty payload, and a
// malformed layer entry is skipped (console.warn) while the rest load.
// Lifecycle: a save before `load()` has read the stored payload is held back,
// so it cannot overwrite data not yet read; `load()` hands the payload to its
// restore callback, then flushes a held-back save once, from a fresh snapshot,
// so the stored data and the earlier edits are written together. A failed read
// still flushes. A failed write goes to `onError`.
// Also keeps the last-known drawn features: a snapshot without drawings (the
// lazy draw chunk not loaded yet) saves these instead of wiping them.
// Deps: none.

export interface StoredLayer {
  filename: string;
  geojson: GeoJSON.FeatureCollection;
  color?: string;
  visible: boolean;
}

export interface UserDataPayload {
  layers: StoredLayer[];
  drawn: GeoJSON.FeatureCollection;
}

const emptyFC = (): GeoJSON.FeatureCollection => ({ type: 'FeatureCollection', features: [] });

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isFeatureCollection(v: unknown): v is GeoJSON.FeatureCollection {
  return isObject(v) && v.type === 'FeatureCollection' && Array.isArray(v.features);
}

function parseLayer(l: unknown): StoredLayer | null {
  if (!isObject(l) || typeof l.filename !== 'string' || !isFeatureCollection(l.geojson)) return null;
  if (l.color !== undefined && typeof l.color !== 'string') return null;
  if (l.visible !== undefined && typeof l.visible !== 'boolean') return null;
  return {
    filename: l.filename,
    geojson: l.geojson,
    color: l.color,
    visible: l.visible ?? true,
  };
}

export function parsePayload(raw: string | null): UserDataPayload {
  if (!raw) return { layers: [], drawn: emptyFC() };
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch (e: unknown) {
    console.warn('[TransmissionMap] user data parse failed:', (e as Error).message);
    return { layers: [], drawn: emptyFC() };
  }
  if (!isObject(payload)) {
    console.warn('[TransmissionMap] user data payload is not an object; ignored');
    return { layers: [], drawn: emptyFC() };
  }

  const layers: StoredLayer[] = [];
  const rawLayers = payload.userLayers ?? [];
  if (Array.isArray(rawLayers)) {
    for (const l of rawLayers) {
      const layer = parseLayer(l);
      if (layer) layers.push(layer);
      else console.warn('[TransmissionMap] skipped a malformed stored layer:', l);
    }
  } else {
    console.warn('[TransmissionMap] stored userLayers is not an array; ignored');
  }

  let drawn = emptyFC();
  if (isFeatureCollection(payload.drawnFeatures)) drawn = payload.drawnFeatures;
  else if (payload.drawnFeatures !== undefined) {
    console.warn('[TransmissionMap] stored drawnFeatures is not a FeatureCollection; ignored');
  }
  return { layers, drawn };
}

export function serializePayload(layers: readonly StoredLayer[], drawn: GeoJSON.FeatureCollection): string {
  return JSON.stringify({
    userLayers: layers.map(l => ({
      filename: l.filename,
      geojson:  l.geojson,
      color:    l.color,
      visible:  l.visible,
    })),
    drawnFeatures: drawn,
  });
}

export const STORAGE_KEY = 'tm-user-data';

// What a save writes; `drawn: null` means drawings are not loaded yet.
export interface UserDataSnapshot {
  layers: readonly StoredLayer[];
  drawn: GeoJSON.FeatureCollection | null;
}

export interface UserDataStore {
  // Reads the stored payload (once read, saves write through), hands it to
  // `restore`, then flushes a save held back before the read.
  load(restore: (payload: UserDataPayload) => void): void;
  // Writes the current snapshot, or holds it back until `load()` has run.
  save(): void;
  // The last-known drawn features (stored, or from the latest save).
  drawn(): GeoJSON.FeatureCollection;
}

export function createUserDataStore(
  storage: Pick<Storage, 'getItem' | 'setItem'>,
  snapshot: () => UserDataSnapshot,
  onError: (e: unknown) => void = () => {},
): UserDataStore {
  let read = false;
  let pending = false;
  let drawn = emptyFC();

  function save() {
    if (!read) { pending = true; return; }
    try {
      const snap = snapshot();
      if (snap.drawn) drawn = snap.drawn;
      storage.setItem(STORAGE_KEY, serializePayload(snap.layers, drawn));
    } catch (e: unknown) {
      console.warn('[TransmissionMap] saveUserData failed:', (e as Error).message);
      onError(e);
    }
  }

  function load(restore: (payload: UserDataPayload) => void) {
    read = true;
    const held = pending;
    pending = false;
    let raw: string | null = null;
    let ok = true;
    try {
      raw = storage.getItem(STORAGE_KEY);
    } catch (e: unknown) {
      console.warn('[TransmissionMap] loadUserData read failed:', (e as Error).message);
      ok = false;
    }
    if (ok) {
      const payload = parsePayload(raw);
      drawn = payload.drawn;
      restore(payload);
    }
    if (held) save();
  }

  return { load, save, drawn: () => drawn };
}
