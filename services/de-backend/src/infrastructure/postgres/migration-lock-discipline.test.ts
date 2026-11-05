import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Kysely's Migrator introspects every schema of the database (`getTables`: `pg_get_serial_sequence` for each column),
 * which fails with "column … does not exist" when another session drops a column or table meanwhile (seen on PR #273:
 * `acquisition-transfer-date.test.ts` ran 0067's `down`, dropping `economic_transfer_recorded_at`, while a parallel test
 * file migrated). `migrateToLatest` holds `MIGRATION_ADVISORY_LOCK`; so must every test that runs a migration's `down`
 * by hand. This test pins that: each `.down(createDatabase(` call in a test file sits inside a `withMigrationLock(` call.
 */
const srcDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function testFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return e.name === 'node_modules' ? [] : testFiles(path);
    return /\.test\.ts$/.test(e.name) ? [path] : [];
  });
}

/** The offsets covered by `withMigrationLock( … )`, by parenthesis depth (strings are not special-cased; good enough here). */
function lockedRanges(source: string): [number, number][] {
  const ranges: [number, number][] = [];
  for (let at = source.indexOf('withMigrationLock('); at >= 0; at = source.indexOf('withMigrationLock(', at + 1)) {
    const open = at + 'withMigrationLock'.length;
    let depth = 0;
    for (let i = open; i < source.length; i++) {
      if (source[i] === '(') depth++;
      if (source[i] === ')' && --depth === 0) {
        ranges.push([open, i]);
        break;
      }
    }
  }
  return ranges;
}

/**
 * Every `.down(createDatabase(` call outside a lock, as `file:line`. A down wrapped in a helper (`const down = async () =>
 * ….down(createDatabase(…))`) counts by its calls: each `down()` must be inside a lock.
 */
export function unlockedDowns(source: string, name: string): string[] {
  const ranges = lockedRanges(source);
  const locked = (at: number) => ranges.some(([from, to]) => at > from && at < to);
  const line = (at: number) => `${name}:${source.slice(0, at).split('\n').length}`;
  const found: string[] = [];
  const helpers = [...source.matchAll(/const (\w+) = async \(\) =>[^\n]*\.down\(createDatabase\(/g)];
  for (let at = source.indexOf('.down(createDatabase('); at >= 0; at = source.indexOf('.down(createDatabase(', at + 1)) {
    const helper = helpers.find((h) => h.index < at && at < h.index + h[0].length);
    if (helper === undefined) {
      if (!locked(at)) found.push(line(at));
      continue;
    }
    for (const call of source.matchAll(new RegExp(`\\b${helper[1] as string}\\(\\)`, 'g'))) {
      if (!locked(call.index)) found.push(line(call.index));
    }
  }
  return found;
}

describe('migration downs in tests run under MIGRATION_ADVISORY_LOCK', () => {
  it('every hand-run down of a migration is inside withMigrationLock', () => {
    const self = fileURLToPath(import.meta.url);
    const offenders = testFiles(srcDir)
      .filter((f) => f !== self)
      .flatMap((f) => unlockedDowns(readFileSync(f, 'utf8'), relative(srcDir, f)));
    expect(offenders).toEqual([]);
  });

  it('counter-check: an unlocked down is found, a locked one is not', () => {
    expect(unlockedDowns('await m.down(createDatabase(pool) as never);', 'x.ts')).toEqual(['x.ts:1']);
    expect(unlockedDowns('await withMigrationLock(async () => {\n  await m.down(createDatabase(pool) as never);\n});', 'x.ts')).toEqual([]);
    expect(unlockedDowns('await withMigrationLock(() => a());\nawait m.down(createDatabase(pool) as never);', 'x.ts')).toEqual(['x.ts:2']);
    const helper = "const down = async () => (await import('./m.js')).down(createDatabase(pool) as never);\n";
    expect(unlockedDowns(`${helper}await withMigrationLock(() => down());`, 'x.ts')).toEqual([]);
    expect(unlockedDowns(`${helper}await withMigrationLock(() => down());\nawait down();`, 'x.ts')).toEqual(['x.ts:3']);
  });
});
