import { PHASE_7_DEPRECIATION } from './tax-year-depreciation.test-support.js';
import { describe, expect, it } from 'vitest';
import { Money, RuleRegistry, type BusinessDate } from '../../shared/index.js';
import type { Direction } from '../ledger/index.js';
import { capitalizedItemsOf } from './capitalized-items.js';
import type { TaxMeaning } from './classification.js';
import { TAXATION_RULE_VERSIONS } from './rules/versions.js';
import { buildTaxYearView, type TaxYearView, type ViewOwnership } from './tax-year-view.js';
import type { Origin, ReviewState, TaxCategory, Treatment } from './vocabulary.js';
import type { WegTaxMeaning } from './weg-sources.js';

/**
 * VC-8-03 (api-design.md §59B, P8-D11): Taxation's capitalised items for Depreciation are exactly the view's
 * `capitalized`, over every year: only a classification with `CAPITALIZED`, the view's signs, and the view's own
 * per-item parts (`participantsOn`, `shareOut`). Synthetic sources; no personal data.
 */
const day = (value: string) => value as BusinessDate;
const eur = (amount: string) => Money.of(amount, 'EUR');
const PR = '0000aaaa-0000-4000-8000-000000000001';
const ACQ = '0000cccc-0000-4000-8000-000000000001';
/** Parties A < B < C by id. */
const [A, B, C] = ['a', 'b', 'c'].map((c) => `${c.repeat(8)}-0000-4000-8000-000000000000`) as [string, string, string];
let seq = 0;
const id = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`;
const registry = new RuleRegistry(TAXATION_RULE_VERSIONS);

function split(o: {
  readonly amount: string;
  readonly treatment?: Treatment | null;
  readonly origin?: Origin;
  readonly direction?: Direction;
  readonly bookingDate?: string;
  readonly reviewState?: ReviewState;
  readonly taxCategory?: TaxCategory;
  readonly counts?: boolean;
  readonly taxYear?: number;
  readonly flags?: TaxMeaning['flags'];
}): TaxMeaning {
  const sourceId = id();
  const bookingDate = day(o.bookingDate ?? '2027-03-10');
  return {
    splitId: sourceId,
    sourceId,
    sourceType: 'TRANSACTION_SPLIT',
    transactionId: id(),
    position: 1,
    bookingDate,
    direction: o.direction ?? 'OUTFLOW',
    amount: eur(o.amount),
    financialCategoryCode: 'MAINTENANCE',
    categoryType: 'OPERATING_EXPENSE',
    propertyReferenceId: PR,
    transactionStatus: 'CONFIRMED',
    correctionRole: null,
    counts: o.counts ?? true,
    taxCategory: o.taxCategory ?? 'MAINTENANCE',
    treatment: o.treatment === undefined ? 'CAPITALIZED' : o.treatment,
    reviewState: o.reviewState ?? 'USER_CONFIRMED',
    origin: o.origin ?? 'CLASSIFICATION',
    rule: { ruleCode: 'DE_CATEGORY_DEFAULTS', version: 1 },
    classificationId: (o.origin ?? 'CLASSIFICATION') === 'CLASSIFICATION' ? id() : null,
    taxYear: o.taxYear ?? Number(bookingDate.slice(0, 4)),
    attribution: { rule: { ruleCode: 'DE_CASH_TIMING', version: 1 }, bookingYear: Number(bookingDate.slice(0, 4)), proposedYear: 2027, overridden: false },
    refund: null,
    netAmount: null,
    treatmentRule: null,
    distribution: null,
    suggestion: null,
    flags: o.flags ?? [],
  };
}

function use(amount: string, date = '2028-02-15'): WegTaxMeaning {
  return {
    sourceType: 'WEG_ASSESSMENT_USE',
    sourceId: id(),
    sourcePosition: 1,
    membershipId: id(),
    propertyReferenceId: PR,
    date: day(date),
    dateSource: 'USE',
    description: 'Fassadensanierung (synthetisch)',
    amount: eur(amount),
    netAmount: null,
    counts: true,
    notCountedReason: null,
    taxYear: Number(date.slice(0, 4)),
    attribution: { rule: null, proposedYear: Number(date.slice(0, 4)), overridden: false },
    taxCategory: 'WEG_SPENDING',
    treatment: 'CAPITALIZED',
    reviewState: 'USER_CONFIRMED',
    origin: 'CLASSIFICATION',
    rule: { ruleCode: 'DE_WEG_SPENDING', version: 1 },
    treatmentRule: null,
    classificationId: id(),
    distribution: null,
    suggestion: null,
    flags: [{ code: 'WITHDRAWAL_DATE_ASSUMED', details: { date: day(date), periodUntil: day(date) } }] as unknown as WegTaxMeaning['flags'],
  };
}

const own = (party: string, share: string, from: string, until: string | null = null): ViewOwnership => {
  const [n, d] = share.split('/').map(Number) as [number, number];
  return { id: id(), partyId: party, share: { numerator: n, denominator: d }, validFrom: day(from), validUntil: until === null ? null : day(until) };
};

function viewOf(
  meanings: readonly (TaxMeaning | WegTaxMeaning)[],
  ownerships: readonly ViewOwnership[],
  year: number,
  ownerPartyId: string | null,
): TaxYearView {
  const outcome = buildTaxYearView(
    {
      propertyReferenceId: PR,
      ownerPartyFound: ownerPartyId === null ? null : true,
      sources: meanings.map((m) => ({ item: { ...m, yearAmount: m.amount }, listed: true })),
      unattributedDeposits: [],
      ownerships,
      checks: [],
      attribution: { references: [], candidates: [] },
      allocatedLoanInterest: [],
      loanAllocationSets: new Map(),
      depreciation: PHASE_7_DEPRECIATION,
    },
    { year, ownerPartyId, today: day('2026-10-30'), registry },
  );
  if (outcome.kind !== 'VIEW') throw new Error(outcome.kind);
  return outcome.view;
}

describe('capitalizedItemsOf (§59B)', () => {
  it('only a counting source whose classification is CAPITALIZED; a default never, a suggestion never', () => {
    const kept = split({ amount: '35700.00' });
    const sources = [
      kept,
      // A default with treatment CAPITALIZED (as a test registry might give one) is never taken: the origin decides.
      split({ amount: '100.00', origin: 'DEFAULT', reviewState: 'SUGGESTED' }),
      split({ amount: '200.00', treatment: 'DEDUCTIBLE' }),
      split({ amount: '300.00', counts: false }),
      {
        ...split({ amount: '400.00', treatment: 'DEDUCTIBLE' }),
        suggestion: { treatment: 'CAPITALIZED', reason: 'ANSCHAFFUNGSNAHE_HERSTELLUNGSKOSTEN', acquisitionIds: [ACQ], final: true },
      } satisfies TaxMeaning,
      split({ amount: '500.00', treatment: 'NOT_RELEVANT', taxCategory: 'NOT_RELEVANT' }),
    ];
    const result = capitalizedItemsOf(
      sources.map((meaning) => ({ meaning, anschaffungsnaheAcquisitionId: meaning === kept ? ACQ : null })),
      [own(A, '1/1', '2026-07-01')],
    );
    expect(result.map((r) => [r.sourceId, r.lineAmount.amount, r.anschaffungsnaheAcquisitionId, r.reviewState, r.dateSource])).toEqual([
      [kept.sourceId, '35700.00', ACQ, 'USER_CONFIRMED', 'BOOKING'],
    ]);
  });

  it('a NEEDS_REVIEW CAPITALIZED classification is a capitalised item (Depreciation does not compute it; §58C places it in capitalized)', () => {
    expect(capitalizedItemsOf([{ meaning: split({ amount: '10.00', reviewState: 'NEEDS_REVIEW' }), anschaffungsnaheAcquisitionId: null }], [])).toHaveLength(1);
  });

  it('signs: an OUTFLOW and a use positive, a refund (INFLOW) negative; the gross amount, never netAmount', () => {
    const refund = split({ amount: '1000.00', direction: 'INFLOW', bookingDate: '2031-04-04' });
    const net = { ...split({ amount: '35700.00' }), netAmount: eur('30000.00') };
    const result = capitalizedItemsOf(
      [refund, net, use('9000.00')].map((meaning) => ({ meaning, anschaffungsnaheAcquisitionId: null })),
      [own(A, '1/1', '2026-07-01')],
    );
    expect(result.map((r) => [r.sourceType, r.lineAmount.amount, r.netAmount?.amount ?? null, r.sourcePosition, r.date, r.dateSource])).toEqual([
      ['TRANSACTION_SPLIT', '-1000.00', null, null, '2031-04-04', 'BOOKING'],
      ['TRANSACTION_SPLIT', '35700.00', '30000.00', null, '2027-03-10', 'BOOKING'],
      ['WEG_ASSESSMENT_USE', '9000.00', null, 1, '2028-02-15', 'USE'],
    ]);
  });

  it('the parts are the view’s for the same item and Ownerships: ties, NOT_OWNED and a negative item, to the cent', () => {
    // Three Parties of 1/3 each (a tie on the odd cent) and a gap: NOT_OWNED for 1/10 on the second date.
    const ownerships = [own(A, '3/10', '2026-01-01'), own(B, '3/10', '2026-01-01'), own(C, '3/10', '2026-01-01', '2028-12-31'), own(C, '2/10', '2029-01-01')];
    const sources = [split({ amount: '1000.01' }), split({ amount: '333.33', direction: 'INFLOW', bookingDate: '2029-06-06' }), use('7.00', '2027-08-08')];
    const items = capitalizedItemsOf(
      sources.map((meaning) => ({ meaning, anschaffungsnaheAcquisitionId: null })),
      ownerships,
    );
    for (const [i, item] of items.entries()) {
      expect(item.parts.reduce((sum, p) => sum.add(p.amount), Money.zero('EUR')).equals(item.lineAmount)).toBe(true);
      const year = item.taxYear;
      for (const party of [A, B, C]) {
        const atOwner = viewOf(sources, ownerships, year, party).capitalized.items.find((v) => v.sourceId === sources[i]?.sourceId);
        expect(item.parts.find((p) => p.participant === party)?.amount.amount ?? null, `${i}/${party}`).toBe(atOwner?.lineAmount?.amount ?? null);
      }
      const notOwned = item.parts.find((p) => p.participant === 'NOT_OWNED');
      const view = viewOf([sources[i] as TaxMeaning | WegTaxMeaning], ownerships, year, null);
      expect(notOwned?.amount.amount ?? '0.00').toBe(view.notOwned?.capitalized.total.amount ?? '0.00');
    }
    expect(items[0]?.parts.map((p) => [p.participant, p.amount.amount])).toEqual([
      // The odd cent to the larger share first (A 3/10 before NOT_OWNED 1/10), then by Party: the view's rule.
      [A, '300.01'],
      [B, '300.00'],
      [C, '300.00'],
      ['NOT_OWNED', '100.00'],
    ]);
    expect(items[1]?.parts.map((p) => [p.participant, p.amount.amount])).toEqual([
      [A, '-100.00'],
      [B, '-100.00'],
      [C, '-66.67'],
      ['NOT_OWNED', '-66.66'],
    ]);
  });

  it('the owners on the item’s date, never on 1 January nor the purchase’s buyers: an owner change between them', () => {
    // A sells her 3/5 to C on 2027-07-01; the item of 2027-09-09 belongs to C and B, not to A.
    const ownerships = [own(A, '3/5', '2026-07-01', '2027-06-30'), own(B, '2/5', '2026-07-01'), own(C, '3/5', '2027-07-01')];
    const [item] = capitalizedItemsOf([{ meaning: split({ amount: '1000.00', bookingDate: '2027-09-09' }), anschaffungsnaheAcquisitionId: null }], ownerships);
    expect(item?.parts.map((p) => [p.participant, p.amount.amount])).toEqual([
      [C, '600.00'],
      [B, '400.00'],
    ]);
  });

  it('the flags carried as Taxation gives them', () => {
    const flags = [{ code: 'RULE_SUPERSEDED', details: { superseded: true } }] as unknown as TaxMeaning['flags'];
    const [split1, use1] = capitalizedItemsOf(
      [split({ amount: '1.00', flags }), use('2.00')].map((meaning) => ({ meaning, anschaffungsnaheAcquisitionId: null })),
      [],
    );
    expect(split1?.flags).toEqual([{ code: 'RULE_SUPERSEDED', details: { superseded: true } }]);
    expect(use1?.flags.map((f) => f.code)).toEqual(['WITHDRAWAL_DATE_ASSUMED']);
  });
});
