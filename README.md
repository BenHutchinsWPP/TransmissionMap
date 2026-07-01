# North America Electrical Transmission Map

Interactive map of US electric transmission infrastructure — lines, substations, generators, pipelines, renewable resources, and land constraints. For educational and informational use only; do not rely on for operational, safety, or regulatory decisions.

⚡ Live: **[TransmissionMap](https://benhutchinswpp.github.io/TransmissionMap/)**

---

## Yet Another Map: Why?

[OpenInfraMap](https://openinframap.org/) covers global infrastructure. This project narrows the focus to North America and adds:

- **Feature search** — type "Grizzly" and fly to Grizzly 500 kV directly.
- **Per-layer filters** — show only wind generators, only ≥230 kV substations, etc.
- **Aerial basemap toggle** — ESRI World Imagery to spot newly-built facilities not yet in OSM.
- **HIFLD substations & lines** — the US public-domain dataset that fills in gaps OSM hasn't covered yet.
- **EIA generators** — plant-level capacity, fuel, NERC region, balancing authority for the US.
- **Direct downloads** — CSV / SHP for every layer, ready for Google Earth or GIS software.

---

## Quick start

```bash
git clone https://github.com/benhutchinswpp/TransmissionMap.git
cd TransmissionMap
npm run dev
# open http://localhost:5173
```

The app is Vite-bundled TypeScript + MapLibre GL JS. PMTiles and GeoJSON are committed; `npm run dev` serves locally with hot reload. To regenerate data from upstream sources, see [docs/pipeline.md](docs/pipeline.md).

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
| 8 | [docs/release-artifacts.md](docs/release-artifacts.md) | File inventory for the current build |

---

## License

- **Code** (HTML, JS, CSS, Python, shell scripts, config): MIT — see [`LICENSE`](LICENSE).
- **Data**: per upstream source — see [docs/data-sources.md](docs/data-sources.md) for the full per-layer license, attribution, and vintages.

---

Ben Hutchins (WPP) designed and scoped this application; the implementation was done with an AI-assist.
