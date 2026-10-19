import type { Kysely, Selectable } from 'kysely';
import {
  planClose,
  type AccountStatus,
  type AccountType,
  type CreateOutcome,
  type FinancialAccount,
  type FinancialAccountId,
  type FinancialAccountRepository,
  type NewFinancialAccount,
} from '../../domains/ledger/index.js';
import type { AuditActor, CurrencyCode } from '../../shared/index.js';
import { writeAudit } from './audit.js';
import { claimIdempotencyKey, recordIdempotentResource } from './idempotency.js';
import type { Database, FinancialAccountTable } from './schema.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ENTITY_TYPE = 'FinancialAccount';
const CREATE_SCOPE = 'financial-account.create';

/** PostgreSQL implementation of the FinancialAccount persistence port. */
export class PostgresFinancialAccountRepository implements FinancialAccountRepository {
  constructor(private readonly db: Kysely<Database>) {}

  async create(
    account: NewFinancialAccount,
    actor: AuditActor,
    idempotency?: { readonly key: string; readonly fingerprint: string },
  ): Promise<CreateOutcome> {
    // READ COMMITTED explicitly: the idempotency claim relies on it (idempotency.ts).
    return this.db.transaction().setIsolationLevel('read committed').execute(async (trx) => {
      const keyed =
        idempotency === undefined
          ? undefined
          : {
              ref: { mreRealmId: account.mreRealmId, scope: CREATE_SCOPE, key: idempotency.key },
              fingerprint: idempotency.fingerprint,
            };
      if (keyed !== undefined) {
        const claim = await claimIdempotencyKey(trx, keyed.ref, keyed.fingerprint);
        if (claim.kind === 'CONFLICT') return { kind: 'IDEMPOTENCY_CONFLICT' };
        if (claim.kind === 'REPLAY') {
          const original = await trx
            .selectFrom('financial_account')
            .selectAll()
            .where('id', '=', claim.resourceId)
            .executeTakeFirstOrThrow();
          return { kind: 'REPLAYED', account: toDomain(original) };
        }
      }

      const inserted = await trx
        .insertInto('financial_account')
        .values({
          mre_realm_id: account.mreRealmId,
          account_type: account.accountType,
          display_name: account.displayName,
          currency: account.currency,
          iban: account.iban,
          status: 'OPEN' satisfies AccountStatus,
          created_by: actor.actorId,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      if (keyed !== undefined) await recordIdempotentResource(trx, keyed.ref, inserted.id);
      await writeAudit(trx, { type: ENTITY_TYPE, id: inserted.id }, 'CREATED', actor, {
        newVersion: inserted.version,
        metadata: { accountType: inserted.account_type, currency: inserted.currency },
      });
      return { kind: 'CREATED', account: toDomain(inserted) };
    });
  }

  async findById(id: string, mreRealmId: string): Promise<FinancialAccount | undefined> {
    if (!UUID.test(id)) return undefined;
    const row = await this.db
      .selectFrom('financial_account')
      .selectAll()
      .where('id', '=', id)
      .where('mre_realm_id', '=', mreRealmId)
      .executeTakeFirst();
    return row === undefined ? undefined : toDomain(row);
  }

  async close(id: FinancialAccountId, mreRealmId: string, at: Date, actor: AuditActor): Promise<FinancialAccount | undefined> {
    if (!UUID.test(id)) return undefined;
    return this.db.transaction().setIsolationLevel('read committed').execute(async (trx) => {
      const row = await trx
        .selectFrom('financial_account')
        .selectAll()
        .where('id', '=', id)
        .where('mre_realm_id', '=', mreRealmId)
        .forUpdate()
        .executeTakeFirst();
      if (row === undefined) return undefined;

      const current = toDomain(row);
      const { next, changed } = planClose(current, at);
      if (!changed) return current;
      const updated = await trx
        .updateTable('financial_account')
        .set({ status: next.status, closed_at: next.closedAt, version: next.version, updated_at: at })
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirstOrThrow();
      await writeAudit(trx, { type: ENTITY_TYPE, id }, 'CLOSED', actor, {
        previousVersion: current.version,
        newVersion: next.version,
        metadata: {},
      });
      return toDomain(updated);
    });
  }
}

function toDomain(row: Selectable<FinancialAccountTable>): FinancialAccount {
  return {
    id: row.id as FinancialAccountId,
    mreRealmId: row.mre_realm_id,
    accountType: row.account_type as AccountType,
    displayName: row.display_name,
    currency: row.currency as CurrencyCode,
    iban: row.iban,
    status: row.status as AccountStatus,
    createdAt: row.created_at,
    closedAt: row.closed_at,
    version: row.version,
  };
}
