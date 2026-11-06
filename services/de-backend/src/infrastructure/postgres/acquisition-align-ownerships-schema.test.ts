import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { createDatabase } from './database.js';
import { insertConfirmedAsBeforeVcX34 } from './legacy-acquisition.test-support.js';
import { migrateToLatest } from './migrate.js';
import { migrations } from './migrations/index.js';
import { PostgresPartyRepository } from './party-repository.js';
import { withMigrationLock } from './tax-year.test-support.js';
import { testSchemaName } from './test-schema.test-support.js';
import { REALM, databaseUrl, useAlignSchema } from './align-ownerships.test-support.js';

/**
 * Migration 0072 (VC-X-55, api-design.md §58Q "Migration"; Entscheidung des Projektinhabers, 2026-11-05, Frage 10)
 * past the repository, each guard with its counter-check: `ownership_frozen` admits exactly the act's moves of an
 * aligned X (no other day, no other row, no unaligned X), `ownership_alignment_complete` refuses either half of the act
 * at commit, the write order (the reason for rule 3), `acquisition_frozen`'s marker rules and the CHECK, 0050's guard
 * protecting the buyers' new predecessors, the acknowledgement kind; `down` refused with an aligned row or an
 * acknowledgement, else restoring every function and CHECK verbatim against a schema migrated to 0071, then `up` again;
 * a legacy row untouched by both. Synthetic values only.
 */
