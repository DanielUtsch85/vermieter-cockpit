import { Money, RuleRegistry, type BusinessDate } from '../../shared/index.js';
import type { BasisCost } from '../acquisition/index.js';
import { checkAnschaffungsnahe, type CheckAcquisition, type CheckSource } from './anschaffungsnahe.js';
import type { CostLineGroup, HausgeldInput, HausgeldLine, HausgeldMembership, HausgeldStatement } from './anschaffungsnahe-hausgeld.js';
import type { Performance } from './performance.js';
import { TAXATION_RULE_VERSIONS } from './rules/versions.js';
import type { TaxClassification, TaxClassificationId } from './tax-classification.js';

/**
 * §58M's example (synthetic) for the domain tests: PropertyReference P, owned by A, member of a WEG from 2026-03-15;
 * Acquisition Q with `economicTransferDate` 2026-03-15 and basis 198,000.00 (threshold 29,700.00); the split repair R1
 * (net 26,000.00, performed in April 2027); the `CONFIRMED` statements 2026–2029 with lines L1–L4. Test support only.
 */
export const TAX_RULES = new RuleRegistry(TAXATION_RULE_VERSIONS);
export const day = (value: string) => value as BusinessDate;
export const eur = (amount: string) => Money.of(amount, 'EUR');

export const acquisition: CheckAcquisition = {
  id: 'acq-q',
  propertyReferenceId: 'pr-p',
  status: 'CONFIRMED',
  transferDate: day('2026-03-15'),
  contractDate: day('2026-02-01'),
  acquiredShare: { numerator: 1, denominator: 1 },
  purchasePrice: eur('240000.00'),
};
export const costs: BasisCost[] = [{ id: 'cost-1', category: 'REAL_ESTATE_TRANSFER_TAX', amount: eur('24000.00'), classification: null }];
export const allocation = { id: 'al-1', reviewState: 'CONFIRMED', totalAllocableAmount: eur('264000.00'), buildingAmount: eur('198000.00') };

export const performed = (from: string, until: string, progress: [string, string][] = [], progressEstimated = false): Performance => ({
  from: day(from),
  until: day(until),
  progress: progress.map(([through, amount]) => ({ through: day(through), amount: eur(amount) })),
  progressEstimated: progress.length === 0 ? null : progressEstimated,
});

export const R1: CheckSource = {
  sourceType: 'TRANSACTION_SPLIT',
  sourceId: 'R1',
  sourcePosition: null,
  date: day('2027-05-10'),
  dateSource: 'BOOKING',
  taxYear: 2027,
  taxCategory: 'MAINTENANCE',
  treatment: 'DEDUCTIBLE',
  reviewState: 'USER_CONFIRMED',
  origin: 'CLASSIFICATION',
  classificationId: 'c-R1',
  grossAmount: eur('30940.00'),
  direction: 'OUTFLOW',
  netAmount: eur('26000.00'),
  annuallyRecurring: false,
  anschaffungsnaheAcquisitionId: null,
  performance: performed('2027-04-01', '2027-04-30'),
  sourceFlags: [],
};

/** A cost line's classification (`MAINTENANCE`/`DEDUCTIBLE` with `net`, or `NOT_RELEVANT` without). */
export function judged(
  statementId: string,
  position: number,
  net: string | null,
  performance: Performance | null = null,
  extra: Partial<TaxClassification> = {},
): TaxClassification {
  return {
    id: `c-${statementId}-${position}` as TaxClassificationId,
    mreRealmId: 'realm-1',
    sourceType: 'WEG_STATEMENT_COST_LINE',
    sourceId: statementId,
    taxCategory: net === null ? 'NOT_RELEVANT' : 'MAINTENANCE',
    treatment: net === null ? 'NOT_RELEVANT' : 'DEDUCTIBLE',
    reviewState: 'USER_CONFIRMED',
    rule: { ruleCode: 'DE_ANSCHAFFUNGSNAHE', version: 1 },
    advisorPartyId: null,
    notes: null,
    sourceReferences: performance?.progress.length ? ['Leistungsaufstellung der Verwaltung'] : [],
    taxYear: null,
    refundOfYear: null,
    depositClosing: null,
    sourcePosition: position,
    reserveWithdrawal: null,
    assessmentUse: null,
    netAmount: net === null ? null : eur(net),
    annuallyRecurring: false,
    distributionYears: null,
    mostlyResidentialConfirmed: null,
    anschaffungsnaheAcquisitionId: null,
    constructionPeriodInterestId: null,
    performance,
    treatmentRule: null,
    supersedes: null,
    supersededBy: null,
    supersededAt: null,
    createdAt: new Date('2030-01-01T00:00:00Z'),
    createdBy: 'user-a',
    version: 1,
    ...extra,
  };
}

