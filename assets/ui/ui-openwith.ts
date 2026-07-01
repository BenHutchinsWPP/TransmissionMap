// ─── "Open With" header dropdown ────────────────────────────────────────────

import { state } from '../state.js';
import { escapeHtml } from '../utils/utils.js';

const OPEN_WITH_MAPS = [
  {
    label: "Google Maps",
    icon:  "🗺️",
    url: ({ zoom, lat, lon }: { zoom: number; lat: number; lon: number }) =>
      `https://www.google.com/maps/@${lat},${lon},${Math.round(zoom)}z`,
  },
  {
    label: "OpenStreetMap",
    icon:  "🌍",
    url: ({ zoom, lat, lon }: { zoom: number; lat: number; lon: number }) =>
      `https://www.openstreetmap.org/#map=${Math.round(zoom)}/${lat}/${lon}`,
  },
  {
    label: "OpenInfraMap",
    icon:  "⚡",
    url: ({ zoom, lat, lon }: { zoom: number; lat: number; lon: number }) =>
      `https://openinframap.org/#${zoom}/${lat}/${lon}`,
  },
];

export function wireOpenWith() {
  const openWithWrap = document.getElementById("openWithWrap");
  const openWithBtn  = document.getElementById("openWithBtn");
  const openWithMenu = document.getElementById("openWithMenu");
  if (!openWithBtn || !openWithMenu) return;

  openWithMenu.innerHTML = OPEN_WITH_MAPS.map((m, i) =>
    `<a class="open-with-item" data-map-index="${i}"
        href="#" target="_blank" rel="noopener noreferrer">
      <span class="open-with-icon">${m.icon}</span>
      <span>${escapeHtml(m.label)}</span>
    </a>`
  ).join("");

  function setHrefs() {
    if (!state.mapReady || !state.map) return;
    const { lat, lng } = state.map.getCenter();
    const zoom = +state.map.getZoom().toFixed(2);
    const latS = lat.toFixed(4);
    const lonS = lng.toFixed(4);
    openWithMenu!.querySelectorAll<HTMLAnchorElement>(".open-with-item").forEach(link => {
      const m = OPEN_WITH_MAPS[+(link as HTMLElement & { dataset: DOMStringMap }).dataset.mapIndex!];
      if (m) link.href = m.url({ zoom, lat: +latS, lon: +lonS });
    });
  }

  function close() {
    openWithMenu!.hidden = true;
    openWithBtn!.setAttribute("aria-expanded", "false");
  }

  openWithBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    const opening = openWithMenu.hidden;
    if (opening) {
      setHrefs();
      openWithMenu.hidden = false;
      openWithBtn.setAttribute("aria-expanded", "true");
    } else {
      close();
    }
  });

  openWithMenu.addEventListener("click", () => setTimeout(close, 50));

  document.addEventListener("click", (e) => {
    if (!openWithWrap?.contains(e.target as Node)) close();
  });
}
