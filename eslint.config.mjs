// ESLint for the DE backend (#92, VC-X-03): typescript-eslint's type-checked recommendations, plus the rules that
// carry weight here: no unused code, no floating promise (nearly every route returns one), type-only imports.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

// VC-X-65 (Zod 4): the zod parts whose rules differ from Zod 3 in what a client sees are used through
// `shared/zod3.ts`, which keeps Zod 3's rules (a transform's aborting, integers, numbers, array bounds).
const ZOD3 = [
  {
    selector: "CallExpression[callee.property.name='transform']:not([callee.object.name='zod3'])",
    message: 'Use zod3.transform (shared/zod3.ts, VC-X-65): Zod 4 runs refinements after a failed transform input.',
  },
  { selector: "CallExpression[callee.property.name='int']", message: 'Use zod3.integer (shared/zod3.ts, VC-X-65): Zod 4 aborts at a fraction.' },
  { selector: "CallExpression[callee.object.name='z'][callee.property.name='number']", message: 'Use zod3.number (shared/zod3.ts, VC-X-65).' },
  { selector: "MemberExpression[object.name='z'][property.name='coerce']", message: 'Use zod3.coercedInteger (shared/zod3.ts, VC-X-65).' },
  {
    selector: "CallExpression[callee.object.name='z'][callee.property.name='array']",
    message: 'Use zod3.array (shared/zod3.ts, VC-X-65): Zod 4 stops at a maximum.',
  },
];

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', '.yarn/**', '**/e2e-results/**'] },
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
    files: ['services/de-backend/src/**/*.ts'],
    ignores: ['services/de-backend/src/shared/zod3.ts', '**/*.test.ts', '**/*.test-support.ts'],
    rules: { 'no-restricted-syntax': ['error', ...ZOD3] },
  },
  {
    // VC-X-61 (api-design.md §58W): `readQuery` in validation.ts is the only reader of a request's query; a route that
    // read `req.query` itself would bypass the refusal of unknown and repeated parameters. VC-X-69 (§58X): the same for
    // `readBody` and a request's body (its strictness check and the naming of unknown fields). VC-X-66: `jsonBody` the
    // only body parser, so every command parses as under Express 4.
    files: ['services/de-backend/src/api/**/*.ts'],
    ignores: ['services/de-backend/src/api/validation.ts', '**/*.test.ts', '**/*.test-support.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        { selector: "MemberExpression[property.name='query']", message: 'Read the query with readQuery (validation.ts, §58W).' },
        { selector: "MemberExpression[property.value='query']", message: 'Read the query with readQuery (validation.ts, §58W).' },
        { selector: "ObjectPattern > Property[key.name='query']", message: 'Read the query with readQuery (validation.ts, §58W).' },
        { selector: "MemberExpression[property.name='body']", message: 'Read the body with readBody (validation.ts, §58X).' },
        { selector: "MemberExpression[property.value='body']", message: 'Read the body with readBody (validation.ts, §58X).' },
        { selector: "ObjectPattern > Property[key.name='body']", message: 'Read the body with readBody (validation.ts, §58X).' },
        // VC-X-66: Express 5's body parsers leave no body `undefined`; `jsonBody` keeps Express 4's answers.
        {
          selector: "MemberExpression[object.name='express'][property.name=/^(json|urlencoded|raw|text)$/]",
          message: 'Parse a JSON body with jsonBody (validation.ts, VC-X-66).',
        },
        ...ZOD3,
      ],
    },
  },
  {
    // The cockpit UI writes nothing to the browser console: no token, no bank data, no whole server answer reaches it
    // (ui-guide.md §11).
    files: ['webapps/**/*.ts', 'webapps/**/*.tsx'],
    rules: { 'no-console': 'error' },
  },
  { files: ['**/*.mjs', '**/*.js'], ...tseslint.configs.disableTypeChecked },
  {
    // Repository scripts and this config run on Node: its globals, without a dependency on the `globals` package.
    files: ['scripts/**/*.mjs', 'eslint.config.mjs'],
    languageOptions: { globals: { console: 'readonly', process: 'readonly', URL: 'readonly' } },
  },
);
