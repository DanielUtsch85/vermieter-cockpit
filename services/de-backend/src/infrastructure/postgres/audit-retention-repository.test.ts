import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { AUDIT_MARKER, berlinStartOfYear } from '../../domains/audit/index.js';
import { pseudonymiseDueAuditRecords, startAuditPseudonymisation } from './audit-retention.js';
import { NOW_2037, OTHER_REALM, REALM, databaseUrl, useAuditDatabase } from './audit-retention.test-support.js';
import { createDatabase } from './database.js';
import { migrateToLatest } from './migrate.js';
import { testSchemaName } from './test-schema.test-support.js';

/**
 * VC-X-24 persistence (api-design.md §58U rules 3–5 and 9; Entscheidung des Projektinhabers, 2026-11-06): the job on a
 * migrated schema with Parties amended through the repository. A due record gets its markers, `pseudonymised_at` and
 * one `AUDIT_PSEUDONYMISED` record; a record not due, a `CREATED`/`DEACTIVATED` record, another entity's `AMENDED`
 * record and every column but the metadata stay; the boundary in Europe/Berlin against the database's own
 * `make_timestamptz`; Realm isolation (derived from the Party row); idempotency; two runs at once; 1,201 records in
 * batches of 500, each batch one transaction; the restore of an older copy. Synthetic data only.
 */
const M = AUDIT_MARKER;
const ms = (d: Date, delta: number) => new Date(d.getTime() + delta);

