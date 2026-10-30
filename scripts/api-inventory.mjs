// Route inventory of the DE backend (ui-guide.md §2): every route registered in services/de-backend/src/api, read from
// the source so the list cannot drift from the code. `yarn api:inventory` writes docs/development/api-inventory.md;
// `yarn api:inventory --check` fails when the file is out of date (CI). Implemented routes only, never the specification.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const apiDir = join(root, 'services/de-backend/src/api');
const outFile = join(root, 'docs/development/api-inventory.md');
const check = process.argv.includes('--check');

const METHODS = ['get', 'post', 'put', 'patch', 'delete'];
const pattern = new RegExp(`\\b(router|api|app)\\.(${METHODS.join('|')})\\(\\s*'([^']+)'`, 'g');

const routes = [];
for (const file of readdirSync(apiDir).sort()) {
  if (!file.endsWith('.ts') || file.endsWith('.test.ts') || file.endsWith('.test-support.ts')) continue;
  const source = readFileSync(join(apiDir, file), 'utf8');
  for (const match of source.matchAll(pattern)) {
    const [, receiver, method, path] = match;
    // `app` registers at the server root (health for orchestration); `router` and `api` live under /api/v1.
    const prefix = receiver === 'app' ? '' : '/api/v1';
    routes.push({ method: method.toUpperCase(), path: prefix + path, file: relative(root, join(apiDir, file)) });
  }
}

const order = (a, b) => (a.path === b.path ? METHODS.indexOf(a.method.toLowerCase()) - METHODS.indexOf(b.method.toLowerCase()) : a.path < b.path ? -1 : 1);
routes.sort(order);

const byFile = new Map();
for (const r of routes) byFile.set(r.file, [...(byFile.get(r.file) ?? []), r]);

const lines = [
  '# API inventory (generated)',
  '',
  'Every route the DE backend registers, read from `services/de-backend/src/api` by `scripts/api-inventory.mjs`.',
  'Regenerate with `yarn api:inventory`; CI runs `yarn api:inventory --check`. Do not edit by hand.',
  '',
  'Implemented routes only: a route in `docs/architecture/api-design.md` that is not listed here is specified, not available.',
  'Contracts, payloads and error codes are in `api-design.md`; the business routes need `Authorization: Bearer <MRE token>` and',
  '`organizationid: <mreRealmId>` (`mre-integration.md` §47.2).',
  '',
  `Routes: ${routes.length}.`,
  '',
  '| Method | Path |',
  '|---|---|',
  ...routes.map((r) => `| ${r.method} | \`${r.path}\` |`),
  '',
  '## By module',
  '',
];
for (const [file, list] of [...byFile.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
  lines.push(`### \`${file}\``, '', ...list.map((r) => `- ${r.method} \`${r.path}\``), '');
}
const output = lines.join('\n');

if (check) {
  let current = '';
  try {
    current = readFileSync(outFile, 'utf8');
  } catch {
    // missing file: out of date
  }
  if (current !== output) {
    console.error(`${relative(root, outFile)} is out of date: run \`yarn api:inventory\` and commit the result.`);
    process.exit(1);
  }
  console.log(`${relative(root, outFile)} is up to date (${routes.length} routes).`);
} else {
  writeFileSync(outFile, output);
  console.log(`wrote ${relative(root, outFile)} (${routes.length} routes).`);
}
