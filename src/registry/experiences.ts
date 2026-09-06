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
// Deps: none (types only).

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
    ogfColorBy?: 'status' | 'scenario' | 'planauth';
    westtecColorBy?: 'scenario' | 'dataset';
    weatherVar?: string;        // WEATHER_VARIABLES id
    smokeOpacity?: number;      // 0–1
    terrain3d?: boolean;        // forces mercator — terrain and globe don't mix
    hillshade?: boolean;
  };
  highlights?: ExperienceHighlight[];
}

// Above this the Esri aerial imagery runs out over most of the country and the
// USGS NAIP fallback returns blank tiles, so aerial stories stop here.
export const AERIAL_MAX_ZOOM = 15.5;

export const EXPERIENCES: MapExperience[] = [
  // ── Generation & fuel supply ───────────────────────────────────────────────
  {
    id: 'columbia-hydro',
    title: 'Columbia & Snake River Hydro System',
    category: 'generation',
    summary: 'Cascading federal dams turn one river basin into the largest dispatchable renewable engine in North America.',
    narrative:
      'The Pacific Northwest hydro system is the most powerful renewable energy engine on the continent. ' +
      'Cascading federal dams along the Columbia and Snake rivers deliver massive dispatchable energy and grid ' +
      'stability, gathered onto 500 kV transmission that reaches from the Canadian border to Southern California. ' +
      'Tilt the view to see how elevation head — the drop between one reservoir and the next — sets where each ' +
      'powerhouse sits.',
    takeaways: [
      'Cascading elevation drops let the same water volume generate power again and again on its way downriver.',
      'Grand Coulee and Chief Joseph supply frequency response and black-start capability for the whole Western Interconnection.',
      'Reservoir storage makes the basin a seasonal battery: spring runoff is shaped to meet summer and winter peaks.',
    ],
    keywords: ['hydro', 'dam', 'columbia', 'snake', 'bpa', 'bonneville', 'grand coulee'],
    camera: { center: [-119.3277, 46.8716], zoom: 6.9, pitch: 45 },
    state: {
      layersOn: ['eia-generators', 'osm-plants-points'],
      // Transmission is on by default; the story is about the dams themselves,
      // so the network is cleared to leave the river basin legible.
      layersOff: ['osm-transmission-lines', 'hifld-substations'],
      basemap: 'hydro',
      legendFilters: { fuel: ['hydro', 'pumped_storage'] },
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
    summary: 'Crustal heat flow explains why geothermal plants cluster where they do — and nowhere else.',
    narrative:
      'Geothermal power is geologically constrained. Comparing crustal heat-flow measurements with operating ' +
      'generation shows the plants tracking active extensional faulting through the Nevada Basin and Range, ' +
      "California's Imperial Valley, and The Geysers north of San Francisco. Where the heat is shallow, the " +
      'resource is drillable; a few hundred kilometres east, the same technology has nothing to work with.',
    takeaways: [
      'The Geysers in Northern California is the largest geothermal complex in the world.',
      'Baseload 24/7 clean generation needs colocation with a shallow high-temperature crustal anomaly.',
      'Identified hydrothermal systems mark the near-term drilling frontier; the heat-flow wash marks the long-term one.',
    ],
    keywords: ['geothermal', 'heat flow', 'geysers', 'imperial valley', 'basin and range'],
    camera: { center: [-117.5, 39.5], zoom: 5.5 },
    state: {
      layersOn: ['ihfc-geo-heatflow', 'nrel-hydrothermal-points', 'eia-generators', 'osm-plants-points'],
      basemap: 'topo',
      legendFilters: { fuel: ['geo'] },
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
    summary: 'The richest onshore wind resource in North America sits a thousand miles from the load it could serve.',
    narrative:
      "North America's richest onshore wind corridor runs from the Texas Panhandle to North Dakota. The wind " +
      'resource wash shows where the fuel is; the plants and lines show how little transmission reaches it. ' +
      'That gap between resource and load centre is the single largest transmission expansion challenge in the ' +
      'country.',
    takeaways: [
      'Nighttime wind abundance in the central corridor drives localized negative pricing when export capacity runs out.',
      'The wind belt needs thousands of miles of new high-voltage line to reach coastal and Midwestern demand.',
      'Capacity factors above 45% make these sites competitive even after paying for long-distance delivery.',
    ],
    keywords: ['wind', 'plains', 'texas', 'oklahoma', 'kansas', 'resource'],
    camera: { center: [-99.0, 41.0], zoom: 4.5 },
    state: {
      layersOn: ['nlr-wind-100m', 'eia-generators', 'osm-plants-points', 'hifld-transmission-lines'],
      basemap: 'light',
      legendFilters: { fuel: ['wind'] },
    },
  },
  {
    id: 'thermal-plant-anatomy',
    title: 'Thermal Plant Anatomy: Fuel, Turbine, Switchyard',
    category: 'generation',
    summary: 'A close aerial read of one combined-cycle plant — gas metering, turbine hall, cooling, and the switchyard.',
    narrative:
      'This is the physical infrastructure chain of a combined-cycle natural gas facility at aerial resolution: ' +
      'the high-pressure gas metering station where the pipeline arrives, the turbine hall, the cooling equipment, ' +
      'the step-up transformers, and the switchyard that hands the output to the bulk grid. Every layer on screen ' +
      'is a link in that chain.',
    takeaways: [
      'The gas pipeline and the transmission line are two halves of one fuel-to-electricity conversion.',
      'Step-up transformers lift generator voltage (13.8–24 kV) to bulk transmission voltage (230–500 kV) to cut losses.',
      'Substation footprint, not turbine count, is usually what limits how much a site can export.',
    ],
    keywords: ['gas', 'combined cycle', 'switchyard', 'transformer', 'aerial', 'pipeline'],
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
    summary: 'Craig Station and the Trapper Mine, the classic mine-mouth arrangement, seen end to end.',
    narrative:
      'Craig Station in northwest Colorado is a textbook mine-mouth coal ecosystem. Surface coal comes out of the ' +
      'adjacent Trapper Mine, moves a short distance by conveyor and rail to the boilers, and leaves as electricity ' +
      'on high-voltage circuits crossing the Rockies. Coal economics are mass economics — the shorter the fuel haul, ' +
      'the better the plant competes.',
    takeaways: [
      'Rail access or a direct conveyor is what makes bulk coal economics work, because the fuel is heavy.',
      'Retiring coal plants leave behind high-capacity interconnection rights that solar, storage, and advanced nuclear can reuse.',
      'The mine, the plant, and the switchyard were permitted as one project — which is why they sit within a few miles of each other.',
    ],
    keywords: ['coal', 'mine', 'rail', 'craig', 'trapper', 'mine-mouth'],
    camera: { center: [-107.6014, 40.4589], zoom: 11.5 },
    state: {
      layersOn: ['eia-generators', 'railroads', 'mines', 'hifld-transmission-lines'],
      basemap: 'light',
      legendFilters: { fuel: ['coal'] },
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
    summary: 'Northern Virginia concentrates gigawatts of continuous digital load into a handful of counties.',
    narrative:
      'Loudoun County and its neighbours host the densest concentration of data centers on earth. That digital ' +
      'infrastructure needs gigawatts of continuous power, and it has pulled a matching build-out of transmission ' +
      'substations and 500 kV upgrades in behind it. Watch how tightly the substations track the campuses.',
    takeaways: [
      'A single large campus can demand 500 MW to more than 1 GW — the load of a medium-sized city.',
      'Dual-fed high-voltage supply and redundant substations are table stakes for mission-critical sites.',
      'Interconnection queue position, not construction time, is now the binding constraint on new campuses.',
    ],
    keywords: ['data center', 'load', 'virginia', 'loudoun', 'ashburn'],
    camera: { center: [-77.48, 39.02], zoom: 9.5 },
    state: {
      layersOn: ['osm-datacenters', 'hifld-substations', 'osm-substations-polygons', 'hifld-transmission-lines'],
      basemap: 'light',
    },
  },
  {
    id: 'population-load-density',
    title: 'Continental Load Topography',
    category: 'load',
    summary: 'Where power is consumed, against where it is produced — the case for long-distance transfer in one view.',
    narrative:
      'Population density is the first-order map of electricity demand. Overlaying it with heavy extraction sites ' +
      'and computing hubs shows the mismatch that bulk transmission exists to solve: the load is concentrated on ' +
      'the coasts and around the Great Lakes, while the cheapest new generation is in the interior.',
    takeaways: [
      'Roughly half of US electricity demand sits east of the Mississippi in a fraction of the land area.',
      'Industrial extraction and data centers add large point loads far from the population centres.',
      'Every long-distance transmission proposal is an argument about closing this gap more cheaply than building locally.',
    ],
    keywords: ['population', 'demand', 'density', 'load', 'national'],
    camera: { center: [-93.577, 39.0406], zoom: 4.0 },
    state: {
      layersOn: ['worldpop-pop-density', 'mines', 'osm-datacenters', 'hifld-transmission-lines'],
      basemap: 'light',
      genMode: { 'osm-datacenters': 'clusters' },
    },
  },

  // ── Bulk transmission ──────────────────────────────────────────────────────
  {
    id: 'wecc-paths-and-plans',
    title: 'WECC Paths & Planned Regional Transmission',
    category: 'transmission',
    summary: 'Rated transfer corridors across the West, with the projects proposed to widen them.',
    narrative:
      'The Western Interconnection moves power along established corridors with formally rated transfer limits — ' +
      'the WECC Paths. Laying the planned-project datasets over them shows where utilities intend to add capacity: ' +
      'SunZia, TransWest Express, Boardman-to-Hemingway and the rest are all attempts to relieve a specific rated ' +
      'path.',
    takeaways: [
      'Path ratings encode physical and stability limits across mountain ranges and desert basins, not just conductor size.',
      'New 500 kV AC and ±500 kV DC projects are engineered to move remote Wyoming wind and desert solar to coastal load.',
      'Colouring the planned lines by dataset separates what is under construction from what is still a study.',
    ],
    keywords: ['wecc', 'paths', 'westtec', 'planned', 'transwest', 'sunzia'],
    camera: { center: [-107.4519, 41.5105], zoom: 4.5 },
    state: {
      layersOn: ['wecc-paths', 'westtec-10yr', 'hifld-transmission-lines'],
      basemap: 'light',
      westtecColorBy: 'dataset',
    },
  },

  // ── Interconnections ───────────────────────────────────────────────────────
  {
    id: 'interconnections-dc-seams',
    title: 'The Interconnections & the Great DC Seams',
    category: 'interconnections',
    summary: 'Three asynchronous grids, joined only by a handful of back-to-back HVDC converter stations.',
    narrative:
      'North America is electrically split into three asynchronous grids: the Western Interconnection, the Eastern ' +
      'Interconnection, and ERCOT, plus separate systems in Quebec and Alaska. Because they run out of phase with ' +
      'one another, power crosses between them only through back-to-back HVDC converter stations. Trace the line ' +
      'network and the seam appears as an absence — a north-south band where almost nothing connects.',
    takeaways: [
      'Only about 1,300 MW of transfer capacity exists across the entire East-West seam.',
      'That limit is why a wind surplus in the Plains cannot follow the evening peak eastward.',
      'Proposed HVDC inter-ties are pitched as national-scale arbitrage between Western solar and Plains wind.',
    ],
    keywords: ['interconnection', 'seam', 'hvdc', 'ercot', 'eastern', 'western', 'asynchronous'],
    camera: { center: [-102.5, 38.0], zoom: 4.2 },
    state: {
      layersOn: ['hifld-transmission-lines', 'wecc-paths', 'hifld-substations'],
      basemap: 'light',
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
    summary: '846 miles of ±500 kV DC moving Northwest hydro to Los Angeles, and heat-season power back north.',
    narrative:
      'The Pacific DC Intertie is an 846-mile ±500 kV direct-current corridor from the Celilo converter station on ' +
      'the Columbia River to Sylmar in Los Angeles. It carries up to 3,100 MW of surplus Northwest hydro south for ' +
      'the California summer peak, and reverses to send power north during winter heating peaks. It is the single ' +
      'most consequential seasonal exchange on the Western grid.',
    takeaways: [
      'Long-distance HVDC has far lower line losses than AC beyond roughly 400 miles.',
      'Bidirectional seasonal exchange between a hydro-heavy region and a thermal-heavy one raises the efficiency of both.',
      'A DC line also decouples the two ends electrically — a disturbance on one side does not propagate through the tie.',
    ],
    keywords: ['hvdc', 'pacific intertie', 'path 65', 'celilo', 'sylmar', 'dc'],
    camera: { center: [-119.5, 40.0], zoom: 4.9 },
    state: {
      layersOn: ['hifld-transmission-lines', 'hifld-substations', 'wecc-paths'],
      basemap: 'light',
    },
    highlights: [
      { label: 'Celilo Converter Station', coordinates: [-121.1000, 45.6300], description: 'Northern terminal, near The Dalles, Oregon.' },
      { label: 'Sylmar Converter Station', coordinates: [-118.4800, 34.3100], description: 'Southern terminal, Los Angeles.' },
    ],
  },

  // ── Land, siting & jurisdictions ───────────────────────────────────────────
  {
    id: 'clean-energy-siting-puzzle',
    title: 'The Clean Energy Siting Puzzle',
    category: 'land',
    summary: 'Protected land, tribal jurisdiction and critical habitat over the best solar resource in the country.',
    narrative:
      'Building transmission and utility-scale solar in the American West means threading a jurisdictional ' +
      'patchwork: BLM land, Forest Service wilderness, Department of Defense ranges, tribal reservations, and ' +
      'designated critical habitat for species such as the desert tortoise. The solar resource wash underneath ' +
      'shows what is at stake — this is where the sun is best, and where the constraints are densest.',
    takeaways: [
      'NEPA review and multi-agency permitting commonly run 8–12 years, far longer than the construction itself.',
      'Routing along already-disturbed rights-of-way — highway medians, existing easements — is the usual way through.',
      'Tribal consultation is a sovereign-to-sovereign process, not a permit line item.',
    ],
    keywords: ['siting', 'padus', 'tribal', 'habitat', 'permitting', 'solar', 'blm'],
    camera: { center: [-115.0, 37.0], zoom: 5.0 },
    state: {
      layersOn: ['padus', 'crithab', 'tribal-lands', 'bia-tribal-lands', 'gsa-solar-pvout'],
      basemap: 'light',
    },
  },
  {
    id: 'retail-utility-jurisdictions',
    title: 'Public Power, Co-ops & Investor-Owned Utilities',
    category: 'land',
    summary: 'Who sells you electricity, drawn as territory — and why the rate you pay depends on the line you live behind.',
    narrative:
      'The US retail grid is a fragmented mix of investor-owned utilities, municipal systems, rural electric ' +
      'cooperatives, and federal power marketing administrations such as BPA, TVA and WAPA. Service boundaries ' +
      'are the map of who sets rates, who plans distribution investment, and which regulator hears the case.',
    takeaways: [
      'Cooperatives cover the majority of US land area while serving a small share of customers.',
      'Municipal utilities and PMAs are governed locally or federally, outside state rate-of-return regulation.',
      'Territory boundaries, not physical wires, determine which planning process a new interconnection enters.',
    ],
    keywords: ['retail', 'utility', 'coop', 'municipal', 'iou', 'territory', 'rates'],
    camera: { center: [-94.4334, 39.3193], zoom: 4.14 },
    state: {
      layersOn: ['retail-territories', 'hifld-transmission-lines'],
      basemap: 'light',
    },
  },

  // ── Grid conditions & hazards ──────────────────────────────────────────────
  {
    id: 'wildfires-and-smoke',
    title: 'Wildfire Threat: Active Perimeters & Smoke',
    category: 'hazards',
    summary: 'Live fire perimeters and smoke plumes against the high-voltage corridors they threaten.',
    narrative:
      'Transmission lines through forested corridors are exposed to direct fire damage, to flashover across ' +
      'ionized smoke, and to the Public Safety Power Shutoffs utilities call to avoid starting fires in the first ' +
      'place. This view pairs the live satellite fire feed and the smoke forecast with the bulk power corridors ' +
      'underneath them.',
    takeaways: [
      'Smoke can trigger flashover on an energized line without the fire ever reaching the right-of-way.',
      'PSPS de-energization is a planned outage: the grid trades reliability for ignition risk.',
      'Perimeters update roughly daily; the hotspot feed is closer to real time.',
    ],
    keywords: ['wildfire', 'fire', 'smoke', 'psps', 'live'],
    camera: { center: [-120.5, 42.0], zoom: 5.5 },
    state: {
      layersOn: ['wildfire-live', 'wildfire-smoke', 'wildfire-incidents', 'hifld-transmission-lines'],
      basemap: 'light',
      smokeOpacity: 0.7,
    },
  },
  {
    id: 'wildfire-hazard-potential',
    title: 'Wildfire Hazard Potential & Grid Hardening',
    category: 'hazards',
    summary: "The Forest Service's long-run fire hazard model, read against the rights-of-way that cross it.",
    narrative:
      'Wildfire Hazard Potential is a long-term model of catastrophic fire likelihood, independent of what is ' +
      'burning today. Correlating high-hazard terrain with high-voltage rights-of-way is how utilities decide ' +
      'where undergrounding, covered conductor, vegetation management and camera detection are worth their cost.',
    takeaways: [
      'Undergrounding removes ignition risk but costs several million dollars per mile in mountainous terrain.',
      'Covered conductor and fast-trip settings are the cheaper mitigations applied across far more line-miles.',
      'The hazard model is static; pairing it with the live feeds shows model against outcome.',
    ],
    keywords: ['whp', 'hazard', 'wildfire', 'hardening', 'undergrounding', 'sierra'],
    camera: { center: [-119.5, 37.5], zoom: 5.2 },
    state: {
      layersOn: ['usfs-wildfire-potential', 'hifld-transmission-lines'],
      basemap: 'topo',
      hillshade: true,
    },
  },
  {
    id: 'live-outages-and-radar',
    title: 'Extreme Storm Response: Live Outages & Radar',
    category: 'hazards',
    summary: 'Radar, active weather warnings and reported customer outages, county by county, right now.',
    narrative:
      'This is grid resilience as it happens. As convective storms track across the Southeast, radar ' +
      'precipitation and active National Weather Service warning polygons line up with sudden rises in reported ' +
      'customer outages. The outage counts are joined onto county boundaries, so the damage footprint and the ' +
      'storm footprint can be read against each other directly.',
    takeaways: [
      'Distribution damage, not transmission damage, causes the overwhelming majority of customer-minutes lost.',
      'Outage reporting lags the storm by tens of minutes — the radar leads, the counties follow.',
      'Warning polygons are issued per hazard type, so a county can carry several at once.',
    ],
    keywords: ['outage', 'odin', 'radar', 'nexrad', 'storm', 'nws', 'alerts', 'live'],
    camera: { center: [-90.0, 33.0], zoom: 4.5 },
    state: {
      layersOn: ['odin-outages', 'nexrad-radar', 'nws-alerts', 'hifld-transmission-lines'],
      basemap: 'light',
    },
  },
  {
    id: 'live-temperature-grid-load',
    title: 'Live Temperature & Grid Peak Demand',
    category: 'hazards',
    summary: 'The forecast temperature field, which is the closest thing there is to a forecast of peak demand.',
    narrative:
      'Peak electricity demand tracks temperature extremes almost directly — summer heat domes driving air ' +
      'conditioning, winter cold snaps driving resistive heating and gas system stress. Scrub the forecast ' +
      'and you are watching the demand curve build. Heat also derates the lines themselves, so the hours of ' +
      'greatest need are the hours of least capacity.',
    takeaways: [
      'Air conditioning load rises non-linearly above about 25 °C, so the last few degrees add the most megawatts.',
      'Thermal line ratings fall as ambient temperature rises — capacity shrinks exactly when demand peaks.',
      'Winter peaks stress the gas system and the grid at the same time, since both draw on the same fuel.',
    ],
    keywords: ['temperature', 'weather', 'peak', 'demand', 'forecast', 'heat', 'live'],
    camera: { center: [-95.9661, 39.053], zoom: 4.08 },
    state: {
      layersOn: ['weather-live', 'hifld-transmission-lines'],
      basemap: 'light',
      weatherVar: 'temp',
    },
  },
];

export const experienceById = (id: string): MapExperience | null =>
  EXPERIENCES.find(e => e.id === id) ?? null;
