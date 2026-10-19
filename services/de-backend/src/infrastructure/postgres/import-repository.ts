import { randomUUID } from 'node:crypto';
import type { Insertable, Kysely, Selectable, Transaction as Trx } from 'kysely';
import {
  decideRow,
  type AmbiguityReason,
  importPostable,
  isSkippable,
  normalizedRowJson,
  sourceRowKey,
  summarize,
  type FinancialAccountId,
  type ImportBatch,
  type ImportBatchId,
  type ImportBatchStatus,
  type ImportOutcome,
  type ImportRepository,
  type KnownReviewItem,
  type NewImport,
  type ParsedRow,
  type ReviewResolution,
  type RowLookup,
  type RowOutcome,
  type SourceRowKey,
  type TransactionStatus,
} from '../../domains/ledger/index.js';
import type { AuditActor } from '../../shared/index.js';
import { writeAudit } from './audit.js';
import { toFinancialAccount } from './financial-account-repository.js';
import { toNumericAmount } from './money-column.js';
import type { Database, ImportBatchTable, ImportReviewItemTable, LedgerTransactionTable } from './schema.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Rows per INSERT statement: keeps bind parameters far below PostgreSQL's 65,535. */
const INSERT_CHUNK = 500;

type ParsedDataRow = Extract<ParsedRow, { kind: 'ROW' }>;

interface RecordedAtPosition {
  readonly transactions: { readonly id: string; readonly adapterId: string; readonly adapterVersion: string }[];
  readonly items: (KnownReviewItem & { readonly adapterId: string; readonly adapterVersion: string })[];
}

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

        const known = await prefetch(trx, input);
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
    const row = await this.db
      .selectFrom('import_batch')
      .selectAll()
      .where('id', '=', id)
      .where('mre_realm_id', '=', mreRealmId)
      .executeTakeFirst();
    return row === undefined ? undefined : toDomain(row);
  }
}

interface FingerprintMatch {
  readonly id: string;
  readonly statementKey: string;
  readonly hasExternalId: boolean;
}

interface Known {
  readonly byExternalId: Map<string, { readonly id: string; readonly contentFingerprint: string }>;
  /** Transactions and review items of this statement, by source row key, with their adapter. */
  readonly byPosition: Map<string, RecordedAtPosition>;
  /** Earlier imported Transactions of the account, by content fingerprint. */
  readonly byFingerprint: Map<string, FingerprintMatch[]>;
  readonly reasons: Map<string, AmbiguityReason>;
  readonly conflicts: Map<string, readonly string[]>;
}

async function prefetch(trx: Trx<Database>, input: NewImport): Promise<Known> {
  const { statement } = input;
  const dataRows = statement.rows.filter((r): r is ParsedDataRow => r.kind === 'ROW');
  const statementKey = sourceRowKey(statement, { position: 0, sourceRowId: null }).statementKey;
  const externalIds = [...new Set(dataRows.flatMap((r) => (r.row.externalTransactionId === null ? [] : [r.row.externalTransactionId])))];
  const rowKeys = [...new Set(dataRows.map((r) => sourceRowKey(statement, r).rowKey))];
  const fingerprints = [...new Set(dataRows.map((r) => r.contentFingerprint))];
  const scope = { realm: input.mreRealmId, account: input.financialAccountId };

  const known: Known = {
    byExternalId: new Map(),
    byPosition: new Map(),
    byFingerprint: new Map(),
    reasons: new Map(),
    conflicts: new Map(),
  };

  if (externalIds.length > 0) {
    const byExternal = await trx
      .selectFrom('ledger_transaction')
      .select(['id', 'external_transaction_id', 'content_fingerprint'])
      .where('mre_realm_id', '=', scope.realm)
      .where('financial_account_id', '=', scope.account)
      .where('external_transaction_id', 'in', externalIds)
      .execute();
    for (const t of byExternal) {
      if (t.external_transaction_id === null || t.content_fingerprint === null) continue;
      known.byExternalId.set(t.external_transaction_id, { id: t.id, contentFingerprint: t.content_fingerprint });
    }
  }

  if (rowKeys.length > 0) {
    const atPositions = await trx
      .selectFrom('ledger_transaction')
      .select(['id', 'adapter_id', 'adapter_version', 'source_row_key'])
      .where('mre_realm_id', '=', scope.realm)
      .where('financial_account_id', '=', scope.account)
      .where('source_statement_key', '=', statementKey)
      .where('source_row_key', 'in', rowKeys)
      .where('external_transaction_id', 'is', null)
      .execute();
    for (const t of atPositions) {
      if (t.source_row_key === null || t.adapter_id === null || t.adapter_version === null) continue;
      positionOf(known, t.source_row_key).transactions.push({ id: t.id, adapterId: t.adapter_id, adapterVersion: t.adapter_version });
    }

    const items = await trx
      .selectFrom('import_review_item')
      .select([
        'id',
        'import_batch_id',
        'adapter_id',
        'adapter_version',
        'source_row_key',
        'status',
        'resolution',
        'created_transaction_id',
        'ambiguity_reason',
        'conflicting_transaction_ids',
      ])
      .where('mre_realm_id', '=', scope.realm)
      .where('financial_account_id', '=', scope.account)
      .where('source_statement_key', '=', statementKey)
      .where('source_row_key', 'in', rowKeys)
      .execute();
    for (const item of items) {
      positionOf(known, item.source_row_key).items.push({
        id: item.id,
        importBatchId: item.import_batch_id,
        status: item.status as KnownReviewItem['status'],
        resolution: item.resolution as ReviewResolution | null,
        createdTransactionId: item.created_transaction_id,
        adapterId: item.adapter_id,
        adapterVersion: item.adapter_version,
      });
      known.reasons.set(item.id, item.ambiguity_reason as AmbiguityReason);
      known.conflicts.set(item.id, item.conflicting_transaction_ids);
    }
  }

  if (fingerprints.length > 0) {
    const matches = await trx
      .selectFrom('ledger_transaction')
      .select(['id', 'content_fingerprint', 'source_statement_key', 'external_transaction_id'])
      .where('mre_realm_id', '=', scope.realm)
      .where('financial_account_id', '=', scope.account)
      .where('content_fingerprint', 'in', fingerprints)
      .orderBy('created_at')
      .orderBy('id')
      .execute();
    for (const m of matches) {
      if (m.content_fingerprint === null || m.source_statement_key === null) continue;
      const match = { id: m.id, statementKey: m.source_statement_key, hasExternalId: m.external_transaction_id !== null };
      known.byFingerprint.set(m.content_fingerprint, [...(known.byFingerprint.get(m.content_fingerprint) ?? []), match]);
    }
  }
  return known;
}

