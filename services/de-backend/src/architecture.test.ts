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
 */

const srcDir = dirname(fileURLToPath(import.meta.url));

interface LayerRule {
  /** Top-level directory under src/ the rule applies to. */
  layer: string;
  /** Top-level src/ directories this layer may import from (besides itself). */
  allowedLayers: readonly string[];
  /** Bare package specifiers this layer may import. Node built-ins are never allowed. */
  allowedPackages: readonly string[];
}

const pureDependencies = ['decimal.js', 'zod'];

const rules: readonly LayerRule[] = [
  { layer: 'domains', allowedLayers: ['shared'], allowedPackages: pureDependencies },
  { layer: 'shared', allowedLayers: [], allowedPackages: pureDependencies },
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

/** `file` is relative to src/, e.g. `domains/ledger/index.ts`. */
function violation(rule: LayerRule, file: string, specifier: string): string | undefined {
  if (specifier.startsWith('.')) {
    const target = relative(srcDir, resolve(srcDir, dirname(file), specifier));
    const targetLayer = target.split(sep)[0] ?? '';
    if (targetLayer === '..' || target.startsWith('..')) {
      return `${file} imports '${specifier}' from outside src/`;
    }
    return targetLayer === rule.layer || rule.allowedLayers.includes(targetLayer)
      ? undefined
      : `${file} imports layer '${targetLayer}' via '${specifier}'`;
  }
  return rule.allowedPackages.includes(packageName(specifier))
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
    '../../../package.json',
  ])('domains/ rejects %s', (specifier) => {
    expect(violation(ruleFor('domains'), domainFile, specifier)).toBeDefined();
  });

  it.each(['decimal.js', 'zod', '../../shared/index.js', '../ownership/index.js', './money.js'])(
    'domains/ allows %s',
    (specifier) => {
      expect(violation(ruleFor('domains'), domainFile, specifier)).toBeUndefined();
    },
  );

  it.each(['../domains/ledger/index.js', '../api/index.js', '../integrations/mre/index.js', 'express', 'node:crypto'])(
    'shared/ rejects %s',
    (specifier) => {
      expect(violation(ruleFor('shared'), sharedFile, specifier)).toBeDefined();
    },
  );

  it.each(['decimal.js', './money.js'])('shared/ allows %s', (specifier) => {
    expect(violation(ruleFor('shared'), sharedFile, specifier)).toBeUndefined();
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
