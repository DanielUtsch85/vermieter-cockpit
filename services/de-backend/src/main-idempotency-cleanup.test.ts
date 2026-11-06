import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * VC-X-12 (api-design.md §15 "Retention"): `main.ts` is the composition root and runs on import, so its wiring of the
 * idempotency key cleanup is pinned on its source: the cleanup starts after the migrations (0074's index and the table
 * exist) and before the server listens, its first run is awaited (the log line comes before the listening line), the
 * purge is the real one on this `db`, and `shutdown` stops the interval before closing the server and the pool. The
 * schedule itself (one run now, one a day, unref, stop) is tested in idempotency-retention.test.ts.
 */
const MAIN = join(dirname(fileURLToPath(import.meta.url)), 'main.ts');

/** What is missing or out of order in the wiring, as short words; `[]` when it is wired. */
export function cleanupWiringProblems(source: string): string[] {
  const problems: string[] = [];
  const at = (needle: string) => source.indexOf(needle);
  const migrate = at('await migrateToLatest(pool)');
  const start = at('const idempotencyCleanup = startIdempotencyKeyCleanup({');
  const first = at('await idempotencyCleanup.firstRun;');
  const listen = at('app.listen(');
  if (start < 0) problems.push('not started');
  else {
    if (migrate < 0 || start < migrate) problems.push('started before the migrations');
    if (listen >= 0 && start > listen) problems.push('started after listen');
  }
  if (first < 0) problems.push('first run not awaited');
  else if (listen >= 0 && first > listen) problems.push('first run awaited after listen');
  if (!/purge: \(now\) => purgeExpiredIdempotencyKeys\(db, now\)/.test(source)) problems.push('not the real purge');
  const shutdown = at('function shutdown(');
  const body = shutdown < 0 ? '' : source.slice(shutdown, source.indexOf('\n}\n', shutdown));
  const stop = body.indexOf('idempotencyCleanup.stop();');
  if (stop < 0) problems.push('not stopped on shutdown');
  else if (stop > body.indexOf('server.close(')) problems.push('stopped after server.close');
  return problems;
}

describe('main.ts wires the idempotency key cleanup', () => {
  const source = readFileSync(MAIN, 'utf8');

  it('starts it after the migrations, awaits the first run before listen, and stops it on shutdown', () => {
    expect(cleanupWiringProblems(source)).toEqual([]);
  });

  it('counter-check: without the stop on shutdown, or with it after server.close, it is found', () => {
    expect(cleanupWiringProblems(source.replace('  idempotencyCleanup.stop();\n', ''))).toEqual(['not stopped on shutdown']);
    const late = source.replace('  idempotencyCleanup.stop();\n', '').replace('    void pool.end()', '    idempotencyCleanup.stop();\n    void pool.end()');
    expect(cleanupWiringProblems(late)).toEqual(['stopped after server.close']);
  });

  it('counter-check: no start, no awaited first run, or another purge is found', () => {
    expect(cleanupWiringProblems(source.replace('const idempotencyCleanup = startIdempotencyKeyCleanup({', 'const idempotencyCleanup = ({'))).toEqual([
      'not started',
    ]);
    expect(cleanupWiringProblems(source.replace('await idempotencyCleanup.firstRun;', ''))).toEqual(['first run not awaited']);
    expect(cleanupWiringProblems(source.replace('purgeExpiredIdempotencyKeys(db, now)', 'Promise.resolve(0)'))).toEqual(['not the real purge']);
  });

  it('counter-check: a start before the migrations is found', () => {
    const block = source.slice(source.indexOf('// VC-X-12 (api-design.md §15'), source.indexOf('await idempotencyCleanup.firstRun;'));
    const moved = source.replace(block, '').replace('// Migrate before accepting requests', `${block}// Migrate before accepting requests`);
    expect(cleanupWiringProblems(moved)).toEqual(['started before the migrations']);
  });
});
