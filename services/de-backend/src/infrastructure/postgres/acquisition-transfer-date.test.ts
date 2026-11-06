import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { planOwnerAllocation, type NewAcquisition, type RecordTransferDateInput } from '../../domains/acquisition/index.js';
import { Money, type BusinessDate } from '../../shared/index.js';
import { PostgresAcquisitionRepository } from './acquisition-repository.js';
import { createDatabase } from './database.js';
import { insertConfirmedAsBeforeVcX34 } from './legacy-acquisition.test-support.js';
import { migrateToLatest } from './migrate.js';
import { migrations } from './migrations/index.js';
import { PostgresOwnerAllocationSource } from './owner-allocation-source.js';
import { PostgresPartyRepository } from './party-repository.js';
import { withMigrationLock } from './tax-year.test-support.js';
import { testSchemaName } from './test-schema.test-support.js';

/**
 * §58N (VC-X-52, migration 0067; Entscheidung des Projektinhabers, 2026-11-04, Fragen 1–7) through PostgreSQL: the
 * command on legacy data inserted as CONFIRMED and on a DRAFT (then confirmed, with and without Ownerships), the
 * refusals with nothing written, idempotency, two recordings at once, Realm isolation, history; 0067's guards past the
 * repository, each with a counter-check; `ownershipStart` in 0050's functions; the acknowledgement kind; `down` refused
 * with a recorded date and otherwise restoring 0020's, 0022's, 0050's and 0065's functions verbatim. Synthetic only.
 */
const databaseUrl = process.env['DE_TEST_DATABASE_URL'];
const REALM = '64b0c0ffee0000000000005a';
const OTHER_REALM = '64b0c0ffee0000000000005b';
const actor = { actorType: 'USER', actorId: 'anna@example.com' } as const;
const day = (value: string) => value as BusinessDate;
const AT = new Date('2026-11-04T10:00:00Z');
const EVIDENCE = ['Übergabeprotokoll 2025-05-01 (synthetisch)'];
const record = (date: string, o: Partial<RecordTransferDateInput> = {}): RecordTransferDateInput => ({
  economicTransferDate: day(date),
  sourceReferences: EVIDENCE,
  notes: null,
  ...o,
});
const FUNCTIONS = [
  'acquisition_frozen()',
  'acquisition_step()',
  'acquisition_confirmation_violation(uuid)',
  'acquisition_increase_violation(uuid)',
  'tax_year_acknowledgement_item_shape()',
];
type Outcome = string | undefined;
const classify = (e: { code?: string; message?: string }): Outcome =>
  e.code === '23514'
    ? 'check'
    : /TRANSFER_DATE_MISSING/.test(e.message ?? '')
      ? 'missing'
      : /api-design §58N/.test(e.message ?? '')
        ? 'guard'
        : (e.message ?? e.code);
let counter = 0;

