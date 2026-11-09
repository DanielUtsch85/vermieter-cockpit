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
  {
    // VC-X-61 (api-design.md §58W): `readQuery` in validation.ts is the only reader of a request's query; a route that
    // read `req.query` itself would bypass the refusal of unknown and repeated parameters.
    files: ['services/de-backend/src/api/**/*.ts'],
    ignores: ['services/de-backend/src/api/validation.ts', '**/*.test.ts', '**/*.test-support.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        { selector: "MemberExpression[property.name='query']", message: 'Read the query with readQuery (validation.ts, §58W).' },
        { selector: "MemberExpression[property.value='query']", message: 'Read the query with readQuery (validation.ts, §58W).' },
        { selector: "ObjectPattern > Property[key.name='query']", message: 'Read the query with readQuery (validation.ts, §58W).' },
      ],
    },
  },
  { files: ['**/*.mjs', '**/*.js'], ...tseslint.configs.disableTypeChecked },
  {
    // Repository scripts and this config run on Node: its globals, without a dependency on the `globals` package.
    files: ['scripts/**/*.mjs', 'eslint.config.mjs'],
    languageOptions: { globals: { console: 'readonly', process: 'readonly', URL: 'readonly' } },
  },
);