describe.skipIf(databaseUrl === undefined)('the pseudonymisation job (VC-X-24)', () => {
  const { ctx, person, amend, raw, record, documenting, backdate, checksum } = useAuditDatabase('audit_retention_job_test');
  const run = (now: Date, batchSize?: number) => pseudonymiseDueAuditRecords(ctx.db, now, batchSize === undefined ? {} : { batchSize });

  it('the spec example: the record of 2026-03-05 stays until 31.12.2036 and is pseudonymised from 01.01.2037 with its own record', async () => {
    const party = await person('Erika Beispiel');
    const id = await amend(party, { email: 'erika.neu@example.org' });
    await backdate([id], '2026-03-05T09:00:00Z');
    const before = await record(id);
    expect(before.metadata).toEqual({ changes: { email: { from: 'erika.alt@example.org', to: 'erika.neu@example.org' } } });
    expect(await run(ms(NOW_2037, -1))).toBe(0);
    expect(await record(id)).toEqual(before);
    expect(await run(NOW_2037)).toBe(1);
    const after = await record(id);
    expect(after).toEqual({ ...before, metadata: { changes: { email: { from: M, to: M } } }, pseudonymised_at: NOW_2037 });
    expect(await documenting(party)).toEqual([
      {
        entity_type: 'Party',
        entity_id: party,
        actor_type: 'SYSTEM',
        actor_id: 'audit-retention',
        previous_version: null,
        new_version: null,
        metadata: {
          auditRecordId: id,
          paths: ['changes.email.from', 'changes.email.to'],
          marker: M,
          basis: 'RETENTION_EXPIRED',
          retentionEndedOn: '2036-12-31',
        },
      },
    ]);
    // The Party's current values are untouched (decision: only the history).
    const current = (await ctx.pool.query(`SELECT display_name, email, phone, version FROM party WHERE id = $1`, [party])).rows[0];
    expect(current).toEqual({ display_name: 'Erika Beispiel', email: 'erika.neu@example.org', phone: '+49 30 0000000', version: 2 });
  });

  it('the year boundary in Berlin, not UTC: 31.12.2026 23:30 UTC is of 2027; 22:30 UTC of 2026', async () => {
    const party = await person('Grenzfall Silvester');
    const late = await amend(party, { phone: '+49 30 0000002' });
    const early = await amend(party, { phone: '+49 30 0000003' });
    await backdate([late], '2026-12-31T23:30:00Z');
    await backdate([early], '2026-12-31T22:30:00Z');
    // Exactly 01.01.2027 00:00 Berlin: of 2027, not due at 01.01.2037 (the cutoff is exclusive).
    const exact = await amend(party, { phone: '+49 30 0000004' });
    await backdate([exact], '2026-12-31T23:00:00Z');
    await run(NOW_2037);
    expect([(await record(early)).pseudonymised_at, (await record(late)).pseudonymised_at, (await record(exact)).pseudonymised_at]).toEqual([
      NOW_2037,
      null,
      null,
    ]);
    const y2038 = new Date('2038-01-01T00:00:00+01:00');
    await run(ms(y2038, -1));
    expect((await record(late)).pseudonymised_at).toBeNull();
    await run(y2038);
    expect((await record(late)).pseudonymised_at).toEqual(y2038);
  });

  it('the AUDIT_PSEUDONYMISED record names the end of retention of its own creation year: 31.12.2026 23:30 UTC ends on 2037-12-31', async () => {
    const party = await person('Fristende Silvester');
    const id = await amend(party, { email: 'silvester@example.org' });
    await backdate([id], '2026-12-31T23:30:00Z');
    const due = new Date('2038-01-01T00:00:00+01:00');
    await run(ms(due, -1));
    expect(await documenting(party)).toEqual([]);
    await run(due);
    expect((await documenting(party)).map((d) => [d.metadata.auditRecordId, d.metadata.retentionEndedOn])).toEqual([[id, '2037-12-31']]);
  });

  it('a leap day record (29.02.2028) is due from 01.01.2039 Berlin, not before', async () => {
    const party = await person('Schalttag');
    const id = await amend(party, { lastName: 'Schalttag' });
    await backdate([id], '2028-02-29T12:00:00Z');
    const due = new Date('2039-01-01T00:00:00+01:00');
    await run(ms(due, -1));
    expect((await record(id)).pseudonymised_at).toBeNull();
    await run(due);
    expect((await record(id)).metadata).toEqual({ changes: { lastName: { from: M, to: M } } });
  });

  it('the code boundary equals make_timestamptz(Y, 1, 1, 0, 0, 0, Europe/Berlin) for 2000 to 2100', async () => {
    const { rows } = await ctx.pool.query(
      `SELECT y, make_timestamptz(y, 1, 1, 0, 0, 0, 'Europe/Berlin') AS start FROM generate_series(2000, 2100) y ORDER BY y`,
    );
    expect(rows.map((r) => [r.y, berlinStartOfYear(r.y as number).toISOString()])).toEqual(rows.map((r) => [r.y, (r.start as Date).toISOString()]));
  });

  it('history semantics unchanged: other fields, CREATED and DEACTIVATED records and other entities stay, even when due', async () => {
    const party = await person('Erika Bleibt');
    const amended = await amend(party, { displayName: 'Erika Geändert', email: null });
    const created = (await ctx.pool.query(`SELECT id FROM audit_record WHERE entity_id = $1 AND action = 'CREATED'`, [party])).rows[0].id as string;
    const outcome = await ctx.parties.deactivate(party, REALM, 'Vertrag beendet, Erika Beispiel (synthetisch)', new Date('2026-03-06T00:00:00Z'), {
      actorType: 'USER',
      actorId: 'verwalterin@example.org',
    });
    expect(outcome.kind).toBe('DEACTIVATED');
    const deactivated = (await ctx.pool.query(`SELECT id FROM audit_record WHERE entity_id = $1 AND action = 'DEACTIVATED'`, [party])).rows[0].id as string;
    const others = [
      await raw({
        entityType: 'Loan',
        entityId: party,
        action: 'AMENDED',
        occurredAt: '2025-01-01T00:00:00Z',
        metadata: { changes: { notes: { from: 'Erika', to: null } } },
      }),
      await raw({
        entityType: 'RentalContractReference',
        entityId: party,
        action: 'AMENDED',
        occurredAt: '2025-01-01T00:00:00Z',
        metadata: { changedFields: ['evidence'], changedEvidence: [{ from: 'Mietvertrag Erika', to: 'Nachtrag Erika' }] },
      }),
      await raw({
        entityType: 'Weg',
        entityId: party,
        action: 'AMENDED',
        occurredAt: '2025-01-01T00:00:00Z',
        metadata: { changes: { displayName: { from: 'WEG A', to: 'WEG B' } } },
      }),
      // A Party record without a personal value (only nulls) is left unchanged and not marked.
      await raw({
        entityType: 'Party',
        entityId: party,
        action: 'AMENDED',
        occurredAt: '2025-01-01T00:00:00Z',
        metadata: { changes: { email: { from: null, to: null } } },
      }),
    ];
    await backdate([amended, created, deactivated], '2025-06-01T00:00:00Z');
    const untouched = await Promise.all([created, deactivated, ...others].map(record));
    await run(NOW_2037);
    expect(await Promise.all([created, deactivated, ...others].map(record))).toEqual(untouched);
    expect((await record(amended)).metadata).toEqual({ changes: { displayName: { from: M, to: M }, email: { from: M, to: null } } });
    expect((await documenting(party)).map((d) => d.metadata.paths)).toEqual([['changes.displayName.from', 'changes.displayName.to', 'changes.email.from']]);
    // DEACTIVATED keeps its reason (decision 3: other actions out of scope).
    expect((await record(deactivated)).metadata).toMatchObject({ reason: 'Vertrag beendet, Erika Beispiel (synthetisch)' });
  });

  it('idempotent: a second run writes nothing, the table is byte for byte the same', async () => {
    await run(NOW_2037);
    const before = await checksum();
    expect(await run(NOW_2037)).toBe(0);
    expect(await run(new Date('2050-01-01T00:00:00Z'))).toBeGreaterThanOrEqual(0);
    const later = await checksum();
    expect(await run(new Date('2050-01-01T00:00:00Z'))).toBe(0);
    expect(await checksum()).toEqual(later);
    expect(before.n).toBeLessThanOrEqual(later.n);
  });

  it('Realm isolation: each record keeps its entity; its AUDIT_PSEUDONYMISED record lies in the Party s own Realm; a record not due in the other Realm stays', async () => {
    await run(new Date('2050-01-01T00:00:00Z'));
    const a = await person('Gleicher Name', REALM);
    const b = await person('Gleicher Name', OTHER_REALM);
    const recA = await amend(a, { email: 'gleich@example.org' }, REALM);
    const recB = await amend(b, { email: 'gleich@example.org' }, OTHER_REALM);
    const recBNew = await amend(b, { email: 'neuer@example.org' }, OTHER_REALM);
    await backdate([recA, recB], '2026-05-01T00:00:00Z');
    await backdate([recBNew], '2027-05-01T00:00:00Z');
    expect(await run(NOW_2037)).toBe(2);
    // The Realm of a record is the Realm of its entity's row (audit_record has no Realm column).
    const realms = await ctx.pool.query(
      `SELECT a.metadata->>'auditRecordId' AS original, p.mre_realm_id FROM audit_record a JOIN party p ON p.id::text = a.entity_id
       WHERE a.action = 'AUDIT_PSEUDONYMISED' AND a.entity_id = ANY($1) ORDER BY p.mre_realm_id`,
      [[a, b]],
    );
    expect(realms.rows).toEqual([
      { original: recA, mre_realm_id: REALM },
      { original: recB, mre_realm_id: OTHER_REALM },
    ]);
    expect((await record(recBNew)).metadata).toEqual({ changes: { email: { from: 'gleich@example.org', to: 'neuer@example.org' } } });
  });

  it('two runs at once pseudonymise each record exactly once; a record locked by another transaction waits for the next run', async () => {
    await run(new Date('2050-01-01T00:00:00Z'));
    const party = await person('Gleichzeitig');
    const ids: string[] = [];
    for (let i = 0; i < 30; i += 1) ids.push(await amend(party, { phone: `+49 30 10000${String(i).padStart(2, '0')}` }));
    await backdate(ids, '2026-02-01T00:00:00Z');
    const counts = await Promise.all([run(NOW_2037, 7), run(NOW_2037, 7), run(NOW_2037, 7), run(NOW_2037, 7)]);
    expect(counts.reduce((s, n) => s + n, 0)).toBe(30);
    const per = await ctx.pool.query(
      `SELECT metadata->>'auditRecordId' AS id, count(*)::int AS n FROM audit_record WHERE action = 'AUDIT_PSEUDONYMISED' AND entity_id = $1 GROUP BY 1`,
      [party],
    );
    expect(per.rows.map((r) => r.n)).toEqual(ids.map(() => 1));
    // By hand: one due record locked elsewhere is skipped, then taken by the next run.
    const locked = await amend(party, { phone: '+49 30 2000000' });
    await backdate([locked], '2026-02-01T00:00:00Z');
    const holder = await ctx.pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(`SELECT 1 FROM audit_record WHERE id = $1 FOR UPDATE`, [locked]);
      expect(await run(NOW_2037)).toBe(0);
      await holder.query('COMMIT');
    } finally {
      holder.release();
    }
    expect(await run(NOW_2037)).toBe(1);
  });
});

