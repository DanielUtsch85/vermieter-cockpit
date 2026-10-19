import type { CurrencyCode, Money } from '../../shared/index.js';
import type { BusinessDate, Direction } from './transaction.js';

/**
 * The normalized import contract between bank-statement adapters and the
 * ledger (technology.md §13, data-model.md §70, api-design.md §32.1). The
 * ledger is format-agnostic: it only ever sees these types, never CSV.
 */

/** One bank row after mapping and normalization (data-model.md §70.2–70.3). */
export interface NormalizedBankRow {
  readonly bookingDate: BusinessDate;
  readonly valueDate: BusinessDate | null;
  /** Non-negative; the sign is `direction` (§17.4). */
  readonly amount: Money;
  readonly direction: Direction;
  /** As in the source (normalized: no spaces, upper case), not validated: it is evidence, not identity. */
  readonly counterpartyIbanRaw: string | null;
  readonly counterpartyNameRaw: string | null;
  readonly description: string | null;
  /** A bank-assigned stable transaction reference, if the source provides one (§70.1 branch 1). */
  readonly externalTransactionId: string | null;
}

/** A field-level problem of one row; the row then creates nothing (api-design.md §32.1 `error`). */
export interface RowError {
  readonly field: string;
  readonly code: string;
}

/** One data row of a statement: its source position plus either the normalized row or its errors. */
export type ParsedRow =
  | {
      readonly kind: 'ROW';
      /** 1-based ordinal of the data row within this file (§70.2 `sourceRowPosition`). */
      readonly position: number;
      /** A source-provided row id, if the format has one (§70.2 `sourceRowId`). */
      readonly sourceRowId: string | null;
      readonly row: NormalizedBankRow;
      /** Versioned content fingerprint (§70.2): collision/ambiguity detection only, never an identity. */
      readonly contentFingerprint: string;
    }
  | { readonly kind: 'ERROR'; readonly position: number; readonly errors: readonly RowError[] };

export interface ParsedStatement {
  readonly adapterId: string;
  readonly adapterVersion: string;
  /** Hash of the raw file bytes: the statement identity when the source has no statement id (§70.2). */
  readonly contentHash: string;
  /** A stable statement/source id, if the source provides one (§70.2). */
  readonly sourceStatementId: string | null;
  readonly rows: readonly ParsedRow[];
}

/** The file as a whole cannot be read (api-design.md §32.1 → 400); no row is imported. */
export interface StatementError {
  readonly code: string;
  readonly message: string;
}

/**
 * Port for a bank-statement format (implemented in integrations/bank-import).
 * `options` are adapter-specific (e.g. a column mapping) and validated by the adapter.
 */
export interface BankStatementAdapter {
  readonly id: string;
  readonly version: string;
  parse(
    file: Uint8Array,
    options: unknown,
    accountCurrency: CurrencyCode,
  ): { readonly statement: ParsedStatement } | { readonly error: StatementError };
}

/**
 * The content-fingerprint field set, version 1 (§70.2): booking and value date,
 * amount + direction + currency, counterparty (IBAN, else name), description.
 * Canonical text; an adapter hashes it. Changing the field set is a new adapter
 * version, never a silent redefinition.
 */
export function contentFingerprintFieldsV1(row: NormalizedBankRow): string {
  return JSON.stringify([
    row.bookingDate,
    row.valueDate,
    row.amount.amount,
    row.amount.currency,
    row.direction,
    row.counterpartyIbanRaw ?? row.counterpartyNameRaw,
    row.description,
  ]);
}
