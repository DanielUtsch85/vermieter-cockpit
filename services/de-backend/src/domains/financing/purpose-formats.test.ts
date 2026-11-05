import { describe, expect, it } from 'vitest';
import { Money, type BusinessDate } from '../../shared/index.js';
import { proposePayment, type ProposalTransaction } from './payment-proposal.js';
import { BBBANK_LOAN_DEBIT, LOAN_PURPOSE_FORMATS, germanAmountCents, readPurpose, type PurposeFormat } from './purpose-formats.js';
import { scheduleOf, type LoanTermsId, type SchedulePeriod } from './terms.js';

/**
 * VC-X-53: the payment proposal from the bank's purpose text (api-design.md §58O open question 12 (a); Entscheidung des
 * Projektinhabers, 2026-11-05, question 12, condition 1): a named format as the CSV presets, the source in the answer,
 * the plan's split as the counter-check, an unknown format silently the plan's split. Synthetic texts and figures.
 */
const day = (value: string) => value as BusinessDate;
const eur = (amount: string) => Money.of(amount, 'EUR');
const period: SchedulePeriod = {
  id: 't1' as LoanTermsId,
  validFrom: day('2027-04-25'),
  interestRate: 3000n,
  repaymentModel: 'ANNUITY',
  scheduledPayment: eur('600.00'),
  firstPaymentDate: day('2027-05-31'),
  principalAtStart: null,
  fixedRateUntil: null,
  paymentIntervalMonths: 1,
};
const plan = scheduleOf(eur('120000.00'), null, [period]);
const tx = (description: string | null, amount = 60_000n): ProposalTransaction => ({
  id: 'tx',
  bookingDate: day('2027-05-31'),
  amount,
  direction: 'OUTFLOW',
  status: 'IMPORTED',
  splitCount: 0,
  description,
});
const propose = (description: string | null, amount?: bigint) => proposePayment(plan, tx(description, amount), () => 'ANNUITY');
const EXAMPLE = 'RECHN.ZINS 360,00 TILG./ENTG. 240,00 TILGUNG PER 31.05.2027';

describe('German amounts', () => {
  it('two decimals, thousands by a dot at every third digit; anything else refused', () => {
    expect(['360,00', '1.234,56', '1234,56', '12.345.678,90', '0,05'].map(germanAmountCents)).toEqual([36_000n, 123_456n, 123_456n, 1_234_567_890n, 5n]);
    expect(['360.00', '1.23,45', '12.345,6', '360', '-360,00', '1,234.56'].map(germanAmountCents)).toEqual(Array(6).fill(undefined));
  });
});

describe('BBBANK_LOAN_DEBIT (a named format)', () => {
  it('reads the example; extra whitespace and line breaks between the tokens tolerated', () => {
    expect(readPurpose(EXAMPLE)).toEqual({ kind: 'SPLIT', format: 'BBBANK_LOAN_DEBIT', interest: 36_000n, principal: 24_000n, statedDate: '2027-05-31' });
    expect(readPurpose(`Darlehen 4711  RECHN.ZINS   1.234,56\nTILG./ENTG.  565,44   TILGUNG  PER 31.05.2027 Ende`)).toMatchObject({
      kind: 'SPLIT',
      interest: 123_456n,
      principal: 56_544n,
    });
  });

  it('another bank, another case or no text: not recognised; the pattern with an unreadable amount or date: unreadable', () => {
    for (const text of ['Darlehen 4711 Zins 360,00 Tilgung 240,00', 'rechn.zins 360,00 tilg./entg. 240,00 tilgung per 31.05.2027', 'Rate Mai', ''])
      expect(readPurpose(text)).toEqual({ kind: 'NOT_RECOGNISED' });
    expect(readPurpose(null)).toEqual({ kind: 'NOT_RECOGNISED' });
    expect(readPurpose('RECHN.ZINS 360.00 TILG./ENTG. 240,00 TILGUNG PER 31.05.2027')).toEqual({ kind: 'UNREADABLE', format: 'BBBANK_LOAN_DEBIT' });
    expect(readPurpose('RECHN.ZINS 360,00 TILG./ENTG. 240,00 TILGUNG PER 31.02.2027')).toEqual({ kind: 'UNREADABLE', format: 'BBBANK_LOAN_DEBIT' });
  });

  it('the formats are a registry by name; a format that does not recognise a text gives way to the next', () => {
    expect([...LOAN_PURPOSE_FORMATS.keys()]).toEqual(['BBBANK_LOAN_DEBIT']);
    const other: PurposeFormat = {
      name: 'OTHER_BANK',
      read: (t) =>
        t.startsWith('ZINS') ? { kind: 'SPLIT', format: 'OTHER_BANK', interest: 1n, principal: 2n, statedDate: day('2027-05-31') } : { kind: 'NOT_RECOGNISED' },
    };
    const formats = new Map([
      [BBBANK_LOAN_DEBIT.name, BBBANK_LOAN_DEBIT],
      [other.name, other],
    ]);
    expect(readPurpose('ZINS 1 TILGUNG 2', formats)).toMatchObject({ format: 'OTHER_BANK' });
    expect(readPurpose(EXAMPLE, formats)).toMatchObject({ format: 'BBBANK_LOAN_DEBIT' });
  });
});

