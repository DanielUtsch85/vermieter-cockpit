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
import { claimIdempotencyKey, recordIdempotentResult } from './idempotency.js';
import type { Database, FinancialAccountTable } from './schema.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ENTITY_TYPE = 'FinancialAccount';
const CREATE_SCOPE = 'financial-account.create';

/** PostgreSQL implementation of the FinancialAccount persistence port. */
export class PostgresFinancialAccountRepository implements FinancialAccountRepository {
  constructor(private readonly db: Kysely<Database>) {}

  async create(account: NewFinancialAccount, actor: AuditActor, idempotency?: { readonly key: string; readonly fingerprint: string }): Promise<CreateOutcome> {
    // READ COMMITTED explicitly: the idempotency claim relies on it (idempotency.ts).
    return this.db
      .transaction()
      .setIsolationLevel('read committed')
      .execute(async (trx) => {
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
          // The account as the first request created it, not as it is now (idempotency.ts).
          if (claim.kind === 'REPLAY') return { kind: 'REPLAYED', account: fromSnapshot(claim.result) };
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
        const created = toFinancialAccount(inserted);
        if (keyed !== undefined) await recordIdempotentResult(trx, keyed.ref, inserted.id, toSnapshot(created));
        await writeAudit(trx, { type: ENTITY_TYPE, id: inserted.id }, 'CREATED', actor, {
          newVersion: inserted.version,
          metadata: { accountType: inserted.account_type, currency: inserted.currency },
        });
        return { kind: 'CREATED', account: created };
      });
  }

  async findById(id: string, mreRealmId: string): Promise<FinancialAccount | undefined> {
    if (!UUID.test(id)) return undefined;
    const row = await this.db.selectFrom('financial_account').selectAll().where('id', '=', id).where('mre_realm_id', '=', mreRealmId).executeTakeFirst();
    return row === undefined ? undefined : toFinancialAccount(row);
  }

  async close(id: FinancialAccountId, mreRealmId: string, at: Date, actor: AuditActor): Promise<FinancialAccount | undefined> {
    if (!UUID.test(id)) return undefined;
    return this.db
      .transaction()
      .setIsolationLevel('read committed')
      .execute(async (trx) => {
        const row = await trx
          .selectFrom('financial_account')
          .selectAll()
          .where('id', '=', id)
          .where('mre_realm_id', '=', mreRealmId)
          .forUpdate()
          .executeTakeFirst();
        if (row === undefined) return undefined;

        const current = toFinancialAccount(row);
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
        return toFinancialAccount(updated);
      });
  }
}

export function toFinancialAccount(row: Selectable<FinancialAccountTable>): FinancialAccount {
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

/** The created account as JSON for the idempotency store; dates as ISO strings. */
interface AccountSnapshot {
  readonly id: string;
  readonly mreRealmId: string;
  readonly accountType: string;
  readonly displayName: string;
  readonly currency: string;
  readonly iban: string | null;
  readonly status: string;
  readonly createdAt: string;
  readonly closedAt: string | null;
  readonly version: number;
}

function toSnapshot(account: FinancialAccount): AccountSnapshot {
  return { ...account, createdAt: account.createdAt.toISOString(), closedAt: account.closedAt?.toISOString() ?? null };
}

/** Written by toSnapshot in the same codebase, so its shape is trusted. */
function fromSnapshot(result: unknown): FinancialAccount {
  const snapshot = result as AccountSnapshot;
  return {
    id: snapshot.id as FinancialAccountId,
    mreRealmId: snapshot.mreRealmId,
    accountType: snapshot.accountType as AccountType,
    displayName: snapshot.displayName,
    currency: snapshot.currency as CurrencyCode,
    iban: snapshot.iban,
    status: snapshot.status as AccountStatus,
    createdAt: new Date(snapshot.createdAt),
    closedAt: snapshot.closedAt === null ? null : new Date(snapshot.closedAt),
    version: snapshot.version,
  };
}
