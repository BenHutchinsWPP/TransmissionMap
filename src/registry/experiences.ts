// ─── Map Experiences catalogue ────────────────────────────────────────────────
// Pure data: curated map views ("guided grid stories") the user can jump to from
// File ▸ Experiences… Each entry names a camera, a set of layers, and the filter
// state that makes the story readable, plus the narrative that explains it.
// No side effects and no MapLibre imports — the runtime half lives in
// assets/experiences.ts, the UI in assets/ui/ui-experiences.ts.
//
// Every id in `state.layersOn` / `state.layersOff` must be a real LayerDef id,
// every `legendFilters` key a LEGEND_FILTERS key, and every bucket a real bucket
// id — experiences.test.ts checks all three against the live registry, so a
// renamed layer fails the suite instead of silently drawing an empty map.
//
// Deps: none at runtime; types from condition-compile.ts (Condition),
// area-filter.ts (AreaFilter) and src/types.ts (StyleOverride, Selection).

import type { Condition } from './condition-compile.js';
import type { AreaFilter } from './area-filter.js';
import type { Selection, StyleOverride } from '../types.js';

export type ExperienceCategory =
  | 'generation'
  | 'transmission'
  | 'load'
  | 'land'
  | 'hazards'
  | 'interconnections';

export const EXPERIENCE_CATEGORY_LABELS: Record<ExperienceCategory, string> = {
  generation:        'Generation & Fuel Supply',
  load:              'Load & Industrial Demand',
  transmission:      'Bulk Transmission',
  interconnections:  'Interconnections',
  land:              'Land, Siting & Jurisdictions',
  hazards:           'Grid Conditions & Hazards',
};

// Order the gallery groups its sections in.
export const EXPERIENCE_CATEGORY_ORDER: ExperienceCategory[] =
  ['generation', 'load', 'transmission', 'interconnections', 'land', 'hazards'];

export interface ExperienceHighlight {
  label: string;
  coordinates: [number, number]; // [lng, lat]
  description?: string;
}

export interface MapExperience {
  id: string;                   // URL slug, carried in the `exp` hash param
  title: string;
  category: ExperienceCategory;
  summary: string;              // one or two sentences for the gallery card
  narrative: string;            // plain-text story for the floating card
  takeaways: string[];
  keywords?: string[];          // extra terms the gallery search should match
  camera: {
    center: [number, number];   // [lng, lat]
    zoom: number;               // keep ≤ AERIAL_MAX_ZOOM on the aerial basemap
    pitch?: number;             // 0–75 (the map's maxPitch)
    bearing?: number;
  };
  state: {
    layersOn?: string[];        // switched on over the registry defaults
    layersOff?: string[];       // switched off, including default-on layers
    basemap?: 'light' | 'dark' | 'street' | 'topo' | 'aerial' | 'hydro';
    legendFilters?: Record<string, string[]>; // legend key → active bucket ids
    layerFilters?: Record<string, string[]>;  // layer id → active bucket ids
    genMode?: Record<string, string>;         // layer id → display mode
    ogfColorBy?: 'region' | 'status';
    westtecColorBy?: 'scenario' | 'dataset';
    weatherVar?: string;        // WEATHER_VARIABLES id
    smokeOpacity?: number;      // 0–1
    terrain3d?: boolean;        // forces mercator — terrain and globe don't mix
    hillshade?: boolean;
    where?: Record<string, Condition[]>;      // registry id → field conditions (the link's vx)
    style?: Record<string, StyleOverride>;    // registry id → opacity/size/colour (the link's vx)
    area?: AreaFilter;          // map-wide Area filter (the link's af)
    sel?: Selection;            // selected features, isolated or kept (the link's vx)
  };
  highlights?: ExperienceHighlight[];
}

// Above this the Esri aerial imagery runs out over most of the country and the
// USGS NAIP fallback returns blank tiles, so aerial stories stop here.
export const AERIAL_MAX_ZOOM = 15.5;

// The kV buckets of the bulk backbone (300 kV and up): a story that needs the
// network as context draws only these, so the subject stays in front.
const BACKBONE_KV = ['550+', '500-549', '300-499'];
// One quiet ink for context lines over a coloured wash.
const CONTEXT_LINE = { color: '#334155', opacity: 0.85, size: 1.4 };

