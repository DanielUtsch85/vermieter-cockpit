import type { Kysely } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll } from 'vitest';
import type { NewCostClassification } from '../../domains/acquisition/index.js';
import { Money, type BusinessDate } from '../../shared/index.js';
import { PostgresAcquisitionCostClassificationRepository } from './acquisition-cost-classification-repository.js';
import { PostgresAcquisitionCostRepository } from './acquisition-cost-repository.js';
import { PostgresAcquisitionRepository } from './acquisition-repository.js';
import { createDatabase } from './database.js';
import { migrateToLatest } from './migrate.js';
import { PostgresPartyRepository } from './party-repository.js';
import type { Database } from './schema.js';
import { testSchemaName } from './test-schema.test-support.js';

/**
 * The fixtures of the classification tests (api-design.md §59D, migration 0054): a schema of their own, Acquisitions and
 * costs written through their repositories, raw inserts past the repository, and the lock helpers. Synthetic data.
 * Test support only.
 */
export const databaseUrl = process.env['DE_TEST_DATABASE_URL'];
export const REALM = '64b0c0ffee00000000000901';
export const OTHER_REALM = '64b0c0ffee00000000000902';
export const actor = { actorType: 'USER', actorId: 'anna@example.com' } as const;
export const eur = (amount: string) => Money.of(amount, 'EUR');
const day = (value: string) => value as BusinessDate;

export async function waitUntil(condition: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error('condition not reached');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** The message a statement fails with, or `accepted`. */
export const messageOf = (statement: Promise<unknown>) =>
  statement.then(
    () => 'accepted',
    (error: { message?: string }) => error.message,
  );

export interface ClassificationContext {
  pool: pg.Pool;
  acquisitions: PostgresAcquisitionRepository;
  costs: PostgresAcquisitionCostRepository;
  classifications: PostgresAcquisitionCostClassificationRepository;
  /** A Party of the Realm. */
  party(name: string, realm?: string): Promise<string>;
  /** A DRAFT Acquisition with the transfer date 2026-08-01. */
  acquisition(realm?: string): Promise<string>;
  /** An `ACTIVE` cost of the Acquisition. */
  cost(acquisitionId: string, category: string, amount: string, realm?: string): Promise<string>;
  /** Confirms a DRAFT (its buyer's Ownership written first). */
  confirm(acquisitionId: string): Promise<void>;
  /** A raw classification and its parts in one transaction (past the repository); the id. */
  rawClassify(
    client: Queryable,
    acquisitionId: string,
    costId: string,
    parts: readonly (readonly [string, string])[],
    set?: Record<string, unknown>,
  ): Promise<string>;
  inTransaction<T>(work: (c: pg.PoolClient) => Promise<T>): Promise<T>;
  /** Runs `waiter` while `hold` keeps its transaction open, until `waiter` waits on a lock of `lockText`. */
  whileHeld<T>(hold: (client: pg.PoolClient) => Promise<unknown>, waiter: () => Promise<T>, lockText: string): Promise<T>;
}

export type Queryable = Pick<pg.PoolClient, 'query'>;

/** Registers the schema's `beforeAll`/`afterAll` in the calling `describe` and returns the context (filled once ready). */
export function useClassificationDatabase(name: `${string}_test`): ClassificationContext {
  const schema = testSchemaName(name);
  let counter = 0;
  const ctx = {} as ClassificationContext;
  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: databaseUrl });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.end();
    const pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema} -c application_name=${schema}`, max: 10 });
    await migrateToLatest(pool, { migrationTableSchema: schema });
    const db = createDatabase(pool);
    const parties = new PostgresPartyRepository(db);
    ctx.pool = pool;
    ctx.acquisitions = new PostgresAcquisitionRepository(db);
    ctx.costs = new PostgresAcquisitionCostRepository(db);
    ctx.classifications = new PostgresAcquisitionCostClassificationRepository(db);
    ctx.party = async (displayName, realm = REALM) => {
      const outcome = await parties.create(
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
    ctx.acquisition = async (realm = REALM) => {
      const mrePropertyId = (0x6512f0c2a1b2c3d4e5fc0000n + BigInt(++counter)).toString(16).padStart(24, '0');
      const { rows } = await pool.query(
        `INSERT INTO property_reference (mre_realm_id, mre_property_id, external_reference_state, created_by) VALUES ($1, $2, 'ACTIVE', 'x') RETURNING id`,
        [realm, mrePropertyId],
      );
      const outcome = await ctx.acquisitions.create(
        {
          mreRealmId: realm,
          propertyReferenceId: rows[0].id as string,
          purchasePrice: eur('300000.00'),
          acquiredShare: { numerator: 1, denominator: 1 },
          contractDate: day('2026-06-15'),
          economicTransferDate: day('2026-08-01'),
          landRegistryTransferDate: null,
          buyerPartyIds: [await ctx.party('Käuferin', realm)],
          sellerPartyIds: [],
          sourceReferences: [],
          notes: null,
        },
        actor,
      );
      if (outcome.kind !== 'CREATED') throw new Error(outcome.kind);
      return outcome.acquisition.id;
    };
    ctx.cost = async (acquisitionId, category, amount, realm = REALM) => {
      const outcome = await ctx.costs.createCost(
        {
          mreRealmId: realm,
          acquisitionId,
          category: category as never,
          amount: eur(amount),
          incurredDate: null,
          counterpartyPartyId: null,
          sourceReferences: [],
          notes: null,
        },
        actor,
      );
      if (outcome.kind !== 'CREATED') throw new Error(outcome.kind);
      return outcome.cost.id;
    };
    ctx.confirm = async (acquisitionId) => {
      await pool.query(
        `INSERT INTO ownership (mre_realm_id, property_reference_id, owner_party_id, share_numerator, share_denominator, valid_from, status, acquisition_id, created_by)
         SELECT a.mre_realm_id, a.property_reference_id, ap.party_id, 1, 1, a.economic_transfer_date, 'VALID', a.id, 'x'
           FROM acquisition a JOIN acquisition_party ap ON ap.acquisition_id = a.id AND ap.role = 'BUYER' WHERE a.id = $1`,
        [acquisitionId],
      );
      const outcome = await ctx.acquisitions.confirm(acquisitionId, REALM, new Date(), actor);
      if (outcome.kind !== 'CONFIRMED') throw new Error(outcome.kind);
    };
    ctx.rawClassify = async (client, acquisitionId, costId, parts, set = {}) => {
      const values: Record<string, unknown> = {
        mre_realm_id: REALM,
        acquisition_id: acquisitionId,
        cost_id: costId,
        description: 'Notarrechnung (synthetisch)',
        review_state: 'CONFIRMED',
        created_by: 'x',
        ...set,
      };
      const keys = Object.keys(values);
      const { rows } = await client.query(
        `INSERT INTO acquisition_cost_classification (${keys.join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
        Object.values(values),
      );
      const id = rows[0].id as string;
      for (const [i, [purpose, amount]] of parts.entries()) {
        await client.query(
          `INSERT INTO acquisition_cost_classification_part (classification_id, position, purpose, amount, currency) VALUES ($1, $2, $3, $4, 'EUR')`,
          [id, i + 1, purpose, amount],
        );
      }
      return id;
    };
    ctx.inTransaction = async (work) => {
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        const result = await work(c);
        await c.query('COMMIT');
        return result;
      } catch (error) {
        await c.query('ROLLBACK');
        throw error;
      } finally {
        c.release();
      }
    };
    const waitForLock = (text: string) =>
      waitUntil(
        async () =>
          Number(
            (
              await pool.query(
                `SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND application_name = current_setting('application_name') AND query LIKE $1`,
                [`%${text}%`],
              )
            ).rows[0].count,
          ) >= 1,
      );
    ctx.whileHeld = async (hold, waiter, lockText) => {
      const holder = await pool.connect();
      try {
        await holder.query('BEGIN');
        await hold(holder);
        const waiting = waiter();
        await waitForLock(lockText);
        await holder.query('COMMIT');
        return await waiting;
      } finally {
        holder.release();
      }
    };
  });
  afterAll(async () => {
    await ctx.pool?.end();
  });
  return ctx;
}

