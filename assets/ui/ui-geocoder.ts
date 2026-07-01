// ─── Geocoder (Nominatim place / address search) ────────────────────────────

import { state } from '../state.js';
import { escapeHtml } from '../utils/utils.js';
import { renderMyDataTab, saveUserData } from '../user-data/user-data.js';

interface NominatimResult {
  display_name: string;
  lat: string;
  lon: string;
  boundingbox?: [string, string, string, string];
}

// Nominatim splits house numbers: "1234, Main St, City..." → "1234 Main St".
// Returns [label, partsConsumed] so callers can offset the subtitle slice.
function placeName(display_name: string): [string, number] {
  const parts = display_name.split(",");
  const first = parts[0].trim();
  if (/^\d+$/.test(first) && parts[1]) return [`${first} ${parts[1].trim()}`, 2];
  return [first, 1];
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
    try {
      if (geocoderAbort) geocoderAbort.abort();
      geocoderAbort = new AbortController();
      const params = new URLSearchParams({ q: query, format: "json", limit: "5", addressdetails: "0" });
      const res  = await fetch(
        `https://nominatim.openstreetmap.org/search?${params}`,
        { signal: geocoderAbort!.signal, headers: { "Accept-Language": "en" } }
      );
      const data = await res.json();
      showGeocoderResults(data as NominatimResult[]);
    } catch (err: unknown) {
      if ((err as Error).name !== "AbortError") console.warn("Geocoder error:", err);
    }
  }

  function showGeocoderResults(items: NominatimResult[]) {
    if (!items.length) {
      geocoderResults!.innerHTML = `<div class="search-no-results">No places found</div>`;
      geocoderResults!.hidden = false;
      return;
    }
    geocoderResults!.innerHTML = items.map((item: NominatimResult, i: number) => {
      const parts = item.display_name.split(",");
      const [name, offset] = placeName(item.display_name);
      const sub   = parts.slice(offset, offset + 2).join(",").trim();
      return `<button class="search-result-item" data-index="${i}">
        <span class="search-result-name truncate">${escapeHtml(name)}</span>
        <span class="search-result-label">${escapeHtml(sub)}</span>
      </button>`;
    }).join("");
    geocoderResults!.hidden = false;

    geocoderResults!.querySelectorAll<HTMLElement>(".search-result-item").forEach(btn => {
      btn.addEventListener("click", () => {
        const item  = items[parseInt((btn as HTMLElement).dataset.index!)];
        const [label] = placeName(item.display_name);

        placeGeocoderPin(label, +item.lon, +item.lat);

        const bb = item.boundingbox;
        if (bb) {
          state.map!.fitBounds(
            [[+bb[2], +bb[0]], [+bb[3], +bb[1]]],
            { padding: 40, maxZoom: 16 }
          );
        } else {
          state.map!.flyTo({ center: [+item.lon, +item.lat], zoom: 12 });
        }
        geocoderInput!.value = label;
        hideGeocoderResults();
      });
    });
  }

  function hideGeocoderResults() {
    geocoderResults!.hidden = true;
  }

  // ponytail: no debounce autocomplete — Nominatim ToS prohibits it; search on Enter only
  geocoderInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") geocodeSearch(geocoderInput.value);
    if (e.key === "Escape") hideGeocoderResults();
  });

  document.addEventListener("click", (e) => {
    if (!(e.target as Element)?.closest("#geocoder")) hideGeocoderResults();
  });
}
