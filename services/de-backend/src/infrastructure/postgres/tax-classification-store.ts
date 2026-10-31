import { randomUUID } from 'node:crypto';
import type { Kysely, Transaction } from 'kysely';
import { businessDayOf, type TransactionStatus } from '../../domains/ledger/index.js';
import {
  attributeTaxYear,
  depositNotCounted,
  planClassification,
  planDepositClassification,
  planReview,
  planWegClassification,
  wegNotCounted,
  type CreateClassificationOutcome,
  type DepositFacts,
  type NewTaxClassification,
  type ReviewClassificationOutcome,
  type ReviewStep,
  type RuleRef,
  type RuleRegistry,
  type SourceType,
  type SplitFacts,
  type TaxClassification,
  type WegSourceFacts,
} from '../../domains/taxation/index.js';
import { checkVersion, type AuditActor, type BusinessDate, type Money } from '../../shared/index.js';
import { writeAudit } from './audit.js';
import { claimIdempotencyKey, recordIdempotentResult } from './idempotency.js';
import { toNumericAmount } from './money-column.js';
import type { Database } from './schema.js';
import { wegContextOf } from './tax-property-context.js';
import { UUID, ENTITY_TYPE, COLUMNS, currentOfWeg, readOne, toDomain, toSnapshot, fromSnapshot } from './tax-classification-rows.js';
import { factsQuery, acquisitionFactsOf, toRead, timingOf, depositFactsOf } from './tax-source-facts.js';

/** Classifications (§56–§58B): create (superseding the current one), §57's review steps, one classification and a source's history. */

const CREATE_SCOPE = 'tax-classification.create';

/** What a create writes besides the request: the rules and the source as classified. */
interface Target {
  readonly current: { readonly id: string; readonly version: number } | undefined;
  readonly rule: RuleRef;
  readonly treatmentRule: RuleRef | null;
  readonly depositClosing: { readonly closingDate: BusinessDate; readonly retainedAmount: Money } | undefined;
  readonly reserveWithdrawal: { readonly unitShare: Money } | null;
  readonly assessmentUse: { readonly date: BusinessDate; readonly unitShare: Money } | null;
}

/** The source table of each source type, its column on the classification and (for a WEG source) the position column. */
const SOURCE_TABLES = {
  TRANSACTION_SPLIT: { table: 'transaction_split', column: 'transaction_split_id', position: null },
  DEPOSIT_CLOSING: { table: 'security_deposit', column: 'security_deposit_id', position: null },
  WEG_RESERVE_WITHDRAWAL: { table: 'weg_annual_statement', column: 'weg_annual_statement_id', position: 'weg_reserve_position' },
  WEG_ASSESSMENT_USE: { table: 'weg_special_assessment', column: 'weg_special_assessment_id', position: 'weg_use_position' },
} as const satisfies Record<SourceType, { table: string; column: string; position: string | null }>;

class Rejected extends Error {
  constructor(readonly outcome: CreateClassificationOutcome) {
    super(outcome.kind);
  }
}

export async function createClassification(
  db: Kysely<Database>,
  registry: RuleRegistry,
  classification: NewTaxClassification,
  actor: AuditActor,
  idempotency?: { readonly key: string; readonly fingerprint: string },
): Promise<CreateClassificationOutcome> {
  try {
    return await db
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
            ? await planDeposit(trx, registry, classification)
            : classification.sourceType === 'WEG_RESERVE_WITHDRAWAL'
              ? await planWithdrawal(trx, registry, classification)
              : classification.sourceType === 'WEG_ASSESSMENT_USE'
                ? await planUse(trx, registry, classification)
                : await planSplit(trx, registry, classification);
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
async function planSplit(trx: Transaction<Database>, registry: RuleRegistry, classification: NewTaxClassification): Promise<Target> {
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
  const timing = await timingOf(trx, realm, [read], registry);
  const derived = attributeTaxYear(read.facts, timing.get(read.facts.splitId), null, registry).taxYear;
  const acquisition = await acquisitionFactsOf(trx, realm, classification.anschaffungsnaheAcquisitionId ?? null);
  const plan = planClassification(read.facts, current?.id ?? null, classification, registry, derived, acquisition);
  if (plan.kind !== 'CLASSIFY') throw new Rejected(plan);
  return { current, rule: plan.rule, treatmentRule: plan.treatmentRule, depositClosing: undefined, reserveWithdrawal: null, assessmentUse: null };
}

/** Deposit → classification (§58A, P7-D9): the deposit written first, as a no-op; then §58A's checks. */
async function planDeposit(trx: Transaction<Database>, registry: RuleRegistry, classification: NewTaxClassification): Promise<Target> {
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
  const plan = planDepositClassification(facts as DepositFacts, current?.id ?? null, classification, registry);
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
async function planWithdrawal(trx: Transaction<Database>, registry: RuleRegistry, classification: NewTaxClassification): Promise<Target> {
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
  return planWeg(trx, registry, classification, facts, current);
}

/** Assessment → classification (§58B, P7-D9): the assessment row written first, then the current classification of the use. */
async function planUse(trx: Transaction<Database>, registry: RuleRegistry, classification: NewTaxClassification): Promise<Target> {
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
  return planWeg(trx, registry, classification, facts, current);
}

async function planWeg(
  trx: Transaction<Database>,
  registry: RuleRegistry,
  classification: NewTaxClassification,
  facts: WegSourceFacts,
  current: { id: string; version: number } | undefined,
): Promise<Target> {
  const acquisition = await acquisitionFactsOf(trx, classification.mreRealmId, classification.anschaffungsnaheAcquisitionId ?? null);
  const plan = planWegClassification(facts, current?.id ?? null, classification, registry, acquisition);
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

export async function reviewClassification(
  db: Kysely<Database>,
  registry: RuleRegistry,
  id: string,
  mreRealmId: string,
  step: ReviewStep,
  actor: AuditActor,
  expectedVersions?: readonly number[],
): Promise<ReviewClassificationOutcome> {
  if (!UUID.test(id)) return { kind: 'NOT_FOUND' };
  return db
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
      const plan = planReview(current, step, await sourceStateOf(trx, current), registry);
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

export async function findClassification(db: Kysely<Database>, id: string, mreRealmId: string): Promise<TaxClassification | undefined> {
  if (!UUID.test(id)) return undefined;
  const row = await db.selectFrom('tax_classification').select(COLUMNS).where('id', '=', id).where('mre_realm_id', '=', mreRealmId).executeTakeFirst();
  return row === undefined ? undefined : toDomain(row);
}

export async function listHistory(
  db: Kysely<Database>,
  sourceType: SourceType,
  sourceId: string,
  mreRealmId: string,
  sourcePosition: number | null = null,
): Promise<readonly TaxClassification[] | undefined> {
  if (!UUID.test(sourceId)) return undefined;
  const table = SOURCE_TABLES[sourceType];
  return db
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