// Transmission siting reads the routing constraints layer, which exists on the
// dev server only (src/registry/land.ts), so this story is dev-only with it.
const TRANSMISSION_SITING: MapExperience = {
  id: 'transmission-siting-puzzle',
  title: 'The Transmission Siting Puzzle',
  category: 'land',
  summary: 'Several kinds of siting constraints, overlaid, leave a long line only a few ways through.',
  narrative:
    'A new high-voltage line has to cross hundreds of miles of land with its own rules and owners. The ' +
    'coloured areas overlay several kinds of siting constraints, and the black lines are today\'s 300 kV and ' +
    'higher network. Across southern New Mexico and Arizona the open ground between constrained areas is ' +
    'narrow, which is why new lines tend to follow the old ones.',
  takeaways: [
    'SunZia, a ±525 kV DC line carrying New Mexico wind to Arizona, spent more than a decade in permitting.',
    'Following an existing line or corridor is usually the easiest way through: the land use is already settled.',
    'Pick one concern at a time in the Constraints layer, in the Land group, to see each on its own.',
  ],
  keywords: ['siting', 'routing', 'constraints', 'sunzia', 'permitting'],
  camera: { center: [-108.6, 33.4], zoom: 6.3 },
  state: {
    layersOn: ['route-constraints'],
    basemap: 'light',
    legendFilters: { kv: BACKBONE_KV },
    style: {
      'route-constraints': { opacity: 0.8 },
      'osm-transmission-lines': { color: '#0f172a', opacity: 0.95, size: 1.4 },
    },
  },
  highlights: [
    { label: 'SunZia (west end)', coordinates: [-111.5600, 32.7500], description: 'The Pinal Central end of the SunZia DC line, near Casa Grande.' },
  ],
};