/** A classification as entered through the repository (one `OWNERSHIP_TRANSFER` part of the amount by default). */
export const entered = (
  acquisitionId: string,
  costId: string,
  supersedes: string | null,
  overrides: Partial<NewCostClassification> = {},
  amount = '2000.00',
): NewCostClassification => ({
  mreRealmId: REALM,
  acquisitionId,
  costId,
  parts: [{ purpose: 'OWNERSHIP_TRANSFER', amount: eur(amount) }],
  description: 'Notar Kaufvertrag (synthetisch)',
  sourceReferences: ['Rechnung 0000-SYN'],
  reviewState: 'CONFIRMED',
  advisorPartyId: null,
  notes: null,
  supersedes,
  ...overrides,
});

/**
 * §59D in other tests' fixtures: a confirmed classification of the whole cost as `OWNERSHIP_TRANSFER`, so a `NOTARY`,
 * `LAND_REGISTRY` or `OTHER` cost counts as before (the figures unchanged). Returns the classification's id.
 */
export async function classifyAsTransfer(
  db: Kysely<Database>,
  c: { readonly mreRealmId: string; readonly acquisitionId: string; readonly costId: string; readonly amount: string },
): Promise<string> {
  const outcome = await new PostgresAcquisitionCostClassificationRepository(db).create(
    {
      ...entered(c.acquisitionId, c.costId, null, {}, c.amount),
      mreRealmId: c.mreRealmId,
      description: 'Kosten der Eigentumsübertragung (synthetisch)',
    },
    actor,
  );
  if (outcome.kind !== 'CREATED') throw new Error(outcome.kind);
  return outcome.classification.id;
}
