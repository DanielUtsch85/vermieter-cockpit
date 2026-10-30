import { sql, type Transaction } from 'kysely';
import {
  anschaffungsnaheRuleOn,
  anschaffungsnaheWindow,
  checkAnschaffungsnahe,
  checkFlagsOf,
  deriveWegTaxMeaning,
  distributionOf,
  possiblyTwice,
  useFacts,
  wegSourceKey,
  withTreatmentEffects,
  withdrawalFacts,
  BOOKING_DATE_EDGE_DAYS,
  type AnschaffungsnaheCheck,
  type Distribution,
  type OtherWegSource,
  type TreatmentSuggestion,
  type CheckSource,
  type OwnershipPeriod,
  continuousOwners,
  type RuleRegistry,
  type TaxClassification,
  type WegSourceFacts,
  type WegTaxMeaning,
} from '../../domains/taxation/index.js';
import { addDays, type BusinessDate, type Money } from '../../shared/index.js';
import { fromNumericAmount } from './money-column.js';
import type { Database } from './schema.js';
import { readAssessmentViewIn } from './weg-special-assessment-repository.js';
import { reserveFromJson } from './weg-annual-statement-repository.js';

/**
 * What the tax reads of §58B need around one PropertyReference, in the caller's snapshot: the withdrawals and uses of
 * its WEG memberships, their current classifications, its Ownerships (for the § 82b fold) and its Acquisitions (for the
 * anschaffungsnahe check). Reads only; never a statement's cost lines (§58B "Never counted twice").
 */

export interface WegContext {
  readonly facts: readonly WegSourceFacts[];
  readonly current: ReadonlyMap<string, TaxClassification>;
  readonly twice: ReadonlyMap<string, readonly OtherWegSource[]>;
  /** The `CONFIRMED` statements of the memberships, for `WEG_HAUSGELD_MAINTENANCE_NOT_COUNTED`. */
  readonly confirmedStatements: readonly { readonly id: string; readonly periodFrom: BusinessDate; readonly periodUntil: BusinessDate }[];
}

export type OwnershipSpan = OwnershipPeriod;

/** The withdrawals and uses of the memberships of `propertyReferenceId` (or of one membership), every status. */
export async function wegContextOf(
  trx: Transaction<Database>,
  mreRealmId: string,
  filter: { readonly propertyReferenceId: string } | { readonly membershipId: string },
  asOf: BusinessDate,
  currentOfKeys: (trx: Transaction<Database>, facts: readonly WegSourceFacts[]) => Promise<Map<string, TaxClassification>>,
): Promise<WegContext> {
  let memberships = trx
    .selectFrom('weg_membership as m')
    .innerJoin('weg as w', 'w.id', 'm.weg_id')
    .select([
      'm.id',
      'm.property_reference_id',
      sql<string>`m.mea_numerator::text`.as('n'),
      sql<string>`m.mea_denominator::text`.as('d'),
      'w.financial_year_start_month',
    ])
    .where('m.mre_realm_id', '=', mreRealmId);
  memberships =
    'propertyReferenceId' in filter
      ? memberships.where('m.property_reference_id', '=', filter.propertyReferenceId)
      : memberships.where('m.id', '=', filter.membershipId);
  const members = await memberships.execute();
  if (members.length === 0) return { facts: [], current: new Map(), twice: new Map(), confirmedStatements: [] };
  const byId = new Map(members.map((m) => [m.id, m]));
  const statements = await trx
    .selectFrom('weg_annual_statement')
    .select([
      'id',
      'membership_id',
      'status',
      'superseded_by_id',
      'supersedes_id',
      'financial_year',
      sql<string>`to_char(period_from, 'YYYY-MM-DD')`.as('period_from'),
      sql<string>`to_char(period_until, 'YYYY-MM-DD')`.as('period_until'),
      'reserve',
    ])
    .where('mre_realm_id', '=', mreRealmId)
    .where('membership_id', 'in', [...byId.keys()])
    .orderBy('id')
    .execute();
  const predecessors = statements.map((s) => s.supersedes_id).filter((id): id is string => id !== null);
  const predecessorRows =
    predecessors.length === 0
      ? []
      : await trx
          .selectFrom('tax_classification')
          .select(['id', 'weg_annual_statement_id'])
          .where('weg_annual_statement_id', 'in', predecessors)
          .where('superseded_at', 'is', null)
          .execute();
  const facts: WegSourceFacts[] = [];
  for (const s of statements) {
    const m = byId.get(s.membership_id);
    if (m === undefined) continue;
    const reserve = reserveFromJson(s.reserve);
    const predecessor =
      s.supersedes_id === null
        ? null
        : { statementId: s.supersedes_id, classificationIds: predecessorRows.filter((r) => r.weg_annual_statement_id === s.supersedes_id).map((r) => r.id) };
    for (const line of [...(reserve?.lines ?? [])].sort((a, b) => a.position - b.position)) {
      facts.push(
        withdrawalFacts({
          statementId: s.id,
          status: s.status,
          supersededBy: s.superseded_by_id,
          financialYear: s.financial_year,
          periodFrom: s.period_from as BusinessDate,
          periodUntil: s.period_until as BusinessDate,
          financialYearStartMonth: m.financial_year_start_month,
          membershipId: m.id,
          propertyReferenceId: m.property_reference_id,
          mea: { numerator: m.n, denominator: m.d },
          line: { position: line.position, description: line.description, kind: line.kind, withdrawal: line.withdrawal, date: line.date ?? null },
          predecessor,
        }),
      );
    }
  }
  const assessments = await trx
    .selectFrom('weg_special_assessment')
    .select(['id', 'membership_id'])
    .where('mre_realm_id', '=', mreRealmId)
    .where('membership_id', 'in', [...byId.keys()])
    .orderBy('id')
    .execute();
  for (const a of assessments) {
    const m = byId.get(a.membership_id);
    const view = await readAssessmentViewIn(trx, a.id, mreRealmId, asOf);
    if (m === undefined || view === undefined) continue;
    const exceeded = view.flags.find((f) => f.code === 'USES_EXCEED_PAID');
    for (const use of [...view.uses].sort((x, y) => x.position - y.position)) {
      facts.push(
        useFacts({
          assessmentId: a.id,
          storedStatus: view.storedStatus,
          membershipId: m.id,
          propertyReferenceId: m.property_reference_id,
          financialYearStartMonth: m.financial_year_start_month,
          use,
          usesExceedPaid: exceeded === undefined ? null : (exceeded.details as { uses: Money; paid: Money }),
        }),
      );
    }
  }
  return {
    facts,
    current: await currentOfKeys(trx, facts),
    twice: possiblyTwice(facts),
    confirmedStatements: statements
      .filter((s) => s.status === 'CONFIRMED')
      .map((s) => ({ id: s.id, periodFrom: s.period_from as BusinessDate, periodUntil: s.period_until as BusinessDate })),
  };
}

