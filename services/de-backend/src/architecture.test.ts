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
 *
 * Some module edges are forbidden even through an index (`forbiddenEdges`): the rule
 * registry is composed in `domains/tax-rules/` above Taxation and Depreciation, so
 * neither domain imports it, and Depreciation does not import Taxation (P8-D11, §59). Taxation reads the Loan
 * allocation through Financing's index; Financing never imports Taxation (§58D).
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
const testPackages = ['vitest', 'node:http', 'node:net'];
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
  // busboy: multipart parsing for file uploads (bank import), an HTTP concern.
  { layer: 'api', allowedLayers: ['application', 'shared'], allowedPackages: ['busboy', 'express', 'zod'] },
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
  return rule.allowedPackages === 'any' || rule.allowedPackages.includes(name) || (testFilePattern.test(file) && testPackages.includes(name))
    ? undefined
    : `${file} imports non-allowlisted package '${specifier}'`;
}

/** Module edges refused even through an index (api-design.md §59, P8-D11): `from` module → `to` module, tests included. */
const forbiddenEdges: readonly { readonly from: string; readonly to: string; readonly why: string }[] = [
  { from: join('domains', 'taxation'), to: join('domains', 'tax-rules'), why: 'the registry is composed above both domains' },
  { from: join('domains', 'depreciation'), to: join('domains', 'tax-rules'), why: 'the registry is composed above both domains' },
  { from: join('domains', 'depreciation'), to: join('domains', 'taxation'), why: 'Depreciation and Taxation meet only in infrastructure/, §59B' },
  { from: join('domains', 'taxation'), to: join('domains', 'depreciation'), why: 'Depreciation and Taxation meet only in infrastructure/, §59B' },
  {
    from: join('domains', 'acquisition'),
    to: join('domains', 'taxation'),
    why: 'Taxation imports Acquisition; the basis function is shared through Acquisition, §59A',
  },
  { from: join('domains', 'ownership'), to: join('domains', 'taxation'), why: 'Taxation imports Ownership; the tenure is shared through Ownership, §59A' },
  { from: join('domains', 'financing'), to: join('domains', 'taxation'), why: 'Taxation reads the allocation; Financing never reads tax meanings, §58D' },
];

