import { randomUUID } from 'node:crypto';
import { sql, type Kysely, type Transaction } from 'kysely';
import { loanSchedule } from '../../domains/financing/index.js';
import { businessDayOf, type CategoryType, type Direction, type TransactionStatus } from '../../domains/ledger/index.js';
import type { ChangedEntry, RentDueDay } from '../../domains/rental-contract-reference/index.js';
import { retainedAmountOf, type DepositClosingReason } from '../../domains/security-deposit/index.js';
import { TAX_RULES } from '../../domains/tax-rules/index.js';
import {
  TIMING_SOURCES,
  attributeTaxYear,
  depositNotCounted,
  deriveDepositTaxMeaning,
  deriveTaxMeaning,
  hausgeldTiming,
  interestTiming,
  needsTiming,
  partOf,
  planClassification,
  planDepositClassification,
  planReview,
  planWegClassification,
  rentTiming,
  wegNotCounted,
  wegSourceKey,
  widestWindowDays,
  type AcquisitionFacts,
  type AnschaffungsnaheCheck,
  type AttributionInput,
  type CheckSource,
  type CorrectedOriginal,
  type CreateClassificationOutcome,
  type DepositFacts,
  type DepositTaxMeaning,
  type NewTaxClassification,
  type ReviewClassificationOutcome,
  type ReviewStep,
  type RuleRef,
  type RuleRegistry,
  type SourceType,
  type SplitFacts,
  type StoredReviewState,
  type TaxCategory,
  type TaxClassification,
  type TaxClassificationId,
  type TaxClassificationRepository,
  type TaxListItem,
  type TaxMeaning,
  type TaxMeaningFilter,
  type TaxPage,
  type TaxPageRequest,
  type TaxYearInputs,
  type TaxYearRead,
  type TimingInput,
  type Treatment,
  type WegSourceFacts,
  type WegTaxMeaning,
} from '../../domains/taxation/index.js';
import { Money, checkVersion, type AuditActor, type BusinessDate } from '../../shared/index.js';
import { writeAudit } from './audit.js';
import { claimIdempotencyKey, recordIdempotentResult } from './idempotency.js';
import { readLoanIn } from './loan-repository.js';
import { periodsOf } from './loan-terms-repository.js';
import { fromNumericAmount, toNumericAmount } from './money-column.js';
import type { Database } from './schema.js';
import {
  acquisitionsOf,
  baseWegMeaning,
  checkRange,
  checksOf,
  ownershipsOf,
  wegCheckSource,
  wegContextOf,
  withEffects,
  type OwnershipSpan,
  type WegContext,
} from './tax-property-context.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ENTITY_TYPE = 'TaxClassification';
const CREATE_SCOPE = 'tax-classification.create';
const COUNTED = ['CONFIRMED', 'RECONCILED'];
const RENT_CODES = ['RENT_BASE', 'RENT_OPERATING_COST_ADVANCE', 'RENT_OPERATING_COST_SETTLEMENT'];

const COLUMNS = [
  'id',
  'mre_realm_id',
  'source_type',
  'transaction_split_id',
  'security_deposit_id',
  'weg_annual_statement_id',
  'weg_reserve_position',
  sql<string | null>`weg_withdrawal_unit_share::text`.as('weg_withdrawal_unit_share'),
  'weg_special_assessment_id',
  'weg_use_position',
  sql<string | null>`to_char(weg_use_date, 'YYYY-MM-DD')`.as('weg_use_date'),
  sql<string | null>`weg_use_unit_share::text`.as('weg_use_unit_share'),
  'tax_category',
  'treatment',
  'review_state',
  'rule_code',
  'rule_version',
  'treatment_rule_code',
  'treatment_rule_version',
  'advisor_party_id',
  'notes',
  'source_references',
  'tax_year',
  'refund_of_year',
  sql<string | null>`to_char(deposit_closing_date, 'YYYY-MM-DD')`.as('deposit_closing_date'),
  sql<string | null>`deposit_retained_amount::text`.as('deposit_retained_amount'),
  sql<string | null>`net_amount::text`.as('net_amount'),
  'annually_recurring',
  'distribution_years',
  'mostly_residential_confirmed',
  'anschaffungsnahe_acquisition_id',
  'supersedes_id',
  'superseded_by',
  'superseded_at',
  'created_at',
  'created_by',
  'version',
] as const;

interface ClassificationRow {
  id: string;
  mre_realm_id: string;
  source_type: string;
  transaction_split_id: string | null;
  security_deposit_id: string | null;
  weg_annual_statement_id: string | null;
  weg_reserve_position: number | null;
  weg_withdrawal_unit_share: string | null;
  weg_special_assessment_id: string | null;
  weg_use_position: number | null;
  weg_use_date: string | null;
  weg_use_unit_share: string | null;
  tax_category: string;
  treatment: string | null;
  review_state: string;
  rule_code: string;
  rule_version: number;
  treatment_rule_code: string | null;
  treatment_rule_version: number | null;
  advisor_party_id: string | null;
  notes: string | null;
  source_references: string[];
  tax_year: number | null;
  refund_of_year: number | null;
  deposit_closing_date: string | null;
  deposit_retained_amount: string | null;
  net_amount: string | null;
  annually_recurring: boolean;
  distribution_years: number | null;
  mostly_residential_confirmed: boolean | null;
  anschaffungsnahe_acquisition_id: string | null;
  supersedes_id: string | null;
  superseded_by: string | null;
  superseded_at: Date | null;
  created_at: Date;
  created_by: string;
  version: number;
}

interface FactsRow {
  id: string;
  transaction_id: string;
  position: number;
  amount: string;
  currency: string;
  property_reference_id: string | null;
  loan_id: string | null;
  statement_year: number | null;
  code: string;
  category_type: string;
  booking_date: string;
  direction: string;
  status: string;
  correction_role: string | null;
}

/** A split's facts with what its tax year and refund read besides (§58A). */
interface SplitRead {
  readonly facts: SplitFacts;
  readonly loanId: string | null;
  readonly statementYear: number | null;
}

/** What a create writes besides the request: the rules and the source as classified. */
interface Target {
  readonly current: { readonly id: string; readonly version: number } | undefined;
  readonly rule: RuleRef;
  readonly treatmentRule: RuleRef | null;
  readonly depositClosing: { readonly closingDate: BusinessDate; readonly retainedAmount: Money } | undefined;
  readonly reserveWithdrawal: { readonly unitShare: Money } | null;
  readonly assessmentUse: { readonly date: BusinessDate; readonly unitShare: Money } | null;
}

/** What the effects of §58B (the § 82b parts, the anschaffungsnahe check) read around a PropertyReference. */
interface Effects {
  readonly weg: WegContext;
  readonly ownerships: readonly OwnershipSpan[];
  readonly checks: readonly AnschaffungsnaheCheck[];
}

const EMPTY_WEG: WegContext = { facts: [], current: new Map(), twice: new Map(), confirmedStatements: [] };

/** The source table of each source type, its column on the classification and (for a WEG source) the position column. */
const SOURCE_TABLES = {
  TRANSACTION_SPLIT: { table: 'transaction_split', column: 'transaction_split_id', position: null },
  DEPOSIT_CLOSING: { table: 'security_deposit', column: 'security_deposit_id', position: null },
  WEG_RESERVE_WITHDRAWAL: { table: 'weg_annual_statement', column: 'weg_annual_statement_id', position: 'weg_reserve_position' },
  WEG_ASSESSMENT_USE: { table: 'weg_special_assessment', column: 'weg_special_assessment_id', position: 'weg_use_position' },
} as const satisfies Record<SourceType, { table: string; column: string; position: string | null }>;

/** On one date of the per-property list: splits, deposit closings, withdrawals, uses (§58B). */
const RANK: Record<SourceType, number> = { TRANSACTION_SPLIT: 0, DEPOSIT_CLOSING: 1, WEG_RESERVE_WITHDRAWAL: 2, WEG_ASSESSMENT_USE: 3 };
const dateOf = (m: TaxListItem): string =>
  m.sourceType === 'TRANSACTION_SPLIT' ? m.bookingDate : m.sourceType === 'DEPOSIT_CLOSING' ? (m.closingDate as string) : m.date;

class Rejected extends Error {
  constructor(readonly outcome: CreateClassificationOutcome) {
    super(outcome.kind);
  }
}

/**
 * PostgreSQL implementation of the TaxClassification port (api-design.md §55–§58B). A create writes its source first
 * (the split's Transaction, the deposit, the statement or the assessment; a no-op), then locks the current
 * classification of the source (P7-D9); §57's steps lock the classification row only. Nothing here writes a split, a
 * Transaction, a deposit, a statement, an assessment or an Acquisition (ADR-006).
 */
export class PostgresTaxClassificationRepository implements TaxClassificationRepository {
  constructor(
    private readonly db: Kysely<Database>,
    private readonly registry: RuleRegistry = TAX_RULES,
  ) {}

