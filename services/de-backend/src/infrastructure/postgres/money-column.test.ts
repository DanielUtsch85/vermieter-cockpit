import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Money } from '../../shared/index.js';
import { fromNumericAmount, toNumericAmount } from './money-column.js';

/**
 * Round-trips Money through a real PostgreSQL NUMERIC column (VC-0-05 exit).
 * Needs DE_TEST_DATABASE_URL; CI provides a PostgreSQL service and fails if the
 * variable is missing there, so the suite can never be skipped silently in CI.
 */
const databaseUrl = process.env['DE_TEST_DATABASE_URL'];
if (databaseUrl === undefined && process.env['CI'] !== undefined) {
  throw new Error('DE_TEST_DATABASE_URL must be set in CI');
}

describe.skipIf(databaseUrl === undefined)('Money ↔ PostgreSQL NUMERIC', () => {
  const client = new pg.Client({ connectionString: databaseUrl });

  beforeAll(async () => {
    await client.connect();
    await client.query(
      'CREATE TEMPORARY TABLE money_roundtrip (id serial PRIMARY KEY, amount NUMERIC NOT NULL, currency text NOT NULL)',
    );
  });

  afterAll(async () => {
    await client.end();
  });

  async function roundTrip(money: Money): Promise<{ raw: unknown; restored: Money }> {
    const inserted = await client.query<{ id: number }>(
      'INSERT INTO money_roundtrip (amount, currency) VALUES ($1, $2) RETURNING id',
      [toNumericAmount(money), money.currency],
    );
    const row = await client.query<{ amount: unknown; currency: unknown }>(
      'SELECT amount, currency FROM money_roundtrip WHERE id = $1',
      [inserted.rows[0]?.id],
    );
    const { amount, currency } = row.rows[0] ?? {};
    return { raw: amount, restored: fromNumericAmount(amount, currency) };
  }

  it.each(['0.00', '0.01', '0.10', '1250.00', '-12.34', '999999999999999999.99', '-999999999999999999.99'])(
    'round-trips %s EUR exactly',
    async (amount) => {
      const money = Money.of(amount, 'EUR');
      const { raw, restored } = await roundTrip(money);
      expect(typeof raw).toBe('string');
      expect(raw).toBe(amount);
      expect(restored.equals(money)).toBe(true);
      expect(restored.amount).toBe(amount);
    },
  );

  it('keeps a sum computed in Money exact through the database', async () => {
    const sum = Money.of('0.1', 'EUR').add(Money.of('0.2', 'EUR'));
    const { restored } = await roundTrip(sum);
    expect(restored.amount).toBe('0.30');
  });

  it('sums in SQL equal sums in Money (no float in between)', async () => {
    await client.query('TRUNCATE money_roundtrip');
    const parts = ['0.10', '0.20', '0.30', '1234567890123456.78', '-0.01'].map((a) => Money.of(a, 'EUR'));
    for (const p of parts) {
      await client.query('INSERT INTO money_roundtrip (amount, currency) VALUES ($1, $2)', [
        toNumericAmount(p),
        p.currency,
      ]);
    }
    const result = await client.query<{ total: unknown }>('SELECT sum(amount) AS total FROM money_roundtrip');
    expect(fromNumericAmount(result.rows[0]?.total, 'EUR').equals(Money.sum(parts, 'EUR'))).toBe(true);
  });

  it('rejects a stored amount with more decimals than the currency allows', async () => {
    const result = await client.query<{ amount: unknown }>("SELECT '1.005'::numeric AS amount");
    expect(() => fromNumericAmount(result.rows[0]?.amount, 'EUR')).toThrow(/decimal places/);
  });

  it('accepts NUMERIC trailing zeros beyond the currency scale', async () => {
    const result = await client.query<{ amount: unknown }>("SELECT '12.3400'::numeric(10,4) AS amount");
    expect(fromNumericAmount(result.rows[0]?.amount, 'EUR').amount).toBe('12.34');
  });
});

describe('money column mapping (no database)', () => {
  it('refuses a JS number, e.g. from a float type parser', () => {
    expect(() => fromNumericAmount(1250.5, 'EUR')).toThrow(TypeError);
  });
});
