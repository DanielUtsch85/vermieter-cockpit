import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Enforces the dependency direction from docs/development/coding-guidelines.md §3
 * and docs/architecture/technology.md §5.2: domain code must not depend on HTTP,
 * database drivers, the MRE client, CSV/PDF libraries, or outer layers.
 */

const srcDir = dirname(fileURLToPath(import.meta.url));
const domainsDir = join(srcDir, 'domains');

const forbiddenLayers = ['api', 'application', 'integrations', 'reporting'];
const forbiddenPackages = [
  /^express($|\/)/,
  /^pg($|\/)/,
  /^kysely($|\/)/,
  /^csv/,
  /^papaparse($|\/)/,
  /^pdf/,
  /^node:http/,
];

function listTsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return listTsFiles(path);
    return entry.name.endsWith('.ts') ? [path] : [];
  });
}

function importSpecifiers(source: string): string[] {
  const pattern = /(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|import\s*['"]([^'"]+)['"]/g;
  return [...source.matchAll(pattern)].map((m) => m[1] ?? m[2] ?? m[3] ?? '');
}

function violation(file: string, specifier: string): string | undefined {
  if (specifier.startsWith('.')) {
    const target = relative(srcDir, resolve(dirname(file), specifier));
    const layer = target.split(sep)[0];
    return layer !== undefined && forbiddenLayers.includes(layer)
      ? `${relative(srcDir, file)} imports outer layer '${specifier}'`
      : undefined;
  }
  return forbiddenPackages.some((p) => p.test(specifier))
    ? `${relative(srcDir, file)} imports infrastructure package '${specifier}'`
    : undefined;
}

describe('architecture: domain dependency direction', () => {
  it('finds domain modules to check', () => {
    expect(listTsFiles(domainsDir).length).toBeGreaterThan(0);
  });

  it('domain code does not import outer layers or infrastructure packages', () => {
    const violations = listTsFiles(domainsDir).flatMap((file) =>
      importSpecifiers(readFileSync(file, 'utf8'))
        .map((specifier) => violation(file, specifier))
        .filter((v): v is string => v !== undefined),
    );
    expect(violations).toEqual([]);
  });
});