/** `file` is relative to src/; a forbidden module edge, or undefined. Only relative specifiers name modules. */
function forbiddenEdge(file: string, specifier: string): string | undefined {
  if (!specifier.startsWith('.')) return undefined;
  const target = moduleOf(relative(srcDir, resolve(srcDir, dirname(file), specifier)));
  const edge = forbiddenEdges.find((e) => moduleOf(file) === e.from && target === e.to);
  return edge === undefined ? undefined : `${file} imports '${specifier}' (${edge.from} → ${edge.to} is forbidden: ${edge.why})`;
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

describe('architecture: forbidden module edges (§58D, §59, §59A, §59B)', () => {
  it('no file under domains/taxation/ or domains/depreciation/ imports domains/tax-rules/ or the other one, nor Acquisition, Ownership or Financing Taxation', () => {
    const files = listSourceFiles(join(srcDir, 'domains'));
    for (const module of ['depreciation', 'taxation', 'tax-rules', 'acquisition', 'ownership', 'financing']) {
      expect(files.some((path) => moduleOf(relative(srcDir, path)) === join('domains', module))).toBe(true);
    }
    const violations = files.flatMap((path) => {
      const file = relative(srcDir, path);
      return importSpecifiers(readFileSync(path, 'utf8'))
        .map((specifier) => forbiddenEdge(file, specifier))
        .filter((v): v is string => v !== undefined);
    });
    expect(violations).toEqual([]);
  });

  it.each([
    ['domains/depreciation/probe.ts', '../tax-rules/index.js'],
    ['domains/taxation/probe.ts', '../tax-rules/index.js'],
    ['domains/taxation/rules/probe.test.ts', '../../tax-rules/index.js'],
    ['domains/depreciation/probe.ts', '../taxation/index.js'],
    ['domains/acquisition/probe.ts', '../taxation/index.js'],
    ['domains/ownership/probe.ts', '../taxation/index.js'],
    // §58D: Taxation → Financing is the edge; the way back would close a cycle.
    ['domains/financing/probe.ts', '../taxation/index.js'],
    ['domains/financing/debt.test.ts', '../taxation/tax-year-view.js'],
    // §59B: in both directions, type-only imports included (importSpecifiers scans them).
    ['domains/taxation/probe.ts', '../depreciation/index.js'],
    ['domains/taxation/rules/probe.test.ts', '../../depreciation/index.js'],
  ])('%s may not import %s', (file, specifier) => {
    expect(forbiddenEdge(file, specifier)).toBeDefined();
  });

  it('§59B counter-check: a type-only import of the other domain is refused in both directions', () => {
    const refused = (file: string, source: string) => importSpecifiers(source).map((specifier) => forbiddenEdge(file, specifier));
    expect(refused('domains/taxation/capitalized-items.ts', "import type { CapitalizedItem } from '../depreciation/index.js';")[0]).toBeDefined();
    expect(refused('domains/depreciation/schedule.ts', "import type { TaxListItem } from '../taxation/index.js';")[0]).toBeDefined();
  });

  it.each([
    ['domains/tax-rules/probe.ts', '../taxation/index.js'],
    ['domains/tax-rules/probe.ts', '../depreciation/index.js'],
    ['domains/depreciation/probe.ts', '../../shared/index.js'],
    ['application/probe.ts', '../domains/tax-rules/index.js'],
    ['infrastructure/postgres/probe.ts', '../../domains/tax-rules/index.js'],
    ['domains/taxation/probe.ts', '../acquisition/index.js'],
    ['domains/taxation/probe.ts', '../ownership/index.js'],
    ['domains/taxation/probe.ts', '../financing/index.js'],
    ['domains/depreciation/probe.ts', '../acquisition/index.js'],
    ['domains/acquisition/probe.ts', '../../shared/index.js'],
    // §59B: the two domains meet in infrastructure/postgres/.
    ['infrastructure/postgres/probe.ts', '../../domains/depreciation/index.js'],
    ['infrastructure/postgres/probe.ts', '../../domains/taxation/index.js'],
  ])('%s may import %s', (file, specifier) => {
    expect(forbiddenEdge(file, specifier)).toBeUndefined();
  });
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

  it.each(['zod', '../../shared/index.js', '../ownership/index.js', './money.js', './internal/repo.js'])('domains/ allows %s', (specifier) => {
    expect(violation(ruleFor('domains'), domainFile, specifier)).toBeUndefined();
  });

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

  it.each([
    '../../api/index.js',
    '../../application/index.js',
    '../../integrations/mre/index.js',
    '../../reporting/index.js',
    '../../shared/money.js',
    '../../domains/ledger/internal/repo.js',
  ])('infrastructure/ rejects %s', (specifier) => {
    expect(violation(ruleFor('infrastructure'), infraFile, specifier)).toBeDefined();
  });

  it.each(['pg', 'kysely', 'node:fs', '../../shared/index.js', '../../domains/ledger/index.js', './money-column.js'])(
    'infrastructure/ allows %s',
    (specifier) => {
      expect(violation(ruleFor('infrastructure'), infraFile, specifier)).toBeUndefined();
    },
  );

  it.each([
    '../../api/index.js',
    '../../application/index.js',
    '../../infrastructure/postgres/index.js',
    '../bank-import/internal/parser.js',
    '../../shared/money.js',
  ])('integrations/ rejects %s', (specifier) => {
    expect(violation(ruleFor('integrations'), 'integrations/mre/probe.ts', specifier)).toBeDefined();
  });

  it.each(['zod', 'node:crypto', '../../shared/index.js', './mre-client.js', '../bank-import/index.js'])('integrations/ allows %s', (specifier) => {
    expect(violation(ruleFor('integrations'), 'integrations/mre/probe.ts', specifier)).toBeUndefined();
  });

  it.each([
    '../infrastructure/postgres/index.js',
    '../integrations/mre/index.js',
    '../domains/ledger/index.js',
    '../application/access.js',
    'pg',
    'axios',
    'node:fs',
  ])('api/ rejects %s', (specifier) => {
    expect(violation(ruleFor('api'), 'api/probe.ts', specifier)).toBeDefined();
  });

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
    expect(['a.ts', 'b.mts', 'c.cts', 'd.d.ts', 'e.js'].filter(isSourceFile)).toEqual(['a.ts', 'b.mts', 'c.cts']);
  });
});

/**
 * Specifiers of the imports and re-exports that bind a value at run time. A binding written `type X`, and
 * `import type` / `export type`, are left out: they carry no value, so a cycle through them cannot leave a module
 * reading another one before it is initialised.
 */