  async createClassification(
    classification: NewTaxClassification,
    actor: AuditActor,
    idempotency?: { readonly key: string; readonly fingerprint: string },
  ): Promise<CreateClassificationOutcome> {
    try {
      return await this.db
        .transaction()
        .setIsolationLevel('read committed')
        .execute(async (trx): Promise<CreateClassificationOutcome> => {
          const realm = classification.mreRealmId;
          const keyed =
            idempotency === undefined
              ? undefined
              : { ref: { mreRealmId: realm, scope: CREATE_SCOPE, key: idempotency.key }, fingerprint: idempotency.fingerprint };
          if (keyed !== undefined) {
            const claim = await claimIdempotencyKey(trx, keyed.ref, keyed.fingerprint);
            if (claim.kind === 'CONFLICT') return { kind: 'IDEMPOTENCY_CONFLICT' };
            if (claim.kind === 'REPLAY') return { kind: 'REPLAYED', classification: fromSnapshot(claim.result) };
          }
          if (!UUID.test(classification.sourceId)) throw new Rejected({ kind: 'SOURCE_NOT_FOUND' });
          const target =
            classification.sourceType === 'DEPOSIT_CLOSING'
              ? await this.planDeposit(trx, classification)
              : classification.sourceType === 'WEG_RESERVE_WITHDRAWAL'
                ? await this.planWithdrawal(trx, classification)
                : classification.sourceType === 'WEG_ASSESSMENT_USE'
                  ? await this.planUse(trx, classification)
                  : await this.planSplit(trx, classification);
          const { current, rule, treatmentRule } = target;
          const id = randomUUID();
          const now = new Date();
          if (current !== undefined) {
            // The partial unique index cannot be deferred: the old row leaves "current" before the new one enters.
            await trx
              .updateTable('tax_classification')
              .set({ superseded_at: now, superseded_by: id, version: current.version + 1 })
              .where('id', '=', current.id)
              .execute();
          }
          const type = classification.sourceType;
          const position = type === 'WEG_RESERVE_WITHDRAWAL' || type === 'WEG_ASSESSMENT_USE' ? (classification.sourcePosition ?? null) : null;
          await trx
            .insertInto('tax_classification')
            .values({
              id,
              mre_realm_id: realm,
              source_type: type,
              transaction_split_id: type === 'TRANSACTION_SPLIT' ? classification.sourceId : null,
              security_deposit_id: type === 'DEPOSIT_CLOSING' ? classification.sourceId : null,
              deposit_closing_date: target.depositClosing?.closingDate ?? null,
              deposit_retained_amount: target.depositClosing === undefined ? null : toNumericAmount(target.depositClosing.retainedAmount),
              weg_annual_statement_id: type === 'WEG_RESERVE_WITHDRAWAL' ? classification.sourceId : null,
              weg_reserve_position: type === 'WEG_RESERVE_WITHDRAWAL' ? position : null,
              weg_withdrawal_unit_share: target.reserveWithdrawal === null ? null : toNumericAmount(target.reserveWithdrawal.unitShare),
              weg_special_assessment_id: type === 'WEG_ASSESSMENT_USE' ? classification.sourceId : null,
              weg_use_position: type === 'WEG_ASSESSMENT_USE' ? position : null,
              weg_use_date: target.assessmentUse?.date ?? null,
              weg_use_unit_share: target.assessmentUse === null ? null : toNumericAmount(target.assessmentUse.unitShare),
              tax_category: classification.taxCategory,
              treatment: classification.treatment,
              review_state: classification.reviewState,
              rule_code: rule.ruleCode,
              rule_version: rule.version,
              treatment_rule_code: treatmentRule?.ruleCode ?? null,
              treatment_rule_version: treatmentRule?.version ?? null,
              advisor_party_id: null,
              notes: classification.notes,
              source_references: [...classification.sourceReferences],
              tax_year: type === 'TRANSACTION_SPLIT' || type === 'WEG_RESERVE_WITHDRAWAL' ? (classification.taxYear ?? null) : null,
              refund_of_year: type === 'TRANSACTION_SPLIT' ? (classification.refundOfYear ?? null) : null,
              net_amount: classification.netAmount === undefined || classification.netAmount === null ? null : toNumericAmount(classification.netAmount),
              annually_recurring: classification.annuallyRecurring ?? false,
              distribution_years: classification.distributionYears ?? null,
              mostly_residential_confirmed: classification.mostlyResidentialConfirmed ?? null,
              anschaffungsnahe_acquisition_id: classification.anschaffungsnaheAcquisitionId ?? null,
              supersedes_id: current?.id ?? null,
              created_by: actor.actorId,
            })
            .execute();
          const created = await readOne(trx, id);
          await writeAudit(trx, { type: ENTITY_TYPE, id }, 'TAX_CLASSIFIED', actor, {
            newVersion: created.version,
            metadata: {
              sourceType: created.sourceType,
              sourceId: created.sourceId,
              taxCategory: created.taxCategory,
              treatment: created.treatment,
              reviewState: created.reviewState,
              rule: created.rule,
              ...(created.taxYear === null ? {} : { taxYear: created.taxYear }),
              ...(created.refundOfYear === null ? {} : { refundOfYear: created.refundOfYear }),
              ...(created.depositClosing === null
                ? {}
                : { closingDate: created.depositClosing.closingDate, retainedAmount: created.depositClosing.retainedAmount.toJSON() }),
              // §58B: the new fields, each only when set (a split's AuditRecord of VC-7-01 stays as it was).
              ...(created.sourcePosition === null ? {} : { sourcePosition: created.sourcePosition }),
              ...(created.netAmount === null ? {} : { netAmount: created.netAmount.toJSON() }),
              ...(created.annuallyRecurring ? { annuallyRecurring: true } : {}),
              ...(created.distributionYears === null ? {} : { distributionYears: created.distributionYears }),
              ...(created.mostlyResidentialConfirmed === null ? {} : { mostlyResidentialConfirmed: created.mostlyResidentialConfirmed }),
              ...(created.anschaffungsnaheAcquisitionId === null ? {} : { anschaffungsnaheAcquisitionId: created.anschaffungsnaheAcquisitionId }),
              ...(created.treatmentRule === null ? {} : { treatmentRule: created.treatmentRule }),
              ...(current === undefined ? {} : { supersedes: current.id }),
            },
          });
          if (current !== undefined) {
            await writeAudit(trx, { type: ENTITY_TYPE, id: current.id }, 'TAX_CLASSIFICATION_SUPERSEDED', actor, {
              previousVersion: current.version,
              newVersion: current.version + 1,
              metadata: { supersededBy: id },
            });
          }
          if (keyed !== undefined) await recordIdempotentResult(trx, keyed.ref, id, toSnapshot(created));
          return { kind: 'CREATED', classification: created };
        });
    } catch (error) {
      if (error instanceof Rejected) return error.outcome;
      throw error;
    }
  }

  /** Transaction → classification (§57, P7-D9): the split's Transaction written first, as a no-op; §56's, §58A's and §58B's checks. */
  private async planSplit(trx: Transaction<Database>, classification: NewTaxClassification): Promise<Target> {
    const realm = classification.mreRealmId;
    const locked = await trx
      .updateTable('ledger_transaction')
      .set((eb) => ({ version: eb.ref('version') }))
      .where('id', '=', (eb) =>
        eb.selectFrom('transaction_split').select('transaction_id').where('id', '=', classification.sourceId).where('mre_realm_id', '=', realm),
      )
      .where('mre_realm_id', '=', realm)
      .returning('id')
      .executeTakeFirst();
    if (locked === undefined) throw new Rejected({ kind: 'SOURCE_NOT_FOUND' });
    // Read after the lock, in new statements: a correction committed meanwhile is seen.
    const read = toRead(await factsQuery(trx, realm).where('s.id', '=', classification.sourceId).executeTakeFirstOrThrow());
    const current = await trx
      .selectFrom('tax_classification')
      .select(['id', 'version'])
      .where('transaction_split_id', '=', classification.sourceId)
      .where('superseded_at', 'is', null)
      .forUpdate()
      .executeTakeFirst();
    const timing = await timingOf(trx, realm, [read], this.registry);
    const derived = attributeTaxYear(read.facts, timing.get(read.facts.splitId), null, this.registry).taxYear;
    const acquisition = await acquisitionFactsOf(trx, realm, classification.anschaffungsnaheAcquisitionId ?? null);
    const plan = planClassification(read.facts, current?.id ?? null, classification, this.registry, derived, acquisition);
    if (plan.kind !== 'CLASSIFY') throw new Rejected(plan);
    return { current, rule: plan.rule, treatmentRule: plan.treatmentRule, depositClosing: undefined, reserveWithdrawal: null, assessmentUse: null };
  }

  /** Deposit → classification (§58A, P7-D9): the deposit written first, as a no-op; then §58A's checks. */
  private async planDeposit(trx: Transaction<Database>, classification: NewTaxClassification): Promise<Target> {
    const realm = classification.mreRealmId;
    const locked = await trx
      .updateTable('security_deposit')
      .set((eb) => ({ version: eb.ref('version') }))
      .where('id', '=', classification.sourceId)
      .where('mre_realm_id', '=', realm)
      .returning('id')
      .executeTakeFirst();
    if (locked === undefined) throw new Rejected({ kind: 'SOURCE_NOT_FOUND' });
    const [facts] = await depositFactsOf(trx, realm, [classification.sourceId]);
    const current = await trx
      .selectFrom('tax_classification')
      .select(['id', 'version'])
      .where('security_deposit_id', '=', classification.sourceId)
      .where('superseded_at', 'is', null)
      .forUpdate()
      .executeTakeFirst();
    const plan = planDepositClassification(facts as DepositFacts, current?.id ?? null, classification, this.registry);
    if (plan.kind !== 'CLASSIFY') throw new Rejected(plan);
    return {
      current,
      rule: plan.rule,
      treatmentRule: null,
      depositClosing: { closingDate: plan.closingDate, retainedAmount: (facts as DepositFacts).retainedAmount },
      reserveWithdrawal: null,
      assessmentUse: null,
    };
  }

