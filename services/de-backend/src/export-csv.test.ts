import { parse } from 'csv-parse/sync';
import { describe, expect, it } from 'vitest';
import type { Transaction, TransactionSplit, TransactionWithSplits } from './application/index.js';
import { csvHead, csvRecords, type CsvDialect } from './api/transaction-csv.js';
import { transaction } from './api/transactions.test-support.js';
import { Money } from './shared/index.js';

/**
 * VC-X-04 (api-design.md §58S): the bytes of the Kassenbuch CSV, field by field, in both dialects (decided 2026-11-06,
 * open questions 2 and 3). `rfc4180` writes every value as the DTO; `excel-de` changes only the delimiter, the decimal
 * mark of the four money columns, the BOM and the formula guard on the four free-text columns. Synthetic values.
 */
const TEXT_COLUMNS = ['description', 'counterpartyNameRaw', 'counterpartyIbanRaw', 'splitDescription'] as const;
const STARTS = ['=', '+', '-', '@', '\t', '\r'];

const tx = (changes: Partial<Record<keyof Transaction, unknown>> = {}) => ({ ...transaction, ...changes }) as unknown as Transaction;
const split = (changes: Partial<Record<keyof TransactionSplit, unknown>> = {}) =>
  ({
    id: 's1',
    position: 1,
    amount: Money.of('1250.00', 'EUR'),
    financialCategoryCode: 'RENT_BASE',
    propertyReferenceId: null,
    loanId: null,
    securityDepositId: null,
    wegAnnualStatementId: null,
    wegSpecialAssessmentId: null,
    description: null,
    ...changes,
  }) as unknown as TransactionSplit;
const item = (t: Transaction, splits: TransactionSplit[] = []): TransactionWithSplits => ({ transaction: t, splits });

/** A whole file of one item, parsed back with an RFC 4180 parser (csv-parse) in the dialect's delimiter. */
function roundTrip(entry: TransactionWithSplits, dialect: CsvDialect, rows: 'transactions' | 'splits' = 'splits') {
  const file = csvHead(dialect, rows) + csvRecords(entry, dialect, rows);
  const [header = [], ...records] = parse(file, { delimiter: dialect === 'rfc4180' ? ',' : ';', bom: true, record_delimiter: '\r\n' });
  return { file, header, records, cell: (name: string, row = 0) => records[row]?.[header.indexOf(name)] };
}

