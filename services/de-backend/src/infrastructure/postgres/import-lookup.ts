import { type Insertable, type Transaction as Trx } from 'kysely';
import {
  type AmbiguityReason,
  sourceRowKey,
  type KnownReviewItem,
  type NewImport,
  type ParsedRow,
  type ReviewResolution,
  type RowLookup,
  type SourceRowKey,
  type TransactionStatus,
} from '../../domains/ledger/index.js';
import { type AuditActor } from '../../shared/index.js';
import { toNumericAmount } from './money-column.js';
import type { Database, LedgerTransactionTable } from './schema.js';

/** The look-up of one import run (data-model §70): everything the row decisions depend on, read up front in a few set-based queries, and the Transaction a created row becomes. */

export type ParsedDataRow = Extract<ParsedRow, { kind: 'ROW' }>;

export interface RecordedAtPosition {
  readonly transactions: { readonly id: string; readonly adapterId: string; readonly adapterVersion: string }[];
  readonly items: (KnownReviewItem & { readonly adapterId: string; readonly adapterVersion: string })[];
}

export interface FingerprintMatch {
  readonly id: string;
  readonly statementKey: string;
  readonly hasExternalId: boolean;
}

export interface Known {
  readonly byExternalId: Map<string, { readonly id: string; readonly contentFingerprint: string }>;
  /** Transactions and review items of this statement, by source row key, with their adapter. */
  readonly byPosition: Map<string, RecordedAtPosition>;
  /** Earlier imported Transactions of the account, by content fingerprint. */
  readonly byFingerprint: Map<string, FingerprintMatch[]>;
  readonly reasons: Map<string, AmbiguityReason>;
  readonly conflicts: Map<string, readonly string[]>;
}

export async function prefetch(trx: Trx<Database>, input: NewImport): Promise<Known> {
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

export function lookupFor(known: Known, statement: NewImport['statement'], parsed: ParsedDataRow, key: SourceRowKey): RowLookup {
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
        ...new Set([...otherTransactions.map((t) => t.id), ...otherItems.flatMap((i) => (i.createdTransactionId === null ? [] : [i.createdTransactionId]))]),
      ],
      reviewItemIds: otherItems.map((i) => i.id),
    },
    // Rows imported via an external id count too: an export without ids may show the same payment.
    fingerprintMatches: sameContent.filter((m) => m.statementKey !== key.statementKey).map((m) => m.id),
  };
}

export function positionOf(known: Known, rowKey: string): RecordedAtPosition {
  let recorded = known.byPosition.get(rowKey);
  if (recorded === undefined) {
    recorded = { transactions: [], items: [] };
    known.byPosition.set(rowKey, recorded);
  }
  return recorded;
}

export function newTransaction(
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
