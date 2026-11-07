import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AUDIT_MARKER } from '../../domains/audit/index.js';
import { auditErasure, runAuditErasureCli } from './audit-erasure.js';
import { NOW_2037, OTHER_REALM, REALM, databaseUrl, useAuditDatabase } from './audit-retention.test-support.js';

/**
 * VC-X-24 (api-design.md §58U rule 8; decisions 9 and 10; betrieb.md §12): the erasure procedure. `--dry-run`, the
 * default, writes nothing (row count and checksum of `audit_record` equal); `--apply` changes only records past
 * retention, with `basis: "ERASURE_REQUEST"`; a record within retention is listed and kept; the Party of another Realm
 * is not found; the command line and `scripts/ops/audit-erasure.sh` default to the dry run (the script with a stub
 * compose command, no container). Synthetic data only.
 */
const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..', 'scripts', 'ops', 'audit-erasure.sh');
const M = AUDIT_MARKER;

describe.skipIf(databaseUrl === undefined)('the erasure procedure (VC-X-24)', () => {
  const { ctx, person, amend, record, documenting, backdate, checksum } = useAuditDatabase('audit_erasure_test');

  /** A Party with one record past retention (2026) and one within (2030), as of NOW_2037. */
  const requester = async (realm = REALM) => {
    const party = await person('Erika Antrag', realm);
    const old = await amend(party, { email: 'erika.neu@example.org' }, realm);
    const recent = await amend(party, { phone: '+49 30 0000005' }, realm);
    await backdate([old], '2026-03-05T09:00:00Z');
    await backdate([recent], '2030-06-01T10:00:00Z');
    return { party, old, recent };
  };

  it('the dry run lists every AMENDED record with year, end of retention and paths, and writes nothing', async () => {
    const { party, old, recent } = await requester();
    const before = await checksum();
    const outcome = await auditErasure(ctx.db, { mreRealmId: REALM, partyId: party, apply: false, now: NOW_2037 });
    expect(outcome).toEqual({
      kind: 'LISTED',
      applied: false,
      pseudonymised: 0,
      records: [
        {
          auditRecordId: old,
          occurredAt: '2026-03-05T09:00:00.000Z',
          creationYear: 2026,
          retentionEndsOn: '2036-12-31',
          pseudonymisedAt: null,
          paths: ['changes.email.from', 'changes.email.to'],
          state: 'DUE',
        },
        {
          auditRecordId: recent,
          occurredAt: '2030-06-01T10:00:00.000Z',
          creationYear: 2030,
          retentionEndsOn: '2040-12-31',
          pseudonymisedAt: null,
          paths: ['changes.phone.from', 'changes.phone.to'],
          state: 'WITHIN_RETENTION',
        },
      ],
    });
    expect(await checksum()).toEqual(before);
  });

  it('apply pseudonymises only the record past retention, as an erasure request; the record within retention is kept', async () => {
    const { party, old, recent } = await requester();
    const keep = await record(recent);
    const outcome = await auditErasure(ctx.db, { mreRealmId: REALM, partyId: party, apply: true, now: NOW_2037 });
    expect(outcome.kind === 'LISTED' && [outcome.pseudonymised, outcome.records.map((r) => r.state)]).toEqual([1, ['PSEUDONYMISED_NOW', 'WITHIN_RETENTION']]);
    expect((await record(old)).metadata).toEqual({ changes: { email: { from: M, to: M } } });
    expect(await record(recent)).toEqual(keep);
    expect((await documenting(party)).map((d) => [d.metadata.auditRecordId, d.metadata.basis, d.metadata.retentionEndedOn])).toEqual([
      [old, 'ERASURE_REQUEST', '2036-12-31'],
    ]);
    // A second apply finds it done and writes nothing.
    const before = await checksum();
    const again = await auditErasure(ctx.db, { mreRealmId: REALM, partyId: party, apply: true, now: NOW_2037 });
    expect(again.kind === 'LISTED' && [again.pseudonymised, again.records.map((r) => r.state)]).toEqual([0, ['ALREADY_PSEUDONYMISED', 'WITHIN_RETENTION']]);
    expect(await checksum()).toEqual(before);
  });

  it('Realm isolation: the Party asked for under another Realm is not found and nothing is written', async () => {
    const { party } = await requester(OTHER_REALM);
    const before = await checksum();
    expect(await auditErasure(ctx.db, { mreRealmId: REALM, partyId: party, apply: true, now: NOW_2037 })).toEqual({ kind: 'PARTY_NOT_FOUND' });
    expect(await checksum()).toEqual(before);
    // Counter-check: under its own Realm it is found.
    expect((await auditErasure(ctx.db, { mreRealmId: OTHER_REALM, partyId: party, apply: false, now: NOW_2037 })).kind).toBe('LISTED');
    expect(await auditErasure(ctx.db, { mreRealmId: REALM, partyId: 'keine-uuid', apply: false, now: NOW_2037 })).toEqual({ kind: 'PARTY_NOT_FOUND' });
  });

  it('the command line: dry run by default, apply on request, ids and dates only; a wrong call is status 2', async () => {
    const { party, old, recent } = await requester();
    const lines: string[] = [];
    const deps = { db: ctx.db, now: NOW_2037, out: (l: string) => lines.push(l), err: (l: string) => lines.push(`ERR ${l}`) };
    const before = await checksum();
    expect(await runAuditErasureCli([REALM, party], deps)).toBe(0);
    expect(await checksum()).toEqual(before);
    expect(lines).toEqual([
      `${old} | 2026-03-05T09:00:00.000Z | Jahr 2026 | Aufbewahrung bis 2036-12-31 | pseudonymisiert - | Aufbewahrung abgelaufen, würde ersetzt | changes.email.from,changes.email.to`,
      `${recent} | 2030-06-01T10:00:00.000Z | Jahr 2030 | Aufbewahrung bis 2040-12-31 | pseudonymisiert - | innerhalb der Aufbewahrung, bleibt | changes.phone.from,changes.phone.to`,
      'Probelauf (nichts geschrieben): 2 Datensatz/Datensätze, 0 jetzt pseudonymisiert, 1 innerhalb der Aufbewahrung (längste bis 2040-12-31)',
    ]);
    expect(lines.join('\n')).not.toMatch(/example\.org|\+49/);
    lines.length = 0;
    expect(await runAuditErasureCli([REALM, party, '--apply'], deps)).toBe(0);
    expect(lines.at(-1)).toBe('angewendet: 2 Datensatz/Datensätze, 1 jetzt pseudonymisiert, 1 innerhalb der Aufbewahrung (längste bis 2040-12-31)');
    lines.length = 0;
    expect(await runAuditErasureCli([REALM], deps)).toBe(2);
    expect(await runAuditErasureCli([REALM, party, '--force'], deps)).toBe(2);
    expect(await runAuditErasureCli([OTHER_REALM, party], deps)).toBe(1);
    expect(lines).toEqual([
      'ERR Aufruf: audit-erasure <mreRealmId> <partyId> [--dry-run|--apply]',
      'ERR Aufruf: audit-erasure <mreRealmId> <partyId> [--dry-run|--apply]',
      `ERR Partei ${party} im Realm ${OTHER_REALM} nicht gefunden`,
    ]);
  });
});

