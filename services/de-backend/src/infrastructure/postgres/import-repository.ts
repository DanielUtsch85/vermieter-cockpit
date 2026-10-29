import { randomUUID } from 'node:crypto';
import { sql, type Insertable, type Kysely, type Selectable } from 'kysely';
import {
  decideRow,
  keepsExternalId,
  planResolution,
  type AmbiguityReason,
  type BusinessDate,
  type ConflictingTransaction,
  type ContinuityReport,
  type Direction,
  type ResolveOutcome,
  type ReviewItem,
  type ReviewItemId,
  importPostable,
  inFileContinuity,
  isSkippable,
  uniqueBalanceIdentities,
  normalizedRowJson,
  sourceRowKey,
  summarize,
  type FinancialAccountId,
  type ImportBatch,
  type ImportBatchId,
  type ImportBatchStatus,
  type ImportOutcome,
  type ImportRepository,
  type NewImport,
  type ReviewResolution,
  type RowOutcome,
  type TransactionStatus,
} from '../../domains/ledger/index.js';
import { Money, type AuditActor } from '../../shared/index.js';
import { writeAudit } from './audit.js';
import { toFinancialAccount } from './financial-account-repository.js';
import { fromNumericAmount, toNumericAmount } from './money-column.js';
import type { Database, ImportBatchTable, ImportReviewItemTable, LedgerTransactionTable } from './schema.js';
import { prefetch, lookupFor, positionOf, newTransaction, continuityReport } from './import-lookup.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Rows per INSERT statement: keeps bind parameters far below PostgreSQL's 65,535. */
const INSERT_CHUNK = 500;

/**
 * PostgreSQL implementation of the import port.
 *
 * Everything the decisions depend on is read up front with a few set-based
 * queries (a 10,000-row statement must not cost 50,000 round trips); the rows
 * are then decided in file order in memory — a row created earlier in the same
 * file is visible to later rows — and written in chunks. The account row lock
 * serializes imports into the same account, so two uploads of one file cannot
 * both create; the unique indexes of migration 0006 back this up.
 */
export class PostgresImportRepository implements ImportRepository {
  constructor(private readonly db: Kysely<Database>) {}

