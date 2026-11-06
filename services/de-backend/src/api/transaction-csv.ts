import type { TransactionWithSplits } from '../application/index.js';
import { toDto, toSplitDto } from './transaction-dto.js';

/**
 * The Kassenbuch CSV (api-design.md §58S, VC-X-04): the Transaction DTO's fields as columns, one row per Transaction
 * or per split. Two dialects, decided 2026-11-06 (open questions 2 and 3):
 * - `rfc4180` (default): `,`, CRLF, UTF-8 without BOM, every value character for character as the DTO (no formula guard);
 * - `excel-de`: `;`, CRLF, UTF-8 with BOM, the decimal point of the four money columns a comma, and the formula guard
 *   (a leading `'`) on the four free-text columns. Dates, timestamps, ids, codes and integers are the same in both.
 * Money is never a number here: the sign and the decimal comma are string operations on `Money.amount`.
 */

export const CSV_DIALECTS = ['rfc4180', 'excel-de'] as const;
export type CsvDialect = (typeof CSV_DIALECTS)[number];

export const CSV_ROWS = ['transactions', 'splits'] as const;
export type CsvRows = (typeof CSV_ROWS)[number];

/** How a column's value is written: as it is, as money (the dialect's decimal mark), or as free text (the guard). */
type Kind = 'plain' | 'money' | 'text';

type TransactionDto = ReturnType<typeof toDto>;
type SplitDto = ReturnType<typeof toSplitDto>;

interface Column<R> {
  readonly name: string;
  readonly kind: Kind;
  readonly value: (row: R) => string | null;
}

/** `amount` with `-` for an `OUTFLOW`; zero is never signed. A prefix, not arithmetic. */
function signed(amount: string, direction: string): string {
  return direction === 'OUTFLOW' && !/^0+(\.0+)?$/.test(amount) ? `-${amount}` : amount;
}

const text = (value: number | null): string | null => (value === null ? null : String(value));

const TRANSACTION_COLUMNS: readonly Column<{ readonly t: TransactionDto; readonly splitCount: number }>[] = [
  { name: 'transactionId', kind: 'plain', value: ({ t }) => t.transactionId },
  { name: 'bookingDate', kind: 'plain', value: ({ t }) => t.bookingDate },
  { name: 'valueDate', kind: 'plain', value: ({ t }) => t.valueDate },
  { name: 'financialAccountId', kind: 'plain', value: ({ t }) => t.financialAccountId },
  { name: 'direction', kind: 'plain', value: ({ t }) => t.direction },
  { name: 'amount', kind: 'money', value: ({ t }) => t.amount.amount },
  { name: 'signedAmount', kind: 'money', value: ({ t }) => signed(t.amount.amount, t.direction) },
  { name: 'currency', kind: 'plain', value: ({ t }) => t.amount.currency },
  { name: 'status', kind: 'plain', value: ({ t }) => t.status },
  { name: 'provenance', kind: 'plain', value: ({ t }) => t.provenance },
  { name: 'description', kind: 'text', value: ({ t }) => t.description },
  { name: 'counterpartyNameRaw', kind: 'text', value: ({ t }) => t.counterpartyNameRaw },
  { name: 'counterpartyIbanRaw', kind: 'text', value: ({ t }) => t.counterpartyIbanRaw },
  { name: 'propertyReferenceId', kind: 'plain', value: ({ t }) => t.propertyReferenceId },
  { name: 'splitCount', kind: 'plain', value: ({ splitCount }) => String(splitCount) },
  { name: 'correctionOfTransactionId', kind: 'plain', value: ({ t }) => t.correctionOfTransactionId },
  { name: 'correctionRole', kind: 'plain', value: ({ t }) => t.correctionRole },
  { name: 'reversalTransactionId', kind: 'plain', value: ({ t }) => t.reversalTransactionId },
  { name: 'replacementTransactionId', kind: 'plain', value: ({ t }) => t.replacementTransactionId },
  { name: 'confirmedAt', kind: 'plain', value: ({ t }) => t.confirmedAt },
  { name: 'confirmedBy', kind: 'plain', value: ({ t }) => t.confirmedBy },
  { name: 'createdAt', kind: 'plain', value: ({ t }) => t.createdAt },
  { name: 'version', kind: 'plain', value: ({ t }) => String(t.version) },
];

