import type pg from 'pg';

/**
 * Legacy data (api-design.md §58K K4, §58N open question 7; Entscheidung des Projektinhabers, 2026-11-04: „Testdaten
 * für Altbestand werden direkt als CONFIRMED eingefügt, nicht über den Übergang.“): an Acquisition confirmed before
 * VC-X-34 without `economicTransferDate`. Since 0067 no transition to `CONFIRMED` takes an undated row, also past the
 * repository, so the state the migration finds is **inserted**: in one transaction, exactly the three insert triggers
 * that refuse it are disabled (`acquisition_initial`, `acquisition_party_frozen`, `ownership_acquisition_draft`), the
 * Acquisition is inserted `CONFIRMED` with its parties and the buyers' Ownerships from the contract date (sellers' rows
 * named in `close` end the day before, closed first), the triggers are enabled again, and the row is held to §28.1's
 * requirements 1–6 as a confirmation before VC-X-34 was (`acquisition_confirmation_violation(id) IS NULL`, else the
 * whole transaction rolls back). Every other trigger (0019's invariants, the frozen guards) runs. Test support only.
 */
export interface LegacyAcquisition {
  readonly mreRealmId: string;
  readonly propertyReferenceId: string;
  readonly contractDate: string;
  readonly purchasePrice?: string;
  readonly acquiredShare?: readonly [number, number];
  /** Each buyer with the share of its Ownership carrying the Acquisition (from the contract date). */
  readonly buyers: readonly { readonly partyId: string; readonly share: readonly [number, number] }[];
  readonly sellerPartyIds?: readonly string[];
  /** `VALID` open Ownerships of the sellers closed on `contractDate − 1` before the insert. */
  readonly close?: readonly string[];
}

const DISABLED = [
  ['acquisition', 'acquisition_initial'],
  ['acquisition_party', 'acquisition_party_frozen'],
  ['ownership', 'ownership_acquisition_draft'],
] as const;

export async function insertConfirmedAsBeforeVcX34(pool: pg.Pool, a: LegacyAcquisition): Promise<{ acquisitionId: string; ownershipIds: string[] }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const id of a.close ?? []) {
      const { rowCount } = await client.query(`UPDATE ownership SET valid_until = $2::date - 1 WHERE id = $1 AND status = 'VALID' AND valid_until IS NULL`, [
        id,
        a.contractDate,
      ]);
      if (rowCount !== 1) throw new Error(`not an open VALID Ownership: ${id}`);
    }
    for (const [table, trigger] of DISABLED) await client.query(`ALTER TABLE ${table} DISABLE TRIGGER ${trigger}`);
    const [n, d] = a.acquiredShare ?? [1, 1];
    const { rows } = await client.query(
      `INSERT INTO acquisition (mre_realm_id, property_reference_id, status, purchase_price, currency, acquired_share_numerator,
         acquired_share_denominator, contract_date, confirmed_at, created_by, version)
       VALUES ($1, $2, 'CONFIRMED', $3, 'EUR', $4, $5, $6, now(), 'legacy (synthetisch)', 2) RETURNING id`,
      [a.mreRealmId, a.propertyReferenceId, a.purchasePrice ?? '300000.00', n, d, a.contractDate],
    );
    const acquisitionId = rows[0].id as string;
    const parties = [...a.buyers.map((b, i) => [b.partyId, 'BUYER', i + 1] as const), ...(a.sellerPartyIds ?? []).map((s, i) => [s, 'SELLER', i + 1] as const)];
    for (const [partyId, role, position] of parties) {
      await client.query(`INSERT INTO acquisition_party (acquisition_id, mre_realm_id, party_id, role, position) VALUES ($1, $2, $3, $4, $5)`, [
        acquisitionId,
        a.mreRealmId,
        partyId,
        role,
        position,
      ]);
    }
    const ownershipIds: string[] = [];
    for (const b of a.buyers) {
      const inserted = await client.query(
        `INSERT INTO ownership (mre_realm_id, property_reference_id, owner_party_id, share_numerator, share_denominator, valid_from, status, acquisition_id, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, 'VALID', $7, 'legacy (synthetisch)') RETURNING id`,
        [a.mreRealmId, a.propertyReferenceId, b.partyId, b.share[0], b.share[1], a.contractDate, acquisitionId],
      );
      ownershipIds.push(inserted.rows[0].id as string);
    }
    for (const [table, trigger] of DISABLED) await client.query(`ALTER TABLE ${table} ENABLE TRIGGER ${trigger}`);
    const violation = (await client.query(`SELECT acquisition_confirmation_violation($1) AS v`, [acquisitionId])).rows[0].v as string | null;
    if (violation !== null) throw new Error(`legacy Acquisition fails §28.1: ${violation}`);
    await client.query('COMMIT');
    return { acquisitionId, ownershipIds };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