describe.skipIf(databaseUrl === undefined)('recording the economic transfer date (§58N, migration 0067)', () => {
  const schema = testSchemaName('acquisition_transfer_date_test');
  let pool: pg.Pool;
  let parties: PostgresPartyRepository;
  let acquisitions: PostgresAcquisitionRepository;

  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: databaseUrl });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.end();
    pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 6 });
    await migrateToLatest(pool, { migrationTableSchema: schema });
    const db = createDatabase(pool);
    parties = new PostgresPartyRepository(db);
    acquisitions = new PostgresAcquisitionRepository(db);
  });
  afterAll(async () => {
    await pool.end();
  });

  async function propertyReference(realm = REALM, on: pg.Pool = pool): Promise<string> {
    const mrePropertyId = (0x6512f0c2a1b2c3d4e5f90000n + BigInt(++counter)).toString(16).padStart(24, '0');
    const { rows } = await on.query(
      `INSERT INTO property_reference (mre_realm_id, mre_property_id, external_reference_state, created_by) VALUES ($1, $2, 'ACTIVE', 'x') RETURNING id`,
      [realm, mrePropertyId],
    );
    return rows[0].id as string;
  }
  async function party(name: string, realm = REALM): Promise<string> {
    const outcome = await parties.create(
      {
        mreRealmId: realm,
        partyType: 'PERSON',
        displayName: name,
        firstName: null,
        lastName: null,
        legalName: null,
        registrationNumber: null,
        email: null,
        phone: null,
      },
      actor,
    );
    if (outcome.kind !== 'CREATED') throw new Error(outcome.kind);
    return outcome.party.id;
  }
  async function draft(pr: string, buyer: string, o: Partial<NewAcquisition> = {}): Promise<string> {
    const outcome = await acquisitions.create(
      {
        mreRealmId: REALM,
        propertyReferenceId: pr,
        purchasePrice: Money.of('200000.00', 'EUR'),
        acquiredShare: { numerator: 1, denominator: 1 },
        contractDate: day('2025-03-01'),
        economicTransferDate: null,
        landRegistryTransferDate: null,
        buyerPartyIds: [buyer],
        sellerPartyIds: [],
        sourceReferences: [],
        notes: null,
        ...o,
      },
      actor,
    );
    if (outcome.kind !== 'CREATED') throw new Error(outcome.kind);
    return outcome.acquisition.id;
  }
  const own = async (pr: string, owner: string, from: string, acquisitionId: string | null, realm = REALM) =>
    (
      await pool.query(
        `INSERT INTO ownership (mre_realm_id, property_reference_id, owner_party_id, share_numerator, share_denominator, valid_from, status, acquisition_id, created_by)
         VALUES ($1, $2, $3, 1, 1, $4, 'VALID', $5, 'x') RETURNING id`,
        [realm, pr, owner, from, acquisitionId],
      )
    ).rows[0].id as string;
  /** The legacy example: P, L (contract 2025-03-01, undated, CONFIRMED), buyer A from 2025-03-01, seller S. */
  async function legacy(realm = REALM, sellerHolds = false) {
    const pr = await propertyReference(realm);
    const [a, s] = [await party('Käuferin A (synthetisch)', realm), await party('Verkäufer S (synthetisch)', realm)];
    let close: string[] = [];
    if (sellerHolds) {
      // S bought P earlier in DE: its Ownership carries that purchase, a part of an AfA component (§59A).
      const earlier = await insertConfirmedAsBeforeVcX34(pool, {
        mreRealmId: realm,
        propertyReferenceId: pr,
        contractDate: '2020-01-01',
        buyers: [{ partyId: s, share: [1, 1] }],
      });
      close = earlier.ownershipIds;
    }
    const l = await insertConfirmedAsBeforeVcX34(pool, {
      mreRealmId: realm,
      propertyReferenceId: pr,
      contractDate: '2025-03-01',
      purchasePrice: '200000.00',
      buyers: [{ partyId: a, share: [1, 1] }],
      sellerPartyIds: [s],
      close,
    });
    return { pr, a, s, l: l.acquisitionId, ownershipIds: l.ownershipIds };
  }
  const row = async (id: string) => (await pool.query(`SELECT to_jsonb(a) AS r FROM acquisition a WHERE id = $1`, [id])).rows[0]?.r;
  const audits = async (id: string) =>
    (await pool.query(`SELECT action, previous_version, new_version, metadata FROM audit_record WHERE entity_id = $1 ORDER BY occurred_at, id`, [id])).rows;
  const ownershipsOf = async (pr: string) =>
    (await pool.query(`SELECT to_jsonb(o) AS r FROM ownership o WHERE property_reference_id = $1 ORDER BY id`, [pr])).rows;
  const rec = (id: string, r: RecordTransferDateInput, o: { realm?: string; expectedVersions?: number[]; key?: string } = {}) =>
    acquisitions.recordEconomicTransferDate({
      id,
      mreRealmId: o.realm ?? REALM,
      record: r,
      at: AT,
      actor,
      ...(o.expectedVersions === undefined ? {} : { expectedVersions: o.expectedVersions }),
      ...(o.key === undefined ? {} : { idempotency: { key: o.key, fingerprint: JSON.stringify(r) } }),
    });

  it('the example: legacy L dated, version + 1, status and confirmedAt unchanged, one AuditRecord, no Ownership written, ownershipStart kept', async () => {
    const { pr, a, l } = await legacy();
    const before = await row(l);
    const ownershipsBefore = await ownershipsOf(pr);
    const outcome = await rec(l, record('2025-05-01'));
    if (outcome.kind !== 'RECORDED') throw new Error(outcome.kind);
    expect(outcome.acquisition).toMatchObject({
      status: 'CONFIRMED',
      economicTransferDate: '2025-05-01',
      economicTransferRecordedAt: AT,
      economicTransferSourceReferences: EVIDENCE,
      confirmedAt: new Date(before.confirmed_at),
      version: before.version + 1,
      // The seller is external (no AfA component in the Realm): informative.
      flags: [
        {
          code: 'OWNERSHIP_START_BEFORE_ECONOMIC_TRANSFER',
          level: 'INFORMATIVE',
          details: { acquisitionId: l, ownershipStart: '2025-03-01', economicTransferDate: '2025-05-01' },
        },
      ],
    });
    expect(await ownershipsOf(pr)).toEqual(ownershipsBefore);
    expect(await audits(l)).toEqual([
      {
        action: 'ECONOMIC_TRANSFER_DATE_RECORDED',
        previous_version: 2,
        new_version: 3,
        metadata: {
          economicTransferDate: '2025-05-01',
          sourceReferences: EVIDENCE,
          notes: null,
          contractDate: '2025-03-01',
          status: 'CONFIRMED',
          ownershipStart: '2025-03-01',
        },
      },
    ]);
    // §27.4 under (b): still read on the contract date, A's weight 1/1.
    const input = await new PostgresOwnerAllocationSource(createDatabase(pool)).read(l, REALM);
    const plan = planOwnerAllocation(input as never);
    expect(plan.kind === 'ALLOCATED' && plan.owners.map((o) => o.ownerPartyId)).toEqual([a]);
    // A read writes nothing.
    const n = (await pool.query(`SELECT count(*)::int AS n FROM audit_record`)).rows[0].n;
    expect((await acquisitions.findById(l, REALM))?.flags).toHaveLength(1);
    expect((await pool.query(`SELECT count(*)::int AS n FROM audit_record`)).rows[0].n).toBe(n);
  });

  it('the flag is OPEN when a seller of L holds a part of an AfA component in the Realm', async () => {
    const { l } = await legacy(REALM, true);
    const outcome = await rec(l, record('2025-05-01'));
    expect(outcome.kind === 'RECORDED' && outcome.acquisition.flags.map((f) => f.level)).toEqual(['OPEN']);
    // Counter-check: the transfer on the contract date raises no flag at all.
    const other = await legacy(REALM, true);
    const same = await rec(other.l, record('2025-03-01'));
    expect(same.kind === 'RECORDED' && same.acquisition.flags).toEqual([]);
  });

  it('a DRAFT dated by the command is confirmed: with Ownerships from the contract date, without any, and with the transfer on the contract date', async () => {
    for (const [date, ownBefore] of [
      ['2025-05-01', true],
      ['2025-05-01', false],
      ['2025-03-01', false],
    ] as const) {
      const pr = await propertyReference();
      const a = await party('Käufer D (synthetisch)');
      const d = await draft(pr, a);
      if (ownBefore) await own(pr, a, '2025-03-01', d);
      const recorded = await rec(d, record(date));
      expect(recorded.kind === 'RECORDED' && [recorded.acquisition.status, recorded.acquisition.version]).toEqual(['DRAFT', 2]);
      // ownershipStart is the contract date: the Ownerships are written from it (§58N Frage 4).
      if (!ownBefore) await own(pr, a, '2025-03-01', d);
      const confirmed = await acquisitions.confirm(d, REALM, AT, actor);
      expect(confirmed.kind === 'CONFIRMED' && [confirmed.acquisition.status, confirmed.acquisition.version]).toEqual(['CONFIRMED', 3]);
    }
    // Counter-check: a DRAFT created with 2025-05-01 and an Ownership from the contract date fails requirement 2.
    const pr = await propertyReference();
    const a = await party('Käufer E (synthetisch)');
    const d = await draft(pr, a, { economicTransferDate: day('2025-05-01') });
    await own(pr, a, '2025-03-01', d);
    expect((await acquisitions.confirm(d, REALM, AT, actor)).kind).toBe('CONFIRMATION_BLOCKED');
    expect((await pool.query(`SELECT acquisition_confirmation_violation($1) AS v`, [d])).rows[0].v).toBe('OWNERSHIP_NOT_FROM_TRANSFER_DATE');
  });

  it('the refusals write nothing: CANCELLED, already set (same and other date), before the contract date, a stale version, another Realm', async () => {
    const pr = await propertyReference();
    const a = await party('Käufer F (synthetisch)');
    const cancelled = await draft(pr, a);
    expect((await acquisitions.cancel(cancelled, REALM, 'geplatzt', AT, actor)).kind).toBe('CANCELLED');
    const { l } = await legacy();
    const dated = await draft(await propertyReference(), a, { economicTransferDate: day('2025-04-01') });
    const cases: [string, Promise<unknown>, unknown][] = [
      [cancelled, rec(cancelled, record('2025-05-01'), { expectedVersions: [1] }), { kind: 'ACQUISITION_CANCELLED' }],
      [dated, rec(dated, record('2025-04-01')), { kind: 'TRANSFER_DATE_ALREADY_SET', economicTransferDate: '2025-04-01' }],
      [dated, rec(dated, record('2025-06-01')), { kind: 'TRANSFER_DATE_ALREADY_SET', economicTransferDate: '2025-04-01' }],
      [l, rec(l, record('2025-02-28')), { kind: 'BEFORE_CONTRACT_DATE', contractDate: '2025-03-01' }],
      [l, rec(l, record('2025-05-01'), { expectedVersions: [1] }), { kind: 'VERSION_CONFLICT', expectedVersions: [1], currentVersion: 2 }],
      [l, rec(l, record('2025-05-01'), { realm: OTHER_REALM }), { kind: 'NOT_FOUND' }],
      ['not-a-uuid', rec('not-a-uuid', record('2025-05-01')), { kind: 'NOT_FOUND' }],
    ];
    for (const [id, pending, expected] of cases) {
      const before = id === 'not-a-uuid' ? undefined : await row(id);
      const auditsBefore = id === 'not-a-uuid' ? [] : await audits(id);
      expect(await pending).toEqual(expected);
      if (id !== 'not-a-uuid') {
        expect(await row(id)).toEqual(before);
        expect(await audits(id)).toEqual(auditsBefore);
      }
    }
    // Realm isolation: the other Realm's undated legacy row stays undated, and Realm A cannot date it.
    const theirs = await legacy(OTHER_REALM);
    expect(await rec(theirs.l, record('2025-05-01'))).toEqual({ kind: 'NOT_FOUND' });
    expect((await row(theirs.l)).economic_transfer_date).toBeNull();
    expect(await acquisitions.findById(theirs.l, REALM)).toBeUndefined();
  });

  it('idempotency: a replay answers the recorded body, another payload with the key 409, a retry without a key TRANSFER_DATE_ALREADY_SET', async () => {
    const { l } = await legacy();
    const first = await rec(l, record('2025-05-01'), { key: 'k-58n-1' });
    const replay = await rec(l, record('2025-05-01'), { key: 'k-58n-1' });
    expect(first.kind === 'RECORDED' && first.replayed).toBe(false);
    expect(replay.kind === 'RECORDED' && [replay.replayed, replay.acquisition.version, replay.acquisition.economicTransferRecordedAt]).toEqual([true, 3, AT]);
    expect(await rec(l, record('2025-06-01'), { key: 'k-58n-1' })).toEqual({ kind: 'IDEMPOTENCY_CONFLICT' });
    expect((await rec(l, record('2025-05-01'))).kind).toBe('TRANSFER_DATE_ALREADY_SET');
    expect((await audits(l)).filter((x) => x.action === 'ECONOMIC_TRANSFER_DATE_RECORDED')).toHaveLength(1);
  });

  it('two recordings at once: the second waits on the Acquisition lock and answers TRANSFER_DATE_ALREADY_SET', { timeout: 20_000 }, async () => {
    const { l } = await legacy();
    const holder = await pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(`SELECT 1 FROM acquisition WHERE id = $1 FOR UPDATE`, [l]);
      const pending = [rec(l, record('2025-05-01')), rec(l, record('2025-06-01'))];
      await new Promise((resolve) => setTimeout(resolve, 200));
      await holder.query('COMMIT');
      const kinds = (await Promise.all(pending)).map((o) => o.kind).sort();
      expect(kinds).toEqual(['RECORDED', 'TRANSFER_DATE_ALREADY_SET']);
    } finally {
      holder.release();
    }
  });

  describe('0067 past the repository', () => {
    /** The statement in its own transaction, rolled back. */
    async function attempt(statement: string, params: unknown[] = []): Promise<Outcome> {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        return await client.query(statement, params).then(() => 'accepted', classify);
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }
    }
    const SET = `economic_transfer_date = '2025-05-01', economic_transfer_recorded_at = now(), economic_transfer_source_references = ARRAY['Beleg'], version = version + 1`;

    it('the date guard: a set date never changes, a CANCELLED row takes none, never with a status step, a time or evidence alone, version + 1, nothing else', async () => {
      const { l } = await legacy();
      const pr = await propertyReference();
      const a = await party('Käufer G (synthetisch)');
      const cancelled = await draft(pr, a);
      await acquisitions.cancel(cancelled, REALM, 'geplatzt', AT, actor);
      const undatedDraft = await draft(await propertyReference(), a);
      // Counter-checks first: the one admitted change, on a CONFIRMED and on a DRAFT row.
      expect(await attempt(`UPDATE acquisition SET ${SET} WHERE id = $1`, [l])).toBe('accepted');
      expect(await attempt(`UPDATE acquisition SET ${SET} WHERE id = $1`, [undatedDraft])).toBe('accepted');
      expect(await attempt(`UPDATE acquisition SET ${SET} WHERE id = $1`, [cancelled])).toBe('guard');
      expect(await attempt(`UPDATE acquisition SET ${SET}, status = 'CONFIRMED', confirmed_at = now() WHERE id = $1`, [undatedDraft])).toBe('guard');
      expect(await attempt(`UPDATE acquisition SET economic_transfer_date = '2025-05-01', version = version + 1 WHERE id = $1`, [l])).toBe('guard');
      expect(await attempt(`UPDATE acquisition SET ${SET.replace('version = version + 1', 'version = version + 2')} WHERE id = $1`, [l])).toBe('guard');
      expect(await attempt(`UPDATE acquisition SET ${SET.replace(', version = version + 1', '')} WHERE id = $1`, [l])).toBe('guard');
      expect(await attempt(`UPDATE acquisition SET ${SET}, notes = 'anders' WHERE id = $1`, [l])).toBe('guard');
      // Evidence: at least one non-empty entry, at most ten (CHECK).
      expect(await attempt(`UPDATE acquisition SET ${SET.replace(`ARRAY['Beleg']`, `'{}'`)} WHERE id = $1`, [l])).toBe('check');
      expect(await attempt(`UPDATE acquisition SET ${SET.replace(`ARRAY['Beleg']`, `ARRAY['']`)} WHERE id = $1`, [l])).toBe('check');
      expect(await attempt(`UPDATE acquisition SET ${SET.replace(`ARRAY['Beleg']`, `array_fill('B'::text, ARRAY[11])`)} WHERE id = $1`, [l])).toBe('check');
      // Before the contract date: 0020's CHECK.
      expect(await attempt(`UPDATE acquisition SET ${SET.replace(`'2025-05-01'`, `'2025-02-28'`)} WHERE id = $1`, [l])).toBe('check');
      // Once recorded: never changed, also not to NULL.
      await pool.query(`UPDATE acquisition SET ${SET} WHERE id = $1`, [l]);
      expect(await attempt(`UPDATE acquisition SET economic_transfer_date = '2025-06-01', version = version + 1 WHERE id = $1`, [l])).toBe('guard');
      expect(
        await attempt(
          `UPDATE acquisition SET economic_transfer_date = NULL, economic_transfer_recorded_at = NULL, economic_transfer_source_references = NULL, version = version + 1 WHERE id = $1`,
          [l],
        ),
      ).toBe('guard');
      // A date set on create is never "recorded" later either.
      const created = await draft(await propertyReference(), a, { economicTransferDate: day('2025-04-01') });
      expect(await attempt(`UPDATE acquisition SET ${SET} WHERE id = $1`, [created])).toBe('guard');
      // The no-op write of every Ownership writer still passes on the recorded row.
      expect(await attempt(`UPDATE acquisition SET version = version WHERE id = $1`, [l])).toBe('accepted');
    });

    it('requirement 0 in the transition: a raw confirm without the date refused (TRANSFER_DATE_MISSING); counter-check: with the date it passes', async () => {
      const pr = await propertyReference();
      const a = await party('Käufer H (synthetisch)');
      const undated = await draft(pr, a);
      await own(pr, a, '2025-03-01', undated);
      const confirmRaw = `UPDATE acquisition SET status = 'CONFIRMED', confirmed_at = now(), version = version + 1 WHERE id = $1`;
      expect(await attempt(confirmRaw, [undated])).toBe('missing');
      const pr2 = await propertyReference();
      const dated = await draft(pr2, a, { economicTransferDate: day('2025-03-01') });
      await own(pr2, a, '2025-03-01', dated);
      expect(await attempt(confirmRaw, [dated])).toBe('accepted');
      // A DRAFT dated by the command, its Ownership from the contract date: 0050's functions read ownershipStart.
      await pool.query(`UPDATE acquisition SET ${SET} WHERE id = $1`, [undated]);
      expect(await attempt(confirmRaw, [undated])).toBe('accepted');
    });

    it('the acknowledgement kind on the entity Acquisition, without items; counter-checks: another entity refused, an item of another kind accepted', async () => {
      const pr = await propertyReference();
      const ack = (kind: string, entity: string) =>
        `INSERT INTO tax_year_acknowledgement (mre_realm_id, property_reference_id, tax_year, audit_record_id, change_kind, change_entity_type, change_entity_id,
           change_recorded_at, change_fingerprint, reason, acknowledged_by, status)
         VALUES ('${REALM}', '${pr}', 2025, gen_random_uuid(), '${kind}', '${entity}', gen_random_uuid(), now(), repeat('c', 64), 'Grund', 'anna@example.com', 'ACTIVE') RETURNING id`;
      expect(await attempt(ack('OWNERSHIP_START_BEFORE_ECONOMIC_TRANSFER', 'Acquisition'))).toBe('accepted');
      expect(await attempt(ack('OWNERSHIP_START_BEFORE_ECONOMIC_TRANSFER', 'Loan'))).toBe('check');
      expect(await attempt(ack('LOAN_CLOSED', 'Acquisition'))).toBe('check');
      const withItem = async (kind: string, entity: string) => {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const id = (await client.query(ack(kind, entity))).rows[0].id as string;
          return await client
            .query(`INSERT INTO tax_year_acknowledgement_item VALUES ($1, '${REALM}', gen_random_uuid(), 2025, 2026)`, [id])
            .then(() => 'accepted', classify);
        } finally {
          await client.query('ROLLBACK');
          client.release();
        }
      };
      expect(await withItem('OWNERSHIP_START_BEFORE_ECONOMIC_TRANSFER', 'Acquisition')).toBe('guard');
      expect(await withItem('LOAN_CLOSED', 'Loan')).toBe('accepted');
    });

    it(
      'down refused with a recorded date; otherwise restores 0020, 0022, 0050 and 0065 verbatim, an undated CONFIRMED row untouched; then up again',
      { timeout: 60_000 },
      async () => {
        const downSchema = testSchemaName('acquisition_transfer_date_down_test');
        const admin = new pg.Client({ connectionString: databaseUrl });
        await admin.connect();
        await admin.query(`CREATE SCHEMA "${downSchema}"`);
        await admin.end();
        const down = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${downSchema}`, max: 3 });
        try {
          // The migrations before 0067 (0068, VC-X-27, sorts after it and is applied with it below).
          const before0067 = Object.fromEntries(Object.entries(migrations).filter(([name]) => name < '0067'));
          await migrateToLatest(down, { migrationTableSchema: downSchema, migrations: before0067 });
          const defs = async () => {
            const out: string[] = [];
            for (const fn of FUNCTIONS) out.push((await down.query(`SELECT pg_get_functiondef($1::regprocedure) AS d`, [fn])).rows[0].d as string);
            const { rows } = await down.query(
              `SELECT conname, pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conrelid = 'tax_year_acknowledgement'::regclass AND contype = 'c' ORDER BY conname`,
            );
            return [...out, ...rows.map((r) => `${r.conname}: ${r.d}`)];
          };
          const original = await defs();
          const pr = await propertyReference(REALM, down);
          const createdParty = await new PostgresPartyRepository(createDatabase(down)).create(
            {
              mreRealmId: REALM,
              partyType: 'PERSON',
              displayName: 'L (synthetisch)',
              firstName: null,
              lastName: null,
              legalName: null,
              registrationNumber: null,
              email: null,
              phone: null,
            },
            actor,
          );
          if (createdParty.kind !== 'CREATED') throw new Error(createdParty.kind);
          const buyer = createdParty.party.id;
          const kept = await insertConfirmedAsBeforeVcX34(down, {
            mreRealmId: REALM,
            propertyReferenceId: pr,
            contractDate: '2025-03-01',
            buyers: [{ partyId: buyer, share: [1, 1] }],
          });
          const legacyRow = async () =>
            (
              await down.query(
                `SELECT to_jsonb(a) - 'economic_transfer_recorded_at' - 'economic_transfer_source_references' - 'ownership_aligned_at' - 'ownership_alignment_source_references' AS r FROM acquisition a WHERE id = $1`,
                [kept.acquisitionId],
              )
            ).rows[0].r;
          const untouched = await legacyRow();
          await migrateToLatest(down, { migrationTableSchema: downSchema });
          expect(await legacyRow()).toEqual(untouched);
          expect(await defs()).not.toEqual(original);
          const migration = migrations['0067_acquisition_transfer_date_record'] as { down: (db: never) => Promise<void> };
          // A recorded date: refused, nothing changed.
          const pr2 = await propertyReference(REALM, down);
          const other = await insertConfirmedAsBeforeVcX34(down, {
            mreRealmId: REALM,
            propertyReferenceId: pr2,
            contractDate: '2025-03-01',
            buyers: [{ partyId: buyer, share: [1, 1] }],
          });
          await down.query(`UPDATE acquisition SET ${SET} WHERE id = $1`, [other.acquisitionId]);
          {
            // Every down below runs under MIGRATION_ADVISORY_LOCK: a down drops columns, and Kysely's Migrator in a parallel
            // test file introspects every schema (pg_get_serial_sequence per column), which fails on a column dropped meanwhile.
            const refused = await withMigrationLock(() => migration.down(createDatabase(down) as never)).catch((e: unknown) => e);
            expect(refused).toMatchObject({ code: '23514' });
            // Counter-check: the recorded row removed (triggers off), down runs.
            for (const t of ['ownership', 'acquisition_party', 'acquisition']) await down.query(`ALTER TABLE ${t} DISABLE TRIGGER USER`);
            await down.query(`DELETE FROM ownership WHERE acquisition_id = $1`, [other.acquisitionId]);
            await down.query(`DELETE FROM acquisition_party WHERE acquisition_id = $1`, [other.acquisitionId]);
            await down.query(`DELETE FROM acquisition WHERE id = $1`, [other.acquisitionId]);
            for (const t of ['ownership', 'acquisition_party', 'acquisition']) await down.query(`ALTER TABLE ${t} ENABLE TRIGGER USER`);
            await withMigrationLock(async () => {
              // 0072 (VC-X-55) patches 0020's, 0050's and 0065's functions after 0067 did: its own down first (nothing aligned here).
              await (migrations['0072_ownership_extend_to_economic_transfer'] as { down: (db: never) => Promise<void> }).down(createDatabase(down) as never);
              // 0068 (VC-X-27, tax_classification only) sorts after 0067: its own down first (no cost-line classification here).
              // 0071 (VC-X-54) patches 0065's shape guard after 0067 did: its own down first (no acknowledgement of its kinds here).
              await (migrations['0071_tax_year_loan_schedule_part_kinds'] as { down: (db: never) => Promise<void> }).down(createDatabase(down) as never);
              // 0070 (VC-X-53, loan_terms only) sorts after 0069: its own down first (no interval other than 1 here).
              await (migrations['0070_loan_terms_payment_interval'] as { down: (db: never) => Promise<void> }).down(createDatabase(down) as never);
              // 0069 (VC-X-40, tax_classification only) sorts after 0068: its own down before it (no interest period here).
              await (migrations['0069_loan_interest_period'] as { down: (db: never) => Promise<void> }).down(createDatabase(down) as never);
              await (migrations['0068_hausgeld_cost_line_classification'] as { down: (db: never) => Promise<void> }).down(createDatabase(down) as never);
              await migration.down(createDatabase(down) as never);
            });
            await down.query(
              `DELETE FROM kysely_migration WHERE name IN ('0067_acquisition_transfer_date_record', '0068_hausgeld_cost_line_classification', '0069_loan_interest_period', '0070_loan_terms_payment_interval', '0071_tax_year_loan_schedule_part_kinds', '0072_ownership_extend_to_economic_transfer')`,
            );
          }
          expect(await defs()).toEqual(original);
          expect(await legacyRow()).toEqual(untouched);
          expect(
            (
              await down.query(
                `SELECT count(*)::int AS n FROM information_schema.columns WHERE table_schema = $1 AND column_name LIKE 'economic_transfer_re%'`,
                [downSchema],
              )
            ).rows[0].n,
          ).toBe(0);
          // up again: the guard back.
          await migrateToLatest(down, { migrationTableSchema: downSchema });
          expect(
            await down
              .query(`UPDATE acquisition SET economic_transfer_date = '2025-05-01', version = version + 1 WHERE id = $1`, [kept.acquisitionId])
              .then(() => 'accepted', classify),
          ).toBe('guard');
        } finally {
          await down.end();
        }
      },
    );
  });
});