/** The meaning of a WEG source without the effects of its treatment. */
export function baseWegMeaning(ctx: WegContext, facts: WegSourceFacts, registry: RuleRegistry, today: BusinessDate): WegTaxMeaning {
  const key = wegSourceKey(facts);
  return deriveWegTaxMeaning(facts, ctx.current.get(key) ?? null, registry, today, ctx.twice.get(key) ?? []);
}

/** The `VALID` Ownerships of a PropertyReference. */
export async function ownershipsOf(trx: Transaction<Database>, mreRealmId: string, propertyReferenceId: string | null): Promise<OwnershipSpan[]> {
  if (propertyReferenceId === null) return [];
  const rows = await trx
    .selectFrom('ownership')
    .select([
      'id',
      'owner_party_id',
      sql<string>`to_char(valid_from, 'YYYY-MM-DD')`.as('valid_from'),
      sql<string | null>`to_char(valid_until, 'YYYY-MM-DD')`.as('valid_until'),
    ])
    .where('mre_realm_id', '=', mreRealmId)
    .where('property_reference_id', '=', propertyReferenceId)
    .where('status', '=', 'VALID')
    .orderBy('id')
    .execute();
  return rows.map((r) => ({ id: r.id, partyId: r.owner_party_id, validFrom: r.valid_from as BusinessDate, validUntil: r.valid_until as BusinessDate | null }));
}

/** The owners concerned by a source (§58B): each Party owning on its date, until its continuous ownership ends. */
export const ownersOn = (ownerships: readonly OwnershipSpan[], date: BusinessDate) => continuousOwners(ownerships, date);

export interface AcquisitionInput {
  readonly acquisition: Parameters<typeof checkAnschaffungsnahe>[0]['acquisition'];
  readonly costs: Parameters<typeof checkAnschaffungsnahe>[0]['costs'];
  readonly allocation: Parameters<typeof checkAnschaffungsnahe>[0]['allocation'];
}