describe.skipIf(databaseUrl === undefined)('the batches of the job (VC-X-24)', () => {
  const { ctx, record } = useAuditDatabase('audit_retention_batch_test');
  const PARTY = '0c000000-0000-4000-8000-0000000024aa';
  const metadata = { changes: { email: { from: 'alt@example.org', to: 'neu@example.org' } } };

  it('1201 due records in batches of 500: all pseudonymised, each with its own record', { timeout: 120_000 }, async () => {
    await ctx.pool.query(
      `INSERT INTO audit_record (entity_type, entity_id, action, occurred_at, actor_type, actor_id, metadata)
       SELECT 'Party', $1, 'AMENDED', '2026-04-01T00:00:00Z', 'USER', 'verwalterin@example.org', $2 FROM generate_series(1, 1201)`,
      [PARTY, JSON.stringify(metadata)],
    );
    expect(await pseudonymiseDueAuditRecords(ctx.db, NOW_2037)).toBe(1201);
    const counts = (
      await ctx.pool.query(
        `SELECT count(*) FILTER (WHERE action = 'AMENDED' AND pseudonymised_at IS NOT NULL)::int AS done, count(*) FILTER (WHERE action = 'AUDIT_PSEUDONYMISED')::int AS docs,
           count(DISTINCT metadata->>'auditRecordId') FILTER (WHERE action = 'AUDIT_PSEUDONYMISED')::int AS distinct_docs FROM audit_record WHERE entity_id = $1`,
        [PARTY],
      )
    ).rows[0];
    expect(counts).toEqual({ done: 1201, docs: 1201, distinct_docs: 1201 });
  });

  it('each batch is one transaction: a failure in the second batch keeps the first and rolls back the whole second', async () => {
    const ids = ['0a000000-0000-4000-8000-000000002401', '0a000000-0000-4000-8000-000000002402', '0a000000-0000-4000-8000-000000002403'];
    const fourth = '0a000000-0000-4000-8000-000000002404';
    const fifth = '0a000000-0000-4000-8000-000000002405';
    for (const id of [...ids, fourth, fifth]) {
      await ctx.pool.query(
        `INSERT INTO audit_record (id, entity_type, entity_id, action, occurred_at, actor_type, metadata) VALUES ($1, 'Party', 'p-batch', 'AMENDED', '2026-04-01T00:00:00Z', 'USER', $2)`,
        [id, JSON.stringify(metadata)],
      );
    }
    // A test trigger fails the documenting record of the fourth (second batch of two, its second record).
    await ctx.pool.query(`
      CREATE FUNCTION audit_test_fail() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.action = 'AUDIT_PSEUDONYMISED' AND NEW.metadata->>'auditRecordId' = '${fourth}' THEN RAISE EXCEPTION 'synthetic failure'; END IF;
        RETURN NEW;
      END $$`);
    await ctx.pool.query(`CREATE TRIGGER audit_test_fail BEFORE INSERT ON audit_record FOR EACH ROW EXECUTE FUNCTION audit_test_fail()`);
    try {
      await expect(pseudonymiseDueAuditRecords(ctx.db, NOW_2037, { batchSize: 2 })).rejects.toThrow('synthetic failure');
      const state = await Promise.all([...ids, fourth, fifth].map(async (id) => (await record(id)).pseudonymised_at !== null));
      expect(state).toEqual([true, true, false, false, false]);
    } finally {
      await ctx.pool.query(`DROP TRIGGER audit_test_fail ON audit_record`);
      await ctx.pool.query(`DROP FUNCTION audit_test_fail()`);
    }
    // Counter-check: without the failure the rest goes through.
    expect(await pseudonymiseDueAuditRecords(ctx.db, NOW_2037, { batchSize: 2 })).toBe(3);
  });
});

