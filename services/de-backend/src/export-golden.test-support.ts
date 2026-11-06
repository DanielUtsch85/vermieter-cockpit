import { readFileSync } from 'node:fs';
import type pg from 'pg';

/**
 * The synthetic example of api-design.md §58S ("Example (synthetic)"), seeded row by row with its fixed ids and times,
 * and the golden files cut from the spec's code blocks (`src/export-golden/`). Test support only; no real data.
 */
export const EXAMPLE_REALM = '6a1b2c3d4e5f60718293a4b5';
export const ACCOUNT_A = '0b1c2d3e-0000-4000-8000-000000000001';
export const P = '7e000000-0000-4000-8000-0000000000aa';
export const Q = '7e000000-0000-4000-8000-0000000000bb';
export const T1 = '5d2c0f1e-0000-4000-8000-000000000101';
export const T2 = '5d2c0f1e-0000-4000-8000-000000000102';
export const T3 = '5d2c0f1e-0000-4000-8000-000000000103';
export const OWNER = '0c000000-0000-4000-8000-000000000001';
export const DEPOSIT = '0d000000-0000-4000-8000-000000000001';
export const TENANT = '6c0000000000000000000001';
/** The example's generatedAt (the JSON's `generatedAt`; the CSV files carry no time). */
export const GENERATED_AT = new Date('2026-11-06T12:00:00.000Z');

export const golden = (name: string): Buffer => readFileSync(new URL(`./export-golden/${name}`, import.meta.url));

interface Booking {
  readonly id: string;
  readonly bookingDate: string;
  readonly valueDate: string | null;
  readonly direction: 'INFLOW' | 'OUTFLOW';
  readonly amount: string;
  readonly provenance: string;
  readonly description: string | null;
  readonly counterpartyName?: string;
  readonly counterpartyIban?: string;
  readonly createdAt: string;
  /** Confirmed at, by `vermieter@example.org`; unconfirmed without. */
  readonly confirmedAt?: string;
  readonly splits: readonly { readonly code: string; readonly amount: string; readonly propertyReferenceId: string | null }[];
  readonly account?: string;
}

/** A Transaction as the API leaves it: inserted unconfirmed (version 1), split, then confirmed (version 2). */
export async function book(pool: pg.Pool, realm: string, b: Booking): Promise<void> {
  await pool.query(
    `INSERT INTO ledger_transaction (id, mre_realm_id, financial_account_id, amount, currency, direction, booking_date, value_date, description,
       property_reference_id, provenance, status, created_at, created_by, counterparty_name_raw, counterparty_iban_raw)
     VALUES ($1, $2, $3, $4, 'EUR', $5, $6, $7, $8, NULL, $9, 'UNREVIEWED', $10, 'seed', $11, $12)`,
    [
      b.id,
      realm,
      b.account ?? ACCOUNT_A,
      b.amount,
      b.direction,
      b.bookingDate,
      b.valueDate,
      b.description,
      b.provenance,
      b.createdAt,
      b.counterpartyName ?? null,
      b.counterpartyIban ?? null,
    ],
  );
  for (const [i, s] of b.splits.entries()) {
    await pool.query(
      `INSERT INTO transaction_split (transaction_id, mre_realm_id, position, amount, currency, financial_category_id, property_reference_id, created_by)
       SELECT $1, $2, $3, $4, 'EUR', id, $6, 'seed' FROM financial_category WHERE code = $5`,
      [b.id, realm, i + 1, s.amount, s.code, s.propertyReferenceId],
    );
  }
  if (b.confirmedAt !== undefined) {
    await pool.query(
      `UPDATE ledger_transaction SET status = 'CONFIRMED', confirmed_at = $2, confirmed_by = 'vermieter@example.org', version = 2 WHERE id = $1`,
      [b.id, b.confirmedAt],
    );
  }
}