describe('scripts/ops/audit-erasure.sh', () => {
  const PARTY = '0c000000-0000-4000-8000-000000000001';
  /** The script with `echo` as compose command: what it would run in the container. */
  const call = (...args: string[]) => {
    try {
      return {
        status: 0,
        out: execFileSync('bash', [SCRIPT, ...args], { env: { ...process.env, COMPOSE_CMD: 'echo' }, encoding: 'utf8', stdio: 'pipe' }).trim(),
      };
    } catch (error) {
      const e = error as { status: number; stderr: string };
      return { status: e.status, out: e.stderr.trim() };
    }
  };

  it('defaults to the dry run and passes apply only when asked', () => {
    expect(call(REALM, PARTY)).toEqual({ status: 0, out: `exec -T de-backend node dist/audit-erasure.js ${REALM} ${PARTY} --dry-run` });
    expect(call(REALM, PARTY, '--apply')).toEqual({ status: 0, out: `exec -T de-backend node dist/audit-erasure.js ${REALM} ${PARTY} --apply` });
  });

  it('refuses a wrong call before it reaches the container', () => {
    expect(call(REALM).status).toBe(2);
    expect(call(REALM, PARTY, '--force').status).toBe(2);
    expect(call('kein-realm', PARTY)).toEqual({ status: 2, out: 'mreRealmId ist keine MRE-Objekt-Id (24 Hex-Zeichen): kein-realm' });
    expect(call(REALM, 'keine-uuid')).toEqual({ status: 2, out: 'partyId ist keine UUID: keine-uuid' });
  });
});
