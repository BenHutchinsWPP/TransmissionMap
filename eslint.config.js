import js from '@eslint/js';
import globals from 'globals';
import ts from 'typescript-eslint';

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
  // assets/map-input.ts normalises mouse and touch into one set of map events;
  // every other module subscribes through it rather than to MapLibre directly.
  {
    files: ['assets/**/*.ts', 'src/**/*.ts'],
    ignores: ['assets/map-input.ts', '**/*.test.ts'],
    rules: {
      'no-restricted-syntax': ['error', {
        selector: "CallExpression[callee.property.name=/^(on|once|off)$/][arguments.0.value=/^(click|dblclick|contextmenu|mousedown|mouseup|mousemove|mouseover|mouseout|mouseenter|mouseleave|touchstart|touchmove|touchend|touchcancel)$/]",
        message: 'Subscribe through assets/map-input.ts (onMapTap / onMapDoubleTap / onMapPoint / onMapHover / onMapContextMenu) — it is what carries these to touch as well as to a mouse.',
      }],
    },
  },
  { ignores: ['dist/', 'node_modules/', 'venv/', 'scripts/'] },
];