describe.skipIf(databaseUrl === undefined)('a restore of an older copy (VC-X-24, rule 9)', () => {
  const { ctx, person, amend, record, backdate } = useAuditDatabase('audit_retention_source_test');

  it('brings readable due values back; the run on start replaces them before it settles, with the same markers as before', { timeout: 120_000 }, async () => {
    const party = await person('Erika Restore');
    const id = await amend(party, { email: 'erika.neu@example.org', phone: '+49 30 0000009' });
    await backdate([id], '2026-03-05T09:00:00Z');
    // The older copy, taken before the job ran: every record as it was then.
    const copy = (await ctx.pool.query(`SELECT * FROM audit_record ORDER BY id`)).rows;
    await pseudonymiseDueAuditRecords(ctx.db, NOW_2037);
    const pseudonymised = await record(id);

    const schema = testSchemaName('audit_retention_restore_test');
    const admin = new pg.Client({ connectionString: databaseUrl });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.end();
    const restored = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 2 });
    try {
      await migrateToLatest(restored, { migrationTableSchema: schema });
      for (const r of copy) {
        await restored.query(
          `INSERT INTO audit_record (id, entity_type, entity_id, action, occurred_at, actor_type, actor_id, metadata, previous_version, new_version, pseudonymised_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
          [
            r.id,
            r.entity_type,
            r.entity_id,
            r.action,
            r.occurred_at,
            r.actor_type,
            r.actor_id,
            JSON.stringify(r.metadata),
            r.previous_version,
            r.new_version,
            r.pseudonymised_at,
          ],
        );
      }
      const readable = (await restored.query(`SELECT metadata FROM audit_record WHERE id = $1`, [id])).rows[0].metadata;
      expect(readable.changes.email.from).toBe('erika.alt@example.org');
      const lines: string[] = [];
      const job = startAuditPseudonymisation({
        pseudonymise: (now) => pseudonymiseDueAuditRecords(createDatabase(restored), now),
        log: (line) => lines.push(line),
        logError: (line) => lines.push(line),
        now: () => NOW_2037,
        timers: { setInterval: () => ({ unref: () => undefined }), clearInterval: () => undefined },
      });
      await job.firstRun;
      expect(lines).toEqual(['audit pseudonymisation: 1 record(s) pseudonymised (retention 10 years, created before 2027-01-01)']);
      const after = (await restored.query(`SELECT metadata, pseudonymised_at FROM audit_record WHERE id = $1`, [id])).rows[0];
      expect(after).toEqual({ metadata: pseudonymised.metadata, pseudonymised_at: NOW_2037 });
    } finally {
      await restored.end();
    }
  });
});
