import { createHash } from 'node:crypto';
import { parse } from 'csv-parse/sync';
import { z } from 'zod';
import {
  contentFingerprintFieldsV1,
  type BankStatementAdapter,
  type NormalizedBankRow,
  type ParsedRow,
  type ParsedStatement,
  type RowError,
  type StatementError,
} from '../../domains/ledger/index.js';
import { Money, MoneyError, type CurrencyCode } from '../../shared/index.js';
import { normalizeIbanRaw, normalizeReference, normalizeText, parseSignedAmount, parseSourceDate } from './normalize.js';

/**
 * `generic-csv` version 1: any bank's CSV export with a header row, configured
 * by a column mapping and a few format options (api-design.md §32.1). It
 * treats the file as untrusted input (technology.md §36): values are parsed,
 * never evaluated, and nothing is guessed.
 *
 * Version 1 fixes: one signed amount column (leading `-` = OUTFLOW), the
 * normalization rules in normalize.ts, and fingerprint field set v1. Any change
 * to these is version 2.
 */

export const GENERIC_CSV_ID = 'generic-csv';
export const GENERIC_CSV_VERSION = '1';

/** Upper bound per file; larger statements are split by the user. */
export const MAX_ROWS = 10_000;
const MAX_TEXT_LENGTH = 2_000;

const column = z.string().trim().min(1).max(200);

export const genericCsvOptions = z
  .object({
    columnMapping: z
      .object({
        bookingDate: column,
        amount: column,
        valueDate: column.optional(),
        currency: column.optional(),
        counterpartyName: column.optional(),
        counterpartyIban: column.optional(),
        description: column.optional(),
        externalTransactionId: column.optional(),
        sourceRowId: column.optional(),
      })
      .strict(),
    delimiter: z.enum([';', ',', '\t']).default(';'),
    decimalSeparator: z.enum([',', '.']).default(','),
    dateFormat: z.enum(['DD.MM.YYYY', 'DD.MM.YY', 'YYYY-MM-DD']).default('DD.MM.YYYY'),
    encoding: z.enum(['utf-8', 'windows-1252']).default('utf-8'),
    /** Lines before the header row (bank exports often start with account metadata). */
    skipLines: z.number().int().min(0).max(50).default(0),
  })
  .strict();
export type GenericCsvOptions = z.infer<typeof genericCsvOptions>;

export const genericCsvAdapter: BankStatementAdapter = {
  id: GENERIC_CSV_ID,
  version: GENERIC_CSV_VERSION,
  provenance: 'BANK_CSV',
  parse(file, rawOptions, accountCurrency) {
    const parsedOptions = genericCsvOptions.safeParse(rawOptions);
    if (!parsedOptions.success) {
      const fields = parsedOptions.error.issues.map((i) => i.path.join('.') || '(options)').join(', ');
      return fail('INVALID_OPTIONS', `Invalid adapter options: ${fields}`);
    }
    const options = parsedOptions.data;

    const text = decode(file, options.encoding);
    if (text === undefined) return fail('UNSUPPORTED_ENCODING', `The file is not valid ${options.encoding}; try windows-1252`);

    let records: string[][];
    try {
      records = parse(text, {
        delimiter: options.delimiter,
        from_line: options.skipLines + 1,
        skip_empty_lines: true,
        relax_column_count: true,
        bom: true,
      });
    } catch (error) {
      return fail('UNPARSEABLE', `The file is not valid CSV: ${error instanceof Error ? error.message : String(error)}`);
    }

    const [header, ...dataRows] = records;
    if (header === undefined) return fail('EMPTY', 'The file has no header row');
    if (dataRows.length > MAX_ROWS) return fail('TOO_MANY_ROWS', `More than ${MAX_ROWS} rows; split the statement`);

    const indexes = resolveColumns(header.map((h) => h.trim()), options.columnMapping);
    if ('error' in indexes) return { error: indexes.error };

    const rows: ParsedRow[] = dataRows.map((cells, i) =>
      parseRow(cells, i + 1, header.length, indexes.columns, options, accountCurrency),
    );
    const statement: ParsedStatement = {
      adapterId: GENERIC_CSV_ID,
      adapterVersion: GENERIC_CSV_VERSION,
      contentHash: createHash('sha256').update(file).digest('hex'),
      // A plain CSV export carries no statement id: the file content identifies it (§70.2).
      sourceStatementId: null,
      rows,
    };
    return { statement };
  },
};

type MappedField = keyof GenericCsvOptions['columnMapping'];
type ColumnIndexes = Partial<Record<MappedField, number>>;

