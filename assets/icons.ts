// ─── Generator / pipeline / natgas icons — SVG rendered to canvas ────────────
// Each icon is an SVG body string (viewBox 0 0 24 24 applied by renderer).
// Colors are embedded in each SVG string; single-color, no gradients.
// Icon names match the fuel→icon expressions in layers.js.

import { state } from './state.js';

const GEN_ICON_DEFS = [
  ["gen-solar", `<circle cx="12" cy="12" r="4.5" fill="#f59e0b"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.93 4.93l2.12 2.12M16.95 16.95l2.12 2.12M4.93 19.07l2.12-2.12M16.95 7.05l2.12-2.12" stroke="#f59e0b" stroke-width="2" stroke-linecap="round"/>`],
  ["gen-wind",  `<circle cx="12" cy="12" r="2.2" fill="#60a5fa"/><ellipse cx="12" cy="6.5" rx="2" ry="5.5" fill="#60a5fa"/><ellipse cx="12" cy="6.5" rx="2" ry="5.5" fill="#60a5fa" transform="rotate(120 12 12)"/><ellipse cx="12" cy="6.5" rx="2" ry="5.5" fill="#60a5fa" transform="rotate(240 12 12)"/>`],
  ["gen-hydro", `<path d="M12 3C12 3 5 11 5 15.5a7 7 0 0 0 14 0C19 11 12 3 12 3z" fill="#3b82f6"/>`],
  ["gen-nuclear", `<circle cx="12" cy="12" r="10.5" fill="#fbbf24"/><path d="M10.25 8.97L7.25 3.77A9.5 9.5 0 0 1 16.75 3.77L13.75 8.97A3.5 3.5 0 0 0 10.25 8.97Z" fill="#1a1a1a"/><path d="M10.25 8.97L7.25 3.77A9.5 9.5 0 0 1 16.75 3.77L13.75 8.97A3.5 3.5 0 0 0 10.25 8.97Z" fill="#1a1a1a" transform="rotate(120 12 12)"/><path d="M10.25 8.97L7.25 3.77A9.5 9.5 0 0 1 16.75 3.77L13.75 8.97A3.5 3.5 0 0 0 10.25 8.97Z" fill="#1a1a1a" transform="rotate(240 12 12)"/><circle cx="12" cy="12" r="2" fill="#1a1a1a"/>`],
  ["gen-coal",  `<path d="M8 2L3 8L3 16L8 22L16 22L21 16L21 8L16 2Z" fill="#1c1917"/><path d="M8 2L12 6L16 2Z" fill="#374151"/><path d="M3 8L12 6L8 2Z" fill="#44403c"/><path d="M3 8L3 16L12 6Z" fill="#374151"/><path d="M3 16L8 22L12 6Z" fill="#292524"/><path d="M8 22L16 22L12 6Z" fill="#44403c"/><path d="M16 22L21 16L12 6Z" fill="#374151"/><path d="M21 16L21 8L12 6Z" fill="#292524"/><path d="M21 8L16 2L12 6Z" fill="#44403c"/><circle cx="8" cy="5" r="1.2" fill="#78716c"/>`],
  ["gen-gas",   `<path d="M12 2c0 0-7 8-7 13a7 7 0 0 0 14 0C19 10 12 2 12 2z" fill="#f97316"/><circle cx="12" cy="16" r="3" fill="#fed7aa"/>`],
  ["gen-oil",   `<path d="M6 5Q5 12 6 19L18 19Q19 12 18 5Z" fill="#92400e"/><ellipse cx="12" cy="5" rx="6" ry="2" fill="#78350f"/><ellipse cx="12" cy="19" rx="6" ry="2" fill="#6b3010"/><ellipse cx="12" cy="9" rx="6.5" ry="1.8" stroke="#d97706" stroke-width="1.2" fill="none"/><ellipse cx="12" cy="15" rx="6.5" ry="1.8" stroke="#d97706" stroke-width="1.2" fill="none"/>`],
  ["gen-storage", `<rect x="7" y="5" width="10" height="16" rx="2" fill="#16a34a"/><rect x="9" y="3" width="6" height="3" rx="1" fill="#16a34a"/><rect x="9" y="8" width="6" height="8" rx="0.5" fill="#bbf7d0"/>`],
  // Pumped storage hydro: blue approximate-equal (≈) — two stacked tildes.
  ["gen-pumped-storage", `<path d="M4 9.5q3.5-4 7 0t7 0" stroke="#2563eb" stroke-width="2.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/><path d="M4 15.5q3.5-4 7 0t7 0" stroke="#2563eb" stroke-width="2.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`],
  ["gen-geo",   `<rect x="6" y="9" width="12" height="10" rx="2" fill="#dc2626"/><path d="M18 12h1.5a2.5 2.5 0 0 1 0 5H18" stroke="#dc2626" stroke-width="2" fill="none" stroke-linecap="round"/><path d="M9 8c1-3-1-3 0-6" stroke="#dc2626" stroke-width="1.5" stroke-linecap="round" fill="none"/><path d="M14 8c1-3-1-3 0-6" stroke="#dc2626" stroke-width="1.5" stroke-linecap="round" fill="none"/>`],
  ["gen-biomass", `<path d="M12 2C6 2 2 7 2 12C2 17 6 22 12 22C18 22 22 17 22 12C22 7 18 2 12 2Z" fill="#15803d"/><path d="M12 22C8 18 6 15 6 12C6 9 8 6 12 2C16 6 18 9 18 12C18 15 16 18 12 22Z" fill="#16a34a"/><line x1="12" y1="2" x2="12" y2="22" stroke="#86efac" stroke-width="1.5" stroke-linecap="round"/><line x1="12" y1="10" x2="7" y2="15" stroke="#86efac" stroke-width="1" stroke-linecap="round"/><line x1="12" y1="14" x2="17" y2="9" stroke="#86efac" stroke-width="1" stroke-linecap="round"/>`],
  ["gen-diesel", `<rect x="4" y="5" width="10" height="14" rx="2" stroke="#d97706" stroke-width="2" fill="none"/><path d="M14 9h2a2 2 0 0 1 2 2v4a1 1 0 0 0 2 0V9l-2-3" stroke="#d97706" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"/><rect x="7" y="8" width="4" height="4" rx="1" fill="#d97706"/>`],
  ["gen-other", `<path d="M13 2L4 14h7l-1 8 9-12h-7z" fill="#eab308"/>`],
];

