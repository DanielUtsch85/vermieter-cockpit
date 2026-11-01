import { describe, expect, it } from 'vitest';
import { Money, RuleRegistry } from '../../shared/index.js';
import { canonicalJson, ruleVersionHash } from './fingerprint.js';
import { DE_AFA_BUILDING_LINEAR_V2 } from './rules/de-afa-building-linear.js';
import { DEPRECIATION_RULE_VERSIONS } from './rules/versions.js';
import { acquisition, acc8, asset, capitalized, day, eur, life, ownership, B, C, X } from './schedule.test-support.js';
import { EXTENSION, REPAIR, repair } from './schedule-items.test-support.js';
import type { ScheduleInput } from './schedule-model.js';
import { inputFingerprint } from './version-fingerprint.js';
import { identity, live } from './version.test-support.js';

/**
 * The fingerprints of api-design.md §60 "Changed since recorded", with the identity `Fingerprinter` (the canonical
 * JSON itself): `canonicalJson`, the rule-version hash, the truncation per year, each counting change and each
 * non-counting one.
 */
const registry = new RuleRegistry(DEPRECIATION_RULE_VERSIONS);
// One set of Ownerships for every input: the fixtures number their ids, and an id is an input (a new Ownership counts).
const owners = acc8().ownerships;
const fp = (input: ScheduleInput, year: number, reg = registry) => inputFingerprint(live(input, reg, 2035).inputs, year, identity);
const years = (a: ScheduleInput, b: ScheduleInput, from = 2026, to = 2031) =>
  Array.from({ length: to - from + 1 }, (_, i) => from + i).filter((y) => fp(a, y) !== fp(b, y));

describe('canonicalJson and the rule-version hash (§60)', () => {
  it('keys sorted, no whitespace, "600" and "600.00" the same Money, bigint as text, lists in their order', () => {
    expect(canonicalJson({ b: 1, a: [2, 1], c: { z: null, y: true } })).toBe('{"a":[2,1],"b":1,"c":{"y":true,"z":null}}');
    expect(canonicalJson(Money.of('600', 'EUR'))).toBe(canonicalJson(Money.of('600.00', 'EUR')));
    expect(canonicalJson(Money.of('600', 'EUR'))).toBe('{"amount":"600.00","currency":"EUR"}');
    expect(canonicalJson({ n: 5n, u: undefined })).toBe('{"n":"5"}');
  });

  it('one input, one hash: stable for a registered version, changed by title, legalBasis, effectiveFrom, parameters, source; not by effectiveTo', () => {
    const hash = (v: typeof DE_AFA_BUILDING_LINEAR_V2) => ruleVersionHash(v, identity);
    const v = DE_AFA_BUILDING_LINEAR_V2;
    expect(hash(v)).toBe(hash({ ...v }));
    for (const changed of [
      { ...v, title: `${v.title}.` },
      { ...v, legalBasis: `${v.legalBasis}.` },
      { ...v, effectiveFrom: day('2023-01-02') },
      { ...v, source: `${v.source}.` },
      { ...v, parameters: { ...v.parameters, verified: { ...v.parameters.verified, rates: !v.parameters.verified.rates } } },
    ]) {
      expect(hash(changed)).not.toBe(hash(v));
    }
    expect(hash({ ...v, effectiveTo: day('2030-01-01') })).toBe(hash(v));
  });
});

describe('inputFingerprint(Y) is truncated at the end of Y (§60)', () => {
  const sale = acc8({
    acquisitions: [
      acquisition(),
      acquisition({
        id: X,
        contractDate: day('2029-05-01'),
        economicTransferDate: day('2029-07-01'),
        sellerPartyIds: [B],
        acquiredShare: { numerator: 2, denominator: 5 },
      }),
    ],
    ownerships: [
      owners[0] as (typeof owners)[number],
      { ...(owners[1] as (typeof owners)[number]), validUntil: day('2029-06-30') },
      ownership(C, '2/5', '2029-07-01', null, X),
    ],
  });

  it('a sale in 2029 changes the fingerprints of 2029 onward and not of 2026–2028', () => {
    expect(years(acc8({ ownerships: owners }), sale)).toEqual([2029, 2030, 2031]);
  });

  it('an item dated 2027 changes 2027 onward and not 2026; counter-check: one dated 2028 leaves 2027 alone', () => {
    const item = (date: string) => acc8({ ownerships: owners, capitalizedItems: [capitalized(EXTENSION, date, '10000.00')] });
    expect(years(acc8({ ownerships: owners }), item('2027-05-05'))).toEqual([2027, 2028, 2029, 2030, 2031]);
    expect(years(acc8({ ownerships: owners }), item('2028-05-05'))).toEqual([2028, 2029, 2030, 2031]);
  });
});