  /**
   * Statement → classification (§58B, P7-D9): the statement row written first (a no-op returning what the checks
   * need), then the current classification of the withdrawal `FOR UPDATE`. A confirm superseding the statement writes
   * that row first too, so the two serialise on it.
   */
  private async planWithdrawal(trx: Transaction<Database>, classification: NewTaxClassification): Promise<Target> {
    const realm = classification.mreRealmId;
    const position = classification.sourcePosition ?? null;
    const locked = await trx
      .updateTable('weg_annual_statement')
      .set((eb) => ({ version: eb.ref('version') }))
      .where('id', '=', classification.sourceId)
      .where('mre_realm_id', '=', realm)
      .returning(['id', 'status', 'reserve', 'membership_id'])
      .executeTakeFirst();
    if (locked === undefined || position === null) throw new Rejected({ kind: 'SOURCE_NOT_FOUND' });
    const ctx = await wegContextOf(trx, realm, { membershipId: locked.membership_id }, businessDayOf(new Date()), currentOfWeg);
    const facts = ctx.facts.find((f) => f.sourceType === 'WEG_RESERVE_WITHDRAWAL' && f.sourceId === locked.id && f.sourcePosition === position);
    if (facts === undefined) throw new Rejected({ kind: 'SOURCE_NOT_FOUND' });
    const current = await trx
      .selectFrom('tax_classification')
      .select(['id', 'version'])
      .where('weg_annual_statement_id', '=', locked.id)
      .where('weg_reserve_position', '=', position)
      .where('superseded_at', 'is', null)
      .forUpdate()
      .executeTakeFirst();
    return this.planWeg(trx, classification, facts, current);
  }

  /** Assessment → classification (§58B, P7-D9): the assessment row written first, then the current classification of the use. */
  private async planUse(trx: Transaction<Database>, classification: NewTaxClassification): Promise<Target> {
    const realm = classification.mreRealmId;
    const position = classification.sourcePosition ?? null;
    const locked = await trx
      .updateTable('weg_special_assessment')
      .set((eb) => ({ version: eb.ref('version') }))
      .where('id', '=', classification.sourceId)
      .where('mre_realm_id', '=', realm)
      .returning(['id', 'status', 'uses', 'membership_id'])
      .executeTakeFirst();
    if (locked === undefined || position === null) throw new Rejected({ kind: 'SOURCE_NOT_FOUND' });
    const ctx = await wegContextOf(trx, realm, { membershipId: locked.membership_id }, businessDayOf(new Date()), currentOfWeg);
    const facts = ctx.facts.find((f) => f.sourceType === 'WEG_ASSESSMENT_USE' && f.sourceId === locked.id && f.sourcePosition === position);
    if (facts === undefined) throw new Rejected({ kind: 'SOURCE_NOT_FOUND' });
    const current = await trx
      .selectFrom('tax_classification')
      .select(['id', 'version'])
      .where('weg_special_assessment_id', '=', locked.id)
      .where('weg_use_position', '=', position)
      .where('superseded_at', 'is', null)
      .forUpdate()
      .executeTakeFirst();
    return this.planWeg(trx, classification, facts, current);
  }

  private async planWeg(
    trx: Transaction<Database>,
    classification: NewTaxClassification,
    facts: WegSourceFacts,
    current: { id: string; version: number } | undefined,
  ): Promise<Target> {
    const acquisition = await acquisitionFactsOf(trx, classification.mreRealmId, classification.anschaffungsnaheAcquisitionId ?? null);
    const plan = planWegClassification(facts, current?.id ?? null, classification, this.registry, acquisition);
    if (plan.kind !== 'CLASSIFY') throw new Rejected(plan);
    return {
      current,
      rule: plan.rule,
      treatmentRule: plan.treatmentRule,
      depositClosing: undefined,
      reserveWithdrawal: plan.reserveWithdrawal,
      assessmentUse: plan.assessmentUse,
    };
  }

  async reviewClassification(
    id: string,
    mreRealmId: string,
    step: ReviewStep,
    actor: AuditActor,
    expectedVersions?: readonly number[],
  ): Promise<ReviewClassificationOutcome> {
    if (!UUID.test(id)) return { kind: 'NOT_FOUND' };
    return this.db
      .transaction()
      .setIsolationLevel('read committed')
      .execute(async (trx): Promise<ReviewClassificationOutcome> => {
        // §57: the classification row only.
        const row = await trx
          .selectFrom('tax_classification')
          .select(COLUMNS)
          .where('id', '=', id)
          .where('mre_realm_id', '=', mreRealmId)
          .forUpdate()
          .executeTakeFirst();
        if (row === undefined) return { kind: 'NOT_FOUND' };
        const current = toDomain(row);
        const plan = planReview(current, step, await sourceStateOf(trx, current), this.registry);
        if ('kind' in plan) return plan;
        if (step.kind === 'ADVISOR_CONFIRM' && step.advisorPartyId !== null) {
          const party = await trx
            .selectFrom('party')
            .select('id')
            .where('id', '=', step.advisorPartyId)
            .where('mre_realm_id', '=', mreRealmId)
            .executeTakeFirst();
          if (party === undefined) return { kind: 'PARTY_NOT_FOUND', partyId: step.advisorPartyId };
        }
        if (!plan.changed) return { kind: 'REVIEWED', classification: current, changed: false };
        const conflict = checkVersion(current.version, expectedVersions);
        if (conflict !== undefined) return conflict;
        await trx
          .updateTable('tax_classification')
          .set({ review_state: plan.reviewState, advisor_party_id: plan.advisorPartyId, version: current.version + 1 })
          .where('id', '=', id)
          .execute();
        const changed = await readOne(trx, id);
        await writeAudit(trx, { type: ENTITY_TYPE, id }, ACTIONS[step.kind], actor, {
          previousVersion: current.version,
          newVersion: changed.version,
          metadata: {
            from: current.reviewState,
            to: changed.reviewState,
            ...(step.kind === 'ADVISOR_CONFIRM' ? { advisorPartyId: step.advisorPartyId, note: step.note } : {}),
            ...(step.kind === 'MARK_NEEDS_REVIEW' ? { reason: step.reason } : {}),
          },
        });
        return { kind: 'REVIEWED', classification: changed, changed: true };
      });
  }

  async findClassification(id: string, mreRealmId: string): Promise<TaxClassification | undefined> {
    if (!UUID.test(id)) return undefined;
    const row = await this.db.selectFrom('tax_classification').select(COLUMNS).where('id', '=', id).where('mre_realm_id', '=', mreRealmId).executeTakeFirst();
    return row === undefined ? undefined : toDomain(row);
  }

  async listHistory(
    sourceType: SourceType,
    sourceId: string,
    mreRealmId: string,
    sourcePosition: number | null = null,
  ): Promise<readonly TaxClassification[] | undefined> {
    if (!UUID.test(sourceId)) return undefined;
    const table = SOURCE_TABLES[sourceType];
    return this.db
      .transaction()
      .setIsolationLevel('repeatable read')
      .setAccessMode('read only')
      .execute(async (trx) => {
        const source = await trx.selectFrom(table.table).select('id').where('id', '=', sourceId).where('mre_realm_id', '=', mreRealmId).executeTakeFirst();
        if (source === undefined) return undefined;
        let query = trx.selectFrom('tax_classification').select(COLUMNS).where(table.column, '=', sourceId).where('mre_realm_id', '=', mreRealmId);
        // A WEG source by its position: the history of a dropped use stays readable (§58B).
        if (table.position !== null) query = query.where(table.position, '=', sourcePosition ?? -1);
        const rows = await query.orderBy('created_at').orderBy('id').execute();
        return rows.map(toDomain);
      });
  }

  async findTaxMeaning(splitId: string, mreRealmId: string, today: BusinessDate): Promise<TaxMeaning | undefined> {
    if (!UUID.test(splitId)) return undefined;
    return this.db
      .transaction()
      .setIsolationLevel('repeatable read')
      .setAccessMode('read only')
      .execute(async (trx) => {
        const row = await factsQuery(trx, mreRealmId).where('s.id', '=', splitId).executeTakeFirst();
        if (row === undefined) return undefined;
        const [pair] = await this.meaningsOf(trx, mreRealmId, [toRead(row)], today);
        if (pair === undefined) return undefined;
        const effects = await this.effectsOf(trx, mreRealmId, pair.meaning.propertyReferenceId, today);
        return this.splitWithEffects(pair, effects);
      });
  }

  async findDepositTaxMeaning(depositId: string, mreRealmId: string, today: BusinessDate): Promise<DepositTaxMeaning | undefined> {
    if (!UUID.test(depositId)) return undefined;
    return this.db
      .transaction()
      .setIsolationLevel('repeatable read')
      .setAccessMode('read only')
      .execute(async (trx) => {
        const [facts] = await depositFactsOf(trx, mreRealmId, [depositId]);
        if (facts === undefined) return undefined;
        const current = await currentOfDeposits(trx, [depositId]);
        return deriveDepositTaxMeaning(facts, current.get(depositId) ?? null, this.registry, today);
      });
  }

  findWithdrawalTaxMeaning(statementId: string, position: number, mreRealmId: string, today: BusinessDate): Promise<WegTaxMeaning | undefined> {
    return this.wegMeaning('weg_annual_statement', 'WEG_RESERVE_WITHDRAWAL', statementId, position, mreRealmId, today);
  }

  findUseTaxMeaning(assessmentId: string, position: number, mreRealmId: string, today: BusinessDate): Promise<WegTaxMeaning | undefined> {
    return this.wegMeaning('weg_special_assessment', 'WEG_ASSESSMENT_USE', assessmentId, position, mreRealmId, today);
  }