const PIPELINE_ICON_DEFS = [
  ["pipeline-pig_launcher", `<circle cx="12" cy="12" r="9" fill="#f9a8d4"/><path d="M5 8L4 3L9 7Z" fill="#fda4af"/><path d="M19 8L20 3L15 7Z" fill="#fda4af"/><circle cx="9" cy="10" r="1.5" fill="#1f2937"/><circle cx="15" cy="10" r="1.5" fill="#1f2937"/><ellipse cx="12" cy="15" rx="3.5" ry="2.5" fill="#f472b6"/><circle cx="10.8" cy="15" r="1" fill="#be185d"/><circle cx="13.2" cy="15" r="1" fill="#be185d"/>`],
  ["pipeline-compressor",   `<path fill-rule="evenodd" d="M18.06 8.5L20.86 10.44L20.86 13.56L18.06 15.5L17.79 18.89L15.08 20.46L12 19L8.92 20.46L6.21 18.89L5.94 15.5L3.14 13.56L3.14 10.44L5.94 8.5L6.21 5.11L8.92 3.54L12 5L15.08 3.54L17.79 5.11ZM12 9.5A2.5 2.5 0 1 0 12 14.5A2.5 2.5 0 1 0 12 9.5Z" fill="#6b7280"/>`],
  ["pipeline-delivery",     `<rect x="3" y="12" width="18" height="9" rx="1" fill="#4b5563"/><path d="M3 12L9 6h6l6 6z" fill="#4b5563"/><rect x="9" y="15" width="6" height="6" fill="#9ca3af"/>`],
  ["pipeline-interconnect", `<line x1="12" y1="5" x2="5" y2="19" stroke="#3b82f6" stroke-width="2"/><line x1="12" y1="5" x2="19" y2="19" stroke="#3b82f6" stroke-width="2"/><line x1="5" y1="19" x2="19" y2="19" stroke="#3b82f6" stroke-width="2"/><circle cx="12" cy="5" r="3" fill="#3b82f6"/><circle cx="5" cy="19" r="3" fill="#3b82f6"/><circle cx="19" cy="19" r="3" fill="#3b82f6"/>`],
  ["pipeline-end",          `<circle cx="12" cy="12" r="9" stroke="#dc2626" stroke-width="2" fill="none"/><path d="M8 8l8 8M16 8l-8 8" stroke="#dc2626" stroke-width="2.5" stroke-linecap="round"/>`],
  ["pipeline-other",        `<circle cx="12" cy="12" r="4" fill="#9ca3af"/><circle cx="12" cy="12" r="8" stroke="#9ca3af" stroke-width="2" fill="none"/>`],
];

