import { describe, expect, it } from 'vitest';
import { planOwnerAllocation } from '../../domains/acquisition/index.js';
import { Money } from '../../shared/index.js';
import { AT, OTHER_REALM, REALM, actor, databaseUrl, day, useAlignSchema } from './align-ownerships.test-support.js';
import { createDatabase } from './database.js';
import { PostgresLandBuildingAllocationRepository } from './land-building-allocation-repository.js';
import { insertConfirmedAsBeforeVcX34 } from './legacy-acquisition.test-support.js';
import { PostgresOwnerAllocationSource } from './owner-allocation-source.js';
import { PostgresOwnershipRepository } from './ownership-repository.js';
import { ownershipStartFactsOf } from './ownership-start-reads.js';
import { ownershipStartFixtures } from './ownership-start-on-confirm.test-support.js';

/**
 * §58R (VC-X-57, migration 0073; ADR-044; Entscheidung des Projektinhabers, 2026-11-06, Fragen 1–7) through the
 * repository: the example N (dated by §58N before any row, the §26.2 change on the transfer, confirmed and the day stored,
 * the AuditRecord), N2 (refused with its four violations, nothing written, aligned by §58Q, confirmed), N3 (sellerless:
 * §58Q answers NO_SELLER_ROW, voided and rewritten, confirmed), §58Q on N `CONFIRMED_FROM_TRANSFER`, the year flag's facts,
 * the allocation's default, Realm isolation, history (reads write nothing) and concurrency under READ COMMITTED.
 * Synthetic values only.
 */
const f = (numerator: bigint, denominator: bigint) => ({ numerator, denominator });

