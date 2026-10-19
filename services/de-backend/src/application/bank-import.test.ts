import { describe, expect, it } from 'vitest';
import type {
  BankStatementAdapter,
  FinancialAccount,
  FinancialAccountRepository,
  ImportBatch,
  ImportOutcome,
  ImportRepository,
  NewImport,
  ParsedStatement,
} from '../domains/ledger/index.js';
import type { AuditActor } from '../shared/index.js';
import type { RealmPrincipal } from './access.js';
import { ImportBatchNotFoundError, ImportFileError, UnsupportedAdapterError, getImportBatch, importBankStatement } from './bank-import.js';
import { FinancialAccountNotFoundError } from './financial-accounts.js';

const REALM = '64b0c0ffee0000000000000a';
const ACCOUNT = '0b6f1f9e-2f2c-4a8e-9d55-1f0d8c1e2a3b';
const principal: RealmPrincipal = { email: 'anna@example.com', mreRealmId: REALM, mreRole: 'administrator' };
const account = { id: ACCOUNT, mreRealmId: REALM, currency: 'EUR', status: 'OPEN' } as unknown as FinancialAccount;
const statement: ParsedStatement = { adapterId: 'generic-csv', adapterVersion: '1', contentHash: 'abc', sourceStatementId: null, rows: [] };
const batch = { id: 'batch-1' } as unknown as ImportBatch;
const input = {
  principal,
  financialAccountId: ACCOUNT,
  adapterId: 'generic-csv',
  adapterVersion: '1',
  options: { columnMapping: {} },
  file: new Uint8Array([1, 2, 3]),
  sourceFilename: 'umsatz.csv',
};

function setup(overrides: { parse?: BankStatementAdapter['parse']; account?: FinancialAccount; outcome?: ImportOutcome } = {}) {
  const parseCalls: unknown[][] = [];
  const imported: { input: NewImport; actor: AuditActor }[] = [];
  const adapter: BankStatementAdapter = {
    id: 'generic-csv',
    version: '1',
    provenance: 'BANK_CSV',
    parse: (...args) => {
      parseCalls.push(args);
      return overrides.parse ? overrides.parse(...args) : { statement };
    },
  };
  const imports: ImportRepository = {
    importStatement: async (i, actor) => {
      imported.push({ input: i, actor });
      return overrides.outcome ?? { kind: 'IMPORTED', batch };
    },
    findBatch: async (id, realm) => (id === 'batch-1' && realm === REALM ? batch : undefined),
  };
  const accounts = {
    findById: async (id: string, realm: string) => (id === ACCOUNT && realm === REALM ? (overrides.account ?? account) : undefined),
  } as unknown as FinancialAccountRepository;
  const run = importBankStatement({
    imports,
    accounts,
    findAdapter: (id, version) => (id === 'generic-csv' && version === '1' ? adapter : undefined),
  });
  return { run, imports, parseCalls, imported };
}

describe('importBankStatement', () => {
  it('parses with the account currency and imports in the caller Realm with the adapter provenance', async () => {
    const { run, parseCalls, imported } = setup();
    expect(await run(input)).toBe(batch);
    expect(parseCalls).toEqual([[input.file, input.options, 'EUR']]);
    expect(imported).toEqual([
      {
        input: { mreRealmId: REALM, financialAccountId: ACCOUNT, statement, provenance: 'BANK_CSV', sourceFilename: 'umsatz.csv' },
        actor: { actorType: 'USER', actorId: 'anna@example.com' },
      },
    ]);
  });

  it('refuses an unknown adapter or version before touching the account', async () => {
    const { run, parseCalls } = setup();
    await expect(run({ ...input, adapterVersion: '2' })).rejects.toBeInstanceOf(UnsupportedAdapterError);
    expect(parseCalls).toHaveLength(0);
  });

  it('an unknown or foreign account is not found, also when it vanishes before the import', async () => {
    await expect(setup().run({ ...input, principal: { ...principal, mreRealmId: 'other' } })).rejects.toBeInstanceOf(
      FinancialAccountNotFoundError,
    );
    await expect(setup({ outcome: { kind: 'ACCOUNT_NOT_FOUND' } }).run(input)).rejects.toBeInstanceOf(FinancialAccountNotFoundError);
  });

  it('a file-level adapter error imports nothing', async () => {
    const { run, imported } = setup({ parse: () => ({ error: { code: 'EMPTY', message: 'no rows' } }) });
    const error = await run(input).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ImportFileError);
    expect((error as ImportFileError).error).toEqual({ code: 'EMPTY', message: 'no rows' });
    expect(imported).toHaveLength(0);
  });
});

describe('getImportBatch', () => {
  it('returns the Realm’s batch; anything else is not found', async () => {
    const { imports } = setup();
    const get = getImportBatch({ imports });
    expect(await get({ principal, importBatchId: 'batch-1' })).toBe(batch);
    await expect(get({ principal: { ...principal, mreRealmId: 'other' }, importBatchId: 'batch-1' })).rejects.toBeInstanceOf(
      ImportBatchNotFoundError,
    );
  });
});
