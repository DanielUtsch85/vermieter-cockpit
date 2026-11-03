import type { DeclaredAfa, ShorterUsefulLife } from './asset.js';
import type { ScheduleAcquisition, ScheduleInput } from './schedule.js';
import { amount, component, derive, ownerIn } from './schedule-purchase.test-support.js';
import { A, B, W, acquisition, asset, day, eur, life, ownership } from './schedule.test-support.js';

/**
 * §59G Part 2's example (synthetic): one Acquisition, buyers A 3/5 and B 2/5, basis 240,000.00 (A 144,000.00,
 * B 96,000.00), transfer 2024-04-01 (`Y1` 2024), contract 2024-02-10, completed 1965 (band B of @2, 2 %, shorter below
 * 50 years); an entry of 33 years with the Stichtag 2027-05-20 (`YE` 2027) and the document of 2027-06-15, released by
 * the advisor with each owner's declared AfA through 2026 (A 7,920.00, B 5,280.00). Shared by `schedule-residual*.test.ts`;
 * no `expect` here.
 */

export const NOTE = 'Restwertmethode freigegeben, Steuerberatung, 2027-06-30 (synthetisch)';
export const declared = (partyId: string, value: string, throughYear = 2026): DeclaredAfa => ({
  partyId,
  throughYear,
  amount: eur(value),
  evidenceReference: `Steuerbescheide bis ${throughYear} (synthetisch)`,
});
/** Both owners' declared AfA through 2026, matching the band years 2024–2026. */
export const MATCHING = [declared(A, '7920.00'), declared(B, '5280.00')];

export const gutachten = (valuationDate: string | null, overrides: Partial<ShorterUsefulLife> = {}): ShorterUsefulLife =>
  life({
    usefulLifeYears: 33,
    evidence: {
      source: 'Gutachten zur Restnutzungsdauer',
      date: day('2027-06-15'),
      documentReference: 'Gutachten Nr. 0000-SYN',
      valuationDate: valuationDate === null ? null : day(valuationDate),
    },
    reviewState: 'ADVISOR_CONFIRMED',
    releaseNote: NOTE,
    declaredAfa: MATCHING,
    ...overrides,
  });

/** A Stichtag with the document on the same day (238-5: never a Stichtag after the document's date). */
export const onDay = (valuationDate: string, overrides: Partial<ShorterUsefulLife> = {}) =>
  gutachten(valuationDate, {
    evidence: {
      source: 'Gutachten zur Restnutzungsdauer',
      date: day(valuationDate),
      documentReference: 'Gutachten Nr. 0000-SYN',
      valuationDate: day(valuationDate),
    },
    ...overrides,
  });

export const purchase = (overrides: Partial<ScheduleAcquisition> = {}) =>
  acquisition({
    purchasePrice: eur('240000.00'),
    costs: [],
    contractDate: day('2024-02-10'),
    economicTransferDate: day('2024-04-01'),
    allocation: {
      id: '0000bbbb-0000-4000-8000-000000000041',
      method: 'PURCHASE_CONTRACT',
      reviewState: 'CONFIRMED',
      totalAllocableAmount: eur('240000.00'),
      buildingAmount: eur('240000.00'),
    },
    ...overrides,
  });

export const OWNERS = () => [ownership(A, '3/5', '2024-04-01', null, W), ownership(B, '2/5', '2024-04-01', null, W)];

export const example = (entries: readonly ShorterUsefulLife[], extra: Partial<ScheduleInput> = {}): ScheduleInput => ({
  asset: asset({ buildingCompletionYear: 1965, shorterUsefulLives: entries }),
  acquisitions: [purchase()],
  ownerships: OWNERS(),
  today: day('2026-10-30'),
  from: 2024,
  to: 2060,
  ownerPartyId: null,
  ...extra,
});

/** Per year of the purchase component: A's and B's amounts and the year's status. */
export const purchaseRows = (input: ScheduleInput, reg?: Parameters<typeof derive>[1]) =>
  component(derive(input, reg)).years.map((y) => [y.year, amount(ownerIn(y, A)?.amount), amount(ownerIn(y, B)?.amount), y.calculationStatus] as const);

/**
 * The carried-forward residual value spread exactly, re-derived here independently of the schedule's code: the owner's
 * year from the switch is `round(shown + R · k / months) − round(shown + R · (k − 12) / months)` in cents, half-up.
 */
export function spreadYears(basisCents: bigint, shownCents: bigint, months: number, firstYear: number, monthsInFirstYear = 12): Map<number, string> {
  const rest = basisCents - shownCents;
  const total = BigInt(months);
  const at = (k: number) => {
    const n = rest * BigInt(k) * 2n + total;
    return shownCents + n / (2n * total);
  };
  const out = new Map<number, string>();
  let done = 0;
  let year = firstYear;
  let step = monthsInFirstYear;
  while (done < months) {
    const next = Math.min(months, done + step);
    const cents = at(next) - at(done);
    out.set(year, `${cents / 100n}.${String(cents % 100n).padStart(2, '0')}`);
    done = next;
    year += 1;
    step = 12;
  }
  return out;
}