  async importStatement(input: NewImport, actor: AuditActor): Promise<ImportOutcome> {
    if (!UUID.test(input.financialAccountId)) return { kind: 'ACCOUNT_NOT_FOUND' };
    return this.db
      .transaction()
      .setIsolationLevel('read committed')
      .execute(async (trx) => {
        const accountRow = await trx
          .selectFrom('financial_account')
          .selectAll()
          .where('id', '=', input.financialAccountId)
          .where('mre_realm_id', '=', input.mreRealmId)
          .forUpdate()
          .executeTakeFirst();
        if (accountRow === undefined) return { kind: 'ACCOUNT_NOT_FOUND' };
        const account = toFinancialAccount(accountRow);
        const { statement } = input;
        const batchId = randomUUID();

        await trx
          .insertInto('import_batch')
          .values({
            id: batchId,
            mre_realm_id: input.mreRealmId,
            financial_account_id: account.id,
            adapter_id: statement.adapterId,
            adapter_version: statement.adapterVersion,
            source_filename: input.sourceFilename,
            content_hash: statement.contentHash,
            provenance: input.provenance,
            status: 'COMPLETED',
            transaction_count: 0,
            duplicate_count: 0,
            needs_review_count: 0,
            error_count: 0,
            skipped_count: 0,
            rows: JSON.stringify([]),
            imported_by: actor.actorId,
          })
          .execute();

        const known = await prefetch(trx, input, uniqueBalanceIdentities(statement.rows));
        const continuity = await continuityReport(trx, input, inFileContinuity(statement.rows));
        const transactions: Insertable<LedgerTransactionTable>[] = [];
        const reviewItems: Insertable<ImportReviewItemTable>[] = [];
        const rows: RowOutcome[] = [];

        for (const parsed of statement.rows) {
          if (parsed.kind === 'ERROR') {
            rows.push(
              isSkippable(parsed.errors)
                ? { outcome: 'skipped', position: parsed.position, reason: 'ZERO_AMOUNT' }
                : { outcome: 'error', position: parsed.position, errors: parsed.errors },
            );
            continue;
          }
          if (!importPostable(account, parsed.row.bookingDate)) {
            rows.push({ outcome: 'error', position: parsed.position, errors: [{ field: 'bookingDate', code: 'ACCOUNT_CLOSED' }] });
            continue;
          }

          const key = sourceRowKey(statement, parsed);
          const externalId = parsed.row.externalTransactionId;
          const decision = decideRow(externalId !== null, lookupFor(known, statement, parsed, key));
          switch (decision.kind) {
            case 'CREATE': {
              const id = randomUUID();
              transactions.push(newTransaction(id, batchId, input, parsed, key, account.mreRealmId, actor));
              // Visible to the following rows of the same file.
              if (externalId !== null) known.byExternalId.set(externalId, { id, contentFingerprint: parsed.contentFingerprint });
              else
                positionOf(known, key.rowKey).transactions.push({
                  id,
                  adapterId: statement.adapterId,
                  adapterVersion: statement.adapterVersion,
                });
              rows.push({ outcome: 'created', position: parsed.position, transactionId: id });
              break;
            }
            case 'DUPLICATE_TRANSACTION':
              rows.push({
                outcome: 'duplicate',
                position: parsed.position,
                duplicateOf: 'TRANSACTION',
                transactionId: decision.transactionId,
              });
              break;
            case 'DUPLICATE_RESOLVED_ITEM':
              rows.push({
                outcome: 'duplicate',
                position: parsed.position,
                duplicateOf: 'RESOLVED_REVIEW_ITEM',
                reviewItemId: decision.item.id,
                importBatchId: decision.item.importBatchId,
                resolution: decision.item.resolution as ReviewResolution,
                ...(decision.item.createdTransactionId === null ? {} : { createdTransactionId: decision.item.createdTransactionId }),
              });
              break;
            case 'REFERENCE_PENDING_ITEM':
              rows.push({
                outcome: 'needs_review',
                position: parsed.position,
                reviewItemId: decision.item.id,
                importBatchId: decision.item.importBatchId,
                reason: known.reasons.get(decision.item.id) ?? 'AMBIGUOUS_CROSS_FILE_MATCH',
                conflictingTransactionIds: known.conflicts.get(decision.item.id) ?? [],
              });
              break;
            case 'NEW_REVIEW_ITEM': {
              const id = randomUUID();
              reviewItems.push({
                id,
                import_batch_id: batchId,
                mre_realm_id: account.mreRealmId,
                financial_account_id: account.id,
                adapter_id: statement.adapterId,
                adapter_version: statement.adapterVersion,
                source_statement_key: key.statementKey,
                source_row_key: key.rowKey,
                content_fingerprint: parsed.contentFingerprint,
                normalized_row: JSON.stringify({ ...normalizedRowJson(parsed.row), position: parsed.position, ...key }),
                ambiguity_reason: decision.reason,
                conflicting_transaction_ids: [...decision.conflictingTransactionIds],
                prior_review_item_ids: [...decision.priorReviewItemIds],
                status: 'PENDING',
              });
              positionOf(known, key.rowKey).items.push({
                id,
                importBatchId: batchId,
                status: 'PENDING',
                resolution: null,
                createdTransactionId: null,
                adapterId: statement.adapterId,
                adapterVersion: statement.adapterVersion,
              });
              known.reasons.set(id, decision.reason);
              known.conflicts.set(id, decision.conflictingTransactionIds);
              rows.push({
                outcome: 'needs_review',
                position: parsed.position,
                reviewItemId: id,
                importBatchId: batchId,
                reason: decision.reason,
                conflictingTransactionIds: decision.conflictingTransactionIds,
              });
              break;
            }
          }
        }

        for (const chunk of chunks(transactions)) await trx.insertInto('ledger_transaction').values(chunk).execute();
        for (const chunk of chunks(reviewItems)) await trx.insertInto('import_review_item').values(chunk).execute();

        const summary = summarize(rows, reviewItems.length);
        const stored = await trx
          .updateTable('import_batch')
          .set({
            status: summary.status,
            transaction_count: summary.transactionCount,
            duplicate_count: summary.duplicateCount,
            needs_review_count: summary.needsReviewCount,
            error_count: summary.errorCount,
            skipped_count: summary.skippedCount,
            rows: JSON.stringify(rows),
            continuity: continuity === null ? null : JSON.stringify(continuity),
          })
          .where('id', '=', batchId)
          .returningAll()
          .executeTakeFirstOrThrow();
        await writeAudit(trx, { type: 'ImportBatch', id: batchId }, 'IMPORTED', actor, {
          newVersion: 1,
          metadata: {
            financialAccountId: account.id,
            adapter: `${statement.adapterId}@${statement.adapterVersion}`,
            contentHash: statement.contentHash,
            ...summary,
          },
        });
        return { kind: 'IMPORTED', batch: toDomain(stored) };
      });
  }