  /** One `REPEATABLE READ READ ONLY` snapshot (§58B): the source of the Realm, with its parts and the check's flags. */
  private async wegMeaning(
    table: 'weg_annual_statement' | 'weg_special_assessment',
    sourceType: 'WEG_RESERVE_WITHDRAWAL' | 'WEG_ASSESSMENT_USE',
    sourceId: string,
    position: number,
    mreRealmId: string,
    today: BusinessDate,
  ): Promise<WegTaxMeaning | undefined> {
    if (!UUID.test(sourceId)) return undefined;
    return this.db
      .transaction()
      .setIsolationLevel('repeatable read')
      .setAccessMode('read only')
      .execute(async (trx) => {
        const row = await trx
          .selectFrom(table)
          .innerJoin('weg_membership as m', 'm.id', `${table}.membership_id`)
          .select('m.property_reference_id')
          .where(`${table}.id`, '=', sourceId)
          .where(`${table}.mre_realm_id`, '=', mreRealmId)
          .executeTakeFirst();
        if (row === undefined) return undefined;
        const effects = await this.effectsOf(trx, mreRealmId, row.property_reference_id, today);
        const facts = effects.weg.facts.find((f) => f.sourceType === sourceType && f.sourceId === sourceId && f.sourcePosition === position);
        return facts === undefined ? undefined : this.wegWithEffects(facts, effects, today);
      });
  }

  async anschaffungsnaheCheck(acquisitionId: string, mreRealmId: string, today: BusinessDate): Promise<AnschaffungsnaheCheck | undefined> {
    if (!UUID.test(acquisitionId)) return undefined;
    return this.db
      .transaction()
      .setIsolationLevel('repeatable read')
      .setAccessMode('read only')
      .execute(async (trx) => {
        const [input] = await acquisitionsOf(trx, mreRealmId, { acquisitionId });
        if (input === undefined) return undefined;
        const effects = await this.effectsOf(trx, mreRealmId, input.acquisition.propertyReferenceId, today);
        return effects.checks.find((c) => c.acquisitionId === acquisitionId);
      });
  }

  async listTaxMeanings(
    propertyReferenceId: string,
    mreRealmId: string,
    year: number,
    filter: TaxMeaningFilter,
    page: TaxPageRequest,
    today: BusinessDate,
  ): Promise<TaxPage<TaxListItem> | undefined> {
    if (!UUID.test(propertyReferenceId)) return undefined;
    return taxYearSnapshot(this.db, async (trx) => {
      const reference = await trx
        .selectFrom('property_reference')
        .select('id')
        .where('id', '=', propertyReferenceId)
        .where('mre_realm_id', '=', mreRealmId)
        .executeTakeFirst();
      if (reference === undefined) return undefined;
      const { entries } = await this.yearItems(trx, mreRealmId, propertyReferenceId, year, today);
      const filtered = entries
        .filter((e) => e.listed)
        .map((e) => e.item)
        .filter(
          (m) =>
            (filter.reviewStates === undefined || filter.reviewStates.length === 0 || filter.reviewStates.includes(m.reviewState)) &&
            (filter.origins === undefined || filter.origins.length === 0 || filter.origins.includes(m.origin)) &&
            (filter.taxCategories === undefined || filter.taxCategories.length === 0 || filter.taxCategories.includes(m.taxCategory)) &&
            (filter.sourceTypes === undefined || filter.sourceTypes.length === 0 || filter.sourceTypes.includes(m.sourceType)),
        );
      const pageItems = filtered.slice((page.page - 1) * page.pageSize, page.page * page.pageSize);
      return { items: pageItems, page: page.page, pageSize: page.pageSize, total: filtered.length };
    });
  }

  /**
   * The inputs of the tax-year view (§58C), in one `REPEATABLE READ READ ONLY` snapshot: the PropertyReference, the
   * owner's Party, §55's items of `year` (the very derivation of the list) with the earlier § 82b sources beside them,
   * the Realm's deposit closings of `year` without a PropertyReference, the Ownerships with their shares, the
   * anschaffungsnahe checks, and the RentalContractReferences with their AuditRecords for `ATTRIBUTION_INPUT_CHANGED`.
   * No MRE call; nothing is written (the transaction is `READ ONLY`).
   */
  async readTaxYear(
    propertyReferenceId: string,
    mreRealmId: string,
    year: number,
    ownerPartyId: string | null,
    today: BusinessDate,
  ): Promise<TaxYearRead | undefined> {
    if (!UUID.test(propertyReferenceId)) return undefined;
    return taxYearSnapshot(this.db, async (trx): Promise<TaxYearRead | undefined> => {
      const reference = await trx
        .selectFrom('property_reference')
        .select('id')
        .where('id', '=', propertyReferenceId)
        .where('mre_realm_id', '=', mreRealmId)
        .executeTakeFirst();
      if (reference === undefined) return undefined;
      const empty: TaxYearRead = {
        propertyReferenceId,
        ownerPartyFound: false,
        sources: [],
        unattributedDeposits: [],
        ownerships: [],
        checks: [],
        attribution: { references: [], candidates: [] },
        allocatedLoanInterest: [],
      };
      if (ownerPartyId !== null) {
        const party = UUID.test(ownerPartyId)
          ? await trx.selectFrom('party').select('id').where('id', '=', ownerPartyId).where('mre_realm_id', '=', mreRealmId).executeTakeFirst()
          : undefined;
        if (party === undefined) return empty;
      }
      const { entries, effects, deposits } = await this.yearItems(trx, mreRealmId, propertyReferenceId, year, today);
      const ownerships = await trx
        .selectFrom('ownership')
        .select([
          'id',
          'owner_party_id',
          'share_numerator',
          'share_denominator',
          sql<string>`to_char(valid_from, 'YYYY-MM-DD')`.as('valid_from'),
          sql<string | null>`to_char(valid_until, 'YYYY-MM-DD')`.as('valid_until'),
        ])
        .where('mre_realm_id', '=', mreRealmId)
        .where('property_reference_id', '=', propertyReferenceId)
        .where('status', '=', 'VALID')
        .orderBy('id')
        .execute();
      return {
        propertyReferenceId,
        ownerPartyFound: ownerPartyId === null ? null : true,
        sources: entries,
        unattributedDeposits: deposits.filter((d) => d.propertyReferenceId === null),
        ownerships: ownerships.map((o) => ({
          id: o.id,
          partyId: o.owner_party_id,
          share: { numerator: o.share_numerator, denominator: o.share_denominator },
          validFrom: o.valid_from as BusinessDate,
          validUntil: o.valid_until as BusinessDate | null,
        })),
        checks: effects.checks,
        attribution: await attributionInputOf(trx, mreRealmId, propertyReferenceId, year, this.registry),
        allocatedLoanInterest: await this.allocatedLoanInterest(trx, mreRealmId, propertyReferenceId, year, today),
      };
    });
  }

  /**
   * `LOAN_INTEREST_NOT_ATTRIBUTED`'s input (§58C): the counting `LOAN_INTEREST` splits of the Loans with a `VALID`
   * allocation set naming the PropertyReference (whatever the set's period and share: which apply is VC-X-29's),
   * selected as `yearItems` selects (the windows around `year`, or overridden to it) and kept when §58A's derivation,
   * the list's, puts them in `year`.
   */
  private async allocatedLoanInterest(
    trx: Transaction<Database>,
    mreRealmId: string,
    propertyReferenceId: string,
    year: number,
    today: BusinessDate,
  ): Promise<TaxYearRead['allocatedLoanInterest']> {
    const { from, to } = yearWindow(this.registry, year);
    const rows = await countingSplits(factsQuery(trx, mreRealmId))
      .where('c.code', '=', 'LOAN_INTEREST')
      .where((eb) =>
        eb(
          's.loan_id',
          'in',
          eb
            .selectFrom('loan_allocation_set as las')
            .innerJoin('loan_allocation as la', 'la.set_id', 'las.id')
            .select('las.loan_id')
            .where('las.mre_realm_id', '=', mreRealmId)
            .where('las.status', '=', 'VALID')
            .where('la.property_reference_id', '=', propertyReferenceId),
        ),
      )
      .where((eb) => eb.or([eb.and([eb('t.booking_date', '>=', from), eb('t.booking_date', '<=', to)]), eb('s.id', 'in', overriddenTo(trx, year))]))
      .orderBy('t.booking_date')
      .orderBy('t.id')
      .orderBy('s.position')
      .execute();
    const meanings = await this.meaningsOf(trx, mreRealmId, rows.map(toRead), today);
    return rows.flatMap((row, i) => {
      const meaning = meanings[i]?.meaning;
      return meaning === undefined || meaning.taxYear !== year
        ? []
        : [{ splitId: row.id, loanId: row.loan_id as string, direction: meaning.direction, amount: meaning.amount }];
    });
  }

