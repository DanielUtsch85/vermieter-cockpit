import { describe, expect, it } from 'vitest';
import { RuleRegistry } from '../../shared/index.js';
import type { CapitalizedItem } from './capitalized-item.js';
import { DEPRECIATION_RULE_VERSIONS } from './rules/versions.js';
import { acc8, capitalized, eur } from './schedule.test-support.js';
import { repair } from './schedule-items.test-support.js';
import type { ScheduleInput } from './schedule-model.js';
import { countedComponent, inputFingerprint } from './version-fingerprint.js';
import { identity, live } from './version.test-support.js';

/**
 * §59E "Recorded versions and fingerprints" (§60): a Loan interest source carries `loan` and its record in its stored
 * inputs and its canonical JSON; every other component keeps its JSON byte for byte (no key, not `null`), so no existing
 * fingerprint changes; a Loan source added, its share changed by a backdated set, or its record changed each change the
 * fingerprint from the component's first year on. Synthetic figures.
 */
const registry = new RuleRegistry(DEPRECIATION_RULE_VERSIONS);
const owners = acc8().ownerships;
const L = '0000bbbb-0000-4000-8000-000000000031';
const SET = '0000eeee-0000-4000-8000-0000000000a1';
const R = '0000cccc-0000-4000-8000-0000000000c1';
const SPLIT = '0000eeee-0000-4000-8000-0000000000b1';
const loanItem = (overrides: Partial<CapitalizedItem> = {}) =>
  capitalized(SPLIT, '2028-03-31', '300.00', undefined, {
    taxCategory: 'LOAN_INTEREST',
    loan: { loanId: L, allocationSetId: SET, share: '3/5' },
    constructionPeriodInterestId: R,
    ...overrides,
  });
const inputsOf = (input: ScheduleInput) => live(input, registry, 2035).inputs;
const fp = (input: ScheduleInput, year: number) => inputFingerprint(inputsOf(input), year, identity);
const changedYears = (a: ScheduleInput, b: ScheduleInput) => [2026, 2027, 2028, 2029].filter((y) => fp(a, y) !== fp(b, y));

describe('§59E: the Loan keys of the stored inputs and the fingerprint', () => {
  const base = acc8({ ownerships: owners, capitalizedItems: [repair({ anschaffungsnaheAcquisitionId: null })] });

  it('a component without a Loan keeps its canonical JSON: no loan key, not null (no existing fingerprint changes)', () => {
    const [, item] = inputsOf(base).components;
    expect(item?.item).not.toHaveProperty('loan');
    expect(countedComponent(item as NonNullable<typeof item>).item).not.toHaveProperty('loan');
    expect(JSON.stringify(countedComponent(item as NonNullable<typeof item>))).not.toContain('constructionPeriodInterestId');
    // The same item with loan: null (as the adapter maps a PropertyReference's split) counts the same.
    const withNull = acc8({
      ownerships: owners,
      capitalizedItems: [repair({ anschaffungsnaheAcquisitionId: null, loan: null, constructionPeriodInterestId: null })],
    });
    expect(changedYears(base, withNull)).toEqual([]);
  });

  it('a Loan source: stored with its Loan, set, share and record; added, its share, its set or its record changed: the years from 2028 change', () => {
    const withLoan = acc8({ ownerships: owners, capitalizedItems: [repair({ anschaffungsnaheAcquisitionId: null }), loanItem()] });
    const stored = inputsOf(withLoan).components.find((c) => c.componentId === `TRANSACTION_SPLIT:${SPLIT}`);
    expect(stored?.item).toMatchObject({ loan: { loanId: L, allocationSetId: SET, share: '3/5' }, constructionPeriodInterestId: R });
    expect(stored?.basis).toBe(30_000n);
    expect(changedYears(base, withLoan)).toEqual([2028, 2029]);
    // A backdated set: the same part, another set or share; the record voided and another named: seen.
    const backdated = acc8({
      ownerships: owners,
      capitalizedItems: [
        repair({ anschaffungsnaheAcquisitionId: null }),
        loanItem({ loan: { loanId: L, allocationSetId: '0000eeee-0000-4000-8000-0000000000a2', share: '3/5' } }),
      ],
    });
    const share = acc8({
      ownerships: owners,
      capitalizedItems: [repair({ anschaffungsnaheAcquisitionId: null }), loanItem({ loan: { loanId: L, allocationSetId: SET, share: '1/2' } })],
    });
    const record = acc8({
      ownerships: owners,
      capitalizedItems: [repair({ anschaffungsnaheAcquisitionId: null }), loanItem({ constructionPeriodInterestId: '0000cccc-0000-4000-8000-0000000000c2' })],
    });
    for (const changed of [backdated, share, record]) expect(changedYears(withLoan, changed)).toEqual([2028, 2029]);
    // P's part changed (the basis): seen too.
    const part = acc8({ ownerships: owners, capitalizedItems: [repair({ anschaffungsnaheAcquisitionId: null }), loanItem({ lineAmount: eur('250.00') })] });
    expect(changedYears(withLoan, part)).not.toEqual([]);
  });
});