function lookupFor(known: Known, statement: NewImport['statement'], parsed: ParsedDataRow, key: SourceRowKey): RowLookup {
  const recorded = known.byPosition.get(key.rowKey) ?? { transactions: [], items: [] };
  const sameAdapter = (r: { adapterId: string; adapterVersion: string }) =>
    r.adapterId === statement.adapterId && r.adapterVersion === statement.adapterVersion;
  const ownItem = recorded.items.find(sameAdapter);
  const sameContent = known.byFingerprint.get(parsed.contentFingerprint) ?? [];

  const externalId = parsed.row.externalTransactionId;
  if (externalId !== null) {
    const byId = known.byExternalId.get(externalId);
    return {
      ...(ownItem === undefined ? {} : { reviewItemByIdentity: ownItem }),
      ...(byId === undefined ? {} : { transactionByExternalId: byId }),
      contentFingerprint: parsed.contentFingerprint,
      // Any statement: the same file may have been imported before without mapping the id column.
      fallbackFingerprintMatches: sameContent.filter((m) => !m.hasExternalId).map((m) => m.id),
      fingerprintMatches: [],
    };
  }
  const ownTransaction = recorded.transactions.find(sameAdapter);
  const otherTransactions = recorded.transactions.filter((t) => !sameAdapter(t));
  const otherItems = recorded.items.filter((i) => !sameAdapter(i));
  return {
    ...(ownTransaction === undefined ? {} : { transactionByIdentity: ownTransaction.id }),
    ...(ownItem === undefined ? {} : { reviewItemByIdentity: ownItem }),
    otherAdapterVersion: {
      // A prior decision's Transaction is part of the conflict too (provenance preserved).
      transactionIds: [
        ...otherTransactions.map((t) => t.id),
        ...otherItems.flatMap((i) => (i.createdTransactionId === null ? [] : [i.createdTransactionId])),
      ],
      reviewItemIds: otherItems.map((i) => i.id),
    },
    // Rows imported via an external id count too: an export without ids may show the same payment.
    fingerprintMatches: sameContent.filter((m) => m.statementKey !== key.statementKey).map((m) => m.id),
  };
}

function positionOf(known: Known, rowKey: string): RecordedAtPosition {
  let recorded = known.byPosition.get(rowKey);
  if (recorded === undefined) {
    recorded = { transactions: [], items: [] };
    known.byPosition.set(rowKey, recorded);
  }
  return recorded;
}

function newTransaction(
  id: string,
  batchId: string,
  input: NewImport,
  parsed: ParsedDataRow,
  key: { statementKey: string; rowKey: string },
  mreRealmId: string,
  actor: AuditActor,
): Insertable<LedgerTransactionTable> {
  const { row } = parsed;
  return {
    id,
    mre_realm_id: mreRealmId,
    financial_account_id: input.financialAccountId,
    amount: toNumericAmount(row.amount),
    currency: row.amount.currency,
    direction: row.direction,
    booking_date: row.bookingDate,
    value_date: row.valueDate,
    description: row.description,
    property_reference_id: null,
    provenance: input.provenance,
    status: 'IMPORTED' satisfies TransactionStatus,
    created_by: actor.actorId,
    import_batch_id: batchId,
    external_transaction_id: row.externalTransactionId,
    counterparty_name_raw: row.counterpartyNameRaw,
    counterparty_iban_raw: row.counterpartyIbanRaw,
    adapter_id: input.statement.adapterId,
    adapter_version: input.statement.adapterVersion,
    source_statement_key: key.statementKey,
    source_row_key: key.rowKey,
    content_fingerprint: parsed.contentFingerprint,
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
  };
}