export const EXPERIENCES: MapExperience[] = [
  // ── Generation & fuel supply ───────────────────────────────────────────────
  {
    id: 'columbia-hydro',
    title: 'Columbia & Snake River Hydro System',
    category: 'generation',
    summary: "Cascading federal dams turn one river basin into North America's largest dispatchable renewable engine.",
    narrative:
      'Each blue drop is a hydro plant of 20 MW or more, sized by its total capacity; the red lines are the 500 kV network they ' +
      'feed. Follow the Columbia from Grand Coulee down to Bonneville, and the Snake from Lower Granite to Ice ' +
      'Harbor: the dams sit one after another, each using the drop to the next reservoir to run the same water ' +
      'through its turbines again. Bonneville Power Administration markets the output of 31 federal dams in the' +
      ' basin, and the 500 kV lines carry it to the coast and south toward California.',
    takeaways: [
      'Cascading head lets the same water generate power again and again on its way downriver.',
      "Large hydro units respond within seconds, which makes them the West's main source of frequency response.",
      'Upstream storage, much of it in Canada under the Columbia River Treaty, shapes spring runoff toward the summer and winter peaks.',
      'Tilt and rotate the 3D terrain (right-drag, or two fingers) to see the head each dam works with.',
    ],
    keywords: ['hydro', 'dam', 'columbia', 'snake', 'bpa', 'bonneville', 'grand coulee'],
    camera: { center: [-120.2, 46.6], zoom: 6.7, pitch: 45, bearing: -10 },
    state: {
      // One point per plant: EIA has a point per generator, and a dam's units stack on one spot.
      layersOn: ['osm-plants-points'],
      basemap: 'hydro',
      // Only the 500 kV lines the dams feed, faint, so the river basin stays legible.
      legendFilters: { fuel: ['hydro', 'pumped_storage'], kv: ['550+', '500-549'] },
      // Small run-of-river plants crowd the main-stem dams.
      where: { 'osm-plants-points': [{ field: 'output_mw', op: '>=', value: 20 }] },
      style: {
        'osm-plants-points': { size: 1.4 },
        'osm-transmission-lines': { color: '#b91c1c', opacity: 0.9, size: 1.6 },
      },
      terrain3d: true,
      hillshade: true,
    },
    highlights: [
      { label: 'Grand Coulee Dam', coordinates: [-118.9814, 47.9565], description: '6,809 MW — the largest power station in the United States.' },
      { label: 'Chief Joseph Dam', coordinates: [-119.6353, 47.9958], description: '2,620 MW, immediately downstream of Grand Coulee.' },
      { label: 'John Day Dam', coordinates: [-120.6936, 45.7150], description: '2,160 MW on the lower Columbia.' },
    ],
  },
  {
    id: 'geothermal-heat-flux',
    title: 'Geothermal Heat Flux & Generation',
    category: 'generation',
    summary: 'Crustal heat flow explains why geothermal plants cluster where they do, and almost nowhere else.',
    narrative:
      "The red shading is heat flow out of the Earth's crust: the deeper the red, the hotter the rock near the " +
      'surface. The grey dots are identified hydrothermal systems, and the red plant icons are the geothermal ' +
      'generators running today. The plants follow the heat: The Geysers north of San Francisco, the Basin and ' +
      'Range faults across Nevada, and the Imperial Valley by the Salton Sea, because a conventional plant ' +
      'needs hot water within drilling depth. East of the Rockies the same technology has little to work with.',
    takeaways: [
      'The Geysers is the largest geothermal field in the world.',
      'Geothermal runs around the clock, which makes it one of the few clean sources that is firm without storage.',
      'The grey dots mark the near-term drilling frontier; enhanced geothermal aims to reach the wider red areas by fracturing hot, dry rock.',
    ],
    keywords: ['geothermal', 'heat flow', 'geysers', 'imperial valley', 'basin and range'],
    // Wide enough to show the hot West against the cool East.
    camera: { center: [-110.5, 39.0], zoom: 4.2 },
    state: {
      layersOn: ['ihfc-geo-heatflow', 'nrel-hydrothermal-points', 'eia-generators'],
      layersOff: ['osm-transmission-lines'],
      basemap: 'light',
      legendFilters: { fuel: ['geo'] },
      // The heat-flow wash and the hydrothermal systems sit behind the plants.
      style: {
        'ihfc-geo-heatflow': { opacity: 0.75 },
        'nrel-hydrothermal-points': { size: 0.4, opacity: 0.5, color: '#334155' },
        'eia-generators': { size: 1.6 },
      },
    },
    highlights: [
      { label: 'The Geysers', coordinates: [-122.7550, 38.7900], description: 'About 1.5 GW of installed steam capacity.' },
      { label: 'Imperial Valley / Salton Sea', coordinates: [-115.6200, 33.1500], description: 'Brine-rich reservoirs also targeted for lithium recovery.' },
    ],
  },
  {
    id: 'great-plains-wind',
    title: "Where's the Wind? The Great Plains Corridor",
    category: 'generation',
    summary: 'The richest onshore wind in North America sits far from the cities it could serve.',
    narrative:
      'The blue wash is average wind speed at 100 m, the hub height of a modern turbine: the darker the blue, ' +
      'the stronger the wind. Each blue icon is a wind plant, and the dark lines are the 300 kV and higher ' +
      'backbone. The plants crowd where wind and wires meet, across Iowa and the Texas and Oklahoma plains, ' +
      'while some of the windiest ground, in Wyoming and the Dakotas, has few lines to export from. That gap ' +
      'between resource and transmission is one of the largest expansion challenges on the grid.',
    takeaways: [
      'Iowa now gets more than half of its electricity from wind.',
      'When the export lines fill on windy nights, prices at nearby grid nodes can fall below zero.',
      'New Plains projects reach capacity factors above 40%, competitive even after paying for long-distance delivery.',
    ],
    keywords: ['wind', 'plains', 'texas', 'oklahoma', 'kansas', 'resource'],
    camera: { center: [-100.8, 40.2], zoom: 4.6 },
    state: {
      layersOn: ['nlr-wind-100m', 'eia-generators'],
      basemap: 'light',
      // The 300 kV+ backbone only: the gap between the wind and the lines is the story.
      legendFilters: { fuel: ['wind'], kv: BACKBONE_KV },
      style: {
        'nlr-wind-100m': { opacity: 0.75 },
        'eia-generators': { size: 1.0 },
        'osm-transmission-lines': { color: '#0f172a', opacity: 0.8, size: 1.2 },
      },
    },
  },
  {
    id: 'thermal-plant-anatomy',
    title: 'Thermal Plant Anatomy: Fuel, Turbine, Switchyard',
    category: 'generation',
    summary: 'Port Westward on the Columbia River, from the air: gas in, power out, and everything in between.',
    narrative:
      'This is Port Westward near Clatskanie, Oregon, where Portland General Electric runs two gas plants side ' +
      'by side. Port Westward 1 is a combined-cycle plant: a gas turbine, then a steam turbine driven by the ' +
      "gas turbine's exhaust heat. Port Westward 2 is a row of reciprocating engines, labelled about 19 MW " +
      'each, that start within minutes to follow wind and load. The dashed orange line is the gas pipeline that' +
      ' feeds the site; the blue lines leave the 230 kV switchyard for the bulk grid.',
    takeaways: [
      'Combined cycle reuses exhaust heat in a second turbine, reaching roughly 50 to 60% efficiency against 35 to 40% for a gas turbine alone.',
      'Reciprocating engines trade some efficiency for fast starts, which makes them a common partner for wind and solar.',
      'Step-up transformers lift generator voltage (13.8 to 24 kV) to the 230 kV of the switchyard, cutting losses on the way out.',
    ],
    keywords: ['gas', 'combined cycle', 'switchyard', 'transformer', 'aerial', 'pipeline', 'port westward', 'reciprocating'],
    camera: { center: [-123.1729, 46.1790], zoom: 15.4 },
    state: {
      layersOn: [
        'osm-pipelines-lines', 'hifld-substations', 'osm-substations-polygons',
        'osm-generators', 'osm-plants-polygons', 'hifld-transmission-lines',
      ],
      basemap: 'aerial',
      legendFilters: { fuel: ['gas'] },
    },
  },
  {
    id: 'coal-supply-chain',
    title: 'Coal Supply Chain: Mine, Rail, Power Plant',
    category: 'generation',
    summary: 'Craig Station and its mines in northwest Colorado: the mine-mouth arrangement, seen from the air.',
    narrative:
      'Craig Station, the dark icon on the right, burns coal mined a few miles away. Trapper Mine lies just to ' +
      'the south-west, and the rail line in yellow brings in coal from mines farther out. Coal is heavy and ' +
      'cheap per ton, so the shortest haul wins: plants like Craig were built at the mine, and the power ' +
      'travels instead of the fuel, on the high-voltage lines leaving the switchyard across the Rockies.',
    takeaways: [
      'Rail or a conveyor makes bulk coal economics work; trucking it any distance does not.',
      'Mine, plant and switchyard were planned as one system, which is why they sit within a few miles of each other.',
      'A retiring coal plant leaves behind a high-capacity grid connection that solar, storage or new firm generation can reuse.',
    ],
    keywords: ['coal', 'mine', 'rail', 'craig', 'trapper', 'mine-mouth'],
    camera: { center: [-107.64, 40.455], zoom: 12.2 },
    state: {
      layersOn: ['eia-generators', 'railroads', 'mines', 'hifld-transmission-lines'],
      // HIFLD names the circuits leaving the plant; the OSM copy would double them.
      layersOff: ['osm-transmission-lines'],
      // The open pits and the plant read best from the air.
      basemap: 'aerial',
      legendFilters: { fuel: ['coal'] },
      style: {
        'eia-generators': { size: 1.6 },
        mines: { size: 1.6 },
        railroads: { color: '#facc15', size: 1.5 },
      },
    },
    highlights: [
      { label: 'Craig Station', coordinates: [-107.5878, 40.4736], description: 'Three coal units, ~1.3 GW, retiring through 2028.' },
      { label: 'Trapper Mine', coordinates: [-107.6300, 40.4400], description: 'Surface mine feeding the station directly.' },
    ],
  },

  // ── Load & industrial demand ───────────────────────────────────────────────
  {
    id: 'industrial-load-centers',
    title: 'Data Center Alley',
    category: 'load',
    summary: 'Northern Virginia packs gigawatts of round-the-clock digital load into a few counties.',
    narrative:
      'Each purple circle is a data center, sized by floor area where it is known. The cluster around Ashburn ' +
      'in Loudoun County is the densest concentration of data centers in the world, and a second one has grown ' +
      'around Manassas and Gainesville in Prince William County. The dots are substations and the coloured ' +
      'lines are transmission, red for 500 kV. Follow them and you can see how closely new substations have ' +
      'followed the campuses.',
    takeaways: [
      'A single campus can draw from 300 MW to more than 1 GW, the load of a mid-sized city.',
      'Most campuses are fed from two directions, so they ride through the loss of one line.',
      'In Northern Virginia, the wait for a grid connection, not construction, now sets when a new campus can open.',
    ],
    keywords: ['data center', 'load', 'virginia', 'loudoun', 'ashburn'],
    camera: { center: [-77.58, 38.92], zoom: 9.9 },
    state: {
      layersOn: ['osm-datacenters', 'hifld-substations', 'osm-substations-polygons', 'hifld-transmission-lines'],
      layersOff: ['osm-transmission-lines'],
      basemap: 'dark',
    },
  },

  // ── Bulk transmission ──────────────────────────────────────────────────────
  {
    id: 'wecc-paths-and-plans',
    title: 'WECC Paths & Planned Regional Transmission',
    category: 'transmission',
    summary: 'Rated transfer paths across the West, with the lines planned to widen them.',
    narrative:
      'The numbered yellow badges are WECC Paths: corridors with a formally rated transfer limit, set by ' +
      'thermal, voltage and stability studies. The dashed lines are the Western Transmission Expansion ' +
      "Coalition's 10-year plan, coloured by dataset (planned projects or identified upgrades), and the grey " +
      "lines are today's 300 kV and higher network. Most planned lines run alongside an existing path: each one" +
      ' raises a specific limit, such as the paths out of Wyoming or into the Desert Southwest.',
    takeaways: [
      'A path rating reflects stability limits across mountains and deserts, not only the size of the conductor.',
      'New 500 kV AC and HVDC lines are designed to carry Wyoming wind and desert solar to coastal load.',
      'Click a badge or a dashed line for its details.',
    ],
    keywords: ['wecc', 'paths', 'westtec', 'planned', 'transwest', 'sunzia'],
    camera: { center: [-115.5, 40.3], zoom: 4.8 },
    state: {
      layersOn: ['wecc-paths', 'westtec-10yr'],
      basemap: 'light',
      westtecColorBy: 'dataset',
      // Today's 300 kV+ network as a quiet base under the planned lines.
      legendFilters: { kv: BACKBONE_KV },
      style: { 'osm-transmission-lines': { color: '#475569', opacity: 0.85, size: 1.3 } },
    },
  },

  // ── Interconnections ───────────────────────────────────────────────────────
  {
    id: 'interconnections-dc-seams',
    title: 'The Interconnections & the Great DC Seams',
    category: 'interconnections',
    summary: 'Three grids that run out of step, and the few DC links that join them.',
    narrative:
      'North America runs as three separate AC grids, the Western Interconnection, the Eastern Interconnection ' +
      'and ERCOT, plus Quebec and Alaska. The blue area is WECC, the Western Interconnection, and the red one ' +
      'is Texas RE, which covers ERCOT; everything untinted is the Eastern Interconnection. Because the grids ' +
      'are not synchronised, power crosses between them only through DC converters. Follow the edge of the blue ' +
      'down the Plains: the dark 300 kV and higher lines thin out on both sides, and the few ties across it are ' +
      'back-to-back converters with no line at all, listed below. The orange lines are long-distance DC lines ' +
      'inside one grid.',
    takeaways: [
      'Only about 1,300 MW of tie capacity crosses the whole East-West seam.',
      'That limit is why a Plains wind surplus cannot follow the evening peak east or west.',
      'Click a pin below to fly to a back-to-back tie on the seam.',
    ],
    keywords: ['interconnection', 'seam', 'hvdc', 'ercot', 'eastern', 'western', 'asynchronous'],
    camera: { center: [-102.5, 38.5], zoom: 4.5 },
    state: {
      // Only the two NERC regions that match the smaller grids are tinted; the rest reads as Eastern.
      layersOn: ['nerc-regions', 'hifld-transmission-lines'],
      basemap: 'light',
      legendFilters: { kv: BACKBONE_KV, nerc: ['WECC', 'TRE'] },
      style: {
        'nerc-regions': { opacity: 0.6 },
        'osm-transmission-lines': { color: '#334155', opacity: 0.85, size: 1.2 },
        // The DC lines in front, in one strong colour.
        'hifld-transmission-lines': { color: '#f97316', size: 4 },
      },
      where: { 'hifld-transmission-lines': [{ field: 'VOLT_CLASS', op: '=', value: 'DC' }] },
    },
    highlights: [
      { label: 'Stegall (Nebraska)', coordinates: [-103.6300, 41.8300], description: 'Back-to-back HVDC tie across the East-West seam.' },
      { label: 'Lamar (Colorado)', coordinates: [-102.6200, 38.0800], description: '210 MW back-to-back converter station.' },
      { label: 'Blackwater (New Mexico)', coordinates: [-103.2000, 34.4000], description: '200 MW East-West tie near Clovis.' },
    ],
  },
  {
    id: 'pacific-hvdc-intertie',
    title: 'The Pacific DC Intertie (Path 65)',
    category: 'interconnections',
    summary: '846 miles of ±500 kV DC moving Northwest hydro to Los Angeles, and power back north in winter.',
    narrative:
      'The orange line is the Pacific DC Intertie (Path 65): 846 miles of ±500 kV direct current from the ' +
      'Celilo converter station on the Columbia River to Sylmar in Los Angeles, rated at about 3,100 MW. In ' +
      'spring and summer it carries surplus Northwest hydro south for the California peak; in winter the flow ' +
      'often reverses. Path 66, the AC California-Oregon Intertie, runs to its west, and together the two carry' +
      ' most of the seasonal exchange in the West.',
    takeaways: [
      'Beyond roughly 400 miles, DC loses less power than AC and needs fewer conductors.',
      'A DC link decouples its two ends: a disturbance on one side does not travel through it as it would on an AC line.',
      'Exchange between a hydro-heavy region and a heat-driven one lets both build less for their own peaks.',
    ],
    keywords: ['hvdc', 'pacific intertie', 'path 65', 'celilo', 'sylmar', 'dc'],
    camera: { center: [-123.0, 39.6], zoom: 5.0 },
    state: {
      layersOn: ['hifld-transmission-lines', 'wecc-paths'],
      basemap: 'light',
      legendFilters: { kv: BACKBONE_KV },
      style: {
        'osm-transmission-lines': CONTEXT_LINE,
        'hifld-transmission-lines': { color: '#f97316', size: 3.5 },
      },
      // The DC intertie in front of the AC network it parallels.
      where: { 'hifld-transmission-lines': [{ field: 'VOLT_CLASS', op: '=', value: 'DC' }] },
    },
    highlights: [
      { label: 'Celilo Converter Station', coordinates: [-121.1000, 45.6300], description: 'Northern terminal, near The Dalles, Oregon.' },
      { label: 'Sylmar Converter Station', coordinates: [-118.4800, 34.3100], description: 'Southern terminal, Los Angeles.' },
    ],
  },
  {
    id: 'ercot-island-grid',
    title: 'ERCOT: The Texas Island Grid',
    category: 'interconnections',
    summary: 'Most of Texas runs on its own interconnection, tied to its neighbours only through a few DC links.',
    narrative:
      'ERCOT runs the grid for most of Texas as an interconnection of its own, tied to the Eastern grid and to ' +
      'Mexico only through a few DC links. Here the Area filter keeps the plants and lines inside the ERCOT ' +
      'balancing authority, and a voltage condition keeps only lines of 345 kV and above, the top voltage of ' +
      'the ERCOT backbone. The soft colours around it are the neighbouring balancing authorities, which the ' +
      'Area filter leaves drawn.',
    takeaways: [
      'Parts of Texas sit outside ERCOT: El Paso is in the Western Interconnection, and the Panhandle and parts of East Texas are in the Eastern.',
      'Because ERCOT stays within one state, its wholesale market and transmission rates are regulated by the Public Utility Commission of Texas rather than FERC.',
      '345 kV is the top voltage of the ERCOT backbone, which reaches from the load centres to the wind and solar of West Texas.',
      'The Area filter in the layer panel sets the region; clear it there to bring the neighbouring grids back.',
    ],
    keywords: ['ercot', 'texas', 'island', 'dc tie', 'balancing authority', '345 kv', 'area'],
    camera: { center: [-101.3, 31.2], zoom: 5.5 },
    state: {
      layersOn: ['hifld-transmission-lines', 'eia-generators', 'eia-ba'],
      // The OSM network draws every voltage; HIFLD carries the 345 kV condition.
      layersOff: ['osm-transmission-lines'],
      basemap: 'light',
      where: { 'hifld-transmission-lines': [{ field: 'VOLTAGE', op: '>=', value: 345 }] },
      area: { kind: 'ba', codes: ['ERCO'] },
      // Smaller, fainter plant markers leave the 345 kV lines in front.
      style: {
        'eia-generators': { opacity: 0.5, size: 0.5 },
        // The neighbours stay as soft context around the island.
        'eia-ba': { opacity: 0.35 },
        'hifld-transmission-lines': { size: 1.4 },
      },
    },
  },

  // ── Land, siting & jurisdictions ───────────────────────────────────────────
  ...(import.meta.env.DEV ? [TRANSMISSION_SITING] : []),
  {
    id: 'retail-utility-jurisdictions',
    title: 'Co-ops & Public Power: Who Owns the Wires Outside the Cities',
    category: 'land',
    summary: 'Member-owned co-ops and public power districts serve most of rural America; investor-owned utilities serve most of its people.',
    narrative:
      'Coloured areas are utilities that are not investor-owned: green cooperatives, owned by the customers ' +
      'they serve; orange municipal utilities; purple public power, such as the public power districts that ' +
      'serve all of Nebraska and Salt River Project around Phoenix. Most co-ops were founded in the 1930s and ' +
      '1940s with federal Rural Electrification Administration loans, when investor-owned utilities found it ' +
      'unprofitable to run lines to farms. The white areas are mostly investor-owned territory: the big cities ' +
      'and the corridors between them.',
    takeaways: [
      "Cooperatives serve about one American in eight but cover more than half of the country's land.",
      'A co-op or a municipal utility sets its rates through a board its customers elect; in most states the utility commission does not review them.',
      'Few customers per mile of line makes rural service costly, which is why co-ops band together in generation-and-transmission co-ops they own jointly.',
      'In the Utility type legend, switch on investor-owned to fill in the rest of the patchwork.',
    ],
    keywords: ['retail', 'utility', 'coop', 'municipal', 'iou', 'territory', 'rates'],
    camera: { center: [-97.5, 38.8], zoom: 4.2 },
    state: {
      layersOn: ['retail-territories'],
      layersOff: ['osm-transmission-lines'],
      basemap: 'light',
      // Investor-owned off: its territories overlap the others', and the colours mix into mud.
      legendFilters: { retail: ['coop', 'muni', 'public'] },
      style: { 'retail-territories': { opacity: 0.8 } },
    },
  },

  // ── Grid conditions & hazards ──────────────────────────────────────────────
  {
    id: 'wildfires-and-smoke',
    title: 'Wildfire Threat: Active Perimeters & Smoke',
    category: 'hazards',
    summary: 'Live fires and smoke against the high-voltage corridors they threaten.',
    narrative:
      'Fire icons are active incidents, coloured by containment from red (little contained) to green (mostly ' +
      'contained); outlines are fire perimeters, and the orange glow is satellite-detected heat from the last ' +
      "24 hours. Smoke from NOAA's daily analysis shades the areas downwind. The light grey lines are the 300 " +
      'kV and higher corridors: a fire need not reach a line to threaten it, since heavy smoke can cause ' +
      'flashover and utilities may switch lines off ahead of a fire.',
    takeaways: [
      'Dense smoke and ash can make an energized line flash over without the fire reaching the right-of-way.',
      'A Public Safety Power Shutoff is a planned outage: the utility trades service for a lower chance of starting a fire.',
      'Hotspots update several times a day from satellite passes; perimeters and incidents update as fire agencies report them.',
      'This view is live: a quiet map means a quiet fire season. Zoom out to find fires elsewhere.',
    ],
    keywords: ['wildfire', 'fire', 'smoke', 'psps', 'live'],
    // The whole West: a live story cannot know in advance where the fires will be.
    camera: { center: [-109.0, 40.0], zoom: 4.3 },
    state: {
      layersOn: ['wildfire-live', 'wildfire-smoke', 'wildfire-incidents'],
      basemap: 'dark',
      smokeOpacity: 0.6,
      legendFilters: { kv: BACKBONE_KV },
      style: {
        'osm-transmission-lines': { color: '#cbd5e1', opacity: 0.85, size: 1.3 },
        'wildfire-incidents': { size: 0.7 },
      },
    },
  },
  {
    id: 'wildfire-hazard-potential',
    title: 'Wildfire Hazard Potential & Grid Hardening',
    category: 'hazards',
    summary: "The Forest Service's long-run fire hazard model, read against the rights-of-way that cross it.",
    narrative:
      "This is the US Forest Service's Wildfire Hazard Potential: a long-run estimate of where a fire would be " +
      'hardest to contain, from green (very low) through yellow to red (very high). It says nothing about what ' +
      'is burning today. The dark lines are transmission at 200 kV and above. Where a right-of-way crosses long' +
      " runs of red, in the Sierra foothills, the coast ranges and Southern California's mountains, utilities " +
      'weigh undergrounding, covered conductor, vegetation clearing and camera detection.',
    takeaways: [
      'Undergrounding removes ignition risk but costs several million dollars per mile in mountainous terrain.',
      'Covered conductor and fast-trip settings are cheaper and applied across far more miles of line.',
      "Pair this view with the live wildfire story to set the model against today's fires.",
    ],
    keywords: ['whp', 'hazard', 'wildfire', 'hardening', 'undergrounding', 'sierra'],
    camera: { center: [-121.0, 37.6], zoom: 5.6 },
    state: {
      layersOn: ['usfs-wildfire-potential'],
      basemap: 'light',
      hillshade: true,
      // Dark backbone lines over the hazard wash, so a right-of-way reads across red.
      legendFilters: { kv: ['550+', '500-549', '300-499', '200-299'] },
      style: {
        'usfs-wildfire-potential': { opacity: 0.65 },
        'osm-transmission-lines': { color: '#0f172a', opacity: 0.85, size: 1.2 },
      },
    },
  },
  {
    id: 'live-outages-and-radar',
    title: 'Extreme Storm Response: Live Outages & Radar',
    category: 'hazards',
    summary: 'Radar, active weather warnings and customers without power, county by county, right now.',
    narrative:
      'Radar shows precipitation now, from light green to red in the heaviest cells. The outlined areas are ' +
      'active National Weather Service warnings, and counties are shaded by customers without power, from ' +
      'yellow (under 100) to dark red (5,000 or more). Read them together: where a storm line has passed, ' +
      'outage counts climb behind it. The faint lines are the 300 kV and higher backbone, which storms rarely ' +
      'take down; most outages start on local distribution lines.',
    takeaways: [
      'Distribution damage, not transmission damage, causes the overwhelming majority of customer-minutes lost.',
      'Outage reporting lags the storm by tens of minutes — the radar leads, the counties follow.',
      'Warning polygons are issued per hazard type, so a county can carry several at once.',
    ],
    keywords: ['outage', 'odin', 'radar', 'nexrad', 'storm', 'nws', 'alerts', 'live'],
    camera: { center: [-93.0, 35.5], zoom: 4.6 },
    state: {
      layersOn: ['odin-outages', 'nexrad-radar', 'nws-alerts'],
      basemap: 'dark',
      legendFilters: { kv: BACKBONE_KV },
      style: { 'osm-transmission-lines': { color: '#94a3b8', opacity: 0.8, size: 1.2 } },
    },
  },
  {
    id: 'live-temperature-grid-load',
    title: 'Live Temperature & Grid Peak Demand',
    category: 'hazards',
    summary: 'The forecast temperature field, the closest thing there is to a forecast of peak demand.',
    narrative:
      'The wash is the latest GFS forecast of air temperature near the ground: the warmer the colour, the ' +
      'hotter the air. Drag the time bar to step through the forecast. Electricity demand follows temperature ' +
      'closely, with air conditioning in summer heat and electric heating in winter cold, so this is close to a' +
      " map of tomorrow's peak. The dark lines are the 300 kV and higher backbone: lines carry less in hot " +
      'weather, so the hours of greatest need are the hours of least capacity.',
    takeaways: [
      'Air conditioning load rises non-linearly above about 25 °C, so the last few degrees add the most megawatts.',
      'Thermal line ratings fall as ambient temperature rises — capacity shrinks exactly when demand peaks.',
      'Winter peaks stress the gas system and the grid at the same time, since both draw on the same fuel.',
    ],
    keywords: ['temperature', 'weather', 'peak', 'demand', 'forecast', 'heat', 'live'],
    camera: { center: [-99.0, 38.6], zoom: 4.1 },
    state: {
      layersOn: ['weather-live'],
      basemap: 'light',
      weatherVar: 'temp',
      legendFilters: { kv: BACKBONE_KV },
      style: { 'osm-transmission-lines': CONTEXT_LINE },
    },
  },
];

export const experienceById = (id: string): MapExperience | null =>
  EXPERIENCES.find(e => e.id === id) ?? null;
