import { describe, expect, it } from 'vitest';
import { Money, type BusinessDate } from '../../shared/index.js';
import {
  assessmentFingerprint,
  changedAssessmentFields,
  deriveAssessment,
  instalmentsRefusal,
  sameAssessmentContent,
  sameUses,
  type AssessmentPayment,
  type SpecialAssessment,
  type WegSpecialAssessmentId,
} from './special-assessment.js';

/** The Sonderumlage (api-design.md §51A). Figures are invented. */
const eur = (amount: string) => Money.of(amount, 'EUR');
const day = (value: string) => value as BusinessDate;

/** 900 in three instalments of 300, due 1 March, 1 June, 1 September. */
const assessment = (overrides: Partial<SpecialAssessment> = {}): SpecialAssessment => ({
  id: 'a' as WegSpecialAssessmentId,
  mreRealmId: 'r',
  membershipId: 'm',
  description: 'Dachsanierung',
  resolutionDate: day('2026-02-10'),
  purpose: 'MAINTENANCE',
  totalAmount: eur('36000.00'),
  unitShare: eur('900.00'),
  instalments: [
    { position: 1, dueDate: day('2026-03-01'), amount: eur('300.00') },
    { position: 2, dueDate: day('2026-06-01'), amount: eur('300.00') },
    { position: 3, dueDate: day('2026-09-01'), amount: eur('300.00') },
  ],
  uses: [],
  storedStatus: 'ACTIVE',
  voidedAt: null,
  voidReason: null,
  sourceReferences: [],
  notes: null,
  createdAt: new Date(),
  version: 1,
  ...overrides,
});
const pay = (transactionId: string, amount: string, bookingDate = '2026-03-01'): AssessmentPayment => ({
  transactionId,
  bookingDate: day(bookingDate),
  amount: eur(amount),
});

describe('instalments (§51A)', () => {
  it('sum to the unit share exactly, due dates strictly increasing', () => {
    expect(instalmentsRefusal(assessment())).toBeUndefined();
    expect(instalmentsRefusal(assessment({ unitShare: eur('900.01') }))).toBe('INSTALMENTS_DO_NOT_SUM');
    const same = assessment().instalments.map((i) => ({ ...i, dueDate: day('2026-03-01') }));
    expect(instalmentsRefusal(assessment({ instalments: same }))).toBe('DUE_DATES_NOT_INCREASING');
  });
});

describe('deriveAssessment (§51A)', () => {
  it('nothing paid: everything outstanding, ACTIVE, overdue only once due before asOf', () => {
    const view = deriveAssessment(assessment(), [], [], day('2026-06-01'));
    expect(view).toMatchObject({ status: 'ACTIVE', paid: eur('0.00'), outstanding: eur('900.00'), flags: [] });
    expect(view.instalmentsCovered.map((i) => [i.covered.amount, i.overdue])).toEqual([
      ['0.00', true],
      ['0.00', false],
      ['0.00', false],
    ]);
  });

  it('paid covers the instalments in due order, partially; a refund counts negative', () => {
    const view = deriveAssessment(
      assessment(),
      [pay('t1', '300.00'), pay('t2', '200.00', '2026-06-03'), pay('r', '-50.00', '2026-06-04')],
      [],
      day('2026-07-01'),
    );
    expect(view.paid).toEqual(eur('450.00'));
    expect(view.instalmentsCovered.map((i) => [i.covered.amount, i.overdue])).toEqual([
      ['300.00', false],
      ['150.00', true],
      ['0.00', false],
    ]);
    expect(view.payments.map((p) => p.transactionId)).toEqual(['t1', 't2', 'r']);
  });

  it('fully paid: SETTLED; overpaid: flagged; VOID stays VOID', () => {
    const paid = [pay('t1', '900.00')];
    expect(deriveAssessment(assessment(), paid, [], day('2026-12-31')).status).toBe('SETTLED');
    const over = deriveAssessment(assessment(), [pay('t1', '950.00')], [], day('2026-12-31'));
    expect(over).toMatchObject({ status: 'SETTLED', outstanding: eur('-50.00'), flags: [{ code: 'OVERPAID', details: { amount: eur('50.00') } }] });
    expect(over.instalmentsCovered.every((i) => i.covered.equals(i.amount))).toBe(true);
    expect(deriveAssessment(assessment({ storedStatus: 'VOID' }), [], [], day('2026-12-31')).status).toBe('VOID');
  });

  it('USES_EXCEED_PAID and UNCOUNTED_PAYMENTS', () => {
    const uses = [{ position: 1, date: day('2026-08-01'), description: 'Dachdecker', unitShare: eur('400.00') }];
    const view = deriveAssessment(assessment({ uses }), [pay('t1', '300.00')], ['u2', 'u1', 'u2'], day('2026-03-02'));
    expect(view.flags).toEqual([
      { code: 'USES_EXCEED_PAID', details: { uses: eur('400.00'), paid: eur('300.00') } },
      { code: 'UNCOUNTED_PAYMENTS', details: { transactionIds: ['u1', 'u2'] } },
    ]);
  });
});

describe('content', () => {
  it('sameAssessmentContent and changedAssessmentFields; sameUses; the fingerprint', () => {
    const a = assessment();
    expect(sameAssessmentContent(a, { ...a, instalments: [...a.instalments].reverse() })).toBe(true);
    expect(sameAssessmentContent(a, { ...a, purpose: 'MODERNISATION' })).toBe(false);
    expect(changedAssessmentFields(a, { ...a, purpose: 'MODERNISATION', notes: 'n', unitShare: eur('600.00') })).toEqual(['purpose', 'unitShare', 'notes']);
    const use = { position: 1, date: day('2026-08-01'), description: 'Dachdecker', unitShare: eur('400.00') };
    expect(sameUses([use], [{ ...use }])).toBe(true);
    expect(sameUses([use], [{ ...use, unitShare: eur('400.01') }])).toBe(false);
    expect(assessmentFingerprint(a)).toBe(assessmentFingerprint({ ...a, mreRealmId: 'other' }));
    expect(assessmentFingerprint(a)).not.toBe(assessmentFingerprint({ ...a, resolutionDate: day('2026-02-11') }));
  });
});
