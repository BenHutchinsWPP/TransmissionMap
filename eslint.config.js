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

// The map chat and the linked-services UI set model, tool and service text as
// text only (textContent, append, attributes): an HTML sink there would let a model's answer or a feature
// name run as markup, next to a saved OpenRouter key.
const CHAT_FILES = [
  'assets/agent/**/*.ts', 'assets/ui/ui-chat.ts', 'assets/ui/chat-markdown.ts','assets/ui/ui-chart.ts', 'assets/chart-spec.ts',
  'assets/ui/ui-services.ts', 'assets/ui/ui-linked-services.ts', 'assets/ui/services-dom.ts', 'assets/ui/notice-dialog.ts',
  'assets/ui/ui-canvas.ts', 'assets/ui/ui-templates.ts', 'assets/ui/ui-proximity.ts', 'assets/ui/ui-grid-ops.ts', 'assets/sandbox/canvas-host.ts', 'assets/templates/template-actions.ts',
];
const HTML_SINKS = [
  {
    selector: "AssignmentExpression > MemberExpression.left[property.name=/^(innerHTML|outerHTML)$/]",
    message: 'The map chat builds DOM as text: use createElement + textContent (or append a string), never innerHTML/outerHTML.',
  },
  {
    selector: "CallExpression[callee.property.name=/^(insertAdjacentHTML|createContextualFragment|parseFromString|write|writeln)$/]",
    message: 'The map chat builds DOM as text: no HTML-parsing calls.',
  },
];

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
    files: CHAT_FILES,
    ignores: ['**/*.test.ts'],
    rules: { 'no-restricted-syntax': ['error', MAP_INPUT_SEAM, SHOW_LAYER_SEAM, ...HTML_SINKS] },
  },
  {
    files: SHOW_LAYER_OWNERS,
    rules: { 'no-restricted-syntax': ['error', MAP_INPUT_SEAM] },
  },
  {
    files: ['assets/map-input.ts'],
    rules: { 'no-restricted-syntax': ['error', SHOW_LAYER_SEAM] },
  },
  // Page-owned html templates and their kit run in the canvas frame as classic
  // scripts and set params (model text) and feature values as text only.
  {
    files: ['assets/templates/html/**/*.js'],
    languageOptions: {
      sourceType: 'script',
      globals: {
        ...globals.browser,
        ...Object.fromEntries(['TM', 'TM_INPUT', 'Kit', 'd3', 'vega', 'vegaLite', 'maplibregl', 'deck', 'turf', 'Plot'].map(g => [g, 'readonly'])),
      },
    },
    rules: {
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',
      'no-restricted-properties': ['error',
        ...['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'createContextualFragment', 'parseFromString', 'srcdoc', 'setHTMLUnsafe'].map(property => ({
          property, message: 'Templates build DOM with createElement + textContent; no HTML sinks.',
        })),
        { object: 'document', property: 'write', message: 'Templates build DOM with createElement + textContent.' },
        { object: 'document', property: 'writeln', message: 'Templates build DOM with createElement + textContent.' },
      ],
      'no-restricted-syntax': ['error',
        { selector: "CallExpression[callee.name='eval']", message: 'No eval in a template.' },
        { selector: "NewExpression[callee.name='Function'], CallExpression[callee.name='Function']", message: 'No new Function in a template.' },
        { selector: "CallExpression[callee.property.name='html']", message: "A library's .html() sets innerHTML: use .text() or textContent." },
      ],
    },
  },
  { ignores: ['dist/', 'node_modules/', 'venv/', 'scripts/'] },
];