/** With `rows=splits`, after the Transaction's columns; all empty on the row of an unsplit Transaction. */
const SPLIT_COLUMNS: readonly Column<{ readonly s: SplitDto; readonly direction: string }>[] = [
  { name: 'splitPosition', kind: 'plain', value: ({ s }) => text(s.position) },
  { name: 'splitAmount', kind: 'money', value: ({ s }) => s.amount.amount },
  { name: 'signedSplitAmount', kind: 'money', value: ({ s, direction }) => signed(s.amount.amount, direction) },
  { name: 'financialCategoryCode', kind: 'plain', value: ({ s }) => s.financialCategoryCode },
  { name: 'splitPropertyReferenceId', kind: 'plain', value: ({ s }) => s.propertyReferenceId },
  { name: 'loanId', kind: 'plain', value: ({ s }) => s.loanId },
  { name: 'securityDepositId', kind: 'plain', value: ({ s }) => s.securityDepositId },
  { name: 'wegAnnualStatementId', kind: 'plain', value: ({ s }) => s.wegAnnualStatementId },
  { name: 'wegSpecialAssessmentId', kind: 'plain', value: ({ s }) => s.wegSpecialAssessmentId },
  { name: 'splitDescription', kind: 'text', value: ({ s }) => s.description },
];

interface Dialect {
  readonly bom: string;
  readonly delimiter: string;
  /** A field is quoted exactly when it contains one of these. */
  readonly quoteWhen: RegExp;
  readonly money: (amount: string) => string;
  /** The formula guard (CWE-1236) on free text: a leading `'` before `=`, `+`, `-`, `@`, TAB or CR. */
  readonly guard: boolean;
}

const DIALECTS: Record<CsvDialect, Dialect> = {
  rfc4180: { bom: '', delimiter: ',', quoteWhen: /[,"\r\n]/, money: (amount) => amount, guard: false },
  'excel-de': { bom: '\uFEFF', delimiter: ';', quoteWhen: /[;"\r\n]/, money: (amount) => amount.replace('.', ','), guard: true },
};

const FORMULA_START = /^[=+\-@\t\r]/;

function field(value: string | null, kind: Kind, dialect: Dialect): string {
  if (value === null) return '';
  let out = kind === 'money' ? dialect.money(value) : value;
  if (kind === 'text' && dialect.guard && FORMULA_START.test(out)) out = `'${out}`;
  return dialect.quoteWhen.test(out) ? `"${out.replaceAll('"', '""')}"` : out;
}

const record = (fields: readonly string[], dialect: Dialect) => `${fields.join(dialect.delimiter)}\r\n`;

/** The file's start: the BOM of `excel-de`, once, and the header line (also for an empty result). */
export function csvHead(dialect: CsvDialect, rows: CsvRows): string {
  const d = DIALECTS[dialect];
  const names = [...TRANSACTION_COLUMNS, ...(rows === 'splits' ? SPLIT_COLUMNS : [])].map((c) => c.name);
  return d.bom + record(names, d);
}

/** The rows of one Transaction: one, or with `rows=splits` one per split in `position` order (one if it has none). */
export function csvRecords(item: TransactionWithSplits, dialect: CsvDialect, rows: CsvRows): string {
  const d = DIALECTS[dialect];
  const t = toDto(item.transaction);
  const own = TRANSACTION_COLUMNS.map((c) => field(c.value({ t, splitCount: item.splits.length }), c.kind, d));
  if (rows === 'transactions') return record(own, d);
  if (item.splits.length === 0) return record([...own, ...SPLIT_COLUMNS.map(() => '')], d);
  return item.splits
    .map((split) => record([...own, ...SPLIT_COLUMNS.map((c) => field(c.value({ s: toSplitDto(split), direction: t.direction }), c.kind, d))], d))
    .join('');
}