function valueImportSpecifiers(source: string): string[] {
  const file = ts.createSourceFile('probe.ts', source, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
  const valueNamed = (elements: ts.NodeArray<ts.ImportSpecifier | ts.ExportSpecifier>) => elements.some((e) => !e.isTypeOnly);
  return file.statements.flatMap((s) => {
    if (ts.isImportDeclaration(s) && ts.isStringLiteral(s.moduleSpecifier)) {
      const clause = s.importClause;
      if (clause === undefined) return [s.moduleSpecifier.text];
      if (clause.isTypeOnly) return [];
      const bindings = clause.namedBindings;
      const hasValue = clause.name !== undefined || (bindings !== undefined && (ts.isNamespaceImport(bindings) || valueNamed(bindings.elements)));
      return hasValue ? [s.moduleSpecifier.text] : [];
    }
    if (ts.isExportDeclaration(s) && s.moduleSpecifier !== undefined && ts.isStringLiteral(s.moduleSpecifier)) {
      if (s.isTypeOnly) return [];
      const clause = s.exportClause;
      return clause === undefined || ts.isNamespaceExport(clause) || valueNamed(clause.elements) ? [s.moduleSpecifier.text] : [];
    }
    return [];
  });
}

/** The cycles (strongly connected components of more than one file, or a file importing itself) of a value-import graph. */
function valueImportCycles(graph: ReadonlyMap<string, readonly string[]>): string[][] {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const cycles: string[][] = [];
  const visit = (v: string) => {
    index.set(v, index.size);
    low.set(v, index.get(v) as number);
    stack.push(v);
    onStack.add(v);
    for (const w of graph.get(v) ?? []) {
      if (!index.has(w)) {
        visit(w);
        low.set(v, Math.min(low.get(v) as number, low.get(w) as number));
      } else if (onStack.has(w)) low.set(v, Math.min(low.get(v) as number, index.get(w) as number));
    }
    if (low.get(v) === index.get(v)) {
      const component: string[] = [];
      for (let w = stack.pop(); w !== undefined; w = w === v ? undefined : stack.pop()) {
        onStack.delete(w);
        component.push(w);
      }
      if (component.length > 1 || (graph.get(v) ?? []).includes(v)) cycles.push(component.sort());
    }
  };
  for (const v of graph.keys()) if (!index.has(v)) visit(v);
  return cycles;
}

describe('architecture: no value-import cycle in production code', () => {
  it('no production file reaches itself through value imports (type-only bindings excluded)', () => {
    const production = listSourceFiles(srcDir).filter((path) => !testFilePattern.test(path) && !/\.test-support\.(c|m)?ts$/.test(path));
    const known = new Set(production.map((path) => relative(srcDir, path)));
    const graph = new Map<string, string[]>();
    for (const path of production) {
      const file = relative(srcDir, path);
      const targets = valueImportSpecifiers(readFileSync(path, 'utf8'))
        .filter((specifier) => specifier.startsWith('.'))
        .map((specifier) => relative(srcDir, resolve(srcDir, dirname(file), specifier)).replace(/\.js$/, '.ts'))
        .filter((target) => known.has(target));
      graph.set(file, targets);
    }
    expect(graph.size).toBeGreaterThan(100);
    expect(valueImportCycles(graph)).toEqual([]);
  });

  it('counter-check: the detector finds a cycle, and ignores one made of type-only bindings', () => {
    expect(valueImportSpecifiers("import { a } from './a.js';\nexport { b } from './b.js';")).toEqual(['./a.js', './b.js']);
    expect(valueImportSpecifiers("import type { A } from './a.js';\nimport { type B } from './b.js';\nexport type { C } from './c.js';")).toEqual([]);
    expect(valueImportSpecifiers("import { type A, b } from './a.js';\nimport * as n from './n.js';\nimport './side.js';")).toEqual([
      './a.js',
      './n.js',
      './side.js',
    ]);
    const cyclic = new Map([
      ['a.ts', ['b.ts']],
      ['b.ts', ['c.ts']],
      ['c.ts', ['a.ts']],
      ['d.ts', ['a.ts']],
    ]);
    expect(valueImportCycles(cyclic)).toEqual([['a.ts', 'b.ts', 'c.ts']]);
    expect(
      valueImportCycles(
        new Map([
          ['a.ts', ['b.ts']],
          ['b.ts', []],
        ]),
      ),
    ).toEqual([]);
  });
});