const NATGAS_PT_ICON_DEFS = [
  ["natgas-lng_terminal",  `<path d="M3 16h18l-3 5H6z" fill="#1e40af"/><rect x="6" y="10" width="12" height="6" rx="1" fill="#1e40af"/><rect x="10" y="6" width="4" height="4" fill="#1e40af"/><path d="M2 19c4 3 16 3 20 0" stroke="#93c5fd" stroke-width="1.5" fill="none"/>`],
  ["natgas-underground",   `<ellipse cx="12" cy="8" rx="6" ry="2.5" fill="#92400e"/><rect x="6" y="8" width="12" height="8" fill="#78350f"/><ellipse cx="12" cy="16" rx="6" ry="2.5" fill="#5c2a0e"/><path d="M9 19v3M12 20v3M15 19v3" stroke="#78350f" stroke-width="1.5" stroke-linecap="round"/>`],
  ["natgas-spr",           `<rect x="7" y="5" width="10" height="14" rx="2" fill="#431407"/><ellipse cx="12" cy="5" rx="5" ry="2" fill="#350e05"/><ellipse cx="12" cy="19" rx="5" ry="2" fill="#350e05"/><line x1="7" y1="9" x2="17" y2="9" stroke="#fde68a" stroke-width="1.2"/><line x1="7" y1="14" x2="17" y2="14" stroke="#fde68a" stroke-width="1.2"/>`],
  ["natgas-trading_hub",   `<path d="M5 8h14M19 8l-3-3M19 8l-3 3" stroke="#16a34a" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"/><path d="M19 16H5M5 16l3-3M5 16l3 3" stroke="#16a34a" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"/>`],
  ["natgas-processing",    `<path fill-rule="evenodd" d="M18.06 8.5L20.86 10.44L20.86 13.56L18.06 15.5L17.79 18.89L15.08 20.46L12 19L8.92 20.46L6.21 18.89L5.94 15.5L3.14 13.56L3.14 10.44L5.94 8.5L6.21 5.11L8.92 3.54L12 5L15.08 3.54L17.79 5.11ZM12 9.5A2.5 2.5 0 1 0 12 14.5A2.5 2.5 0 1 0 12 9.5Z" fill="#0d9488"/>`],
  ["natgas-border_cross",  `<circle cx="12" cy="12" r="9" stroke="#2563eb" stroke-width="2" fill="none"/><path d="M12 3C9.5 6 8 9 8 12s1.5 6 4 9M12 3c2.5 3 4 6 4 9s-1.5 6-4 9" stroke="#2563eb" stroke-width="1.5" fill="none"/><line x1="3" y1="12" x2="21" y2="12" stroke="#2563eb" stroke-width="1.5"/>`],
  ["natgas-peak_shaving",  `<path d="M12 2v20M2 12h20M4.93 4.93l14.14 14.14M19.07 4.93L4.93 19.07" stroke="#7dd3fc" stroke-width="2" stroke-linecap="round"/><circle cx="12" cy="12" r="2.5" fill="#7dd3fc"/>`],
  ["natgas-lng_storage",   `<ellipse cx="7" cy="12" rx="4" ry="6" fill="#0891b2"/><rect x="7" y="6" width="10" height="12" fill="#06b6d4"/><ellipse cx="17" cy="12" rx="4" ry="6" fill="#0e7490"/>`],
  ["natgas-pol_terminal",  `<rect x="3" y="4" width="10" height="13" rx="2" stroke="#ea580c" stroke-width="2" fill="none"/><path d="M13 8h2a2 2 0 0 1 2 2v4a2 2 0 0 0 4 0V8" stroke="#ea580c" stroke-width="2" stroke-linecap="round" fill="none"/><rect x="6" y="7" width="4" height="4" rx="1" fill="#ea580c"/><line x1="3" y1="17" x2="13" y2="17" stroke="#ea580c" stroke-width="2" stroke-linecap="round"/>`],
  ["natgas-other",         `<circle cx="12" cy="12" r="4" fill="#9ca3af"/><circle cx="12" cy="12" r="8" stroke="#9ca3af" stroke-width="2" fill="none"/>`],
];