describe('what counts as a change (§60)', () => {
  const base = acc8({ ownerships: owners, capitalizedItems: [repair({ anschaffungsnaheAcquisitionId: null })] });
  const withAcq = (change: Parameters<typeof acquisition>[0]) => ({ ...base, acquisitions: [acquisition(change)] });
  const a = acquisition();
  const counting: Record<string, ScheduleInput> = {
    'an item added': acc8({
      ownerships: owners,
      capitalizedItems: [repair({ anschaffungsnaheAcquisitionId: null }), capitalized(EXTENSION, '2027-05-05', '1000.00')],
    }),
    'an item removed': acc8({ ownerships: owners }),
    'an item reclassified (a new classificationId)': acc8({
      ownerships: owners,
      capitalizedItems: [repair({ anschaffungsnaheAcquisitionId: null, classificationId: `${REPAIR.slice(0, 30)}ee` })],
    }),
    'an item’s amount': acc8({ ownerships: owners, capitalizedItems: [repair({ anschaffungsnaheAcquisitionId: null, lineAmount: eur('35000.00') })] }),
    'an item’s date': acc8({ ownerships: owners, capitalizedItems: [repair({ anschaffungsnaheAcquisitionId: null, date: day('2027-03-11') })] }),
    'a cost added': withAcq({
      costs: [...a.costs, { id: '0000bbbb-0000-4000-8000-000000000099', category: 'NOTARY', amount: eur('100.00'), paymentStatus: 'PAID' }],
    }),
    'a cost voided': withAcq({ costs: a.costs.slice(1) }),
    'an allocation superseded with the same amounts': withAcq({
      allocation: { ...(a.allocation as NonNullable<typeof a.allocation>), id: '0000bbbb-0000-4000-8000-000000000031' },
    }),
    'an owner’s share': {
      ...base,
      ownerships: [
        owners[0] as (typeof owners)[number],
        { ...(owners[1] as (typeof owners)[number]), validUntil: day('2027-06-30') },
        ownership(B, '1/5', '2027-07-01', null, null),
      ],
    },
    'the completion year': { ...base, asset: asset({ buildingCompletionYear: 1920 }) },
    'a shorter life’s years': { ...base, asset: asset({ shorterUsefulLives: [life({ usefulLifeYears: 30 })] }) },
  };
  for (const [name, changed] of Object.entries(counting)) {
    it(`${name} changes the fingerprint of 2027`, () => {
      expect(fp(changed, 2027)).not.toBe(fp(base, 2027));
    });
  }

  it('another rule version, a changed rule hash: the fingerprint of 2027 changes', () => {
    const titled = new RuleRegistry(
      DEPRECIATION_RULE_VERSIONS.map((v) => (v.ruleCode === 'DE_AFA_BUILDING_LINEAR' && v.version === 2 ? { ...v, source: `${v.source}.` } : v)),
    );
    expect(fp(base, 2027, titled)).not.toBe(fp(base, 2027));
  });

  const notCounting: Record<string, ScheduleInput> = {
    notes: { ...base, asset: asset({ notes: 'Notiz (synthetisch)' }) },
    sourceReferences: { ...base, asset: asset({ sourceReferences: ['Akte 7'] }) },
    'CONFIRMED → ADVISOR_CONFIRMED (asset)': { ...base, asset: asset({ reviewState: 'ADVISOR_CONFIRMED' }) },
    'CONFIRMED → ADVISOR_CONFIRMED (allocation)': withAcq({
      allocation: { ...(a.allocation as NonNullable<typeof a.allocation>), reviewState: 'ADVISOR_CONFIRMED' },
    }),
    'USER_CONFIRMED → ADVISOR_CONFIRMED (classification)': acc8({
      ownerships: owners,
      capitalizedItems: [repair({ anschaffungsnaheAcquisitionId: null, reviewState: 'ADVISOR_CONFIRMED' })],
    }),
    'a cost’s payment status': withAcq({ costs: a.costs.map((c) => ({ ...c, paymentStatus: 'UNPAID' })) }),
    'the asset’s row version': { ...base, asset: asset({ version: 7 }) },
    computedOn: { ...base, today: day('2031-01-01') },
  };
  for (const [name, same] of Object.entries(notCounting)) {
    it(`${name} does not change it`, () => {
      expect(fp(same, 2027)).toBe(fp(base, 2027));
    });
  }
});
