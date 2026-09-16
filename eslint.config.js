import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['coverage'] },
  js.configs.recommended,
  {
    files: ['**/*.js', '**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node, ...globals.es2022 },
    },
    rules: {
      'no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          // This codebase strips a field via `const { secret, ...rest } = obj`
          // in several places (deployment.service.js's commercial-field
          // stripping) — the destructured-and-discarded key is the point of
          // the pattern, not dead code.
          ignoreRestSiblings: true,
        },
      ],
    },
  },
  {
    files: ['**/*.test.js', 'test/**/*.js'],
    languageOptions: {
      globals: { ...globals.node, ...globals.vitest },
    },
  },
];
