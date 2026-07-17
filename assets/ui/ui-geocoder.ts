// ─── Geocoder (Esri place / address search) ──────────────────────────────────
// Role: the place-search box. Queries the ArcGIS World Geocoding Service
//       (findAddressCandidates, temporary results — no forStorage) using the
//       same VITE_ESRI_API_KEY as the aerial basemap; replaced Nominatim,
//       whose usage policy a browser cannot satisfy (User-Agent is a
//       forbidden fetch header). Search fires on Enter only — every request
//       costs a metered geocode, and the 20k/month free tier is plenty for
//       explicit searches but not for per-keystroke autocomplete.
// Deps: state (map, draw), constants (ESRI_TOKEN), utils (escapeHtml),
//       user-data (pin + My Data refresh). DOM: #geocoderInput/#geocoderResults.

import { state } from '../state.js';
import { ESRI_TOKEN } from '../constants.js';
import { escapeHtml } from '../utils/utils.js';
import { renderMyDataTab, saveUserData } from '../user-data/user-data.js';

interface EsriCandidate {
  address: string;                                              // "Yosemite National Park, CA, USA"
  location: { x: number; y: number };                           // lon, lat (WGS84)
  extent?: { xmin: number; ymin: number; xmax: number; ymax: number };
}

// "Name, City, State" → ["Name", "City, State"] for the two-line result row.
function splitLabel(address: string): [string, string] {
  const parts = address.split(",");
  return [parts[0].trim(), parts.slice(1, 3).join(",").trim()];
}

async function placeGeocoderPin(label: string, lon: number, lat: number) {
  if (!state.draw) {
    const chunk = await import('../user-data/draw-chunk.js');
    if (!state.draw) chunk.initDraw();
  }
  const draw = state.draw!;
  const ids = draw.add({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [lon, lat] },
    properties: { name: label },
  } as GeoJSON.Feature);
  if (ids[0]) draw.setFeatureProperty(ids[0], 'color', state.drawDefaultColor);
  draw.set(draw.getAll());
  renderMyDataTab();
  saveUserData();
}

export function wireGeocoder() {
  const geocoderInput   = document.getElementById("geocoderInput") as HTMLInputElement | null;
  const geocoderResults = document.getElementById("geocoderResults");
  if (!geocoderInput || !geocoderResults) return;

  let geocoderAbort: AbortController | null = null;

  async function geocodeSearch(q: string) {
    const query = q.trim();
    if (!query || query.length < 2) { hideGeocoderResults(); return; }
    if (!ESRI_TOKEN) { console.warn("Geocoder disabled: VITE_ESRI_API_KEY not set"); return; }
    try {
      if (geocoderAbort) geocoderAbort.abort();
      geocoderAbort = new AbortController();
      const params = new URLSearchParams({
        f: "json",
        singleLine: query,
        maxLocations: "5",
        token: ESRI_TOKEN,
      });
      const res = await fetch(
        `https://geocode-api.arcgis.com/arcgis/rest/services/World/GeocodeServer/findAddressCandidates?${params}`,
        { signal: geocoderAbort!.signal }
      );
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const data = await res.json();
      if (data.error) throw new Error(data.error.message || "geocode error");
      showGeocoderResults((data.candidates ?? []) as EsriCandidate[]);
    } catch (err: unknown) {
      if ((err as Error).name !== "AbortError") console.warn("Geocoder error:", err);
    }
  }

  function showGeocoderResults(items: EsriCandidate[]) {
    if (!items.length) {
      geocoderResults!.innerHTML = `<div class="search-no-results">No places found</div>`;
      geocoderResults!.hidden = false;
      return;
    }
    geocoderResults!.innerHTML = items.map((item: EsriCandidate, i: number) => {
      const [name, sub] = splitLabel(item.address);
      return `<button class="search-result-item" data-index="${i}">
        <span class="search-result-name truncate">${escapeHtml(name)}</span>
        <span class="search-result-label">${escapeHtml(sub)}</span>
      </button>`;
    }).join("");
    geocoderResults!.hidden = false;

    geocoderResults!.querySelectorAll<HTMLElement>(".search-result-item").forEach(btn => {
      btn.addEventListener("click", () => {
        const item  = items[parseInt((btn as HTMLElement).dataset.index!)];
        const [label] = splitLabel(item.address);
        const { x: lon, y: lat } = item.location;

        placeGeocoderPin(label, lon, lat);

        const ext = item.extent;
        if (ext) {
          state.map!.fitBounds(
            [[ext.xmin, ext.ymin], [ext.xmax, ext.ymax]],
            { padding: 40, maxZoom: 16 }
          );
        } else {
          state.map!.flyTo({ center: [lon, lat], zoom: 12 });
        }
        geocoderInput!.value = label;
        hideGeocoderResults();
      });
    });
  }

  function hideGeocoderResults() {
    geocoderResults!.hidden = true;
  }

  geocoderInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") geocodeSearch(geocoderInput.value);
    if (e.key === "Escape") hideGeocoderResults();
  });

  document.addEventListener("click", (e) => {
    if (!(e.target as Element)?.closest("#geocoder")) hideGeocoderResults();
  });
}