/** The Acquisitions of a PropertyReference (or one), with their `ACTIVE` costs and current land/building allocation. */
export async function acquisitionsOf(
  trx: Transaction<Database>,
  mreRealmId: string,
  filter: { readonly propertyReferenceId: string } | { readonly acquisitionId: string },
): Promise<AcquisitionInput[]> {
  let query = trx
    .selectFrom('acquisition')
    .select([
      'id',
      'property_reference_id',
      'status',
      sql<string>`purchase_price::text`.as('purchase_price'),
      'currency',
      'acquired_share_numerator',
      'acquired_share_denominator',
      sql<string>`to_char(coalesce(economic_transfer_date, contract_date), 'YYYY-MM-DD')`.as('transfer_date'),
    ])
    .where('mre_realm_id', '=', mreRealmId);
  query =
    'propertyReferenceId' in filter ? query.where('property_reference_id', '=', filter.propertyReferenceId) : query.where('id', '=', filter.acquisitionId);
  const rows = await query.orderBy('id').execute();
  const found: AcquisitionInput[] = [];
  for (const r of rows) {
    const costs = await trx
      .selectFrom('acquisition_cost')
      .select(['category', 'currency', sql<string>`amount::text`.as('amount')])
      .where('acquisition_id', '=', r.id)
      .where('status', '=', 'ACTIVE')
      .execute();
    const allocation = await trx
      .selectFrom('land_building_allocation')
      .select(['id', 'review_state', 'currency', sql<string>`total_allocable_amount::text`.as('total'), sql<string>`building_amount::text`.as('building')])
      .where('acquisition_id', '=', r.id)
      .where('superseded_at', 'is', null)
      .executeTakeFirst();
    found.push({
      acquisition: {
        id: r.id,
        propertyReferenceId: r.property_reference_id,
        status: r.status,
        transferDate: r.transfer_date as BusinessDate,
        acquiredShare: { numerator: r.acquired_share_numerator, denominator: r.acquired_share_denominator },
        purchasePrice: fromNumericAmount(r.purchase_price, r.currency),
      },
      costs: costs.map((c) => ({ category: c.category, amount: fromNumericAmount(c.amount, c.currency) })),
      allocation:
        allocation === undefined
          ? null
          : {
              id: allocation.id,
              reviewState: allocation.review_state,
              totalAllocableAmount: fromNumericAmount(allocation.total, allocation.currency),
              buildingAmount: fromNumericAmount(allocation.building, allocation.currency),
            },
    });
  }
  return found;
}

/**
 * The dates the checks of these Acquisitions read sources for: each window and the 90-day strip after it (the
 * owner's request on VC-7-03); `undefined` without an applicable rule.
 */
export function checkRange(
  inputs: readonly AcquisitionInput[],
  registry: RuleRegistry,
): { readonly from: BusinessDate; readonly to: BusinessDate } | undefined {
  let range: { from: BusinessDate; to: BusinessDate } | undefined;
  for (const { acquisition } of inputs) {
    const rule = anschaffungsnaheRuleOn(registry, acquisition.transferDate);
    if (rule === undefined) continue;
    const window = anschaffungsnaheWindow(acquisition.transferDate, rule.parameters.windowYears);
    const to = addDays(window.until, BOOKING_DATE_EDGE_DAYS);
    range = range === undefined ? { from: window.from, to } : { from: window.from < range.from ? window.from : range.from, to: to > range.to ? to : range.to };
  }
  return range;
}

/** A WEG meaning as a source of the check (§58B). */
export function wegCheckSource(meaning: WegTaxMeaning, classification: TaxClassification | null): CheckSource {
  return {
    sourceType: meaning.sourceType,
    sourceId: meaning.sourceId,
    sourcePosition: meaning.sourcePosition,
    date: meaning.date,
    taxYear: meaning.taxYear,
    taxCategory: meaning.taxCategory,
    treatment: meaning.treatment,
    reviewState: meaning.reviewState,
    origin: meaning.origin,
    classificationId: meaning.classificationId,
    grossAmount: meaning.amount,
    direction: 'OUTFLOW',
    netAmount: meaning.netAmount,
    annuallyRecurring: classification?.annuallyRecurring ?? false,
    anschaffungsnaheAcquisitionId: classification?.anschaffungsnaheAcquisitionId ?? null,
    sourceFlags: meaning.flags.filter((f) => f.code === 'WITHDRAWAL_DATE_ASSUMED'),
  };
}

/** The checks of the Acquisitions, from their sources (already in list order) and the confirmed statements. */
export function checksOf(
  inputs: readonly AcquisitionInput[],
  sources: readonly CheckSource[],
  statements: WegContext['confirmedStatements'],
  today: BusinessDate,
  registry: RuleRegistry,
): AnschaffungsnaheCheck[] {
  return inputs.map((input) => checkAnschaffungsnahe({ ...input, sources, statements, today }, registry));
}

/** A meaning with its § 82b parts (by the owners on its date) and the checks' flags and suggestion. */
export function withEffects<
  M extends {
    readonly flags: readonly unknown[];
    readonly distribution: Distribution | null;
    readonly suggestion: TreatmentSuggestion | null;
    readonly sourceType: string;
    readonly sourceId: string;
    readonly taxYear: number;
  },
>(
  meaning: M,
  source: { readonly sourcePosition: number | null; readonly date: BusinessDate; readonly amount: Money },
  classification: TaxClassification | null,
  ownerships: readonly OwnershipSpan[],
  checks: readonly AnschaffungsnaheCheck[],
): M {
  const distribution = distributionOf(classification, source.amount, meaning.taxYear, ownersOn(ownerships, source.date));
  const check = checkFlagsOf(
    checks.filter((c) => c.acquisitionStatus !== 'CANCELLED'),
    { sourceType: meaning.sourceType as CheckSource['sourceType'], sourceId: meaning.sourceId, sourcePosition: source.sourcePosition },
  );
  return withTreatmentEffects(meaning, distribution, check);
}