  /**
   * §55's items of `year` in the list's order (§58A, §58B), each with `listed`: false for an earlier § 82b source
   * whose §58B parts have none in `year` (the view's per-owner fold may still give it one, §58C); and the Realm's
   * deposit closings of `year`.
   */
  private async yearItems(
    trx: Transaction<Database>,
    mreRealmId: string,
    propertyReferenceId: string,
    year: number,
    today: BusinessDate,
  ): Promise<{
    readonly entries: { readonly item: TaxListItem; readonly listed: boolean }[];
    readonly effects: Effects;
    readonly deposits: DepositTaxMeaning[];
  }> {
    // §58A: every split that can count in `year`: booked in it or in the windows around it, or overridden to it.
    const { from, to } = yearWindow(this.registry, year);
    const rows = await countingSplits(factsQuery(trx, mreRealmId).where('s.property_reference_id', '=', propertyReferenceId))
      .where((eb) =>
        eb.or([
          eb.and([eb('t.booking_date', '>=', from), eb('t.booking_date', '<=', to)]),
          eb('s.id', 'in', overriddenTo(trx, year)),
          // §58B: an election of an earlier year may have a part in `year` (at most 4 years back, 5 years).
          eb(
            's.id',
            'in',
            eb.selectFrom('tax_classification').select('transaction_split_id').where('superseded_at', 'is', null).where('treatment', '=', 'DISTRIBUTED_82B'),
          ),
        ]),
      )
      .orderBy('t.booking_date')
      .orderBy('t.id')
      .orderBy('s.position')
      .execute();
    const effects = await this.effectsOf(trx, mreRealmId, propertyReferenceId, today);
    const splits = (await this.meaningsOf(trx, mreRealmId, rows.map(toRead), today)).map((pair) => this.splitWithEffects(pair, effects));
    const deposits = await this.closedDepositsOf(trx, mreRealmId, year, today);
    // §58B: the withdrawals of CONFIRMED statements and the uses of assessments not VOID; a superseded statement's
    // withdrawals do not count and are not listed.
    const weg = effects.weg.facts.filter((f) => f.notCounted === null).map((f) => this.wegWithEffects(f, effects, today));
    const entries: { item: TaxListItem; listed: boolean }[] = [];
    for (const m of [...splits, ...weg]) {
      const part = m.distribution === null ? undefined : partOf(m.distribution, year);
      if (m.taxYear === year) entries.push({ item: { ...m, yearAmount: part ?? m.amount }, listed: true });
      else if (m.taxYear < year && m.counts && part !== undefined) entries.push({ item: { ...m, yearAmount: part }, listed: true });
      // §58C: the per-owner fold keeps a NOT_OWNED part in its year where §58B's fold moved it.
      else if (m.taxYear < year && m.counts && m.distribution !== null)
        entries.push({ item: { ...m, yearAmount: Money.zero(m.amount.currency) }, listed: false });
    }
    for (const d of deposits) if (d.propertyReferenceId === propertyReferenceId) entries.push({ item: { ...d, yearAmount: d.amount }, listed: true });
    // By date (booking, closing, withdrawal or use date); on one date splits, deposits, withdrawals, uses; splits in
    // §55's order (Transaction, position), the WEG sources by sourceId and position (§58B).
    const sorted = entries
      .map((entry, index) => ({ entry, index }))
      .sort((a, b) => {
        const [da, db] = [dateOf(a.entry.item), dateOf(b.entry.item)];
        if (da !== db) return da < db ? -1 : 1;
        const [ra, rb] = [RANK[a.entry.item.sourceType], RANK[b.entry.item.sourceType]];
        if (ra !== rb) return ra - rb;
        if (a.entry.item.sourceType === 'WEG_RESERVE_WITHDRAWAL' || a.entry.item.sourceType === 'WEG_ASSESSMENT_USE') {
          const [pa, pb] = [a.entry.item as WegTaxMeaning, b.entry.item as WegTaxMeaning];
          if (pa.sourceId !== pb.sourceId) return pa.sourceId < pb.sourceId ? -1 : 1;
          return pa.sourcePosition - pb.sourcePosition;
        }
        return a.index - b.index;
      })
      .map((x) => x.entry);
    return { entries: sorted, effects, deposits };
  }

  async storedRuleReferences(): Promise<readonly RuleRef[]> {
    // Both references (§58B): the rule of the source's default and the second, `treatmentRule`.
    const rows = await sql<{ rule_code: string; rule_version: number }>`
      SELECT rule_code, rule_version FROM tax_classification
      UNION
      SELECT treatment_rule_code, treatment_rule_version FROM tax_classification WHERE treatment_rule_code IS NOT NULL
      ORDER BY rule_code, rule_version
    `.execute(this.db);
    return rows.rows.map((r) => ({ ruleCode: r.rule_code, version: r.rule_version }));
  }

  /** The meanings of the splits, with their current classifications, corrected originals and tax-year inputs. */
  private async meaningsOf(
    trx: Transaction<Database>,
    mreRealmId: string,
    reads: readonly SplitRead[],
    today: BusinessDate,
  ): Promise<{ readonly meaning: TaxMeaning; readonly classification: TaxClassification | null }[]> {
    const facts = reads.map((r) => r.facts);
    const current = await currentOf(
      trx,
      facts.map((f) => f.splitId),
    );
    const originals = await correctedOriginalsOf(trx, facts);
    const timing = await timingOf(trx, mreRealmId, reads, this.registry);
    return reads.map((r) => {
      const known = timing.get(r.facts.splitId);
      const inputs: TaxYearInputs = { statementYear: r.statementYear, ...(known === undefined ? {} : { timing: known }) };
      const classification = current.get(r.facts.splitId) ?? null;
      return {
        meaning: deriveTaxMeaning(r.facts, classification, originals.get(r.facts.transactionId) ?? null, this.registry, today, inputs),
        classification,
      };
    });
  }

  /**
   * What the effects of §58B read around a PropertyReference: its WEG sources, Ownerships, and the anschaffungsnahe
   * checks of its Acquisitions with the counting splits and WEG sources of their windows (and the strip after them).
   */
  private async effectsOf(trx: Transaction<Database>, mreRealmId: string, propertyReferenceId: string | null, today: BusinessDate): Promise<Effects> {
    if (propertyReferenceId === null) return { weg: EMPTY_WEG, ownerships: [], checks: [] };
    const weg = await wegContextOf(trx, mreRealmId, { propertyReferenceId }, today, currentOfWeg);
    const ownerships = await ownershipsOf(trx, mreRealmId, propertyReferenceId);
    const inputs = await acquisitionsOf(trx, mreRealmId, { propertyReferenceId });
    const range = checkRange(inputs, this.registry);
    const sources: { source: CheckSource; date: BusinessDate; rank: number; index: number }[] = [];
    if (range !== undefined) {
      const rows = await countingSplits(factsQuery(trx, mreRealmId).where('s.property_reference_id', '=', propertyReferenceId))
        .where('t.booking_date', '>=', range.from)
        .where('t.booking_date', '<=', range.to)
        .orderBy('t.booking_date')
        .orderBy('t.id')
        .orderBy('s.position')
        .execute();
      (await this.meaningsOf(trx, mreRealmId, rows.map(toRead), today)).forEach(({ meaning, classification }, index) =>
        sources.push({ source: splitCheckSource(meaning, classification), date: meaning.bookingDate, rank: 0, index }),
      );
      weg.facts
        .filter((f) => f.notCounted === null && f.date >= range.from && f.date <= range.to)
        .forEach((f, index) => {
          const meaning = baseWegMeaning(weg, f, this.registry, today);
          if (!meaning.counts) return;
          sources.push({
            source: wegCheckSource(meaning, weg.current.get(wegSourceKey(f)) ?? null),
            date: f.date,
            rank: f.sourceType === 'WEG_RESERVE_WITHDRAWAL' ? 2 : 3,
            index,
          });
        });
    }
    // The order of the per-property list.
    sources.sort((a, b) => (a.date !== b.date ? (a.date < b.date ? -1 : 1) : a.rank !== b.rank ? a.rank - b.rank : a.index - b.index));
    return {
      weg,
      ownerships,
      checks: checksOf(
        inputs,
        sources.map((s) => s.source),
        weg.confirmedStatements,
        today,
        this.registry,
      ),
    };
  }

  private splitWithEffects(pair: { readonly meaning: TaxMeaning; readonly classification: TaxClassification | null }, effects: Effects): TaxMeaning {
    const { meaning, classification } = pair;
    return withEffects(
      meaning,
      { sourcePosition: null, date: meaning.bookingDate, amount: meaning.amount },
      classification,
      effects.ownerships,
      effects.checks,
    );
  }

  private wegWithEffects(facts: WegSourceFacts, effects: Effects, today: BusinessDate): WegTaxMeaning {
    const meaning = baseWegMeaning(effects.weg, facts, this.registry, today);
    const classification = effects.weg.current.get(wegSourceKey(facts)) ?? null;
    return withEffects(
      meaning,
      { sourcePosition: facts.sourcePosition, date: facts.date, amount: facts.amount },
      classification,
      effects.ownerships,
      effects.checks,
    );
  }

  /** The deposit closings of the Realm closed in `year` that count by the deposit (§58A), with their meanings. */
  private async closedDepositsOf(trx: Transaction<Database>, mreRealmId: string, year: number, today: BusinessDate): Promise<DepositTaxMeaning[]> {
    const closed = await trx
      .selectFrom('security_deposit')
      .select('id')
      .where('mre_realm_id', '=', mreRealmId)
      .where('status', '=', 'CLOSED')
      .where('closing_date', '>=', `${year}-01-01`)
      .where('closing_date', '<=', `${year}-12-31`)
      .orderBy('closing_date')
      .orderBy('id')
      .execute();
    const facts = (
      await depositFactsOf(
        trx,
        mreRealmId,
        closed.map((d) => d.id),
      )
    ).filter((f) => depositNotCounted(f, null) === null);
    const current = await currentOfDeposits(
      trx,
      facts.map((f) => f.securityDepositId),
    );
    return facts.map((f) => deriveDepositTaxMeaning(f, current.get(f.securityDepositId) ?? null, this.registry, today));
  }
}

const ACTIONS: Record<ReviewStep['kind'], string> = {
  CONFIRM: 'TAX_CLASSIFICATION_CONFIRMED',
  ADVISOR_CONFIRM: 'TAX_CLASSIFICATION_ADVISOR_CONFIRMED',
  MARK_NEEDS_REVIEW: 'TAX_CLASSIFICATION_MARKED_NEEDS_REVIEW',
};

