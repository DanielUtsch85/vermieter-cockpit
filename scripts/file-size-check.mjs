// File-size limit of the backend sources (coding-guidelines.md §3, issue #191): every `.ts` file under services/*/src,
// migrations/ excluded, has at most 600 lines (production) or 900 lines (tests: `*.test.ts`, `*.test-support.ts`).
// `yarn size:check` fails on a file over its limit; CI runs it after lint.
//
// Lines are counted as `wc -l` counts them for a file ending in a newline (Prettier guarantees that): the number of line
// breaks, plus one for a last line without a trailing newline.
//
// EXCEPTIONS lists the files that were over the limit when the check was introduced, with their line count then. A listed
// file may not grow beyond that count; once it is split below the limit, it must be removed from the list (the check fails
// until it is), so the list always names exactly the remaining debt. PERMANENT files carry declarations only and are
// never checked.
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const servicesDir = join(root, 'services');

const PRODUCTION_LIMIT = 600;
const TEST_LIMIT = 900;

// Relative to a service's src/: the schema of all tables, and the re-exports of the application and of each domain.
const PERMANENT = [/^infrastructure\/postgres\/schema\.ts$/, /^application\/index\.ts$/, /^domains\/[^/]+\/index\.ts$/];

// Repository path → line count on main when the check was introduced (2e4da1b; the four depreciation schedule files, split since, at
// 923ad67, after VC-X-33). May shrink, never grow; remove when split.
const EXCEPTIONS = {
  'services/de-backend/src/domains/taxation/classification.ts': 657,
  'services/de-backend/src/domains/taxation/tax-year-view.ts': 865,
  'services/de-backend/src/infrastructure/postgres/tax-weg-repository.test.ts': 1284,
  'services/de-backend/src/infrastructure/postgres/tax-year-repository.test.ts': 1103,
  'services/de-backend/src/phase-2-acceptance.e2e.test.ts': 1063,
};

const countLines = (source) => {
  const breaks = source.split('\n').length - 1;
  return source.length > 0 && !source.endsWith('\n') ? breaks + 1 : breaks;
};
const isTest = (file) => file.endsWith('.test.ts') || file.endsWith('.test-support.ts');

const files = [];
const walk = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'migrations' && entry.name !== 'node_modules') walk(path);
    } else if (entry.name.endsWith('.ts')) {
      files.push(path);
    }
  }
};
for (const service of readdirSync(servicesDir, { withFileTypes: true })) {
  const src = join(servicesDir, service.name, 'src');
  if (service.isDirectory() && existsSync(src)) walk(src);
}

const errors = [];
const seen = new Set();
let checked = 0;
for (const path of files) {
  const file = relative(root, path);
  const inSrc = relative(join(root, file.split('/').slice(0, 3).join('/')), path);
  if (PERMANENT.some((pattern) => pattern.test(inSrc))) continue;
  checked += 1;
  const lines = countLines(readFileSync(path, 'utf8'));
  const limit = isTest(file) ? TEST_LIMIT : PRODUCTION_LIMIT;
  if (file in EXCEPTIONS) {
    seen.add(file);
    const recorded = EXCEPTIONS[file];
    if (lines > recorded) {
      errors.push(`${file}: ${lines} lines, grew beyond its recorded ${recorded} on the exception list. Split it instead of adding to it.`);
    } else if (lines <= limit) {
      errors.push(`${file}: ${lines} lines, now within the limit of ${limit}. Remove it from EXCEPTIONS in scripts/file-size-check.mjs.`);
    }
  } else if (lines > limit) {
    errors.push(`${file}: ${lines} lines, over the limit of ${limit} for ${isTest(file) ? 'a test' : 'a production'} file. Split it.`);
  }
}
for (const file of Object.keys(EXCEPTIONS)) {
  if (!seen.has(file)) errors.push(`${file}: on the exception list but no longer exists. Remove it from EXCEPTIONS in scripts/file-size-check.mjs.`);
}

if (errors.length > 0) {
  console.error(`File-size check failed (limit ${PRODUCTION_LIMIT} lines production, ${TEST_LIMIT} test; coding-guidelines.md §3):`);
  for (const error of errors) console.error(`  ${error}`);
  process.exit(1);
}
console.log(`File-size check passed: ${checked} files, ${Object.keys(EXCEPTIONS).length} listed exceptions within their recorded size.`);
