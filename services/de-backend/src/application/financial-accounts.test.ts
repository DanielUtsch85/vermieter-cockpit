import { describe, expect, it } from 'vitest';
import {
  planClose,
  type CreateOutcome,
  type FinancialAccount,
  type FinancialAccountId,
  type FinancialAccountRepository,
  type NewFinancialAccount,
} from '../domains/ledger/index.js';
import type { AuditActor } from '../shared/index.js';
import type { RealmPrincipal } from './access.js';
import {
  FinancialAccountNotFoundError,
  IdempotencyKeyConflictError,
  closeFinancialAccount,
  createFinancialAccount,
} from './financial-accounts.js';

const REALM = '64b0c0ffee0000000000000a';
const principal: RealmPrincipal = { email: 'anna@example.com', mreRealmId: REALM, mreRole: 'administrator' };
const created = new Date('2026-10-19T08:00:00Z');

/** In-memory repository with the same idempotency semantics as the PostgreSQL one. */
function memoryRepository() {
  const rows: FinancialAccount[] = [];
  const keys = new Map<string, { fingerprint: string; id: string }>();
  const audits: { action: string; actor: AuditActor }[] = [];
  const repository: FinancialAccountRepository = {
    create: async (draft: NewFinancialAccount, actor, idempotency): Promise<CreateOutcome> => {
      const keyId = idempotency && `${draft.mreRealmId}/${idempotency.key}`;
      const known = keyId === undefined ? undefined : keys.get(keyId);
      if (known !== undefined && idempotency !== undefined) {
        if (known.fingerprint !== idempotency.fingerprint) return { kind: 'IDEMPOTENCY_CONFLICT' };
        return { kind: 'REPLAYED', account: rows.find((r) => r.id === known.id) as FinancialAccount };
      }
      const account: FinancialAccount = {
        ...draft,
        id: `fa-${rows.length + 1}` as FinancialAccountId,
        status: 'OPEN',
        createdAt: created,
        closedAt: null,
        version: 1,
      };
      rows.push(account);
      audits.push({ action: 'CREATED', actor });
      if (keyId !== undefined && idempotency !== undefined) keys.set(keyId, { fingerprint: idempotency.fingerprint, id: account.id });
      return { kind: 'CREATED', account };
    },
    findById: async (id, realm) => rows.find((r) => r.id === id && r.mreRealmId === realm),
    close: async (id, realm, at, actor) => {
      const index = rows.findIndex((r) => r.id === id && r.mreRealmId === realm);
      const current = rows[index];
      if (current === undefined) return undefined;
      const { next, changed } = planClose(current, at);
      rows[index] = next;
      if (changed) audits.push({ action: 'CLOSED', actor });
      return next;
    },
  };
  return { repository, rows, audits };
}

const girokonto = { principal, accountType: 'BANK', displayName: 'Girokonto', currency: 'EUR', iban: 'DE89370400440532013000' } as const;

describe('createFinancialAccount', () => {
  it("creates an OPEN account in the caller's Realm, audited as the caller", async () => {
    const { repository, audits } = memoryRepository();
    const { account, replayed } = await createFinancialAccount({ repository })(girokonto);
    expect(replayed).toBe(false);
    expect(account).toMatchObject({ mreRealmId: REALM, accountType: 'BANK', status: 'OPEN', iban: 'DE89370400440532013000' });
    expect(audits).toEqual([{ action: 'CREATED', actor: { actorType: 'USER', actorId: 'anna@example.com' } }]);
  });

  it('without a key, every request creates an account', async () => {
    const { repository, rows } = memoryRepository();
    const create = createFinancialAccount({ repository });
    await create(girokonto);
    await create(girokonto);
    expect(rows).toHaveLength(2);
  });

  it('same key and payload: replays the original account, no second one', async () => {
    const { repository, rows } = memoryRepository();
    const create = createFinancialAccount({ repository });
    const first = await create({ ...girokonto, idempotencyKey: 'k-1' });
    const again = await create({ ...girokonto, idempotencyKey: 'k-1' });
    expect(again).toEqual({ account: first.account, replayed: true });
    expect(rows).toHaveLength(1);
  });

  it('same key, different payload: IdempotencyKeyConflictError', async () => {
    const { repository, rows } = memoryRepository();
    const create = createFinancialAccount({ repository });
    await create({ ...girokonto, idempotencyKey: 'k-1' });
    await expect(create({ ...girokonto, displayName: 'Tagesgeld', idempotencyKey: 'k-1' })).rejects.toBeInstanceOf(
      IdempotencyKeyConflictError,
    );
    expect(rows).toHaveLength(1);
  });
});

describe('closeFinancialAccount', () => {
  it('closes the account at now(), and a repeat is a no-op', async () => {
    const { repository, audits } = memoryRepository();
    const { account } = await createFinancialAccount({ repository })(girokonto);
    const at = new Date('2026-12-31T12:00:00Z');
    const close = closeFinancialAccount({ repository, now: () => at });
    expect(await close({ principal, financialAccountId: account.id })).toMatchObject({ status: 'CLOSED', closedAt: at, version: 2 });
    expect(await close({ principal, financialAccountId: account.id })).toMatchObject({ status: 'CLOSED', version: 2 });
    expect(audits.map((a) => a.action)).toEqual(['CREATED', 'CLOSED']);
  });

  it("another Realm's or an unknown account is not found", async () => {
    const { repository } = memoryRepository();
    const { account } = await createFinancialAccount({ repository })(girokonto);
    const close = closeFinancialAccount({ repository });
    const other = { ...principal, mreRealmId: '64b0c0ffee0000000000000b' };
    await expect(close({ principal: other, financialAccountId: account.id })).rejects.toBeInstanceOf(FinancialAccountNotFoundError);
    await expect(close({ principal, financialAccountId: 'fa-404' })).rejects.toBeInstanceOf(FinancialAccountNotFoundError);
  });
});
