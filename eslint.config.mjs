// ESLint for the DE backend (#92, VC-X-03): typescript-eslint's type-checked recommendations, plus the rules that
// carry weight here: no unused code, no floating promise (nearly every route returns one), type-only imports.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', '.yarn/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      // `Money` narrows its currency to `never` in the mismatch message while only EUR exists.
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNever: true }],
      // Kysely's expression builder is destructured by design (`({ exists, selectFrom }) => …`); its methods are bound.
      '@typescript-eslint/unbound-method': 'off',
    },
  },
  {
    // Tests: test doubles are `async` without awaiting, and parsed JSON bodies are untyped by nature. The rules that catch
    // real mistakes (unused code, floating promises, type-only imports) stay on.
    files: ['**/*.test.ts', '**/*.test-support.ts'],
    rules: {
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/only-throw-error': 'off',
      '@typescript-eslint/no-base-to-string': 'off',
    },
  },
  { files: ['**/*.mjs', '**/*.js'], ...tseslint.configs.disableTypeChecked },
);
