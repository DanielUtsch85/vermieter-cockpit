import { randomUUID } from 'node:crypto';
import { sql, type Kysely, type Transaction } from 'kysely';
import { loanSchedule } from '../../domains/financing/index.js';
import type { CategoryType, Direction, TransactionStatus } from '../../domains/ledger/index.js';
import type { RentDueDay } from '../../domains/rental-contract-reference/index.js';
import { retainedAmountOf, type DepositClosingReason } from '../../domains/security-deposit/index.js';
import {
  TAX_RULES,
  TIMING_SOURCES,
  attributeTaxYear,
  depositNotCounted,
  deriveDepositTaxMeaning,
  deriveTaxMeaning,
  hausgeldTiming,
  interestTiming,
  needsTiming,
  planClassification,
  planDepositClassification,
  planReview,
  rentTiming,
  widestWindowDays,
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
  type TimingInput,
  type Treatment,
} from '../../domains/taxation/index.js';
import { Money, checkVersion, type AuditActor, type BusinessDate } from '../../shared/index.js';
import { writeAudit } from './audit.js';
import { claimIdempotencyKey, recordIdempotentResult } from './idempotency.js';
import { readLoanIn } from './loan-repository.js';
import { periodsOf } from './loan-terms-repository.js';
import { fromNumericAmount, toNumericAmount } from './money-column.js';
import type { Database } from './schema.js';

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
  'tax_category',
  'treatment',
  'review_state',
  'rule_code',
  'rule_version',
  'advisor_party_id',
  'notes',
  'source_references',
  'tax_year',
  'refund_of_year',
  sql<string | null>`to_char(deposit_closing_date, 'YYYY-MM-DD')`.as('deposit_closing_date'),
  sql<string | null>`deposit_retained_amount::text`.as('deposit_retained_amount'),
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
  tax_category: string;
  treatment: string | null;
  review_state: string;
  rule_code: string;
  rule_version: number;
  advisor_party_id: string | null;
  notes: string | null;
  source_references: string[];
  tax_year: number | null;
  refund_of_year: number | null;
  deposit_closing_date: string | null;
  deposit_retained_amount: string | null;
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

class Rejected extends Error {
  constructor(readonly outcome: CreateClassificationOutcome) {
    super(outcome.kind);
  }
}