  async findBatch(id: string, mreRealmId: string): Promise<ImportBatch | undefined> {
    if (!UUID.test(id)) return undefined;
    const row = await this.db.selectFrom('import_batch').selectAll().where('id', '=', id).where('mre_realm_id', '=', mreRealmId).executeTakeFirst();
    return row === undefined ? undefined : toDomain(row);
  }

  async listReviewItems(importBatchId: string, mreRealmId: string, status?: ReviewItem['status']) {
    if (!UUID.test(importBatchId)) return undefined;
    const batch = await this.db
      .selectFrom('import_batch')
      .select('id')
      .where('id', '=', importBatchId)
      .where('mre_realm_id', '=', mreRealmId)
      .executeTakeFirst();
    if (batch === undefined) return undefined;
    let query = this.db.selectFrom('import_review_item').selectAll().where('import_batch_id', '=', importBatchId).where('mre_realm_id', '=', mreRealmId);
    if (status !== undefined) query = query.where('status', '=', status);
    const items = (
      await query
        .orderBy(sql`(normalized_row->>'position')::int`)
        .orderBy('id')
        .execute()
    ).map(toReviewItem);
    const ids = [...new Set(items.flatMap((i) => [...i.conflictingTransactionIds, ...(i.createdTransactionId === null ? [] : [i.createdTransactionId])]))];
    if (ids.length === 0) return { items, conflicting: [] };
    const rows = await this.db
      .selectFrom('ledger_transaction')
      .select([
        'id',
        sql<string>`to_char(booking_date, 'YYYY-MM-DD')`.as('booking_date'),
        sql<string | null>`to_char(value_date, 'YYYY-MM-DD')`.as('value_date'),
        'amount',
        'currency',
        'direction',
        'description',
        'counterparty_name_raw',
        'counterparty_iban_raw',
        'external_transaction_id',
        'import_batch_id',
      ])
      .where('id', 'in', ids)
      .where('mre_realm_id', '=', mreRealmId)
      .orderBy('booking_date')
      .orderBy('id')
      .execute();
    const conflicting = rows.map(
      (t): ConflictingTransaction => ({
        id: t.id,
        bookingDate: t.booking_date as BusinessDate,
        valueDate: t.value_date as BusinessDate | null,
        amount: fromNumericAmount(t.amount, t.currency),
        direction: t.direction as Direction,
        description: t.description,
        counterpartyNameRaw: t.counterparty_name_raw,
        counterpartyIbanRaw: t.counterparty_iban_raw,
        externalTransactionId: t.external_transaction_id,
        importBatchId: t.import_batch_id,
      }),
    );
    return { items, conflicting };
  }