const KIND = 'OWNERSHIP_EXTENDED_TO_ECONOMIC_TRANSFER';
const ALIGN = `UPDATE acquisition SET ownership_aligned_at = now(), ownership_alignment_source_references = ARRAY['Protokoll (synthetisch)'], version = version + 1 WHERE id = $1`;
const FROM = (date: string) => `UPDATE ownership SET valid_from = '${date}', version = version + 1 WHERE id = $1`;
const UNTIL = (date: string) => `UPDATE ownership SET valid_until = '${date}', version = version + 1 WHERE id = $1`;
const FUNCTIONS = [
  'acquisition_frozen()',
  'ownership_frozen()',
  'acquisition_confirmation_violation(uuid)',
  'acquisition_increase_violation(uuid)',
  'tax_year_acknowledgement_item_shape()',
];
const ackRow = (pr: string, o: Record<string, string> = {}) => {
  const v = {
    mre_realm_id: `'${REALM}'`,
    property_reference_id: `'${pr}'`,
    tax_year: '2025',
    audit_record_id: 'gen_random_uuid()',
    change_kind: `'${KIND}'`,
    change_entity_type: `'Acquisition'`,
    change_entity_id: 'gen_random_uuid()',
    change_recorded_at: 'now()',
    change_fingerprint: `repeat('c', 64)`,
    reason: `'Grund'`,
    acknowledged_by: `'anna@example.com'`,
    status: `'ACTIVE'`,
    ...o,
  };
  return `INSERT INTO tax_year_acknowledgement (${Object.keys(v).join(', ')}) VALUES (${Object.values(v).join(', ')}) RETURNING id`;
};
/** The refusal as a short word: the guard that fired, or `committed`. */
const short = (outcome: string) =>
  outcome === 'committed'
    ? 'committed'
    : /never extended/.test(outcome)
      ? 'never-extended'
      : /validFrom never change/.test(outcome)
        ? 'fixed'
        : /only as a whole \((\w+)/.test(outcome)
          ? `incomplete:${/only as a whole \((\w+)/.exec(outcome)?.[1]}`
          : /OWNERSHIP_TOTAL_EXCEEDS_ONE/.test(outcome)
            ? 'sum'
            : /^23514/.test(outcome)
              ? 'check'
              : /api-design §58Q/.test(outcome)
                ? `marker:${/\(([A-Z_]+), api-design §58Q\)/.exec(outcome)?.[1] ?? 'rule'}`
                : outcome;

describe.skipIf(databaseUrl === undefined)('the schema of 0072 past the repository (§58Q)', () => {
  const t = useAlignSchema('acquisition_align_ownerships_schema_test');
  const { example, inTransaction, align, party, propertyReference, own, recordDate } = t;
  const run = async (statements: readonly (readonly [string, readonly unknown[]])[]) => short(await inTransaction(statements));

  it('ownership_frozen: the raw act commits (counter-check); an extension without an aligned X refused, also with the buyers moved', async () => {
    const x = await example();
    expect(await run([[UNTIL('2025-04-30'), [x.oS]]])).toBe('never-extended');
    expect(await run([[FROM('2025-05-01'), [x.oA]]])).toBe('fixed');
    // Counter-check: X aligned first in the same transaction, then the buyers' start, then the seller's end: committed.
    expect(
      await run([
        [ALIGN, [x.l]],
        [FROM('2025-05-01'), [x.oA]],
        [UNTIL('2025-04-30'), [x.oS]],
      ]),
    ).toBe('committed');
  });

  it('ownership_frozen: another day than t − 1 or t, a row ending on another day than c − 1, a start moved on a row not carrying X', async () => {
    for (const day of ['2025-04-29', '2025-05-01', '2025-05-02']) {
      const x = await example();
      expect(
        await run([
          [ALIGN, [x.l]],
          [FROM('2025-05-01'), [x.oA]],
          [UNTIL(day), [x.oS]],
        ]),
        day,
      ).toBe('never-extended');
    }
    for (const day of ['2025-04-30', '2025-05-02', '2025-03-02']) {
      const x = await example();
      expect(
        await run([
          [ALIGN, [x.l]],
          [FROM(day), [x.oA]],
        ]),
        day,
      ).toBe('fixed');
    }
    // S's row ended one day earlier (c − 2): no row ends on c − 1, the extension of this one is refused.
    const early = await example();
    await t.ctx.pool.query(UNTIL('2025-02-27'), [early.oS]);
    expect(
      await run([
        [ALIGN, [early.l]],
        [FROM('2025-05-01'), [early.oA]],
        [UNTIL('2025-04-30'), [early.oS]],
      ]),
    ).toBe('never-extended');
    // A row starting on c that does not carry X (D 1/2 beside A 1/2 of L): its start stays.
    const pr = await propertyReference();
    const [s, a, d] = [await party('Verkäufer S (synthetisch)'), await party('Käuferin A (synthetisch)'), await party('Miteigentümer D (synthetisch)')];
    const w = await insertConfirmedAsBeforeVcX34(t.ctx.pool, {
      mreRealmId: REALM,
      propertyReferenceId: pr,
      contractDate: '2015-06-01',
      buyers: [{ partyId: s, share: [1, 1] }],
    });
    await t.ctx.pool.query(UNTIL('2025-02-28'), [w.ownershipIds[0]]);
    const oD = await own(pr, { owner: d, share: [1, 2], from: '2025-03-01' });
    const l = await insertConfirmedAsBeforeVcX34(t.ctx.pool, {
      mreRealmId: REALM,
      propertyReferenceId: pr,
      contractDate: '2025-03-01',
      acquiredShare: [1, 2],
      buyers: [{ partyId: a, share: [1, 2] }],
      sellerPartyIds: [s],
    });
    await recordDate(l.acquisitionId, '2025-05-01');
    expect(
      await run([
        [ALIGN, [l.acquisitionId]],
        [FROM('2025-05-01'), [oD]],
      ]),
    ).toBe('fixed');
  });

  it('ownership_alignment_complete: the marker alone, the buyers moved alone, the seller extended without the predecessor; counter-check the whole act', async () => {
    const x = await example();
    expect(await run([[ALIGN, [x.l]]])).toBe('incomplete:BUYER_ROW_NOT_MOVED');
    expect(
      await run([
        [ALIGN, [x.l]],
        [FROM('2025-05-01'), [x.oA]],
      ]),
    ).toBe('incomplete:SELLER_ROW_NOT_EXTENDED');
    // §28.1A: A held 1/2 (W) beside S 1/2; the predecessor left on c − 1 is refused at commit.
    const pr = await propertyReference();
    const [s, a] = [await party('Verkäufer S (synthetisch)'), await party('Käuferin A (synthetisch)')];
    const w = await insertConfirmedAsBeforeVcX34(t.ctx.pool, {
      mreRealmId: REALM,
      propertyReferenceId: pr,
      contractDate: '2015-06-01',
      buyers: [
        { partyId: a, share: [1, 2] },
        { partyId: s, share: [1, 2] },
      ],
    });
    const [wA, wS] = w.ownershipIds as [string, string];
    const l = await insertConfirmedAsBeforeVcX34(t.ctx.pool, {
      mreRealmId: REALM,
      propertyReferenceId: pr,
      contractDate: '2025-03-01',
      acquiredShare: [1, 2],
      buyers: [{ partyId: a, share: [1, 1] }],
      sellerPartyIds: [s],
      close: [wA, wS],
    });
    await recordDate(l.acquisitionId, '2025-05-01');
    const oX = l.ownershipIds[0] as string;
    // The 1/1 of A moved and S extended, the 1/2 of A (its predecessor) left on c − 1: refused at commit.
    expect(
      await run([
        [ALIGN, [l.acquisitionId]],
        [FROM('2025-05-01'), [oX]],
        [UNTIL('2025-04-30'), [wS]],
      ]),
    ).toBe('incomplete:BUYER_PREDECESSOR_NOT_EXTENDED');
    // Counter-check: the predecessor extended too; committed (0050's guard is passed by the write order).
    expect(
      await run([
        [ALIGN, [l.acquisitionId]],
        [FROM('2025-05-01'), [oX]],
        [UNTIL('2025-04-30'), [wS]],
        [UNTIL('2025-04-30'), [wA]],
      ]),
    ).toBe('committed');
    // 0050's guard protects the new predecessor (end t − 1, successor from t): moving its end is refused (a void of it is
    // refused by 0022's guard first, W being CONFIRMED); counter-check with 0050's guard disabled.
    const shorten = UNTIL('2025-04-29');
    expect(await inTransaction([[shorten, [wA]]])).toMatch(/carries the CONFIRMED Acquisition/);
    const client = await t.ctx.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('ALTER TABLE ownership DISABLE TRIGGER ownership_predecessor_of_confirmed');
      await expect(client.query(shorten, [wA])).resolves.toBeDefined();
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('the write order: the seller extended before the buyers moved is OWNERSHIP_TOTAL_EXCEEDS_ONE (the reason for rule 3)', async () => {
    const x = await example();
    expect(
      await run([
        [ALIGN, [x.l]],
        [UNTIL('2025-04-30'), [x.oS]],
        [FROM('2025-05-01'), [x.oA]],
      ]),
    ).toBe('sum');
  });

  it('acquisition_frozen and the CHECK: cancelled, undated, t = c, back to NULL, a status step, no version step, no evidence, empty evidence', async () => {
    // A DRAFT dated by §58N, then cancelled (no Ownership): no alignment.
    const pr = await propertyReference();
    const b = await party('Käufer B (synthetisch)');
    const { rows } = await t.ctx.pool.query(
      `INSERT INTO acquisition (mre_realm_id, property_reference_id, status, purchase_price, currency, acquired_share_numerator, acquired_share_denominator, contract_date, created_by)
       VALUES ($1, $2, 'DRAFT', 100000, 'EUR', 1, 1, '2025-03-01', 'x') RETURNING id`,
      [REALM, pr],
    );
    const draft = rows[0].id as string;
    await t.ctx.pool.query(`INSERT INTO acquisition_party (acquisition_id, mre_realm_id, party_id, role, position) VALUES ($1, $2, $3, 'BUYER', 1)`, [
      draft,
      REALM,
      b,
    ]);
    await recordDate(draft, '2025-05-01');
    // Counter-check on the DRAFT: the marker accepted by the guard and the CHECK (the commit then refuses nothing: no rows).
    expect(await run([[ALIGN, [draft]]])).toBe('committed');
    const cancelled = (
      await t.ctx.pool.query(
        `INSERT INTO acquisition (mre_realm_id, property_reference_id, status, purchase_price, currency, acquired_share_numerator, acquired_share_denominator, contract_date, created_by)
       VALUES ($1, $2, 'DRAFT', 100000, 'EUR', 1, 1, '2025-03-01', 'x') RETURNING id`,
        [REALM, pr],
      )
    ).rows[0].id as string;
    await recordDate(cancelled, '2025-05-01');
    await t.ctx.pool.query(
      `UPDATE acquisition SET status = 'CANCELLED', cancelled_at = now(), cancellation_reason = 'x', version = version + 1 WHERE id = $1`,
      [cancelled],
    );
    expect(await run([[ALIGN, [cancelled]]])).toBe('marker:ACQUISITION_CANCELLED');
    expect(await run([[ALIGN, [(await example({ transfer: null })).l]]])).toBe('marker:OWNERSHIP_EXTENSION_NOT_APPLICABLE');
    expect(await run([[ALIGN, [(await example({ transfer: '2025-03-01' })).l]]])).toBe('marker:OWNERSHIP_EXTENSION_NOT_APPLICABLE');
    const x = await example();
    expect((await align(x.l)).kind).toBe('ALIGNED');
    expect(
      await run([
        [`UPDATE acquisition SET ownership_aligned_at = NULL, ownership_alignment_source_references = NULL, version = version + 1 WHERE id = $1`, [x.l]],
      ]),
    ).toBe('marker:OWNERSHIPS_ALREADY_ALIGNED');
    expect(await run([[`UPDATE acquisition SET ownership_aligned_at = now(), version = version + 1 WHERE id = $1`, [x.l]]])).toBe(
      'marker:OWNERSHIPS_ALREADY_ALIGNED',
    );
    const y = await example();
    expect(await run([[`UPDATE acquisition SET ownership_aligned_at = now(), version = version + 1 WHERE id = $1`, [y.l]]])).toBe('marker:rule');
    expect(await run([[ALIGN.replace('version = version + 1', 'version = version'), [y.l]]])).toBe('marker:rule');
    expect(await run([[ALIGN.replace('version = version + 1', 'version = version + 2'), [y.l]]])).toBe('marker:rule');
    expect(await run([[ALIGN.replace(`ARRAY['Protokoll (synthetisch)']`, `ARRAY[]::text[]`), [y.l]]])).toBe('check');
    expect(await run([[ALIGN.replace(`ARRAY['Protokoll (synthetisch)']`, `ARRAY['']`), [y.l]]])).toBe('check');
    expect(await run([[ALIGN.replace('version = version + 1', `version = version + 1, notes = 'x'`), [y.l]]])).toBe('marker:rule');
    // A status step with the marker (on a DRAFT dated by §58N).
    const z = (
      await t.ctx.pool.query(
        `INSERT INTO acquisition (mre_realm_id, property_reference_id, status, purchase_price, currency, acquired_share_numerator, acquired_share_denominator, contract_date, created_by)
       VALUES ($1, $2, 'DRAFT', 100000, 'EUR', 1, 1, '2025-03-01', 'x') RETURNING id`,
        [REALM, await propertyReference()],
      )
    ).rows[0].id as string;
    await recordDate(z, '2025-05-01');
    expect(
      await run([
        [
          `UPDATE acquisition SET ownership_aligned_at = now(), ownership_alignment_source_references = ARRAY['x'], status = 'CANCELLED', cancelled_at = now(), cancellation_reason = 'x', version = version + 1 WHERE id = $1`,
          [z],
        ],
      ]),
    ).toBe('marker:rule');
  });

  it('the acknowledgement kind: on Acquisition accepted; on another entity refused; with an item refused (counter-check: none)', async () => {
    const pr = await propertyReference();
    expect(await inTransaction([[ackRow(pr), []]])).toBe('committed');
    expect(short(await inTransaction([[ackRow(pr, { change_entity_type: `'Loan'` }), []]]))).toBe('check');
    const client = await t.ctx.pool.connect();
    try {
      await client.query('BEGIN');
      const id = (await client.query(ackRow(pr))).rows[0].id as string;
      const item = await client.query(`INSERT INTO tax_year_acknowledgement_item VALUES ($1, '${REALM}', gen_random_uuid(), 2025, 2026)`, [id]).then(
        () => 'accepted',
        (e: Error) => e.message,
      );
      expect(item).toMatch(/takes no items/);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('no index: the guard reads acquisition by an existing key on its id and acquisition_party by its key', async () => {
    const x = await example();
    const client = await t.ctx.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL enable_seqscan = off');
      const plan = (
        await client.query(`EXPLAIN SELECT 1 FROM acquisition a JOIN acquisition_party ap ON ap.acquisition_id = a.id WHERE a.id = $1 AND ap.party_id = $2`, [
          x.l,
          x.s,
        ])
      ).rows
        .map((r) => r['QUERY PLAN'] as string)
        .join('\n');
      // Any of the existing keys led by `id` (0020's primary key or unique keys); no new index.
      expect(plan).toMatch(/Index (Only )?Scan using acquisition_(pkey|realm_key|ownership_key) on acquisition a/);
      expect(plan).toMatch(/acquisition_party_key/);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it(
    'down refused with an aligned row or an acknowledgement of the kind; else every function and CHECK of 0071 back verbatim, a legacy row untouched; then up again',
    { timeout: 60_000 },
    async () => {
      const downSchema = testSchemaName('acquisition_align_ownerships_down_test');
      const admin = new pg.Client({ connectionString: databaseUrl });
      await admin.connect();
      await admin.query(`CREATE SCHEMA "${downSchema}"`);
      await admin.end();
      const down = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${downSchema}`, max: 2 });
      try {
        const defs = async () => {
          const fns = [];
          for (const fn of FUNCTIONS) fns.push((await down.query(`SELECT pg_get_functiondef($1::regprocedure) AS d`, [fn])).rows[0].d as string);
          const { rows } = await down.query(
            `SELECT conrelid::regclass::text AS t, conname, pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conrelid IN ('acquisition'::regclass, 'tax_year_acknowledgement'::regclass) AND contype = 'c' ORDER BY 1, 2`,
          );
          const triggers = (
            await down.query(
              `SELECT tgrelid::regclass::text AS t, tgname FROM pg_trigger WHERE NOT tgisinternal AND tgrelid IN ('acquisition'::regclass, 'ownership'::regclass) ORDER BY 1, 2`,
            )
          ).rows;
          return [...fns, ...rows.map((r) => `${r.t}.${r.conname}: ${r.d}`), ...triggers.map((r) => `${r.t}.${r.tgname}`)];
        };
        const upTo0071 = Object.fromEntries(Object.entries(migrations).filter(([name]) => name < '0072'));
        await migrateToLatest(down, { migrationTableSchema: downSchema, migrations: upTo0071 });
        const original = await defs();
        const pr = (
          await down.query(
            `INSERT INTO property_reference (mre_realm_id, mre_property_id, external_reference_state, created_by) VALUES ($1, '6512f0c2a1b2c3d4e5f5ffff', 'ACTIVE', 'x') RETURNING id`,
            [REALM],
          )
        ).rows[0].id as string;
        const created = await new PostgresPartyRepository(createDatabase(down)).create(
          {
            mreRealmId: REALM,
            partyType: 'PERSON',
            displayName: 'Käufer (synthetisch)',
            firstName: null,
            lastName: null,
            legalName: null,
            registrationNumber: null,
            email: null,
            phone: null,
          },
          { actorType: 'USER', actorId: 'anna@example.com' },
        );
        if (created.kind !== 'CREATED') throw new Error(created.kind);
        const buyer = created.party.id;
        const kept = await insertConfirmedAsBeforeVcX34(down, {
          mreRealmId: REALM,
          propertyReferenceId: pr,
          contractDate: '2025-03-01',
          buyers: [{ partyId: buyer, share: [1, 1] }],
        });
        const legacyRow = async () =>
          (
            await down.query(`SELECT to_jsonb(a) - 'ownership_aligned_at' - 'ownership_alignment_source_references' AS r FROM acquisition a WHERE id = $1`, [
              kept.acquisitionId,
            ])
          ).rows[0].r;
        const untouched = await legacyRow();
        await migrateToLatest(down, { migrationTableSchema: downSchema });
        const after = await defs();
        expect(after).not.toEqual(original);
        expect(await legacyRow()).toEqual(untouched);
        expect((await down.query(`SELECT ownership_aligned_at FROM acquisition WHERE id = $1`, [kept.acquisitionId])).rows[0].ownership_aligned_at).toBeNull();
        const migration = migrations['0072_ownership_extend_to_economic_transfer'] as { up: (db: never) => Promise<void>; down: (db: never) => Promise<void> };
        const refused = async () => {
          let error: unknown;
          await withMigrationLock(async () => {
            error = await migration.down(createDatabase(down) as never).catch((e: unknown) => e);
          });
          return error;
        };
        // An acknowledgement of the kind: refused, nothing changed; also an aligned row (the marker set with triggers off).
        const ack = (await down.query(ackRow(pr))).rows[0].id as string;
        expect(await refused()).toMatchObject({ code: '23514' });
        expect(await defs()).toEqual(after);
        await down.query(`ALTER TABLE tax_year_acknowledgement DISABLE TRIGGER USER`);
        await down.query(`DELETE FROM tax_year_acknowledgement WHERE id = $1`, [ack]);
        await down.query(`ALTER TABLE tax_year_acknowledgement ENABLE TRIGGER USER`);
        await down.query(`ALTER TABLE acquisition DISABLE TRIGGER USER`);
        await down.query(
          `UPDATE acquisition SET economic_transfer_date = '2025-05-01', economic_transfer_recorded_at = now(), economic_transfer_source_references = ARRAY['x'], ownership_aligned_at = now(), ownership_alignment_source_references = ARRAY['x'] WHERE id = $1`,
          [kept.acquisitionId],
        );
        expect(await refused()).toMatchObject({ code: '23514' });
        expect(await defs()).toEqual(after);
        // Counter-check: the marker removed, down runs and restores 0071's state verbatim.
        await down.query(
          `UPDATE acquisition SET economic_transfer_date = NULL, economic_transfer_recorded_at = NULL, economic_transfer_source_references = NULL, ownership_aligned_at = NULL, ownership_alignment_source_references = NULL WHERE id = $1`,
          [kept.acquisitionId],
        );
        await down.query(`ALTER TABLE acquisition ENABLE TRIGGER USER`);
        await withMigrationLock(() => migration.down(createDatabase(down) as never));
        expect(await defs()).toEqual(original);
        expect(await legacyRow()).toEqual(untouched);
        // up again: the same state as after the first up; up on the patched functions fails and changes nothing.
        await withMigrationLock(() => migration.up(createDatabase(down) as never));
        expect(await defs()).toEqual(after);
        let again: unknown;
        await withMigrationLock(async () => {
          again = await migration.up(createDatabase(down) as never).catch((e: unknown) => e);
        });
        expect(String(again)).toMatch(/already exists|holds the passage to replace 0 times/);
        expect(await defs()).toEqual(after);
      } finally {
        await down.end();
      }
    },
  );
});