/**
 * PostgreSQL implementation of the TaxClassification port (api-design.md §55–§58A). A create writes its source first
 * (the split's Transaction, or the deposit; a no-op), then locks the current classification of the source (P7-D9);
 * §57's steps lock the classification row only. Nothing here writes a split, a Transaction or a deposit (ADR-006).
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
            classification.sourceType === 'DEPOSIT_CLOSING' ? await this.planDeposit(trx, classification) : await this.planSplit(trx, classification);
          const { current, rule } = target;
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
          await trx
            .insertInto('tax_classification')
            .values({
              id,
              mre_realm_id: realm,
              source_type: classification.sourceType,
              transaction_split_id: classification.sourceType === 'TRANSACTION_SPLIT' ? classification.sourceId : null,
              security_deposit_id: classification.sourceType === 'DEPOSIT_CLOSING' ? classification.sourceId : null,
              deposit_closing_date: target.depositClosing?.closingDate ?? null,
              deposit_retained_amount: target.depositClosing === undefined ? null : toNumericAmount(target.depositClosing.retainedAmount),
              tax_category: classification.taxCategory,
              treatment: classification.treatment,
              review_state: classification.reviewState,
              rule_code: rule.ruleCode,
              rule_version: rule.version,
              advisor_party_id: null,
              notes: classification.notes,
              source_references: [...classification.sourceReferences],
              tax_year: classification.sourceType === 'TRANSACTION_SPLIT' ? (classification.taxYear ?? null) : null,
              refund_of_year: classification.sourceType === 'TRANSACTION_SPLIT' ? (classification.refundOfYear ?? null) : null,
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

  /** Transaction → classification (§57, P7-D9): the split's Transaction written first, as a no-op; §56's and §58A's checks. */
  private async planSplit(trx: Transaction<Database>, classification: NewTaxClassification) {
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
    const plan = planClassification(read.facts, current?.id ?? null, classification, this.registry, derived);
    if (plan.kind !== 'CLASSIFY') throw new Rejected(plan);
    return { current, rule: plan.rule, depositClosing: undefined };
  }

  /** Deposit → classification (§58A, P7-D9): the deposit written first, as a no-op; then §58A's checks. */
  private async planDeposit(trx: Transaction<Database>, classification: NewTaxClassification) {
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
    return { current, rule: plan.rule, depositClosing: { closingDate: plan.closingDate, retainedAmount: (facts as DepositFacts).retainedAmount } };
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

  async listHistory(sourceType: SourceType, sourceId: string, mreRealmId: string): Promise<readonly TaxClassification[] | undefined> {
    if ((sourceType !== 'TRANSACTION_SPLIT' && sourceType !== 'DEPOSIT_CLOSING') || !UUID.test(sourceId)) return undefined;
    const split = sourceType === 'TRANSACTION_SPLIT';
    return this.db
      .transaction()
      .setIsolationLevel('repeatable read')
      .setAccessMode('read only')
      .execute(async (trx) => {
        const source = await trx
          .selectFrom(split ? 'transaction_split' : 'security_deposit')
          .select('id')
          .where('id', '=', sourceId)
          .where('mre_realm_id', '=', mreRealmId)
          .executeTakeFirst();
        if (source === undefined) return undefined;
        const rows = await trx
          .selectFrom('tax_classification')
          .select(COLUMNS)
          .where(split ? 'transaction_split_id' : 'security_deposit_id', '=', sourceId)
          .where('mre_realm_id', '=', mreRealmId)
          .orderBy('created_at')
          .orderBy('id')
          .execute();
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
        return (await this.meaningsOf(trx, mreRealmId, [toRead(row)], today))[0];
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

  async listTaxMeanings(
    propertyReferenceId: string,
    mreRealmId: string,
    year: number,
    filter: TaxMeaningFilter,
    page: TaxPageRequest,
    today: BusinessDate,
  ): Promise<TaxPage<TaxListItem> | undefined> {
    if (!UUID.test(propertyReferenceId)) return undefined;
    return this.db
      .transaction()
      .setIsolationLevel('repeatable read')
      .setAccessMode('read only')
      .execute(async (trx) => {
        const reference = await trx
          .selectFrom('property_reference')
          .select('id')
          .where('id', '=', propertyReferenceId)
          .where('mre_realm_id', '=', mreRealmId)
          .executeTakeFirst();
        if (reference === undefined) return undefined;
        // §58A: every split that can count in `year`: booked in it or in the windows around it, or overridden to it.
        const days = widestWindowDays(this.registry);
        const from = days > 0 ? `${year - 1}-12-${String(32 - days).padStart(2, '0')}` : `${year}-01-01`;
        const to = days > 0 ? `${year + 1}-01-${String(days).padStart(2, '0')}` : `${year}-12-31`;
        const rows = await factsQuery(trx, mreRealmId)
          .where('s.property_reference_id', '=', propertyReferenceId)
          .where((eb) =>
            eb.or([
              eb.and([eb('t.booking_date', '>=', from), eb('t.booking_date', '<=', to)]),
              eb(
                's.id',
                'in',
                eb.selectFrom('tax_classification').select('transaction_split_id').where('superseded_at', 'is', null).where('tax_year', '=', year),
              ),
            ]),
          )
          .where('t.status', 'in', COUNTED)
          .where((eb) => eb.or([eb('t.correction_role', 'is', null), eb('t.correction_role', '<>', 'REVERSAL')]))
          .orderBy('t.booking_date')
          .orderBy('t.id')
          .orderBy('s.position')
          .execute();
        const splits = (await this.meaningsOf(trx, mreRealmId, rows.map(toRead), today)).filter((m) => m.taxYear === year);
        const deposits = await this.depositsOf(trx, mreRealmId, propertyReferenceId, year, today);
        // By date (booking date, closing date); on one date the splits first.
        const dated = (m: TaxListItem) => (m.sourceType === 'TRANSACTION_SPLIT' ? m.bookingDate : (m.closingDate as string));
        const items = [...splits, ...deposits].sort((a, b) => (dated(a) < dated(b) ? -1 : dated(a) > dated(b) ? 1 : 0));
        const filtered = items.filter(
          (m) =>
            (filter.reviewStates === undefined || filter.reviewStates.length === 0 || filter.reviewStates.includes(m.reviewState)) &&
            (filter.origins === undefined || filter.origins.length === 0 || filter.origins.includes(m.origin)) &&
            (filter.taxCategories === undefined || filter.taxCategories.length === 0 || filter.taxCategories.includes(m.taxCategory)),
        );
        const pageItems = filtered.slice((page.page - 1) * page.pageSize, page.page * page.pageSize);
        return { items: pageItems, page: page.page, pageSize: page.pageSize, total: filtered.length };
      });
  }

  async storedRuleReferences(): Promise<readonly RuleRef[]> {
    const rows = await this.db
      .selectFrom('tax_classification')
      .select(['rule_code', 'rule_version'])
      .distinct()
      .orderBy('rule_code')
      .orderBy('rule_version')
      .execute();
    return rows.map((r) => ({ ruleCode: r.rule_code, version: r.rule_version }));
  }

  /** The meanings of the splits, with their current classifications, corrected originals and tax-year inputs. */
  private async meaningsOf(trx: Transaction<Database>, mreRealmId: string, reads: readonly SplitRead[], today: BusinessDate): Promise<TaxMeaning[]> {
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
      return deriveTaxMeaning(r.facts, current.get(r.facts.splitId) ?? null, originals.get(r.facts.transactionId) ?? null, this.registry, today, inputs);
    });
  }

  /** The retained deposits of the PropertyReference closed in `year` (§58A), counting by the deposit. */
  private async depositsOf(
    trx: Transaction<Database>,
    mreRealmId: string,
    propertyReferenceId: string,
    year: number,
    today: BusinessDate,
  ): Promise<DepositTaxMeaning[]> {
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
    ).filter((f) => f.propertyReferenceId === propertyReferenceId && depositNotCounted(f, null) === null);
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
    const ofTenant = units.filter((u) => u.mre_tenant_id === row.mre_tenant_id);
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
        propertyReferenceId: ofTenant.length === 1 ? (ofTenant[0]?.property_reference_id ?? null) : null,
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

function toDomain(row: ClassificationRow): TaxClassification {
  return {
    id: row.id as TaxClassificationId,
    mreRealmId: row.mre_realm_id,
    sourceType: row.source_type as SourceType,
    sourceId: (row.transaction_split_id ?? row.security_deposit_id) as string,
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
    supersedes: row.supersedes_id,
    supersededBy: row.superseded_by,
    supersededAt: row.superseded_at,
    createdAt: row.created_at,
    createdBy: row.created_by,
    version: row.version,
  };
}

/** The created row as JSON for the idempotency store. VC-7-01's snapshots lack the VC-7-02 fields (read as null). */
interface ClassificationSnapshot {
  readonly row: Omit<
    ClassificationRow,
    'created_at' | 'superseded_at' | 'security_deposit_id' | 'tax_year' | 'refund_of_year' | 'deposit_closing_date' | 'deposit_retained_amount'
  > &
    Partial<Pick<ClassificationRow, 'security_deposit_id' | 'tax_year' | 'refund_of_year' | 'deposit_closing_date' | 'deposit_retained_amount'>> & {
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
      tax_category: c.taxCategory,
      treatment: c.treatment,
      review_state: c.reviewState,
      rule_code: c.rule.ruleCode,
      rule_version: c.rule.version,
      advisor_party_id: c.advisorPartyId,
      notes: c.notes,
      source_references: [...c.sourceReferences],
      tax_year: c.taxYear,
      refund_of_year: c.refundOfYear,
      deposit_closing_date: c.depositClosing?.closingDate ?? null,
      deposit_retained_amount: c.depositClosing?.retainedAmount.amount ?? null,
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
    created_at: new Date(row.created_at),
    superseded_at: null,
  });
}