  async resolveReviewItem(
    importBatchId: string,
    reviewItemId: string,
    mreRealmId: string,
    resolution: ReviewResolution,
    actor: AuditActor,
  ): Promise<ResolveOutcome> {
    if (!UUID.test(importBatchId) || !UUID.test(reviewItemId)) return { kind: 'NOT_FOUND' };
    return this.db
      .transaction()
      .setIsolationLevel('read committed')
      .execute(async (trx): Promise<ResolveOutcome> => {
        // Owned by the path batch, in the Realm: anything else is not found (§32.2 path validation).
        const located = await trx
          .selectFrom('import_review_item')
          .select('financial_account_id')
          .where('id', '=', reviewItemId)
          .where('import_batch_id', '=', importBatchId)
          .where('mre_realm_id', '=', mreRealmId)
          .executeTakeFirst();
        if (located === undefined) return { kind: 'NOT_FOUND' };
        // Same lock order as an import (account first): a resolve and an import into the account serialize.
        const accountRow = await trx
          .selectFrom('financial_account')
          .selectAll()
          .where('id', '=', located.financial_account_id)
          .where('mre_realm_id', '=', mreRealmId)
          .forUpdate()
          .executeTakeFirstOrThrow();
        const row = await trx.selectFrom('import_review_item').selectAll().where('id', '=', reviewItemId).forUpdate().executeTakeFirstOrThrow();
        const item = toReviewItem(row);

        switch (planResolution(item, resolution)) {
          case 'REPLAY':
            return { kind: 'RESOLVED', item, replayed: true };
          case 'CONFLICT':
            return { kind: 'RESOLUTION_CONFLICT', item };
          case 'APPLY':
            break;
        }

        let createdTransactionId: string | null = null;
        if (resolution === 'CREATE') {
          const normalized = storedRow(item);
          if (!importPostable(toFinancialAccount(accountRow), normalized.bookingDate)) return { kind: 'ACCOUNT_CLOSED', item };
          const batch = await trx.selectFrom('import_batch').select('provenance').where('id', '=', item.importBatchId).executeTakeFirstOrThrow();
          const externalId = normalized.externalTransactionId;
          const idTaken =
            externalId !== null &&
            (await trx
              .selectFrom('ledger_transaction')
              .select('id')
              .where('mre_realm_id', '=', mreRealmId)
              .where('financial_account_id', '=', item.financialAccountId)
              .where('external_transaction_id', '=', externalId)
              .executeTakeFirst()) !== undefined;
          createdTransactionId = randomUUID();
          await trx
            .insertInto('ledger_transaction')
            .values({
              id: createdTransactionId,
              mre_realm_id: mreRealmId,
              financial_account_id: item.financialAccountId,
              amount: toNumericAmount(normalized.amount),
              currency: normalized.amount.currency,
              direction: normalized.direction,
              booking_date: normalized.bookingDate,
              value_date: normalized.valueDate,
              description: normalized.description,
              property_reference_id: null,
              provenance: batch.provenance,
              status: 'IMPORTED' satisfies TransactionStatus,
              created_by: actor.actorId,
              import_batch_id: item.importBatchId,
              external_transaction_id: externalId !== null && keepsExternalId(item.ambiguityReason, idTaken) ? externalId : null,
              counterparty_name_raw: normalized.counterpartyNameRaw,
              counterparty_iban_raw: normalized.counterpartyIbanRaw,
              adapter_id: item.adapterId,
              adapter_version: item.adapterVersion,
              source_statement_key: item.sourceStatementKey,
              source_row_key: item.sourceRowKey,
              content_fingerprint: row.content_fingerprint,
              source_balance_after: normalized.balanceAfter ?? null,
              import_review_item_id: item.id,
            })
            .execute();
        }

        const updated = await trx
          .updateTable('import_review_item')
          .set({
            status: 'RESOLVED',
            resolution,
            resolved_by: actor.actorId,
            resolved_at: new Date(),
            created_transaction_id: createdTransactionId,
          })
          .where('id', '=', item.id)
          .returningAll()
          .executeTakeFirstOrThrow();
        // The owning batch counts its own PENDING items only (§20A).
        await trx
          .updateTable('import_batch')
          .set({
            needs_review_count: sql`needs_review_count - 1`,
            status: sql`CASE WHEN needs_review_count > 1 THEN 'NEEDS_REVIEW' ELSE 'COMPLETED' END`,
          })
          .where('id', '=', item.importBatchId)
          .execute();
        await writeAudit(trx, { type: 'ImportReviewItem', id: item.id }, 'RESOLVED', actor, {
          newVersion: 1,
          metadata: {
            importBatchId: item.importBatchId,
            financialAccountId: item.financialAccountId,
            resolution,
            ambiguityReason: item.ambiguityReason,
            conflictingTransactionIds: item.conflictingTransactionIds,
            ...(createdTransactionId === null ? {} : { createdTransactionId }),
          },
        });
        return { kind: 'RESOLVED', item: toReviewItem(updated), replayed: false };
      });
  }
}

