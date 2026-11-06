import pg from 'pg';
import { afterAll, beforeAll } from 'vitest';
import type { AlignOwnershipsInput } from '../../domains/acquisition/index.js';
import type { BusinessDate } from '../../shared/index.js';
import { PostgresAcquisitionRepository } from './acquisition-repository.js';
import { createDatabase } from './database.js';
import { insertConfirmedAsBeforeVcX34 } from './legacy-acquisition.test-support.js';
import { migrateToLatest } from './migrate.js';
import { PostgresPartyRepository } from './party-repository.js';
import { testSchemaName } from './test-schema.test-support.js';

/**
 * Test support of §58Q (VC-X-55, migration 0072) through PostgreSQL: a migrated schema of its own, Parties, the
 * example's legacy data (§58Q "Example (synthetic)": S held P since 2015 by W; L, contract 2025-03-01, confirmed before
 * VC-X-34, sold it to A; §58N recorded the transfer 2025-05-01) and raw reads. Synthetic values only.
 */
export const databaseUrl = process.env['DE_TEST_DATABASE_URL'];
export const REALM = '64b0c0ffee0000000000055a';
export const OTHER_REALM = '64b0c0ffee0000000000055b';
export const actor = { actorType: 'USER', actorId: 'anna@example.com' } as const;
export const day = (value: string) => value as BusinessDate;
export const AT = new Date('2026-02-10T10:00:00Z');
export const EVIDENCE = ['Übergabeprotokoll 2025-05-01, Abschnitt 2 (synthetisch)'];
export const ALIGN: AlignOwnershipsInput = { sourceReferences: EVIDENCE, notes: null };

/** One `VALID` 1/1 or given-share Ownership inserted past the repository (every guard runs). */
export interface RawOwnership {
  readonly owner: string;
  readonly share?: readonly [number, number];
  readonly from: string;
  readonly until?: string | null;
  readonly acquisitionId?: string | null;
}

