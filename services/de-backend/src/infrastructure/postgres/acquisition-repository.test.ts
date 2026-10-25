import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFingerprint, type NewAcquisition } from '../../domains/acquisition/index.js';
import { changeFingerprint, type NewOwnership } from '../../domains/ownership/index.js';
import { Money, type BusinessDate } from '../../shared/index.js';
import { PostgresAcquisitionRepository } from './acquisition-repository.js';
import { createDatabase } from './database.js';
import { migrateToLatest } from './migrate.js';
import { PostgresOwnershipRepository } from './ownership-repository.js';
import { PostgresPartyRepository } from './party-repository.js';
import { testSchemaName } from './test-schema.test-support.js';

/**
 * VC-2-05 persistence (api-design.md §27.1): drafts with their parties, the order of checks, idempotency, cancel with
 * its refusals, the reads, the schema's own rules, and the Ownership link (`acquisitionId`) with its lock order.
 */
const databaseUrl = process.env['DE_TEST_DATABASE_URL'];

const REALM = '64b0c0ffee0000000000000a';
const OTHER_REALM = '64b0c0ffee0000000000000b';
const actor = { actorType: 'USER', actorId: 'anna@example.com' } as const;
const day = (value: string) => value as BusinessDate;
let counter = 0;

async function waitUntil(condition: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error('condition not reached');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe.skipIf(databaseUrl === undefined)('PostgresAcquisitionRepository', () => {
  const schema = testSchemaName('acquisition_test');
  let pool: pg.Pool;
  let parties: PostgresPartyRepository;
  let ownerships: PostgresOwnershipRepository;
  let acquisitions: PostgresAcquisitionRepository;

  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: databaseUrl });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.end();
    pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 10 });
    await migrateToLatest(pool, { migrationTableSchema: schema });
    const db = createDatabase(pool);
    parties = new PostgresPartyRepository(db);
    ownerships = new PostgresOwnershipRepository(db);
    acquisitions = new PostgresAcquisitionRepository(db);
  });

  afterAll(async () => {
    await pool.end();
  });

  async function propertyReference(realm = REALM): Promise<string> {
    const mrePropertyId = (0x6512f0c2a1b2c3d4e5f80000n + BigInt(++counter)).toString(16).padStart(24, '0');
    const { rows } = await pool.query(
      `INSERT INTO property_reference (mre_realm_id, mre_property_id, external_reference_state, created_by) VALUES ($1, $2, 'ACTIVE', 'x') RETURNING id`,
      [realm, mrePropertyId],
    );
    return rows[0].id as string;
  }
  async function party(name: string, realm = REALM): Promise<string> {
    const outcome = await parties.create(
      { mreRealmId: realm, partyType: 'PERSON', displayName: name, firstName: null, lastName: null, legalName: null, registrationNumber: null, email: null, phone: null },
      actor,
    );
    if (outcome.kind !== 'CREATED') throw new Error(outcome.kind);
    return outcome.party.id;
  }
  const draft = (propertyReferenceId: string, buyers: string[], overrides: Partial<NewAcquisition> = {}): NewAcquisition => ({
    mreRealmId: REALM,
    propertyReferenceId,
    purchasePrice: Money.of('350000.00', 'EUR'),
    acquiredShare: { numerator: 1, denominator: 1 },
    contractDate: day('2026-06-15'),
    economicTransferDate: day('2026-08-01'),
    landRegistryTransferDate: null,
    buyerPartyIds: buyers,
    sellerPartyIds: [],
    sourceReferences: [],
    notes: null,
    ...overrides,
  });
  async function created(acquisition: NewAcquisition) {
    const outcome = await acquisitions.create(acquisition, actor);
    if (outcome.kind !== 'CREATED') throw new Error(outcome.kind);
    return outcome.acquisition;
  }
  const ownership = (pr: string, owner: string, acquisitionId: string | null, overrides: Partial<NewOwnership> = {}): NewOwnership => ({
    mreRealmId: REALM,
    propertyReferenceId: pr,
    ownerPartyId: owner,
    share: { numerator: 1, denominator: 1 },
    validFrom: day('2026-08-01'),
    validUntil: null,
    acquisitionId,
    sourceReferences: [],
    notes: null,
    ...overrides,
  });

  it('create: a DRAFT with its parties in the order given, the price exact, and an AuditRecord', async () => {
    const pr = await propertyReference();
    const [anna, ben, seller] = [await party('Anna'), await party('Ben'), await party('Verkäufer')];
    const acquisition = await created(
      draft(pr, [ben, anna], { sellerPartyIds: [seller], acquiredShare: { numerator: 1, denominator: 2 }, purchasePrice: Money.of('175000.05', 'EUR'), notes: 'Notar Müller' }),
    );
    expect(acquisition).toMatchObject({
      mreRealmId: REALM,
      propertyReferenceId: pr,
      status: 'DRAFT',
      acquiredShare: { numerator: 1, denominator: 2 },
      contractDate: '2026-06-15',
      economicTransferDate: '2026-08-01',
      landRegistryTransferDate: null,
      buyerPartyIds: [ben, anna],
      sellerPartyIds: [seller],
      notes: 'Notar Müller',
      cancelledAt: null,
      confirmedAt: null,
      version: 1,
    });
    expect(acquisition.purchasePrice.amount).toBe('175000.05');
    expect(await acquisitions.findById(acquisition.id, REALM)).toEqual(acquisition);
    expect(await acquisitions.findById(acquisition.id, OTHER_REALM)).toBeUndefined();
    expect((await pool.query(`SELECT action, metadata FROM audit_record WHERE entity_type = 'Acquisition' AND entity_id = $1`, [acquisition.id])).rows).toEqual([
      {
        action: 'CREATED',
        metadata: {
          propertyReferenceId: pr,
          purchasePrice: { amount: '175000.05', currency: 'EUR' },
          acquiredShare: '1/2',
          contractDate: '2026-06-15',
          economicTransferDate: '2026-08-01',
          landRegistryTransferDate: null,
          buyerPartyIds: [ben, anna],
          sellerPartyIds: [seller],
        },
      },
    ]);
  });

  it('create: the order of checks (PropertyReference, unknown parties buyers first, inactive buyer); an inactive seller is fine; a refusal writes nothing', async () => {
    const pr = await propertyReference();
    const [anna, gone] = [await party('Anna'), await party('Verstorben')];
    await parties.deactivate(gone, REALM, 'verstorben', new Date(), actor);
    const foreign = await party('Fremd', OTHER_REALM);
    const keyed = (a: NewAcquisition) => acquisitions.create(a, actor, { key: `k-${++counter}`, fingerprint: createFingerprint(a) });
    expect(await keyed(draft(await propertyReference(OTHER_REALM), [anna]))).toEqual({ kind: 'PROPERTY_REFERENCE_NOT_FOUND' });
    expect(await keyed(draft(pr, [anna, foreign]))).toEqual({ kind: 'PARTY_NOT_FOUND', partyId: foreign });
    expect(await keyed(draft(pr, [gone], { sellerPartyIds: [foreign] }))).toEqual({ kind: 'PARTY_NOT_FOUND', partyId: foreign });
    expect(await keyed(draft(pr, [gone]))).toEqual({ kind: 'PARTY_INACTIVE', partyId: gone });
    expect((await pool.query(`SELECT count(*)::int AS n FROM acquisition WHERE property_reference_id = $1`, [pr])).rows[0].n).toBe(0);
    expect((await pool.query(`SELECT count(*)::int AS n FROM idempotency_key WHERE scope = 'acquisition.create'`)).rows[0].n).toBe(0);
    // An inactive seller (an estate selling) is fine.
    expect(await created(draft(pr, [anna], { sellerPartyIds: [gone] }))).toMatchObject({ sellerPartyIds: [gone] });
  });

  it('create: Idempotency-Key replays the recorded draft, another payload conflicts; two drafts of one PropertyReference may exist', async () => {
    const pr = await propertyReference();
    const anna = await party('Anna');
    const a = draft(pr, [anna]);
    const key = { key: 'acq-1', fingerprint: createFingerprint(a) };
    const first = await acquisitions.create(a, actor, key);
    if (first.kind !== 'CREATED') throw new Error(first.kind);
    expect(await acquisitions.create(a, actor, key)).toEqual({ kind: 'REPLAYED', acquisition: first.acquisition });
    const other = { ...a, purchasePrice: Money.of('1.00', 'EUR') };
    expect(await acquisitions.create(other, actor, { key: 'acq-1', fingerprint: createFingerprint(other) })).toEqual({ kind: 'IDEMPOTENCY_CONFLICT' });
    expect((await created(a)).id).not.toBe(first.acquisition.id);
  });

  it('cancel: once, with its reason; a repeat keeps the first whatever If-Match says; refused while VALID Ownerships carry it; a confirmed one is final', async () => {
    const pr = await propertyReference();
    const anna = await party('Anna');
    const a = await created(draft(pr, [anna]));
    const o = await ownerships.create(ownership(pr, anna, a.id), actor);
    if (o.kind !== 'CREATED') throw new Error(o.kind);
    expect(o.ownership.acquisitionId).toBe(a.id);
    const at = new Date('2026-10-25T10:00:00Z');
    expect(await acquisitions.cancel(a.id, REALM, 'geplatzt', at, actor)).toEqual({ kind: 'ACQUISITION_HAS_VALID_OWNERSHIPS', ownershipIds: [o.ownership.id] });
    await ownerships.void(o.ownership.id, REALM, 'Kauf geplatzt', new Date(), actor);
    expect(await acquisitions.cancel(a.id, REALM, 'geplatzt', at, actor, [7])).toEqual({ kind: 'VERSION_CONFLICT', expectedVersions: [7], currentVersion: 1 });
    expect(await acquisitions.cancel(a.id, REALM, 'geplatzt', at, actor, [1])).toMatchObject({
      kind: 'CANCELLED',
      changed: true,
      acquisition: { status: 'CANCELLED', cancelledAt: at, cancellationReason: 'geplatzt', version: 2 },
    });
    expect(await acquisitions.cancel(a.id, REALM, 'anders', new Date(), actor, [1])).toMatchObject({
      kind: 'CANCELLED',
      changed: false,
      acquisition: { cancellationReason: 'geplatzt', cancelledAt: at, version: 2 },
    });
    expect((await pool.query(`SELECT action, metadata FROM audit_record WHERE entity_id = $1 ORDER BY occurred_at, id`, [a.id])).rows.at(-1)).toEqual({
      action: 'CANCELLED',
      metadata: { reason: 'geplatzt' },
    });
    // Confirmation comes with VC-2-07; a confirmed row (written directly) is final for cancel.
    const confirmed = await created(draft(pr, [anna]));
    await pool.query(`UPDATE acquisition SET status = 'CONFIRMED', confirmed_at = now(), version = 2 WHERE id = $1`, [confirmed.id]);
    expect(await acquisitions.cancel(confirmed.id, REALM, 'x', at, actor)).toEqual({ kind: 'ACQUISITION_CONFIRMED' });
    expect(await acquisitions.cancel(confirmed.id, OTHER_REALM, 'x', at, actor)).toEqual({ kind: 'NOT_FOUND' });
    expect(await acquisitions.cancel('nope', REALM, 'x', at, actor)).toEqual({ kind: 'NOT_FOUND' });
  });

  it('the Ownership link: only a DRAFT of the same Realm and PropertyReference; fixed afterwards; also on ownership-changes', async () => {
    const [pr, otherPr] = [await propertyReference(), await propertyReference()];
    const [anna, ben] = [await party('Anna'), await party('Ben')];
    const a = await created(draft(pr, [anna]));
    const elsewhere = await created(draft(otherPr, [anna]));
    expect(await ownerships.create(ownership(pr, anna, elsewhere.id), actor)).toEqual({ kind: 'ACQUISITION_NOT_FOUND', acquisitionId: elsewhere.id });
    expect(await ownerships.create(ownership(pr, anna, '0b6f1f9e-2f2c-4a8e-9d55-1f0d8c1e2a3b'), actor)).toEqual({
      kind: 'ACQUISITION_NOT_FOUND',
      acquisitionId: '0b6f1f9e-2f2c-4a8e-9d55-1f0d8c1e2a3b',
    });
    const cancelled = await created(draft(pr, [anna]));
    await acquisitions.cancel(cancelled.id, REALM, 'x', new Date(), actor);
    expect(await ownerships.create(ownership(pr, anna, cancelled.id), actor)).toEqual({ kind: 'ACQUISITION_NOT_DRAFT', acquisitionId: cancelled.id, status: 'CANCELLED' });

    const o = await ownerships.create(ownership(pr, anna, a.id, { share: { numerator: 1, denominator: 2 } }), actor);
    if (o.kind !== 'CREATED') throw new Error(o.kind);
    await expect(pool.query(`UPDATE ownership SET acquisition_id = NULL WHERE id = $1`, [o.ownership.id])).rejects.toThrow(/never change/);
    await expect(
      pool.query(`UPDATE ownership SET acquisition_id = $2 WHERE id = $1`, [o.ownership.id, elsewhere.id]),
    ).rejects.toThrow(/ownership_acquisition_fk|never change/);

    // A sale of half to Ben within the same draft, as an ownership-change.
    const change = {
      mreRealmId: REALM,
      propertyReferenceId: pr,
      effectiveDate: day('2027-01-01'),
      reason: 'Verkauf',
      close: [],
      create: [{ ownerPartyId: ben, share: { numerator: 1, denominator: 2 }, sourceReferences: [], notes: null }],
      acquisitionId: a.id,
    };
    expect(await ownerships.change(change, actor, { key: 'chg', fingerprint: changeFingerprint(change) })).toMatchObject({
      kind: 'CHANGED',
      result: { created: [{ ownerPartyId: ben, acquisitionId: a.id }] },
    });
    expect(await ownerships.change({ ...change, acquisitionId: cancelled.id, effectiveDate: day('2028-01-01') }, actor)).toEqual({
      kind: 'ACQUISITION_NOT_DRAFT',
      acquisitionId: cancelled.id,
      status: 'CANCELLED',
    });
  });

  it('a cancel racing an Ownership create for the draft: the create holds the Acquisition FOR SHARE, the cancel then sees its Ownership', async () => {
    const pr = await propertyReference();
    const anna = await party('Anna');
    const a = await created(draft(pr, [anna]));
    const holder = await pool.connect();
    try {
      await holder.query('BEGIN');
      // An Ownership create past the repository: it holds the PropertyReference (trigger) and the Acquisition.
      await holder.query(`SELECT 1 FROM acquisition WHERE id = $1 FOR SHARE`, [a.id]);
      const { rows } = await holder.query(
        `INSERT INTO ownership (mre_realm_id, property_reference_id, owner_party_id, share_numerator, share_denominator, valid_from, status, acquisition_id, created_by)
         VALUES ($1, $2, $3, 1, 1, '2026-08-01', 'VALID', $4, 'x') RETURNING id`,
        [REALM, pr, anna, a.id],
      );
      const cancelling = acquisitions.cancel(a.id, REALM, 'geplatzt', new Date(), actor);
      await waitUntil(async () =>
        Number(
          (
            await pool.query(
              `SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%"property_reference"%'`,
            )
          ).rows[0].count,
        ) >= 1,
      );
      await holder.query('COMMIT');
      expect(await cancelling).toEqual({ kind: 'ACQUISITION_HAS_VALID_OWNERSHIPS', ownershipIds: [rows[0].id] });
    } finally {
      holder.release();
    }
  });

  it('reads: newest contract first; filters by status, PropertyReference and party; paged; Realm-scoped', async () => {
    const [pr, otherPr] = [await propertyReference(), await propertyReference()];
    const [anna, ben, carl] = [await party('Anna'), await party('Ben'), await party('Carl')];
    const realm = '64b0c0ffee0000000000000c';
    const [prC, annaC, benC] = [await propertyReference(realm), await party('Anna C', realm), await party('Ben C', realm)];
    const old = await created(draft(prC, [annaC], { mreRealmId: realm, contractDate: day('2020-01-01'), economicTransferDate: null }));
    const recent = await created(draft(prC, [benC], { mreRealmId: realm, sellerPartyIds: [annaC], contractDate: day('2026-01-01'), economicTransferDate: null }));
    await acquisitions.cancel(old.id, realm, 'x', new Date(), actor);
    const page = { page: 1, pageSize: 50 };
    expect((await acquisitions.list(realm, {}, page)).items.map((a) => a.id)).toEqual([recent.id, old.id]);
    expect((await acquisitions.list(realm, { status: 'CANCELLED' }, page)).items.map((a) => a.id)).toEqual([old.id]);
    expect((await acquisitions.list(realm, { partyId: annaC }, page)).items.map((a) => a.id)).toEqual([recent.id, old.id]);
    expect((await acquisitions.list(realm, { partyId: benC }, page)).items.map((a) => a.id)).toEqual([recent.id]);
    expect(await acquisitions.list(realm, {}, { page: 2, pageSize: 1 })).toMatchObject({ items: [{ id: old.id }], total: 2 });
    await created(draft(pr, [anna]));
    await created(draft(otherPr, [ben], { sellerPartyIds: [carl] }));
    expect((await acquisitions.list(REALM, { propertyReferenceId: otherPr }, page)).items.map((a) => a.buyerPartyIds)).toEqual([[ben]]);
    expect((await acquisitions.list(realm, { propertyReferenceId: pr }, page)).total).toBe(0);
  });

  it('the schema: Realm-bound keys, price and share rules, date order, status fields, frozen data, final status, fixed parties', async () => {
    const pr = await propertyReference();
    const [anna, ben] = [await party('Anna'), await party('Ben')];
    const insert = (set: Record<string, string>) => {
      const values = {
        mre_realm_id: `'${REALM}'`,
        property_reference_id: `'${pr}'`,
        status: `'DRAFT'`,
        purchase_price: '1000',
        currency: `'EUR'`,
        acquired_share_numerator: '1',
        acquired_share_denominator: '1',
        contract_date: `'2026-06-15'`,
        created_by: `'x'`,
        ...set,
      };
      return pool.query(`INSERT INTO acquisition (${Object.keys(values).join(', ')}) VALUES (${Object.values(values).join(', ')}) RETURNING id`);
    };
    await expect(insert({ mre_realm_id: `'${OTHER_REALM}'` })).rejects.toThrow(/acquisition_property_reference_fk/);
    await expect(insert({ purchase_price: '0' })).rejects.toThrow(/acquisition_purchase_price_check/);
    await expect(insert({ purchase_price: '1.005' })).rejects.toThrow(/acquisition_purchase_price_check/);
    await expect(insert({ acquired_share_numerator: '2', acquired_share_denominator: '4' })).rejects.toThrow(/acquisition_share/);
    await expect(insert({ economic_transfer_date: `'2026-06-14'` })).rejects.toThrow(/acquisition_transfer_dates/);
    await expect(insert({ land_registry_transfer_date: `'2026-06-14'` })).rejects.toThrow(/acquisition_transfer_dates/);
    await expect(insert({ status: `'CANCELLED'` })).rejects.toThrow(/acquisition_status_fields/);
    await expect(insert({ status: `'CONFIRMED'` })).rejects.toThrow(/acquisition_status_fields/);

    const a = await created(draft(pr, [anna]));
    const update = (set: string) => pool.query(`UPDATE acquisition SET ${set} WHERE id = $1`, [a.id]);
    await expect(update(`purchase_price = 1`)).rejects.toThrow(/never changes/);
    await expect(update(`contract_date = '2026-01-01', economic_transfer_date = NULL`)).rejects.toThrow(/never changes/);
    await expect(update(`version = version + 1`)).rejects.toThrow(/only with a status transition/);
    await expect(pool.query(`DELETE FROM acquisition_party WHERE acquisition_id = $1`, [a.id])).rejects.toThrow(/never change/);
    await expect(pool.query(`UPDATE acquisition_party SET role = 'SELLER' WHERE acquisition_id = $1`, [a.id])).rejects.toThrow(/never change/);
    await expect(
      pool.query(`INSERT INTO acquisition_party (acquisition_id, mre_realm_id, party_id, role, position) VALUES ($1, $2, $3, 'SELLER', 1)`, [a.id, REALM, anna]),
    ).rejects.toThrow(/acquisition_party_key/);
    await update(`status = 'CANCELLED', cancelled_at = now(), cancellation_reason = 'x', version = 2`);
    await expect(update(`status = 'DRAFT', cancelled_at = NULL, cancellation_reason = NULL`)).rejects.toThrow(/final/);
    await expect(
      pool.query(`INSERT INTO acquisition_party (acquisition_id, mre_realm_id, party_id, role, position) VALUES ($1, $2, $3, 'BUYER', 2)`, [a.id, REALM, ben]),
    ).rejects.toThrow(/with the draft only/);
    // A party row of another Realm than its (draft) Acquisition.
    const b = await created(draft(pr, [anna]));
    await expect(
      pool.query(`INSERT INTO acquisition_party (acquisition_id, mre_realm_id, party_id, role, position) VALUES ($1, $2, $3, 'SELLER', 1)`, [b.id, OTHER_REALM, ben]),
    ).rejects.toThrow(/acquisition_party_acquisition_fk/);
  });

  it('the invariant trigger message shows the sum as integers (review on #45)', async () => {
    const pr = await propertyReference();
    const [anna, ben] = [await party('Anna'), await party('Ben')];
    await ownerships.create(ownership(pr, anna, null, { share: { numerator: 1, denominator: 2 } }), actor);
    await ownerships.create(ownership(pr, ben, null, { share: { numerator: 1, denominator: 2 } }), actor);
    await expect(
      pool.query(
        `INSERT INTO ownership (mre_realm_id, property_reference_id, owner_party_id, share_numerator, share_denominator, valid_from, status, created_by)
         VALUES ($1, $2, $3, 1, 2, '2026-08-01', 'VALID', 'x')`,
        [REALM, pr, await party('Carl')],
      ),
    ).rejects.toThrow(/sum to 3\/2 \(OWNERSHIP_TOTAL_EXCEEDS_ONE\)/);
  });
});