/** The normalized row of a review item, as stored by the import (`normalizedRowJson`). */
function storedRow(item: ReviewItem) {
  const row = item.normalizedRow as {
    bookingDate: BusinessDate;
    valueDate: BusinessDate | null;
    amount: { amount: string; currency: string };
    direction: Direction;
    counterpartyNameRaw: string | null;
    counterpartyIbanRaw: string | null;
    description: string | null;
    externalTransactionId: string | null;
    /** Absent on items stored before generic-csv v2 (§70.6). */
    balanceAfter?: string | null;
  };
  return { ...row, amount: Money.of(row.amount.amount, row.amount.currency) };
}

function toReviewItem(row: Selectable<ImportReviewItemTable>): ReviewItem {
  return {
    id: row.id as ReviewItemId,
    importBatchId: row.import_batch_id as ImportBatchId,
    mreRealmId: row.mre_realm_id,
    financialAccountId: row.financial_account_id as FinancialAccountId,
    adapterId: row.adapter_id,
    adapterVersion: row.adapter_version,
    sourceStatementKey: row.source_statement_key,
    sourceRowKey: row.source_row_key,
    normalizedRow: row.normalized_row,
    ambiguityReason: row.ambiguity_reason as AmbiguityReason,
    conflictingTransactionIds: row.conflicting_transaction_ids,
    priorReviewItemIds: row.prior_review_item_ids,
    status: row.status as ReviewItem['status'],
    resolution: row.resolution as ReviewResolution | null,
    resolvedBy: row.resolved_by,
    resolvedAt: row.resolved_at,
    createdTransactionId: row.created_transaction_id,
    createdAt: row.created_at,
  };
}

function* chunks<T>(items: readonly T[]): Generator<T[]> {
  for (let i = 0; i < items.length; i += INSERT_CHUNK) yield items.slice(i, i + INSERT_CHUNK);
}

function toDomain(row: Selectable<ImportBatchTable>): ImportBatch {
  return {
    id: row.id as ImportBatchId,
    mreRealmId: row.mre_realm_id,
    financialAccountId: row.financial_account_id as FinancialAccountId,
    adapterId: row.adapter_id,
    adapterVersion: row.adapter_version,
    sourceFilename: row.source_filename,
    contentHash: row.content_hash,
    status: row.status as ImportBatchStatus,
    transactionCount: row.transaction_count,
    duplicateCount: row.duplicate_count,
    needsReviewCount: row.needs_review_count,
    errorCount: row.error_count,
    skippedCount: row.skipped_count,
    importedAt: row.imported_at,
    importedBy: row.imported_by,
    rows: row.rows as RowOutcome[],
    continuity: row.continuity as ContinuityReport | null,
  };
}