export function useAlignSchema(name: `${string}_test`) {
  const schema = testSchemaName(name);
  const ctx = {} as { pool: pg.Pool; acquisitions: PostgresAcquisitionRepository; parties: PostgresPartyRepository; schema: string };
  let counter = 0;
  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: databaseUrl });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.end();
    ctx.pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 8 });
    await migrateToLatest(ctx.pool, { migrationTableSchema: schema });
    const db = createDatabase(ctx.pool);
    ctx.acquisitions = new PostgresAcquisitionRepository(db);
    ctx.parties = new PostgresPartyRepository(db);
    ctx.schema = schema;
  });
  afterAll(async () => {
    await ctx.pool.end();
  });

  const propertyReference = async (realm = REALM): Promise<string> => {
    const mrePropertyId = (0x6512f0c2a1b2c3d4e5f50000n + BigInt(++counter)).toString(16).padStart(24, '0');
    const { rows } = await ctx.pool.query(
      `INSERT INTO property_reference (mre_realm_id, mre_property_id, external_reference_state, created_by) VALUES ($1, $2, 'ACTIVE', 'x') RETURNING id`,
      [realm, mrePropertyId],
    );
    return rows[0].id as string;
  };
  const party = async (displayName: string, realm = REALM): Promise<string> => {
    const outcome = await ctx.parties.create(
      {
        mreRealmId: realm,
        partyType: 'PERSON',
        displayName,
        firstName: null,
        lastName: null,
        legalName: null,
        registrationNumber: null,
        email: null,
        phone: null,
      },
      actor,
    );
    if (outcome.kind !== 'CREATED') throw new Error(outcome.kind);
    return outcome.party.id;
  };
  const own = async (pr: string, o: RawOwnership, realm = REALM): Promise<string> =>
    (
      await ctx.pool.query(
        `INSERT INTO ownership (mre_realm_id, property_reference_id, owner_party_id, share_numerator, share_denominator, valid_from, valid_until, status, acquisition_id, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'VALID', $8, 'x') RETURNING id`,
        [realm, pr, o.owner, o.share?.[0] ?? 1, o.share?.[1] ?? 1, o.from, o.until ?? null, o.acquisitionId ?? null],
      )
    ).rows[0].id as string;
  const recordDate = async (id: string, date: string, realm = REALM) => {
    const outcome = await ctx.acquisitions.recordEconomicTransferDate({
      id,
      mreRealmId: realm,
      record: { economicTransferDate: day(date), sourceReferences: ['Übergabeprotokoll (synthetisch)'], notes: null },
      at: new Date('2026-01-15T10:00:00Z'),
      actor,
    });
    if (outcome.kind !== 'RECORDED') throw new Error(outcome.kind);
    return outcome.acquisition;
  };
  /**
   * The example: W (S from 2015-06-01, legacy), L (A from 2025-03-01 by L, S's row closed on 2025-02-28), the transfer
   * of L recorded as `transfer` (default 2025-05-01). `contract` moves both dates of L.
   */
  const example = async (o: { realm?: string; contract?: string; transfer?: string | null } = {}) => {
    const realm = o.realm ?? REALM;
    const contract = o.contract ?? '2025-03-01';
    const pr = await propertyReference(realm);
    const [s, a] = [await party('Verkäufer S (synthetisch)', realm), await party('Käuferin A (synthetisch)', realm)];
    const w = await insertConfirmedAsBeforeVcX34(ctx.pool, {
      mreRealmId: realm,
      propertyReferenceId: pr,
      contractDate: '2015-06-01',
      buyers: [{ partyId: s, share: [1, 1] }],
    });
    const l = await insertConfirmedAsBeforeVcX34(ctx.pool, {
      mreRealmId: realm,
      propertyReferenceId: pr,
      contractDate: contract,
      purchasePrice: '200000.00',
      buyers: [{ partyId: a, share: [1, 1] }],
      sellerPartyIds: [s],
      close: w.ownershipIds,
    });
    if (o.transfer !== null) await recordDate(l.acquisitionId, o.transfer ?? '2025-05-01', realm);
    return { pr, s, a, w: w.acquisitionId, l: l.acquisitionId, oS: w.ownershipIds[0] as string, oA: l.ownershipIds[0] as string };
  };
  const align = (id: string, o: { realm?: string; expectedVersions?: number[]; key?: string; input?: AlignOwnershipsInput; at?: Date } = {}) =>
    ctx.acquisitions.alignOwnershipsToTransfer({
      id,
      mreRealmId: o.realm ?? REALM,
      align: o.input ?? ALIGN,
      at: o.at ?? AT,
      actor,
      ...(o.expectedVersions === undefined ? {} : { expectedVersions: o.expectedVersions }),
      ...(o.key === undefined ? {} : { idempotency: { key: o.key, fingerprint: JSON.stringify(o.input ?? ALIGN) } }),
    });
  /** The rows as `[id, owner, from, until, version]`, by id. */
  const periods = async (pr: string) =>
    (
      await ctx.pool.query(
        `SELECT id, owner_party_id AS owner, to_char(valid_from, 'YYYY-MM-DD') AS f, to_char(valid_until, 'YYYY-MM-DD') AS u, version FROM ownership WHERE property_reference_id = $1 ORDER BY id`,
        [pr],
      )
    ).rows.map((r) => [r.id, r.owner, r.f, r.u, r.version]);
  const acquisitionRow = async (id: string) =>
    (await ctx.pool.query(`SELECT to_jsonb(a) - 'updated_at' AS r FROM acquisition a WHERE id = $1`, [id])).rows[0]?.r;
  const audits = async (ids: readonly string[]) =>
    (
      await ctx.pool.query(
        `SELECT entity_type, entity_id, action, previous_version, new_version, metadata FROM audit_record WHERE entity_id = ANY($1) ORDER BY occurred_at, id`,
        [ids],
      )
    ).rows;
  /** One statement list in its own transaction, committed; the error's code and message, or `committed`. */
  const inTransaction = async (statements: readonly (readonly [string, readonly unknown[]])[]): Promise<string> => {
    const client = await ctx.pool.connect();
    try {
      await client.query('BEGIN');
      for (const [text, params] of statements) await client.query(text, [...params]);
      await client.query('COMMIT');
      return 'committed';
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      const e = error as { code?: string; message?: string };
      return `${e.code}: ${e.message}`;
    } finally {
      client.release();
    }
  };
  return { ctx, propertyReference, party, own, recordDate, example, align, periods, acquisitionRow, audits, inTransaction };
}
