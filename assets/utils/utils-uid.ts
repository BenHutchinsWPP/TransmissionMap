// ─── Feature UID helpers ───────────────────────────────────────────────────────

let _clientUidCounter = 0;

function createClientUid(prefix = "uid") {
  // Only ever used as an opaque key; randomUUID needs a secure context, so
  // keep a plain counter fallback for http-over-LAN.
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  _clientUidCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${_clientUidCounter.toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function ensureFeatureUid(feature: GeoJSON.Feature, prefix = "feature") {
  const props = feature.properties ?? {};
  const existing = feature.id ?? props.__uid;
  const uid = existing != null && String(existing) !== ""
    ? String(existing)
    : createClientUid(prefix);
  feature.properties = props;
  feature.properties.__uid = uid;
  return uid;
}

export function ensureGeoJsonFeatureUids(geojson: GeoJSON.GeoJSON, prefix = "feature") {
  if (geojson.type === "Feature") {
    ensureFeatureUid(geojson as GeoJSON.Feature, prefix);
  } else if (geojson.type === "FeatureCollection") {
    (geojson as GeoJSON.FeatureCollection).features.forEach((feature, index) =>
      ensureFeatureUid(feature, `${prefix}-${index + 1}`));
  }
  return geojson;
}