describe('the Kassenbuch CSV, rfc4180 (the exact portability file)', () => {
  it('no BOM; a header always; CRLF after every record; quoted exactly on comma, quote, CR and LF, quotes doubled', () => {
    expect(csvHead('rfc4180', 'transactions').startsWith('transactionId,bookingDate,')).toBe(true);
    expect(csvHead('rfc4180', 'transactions').endsWith(',createdAt,version\r\n')).toBe(true);
    const line = csvRecords(item(tx({ description: 'a,b "c"\r\nd' })), 'rfc4180', 'transactions');
    expect(line.endsWith('\r\n')).toBe(true);
    expect(line).toContain(',"a,b ""c""\r\nd",');
    expect(csvRecords(item(tx({ description: 'Miete; Juli' })), 'rfc4180', 'transactions')).toContain(',Miete; Juli,');
    expect(csvRecords(item(tx({ description: 'Zeile\nzwei' })), 'rfc4180', 'transactions')).toContain(',"Zeile\nzwei",');
  });

  it('no formula guard: a value starting with = + - @ TAB or CR in each of the four text columns parses back unchanged', () => {
    for (const start of STARTS) {
      for (const column of TEXT_COLUMNS) {
        const value = `${start}SUMME(A1)`;
        const entry =
          column === 'splitDescription'
            ? item(tx(), [split({ description: value })])
            : item(tx({ [column === 'description' ? 'description' : column]: value }), [split()]);
        const { cell, file } = roundTrip(entry, 'rfc4180');
        expect(cell(column), `${JSON.stringify(start)} in ${column}`).toBe(value);
        expect(file).not.toContain(`'${start}`);
      }
    }
  });

  it('money exact: decimal point, two decimals, no separator; the 18-digit amount; 0.00 never signed; -312.40 for an outflow', () => {
    const big = '999999999999999999.99';
    expect(roundTrip(item(tx({ amount: Money.of(big, 'EUR') }), [split({ amount: Money.of(big, 'EUR') })]), 'rfc4180').cell('signedSplitAmount')).toBe(big);
    const out = roundTrip(item(tx({ direction: 'OUTFLOW', amount: Money.of(big, 'EUR') }), [split({ amount: Money.of(big, 'EUR') })]), 'rfc4180');
    expect([out.cell('amount'), out.cell('signedAmount'), out.cell('splitAmount'), out.cell('signedSplitAmount')]).toEqual([big, `-${big}`, big, `-${big}`]);
    const zero = roundTrip(item(tx({ direction: 'OUTFLOW', amount: Money.of('0.00', 'EUR') }), [split({ amount: Money.of('0.00', 'EUR') })]), 'rfc4180');
    expect([zero.cell('signedAmount'), zero.cell('signedSplitAmount')]).toEqual(['0.00', '0.00']);
    expect(roundTrip(item(tx({ direction: 'OUTFLOW', amount: Money.of('312.40', 'EUR') })), 'rfc4180').cell('signedAmount')).toBe('-312.40');
    expect(roundTrip(item(tx({ amount: Money.of('1250.00', 'EUR') })), 'rfc4180').cell('amount')).toBe('1250.00');
  });

  it('umlauts as UTF-8; null as an empty field; an unsplit Transaction under rows=splits is one row with ten empty split columns', () => {
    const { file, cell, records, header } = roundTrip(item(tx({ description: 'Müller Straße', valueDate: null })), 'rfc4180');
    expect(Buffer.from(file, 'utf8').includes(Buffer.from('Müller Straße', 'utf8'))).toBe(true);
    expect(cell('description')).toBe('Müller Straße');
    expect(cell('valueDate')).toBe('');
    expect(records).toHaveLength(1);
    expect(header).toHaveLength(33);
    expect(records[0]?.slice(23)).toEqual(Array(10).fill(''));
    expect(cell('splitCount')).toBe('0');
  });

  it('rows=splits: one row per split in position order, the Transaction columns repeated, the split signed by the direction', () => {
    const entry = item(tx({ direction: 'OUTFLOW', amount: Money.of('300.00', 'EUR') }), [
      split({ position: 1, amount: Money.of('100.00', 'EUR'), financialCategoryCode: 'MAINTENANCE' }),
      split({ position: 2, amount: Money.of('200.00', 'EUR'), financialCategoryCode: 'ADMINISTRATION', loanId: 'l-1' }),
    ]);
    const { records, cell } = roundTrip(entry, 'rfc4180');
    expect(records).toHaveLength(2);
    expect([cell('splitPosition', 0), cell('signedSplitAmount', 0), cell('splitPosition', 1), cell('signedSplitAmount', 1), cell('loanId', 1)]).toEqual([
      '1',
      '-100.00',
      '2',
      '-200.00',
      'l-1',
    ]);
    expect(records[0]?.slice(0, 23)).toEqual(records[1]?.slice(0, 23));
    expect(cell('splitCount')).toBe('2');
  });
});