describe('the proposal with the purpose text (§41.5, §58O (a))', () => {
  it('the example: source PURPOSE_TEXT, 360.00 / 240.00, the plan split beside it, SPLIT_DIFFERS_FROM_SCHEDULE', () => {
    expect(propose(EXAMPLE)).toMatchObject({
      kind: 'PROPOSAL',
      interest: 36_000n,
      principal: 24_000n,
      unallocated: 0n,
      source: 'PURPOSE_TEXT',
      purposeFormat: 'BBBANK_LOAN_DEBIT',
      scheduleSplit: { interest: 30_000n, principal: 30_000n },
      flags: [
        {
          code: 'SPLIT_DIFFERS_FROM_SCHEDULE',
          purposeText: { interest: 36_000n, principal: 24_000n },
          schedule: { interest: 30_000n, principal: 30_000n },
        },
      ],
    });
  });

  it('a text whose amounts do not add up to the debit: the plan split with PURPOSE_SPLIT_NOT_MATCHING', () => {
    expect(propose('RECHN.ZINS 360,00 TILG./ENTG. 250,00 TILGUNG PER 31.05.2027')).toMatchObject({
      interest: 30_000n,
      principal: 30_000n,
      source: 'SCHEDULE',
      purposeFormat: null,
      flags: [{ code: 'PURPOSE_SPLIT_NOT_MATCHING', format: 'BBBANK_LOAN_DEBIT', stated: { interest: 36_000n, principal: 25_000n } }],
    });
    expect(propose('RECHN.ZINS 360.00 TILG./ENTG. 240,00 TILGUNG PER 31.05.2027')).toMatchObject({
      source: 'SCHEDULE',
      flags: [{ code: 'PURPOSE_SPLIT_NOT_MATCHING', format: 'BBBANK_LOAN_DEBIT', stated: null }],
    });
  });

  it('another bank, no text: silently the plan split, no flag', () => {
    for (const text of ['Darlehen 4711 Zins 360,00 Tilgung 240,00', null]) {
      expect(propose(text)).toEqual({ ...propose(null), flags: [] });
      expect(propose(text)).toMatchObject({
        source: 'SCHEDULE',
        interest: 30_000n,
        principal: 30_000n,
        scheduleSplit: { interest: 30_000n, principal: 30_000n },
      });
    }
  });

  it('a parsed split equal to the plan: PURPOSE_TEXT without SPLIT_DIFFERS_FROM_SCHEDULE; the amount flags unchanged', () => {
    expect(propose('RECHN.ZINS 300,00 TILG./ENTG. 300,00 TILGUNG PER 31.05.2027')).toMatchObject({ source: 'PURPOSE_TEXT', flags: [] });
    // A debit above the plan: the amount flag as today, the text's split adding up to it.
    expect(propose('RECHN.ZINS 300,00 TILG./ENTG. 400,00 TILGUNG PER 31.05.2027', 70_000n)).toMatchObject({
      source: 'PURPOSE_TEXT',
      interest: 30_000n,
      principal: 40_000n,
      scheduleSplit: { interest: 30_000n, principal: 40_000n },
      flags: [{ code: 'AMOUNT_DIFFERS_FROM_SCHEDULE', difference: 10_000n }],
    });
  });
});