describe.skipIf(databaseUrl === undefined)('the Ownerships from the economic transfer on confirm through the repository (§58R)', () => {
  const t = useAlignSchema('acquisition_ownership_start_test');
  const { align, periods, acquisitionRow, audits, own, party, propertyReference, recordDate } = t;
  const { draft, scenario } = ownershipStartFixtures(t);
  const count = async (sql: string, params: unknown[] = []) => Number((await t.ctx.pool.query(sql, params)).rows[0].n);
  const confirm = (id: string, realm = REALM) => t.ctx.acquisitions.confirm(id, realm, AT, actor);
  const ownerships = () => new PostgresOwnershipRepository(createDatabase(t.ctx.pool));
  const changeOnTransfer = (pr: string, close: string[], create: string[], acquisitionId: string, realm = REALM) =>
    ownerships().change(
      {
        mreRealmId: realm,
        propertyReferenceId: pr,
        effectiveDate: day('2025-05-01'),
        reason: 'Übergang (synthetisch)',
        close,
        create: create.map((ownerPartyId) => ({ ownerPartyId, share: { numerator: 1, denominator: 1 }, sourceReferences: [], notes: null })),
        acquisitionId,
      },
      actor,
    );
  const snapshot = async (pr: string, ids: readonly string[]) => ({
    rows: await periods(pr),
    acquisitions: await Promise.all(ids.map(acquisitionRow)),
    audits: await count(`SELECT count(*) AS n FROM audit_record`),
  });

  it('the example N: dated before any row, the change on t, confirm stores 2025-05-01, version 3, one AuditRecord naming it', async () => {
    const x = await scenario();
    const dated = await t.ctx.acquisitions.findById(x.n, REALM);
    // §58N's command on a DRAFT: transferDate (= ownershipStart) is the date, no flag (rule 1 branch 3, Frage 5).
    expect([dated?.version, dated?.flags, dated?.confirmedOwnershipStart]).toEqual([2, [], null]);
    const recorded = (await audits([x.n])).find((r) => r.action === 'ECONOMIC_TRANSFER_DATE_RECORDED');
    expect(recorded?.metadata).toMatchObject({ status: 'DRAFT', ownershipStart: '2025-05-01', contractDate: '2025-03-01' });
    const changed = await changeOnTransfer(x.pr, [x.oS], [x.a], x.n);
    expect(changed.kind).toBe('CHANGED');
    const outcome = await confirm(x.n);
    if (outcome.kind !== 'CONFIRMED') throw new Error(outcome.kind);
    expect([outcome.acquisition.status, outcome.acquisition.version, outcome.acquisition.confirmedOwnershipStart, outcome.acquisition.flags]).toEqual([
      'CONFIRMED',
      3,
      '2025-05-01',
      [],
    ]);
    expect((await acquisitionRow(x.n)).confirmed_ownership_start).toBe('2025-05-01');
    const confirmed = (await audits([x.n])).filter((r) => r.action === 'CONFIRMED');
    expect(confirmed).toEqual([
      {
        entity_type: 'Acquisition',
        entity_id: x.n,
        action: 'CONFIRMED',
        previous_version: 2,
        new_version: 3,
        metadata: { transferDate: '2025-05-01', ownershipIds: outcome.ownershipIds },
      },
    ]);
    // The rows as written: S to 2025-04-30, A from 2025-05-01.
    expect((await periods(x.pr)).map((r) => [r[1], r[2], r[3]]).sort()).toEqual(
      [
        [x.s, '2015-06-01', '2025-04-30'],
        [x.a, '2025-05-01', null],
      ].sort(),
    );
    // A repeat is a no-op; §27.4 reads on t; reads write nothing.
    const n = await count(`SELECT count(*) AS n FROM audit_record`);
    expect((await confirm(x.n)).kind).toBe('CONFIRMED');
    const input = await new PostgresOwnerAllocationSource(createDatabase(t.ctx.pool)).read(x.n, REALM);
    const plan = planOwnerAllocation(input as never);
    expect(plan.kind === 'ALLOCATED' && plan.owners.map((o) => o.ownerPartyId)).toEqual([x.a]);
    expect(await count(`SELECT count(*) AS n FROM audit_record`)).toBe(n);
    // §58Q on N: nothing to align (Frage 7), nothing written.
    const before = await snapshot(x.pr, [x.n]);
    expect(await align(x.n)).toEqual({ kind: 'OWNERSHIP_EXTENSION_NOT_APPLICABLE', reason: 'CONFIRMED_FROM_TRANSFER' });
    expect(await snapshot(x.pr, [x.n])).toEqual(before);
  });

  it('N2: rows from the contract date written before the date: refused with the four violations, nothing written; aligned by §58Q, then confirmed', async () => {
    const x = await scenario({ rows: 'contract' });
    const before = await snapshot(x.pr, [x.n, x.w]);
    const refused = await confirm(x.n);
    expect(refused).toEqual({
      kind: 'CONFIRMATION_BLOCKED',
      violations: [
        { code: 'OWNERSHIP_NOT_FROM_TRANSFER_DATE', ownershipId: x.oA, validFrom: '2025-03-01', transferDate: '2025-05-01' },
        { code: 'BUYER_SHARE_NOT_INCREASED', partyId: x.a, shareBefore: f(1n, 1n), share: f(1n, 1n) },
        {
          code: 'SHARE_SUM_MISMATCH',
          expected: f(1n, 1n),
          actual: f(0n, 1n),
          byBuyer: [{ partyId: x.a, shareBefore: f(1n, 1n), share: f(1n, 1n), acquired: f(0n, 1n) }],
        },
        { code: 'SELLER_SHARE_CHANGED_BEFORE_TRANSFER', partyId: x.s, shareOnContractEve: f(1n, 1n), shareOnTransferEve: f(0n, 1n) },
      ],
    });
    expect(await snapshot(x.pr, [x.n, x.w])).toEqual(before);
    expect((await align(x.n)).kind).toBe('ALIGNED');
    const confirmed = await confirm(x.n);
    expect(confirmed.kind === 'CONFIRMED' && [confirmed.acquisition.confirmedOwnershipStart, confirmed.acquisition.ownershipAlignedAt]).toEqual([
      '2025-05-01',
      AT,
    ]);
    const row = await acquisitionRow(x.n);
    expect([row.status, row.confirmed_ownership_start, row.ownership_aligned_at !== null]).toEqual(['CONFIRMED', '2025-05-01', true]);
  });

  it('N3: sellerless with a row from the contract date: refused, §58Q NO_SELLER_ROW; the row voided and written on t, then confirmed', async () => {
    const pr = await propertyReference();
    const a = await party('Käuferin A3 (synthetisch)');
    const n3 = await draft(pr, { buyers: [a] });
    const oA3 = await own(pr, { owner: a, from: '2025-03-01', acquisitionId: n3 });
    await recordDate(n3, '2025-05-01');
    const refused = await confirm(n3);
    expect(refused.kind === 'CONFIRMATION_BLOCKED' && refused.violations.map((v) => v.code)).toEqual([
      'OWNERSHIP_NOT_FROM_TRANSFER_DATE',
      'BUYER_SHARE_NOT_INCREASED',
      'SHARE_SUM_MISMATCH',
    ]);
    expect(await align(n3)).toEqual({ kind: 'OWNERSHIP_EXTENSION_NOT_APPLICABLE', reason: 'NO_SELLER_ROW' });
    expect((await ownerships().void(oA3, REALM, 'vor dem Übergang erfasst (synthetisch)', AT, actor)).kind).toBe('VOIDED');
    await own(pr, { owner: a, from: '2025-05-01', acquisitionId: n3 });
    expect((await confirm(n3)).kind).toBe('CONFIRMED');
  });

  it('the year flag and the allocation default: the dated DRAFT neither flagged nor read on c; legacy L keeps both (counter-check)', async () => {
    const x = await scenario();
    const legacyPr = await propertyReference();
    const [s, a] = [await party('Verkäufer S (synthetisch)'), await party('Käuferin A (synthetisch)')];
    const l = await insertConfirmedAsBeforeVcX34(t.ctx.pool, {
      mreRealmId: REALM,
      propertyReferenceId: legacyPr,
      contractDate: '2025-03-01',
      buyers: [{ partyId: a, share: [1, 1] }],
      sellerPartyIds: [s],
    });
    await recordDate(l.acquisitionId, '2025-05-01');
    await createDatabase(t.ctx.pool)
      .transaction()
      .execute(async (trx) => {
        expect(await ownershipStartFactsOf(trx, REALM, x.pr)).toEqual([]);
        expect((await ownershipStartFactsOf(trx, REALM, legacyPr)).map((fact) => [fact.acquisitionId, fact.ownershipStart])).toEqual([
          [l.acquisitionId, '2025-03-01'],
        ]);
      });
    expect((await t.ctx.acquisitions.findById(l.acquisitionId, REALM))?.flags.map((fl) => fl.code)).toEqual(['OWNERSHIP_START_BEFORE_ECONOMIC_TRANSFER']);
    const allocations = new PostgresLandBuildingAllocationRepository(createDatabase(t.ctx.pool));
    const allocate = async (acquisitionId: string) => {
      const created = await allocations.create(
        {
          mreRealmId: REALM,
          acquisitionId,
          totalAllocableAmount: Money.of('200000.00', 'EUR'),
          landAmount: Money.of('40000.00', 'EUR'),
          buildingAmount: Money.of('160000.00', 'EUR'),
          method: 'PURCHASE_CONTRACT',
          reviewState: 'UNREVIEWED',
          effectiveDate: null,
          advisorPartyId: null,
          sourceReferences: [],
          notes: null,
          supersedes: null,
        },
        actor,
      );
      return created.kind === 'CREATED' ? created.allocation.effectiveDate : created.kind;
    };
    expect([await allocate(x.n), await allocate(l.acquisitionId)]).toEqual(['2025-05-01', '2025-03-01']);
  });

  it('Realm isolation: Realm B identical DRAFT untouched by A, a confirm of it from A NOT_FOUND; each Realm confirms its own', async () => {
    const mine = await scenario({ rows: 'transfer' });
    const theirs = await scenario({ rows: 'transfer', realm: OTHER_REALM });
    const before = await snapshot(theirs.pr, [theirs.n]);
    expect(await confirm(theirs.n, REALM)).toEqual({ kind: 'NOT_FOUND' });
    expect(await align(theirs.n)).toEqual({ kind: 'NOT_FOUND' });
    expect(await snapshot(theirs.pr, [theirs.n])).toEqual(before);
    expect((await confirm(mine.n)).kind).toBe('CONFIRMED');
    expect({ ...(await snapshot(theirs.pr, [theirs.n])), audits: before.audits }).toEqual(before);
    expect(await count(`SELECT count(*) AS n FROM audit_record WHERE entity_id = $1 AND action = 'CONFIRMED'`, [theirs.n])).toBe(0);
    expect((await confirm(theirs.n, OTHER_REALM)).kind).toBe('CONFIRMED');
    // Counter-check of the Realm read: Realm B's early-closed seller is refused in its own Realm.
    const early = await scenario({ rows: 'sellerEarly', realm: OTHER_REALM });
    const refused = await confirm(early.n, OTHER_REALM);
    expect(refused.kind === 'CONFIRMATION_BLOCKED' && refused.violations.map((v) => v.code)).toEqual(['SELLER_SHARE_CHANGED_BEFORE_TRANSFER']);
  });

  it(
    'concurrency (READ COMMITTED): confirm against §58N command (both orders) and against the change on t (both orders, at once)',
    { timeout: 30_000 },
    async () => {
      for (const order of ['date first', 'confirm first', 'at once'] as const) {
        const x = await scenario({ rows: 'transfer', dated: false });
        const rec = () =>
          t.ctx.acquisitions.recordEconomicTransferDate({
            id: x.n,
            mreRealmId: REALM,
            record: { economicTransferDate: day('2025-05-01'), sourceReferences: ['Übergabeprotokoll (synthetisch)'], notes: null },
            at: AT,
            actor,
          });
        const kinds =
          order === 'date first'
            ? [(await rec()).kind, (await confirm(x.n)).kind]
            : order === 'confirm first'
              ? [(await confirm(x.n)).kind, (await rec()).kind]
              : (await Promise.all([rec(), confirm(x.n)])).map((o) => o.kind);
        // Confirmed first is impossible without the date: requirement 0 refuses, the date then recorded.
        expect([
          ['RECORDED', 'CONFIRMED'],
          ['CONFIRMATION_BLOCKED', 'RECORDED'],
          ['RECORDED', 'CONFIRMATION_BLOCKED'],
        ]).toContainEqual(kinds);
        if (order === 'confirm first') expect(kinds).toEqual(['CONFIRMATION_BLOCKED', 'RECORDED']);
        const final = (await confirm(x.n)).kind;
        expect([order, final, (await acquisitionRow(x.n)).confirmed_ownership_start]).toEqual([order, 'CONFIRMED', '2025-05-01']);
      }
      for (const order of ['change first', 'confirm first', 'at once'] as const) {
        const x = await scenario();
        const kinds =
          order === 'change first'
            ? [(await changeOnTransfer(x.pr, [x.oS], [x.a], x.n)).kind, (await confirm(x.n)).kind]
            : order === 'confirm first'
              ? [(await confirm(x.n)).kind, (await changeOnTransfer(x.pr, [x.oS], [x.a], x.n)).kind]
              : (await Promise.all([changeOnTransfer(x.pr, [x.oS], [x.a], x.n), confirm(x.n)])).map((o) => o.kind);
        expect([
          ['CHANGED', 'CONFIRMED'],
          ['CONFIRMATION_BLOCKED', 'CHANGED'],
          ['CHANGED', 'CONFIRMATION_BLOCKED'],
        ]).toContainEqual(kinds);
        if (!kinds.includes('CONFIRMED')) expect((await confirm(x.n)).kind).toBe('CONFIRMED');
        expect((await acquisitionRow(x.n)).confirmed_ownership_start, order).toBe('2025-05-01');
      }
    },
  );
});
