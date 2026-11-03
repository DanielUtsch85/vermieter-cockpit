import { describe, expect, it } from 'vitest';
import type { AcknowledgeDecision, AcknowledgeOutcome, AttributionInput, PartChangeInput, TaxStatementRepository } from './domains/taxation/index.js';
import { DEBITS, P1, S1_HISTORY, S2, allocationSet, partsOf, rec } from './domains/taxation/attribution-parts.test-support.js';
import { testFingerprinter as fingerprinter } from './domains/taxation/fingerprinter.test-support.js';
import type { RealmPrincipal } from './application/access.js';
import { acknowledgeAttributionChange } from './application/tax-statements.js';

/**
 * The acknowledgement use case with both flags (api-design.md §58G, VC-X-48): the year changes and the part changes of
 * one snapshot judged together, the optional `kind`, `CHANGE_AMBIGUOUS` and `CHANGE_NOT_FLAGGED` with the kind. The
 * repository is a stub that runs the use case's decision on the given inputs. One AuditRecord as two changes cannot
 * arise from a set record (VC-X-48); the inputs share a record id synthetically, as §58H's reconciliation will.
 */
const principal = { mreRealmId: 'realm', email: 'anna@example.com' } as RealmPrincipal;
const RENT = '0000c48f-0000-4000-8000-0000000000a1';
const TENANT = '6512f0c2a1b2c3d4e5f6e481';
/** A rent paid 2027-12-29 for January 2028, matched by record `a-1` on 2029-02-01: a year change of 2027 and 2028. */
const attribution: AttributionInput = {
  references: [],
  candidates: [],
  reconciliations: {
    candidates: [{ sourceId: RENT, transactionId: 'tx', bookingDate: '2027-12-29' as never, financialCategoryCode: 'RENT_BASE', taxYearOverride: null }],
    reconciliations: [
      {
        reconciliationId: 'rec-1',
        transactionId: 'tx',
        mreTenantId: TENANT,
        mreRentTerm: '2028010100',
        confirmedNow: true,
        records: [rec('a-1', 'CONFIRMED', '2029-02-01T10:00:00Z')],
      },
    ],
    rentDueDays: [{ mreTenantId: TENANT, rentDueDays: [{ validFrom: '2026-01-01' as never, day: 3 }] }],
  },
};
/** S2 voided by a record with the same id `a-1`: a part change of 2028 (d4). */
const parts: PartChangeInput = partsOf(
  [
    S1_HISTORY,
    {
      set: allocationSet(
        S2,
        '2027-07-01',
        [
          [P1, '1/2'],
          ['0000c48a-0000-4000-8000-000000000002', '1/2'],
        ],
        'VOID',
      ),
      records: [rec('r-s2', 'CREATED', '2028-03-01T10:00:00Z'), rec('a-1', 'VOIDED', '2029-02-01T10:00:00Z')],
    },
  ],
  DEBITS[2028],
);

function repository(decisions: AcknowledgeDecision[]): TaxStatementRepository {
  return {
    acknowledge: async (input: Parameters<TaxStatementRepository['acknowledge']>[0]): Promise<AcknowledgeOutcome> => {
      const decision = input.decide({ attribution, parts }, []);
      decisions.push(decision);
      if (decision.kind === 'CREATE' || decision.kind === 'NOOP') throw new Error('not written in this test');
      return decision;
    },
  } as unknown as TaxStatementRepository;
}

describe('acknowledging with both flags (§58G)', () => {
  const run = (decisions: AcknowledgeDecision[], o: Record<string, unknown>) =>
    acknowledgeAttributionChange({ repository: repository(decisions), fingerprinter })({
      principal,
      propertyReferenceId: P1,
      year: 2028,
      auditRecordId: 'A-1',
      expectedFingerprint: 'f'.repeat(64),
      reason: 'Grund',
      ...o,
    });

  it('one record as two changes: CHANGE_AMBIGUOUS naming both kinds without kind; with a kind its own fingerprint in the 412', async () => {
    const decisions: AcknowledgeDecision[] = [];
    await expect(run(decisions, {})).rejects.toMatchObject({
      name: 'AttributionChangeAmbiguousError',
      auditRecordId: 'a-1',
      year: 2028,
      kinds: ['LOAN_ALLOCATION_SET_VOIDED', 'RECONCILIATION_CONFIRMED'],
    });
    await expect(run(decisions, { kind: 'LOAN_ALLOCATION_SET_VOIDED' })).rejects.toMatchObject({ name: 'AttributionChangeDiffersError' });
    await expect(run(decisions, { kind: 'RECONCILIATION_CONFIRMED' })).rejects.toMatchObject({ name: 'AttributionChangeDiffersError' });
    const [, part, year] = decisions as [AcknowledgeDecision, { currentFingerprint: string }, { currentFingerprint: string }];
    expect(part.currentFingerprint).not.toBe(year.currentFingerprint);
  });

  it('a kind the record is not: CHANGE_NOT_FLAGGED with the kind; another record: without', async () => {
    await expect(run([], { kind: 'LOAN_ALLOCATION_SET_ADDED' })).rejects.toMatchObject({
      name: 'AttributionChangeNotFlaggedError',
      kind: 'LOAN_ALLOCATION_SET_ADDED',
    });
    await expect(run([], { auditRecordId: 'a-9' })).rejects.toMatchObject({ name: 'AttributionChangeNotFlaggedError', kind: undefined });
  });
});
