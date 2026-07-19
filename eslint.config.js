// @ts-check
import eslintComments from '@eslint-community/eslint-plugin-eslint-comments';
import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import vitest from '@vitest/eslint-plugin';
import tseslint from 'typescript-eslint';

/**
 * Flat ESLint config for the paintclash monorepo (spec §9.4, §9.6).
 *
 * Lint is a build-breaking **error**, not a warning. Escape hatches are only
 * allowed with a written justification (`ban-ts-comment`,
 * `eslint-comments/require-description`). `.only` in tests is forbidden.
 */
export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      'coverage/**',
      '**/.wrangler/**',
      'playwright-report/**',
      'test-results/**',
      '.scratch/**',
      'docs/**',
    ],
  },

  // Typed linting for all package source (spec §5.1) — benches/spikes included.
  {
    files: ['packages/**/*.ts', 'bench/**/*.ts'],
    extends: [
      js.configs.recommended,
      ...tseslint.configs.strictTypeChecked,
      ...tseslint.configs.stylisticTypeChecked,
    ],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      '@eslint-community/eslint-comments': eslintComments,
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/ban-ts-comment': [
        'error',
        {
          'ts-expect-error': 'allow-with-description',
          'ts-ignore': true,
          'ts-nocheck': true,
          'ts-check': false,
          minimumDescriptionLength: 5,
        },
      ],
      '@eslint-community/eslint-comments/require-description': ['error', { ignore: [] }],
      '@eslint-community/eslint-comments/no-unused-disable': 'error',
      // §9.6: eslint-disable only line-by-line — forbid blanket file-level disables.
      '@eslint-community/eslint-comments/no-unlimited-disable': 'error',
    },
  },

  // Bench code indexes flat number arrays in hot loops; under
  // `noUncheckedIndexedAccess` the `arr[i]!` idiom is the readable form there
  // (the stylistic non-nullable-type-assertion-style rule even rewrites the
  // `as` alternative into `!`). Production packages keep the strict ban.
  {
    files: ['bench/**/*.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },

  // No focused/skipped-without-reason tests — `forbidOnly` enforced at lint time.
  {
    files: ['packages/**/*.test.ts', 'bench/**/*.test.ts'],
    plugins: { vitest },
    rules: {
      'vitest/no-focused-tests': 'error',
    },
  },

  // E2E/integration tests live outside packages (no tsconfig project) — lint them
  // untyped. A stray `.only` is separately caught by Playwright `forbidOnly`.
  {
    files: ['tests/**/*.ts'],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
  },

  // Prettier owns formatting — turn off conflicting stylistic rules last.
  prettier,
);
