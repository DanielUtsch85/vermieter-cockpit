import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { ParsedRow, ParsedStatement } from '../../domains/ledger/index.js';
import { MAX_ROWS, findBankStatementAdapter, genericCsvAdapter } from './index.js';

const mapping = {
  bookingDate: 'Buchungstag',
  valueDate: 'Valuta',
  amount: 'Betrag',
  counterpartyName: 'Beguenstigter/Zahlungspflichtiger',
  counterpartyIban: 'IBAN',
  description: 'Verwendungszweck',
};

/** Shaped like a German savings-bank export: semicolons, decimal comma, quoted fields. */
const sparkasse = [
  'Buchungstag;Valuta;Beguenstigter/Zahlungspflichtiger;IBAN;Verwendungszweck;Betrag',
  '01.09.2026;01.09.2026;Max Mustermann;DE89 3704 0044 0532 0130 00;"Miete September; Whg 1";1.250,00',
  '03.09.2026;03.09.2026;Stadtwerke;DE02120300000000202051;Abschlag;-89,50',
  '03.09.2026;03.09.2026;Stadtwerke;DE02120300000000202051;Abschlag;-89,50',
].join('\r\n');

function parse(content: string | Uint8Array, options: unknown = { columnMapping: mapping }) {
  const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content;
  return genericCsvAdapter.parse(bytes, options, 'EUR');
}

function statementOf(result: ReturnType<typeof parse>): ParsedStatement {
  if ('error' in result) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.statement;
}

function rowsOf(result: ReturnType<typeof parse>): Extract<ParsedRow, { kind: 'ROW' }>[] {
  return statementOf(result).rows.filter((r): r is Extract<ParsedRow, { kind: 'ROW' }> => r.kind === 'ROW');
}

