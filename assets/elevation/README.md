Map of this folder; each file's header comment is the source of truth.

# assets/elevation

- **`assets/elevation/`** — elevation samplers (main thread): `terrarium.ts` (Terrain Tiles, worldwide; the route
  profile and the line profile's fallback, `TERRAIN_CREDIT`), `usgs-3dep.ts` (`sample3dep`: ImageServer `getSamples`,
  ≤ 1,000 points per form POST, always `pixelSize`, ≤ 4 in flight, 30 s timeout, one retry on a 5xx/timeout, US boxes only)
