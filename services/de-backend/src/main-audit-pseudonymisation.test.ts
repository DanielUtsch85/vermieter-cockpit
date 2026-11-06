import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * VC-X-24 (api-design.md §58U rules 4 and 9): `main.ts` runs on import, so its wiring of the pseudonymisation is pinned
 * on its source: started after the migrations (0076's column and guard exist), its first run awaited before the server
 * listens (after a restore of an older copy the readable due values are replaced before the first response), the real
 * job on this `db`, and stopped on shutdown before the server closes. The schedule itself is in audit-retention.test.ts.
 */
const MAIN = join(dirname(fileURLToPath(import.meta.url)), 'main.ts');

export function pseudonymisationWiringProblems(source: string): string[] {
  const problems: string[] = [];
  const at = (needle: string) => source.indexOf(needle);
  const migrate = at('await migrateToLatest(pool)');
  const start = at('const auditPseudonymisation = startAuditPseudonymisation({');
  const first = at('await auditPseudonymisation.firstRun;');
  const listen = at('app.listen(');
  if (start < 0) problems.push('not started');
  else {
    if (migrate < 0 || start < migrate) problems.push('started before the migrations');
    if (listen >= 0 && start > listen) problems.push('started after listen');
  }
  if (first < 0) problems.push('first run not awaited');
  else if (listen >= 0 && first > listen) problems.push('first run awaited after listen');
  if (!/pseudonymise: \(now\) => pseudonymiseDueAuditRecords\(db, now\)/.test(source)) problems.push('not the real job');
  const shutdown = at('function shutdown(');
  const body = shutdown < 0 ? '' : source.slice(shutdown, source.indexOf('\n}\n', shutdown));
  const stop = body.indexOf('auditPseudonymisation.stop();');
  if (stop < 0) problems.push('not stopped on shutdown');
  else if (stop > body.indexOf('server.close(')) problems.push('stopped after server.close');
  return problems;
}

describe('main.ts wires the audit pseudonymisation', () => {
  const source = readFileSync(MAIN, 'utf8');

  it('starts it after the migrations, awaits the first run before listen, and stops it on shutdown', () => {
    expect(pseudonymisationWiringProblems(source)).toEqual([]);
  });

  it('counter-check: the first run not awaited, or awaited after listen, is found', () => {
    expect(pseudonymisationWiringProblems(source.replace('await auditPseudonymisation.firstRun;', ''))).toEqual(['first run not awaited']);
    const late = source
      .replace('await auditPseudonymisation.firstRun;\n', '')
      .replace('function shutdown(', 'await auditPseudonymisation.firstRun;\nfunction shutdown(');
    expect(pseudonymisationWiringProblems(late)).toEqual(['first run awaited after listen']);
  });

  it('counter-check: no start, another job, or no stop on shutdown is found', () => {
    expect(
      pseudonymisationWiringProblems(source.replace('const auditPseudonymisation = startAuditPseudonymisation({', 'const auditPseudonymisation = ({')),
    ).toEqual(['not started']);
    expect(pseudonymisationWiringProblems(source.replace('pseudonymiseDueAuditRecords(db, now)', 'Promise.resolve(0)'))).toEqual(['not the real job']);
    expect(pseudonymisationWiringProblems(source.replace('  auditPseudonymisation.stop();\n', ''))).toEqual(['not stopped on shutdown']);
  });

  it('counter-check: a start before the migrations is found', () => {
    const block = source.slice(source.indexOf('// VC-X-24 (api-design.md §58U)'), source.indexOf('await auditPseudonymisation.firstRun;'));
    const moved = source.replace(block, '').replace('// Migrate before accepting requests', `${block}// Migrate before accepting requests`);
    expect(pseudonymisationWiringProblems(moved)).toEqual(['started before the migrations']);
  });
});