/** The state of a classification's source for §57's checks, read without a lock. */
async function sourceStateOf(trx: Transaction<Database>, current: TaxClassification): Promise<Parameters<typeof planReview>[2]> {
  if (current.sourceType === 'DEPOSIT_CLOSING') {
    const [facts] = await depositFactsOf(trx, current.mreRealmId, [current.sourceId]);
    return { deposit: depositNotCounted(facts as DepositFacts, current) };
  }
  if (current.sourceType === 'WEG_RESERVE_WITHDRAWAL' || current.sourceType === 'WEG_ASSESSMENT_USE') {
    const table = current.sourceType === 'WEG_RESERVE_WITHDRAWAL' ? 'weg_annual_statement' : 'weg_special_assessment';
    const row = await trx.selectFrom(table).select('membership_id').where('id', '=', current.sourceId).executeTakeFirstOrThrow();
    const ctx = await wegContextOf(trx, current.mreRealmId, { membershipId: row.membership_id }, businessDayOf(new Date()), currentOfWeg);
    const facts = ctx.facts.find((f) => f.sourceType === current.sourceType && f.sourceId === current.sourceId && f.sourcePosition === current.sourcePosition);
    // A use dropped by `PUT …/uses` no longer counts (§58B).
    const notCounted =
      facts === undefined ? { reason: 'USE_REMOVED' as const, details: { position: current.sourcePosition ?? 0 } } : wegNotCounted(facts, current);
    return { weg: notCounted === null ? null : { kind: 'WEG_SOURCE_NOT_COUNTED', sourceType: current.sourceType, ...notCounted } };
  }
  const source = await trx
    .selectFrom('transaction_split as s')
    .innerJoin('ledger_transaction as t', 't.id', 's.transaction_id')
    .select(['t.status', 't.correction_role'])
    .where('s.id', '=', current.sourceId)
    .executeTakeFirstOrThrow();
  return { transactionStatus: source.status as TransactionStatus, correctionRole: source.correction_role as SplitFacts['correctionRole'] };
}

/**
 * A split of the Realm with its category, its Transaction, its Loan and its WEG statement's year, the booking date as
 * `YYYY-MM-DD` and Money as text.
 */
function factsQuery(trx: Transaction<Database>, mreRealmId: string) {
  return trx
    .selectFrom('transaction_split as s')
    .innerJoin('ledger_transaction as t', 't.id', 's.transaction_id')
    .innerJoin('financial_category as c', 'c.id', 's.financial_category_id')
    .leftJoin('weg_annual_statement as st', 'st.id', 's.weg_annual_statement_id')
    .select([
      's.id',
      's.transaction_id',
      's.position',
      sql<string>`s.amount::text`.as('amount'),
      's.currency',
      's.property_reference_id',
      's.loan_id',
      'st.financial_year as statement_year',
      'c.code',
      'c.category_type',
      sql<string>`to_char(t.booking_date, 'YYYY-MM-DD')`.as('booking_date'),
      't.direction',
      't.status',
      't.correction_role',
    ])
    .where('s.mre_realm_id', '=', mreRealmId);
}

/**
 * The snapshot of every tax read (§55, §58C): one `REPEATABLE READ READ ONLY` transaction, so a write inside it is
 * refused (`25006`) and nothing committed meanwhile is seen.
 */
export function taxYearSnapshot<T>(db: Kysely<Database>, work: (trx: Transaction<Database>) => Promise<T>): Promise<T> {
  return db.transaction().setIsolationLevel('repeatable read').setAccessMode('read only').execute(work);
}

/** The rent splits whose year `rentDueDays` decides (§58A's table): base rent and advances. */
const ATTRIBUTED_RENT_CODES = ['RENT_BASE', 'RENT_OPERATING_COST_ADVANCE'];

/**
 * What `ATTRIBUTION_INPUT_CHANGED` reads (§58C): the counting rent splits of the PropertyReference booked in either
 * window at an edge of `year` with one `CONFIRMED` reconciliation term, their classifications' `taxYear`, the Realm's
 * RentalContractReferences of their Tenants and those references' `CREATED` and `AMENDED` AuditRecords (by
 * `audit_record_entity_idx`). The references are read in the Realm, so another Realm's AuditRecord is never read.
 */
async function attributionInputOf(
  trx: Transaction<Database>,
  mreRealmId: string,
  propertyReferenceId: string,
  year: number,
  registry: RuleRegistry,
): Promise<AttributionInput> {
  const days = widestWindowDays(registry);
  if (days === 0) return { references: [], candidates: [] };
  const windows = [year - 1, year].map((y) => ({ from: `${y}-12-${String(32 - days).padStart(2, '0')}`, to: `${y + 1}-01-${String(days).padStart(2, '0')}` }));
  const rows = await countingSplits(factsQuery(trx, mreRealmId).where('s.property_reference_id', '=', propertyReferenceId))
    .where('c.code', 'in', ATTRIBUTED_RENT_CODES)
    .where((eb) => eb.or(windows.map((w) => eb.and([eb('t.booking_date', '>=', w.from), eb('t.booking_date', '<=', w.to)]))))
    .orderBy('t.booking_date')
    .orderBy('t.id')
    .orderBy('s.position')
    .execute();
  if (rows.length === 0) return { references: [], candidates: [] };
  const reconciliations = await trx
    .selectFrom('rent_payment_reconciliation')
    .select(['transaction_id', 'mre_tenant_id', 'mre_rent_term'])
    .where('transaction_id', 'in', [...new Set(rows.map((r) => r.transaction_id))])
    .where('mre_realm_id', '=', mreRealmId)
    .where('status', '=', 'CONFIRMED')
    .execute();
  const overrides = await currentOf(
    trx,
    rows.map((r) => r.id),
  );
  const candidates: AttributionInput['candidates'][number][] = rows.flatMap((r) => {
    const terms = new Map(
      reconciliations.filter((c) => c.transaction_id === r.transaction_id).map((c) => [`${c.mre_tenant_id}/${c.mre_rent_term}`, c] as const),
    );
    // Without one term the rent has no economic period under any list (§58A): rentDueDays decides nothing.
    const [only] = terms.values();
    if (only === undefined || terms.size > 1) return [];
    return [
      {
        sourceId: r.id,
        bookingDate: r.booking_date as BusinessDate,
        financialCategoryCode: r.code,
        mreTenantId: only.mre_tenant_id,
        mreRentTerm: only.mre_rent_term,
        taxYearOverride: overrides.get(r.id)?.taxYear ?? null,
      },
    ];
  });
  const tenants = [...new Set(candidates.map((c) => c.mreTenantId))];
  if (tenants.length === 0) return { references: [], candidates: [] };
  const references = await trx
    .selectFrom('rental_contract_reference')
    .select(['id', 'mre_tenant_id', 'rent_due_days'])
    .where('mre_realm_id', '=', mreRealmId)
    .where('mre_tenant_id', 'in', tenants)
    .orderBy('id')
    .execute();
  const records =
    references.length === 0
      ? []
      : await trx
          .selectFrom('audit_record')
          .select(['id', 'entity_id', 'action', 'new_version', 'occurred_at', 'metadata'])
          .where('entity_type', '=', 'RentalContractReference')
          .where(
            'entity_id',
            'in',
            references.map((r) => r.id),
          )
          .where('action', 'in', ['CREATED', 'AMENDED'])
          .orderBy('new_version')
          .orderBy('id')
          .execute();
  return {
    candidates,
    references: references.map((r) => {
      const own = records.filter((a) => a.entity_id === r.id);
      const created = own.find((a) => a.action === 'CREATED');
      const createdDays = (created?.metadata as { rentDueDays?: RentDueDay[] } | null)?.rentDueDays;
      return {
        rentalContractReferenceId: r.id,
        mreTenantId: r.mre_tenant_id,
        rentDueDays: r.rent_due_days as RentDueDay[],
        created: createdDays ?? null,
        amendments: own
          .filter((a) => a.action === 'AMENDED')
          .map((a) => ({
            auditRecordId: a.id,
            newVersion: a.new_version ?? 0,
            amendedAt: a.occurred_at,
            changedEntries: (a.metadata as { changedEntries?: ChangedEntry[] } | null)?.changedEntries ?? [],
          }))
          // An amendment of notes or sourceReferences alone has no changedEntries (§58C).
          .filter((a) => a.changedEntries.length > 0),
      };
    }),
  };
}

/** The booking dates of the splits that can count in `year` (§58A): the year with the widest window around it. */
function yearWindow(registry: RuleRegistry, year: number): { readonly from: string; readonly to: string } {
  const days = widestWindowDays(registry);
  return {
    from: days > 0 ? `${year - 1}-12-${String(32 - days).padStart(2, '0')}` : `${year}-01-01`,
    to: days > 0 ? `${year + 1}-01-${String(days).padStart(2, '0')}` : `${year}-12-31`,
  };
}

/** The splits whose current classification overrides their tax year to `year` (§58A). */
const overriddenTo = (trx: Transaction<Database>, year: number) =>
  trx.selectFrom('tax_classification').select('transaction_split_id').where('superseded_at', 'is', null).where('tax_year', '=', year);

/** Only the splits that count: a current Transaction, not a reversal (§55). */
const countingSplits = (query: ReturnType<typeof factsQuery>) =>
  query.where('t.status', 'in', COUNTED).where((eb) => eb.or([eb('t.correction_role', 'is', null), eb('t.correction_role', '<>', 'REVERSAL')]));

/** A split meaning as a source of the anschaffungsnahe check (§58B). */
function splitCheckSource(meaning: TaxMeaning, classification: TaxClassification | null): CheckSource {
  return {
    sourceType: 'TRANSACTION_SPLIT',
    sourceId: meaning.splitId,
    sourcePosition: null,
    date: meaning.bookingDate,
    taxYear: meaning.taxYear,
    taxCategory: meaning.taxCategory,
    treatment: meaning.treatment,
    reviewState: meaning.reviewState,
    origin: meaning.origin,
    classificationId: meaning.classificationId,
    grossAmount: meaning.amount,
    direction: meaning.direction,
    netAmount: meaning.netAmount,
    annuallyRecurring: classification?.annuallyRecurring ?? false,
    anschaffungsnaheAcquisitionId: classification?.anschaffungsnaheAcquisitionId ?? null,
    sourceFlags: [],
  };
}

