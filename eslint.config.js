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
  { ignores: ['dist/', 'node_modules/', 'venv/', 'scripts/'] },
];
