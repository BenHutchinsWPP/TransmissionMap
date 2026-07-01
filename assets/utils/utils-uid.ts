// ─── Feature UID helpers ───────────────────────────────────────────────────────

let _clientUidCounter = 0;

function createClientUid(prefix = "uid") {
  const cryptoObj = globalThis.crypto;
  if (cryptoObj?.randomUUID) return cryptoObj.randomUUID();

  if (cryptoObj?.getRandomValues) {
    const bytes = new Uint8Array(16);
    cryptoObj.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, b => b.toString(16).padStart(2, "0"));
    return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
  }

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