/** The Acquisition a capitalisation names, of the Realm, read without a lock (§58B: a confirmed one is final); `null`: unknown. */
async function acquisitionFactsOf(trx: Transaction<Database>, mreRealmId: string, id: string | null): Promise<AcquisitionFacts | null | undefined> {
  if (id === null) return undefined;
  if (!UUID.test(id)) return null;
  const row = await trx
    .selectFrom('acquisition')
    .select(['id', 'property_reference_id', 'status', sql<string>`to_char(coalesce(economic_transfer_date, contract_date), 'YYYY-MM-DD')`.as('transfer_date')])
    .where('id', '=', id)
    .where('mre_realm_id', '=', mreRealmId)
    .executeTakeFirst();
  return row === undefined
    ? null
    : { id: row.id, propertyReferenceId: row.property_reference_id, status: row.status, transferDate: row.transfer_date as BusinessDate };
}

/** The current classification of each WEG source, by `sourceType/sourceId/position`. */
async function currentOfWeg(trx: Transaction<Database>, facts: readonly WegSourceFacts[]): Promise<Map<string, TaxClassification>> {
  const statements = [...new Set(facts.filter((f) => f.sourceType === 'WEG_RESERVE_WITHDRAWAL').map((f) => f.sourceId))];
  const assessments = [...new Set(facts.filter((f) => f.sourceType === 'WEG_ASSESSMENT_USE').map((f) => f.sourceId))];
  if (statements.length === 0 && assessments.length === 0) return new Map();
  const rows = await trx
    .selectFrom('tax_classification')
    .select(COLUMNS)
    .where('superseded_at', 'is', null)
    .where((eb) =>
      eb.or([
        ...(statements.length === 0 ? [] : [eb('weg_annual_statement_id', 'in', statements)]),
        ...(assessments.length === 0 ? [] : [eb('weg_special_assessment_id', 'in', assessments)]),
      ]),
    )
    .execute();
  return new Map(rows.map((r) => toDomain(r)).map((c) => [wegSourceKey(c), c]));
}

function toRead(row: FactsRow): SplitRead {
  return {
    facts: {
      splitId: row.id,
      transactionId: row.transaction_id,
      position: row.position,
      bookingDate: row.booking_date as BusinessDate,
      direction: row.direction as Direction,
      amount: fromNumericAmount(row.amount, row.currency),
      financialCategoryCode: row.code,
      categoryType: row.category_type as CategoryType,
      propertyReferenceId: row.property_reference_id,
      transactionStatus: row.status as TransactionStatus,
      correctionRole: row.correction_role as SplitFacts['correctionRole'],
    },
    loanId: row.loan_id,
    statementYear: row.statement_year,
  };
}

/**
 * The economic period and due date of each split the 10-day rule could move (`needsTiming`, §58A's table): rent by
 * its Transaction's `CONFIRMED` reconciliation and the Tenant's RentalContractReference, Hausgeld by the plan of the
 * unit's membership on the booking date, interest by the Loan's schedule. Other splits are not read.
 */
async function timingOf(
  trx: Transaction<Database>,
  mreRealmId: string,
  reads: readonly SplitRead[],
  registry: RuleRegistry,
): Promise<Map<string, TimingInput>> {
  const found = new Map<string, TimingInput>();
  const needed = reads.filter((r) => needsTiming(registry, r.facts));
  if (needed.length === 0) return found;
  const bySource = (source: string) => needed.filter((r) => TIMING_SOURCES[r.facts.financialCategoryCode] === source);

  const rent = bySource('RENT');
  if (rent.length > 0) {
    const reconciliations = await trx
      .selectFrom('rent_payment_reconciliation')
      .select(['transaction_id', 'mre_tenant_id', 'mre_rent_term'])
      .where('transaction_id', 'in', [...new Set(rent.map((r) => r.facts.transactionId))])
      .where('mre_realm_id', '=', mreRealmId)
      .where('status', '=', 'CONFIRMED')
      .execute();
    const tenants = [...new Set(reconciliations.map((r) => r.mre_tenant_id))];
    const references =
      tenants.length === 0
        ? []
        : await trx
            .selectFrom('rental_contract_reference')
            .select(['mre_tenant_id', 'rent_due_days'])
            .where('mre_realm_id', '=', mreRealmId)
            .where('mre_tenant_id', 'in', tenants)
            .execute();
    const dueDays = new Map(references.map((r) => [r.mre_tenant_id, r.rent_due_days as RentDueDay[]]));
    for (const r of rent) {
      const terms = new Map(
        reconciliations.filter((c) => c.transaction_id === r.facts.transactionId).map((c) => [`${c.mre_tenant_id}/${c.mre_rent_term}`, c] as const),
      );
      const [only] = terms.values();
      if (only === undefined) found.set(r.facts.splitId, { kind: 'NO_ECONOMIC_PERIOD', reason: 'NO_RECONCILIATION' });
      else if (terms.size > 1) found.set(r.facts.splitId, { kind: 'NO_ECONOMIC_PERIOD', reason: 'SEVERAL_TERMS' });
      else found.set(r.facts.splitId, rentTiming(only.mre_rent_term, dueDays.get(only.mre_tenant_id) ?? null));
    }
  }

  for (const r of bySource('HAUSGELD')) {
    const unit = r.facts.propertyReferenceId;
    const plan =
      unit === null
        ? undefined
        : await trx
            .selectFrom('weg_membership as m')
            .innerJoin('weg_economic_plan as p', 'p.membership_id', 'm.id')
            .select('p.advance_due_day')
            .where('m.property_reference_id', '=', unit)
            .where('m.mre_realm_id', '=', mreRealmId)
            .where('m.status', '=', 'ACTIVE')
            .where('m.valid_from', '<=', r.facts.bookingDate)
            .where((eb) => eb.or([eb('m.valid_until', 'is', null), eb('m.valid_until', '>=', r.facts.bookingDate)]))
            .where('p.status', '=', 'ACTIVE')
            .where('p.effective_from', '<=', r.facts.bookingDate)
            .orderBy('p.effective_from', 'desc')
            .limit(1)
            .executeTakeFirst();
    found.set(
      r.facts.splitId,
      plan === undefined ? { kind: 'NO_ECONOMIC_PERIOD', reason: 'NO_ECONOMIC_PLAN' } : hausgeldTiming(r.facts.bookingDate, plan.advance_due_day),
    );
  }

  for (const r of bySource('LOAN_SCHEDULE')) {
    const loan = r.loanId === null ? undefined : await readLoanIn(trx, r.loanId, mreRealmId);
    if (loan === undefined) {
      found.set(r.facts.splitId, { kind: 'NO_ECONOMIC_PERIOD', reason: 'NO_LOAN' });
      continue;
    }
    const periods = (await periodsOf(trx, loan.id)).filter((t) => t.status === 'VALID');
    const schedule = loanSchedule(loan, periods);
    found.set(
      r.facts.splitId,
      interestTiming(
        r.facts.bookingDate,
        schedule.entries.map((e) => e.paymentDate),
      ),
    );
  }
  return found;
}

/** Deposits of the Realm as tax reads them, in the order of `ids`; unknown ids are left out. */
async function depositFactsOf(trx: Transaction<Database>, mreRealmId: string, ids: readonly string[]): Promise<DepositFacts[]> {
  if (ids.length === 0) return [];
  const rows = await trx
    .selectFrom('security_deposit')
    .select([
      'id',
      'status',
      'mre_tenant_id',
      'currency',
      'closing_reason',
      'closing_note',
      sql<string | null>`to_char(closing_date, 'YYYY-MM-DD')`.as('closing_date'),
      sql<string | null>`held_at_closing::text`.as('held_at_closing'),
    ])
    .where('id', 'in', [...ids])
    .where('mre_realm_id', '=', mreRealmId)
    .execute();
  const tenants = [...new Set(rows.map((r) => r.mre_tenant_id))];
  // The deposit's PropertyReference: the one its Tenant's confirmed rent is booked on (§58A); none, or several, is null.
  const units =
    tenants.length === 0
      ? []
      : await trx
          .selectFrom('rent_payment_reconciliation as r')
          .innerJoin('transaction_split as s', 's.transaction_id', 'r.transaction_id')
          .innerJoin('financial_category as c', 'c.id', 's.financial_category_id')
          .select(['r.mre_tenant_id', 's.property_reference_id'])
          .distinct()
          .where('r.mre_realm_id', '=', mreRealmId)
          .where('r.mre_tenant_id', 'in', tenants)
          .where('r.status', '=', 'CONFIRMED')
          .where('c.code', 'in', RENT_CODES)
          .where('s.property_reference_id', 'is not', null)
          .execute();
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids.flatMap((id) => {
    const row = byId.get(id);
    if (row === undefined) return [];
    const ofTenant = [...new Set(units.filter((u) => u.mre_tenant_id === row.mre_tenant_id).map((u) => u.property_reference_id as string))].sort();
    const retainedAmount =
      row.closing_reason === null || row.closing_date === null || row.held_at_closing === null
        ? Money.zero(row.currency)
        : retainedAmountOf({
            closingDate: row.closing_date as BusinessDate,
            reason: row.closing_reason as DepositClosingReason,
            closingNote: row.closing_note,
            heldAtClosing: fromNumericAmount(row.held_at_closing, row.currency),
          });
    return [
      {
        securityDepositId: row.id,
        status: row.status,
        closingDate: row.closing_date as BusinessDate | null,
        retainedAmount,
        propertyReferenceId: ofTenant.length === 1 ? (ofTenant[0] ?? null) : null,
        propertyCandidates: ofTenant,
      },
    ];
  });
}

