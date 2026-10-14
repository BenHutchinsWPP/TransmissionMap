import js from '@eslint/js';
import globals from 'globals';
import ts from 'typescript-eslint';


// assets/map-input.ts normalises mouse and touch into one set of map events;
// every other module subscribes through it rather than to MapLibre directly.
const MAP_INPUT_SEAM = {
  selector: "CallExpression[callee.property.name=/^(on|once|off)$/][arguments.0.value=/^(click|dblclick|contextmenu|mousedown|mouseup|mousemove|mouseover|mouseout|mouseenter|mouseleave|touchstart|touchmove|touchend|touchcancel)$/]",
  message: 'Subscribe through assets/map-input.ts (onMapTap / onMapDoubleTap / onMapPoint / onMapHover / onMapContextMenu) — it is what carries these to touch as well as to a mouse.',
};

// setMapLayerVisibility() in assets/layers/layer-plan.ts gives a held-back
// PMTiles source its url on first show; these modules own their own sources.
const SHOW_LAYER_OWNERS = [
  'assets/layers/layer-plan.ts',
  'assets/hover.ts',
  'assets/terrain.ts',
  'assets/basemap.ts',
  'assets/user-data/user-data.ts',
  'assets/highlights.ts',
];
const SHOW_LAYER_SEAM = {
  selector: "CallExpression[callee.property.name='setLayoutProperty'][arguments.1.value='visibility']",
  message: 'Show or hide a style layer with setMapLayerVisibility() from assets/layers/layer-plan.ts — it reads a held-back PMTiles archive on first show; a raw visibility change draws nothing there.',
};

export default [
  js.configs.recommended,
  ...ts.configs.recommended,
  {
    languageOptions: { globals: { ...globals.browser, ...globals.es2022 } },
    rules: {
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
      '@typescript-eslint/no-unused-expressions': ['error', { allowTernary: true }],
      'no-console': 'off',
    },
  },
  // No-restricted-syntax settings replace rather than merge across blocks, so
  // each block below lists every restriction that applies to its files.
  {
    files: ['assets/**/*.ts', 'src/**/*.ts'],
    ignores: ['assets/map-input.ts', ...SHOW_LAYER_OWNERS, '**/*.test.ts'],
    rules: { 'no-restricted-syntax': ['error', MAP_INPUT_SEAM, SHOW_LAYER_SEAM] },
  },
  {
    files: SHOW_LAYER_OWNERS,
    rules: { 'no-restricted-syntax': ['error', MAP_INPUT_SEAM] },
  },
  {
    files: ['assets/map-input.ts'],
    rules: { 'no-restricted-syntax': ['error', SHOW_LAYER_SEAM] },
  },
  { ignores: ['dist/', 'node_modules/', 'venv/', 'scripts/'] },
];