function resolveColumns(
  header: readonly string[],
  mapping: GenericCsvOptions['columnMapping'],
): { readonly columns: ColumnIndexes } | { readonly error: StatementError } {
  const columns: ColumnIndexes = {};
  for (const [field, name] of Object.entries(mapping) as [MappedField, string | undefined][]) {
    if (name === undefined) continue;
    const matches = header.flatMap((h, index) => (h === name ? [index] : []));
    const [index, ...more] = matches;
    if (index === undefined) return { error: { code: 'MISSING_COLUMN', message: `Column "${name}" (${field}) not in the header` } };
    if (more.length > 0) return { error: { code: 'AMBIGUOUS_COLUMN', message: `Column "${name}" (${field}) appears more than once` } };
    columns[field] = index;
  }
  return { columns };
}

function parseRow(
  cells: readonly string[],
  position: number,
  headerLength: number,
  columns: ColumnIndexes,
  options: GenericCsvOptions,
  accountCurrency: CurrencyCode,
): ParsedRow {
  if (cells.length !== headerLength) return { kind: 'ERROR', position, errors: [{ field: '(row)', code: 'COLUMN_COUNT' }] };
  const cell = (field: MappedField) => {
    const index = columns[field];
    return index === undefined ? undefined : cells[index];
  };
  const errors: RowError[] = [];

  const bookingDateRaw = normalizeText(cell('bookingDate'));
  const bookingDate = bookingDateRaw === null ? undefined : parseSourceDate(bookingDateRaw, options.dateFormat);
  if (bookingDate === undefined) errors.push({ field: 'bookingDate', code: 'REQUIRED' });
  else if ('error' in bookingDate) errors.push({ field: 'bookingDate', code: bookingDate.error });

  const valueDateRaw = normalizeText(cell('valueDate'));
  const valueDate = valueDateRaw === null ? null : parseSourceDate(valueDateRaw, options.dateFormat);
  if (valueDate !== null && 'error' in valueDate) errors.push({ field: 'valueDate', code: valueDate.error });

  const currencyRaw = normalizeText(cell('currency'))?.toUpperCase() ?? accountCurrency;
  if (currencyRaw !== accountCurrency) errors.push({ field: 'currency', code: 'CURRENCY_MISMATCH' });

  const amountRaw = normalizeText(cell('amount'));
  const signed = amountRaw === null ? undefined : parseSignedAmount(amountRaw, options.decimalSeparator);
  let amount: Money | undefined;
  if (amountRaw === null) errors.push({ field: 'amount', code: 'REQUIRED' });
  else if (signed === undefined) errors.push({ field: 'amount', code: 'INVALID_FORMAT' });
  else {
    try {
      amount = Money.of(signed.magnitude, accountCurrency);
      // A zero row moves no cash and has no direction; it is reported, not booked.
      if (amount.isZero()) errors.push({ field: 'amount', code: 'ZERO_AMOUNT' });
    } catch (error) {
      if (!(error instanceof MoneyError)) throw error;
      // More decimals than the currency allows are rejected, never rounded (§17.4).
      errors.push({ field: 'amount', code: error.code === 'SCALE_EXCEEDED' ? 'SCALE_EXCEEDED' : 'AMOUNT_OUT_OF_RANGE' });
    }
  }

  const texts = {
    counterpartyNameRaw: normalizeText(cell('counterpartyName')),
    description: normalizeText(cell('description')),
    externalTransactionId: normalizeReference(cell('externalTransactionId')),
  };
  for (const [field, value] of Object.entries(texts)) {
    if (value !== null && value.length > MAX_TEXT_LENGTH) errors.push({ field, code: 'TOO_LONG' });
  }

  if (errors.length > 0 || bookingDate === undefined || 'error' in bookingDate || amount === undefined || signed === undefined) {
    return { kind: 'ERROR', position, errors };
  }
  const row: NormalizedBankRow = {
    bookingDate: bookingDate.date,
    valueDate: valueDate === null || 'error' in valueDate ? null : valueDate.date,
    amount,
    direction: signed.negative ? 'OUTFLOW' : 'INFLOW',
    counterpartyIbanRaw: normalizeIbanRaw(cell('counterpartyIban')),
    ...texts,
  };
  return {
    kind: 'ROW',
    position,
    sourceRowId: normalizeReference(cell('sourceRowId')),
    row,
    contentFingerprint: createHash('sha256').update(contentFingerprintFieldsV1(row)).digest('hex'),
  };
}

function decode(file: Uint8Array, encoding: GenericCsvOptions['encoding']): string | undefined {
  try {
    // fatal for UTF-8: a Windows-1252 export read as UTF-8 would silently garble umlauts.
    return new TextDecoder(encoding, { fatal: encoding === 'utf-8' }).decode(file);
  } catch {
    return undefined;
  }
}

function fail(code: string, message: string): { readonly error: StatementError } {
  return { error: { code, message } };
}