/** The current classification of each split. */
async function currentOf(trx: Transaction<Database>, splitIds: readonly string[]): Promise<Map<string, TaxClassification>> {
  if (splitIds.length === 0) return new Map();
  const rows = await trx
    .selectFrom('tax_classification')
    .select(COLUMNS)
    .where('transaction_split_id', 'in', [...splitIds])
    .where('superseded_at', 'is', null)
    .execute();
  return new Map(rows.map((r) => [r.transaction_split_id as string, toDomain(r)]));
}

/** The current classification of each deposit. */
async function currentOfDeposits(trx: Transaction<Database>, depositIds: readonly string[]): Promise<Map<string, TaxClassification>> {
  if (depositIds.length === 0) return new Map();
  const rows = await trx
    .selectFrom('tax_classification')
    .select(COLUMNS)
    .where('security_deposit_id', 'in', [...depositIds])
    .where('superseded_at', 'is', null)
    .execute();
  return new Map(rows.map((r) => [r.security_deposit_id as string, toDomain(r)]));
}

/** For each replacement among the splits' Transactions: its original and the current classifications of its splits (P7-D2). */
async function correctedOriginalsOf(trx: Transaction<Database>, facts: readonly SplitFacts[]): Promise<Map<string, CorrectedOriginal>> {
  const replacements = [...new Set(facts.filter((f) => f.correctionRole === 'REPLACEMENT').map((f) => f.transactionId))];
  if (replacements.length === 0) return new Map();
  const rows = await trx
    .selectFrom('ledger_transaction as r')
    .innerJoin('transaction_split as os', 'os.transaction_id', 'r.correction_of_transaction_id')
    .innerJoin('tax_classification as c', (join) => join.onRef('c.transaction_split_id', '=', 'os.id').on('c.superseded_at', 'is', null))
    .select(['r.id as replacement_id', 'r.correction_of_transaction_id as original_id', 'c.id as classification_id'])
    .where('r.id', 'in', replacements)
    .execute();
  const found = new Map<string, CorrectedOriginal>();
  for (const r of rows) {
    const seen = found.get(r.replacement_id);
    found.set(r.replacement_id, {
      originalTransactionId: r.original_id as string,
      classificationIds: [...(seen?.classificationIds ?? []), r.classification_id],
    });
  }
  return found;
}

async function readOne(trx: Transaction<Database>, id: string): Promise<TaxClassification> {
  return toDomain(await trx.selectFrom('tax_classification').select(COLUMNS).where('id', '=', id).executeTakeFirstOrThrow());
}

const eurOrNull = (amount: string | null) => (amount === null ? null : fromNumericAmount(amount, 'EUR'));

function toDomain(row: ClassificationRow): TaxClassification {
  return {
    id: row.id as TaxClassificationId,
    mreRealmId: row.mre_realm_id,
    sourceType: row.source_type as SourceType,
    sourceId: (row.transaction_split_id ?? row.security_deposit_id ?? row.weg_annual_statement_id ?? row.weg_special_assessment_id) as string,
    taxCategory: row.tax_category as TaxCategory,
    treatment: row.treatment as Treatment | null,
    reviewState: row.review_state as StoredReviewState,
    rule: { ruleCode: row.rule_code, version: row.rule_version },
    advisorPartyId: row.advisor_party_id,
    notes: row.notes,
    sourceReferences: row.source_references,
    taxYear: row.tax_year,
    refundOfYear: row.refund_of_year,
    depositClosing:
      row.deposit_closing_date === null || row.deposit_retained_amount === null
        ? null
        : { closingDate: row.deposit_closing_date as BusinessDate, retainedAmount: fromNumericAmount(row.deposit_retained_amount, 'EUR') },
    sourcePosition: row.weg_reserve_position ?? row.weg_use_position,
    reserveWithdrawal: row.weg_withdrawal_unit_share === null ? null : { unitShare: fromNumericAmount(row.weg_withdrawal_unit_share, 'EUR') },
    assessmentUse:
      row.weg_use_date === null || row.weg_use_unit_share === null
        ? null
        : { date: row.weg_use_date as BusinessDate, unitShare: fromNumericAmount(row.weg_use_unit_share, 'EUR') },
    netAmount: eurOrNull(row.net_amount),
    annuallyRecurring: row.annually_recurring,
    distributionYears: row.distribution_years,
    mostlyResidentialConfirmed: row.mostly_residential_confirmed,
    anschaffungsnaheAcquisitionId: row.anschaffungsnahe_acquisition_id,
    treatmentRule:
      row.treatment_rule_code === null || row.treatment_rule_version === null
        ? null
        : { ruleCode: row.treatment_rule_code, version: row.treatment_rule_version },
    supersedes: row.supersedes_id,
    supersededBy: row.superseded_by,
    supersededAt: row.superseded_at,
    createdAt: row.created_at,
    createdBy: row.created_by,
    version: row.version,
  };
}

/** The columns a snapshot of an earlier item may lack: read as null (or false). */
type LaterColumns =
  | 'security_deposit_id'
  | 'tax_year'
  | 'refund_of_year'
  | 'deposit_closing_date'
  | 'deposit_retained_amount'
  | 'weg_annual_statement_id'
  | 'weg_reserve_position'
  | 'weg_withdrawal_unit_share'
  | 'weg_special_assessment_id'
  | 'weg_use_position'
  | 'weg_use_date'
  | 'weg_use_unit_share'
  | 'net_amount'
  | 'annually_recurring'
  | 'distribution_years'
  | 'mostly_residential_confirmed'
  | 'anschaffungsnahe_acquisition_id'
  | 'treatment_rule_code'
  | 'treatment_rule_version';

/** The created row as JSON for the idempotency store. Snapshots of VC-7-01/-02 lack the later fields (read as null). */
interface ClassificationSnapshot {
  readonly row: Omit<ClassificationRow, 'created_at' | 'superseded_at' | LaterColumns> &
    Partial<Pick<ClassificationRow, LaterColumns>> & {
      readonly created_at: string;
    };
}

function toSnapshot(c: TaxClassification): ClassificationSnapshot {
  return {
    row: {
      id: c.id,
      mre_realm_id: c.mreRealmId,
      source_type: c.sourceType,
      transaction_split_id: c.sourceType === 'TRANSACTION_SPLIT' ? c.sourceId : null,
      security_deposit_id: c.sourceType === 'DEPOSIT_CLOSING' ? c.sourceId : null,
      weg_annual_statement_id: c.sourceType === 'WEG_RESERVE_WITHDRAWAL' ? c.sourceId : null,
      weg_reserve_position: c.sourceType === 'WEG_RESERVE_WITHDRAWAL' ? c.sourcePosition : null,
      weg_withdrawal_unit_share: c.reserveWithdrawal?.unitShare.amount ?? null,
      weg_special_assessment_id: c.sourceType === 'WEG_ASSESSMENT_USE' ? c.sourceId : null,
      weg_use_position: c.sourceType === 'WEG_ASSESSMENT_USE' ? c.sourcePosition : null,
      weg_use_date: c.assessmentUse?.date ?? null,
      weg_use_unit_share: c.assessmentUse?.unitShare.amount ?? null,
      tax_category: c.taxCategory,
      treatment: c.treatment,
      review_state: c.reviewState,
      rule_code: c.rule.ruleCode,
      rule_version: c.rule.version,
      treatment_rule_code: c.treatmentRule?.ruleCode ?? null,
      treatment_rule_version: c.treatmentRule?.version ?? null,
      advisor_party_id: c.advisorPartyId,
      notes: c.notes,
      source_references: [...c.sourceReferences],
      tax_year: c.taxYear,
      refund_of_year: c.refundOfYear,
      deposit_closing_date: c.depositClosing?.closingDate ?? null,
      deposit_retained_amount: c.depositClosing?.retainedAmount.amount ?? null,
      net_amount: c.netAmount?.amount ?? null,
      annually_recurring: c.annuallyRecurring,
      distribution_years: c.distributionYears,
      mostly_residential_confirmed: c.mostlyResidentialConfirmed,
      anschaffungsnahe_acquisition_id: c.anschaffungsnaheAcquisitionId,
      supersedes_id: c.supersedes,
      superseded_by: c.supersededBy,
      created_at: c.createdAt.toISOString(),
      created_by: c.createdBy,
      version: c.version,
    },
  };
}

/** Written by toSnapshot in the same codebase, so its shape is trusted; a created classification is current. */
function fromSnapshot(result: unknown): TaxClassification {
  const { row } = result as ClassificationSnapshot;
  return toDomain({
    ...row,
    security_deposit_id: row.security_deposit_id ?? null,
    tax_year: row.tax_year ?? null,
    refund_of_year: row.refund_of_year ?? null,
    deposit_closing_date: row.deposit_closing_date ?? null,
    deposit_retained_amount: row.deposit_retained_amount ?? null,
    weg_annual_statement_id: row.weg_annual_statement_id ?? null,
    weg_reserve_position: row.weg_reserve_position ?? null,
    weg_withdrawal_unit_share: row.weg_withdrawal_unit_share ?? null,
    weg_special_assessment_id: row.weg_special_assessment_id ?? null,
    weg_use_position: row.weg_use_position ?? null,
    weg_use_date: row.weg_use_date ?? null,
    weg_use_unit_share: row.weg_use_unit_share ?? null,
    net_amount: row.net_amount ?? null,
    annually_recurring: row.annually_recurring ?? false,
    distribution_years: row.distribution_years ?? null,
    mostly_residential_confirmed: row.mostly_residential_confirmed ?? null,
    anschaffungsnahe_acquisition_id: row.anschaffungsnahe_acquisition_id ?? null,
    treatment_rule_code: row.treatment_rule_code ?? null,
    treatment_rule_version: row.treatment_rule_version ?? null,
    created_at: new Date(row.created_at),
    superseded_at: null,
  });
}