describe('the Kassenbuch CSV, excel-de (for a German spreadsheet)', () => {
  it('the BOM once, before the header; semicolons; the same header names and order as the default', () => {
    const head = csvHead('excel-de', 'splits');
    expect([...Buffer.from(head, 'utf8').subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(head.slice(1).split('\r\n')[0]?.split(';')).toEqual(csvHead('rfc4180', 'splits').split('\r\n')[0]?.split(','));
    expect(csvRecords(item(tx()), 'excel-de', 'transactions').startsWith('\uFEFF')).toBe(false);
    expect(csvHead('excel-de', 'transactions').split('\uFEFF')).toHaveLength(2);
  });

  it('quoted on semicolon, quote, CR and LF, not on a lone comma', () => {
    expect(csvRecords(item(tx({ description: 'Miete, Juli' })), 'excel-de', 'transactions')).toContain(';Miete, Juli;');
    expect(csvRecords(item(tx({ description: 'Miete; Juli' })), 'excel-de', 'transactions')).toContain(';"Miete; Juli";');
    expect(csvRecords(item(tx({ description: 'a "b"' })), 'excel-de', 'transactions')).toContain(';"a ""b""";');
    expect(csvRecords(item(tx({ description: 'a\r\nb' })), 'excel-de', 'transactions')).toContain(';"a\r\nb";');
  });

  it('decimal comma in all four money columns, no point, no thousands separator; the 18-digit amount; -312,40 keeps its minus; 0,00 unsigned', () => {
    const entry = item(tx({ direction: 'OUTFLOW', amount: Money.of('1250.00', 'EUR') }), [split({ amount: Money.of('1250.00', 'EUR') })]);
    const { cell } = roundTrip(entry, 'excel-de');
    expect([cell('amount'), cell('signedAmount'), cell('splitAmount'), cell('signedSplitAmount')]).toEqual(['1250,00', '-1250,00', '1250,00', '-1250,00']);
    const big = '999999999999999999.99';
    const huge = roundTrip(item(tx({ amount: Money.of(big, 'EUR') }), [split({ amount: Money.of(big, 'EUR') })]), 'excel-de');
    expect(huge.cell('amount')).toBe('999999999999999999,99');
    expect(huge.cell('signedSplitAmount')).toBe('999999999999999999,99');
    expect(roundTrip(item(tx({ direction: 'OUTFLOW', amount: Money.of('312.40', 'EUR') })), 'excel-de').cell('signedAmount')).toBe('-312,40');
    expect(roundTrip(item(tx({ direction: 'OUTFLOW', amount: Money.of('0.00', 'EUR') })), 'excel-de').cell('signedAmount')).toBe('0,00');
  });

  it('dates, timestamps, ids, codes and integers byte-equal to the default', () => {
    const entry = item(tx({ valueDate: '2026-10-01', confirmedAt: new Date('2026-10-02T08:15:00Z'), confirmedBy: 'v@example.org', version: 7 }), [split()]);
    const rfc = roundTrip(entry, 'rfc4180');
    const de = roundTrip(entry, 'excel-de');
    for (const name of [
      'transactionId',
      'bookingDate',
      'valueDate',
      'financialAccountId',
      'confirmedAt',
      'createdAt',
      'version',
      'splitCount',
      'splitPosition',
      'financialCategoryCode',
      'status',
    ]) {
      expect(de.cell(name), name).toBe(rfc.cell(name));
    }
    expect(de.cell('bookingDate')).toBe('2026-09-01');
    expect(de.cell('confirmedAt')).toBe('2026-10-02T08:15:00.000Z');
  });

  it('the formula guard on each of = + - @ TAB CR in each of the four text columns; parsed back, the guard stripped gives the value', () => {
    for (const start of STARTS) {
      for (const column of TEXT_COLUMNS) {
        const value = `${start}SUMME(A1)`;
        const entry = column === 'splitDescription' ? item(tx(), [split({ description: value })]) : item(tx({ [column]: value }), [split()]);
        const cell = roundTrip(entry, 'excel-de').cell(column) ?? '';
        expect(cell, `${JSON.stringify(start)} in ${column}`).toBe(`'${value}`);
        expect(cell.slice(1)).toBe(value);
      }
    }
  });

  it('the guard on no other column: a negative signedAmount, an id, a code untouched; a value already starting with an apostrophe unchanged', () => {
    const entry = item(tx({ direction: 'OUTFLOW', amount: Money.of('312.40', 'EUR'), confirmedBy: '=x@example.org', propertyReferenceId: '-p' }), [
      split({ financialCategoryCode: '=CODE', amount: Money.of('312.40', 'EUR') }),
    ]);
    const { cell } = roundTrip(entry, 'excel-de');
    expect(cell('signedAmount')).toBe('-312,40');
    expect(cell('signedSplitAmount')).toBe('-312,40');
    expect(cell('confirmedBy')).toBe('=x@example.org');
    expect(cell('propertyReferenceId')).toBe('-p');
    expect(cell('financialCategoryCode')).toBe('=CODE');
    expect(roundTrip(item(tx({ description: "'=x" })), 'excel-de').cell('description')).toBe("'=x");
    expect(roundTrip(item(tx({ description: '=x' })), 'excel-de').cell('description')).toBe("'=x");
  });

  it('a guarded value with a semicolon or a quote is quoted after guarding', () => {
    expect(csvRecords(item(tx({ description: '=A;B' })), 'excel-de', 'transactions')).toContain(`;"'=A;B";`);
    expect(csvRecords(item(tx({ description: '=A"B' })), 'excel-de', 'transactions')).toContain(`;"'=A""B";`);
  });
});
