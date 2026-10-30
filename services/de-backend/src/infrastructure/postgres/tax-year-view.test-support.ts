import type pg from 'pg';

/**
 * The counter-check "no cash mutated" of the tax-year view (api-design.md §58C): every row of the tables the view
 * reads, with its `version` where it has one (whole rows, so a table without one is compared as well), and the count of
 * `audit_record`. Two snapshots taken around views must be equal.
 */
export const VIEW_TABLES = [
  'ledger_transaction',
  'transaction_split',
  'tax_classification',
  'security_deposit',
  'weg_annual_statement',
  'weg_special_assessment',
  'acquisition',
  'land_building_allocation',
  'ownership',
  'rental_contract_reference',
] as const;

export async function rowsSnapshot(pool: pg.Pool): Promise<Record<string, unknown>> {
  const snapshot: Record<string, unknown> = {};
  for (const table of VIEW_TABLES) {
    const { rows } = await pool.query(`SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY id`);
    snapshot[table] = rows.map((r: { row: unknown }) => r.row);
  }
  snapshot['audit_record'] = Number((await pool.query(`SELECT count(*) AS n FROM audit_record`)).rows[0].n);
  return snapshot;
}