export const line = (
  position: number,
  account: string,
  unitShare: string,
  current: TaxClassification | null,
  classification: CostLineGroup = 'NON_RECOVERABLE',
): HausgeldLine => ({
  position,
  account,
  classification,
  unitShare: eur(unitShare),
  current,
});

export const statement = (
  year: number,
  lines: (id: string) => HausgeldLine[],
  period: [string, string] = [`${year}-01-01`, `${year}-12-31`],
): HausgeldStatement => {
  const id = `st-${year}`;
  return { id, membershipId: 'm-1', financialYear: year, periodFrom: day(period[0]), periodUntil: day(period[1]), lines: lines(id) };
};

export const membership: HausgeldMembership = { id: 'm-1', validFrom: day('2026-03-15'), validUntil: null, financialYearStartMonth: 1 };

/** The `RECOVERABLE` lines every statement carries (never read) and a `NOT_RELEVANT` administrator's fee. */
const ordinary = (id: string) => [
  line(1, 'Hausmeister', '1800.00', null, 'RECOVERABLE'),
  line(2, 'Gebäudeversicherung', '420.00', null, 'RECOVERABLE'),
  line(4, 'Verwaltervergütung', '600.00', judged(id, 4, null)),
];

/** L4's performance: none in the base example, else as (a) or (b). */
export function example(l4: Performance | null = null, overrides: { readonly l2?: TaxClassification | null } = {}): HausgeldStatement[] {
  return [
    statement(2026, ordinary, ['2026-03-15', '2026-12-31']),
    statement(2027, (id) => [
      ...ordinary(id).filter((l) => l.position !== 4),
      line(3, 'Instandsetzung Fassade', '2000.00', judged(id, 3, '1680.67', performed('2027-06-01', '2027-07-15'))),
      line(4, 'Verwaltervergütung', '600.00', overrides.l2 === undefined ? judged(id, 4, null) : overrides.l2),
    ]),
    statement(2028, ordinary),
    statement(2029, (id) => [
      line(1, 'Hausmeister', '1800.00', null, 'RECOVERABLE'),
      line(2, 'Dachrinnen', '3000.00', judged(id, 2, '2521.01', performed('2029-02-15', '2029-04-14', [['2029-03-15', '1500.00']]))),
      line(3, 'Instandsetzung Tiefgarage', '2400.00', judged(id, 3, '2016.81', l4)),
      line(4, 'Verwaltervergütung', '600.00', judged(id, 4, null)),
    ]),
  ];
}

/** The statement of 2030 with its lines judged `NOT_RELEVANT` (example (a′)). */
export const statement2030 = statement(2030, ordinary);

export function check(
  statements: readonly HausgeldStatement[],
  options: {
    readonly today?: string;
    readonly sources?: CheckSource[];
    readonly registry?: RuleRegistry;
    readonly acquisition?: CheckAcquisition;
  } & Partial<HausgeldInput> = {},
) {
  const hausgeld: HausgeldInput = { statements, memberships: options.memberships ?? [membership] };
  return checkAnschaffungsnahe(
    {
      acquisition: options.acquisition ?? acquisition,
      costs,
      allocation,
      sources: options.sources ?? [R1],
      statements: statements.map((s) => ({ id: s.id, periodFrom: s.periodFrom, periodUntil: s.periodUntil })),
      hausgeld,
      today: day(options.today ?? '2030-08-01'),
    },
    options.registry ?? TAX_RULES,
  );
}

export const reasonsOf = (c: ReturnType<typeof check>) =>
  (c.flags.find((f) => f.code === 'NOT_FINAL')?.details as { reasons: string[] } | undefined)?.reasons ?? [];
export const flagOf = (c: ReturnType<typeof check>, code: string) => c.flags.find((f) => f.code === code)?.details;
export const keys = (entries: readonly { readonly sourceId: string; readonly sourcePosition: number | null }[]) =>
  entries.map((e) => (e.sourcePosition === null ? e.sourceId : `${e.sourceId}/${e.sourcePosition}`));
