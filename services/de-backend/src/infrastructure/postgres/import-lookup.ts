import { sql, type Insertable, type Transaction as Trx } from 'kysely';
import {
  type AmbiguityReason,
  balanceIdentityKey,
  type BusinessDate,
  type Direction,
  type ContinuityReport,
  type InFileContinuity,
  previousExport,
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
import { fromNumericAmount, toNumericAmount } from './money-column.js';
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
  /** The positions whose balance identity is unique in the file (§70.6); only they use the balance branch. */
  readonly uniqueBalances: ReadonlySet<number>;
  /** Transactions of the account by balance identity (`balanceIdentityKey`), any adapter. */
  readonly byBalance: Map<string, { readonly id: string; readonly contentFingerprint: string }[]>;
}

export async function prefetch(trx: Trx<Database>, input: NewImport, uniqueBalances: ReadonlySet<number>): Promise<Known> {
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
    uniqueBalances,
    byBalance: new Map(),
  };

  const balanced = dataRows.filter((r) => r.row.balanceAfter !== null && uniqueBalances.has(r.position));
  if (balanced.length > 0) {
    const matches = await trx
      .selectFrom('ledger_transaction')
      .select([
        'id',
        sql<string>`to_char(booking_date, 'YYYY-MM-DD')`.as('booking_date'),
        'amount',
        'currency',
        'direction',
        'source_balance_after',
        'content_fingerprint',
      ])
      .where('mre_realm_id', '=', scope.realm)
      .where('financial_account_id', '=', scope.account)
      .where('booking_date', 'in', [...new Set(balanced.map((r) => r.row.bookingDate))])
      .where('source_balance_after', 'in', [...new Set(balanced.map((r) => r.row.balanceAfter ?? ''))])
      .orderBy('created_at')
      .orderBy('id')
      .execute();
    for (const m of matches) {
      if (m.source_balance_after === null || m.content_fingerprint === null) continue;
      const key = balanceIdentityKey({
        bookingDate: m.booking_date as BusinessDate,
        amount: fromNumericAmount(m.amount, m.currency),
        direction: m.direction as Direction,
        balanceAfter: m.source_balance_after,
      });
      known.byBalance.set(key, [...(known.byBalance.get(key) ?? []), { id: m.id, contentFingerprint: m.content_fingerprint }]);
    }
  }

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

  const balanceAfter = parsed.row.balanceAfter;
  const balance =
    balanceAfter !== null && known.uniqueBalances.has(parsed.position)
      ? {
          balanceMatches: known.byBalance.get(balanceIdentityKey({ ...parsed.row, balanceAfter })) ?? [],
          balanceFingerprint: parsed.contentFingerprint,
        }
      : {};

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
    ...balance,
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
    source_balance_after: row.balanceAfter,
  };
}

/**
 * The batch's continuity report (§70.6): the in-file chain, and how the file's oldest row relates to the balances the
 * account already holds. Read before the batch's own Transactions are written.
 */
export async function continuityReport(trx: Trx<Database>, input: NewImport, chain: InFileContinuity | undefined): Promise<ContinuityReport | null> {
  if (chain === undefined) return null;
  const { oldest } = chain;
  const earlier = trx
    .selectFrom('ledger_transaction')
    .select(['id', sql<string>`to_char(booking_date, 'YYYY-MM-DD')`.as('booking_date'), 'amount', 'currency', 'direction', 'source_balance_after'])
    .where('mre_realm_id', '=', input.mreRealmId)
    .where('financial_account_id', '=', input.financialAccountId)
    .where('source_balance_after', 'is not', null)
    .where('booking_date', '<=', oldest.bookingDate);
  const sameDay = await earlier.where('booking_date', '=', oldest.bookingDate).execute();
  const oldestImported = sameDay.some(
    (t) =>
      t.source_balance_after !== null &&
      balanceIdentityKey({
        bookingDate: t.booking_date as BusinessDate,
        amount: fromNumericAmount(t.amount, t.currency),
        direction: t.direction as Direction,
        balanceAfter: t.source_balance_after,
      }) === oldest.identityKey,
  );
  // Only a possible predecessor counts: a balance of the oldest row's day or of the last earlier day with a balance. A
  // balance that merely occurred before (an account run down to 0.00) must not hide a gap (review on #114).
  const lastEarlierDay = await earlier.where('booking_date', '<', oldest.bookingDate).orderBy('booking_date', 'desc').limit(1).executeTakeFirst();
  const predecessorDays = [oldest.bookingDate, ...(lastEarlierDay === undefined ? [] : [lastEarlierDay.booking_date])];
  const continuesFromKnown =
    (await earlier.where('booking_date', 'in', predecessorDays).where('source_balance_after', '=', oldest.balanceBefore).limit(1).execute()).length > 0;
  const anyEarlierBalance = sameDay.length > 0 || lastEarlierDay !== undefined;
  return { order: chain.order, breaks: chain.breaks, previousExport: previousExport({ oldestImported, continuesFromKnown, anyEarlierBalance }) };
}
