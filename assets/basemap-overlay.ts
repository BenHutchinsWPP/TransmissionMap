// ─── Aerial overlay layer selection + restyle (pure, no MapLibre import) ─────
// Selects which OpenFreeMap Positron layers get cloned above the Aerial
// satellite imagery (roads, route shields, place names, boundaries) and
// restyles them for contrast over photography instead of Positron's near-
// white ground. No side effects, no map/DOM access — unit-tested directly
// against real Positron layer objects (see basemap-overlay.test.ts).
// Consumed by assets/map.ts's addOfmBasemaps() graft loop, which supplies the
// raw (pre-remap) layer objects fetched from the Positron style JSON and adds
// the returned specs above the Aerial raster tiers.

// Minimal structural view of an OFM style layer — enough to select and restyle
// without modeling MapLibre's whole LayerSpecification union. Defined here
// rather than in map.ts so this module keeps zero imports; map.ts's
// OfmStyleJson imports it back for its own `layers` field.
export type OfmLayer = {
  id: string;
  type: string;
  source?: string;
  'source-layer'?: string;
  minzoom?: number;
  layout?: Record<string, unknown>;
  paint?: Record<string, unknown>;
};

// Only these source-layers carry roads, place names, and boundaries — the
// rest (water, landcover, landuse, building, aeroway, park, ...) stay off
// Aerial to avoid ground-fill clutter over the photograph.
const KEPT_SOURCE_LAYERS = new Set(['transportation', 'transportation_name', 'place', 'boundary']);

// The white road fills widen sharply with zoom (highway_minor alone goes 1.8px
// at z13 to 20px at z20). Solid white is right while a road is a hairline and
// far too much once it is a band, so fade the fills as they thicken and let the
// imagery read through. Casings stay solid — the dark edge is what keeps a
// translucent fill legible as a road.
const ROAD_FILL_OPACITY = ['interpolate', ['linear'], ['zoom'], 14, 0.75, 16, 0.65];

export function aerialOverlayLayer(layer: OfmLayer): OfmLayer | null {
  const sourceLayer = layer['source-layer'];
  if (!sourceLayer || !KEPT_SOURCE_LAYERS.has(sourceLayer)) return null;
  // Pale ground fill/line for pier decking — paints a solid patch over the photograph.
  if (layer.id === 'road_area_pier' || layer.id === 'road_pier') return null;
  // The app ships its own Railroads layer (assets/layers/map-layers-rail.ts).
  if (layer.id.startsWith('railway')) return null;

  const spec: OfmLayer = {
    ...layer,
    id: `ofm-aerial-${layer.id}`,
    // switchBasemap() turns the whole group on/off with the Map Labels toggle.
    layout: { ...layer.layout, visibility: 'none' },
  };
  if (layer.source) spec.source = `ofm-${layer.source}`;

  if (layer.id.endsWith('_casing')) {
    // Casings ship pale gray, made for a near-white ground — invisible over
    // photography. Darken so the white road fill gets a visible edge.
    spec.paint = { ...layer.paint, 'line-color': 'rgba(0,0,0,0.55)' };
  } else if (layer.id === 'highway_minor') {
    // Minor, service and track share this layer and all sit well back: white
    // for legibility over photography, but held at half opacity so residential
    // streets, driveways and parking aisles never compete with the majors.
    spec.paint = { ...layer.paint, 'line-color': '#fff', 'line-opacity': 0.5 };
  } else if (layer.id === 'highway_major_inner') {
    spec.paint = { ...layer.paint, 'line-opacity': ROAD_FILL_OPACITY };
  } else if (layer.type === 'symbol') {
    const hasIcon = 'icon-image' in (layer.layout ?? {});
    // `place` icon-image is a small dot marker anchored BESIDE the text (or ""
    // above the zoom step where it disappears) — recoloring the text is safe.
    // `transportation_name` icon-image (on exactly the 3 shield layers) is a
    // sprite badge the digits sit ON TOP of — recoloring the text would erase
    // the numerals, so only its icon-less name layers get the override.
    const invert = sourceLayer === 'place' || (sourceLayer === 'transportation_name' && !hasIcon);
    if (invert) {
      spec.paint = {
        ...layer.paint,
        'text-color': '#fff',
        'text-halo-color': 'rgba(0,0,0,0.75)',
        'text-halo-width': 1.2,
      };
    }
  } else if (sourceLayer === 'boundary') {
    spec.paint = { ...layer.paint, 'line-color': 'rgba(255,255,255,0.75)' };
    // Ships at minzoom 8, above this app's DEFAULT_ZOOM of 4 — state lines
    // would be missing on the national view.
    if (layer.id === 'boundary_3') spec.minzoom = 0;
  }

  return spec;
}
