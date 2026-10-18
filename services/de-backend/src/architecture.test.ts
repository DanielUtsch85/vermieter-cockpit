import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * Enforces the dependency direction from docs/development/coding-guidelines.md §3
 * and docs/architecture/technology.md §5.2: domain code and the shared kernel must
 * not depend on HTTP, databases, the MRE client, file system, CSV/PDF libraries,
 * or outer layers.
 *
 * Third-party packages are checked against an allowlist, not a denylist, so a new
 * infrastructure package cannot slip through unnoticed. Extending the allowlist is a
 * deliberate, reviewed change.
 *
 * Imports into another module (another domain, or another top-level layer) must go
 * through that module's public `index.js`; deep imports into its internals are
 * rejected (ADR-026 "strong internal boundaries").
 */

const srcDir = dirname(fileURLToPath(import.meta.url));

interface LayerRule {
  /** Top-level directory under src/ the rule applies to. */
  layer: string;
  /** Top-level src/ directories this layer may import from (besides itself). */
  allowedLayers: readonly string[];
  /**
   * Bare package specifiers this layer may import; Node built-ins count as packages and
   * are therefore never allowed in an allowlist. `'any'` leaves packages and built-ins
   * unrestricted (infrastructure adapters are where drivers and file access belong).
   */
  allowedPackages: readonly string[] | 'any';
}

/** Additionally allowed in test files only. */
const testPackages = ['vitest'];
const testFilePattern = /\.test\.(c|m)?ts$/;

const rules: readonly LayerRule[] = [
  // decimal.js only inside shared/: domains compute through ExactDecimal/Money, so the
  // global decimal.js configuration can never take part in a calculation (ADR-033).
  { layer: 'domains', allowedLayers: ['shared'], allowedPackages: ['zod'] },
  { layer: 'shared', allowedLayers: [], allowedPackages: ['decimal.js', 'zod'] },
  // Adapters implement domain ports; they never call use cases or the API (technology.md §5.2).
  { layer: 'infrastructure', allowedLayers: ['shared', 'domains'], allowedPackages: 'any' },
  // The MRE anti-corruption layer and other external adapters: same direction as infrastructure.
  { layer: 'integrations', allowedLayers: ['shared', 'domains'], allowedPackages: 'any' },
  // Use cases and policies: no HTTP, no adapters; infrastructure arrives through ports.
  { layer: 'application', allowedLayers: ['shared', 'domains'], allowedPackages: ['zod'] },
  // HTTP layer: talks to the application layer, never to adapters directly.
  { layer: 'api', allowedLayers: ['application', 'shared'], allowedPackages: 'any' },
];

const sourceFilePattern = /\.(c|m)?ts$/;

function isSourceFile(name: string): boolean {
  return sourceFilePattern.test(name) && !name.endsWith('.d.ts');
}

function listSourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return listSourceFiles(path);
    return isSourceFile(entry.name) ? [path] : [];
  });
}

/** Static, dynamic and `require` import specifiers; comments are ignored. */
function importSpecifiers(source: string): string[] {
  return ts.preProcessFile(source, true, true).importedFiles.map((f) => f.fileName);
}

function packageName(specifier: string): string {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : (parts[0] ?? specifier);
}

/** Layers whose sub-directories are separate modules (one domain / one adapter each). */
const layersWithModules = ['domains', 'integrations', 'infrastructure'];

/** Module a src/-relative path belongs to: `<layer>/<name>` for layersWithModules, else the layer. */
function moduleOf(path: string): string {
  const [layer = '', name = ''] = path.split(sep);
  return layersWithModules.includes(layer) ? `${layer}${sep}${name}` : layer;
}

/** `file` is relative to src/, e.g. `domains/ledger/index.ts`. */
function violation(rule: LayerRule, file: string, specifier: string): string | undefined {
  if (specifier.startsWith('.')) {
    const target = relative(srcDir, resolve(srcDir, dirname(file), specifier));
    const targetLayer = target.split(sep)[0] ?? '';
    if (targetLayer === '..' || target.startsWith('..')) {
      return `${file} imports '${specifier}' from outside src/`;
    }
    if (targetLayer !== rule.layer && !rule.allowedLayers.includes(targetLayer)) {
      return `${file} imports layer '${targetLayer}' via '${specifier}'`;
    }
    const targetModule = moduleOf(target);
    return targetModule !== moduleOf(file) && target !== join(targetModule, 'index.js')
      ? `${file} deep-imports '${specifier}'; use ${targetModule}/index.js`
      : undefined;
  }
  const name = packageName(specifier);
  return rule.allowedPackages === 'any' ||
    rule.allowedPackages.includes(name) ||
    (testFilePattern.test(file) && testPackages.includes(name))
    ? undefined
    : `${file} imports non-allowlisted package '${specifier}'`;
}

function ruleFor(layer: string): LayerRule {
  const rule = rules.find((r) => r.layer === layer);
  if (rule === undefined) throw new Error(`no rule for layer ${layer}`);
  return rule;
}

describe('architecture: layer dependency direction', () => {
  for (const rule of rules) {
    it(`${rule.layer}/ only imports allowed layers and packages`, () => {
      const files = listSourceFiles(join(srcDir, rule.layer));
      expect(files.length).toBeGreaterThan(0);
      const violations = files.flatMap((path) => {
        const file = relative(srcDir, path);
        return importSpecifiers(readFileSync(path, 'utf8'))
          .map((specifier) => violation(rule, file, specifier))
          .filter((v): v is string => v !== undefined);
      });
      expect(violations).toEqual([]);
    });
  }
});