describe('generic-csv v1', () => {
  it('normalizes a German export into ledger rows (sign → direction, exact Money, ISO dates)', () => {
    const statement = statementOf(parse(sparkasse));
    expect(statement).toMatchObject({ adapterId: 'generic-csv', adapterVersion: '1', sourceStatementId: null });
    expect(statement.contentHash).toBe(createHash('sha256').update(sparkasse).digest('hex'));
    const [rent, power] = rowsOf(parse(sparkasse));
    expect(rent).toMatchObject({
      position: 1,
      sourceRowId: null,
      row: {
        bookingDate: '2026-09-01',
        valueDate: '2026-09-01',
        direction: 'INFLOW',
        counterpartyNameRaw: 'Max Mustermann',
        counterpartyIbanRaw: 'DE89370400440532013000',
        description: 'Miete September; Whg 1',
        externalTransactionId: null,
      },
    });
    expect(rent?.row.amount.toJSON()).toEqual({ amount: '1250.00', currency: 'EUR' });
    expect(power?.row.direction).toBe('OUTFLOW');
    expect(power?.row.amount.amount).toBe('89.50');
  });

  it('two identical real payments are two rows at distinct positions with the same fingerprint (§70.4)', () => {
    const [, first, second] = rowsOf(parse(sparkasse));
    expect([first?.position, second?.position]).toEqual([2, 3]);
    expect(first?.contentFingerprint).toBe(second?.contentFingerprint);
  });

  it('the fingerprint ignores presentation formatting but changes with any fingerprint field', () => {
    const reformatted = sparkasse.replace('DE89 3704 0044 0532 0130 00', 'de89370400440532013000').replace('Max Mustermann', 'Max   Mustermann');
    expect(rowsOf(parse(reformatted))[0]?.contentFingerprint).toBe(rowsOf(parse(sparkasse))[0]?.contentFingerprint);
    expect(rowsOf(parse(sparkasse.replace('1.250,00', '1.250,01')))[0]?.contentFingerprint).not.toBe(rowsOf(parse(sparkasse))[0]?.contentFingerprint);
  });

  it('reads Windows-1252 exports when configured; as UTF-8 they are refused, never garbled', () => {
    const latin = Uint8Array.from([
      ...new TextEncoder().encode('Buchungstag;Betrag;Verwendungszweck\n01.09.2026;5,00;Gr'),
      0xfc, // ü in Windows-1252
      ...new TextEncoder().encode('n\n'),
    ]);
    const options = { columnMapping: { bookingDate: 'Buchungstag', amount: 'Betrag', description: 'Verwendungszweck' } };
    expect(rowsOf(parse(latin, { ...options, encoding: 'windows-1252' }))[0]?.row.description).toBe('Grün');
    expect(parse(latin, options)).toEqual({ error: expect.objectContaining({ code: 'UNSUPPORTED_ENCODING' }) });
  });

  it('skips preamble lines, a UTF-8 BOM and empty lines', () => {
    const file = `\uFEFFKonto;DE89370400440532013000\nZeitraum;09/2026\n\n${sparkasse}\n\n`;
    expect(rowsOf(parse(file, { columnMapping: mapping, skipLines: 3 }))).toHaveLength(3);
  });

  it('supports comma-delimited exports with decimal point and ISO dates', () => {
    const csv = 'date,amount,ref\n2026-09-01,"-1,250.00",TX-1\n';
    const rows = rowsOf(
      parse(csv, {
        columnMapping: { bookingDate: 'date', amount: 'amount', externalTransactionId: 'ref' },
        delimiter: ',',
        decimalSeparator: '.',
        dateFormat: 'YYYY-MM-DD',
      }),
    );
    expect(rows[0]?.row).toMatchObject({ direction: 'OUTFLOW', externalTransactionId: 'TX-1' });
    expect(rows[0]?.row.amount.amount).toBe('1250.00');
  });

  it('reports bad rows per row and keeps the good ones (never rounded, never guessed)', () => {
    const csv = [
      'Buchungstag;Betrag;Waehrung',
      '01.09.2026;5,00;EUR',
      '31.02.2026;5,00;EUR',
      '01.09.2026;5,005;EUR',
      '01.09.2026;0,00;EUR',
      '01.09.2026;12.50;EUR',
      ';5,00;EUR',
      '01.09.2026;5,00;USD',
      '01.03.0202;5,00;EUR',
      '01.09.2026;5,00',
    ].join('\n');
    const statement = statementOf(parse(csv, { columnMapping: { bookingDate: 'Buchungstag', amount: 'Betrag', currency: 'Waehrung' } }));
    expect(statement.rows.map((r) => (r.kind === 'ROW' ? 'ROW' : r.errors))).toEqual([
      'ROW',
      [{ field: 'bookingDate', code: 'INVALID_FORMAT' }],
      [{ field: 'amount', code: 'SCALE_EXCEEDED' }],
      [{ field: 'amount', code: 'ZERO_AMOUNT' }],
      [{ field: 'amount', code: 'INVALID_FORMAT' }],
      [{ field: 'bookingDate', code: 'REQUIRED' }],
      [{ field: 'currency', code: 'CURRENCY_MISMATCH' }],
      [{ field: 'bookingDate', code: 'OUT_OF_RANGE' }],
      [{ field: '(row)', code: 'COLUMN_COUNT' }],
    ]);
    expect(statement.rows.map((r) => r.position)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('uses a mapped external id and source row id', () => {
    const csv = 'Buchungstag;Betrag;Ref;Nr\n01.09.2026;5,00;E2E-77;42\n';
    const [row] = rowsOf(parse(csv, { columnMapping: { bookingDate: 'Buchungstag', amount: 'Betrag', externalTransactionId: 'Ref', sourceRowId: 'Nr' } }));
    expect(row).toMatchObject({ sourceRowId: '42', row: { externalTransactionId: 'E2E-77' } });
  });

  it('treats reference placeholders such as SEPA NOTPROVIDED as no reference', () => {
    const csv = 'Buchungstag;Betrag;Ref;Nr\n01.09.2026;750,00;NOTPROVIDED;-\n02.09.2026;980,00;notprovided;NONREF\n';
    const rows = rowsOf(parse(csv, { columnMapping: { bookingDate: 'Buchungstag', amount: 'Betrag', externalTransactionId: 'Ref', sourceRowId: 'Nr' } }));
    expect(rows.map((r) => [r.sourceRowId, r.row.externalTransactionId])).toEqual([
      [null, null],
      [null, null],
    ]);
  });

  it.each([
    ['no mapping', {}, 'INVALID_OPTIONS'],
    ['mapping without amount', { columnMapping: { bookingDate: 'Buchungstag' } }, 'INVALID_OPTIONS'],
    ['unknown option', { columnMapping: mapping, quote: "'" }, 'INVALID_OPTIONS'],
    ['unknown mapped field', { columnMapping: { ...mapping, iban2: 'X' } }, 'INVALID_OPTIONS'],
    ['mapped column not in header', { columnMapping: { ...mapping, amount: 'Umsatz' } }, 'MISSING_COLUMN'],
  ])('refuses the whole file: %s → %s', (_label, options, code) => {
    expect(parse(sparkasse, options)).toEqual({ error: expect.objectContaining({ code }) });
  });

  it.each([
    ['an empty file', '', 'EMPTY'],
    ['broken quoting', 'Buchungstag;Betrag\n"01.09.2026;5,00\n', 'UNPARSEABLE'],
    ['a duplicated header column', 'Buchungstag;Betrag;Betrag\n01.09.2026;1,00;2,00\n', 'AMBIGUOUS_COLUMN'],
  ])('refuses %s → %s', (_label, csv, code) => {
    expect(parse(csv, { columnMapping: { bookingDate: 'Buchungstag', amount: 'Betrag' } })).toEqual({
      error: expect.objectContaining({ code }),
    });
  });

  it(`refuses more than ${MAX_ROWS} rows`, () => {
    const csv = `Buchungstag;Betrag\n${'01.09.2026;1,00\n'.repeat(MAX_ROWS + 1)}`;
    expect(parse(csv, { columnMapping: { bookingDate: 'Buchungstag', amount: 'Betrag' } })).toEqual({
      error: expect.objectContaining({ code: 'TOO_MANY_ROWS' }),
    });
  });

  it('treats cell content as data, never as formulas or code', () => {
    const csv = 'Buchungstag;Betrag;Verwendungszweck\n01.09.2026;5,00;"=HYPERLINK(""http://x"")"\n';
    const result = parse(csv, { columnMapping: { bookingDate: 'Buchungstag', amount: 'Betrag', description: 'Verwendungszweck' } });
    expect(rowsOf(result)[0]?.row.description).toBe('=HYPERLINK("http://x")');
  });

  it('a quote inside an unquoted field fails the whole file with its line number (strict RFC 4180, no guessing)', () => {
    const csv = 'Buchungstag;Betrag;Verwendungszweck\n01.09.2026;5,00;Miete\n03.02.2026;1.250,00;=HYPERLINK("x")\n';
    const result = parse(csv, { columnMapping: { bookingDate: 'Buchungstag', amount: 'Betrag', description: 'Verwendungszweck' } });
    expect(result).toEqual({ error: { code: 'UNPARSEABLE', message: expect.stringMatching(/line 3/) } });
  });

  it('a stray extra cell makes that row an error, not a shifted mapping', () => {
    const csv = 'Buchungstag;Betrag;Verwendungszweck\n01.09.2026;5,00;Miete;extra\n';
    const result = parse(csv, { columnMapping: { bookingDate: 'Buchungstag', amount: 'Betrag', description: 'Verwendungszweck' } });
    expect(statementOf(result).rows[0]).toEqual({ kind: 'ERROR', position: 1, errors: [{ field: '(row)', code: 'COLUMN_COUNT' }] });
  });

  it('is registered by id and version', () => {
    expect(findBankStatementAdapter('generic-csv', '1')).toBe(genericCsvAdapter);
    expect(findBankStatementAdapter('generic-csv', '2')).toBeUndefined();
  });
});
