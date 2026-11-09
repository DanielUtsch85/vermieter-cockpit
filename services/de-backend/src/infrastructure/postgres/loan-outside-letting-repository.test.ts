import { Kysely, PostgresDialect, type CompiledQuery } from 'kysely';
import { describe, expect, it } from 'vitest';
import { allocationFingerprint, remainingDebt, setOn, type AllocationRequest } from '../../domains/financing/index.js';
import { setsOfLoans } from './loan-allocation-repository.js';
import { databaseUrl, EVIDENCE, OTHER_REALM, REALM, actor, day, f, useOutsideLettingDatabase } from './loan-outside-letting.test-support.js';
import type { Database } from './schema.js';

/**
 * VC-X-43 persistence (api-design.md §58V rules 1–4, 7 and 10, "History, AuditRecords and Realm isolation"): a set with
 * a part outside letting written and read (one row without a PropertyReference, after the entries), the CREATED record
 * with the part and the evidence only when present, the list and the day's set, `loansOf` with the set's part, the
 * idempotent replay (with the part, and a key stored before 0077), the batched read with the part and its Realm filter,
 * Financing's remaining debt per property, and Realm isolation. Synthetic figures only.
 */
describe.skipIf(databaseUrl === undefined)('the part outside letting in PostgresLoanAllocationRepository (§58V)', () => {
  const { ctx, loan, properties } = useOutsideLettingDatabase('loan_outside_letting_repository_test');

  const request = (p1: string, p2: string, o: Partial<AllocationRequest> = {}): AllocationRequest => ({
    validFrom: day('2027-01-01'),
    basis: 'MANUAL',
    allocations: [
      { propertyReferenceId: p1, share: f(1n, 2n), acquisitionId: null },
      { propertyReferenceId: p2, share: f(3n, 10n), acquisitionId: null },
    ],
    notes: null,
    outsideLetting: f(1n, 5n),
    useEvidence: EVIDENCE,
    ...o,
  });
  const created = async (loanId: string, r: AllocationRequest, realm = REALM, idempotency?: { key: string; fingerprint: string }) => {
    const outcome = await ctx.allocations.create(loanId, realm, r, actor, idempotency);
    if (outcome.kind !== 'CREATED' && outcome.kind !== 'REPLAYED') throw new Error(outcome.kind);
    return outcome;
  };

  it('create and read: the entries as given, the part and the evidence; one row without a PropertyReference after the entries', async () => {
    const l = await loan();
    const [p1, p2] = (await properties(2)) as [string, string];
    const { set } = await created(l.id, request(p1, p2));
    expect(set.allocations).toEqual([
      { propertyReferenceId: p1, share: f(1n, 2n), acquisitionId: null },
      { propertyReferenceId: p2, share: f(3n, 10n), acquisitionId: null },
    ]);
    expect([set.outsideLetting, set.useEvidence]).toEqual([{ share: f(1n, 5n) }, EVIDENCE]);
    const { rows } = await ctx.pool.query(
      `SELECT position, property_reference_id, use, share_numerator::text AS n, share_denominator::text AS d FROM loan_allocation WHERE set_id = $1 ORDER BY position`,
      [set.id],
    );
    expect(rows).toEqual([
      { position: 0, property_reference_id: p1, use: 'LETTING', n: '1', d: '2' },
      { position: 1, property_reference_id: p2, use: 'LETTING', n: '3', d: '10' },
      { position: 2, property_reference_id: null, use: 'OUTSIDE_LETTING', n: '1', d: '5' },
    ]);
    const listed = await ctx.allocations.list(l.id, REALM);
    expect(listed?.map((s) => [s.id, s.outsideLetting, s.useEvidence, s.validUntil])).toEqual([[set.id, { share: f(1n, 5n) }, EVIDENCE, null]]);
    expect(setOn(listed ?? [], day('2027-03-31'))?.outsideLetting).toEqual({ share: f(1n, 5n) });
  });

  it('a set without the part reads outsideLetting null and useEvidence null; evidence alone is kept', async () => {
    const l = await loan();
    const [p1, p2] = (await properties(2)) as [string, string];
    const plain = request(p1, p2, {
      allocations: [
        { propertyReferenceId: p1, share: f(1n, 2n), acquisitionId: null },
        { propertyReferenceId: p2, share: f(1n, 2n), acquisitionId: null },
      ],
      outsideLetting: null,
      useEvidence: null,
    });
    const { set } = await created(l.id, plain);
    expect([set.outsideLetting, set.useEvidence]).toEqual([null, null]);
    const { set: next } = await created(l.id, { ...plain, validFrom: day('2027-06-01'), useEvidence: [EVIDENCE[0] as string] });
    expect([next.outsideLetting, next.useEvidence]).toEqual([null, [EVIDENCE[0]]]);
  });

  it('AuditRecords: CREATED carries the part and the evidence only when present; VOIDED as before; no AMENDED', async () => {
    const l = await loan();
    const [p1, p2] = (await properties(2)) as [string, string];
    const { set } = await created(l.id, request(p1, p2));
    const l2 = await loan();
    const { set: plain } = await created(
      l2.id,
      request(p1, p2, { allocations: [{ propertyReferenceId: p1, share: f(1n, 1n), acquisitionId: null }], outsideLetting: null, useEvidence: null }),
    );
    await ctx.allocations.void(l.id, set.id, REALM, 'falsch erfasst (synthetisch)', new Date('2027-02-01T10:00:00Z'), actor);
    const records = async (id: string) =>
      (
        await ctx.pool.query(
          `SELECT action, metadata FROM audit_record WHERE entity_type = 'LoanAllocationSet' AND entity_id = $1 ORDER BY occurred_at, action`,
          [id],
        )
      ).rows;
    expect(await records(set.id)).toEqual([
      {
        action: 'CREATED',
        metadata: {
          loanId: l.id,
          validFrom: '2027-01-01',
          basis: 'MANUAL',
          allocations: [
            { propertyReferenceId: p1, share: '1/2', acquisitionId: null },
            { propertyReferenceId: p2, share: '3/10', acquisitionId: null },
          ],
          outsideLetting: { share: '1/5' },
          useEvidence: EVIDENCE,
        },
      },
      { action: 'VOIDED', metadata: { loanId: l.id, reason: 'falsch erfasst (synthetisch)' } },
    ]);
    expect(await records(plain.id)).toEqual([
      {
        action: 'CREATED',
        metadata: { loanId: l2.id, validFrom: '2027-01-01', basis: 'MANUAL', allocations: [{ propertyReferenceId: p1, share: '1/1', acquisitionId: null }] },
      },
    ]);
  });

  it('loansOf: each PropertyReference s entry with the set s part; the part names no PropertyReference', async () => {
    const l = await loan();
    const [p1, p2] = (await properties(2)) as [string, string];
    const { set } = await created(l.id, request(p1, p2));
    const items = await ctx.allocations.loansOf(p1, REALM);
    expect(items?.map((i) => [i.allocationSetId, i.share, i.outsideLettingShare])).toEqual([[set.id, f(1n, 2n), f(1n, 5n)]]);
    expect((await ctx.allocations.loansOf(p2, REALM))?.map((i) => i.outsideLettingShare)).toEqual([f(1n, 5n)]);
  });

  it('idempotency: a replay with the part returns the stored set; a key stored before 0077 (no new keys) replays as before', async () => {
    const l = await loan();
    const [p1, p2] = (await properties(2)) as [string, string];
    const r = request(p1, p2);
    const key = { key: 'vc-x-43-replay', fingerprint: allocationFingerprint(l.id, r) };
    const first = await created(l.id, r, REALM, key);
    const again = await created(l.id, r, REALM, key);
    expect(again.kind).toBe('REPLAYED');
    expect([again.set.id, again.set.outsideLetting, again.set.useEvidence]).toEqual([first.set.id, { share: f(1n, 5n) }, EVIDENCE]);
    // Another part under the same key conflicts.
    expect(
      (
        await ctx.allocations.create(l.id, REALM, { ...r, outsideLetting: f(1n, 10n) }, actor, {
          key: key.key,
          fingerprint: allocationFingerprint(l.id, { ...r, outsideLetting: f(1n, 10n) }),
        })
      ).kind,
    ).toBe('IDEMPOTENCY_CONFLICT');

    const l2 = await loan();
    const old: AllocationRequest = {
      validFrom: day('2027-01-01'),
      basis: 'MANUAL',
      allocations: [{ propertyReferenceId: p1, share: f(1n, 1n), acquisitionId: null }],
      notes: null,
    };
    const oldKey = { key: 'vc-x-43-old', fingerprint: allocationFingerprint(l2.id, old) };
    const stored = await created(l2.id, old, REALM, oldKey);
    // The stored result as written before 0077: without the two keys.
    await ctx.pool.query(`UPDATE idempotency_key SET result = result - 'outsideLetting' - 'useEvidence' WHERE key = $1`, [oldKey.key]);
    const replayed = await created(l2.id, old, REALM, oldKey);
    expect(replayed.kind).toBe('REPLAYED');
    expect([replayed.set.id, replayed.set.outsideLetting, replayed.set.useEvidence]).toEqual([stored.set.id, null, null]);
    expect((await ctx.pool.query(`SELECT request_fingerprint FROM idempotency_key WHERE key = $1`, [oldKey.key])).rows[0].request_fingerprint).toBe(
      `["${l2.id}","2027-01-01","MANUAL",[["${p1}","1/1",null]],null]`,
    );
  });

  it('setsOfLoans: the part read in the batch, filtered by the Realm on the statement; Financing per property beside the items', async () => {
    const l = await loan();
    const [p1, p2] = (await properties(2)) as [string, string];
    const { set } = await created(l.id, request(p1, p2));
    const sent: CompiledQuery[] = [];
    const logged = new Kysely<Database>({
      dialect: new PostgresDialect({ pool: ctx.pool }),
      log: (e) => {
        if (e.level === 'query') sent.push(e.query);
      },
    });
    const sets = await logged.transaction().execute((trx) => setsOfLoans(trx, REALM, [l.id]));
    expect(sets.get(l.id)?.map((s) => [s.id, s.outsideLetting, s.allocations.length])).toEqual([[set.id, { share: f(1n, 5n) }, 2]]);
    const setRead = sent.find((q) => q.sql.includes('from "loan_allocation_set" where') && q.sql.includes('"loan_id" in ('));
    expect(setRead?.sql).toContain('"mre_realm_id" = $1');
    expect(setRead?.parameters[0]).toBe(REALM);
    // §41.6 on the stored inputs: 200,000.00 by 1/2, 3/10 and 1/5.
    const inputs = await ctx.debt.debtInputs(l.id, REALM);
    const out = remainingDebt(inputs as NonNullable<typeof inputs>, day('2027-03-31'), true);
    expect(out.kind === 'PER_PROPERTY' ? [out.debt.items.map((i) => i.actual), out.debt.outsideLetting?.actual] : out.kind).toEqual([
      [10_000_000n, 6_000_000n],
      4_000_000n,
    ]);
  });

  it('Realm isolation: a same-shaped set in another Realm reaches no list, loansOf, batch or debt input of this Realm', async () => {
    const l = await loan();
    const [p1, p2] = (await properties(2)) as [string, string];
    await created(l.id, request(p1, p2));
    const foreignLoan = await loan(OTHER_REALM);
    const [f1, f2] = (await properties(2, OTHER_REALM)) as [string, string];
    const { set: foreign } = await created(foreignLoan.id, request(f1, f2), OTHER_REALM);
    expect(await ctx.allocations.list(foreignLoan.id, REALM)).toBeUndefined();
    expect(await ctx.allocations.loansOf(f1, REALM)).toBeUndefined();
    expect(await ctx.debt.debtInputs(foreignLoan.id, REALM)).toBeUndefined();
    const batch = await new Kysely<Database>({ dialect: new PostgresDialect({ pool: ctx.pool }) })
      .transaction()
      .execute((trx) => setsOfLoans(trx, REALM, [l.id, foreignLoan.id]));
    expect(batch.get(foreignLoan.id)).toEqual([]);
    expect([...batch.values()].flat().some((s) => s.id === foreign.id)).toBe(false);
    // A set of this Realm naming the foreign PropertyReference is refused before any row is written.
    const l2 = await loan();
    expect((await ctx.allocations.create(l2.id, REALM, request(p1, f1), actor)).kind).toBe('PROPERTY_REFERENCE_NOT_FOUND');
  });
});
