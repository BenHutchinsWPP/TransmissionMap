# Global Electrical Transmission Map

Interactive map of global electric transmission infrastructure — lines, substations, generators, pipelines, renewable resources, and land constraints. For educational and informational use only; do not rely on for operational, safety, or regulatory decisions.

⚡ Live: **[TransmissionMap](https://www.wpptx.org/)**

---

## What it shows

The map draws transmission lines, substations, power plants, pipelines, renewable-resource rasters and land constraints, worldwide from OpenStreetMap and, for the United States, from public datasets such as HIFLD and EIA. Layers can be searched, filtered, compared on an aerial basemap and downloaded as GeoJSON or CSV.

---

## Quick start

```bash
git clone https://github.com/benhutchinswpp/TransmissionMap.git
cd TransmissionMap
# prebuilt map data (not in main) — see docs/hosting-plan.md
curl -L https://github.com/BenHutchinsWPP/TransmissionMap/archive/data-static.tar.gz \
  | tar xz --strip-components=1
npm install
npm run dev
# open http://localhost:5173
```

The app is Vite-bundled TypeScript + MapLibre GL JS. PMTiles and GeoJSON are not in `main` — prod fetches them from `data.wpptx.org`; local dev uses your `data/layers/` build. To regenerate data from upstream sources, see [docs/pipeline.md](docs/pipeline.md); for where each asset class is hosted, [docs/hosting-plan.md](docs/hosting-plan.md).

---

## Docs

Read in this order if you're new:

| | Doc | What's in it |
|---|---|---|
| 1 | [docs/layers/](docs/layers/) | What each layer group shows and why — start here |
| 2 | [docs/data-sources.md](docs/data-sources.md) | Where every dataset comes from, licenses, attribution |
| 3 | [docs/pipeline.md](docs/pipeline.md) | How to regenerate the data from upstream sources |
| 4 | [docs/adding-a-dataset.md](docs/adding-a-dataset.md) | How to bring a new public dataset into the pipeline |
| 5 | [docs/adding-a-layer.md](docs/adding-a-layer.md) | How to add a new map layer (frontend wiring) |
| 6 | [docs/adding-a-filter.md](docs/adding-a-filter.md) | How to add a layer filter (legend chips or range) |
| 7 | [docs/url-state.md](docs/url-state.md) | How shareable map links are encoded; adding a URL param |
| 8 | [docs/settings.md](docs/settings.md) | Display-unit preferences and how formatted values reach the map |
| 9 | [docs/release-artifacts.md](docs/release-artifacts.md) | File inventory for the current build |
| 10 | [docs/network-allowlist.md](docs/network-allowlist.md) | Hosts to whitelist — for IT/security review |

---

## License

- **Code** (HTML, JS, CSS, Python, shell scripts, config): MIT — see [`LICENSE`](LICENSE).
- **Data**: per upstream source — see [docs/data-sources.md](docs/data-sources.md) for the full per-layer license, attribution, and vintages.

---

Ben Hutchins (WPP) designed and scoped this application; the implementation was done with an AI-assist.
