/**
 * Lint configuration.
 *
 * `eslint-config-next` ships a flat-config array in v16, so it is spread
 * directly. The extra rules below encode two of the playbook's coding rules
 * (23) as machine-checkable constraints rather than review notes:
 *
 *  - no `any` in the codebase at all, so an audio or domain contract cannot
 *    quietly lose its type;
 *  - no stray `console.log`, so debugging output cannot ship. `warn` and
 *    `error` remain available for the places that genuinely need them, and the
 *    two intentional uses (an audit line on delete, one analytics dev warning)
 *    are individually annotated.
 */
import next from 'eslint-config-next';
import tseslint from 'typescript-eslint';

const config = [
  {
    ignores: [
      '.next/**',
      'node_modules/**',
      'coverage/**',
      'out/**',
      'playwright-report/**',
      'test-results/**',
      'reference/**',
      'public/**',
      // Not JavaScript projects. `vendor/` is pinned upstream source we do not
      // author, and `services/` is the Python Musician service.
      'vendor/**',
      'services/**',
      'models/**',
    ],
  },
  ...next,
  {
    files: ['**/*.ts', '**/*.tsx', '**/*.mts'],
    plugins: { '@typescript-eslint': tseslint.plugin },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      'no-console': ['warn', { allow: ['warn', 'error', 'info'] }],
    },
  },
];

export default config;