// Mine commodity-category icons — hand-drawn SVG glyphs (NOT emoji: color-emoji
// fonts aren't guaranteed on every OS, so emoji render blank). Rasterized via the
// same _makeSvgIcon pipeline as the generator icons. Each is colored to match its
// commodity bucket, with a white outline for contrast on the map. Names are
// `mine-<cat>` and must match minesIconExpr() in src/colors/minerals.ts.
const _mw = 'stroke="#fff" stroke-width="1" stroke-linejoin="round"';
const MINE_ICON_DEFS = [
  // gold ingot
  ["mine-precious",   `<path d="M4 16l3-6h10l3 6z" fill="#d4af37" ${_mw}/>`],
  // hex nut (base metals)
  ["mine-base",       `<path d="M7 5h10l5 7-5 7H7l-5-7z" fill="#b87333" ${_mw}/><circle cx="12" cy="12" r="3.2" fill="#fff"/>`],
  // gear (iron & ferroalloy)
  ["mine-ferroalloy", `<path fill-rule="evenodd" d="M18.06 8.5L20.86 10.44L20.86 13.56L18.06 15.5L17.79 18.89L15.08 20.46L12 19L8.92 20.46L6.21 18.89L5.94 15.5L3.14 13.56L3.14 10.44L5.94 8.5L6.21 5.11L8.92 3.54L12 5L15.08 3.54L17.79 5.11ZM12 9A3 3 0 1 0 12 15A3 3 0 1 0 12 9Z" fill="#708090" ${_mw}/>`],
  // battery
  ["mine-battery",    `<rect x="4" y="7" width="15" height="10" rx="1.5" fill="#22c55e" ${_mw}/><rect x="19" y="10" width="2.5" height="4" rx="1" fill="#22c55e"/><path d="M11 9l-2 4h3l-2 4" stroke="#fff" stroke-width="1.4" fill="none" stroke-linejoin="round" stroke-linecap="round"/>`],
  // lightning bolt (energy)
  ["mine-energy",     `<path d="M13 2L4 14h6l-1 8 9-12h-6z" fill="#ef4444" ${_mw}/>`],
  // diamond (gem)
  ["mine-gem",        `<path d="M6 4h12l3 5-9 12L3 9z" fill="#a855f7" ${_mw}/><path d="M3 9h18M9 4l-3 5 6 12M15 4l3 5-6 12" stroke="#fff" stroke-width="0.9" fill="none"/>`],
  // stacked bricks (industrial/construction)
  ["mine-industrial", `<g fill="#9ca3af" ${_mw}><rect x="3" y="7" width="8" height="4"/><rect x="13" y="7" width="8" height="4"/><rect x="8" y="12" width="8" height="4"/><rect x="3" y="17" width="8" height="4"/><rect x="13" y="17" width="8" height="4"/></g>`],
  // pickaxe (other)
  ["mine-other",      `<path d="M3 7c6-4 12-4 18 0" stroke="#6b7280" stroke-width="2.6" fill="none" stroke-linecap="round"/><rect x="10.7" y="6" width="2.6" height="16" rx="1" fill="#6b7280" ${_mw}/>`],
];

const GEN_ICON_LOGICAL_PX = 22;
const GEN_ICON_OVERSAMPLE = 4;

function _makeSvgIcon(svgBody: string) {
  const size = GEN_ICON_LOGICAL_PX * GEN_ICON_OVERSAMPLE;
  return new Promise<{ imageData: ImageData; pixelRatio: number }>((resolve, reject) => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="${size}" height="${size}">${svgBody}</svg>`;
    const blob = new Blob([svg], { type: "image/svg+xml" });
    const url = URL.createObjectURL(blob);
    const img = new Image(size, size);
    img.onload = () => {
      const c = document.createElement("canvas");
      c.width = c.height = size;
      const ctx = c.getContext("2d");
      if (!ctx) { URL.revokeObjectURL(url); reject(new Error("canvas 2d context unavailable")); return; }
      ctx.drawImage(img, 0, 0, size, size);
      URL.revokeObjectURL(url);
      resolve({ imageData: ctx.getImageData(0, 0, size, size), pixelRatio: GEN_ICON_OVERSAMPLE });
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("SVG icon failed to load")); };
    img.src = url;
  });
}

function _loadIcons(defs: string[][]) {
  if (!state.map) return Promise.resolve();
  const map = state.map;
  return Promise.all(defs.map(async ([name, svgBody]) => {
    if (map.hasImage(name)) map.removeImage(name);
    const { imageData, pixelRatio } = await _makeSvgIcon(svgBody);
    map.addImage(name, imageData, { pixelRatio });
  }));
}

export function loadGenIcons()      { return _loadIcons(GEN_ICON_DEFS);      }
export function loadPipelineIcons() { return _loadIcons(PIPELINE_ICON_DEFS); }
export function loadNatgasPtIcons() { return _loadIcons(NATGAS_PT_ICON_DEFS); }
export function loadMineIcons()     { return _loadIcons(MINE_ICON_DEFS);      }

// Flat name → svgBody lookup used by legend renderer.
export const ICON_SVG = Object.fromEntries([...GEN_ICON_DEFS, ...PIPELINE_ICON_DEFS, ...NATGAS_PT_ICON_DEFS, ...MINE_ICON_DEFS]);