describe('architecture rules (fixtures)', () => {
  const domainFile = 'domains/ledger/probe.ts';
  const sharedFile = 'shared/probe.ts';

  it.each([
    'http',
    'https',
    'node:http',
    'http2',
    'net',
    'fs',
    'node:fs/promises',
    'child_process',
    'mongodb',
    'mongoose',
    'pg',
    'pg-pool',
    'postgres',
    'kysely',
    'express',
    'axios',
    'node-fetch',
    'undici',
    'got',
    'fast-csv',
    '@fast-csv/parse',
    'csv-parse/sync',
    'pdfkit',
    '@react-pdf/renderer',
    '../../api/index.js',
    '../../application/index.js',
    '../../integrations/mre/index.js',
    '../../reporting/index.js',
    '../../infrastructure/postgres/index.js',
    '../../../package.json',
    '../../shared/money.js',
    '../ownership/internal/repository.js',
    '../ownership/',
    'decimal.js',
    'decimal.js/decimal.mjs',
  ])('domains/ rejects %s', (specifier) => {
    expect(violation(ruleFor('domains'), domainFile, specifier)).toBeDefined();
  });

  it.each(['zod', '../../shared/index.js', '../ownership/index.js', './money.js', './internal/repo.js'])(
    'domains/ allows %s',
    (specifier) => {
      expect(violation(ruleFor('domains'), domainFile, specifier)).toBeUndefined();
    },
  );

  it.each(['../domains/ledger/index.js', '../api/index.js', '../integrations/mre/index.js', '../infrastructure/postgres/index.js', 'express', 'node:crypto'])(
    'shared/ rejects %s',
    (specifier) => {
      expect(violation(ruleFor('shared'), sharedFile, specifier)).toBeDefined();
    },
  );

  it.each(['decimal.js', './money.js'])('shared/ allows %s', (specifier) => {
    expect(violation(ruleFor('shared'), sharedFile, specifier)).toBeUndefined();
  });

  const infraFile = 'infrastructure/postgres/probe.ts';

  it.each(['../../api/index.js', '../../application/index.js', '../../integrations/mre/index.js', '../../reporting/index.js', '../../shared/money.js', '../../domains/ledger/internal/repo.js'])(
    'infrastructure/ rejects %s',
    (specifier) => {
      expect(violation(ruleFor('infrastructure'), infraFile, specifier)).toBeDefined();
    },
  );

  it.each(['pg', 'kysely', 'node:fs', '../../shared/index.js', '../../domains/ledger/index.js', './money-column.js'])(
    'infrastructure/ allows %s',
    (specifier) => {
      expect(violation(ruleFor('infrastructure'), infraFile, specifier)).toBeUndefined();
    },
  );

  it.each(['../../api/index.js', '../../application/index.js', '../../infrastructure/postgres/index.js', '../bank-import/internal/parser.js', '../../shared/money.js'])(
    'integrations/ rejects %s',
    (specifier) => {
      expect(violation(ruleFor('integrations'), 'integrations/mre/probe.ts', specifier)).toBeDefined();
    },
  );

  it.each(['zod', 'node:crypto', '../../shared/index.js', './mre-client.js', '../bank-import/index.js'])('integrations/ allows %s', (specifier) => {
    expect(violation(ruleFor('integrations'), 'integrations/mre/probe.ts', specifier)).toBeUndefined();
  });

  it.each(['../infrastructure/postgres/index.js', '../integrations/mre/index.js', '../domains/ledger/index.js', '../application/access.js'])(
    'api/ rejects %s',
    (specifier) => {
      expect(violation(ruleFor('api'), 'api/probe.ts', specifier)).toBeDefined();
    },
  );

  it.each(['express', '../application/index.js', '../shared/index.js', './app.js'])('api/ allows %s', (specifier) => {
    expect(violation(ruleFor('api'), 'api/probe.ts', specifier)).toBeUndefined();
  });

  it.each(['express', 'pg', '../api/index.js', '../infrastructure/postgres/index.js', '../integrations/mre/index.js'])(
    'application/ rejects %s',
    (specifier) => {
      expect(violation(ruleFor('application'), 'application/probe.ts', specifier)).toBeDefined();
    },
  );

  it('allows vitest only in test files', () => {
    expect(violation(ruleFor('shared'), 'shared/money.test.ts', 'vitest')).toBeUndefined();
    expect(violation(ruleFor('shared'), sharedFile, 'vitest')).toBeDefined();
  });

  it('detects static, type-only, re-export, dynamic and require imports, ignoring comments', () => {
    const source = [
      "// import 'commented-line';",
      "/* import 'commented-block'; */",
      "import type { Db } from 'mongodb';",
      "export * from './a.js';",
      'const m = import(`axios`);',
      "import 'http';",
      "const fs = require('fs');",
    ].join('\n');
    expect(importSpecifiers(source)).toEqual(['mongodb', './a.js', 'axios', 'http', 'fs']);
  });

  it('scans .ts, .mts and .cts files but not declaration files', () => {
    expect(['a.ts', 'b.mts', 'c.cts', 'd.d.ts', 'e.js'].filter(isSourceFile)).toEqual([
      'a.ts',
      'b.mts',
      'c.cts',
    ]);
  });
});