/** §58S's example in `realm`: account A, P and Q, T1–T3, the Ownership voided and recorded again, the deposit of a Tenant on P and Q. */
export async function seedExample(pool: pg.Pool, realm = EXAMPLE_REALM): Promise<void> {
  await pool.query(
    `INSERT INTO financial_account (id, mre_realm_id, account_type, display_name, currency, status, created_by) VALUES ($1, $2, 'BANK', 'Giro A', 'EUR', 'OPEN', 'seed')`,
    [ACCOUNT_A, realm],
  );
  for (const [id, mreId, name] of [
    [P, '6b0000000000000000000001', 'Musterstraße 1, Whg. 3'],
    [Q, '6b0000000000000000000002', 'Musterstraße 1, Whg. 4'],
  ] as const) {
    await pool.query(
      `INSERT INTO property_reference (id, mre_realm_id, mre_property_id, external_reference_state, display_name, cached_address, cached_surface,
         last_refreshed_at, last_observed_at, created_at, created_by)
       VALUES ($1, $2, $3, 'ACTIVE', $4, '{"street1": "Musterstraße 1", "city": "Berlin"}', '72.50', '2026-10-01T06:00:00Z', '2026-10-01T06:00:00Z',
         '2026-09-30T18:00:00Z', 'seed')`,
      [id, realm, mreId, name],
    );
  }
  await book(pool, realm, {
    id: T1,
    bookingDate: '2026-10-01',
    valueDate: '2026-10-01',
    direction: 'INFLOW',
    amount: '1250.00',
    provenance: 'BANK_CSV',
    description: 'Miete Oktober, Whg. 3 "EG links"',
    counterpartyName: 'Erika Mustermann',
    counterpartyIban: 'DE02120300000000202051',
    createdAt: '2026-10-02T08:15:00.000Z',
    confirmedAt: '2026-10-03T09:00:00.000Z',
    splits: [
      { code: 'RENT_BASE', amount: '1000.00', propertyReferenceId: P },
      { code: 'RENT_OPERATING_COST_ADVANCE', amount: '250.00', propertyReferenceId: P },
    ],
  });
  // §58S writes T2's split as `WEG_HAUSGELD`, which is no financial category (§33); the `WEG_*` codes need a WEG membership
  // of P, which the JSON example rules out (no membership). `OTHER_EXPENSE` stands in; the golden files have no split column.
  await book(pool, realm, {
    id: T2,
    bookingDate: '2026-10-05',
    valueDate: null,
    direction: 'OUTFLOW',
    amount: '312.40',
    provenance: 'MANUAL',
    description: 'Hausgeld 10/2026',
    createdAt: '2026-10-05T09:58:00.000Z',
    confirmedAt: '2026-10-05T10:00:00.000Z',
    splits: [{ code: 'OTHER_EXPENSE', amount: '312.40', propertyReferenceId: P }],
  });
  await book(pool, realm, {
    id: T3,
    bookingDate: '2026-10-07',
    valueDate: '2026-10-07',
    direction: 'INFLOW',
    amount: '50.00',
    provenance: 'BANK_CSV',
    description: '=HYPERLINK("http://x.example")',
    counterpartyName: '+Test',
    counterpartyIban: 'DE89370400440532013000',
    createdAt: '2026-10-08T07:30:00.000Z',
    splits: [],
  });

  // The Ownership: 1/2 by mistake, voided, recorded again as 1/1.
  await pool.query(
    `INSERT INTO party (id, mre_realm_id, party_type, display_name, first_name, last_name, status, created_at, created_by)
     VALUES ($1, $2, 'PERSON', 'Max Mustermann', 'Max', 'Mustermann', 'ACTIVE', '2026-09-30T17:55:00Z', 'seed')`,
    [OWNER, realm],
  );
  await pool.query(
    `INSERT INTO ownership (id, mre_realm_id, property_reference_id, owner_party_id, share_numerator, share_denominator, valid_from, status, voided_at,
       void_reason, created_at, created_by, version)
     VALUES ('0a000000-0000-4000-8000-000000000001', $1, $2, $3, 1, 2, '2026-01-01', 'VOID', '2026-09-30T18:05:00Z', '1/2 statt 1/1 erfasst',
       '2026-09-30T18:01:00Z', 'seed', 2)`,
    [realm, P, OWNER],
  );
  await pool.query(
    `INSERT INTO ownership (id, mre_realm_id, property_reference_id, owner_party_id, share_numerator, share_denominator, valid_from, status,
       source_references, created_at, created_by)
     VALUES ('0a000000-0000-4000-8000-000000000002', $1, $2, $3, 1, 1, '2026-01-01', 'VALID', ARRAY['Grundbuch von Mitte Blatt 1234, Abt. I Nr. 2'],
       '2026-09-30T18:06:00Z', 'seed')`,
    [realm, P, OWNER],
  );

  // The Tenant's rent, confirmed and reconciled on P and on Q (September, so outside the example's CSV filter).
  for (const [id, property, day] of [
    ['5d2c0f1e-0000-4000-8000-000000000091', P, '01'],
    ['5d2c0f1e-0000-4000-8000-000000000092', Q, '02'],
  ] as const) {
    await book(pool, realm, {
      id,
      bookingDate: `2026-09-${day}`,
      valueDate: null,
      direction: 'INFLOW',
      amount: '800.00',
      provenance: 'MANUAL',
      description: 'Miete September',
      createdAt: `2026-09-${day}T10:00:00.000Z`,
      confirmedAt: `2026-09-${day}T11:00:00.000Z`,
      splits: [{ code: 'RENT_BASE', amount: '800.00', propertyReferenceId: property }],
    });
    await pool.query(
      `INSERT INTO rent_payment_reconciliation (mre_realm_id, status, transaction_id, mre_tenant_id, mre_rent_term, matched_amount, currency, confirmed_at,
         confirmed_by, created_by)
       VALUES ($1, 'CONFIRMED', $2, $3, '2026090100', '800.00', 'EUR', now(), 'seed', 'seed')`,
      [realm, id, TENANT],
    );
  }
  await pool.query(
    `INSERT INTO security_deposit (id, mre_realm_id, status, mre_tenant_id, expected_amount, currency, expected_amount_source, interest_bearing, created_by)
     VALUES ($1, $2, 'ACTIVE', $3, '2400.00', 'EUR', 'REQUEST', true, 'seed')`,
    [DEPOSIT, realm, TENANT],
  );
}
