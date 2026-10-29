import type {
  BankStatementAdapter,
  ConflictingTransaction,
  FinancialAccountRepository,
  ImportBatch,
  ImportRepository,
  ReviewItem,
  ReviewResolution,
  StatementAccountMismatch,
  StatementError,
} from '../domains/ledger/index.js';
import { checkStatementAccount } from '../domains/ledger/index.js';
import type { RealmPrincipal } from './access.js';
import { FinancialAccountNotFoundError } from './financial-accounts.js';
import { FinancialAccountClosedError } from './transactions.js';

/**
 * Bank import (api-design.md §32.1, backlog VC-1-05/06): parses an uploaded
 * statement with the named adapter and hands the normalized rows to the
 * ledger, which decides each row per data-model.md §70. Adapters are injected
 * by the composition root; the application never knows a file format.
 */

/** No adapter with this id and version (→ 400). */
export class UnsupportedAdapterError extends Error {
  override readonly name = 'UnsupportedAdapterError';

  constructor(
    readonly adapterId: string,
    readonly adapterVersion: string,
  ) {
    super(`No bank-statement adapter ${adapterId}@${adapterVersion}`);
  }
}

/** The file as a whole cannot be read; nothing was imported (→ 400). */
export class ImportFileError extends Error {
  override readonly name = 'ImportFileError';

  constructor(readonly error: StatementError) {
    super(error.message);
  }
}

/** The file names another account than the FinancialAccount, or cannot be checked (#107); nothing was imported (→ 422). */
export class ImportAccountMismatchError extends Error {
  override readonly name = 'ImportAccountMismatchError';

  constructor(
    readonly reason: StatementAccountMismatch,
    readonly accountIban: string | null,
    readonly fileIbans: readonly string[],
  ) {
    super(`The file's account does not match the FinancialAccount (${reason})`);
  }
}

export interface ImportBankStatementInput {
  readonly principal: RealmPrincipal;
  readonly financialAccountId: string;
  readonly adapterId: string;
  readonly adapterVersion: string;
  /** Adapter-specific options (e.g. a column mapping), validated by the adapter. */
  readonly options: unknown;
  readonly file: Uint8Array;
  readonly sourceFilename: string | null;
}

export type ImportBankStatement = (input: ImportBankStatementInput) => Promise<ImportBatch>;

export interface ImportBankStatementDeps {
  readonly imports: ImportRepository;
  readonly accounts: FinancialAccountRepository;
  readonly findAdapter: (id: string, version: string) => BankStatementAdapter | undefined;
}

export function importBankStatement(deps: ImportBankStatementDeps): ImportBankStatement {
  return async ({ principal, financialAccountId, adapterId, adapterVersion, options, file, sourceFilename }) => {
    const adapter = deps.findAdapter(adapterId, adapterVersion);
    if (adapter === undefined) throw new UnsupportedAdapterError(adapterId, adapterVersion);
    // The adapter needs the account currency; the repository re-reads the account under its lock.
    const account = await deps.accounts.findById(financialAccountId, principal.mreRealmId);
    if (account === undefined) throw new FinancialAccountNotFoundError(financialAccountId);

    const parsed = adapter.parse(file, options, account.currency);
    if ('error' in parsed) throw new ImportFileError(parsed.error);
    const mismatch = checkStatementAccount(account.iban, parsed.statement);
    if (mismatch !== undefined) throw new ImportAccountMismatchError(mismatch, account.iban, parsed.statement.accountIbans ?? []);

    const outcome = await deps.imports.importStatement(
      {
        mreRealmId: principal.mreRealmId,
        financialAccountId: account.id,
        statement: parsed.statement,
        provenance: adapter.provenance,
        sourceFilename,
      },
      { actorType: 'USER', actorId: principal.email },
    );
    if (outcome.kind === 'ACCOUNT_NOT_FOUND') throw new FinancialAccountNotFoundError(financialAccountId);
    return outcome.batch;
  };
}

export class ImportBatchNotFoundError extends Error {
  override readonly name = 'ImportBatchNotFoundError';

  constructor(readonly importBatchId: string) {
    super(`ImportBatch ${importBatchId} not found`);
  }
}

export type GetImportBatch = (input: { readonly principal: RealmPrincipal; readonly importBatchId: string }) => Promise<ImportBatch>;

export function getImportBatch(deps: { readonly imports: ImportRepository }): GetImportBatch {
  return async ({ principal, importBatchId }) => {
    const batch = await deps.imports.findBatch(importBatchId, principal.mreRealmId);
    if (batch === undefined) throw new ImportBatchNotFoundError(importBatchId);
    return batch;
  };
}

export type ListReviewItems = (input: {
  readonly principal: RealmPrincipal;
  readonly importBatchId: string;
  readonly status?: ReviewItem['status'];
}) => Promise<{ readonly items: readonly ReviewItem[]; readonly conflicting: readonly ConflictingTransaction[] }>;

/** List review items (api-design.md §32.3): only those owned by the batch. */
export function listReviewItems(deps: { readonly imports: ImportRepository }): ListReviewItems {
  return async ({ principal, importBatchId, status }) => {
    const listed = await deps.imports.listReviewItems(importBatchId, principal.mreRealmId, status);
    if (listed === undefined) throw new ImportBatchNotFoundError(importBatchId);
    return listed;
  };
}

export class ReviewItemNotFoundError extends Error {
  override readonly name = 'ReviewItemNotFoundError';

  constructor(readonly reviewItemId: string) {
    super(`ImportReviewItem ${reviewItemId} not found`);
  }
}

/** The item is already RESOLVED with the other resolution (→ 409): a decision is never silently reversed. */
export class ReviewResolutionConflictError extends Error {
  override readonly name = 'ReviewResolutionConflictError';

  constructor(readonly item: ReviewItem) {
    super(`ImportReviewItem ${item.id} is already resolved as ${item.resolution ?? ''}`);
  }
}

export interface ResolveReviewItemResult {
  readonly item: ReviewItem;
  /** true when the item was already resolved the same way (a 200 no-op). */
  readonly replayed: boolean;
}

export type ResolveReviewItem = (input: {
  readonly principal: RealmPrincipal;
  readonly importBatchId: string;
  readonly reviewItemId: string;
  readonly resolution: ReviewResolution;
}) => Promise<ResolveReviewItemResult>;

/** Resolve an ambiguous review item (api-design.md §32.2). */
export function resolveReviewItem(deps: { readonly imports: ImportRepository }): ResolveReviewItem {
  return async ({ principal, importBatchId, reviewItemId, resolution }) => {
    const outcome = await deps.imports.resolveReviewItem(importBatchId, reviewItemId, principal.mreRealmId, resolution, {
      actorType: 'USER',
      actorId: principal.email,
    });
    switch (outcome.kind) {
      case 'RESOLVED':
        return { item: outcome.item, replayed: outcome.replayed };
      case 'NOT_FOUND':
        throw new ReviewItemNotFoundError(reviewItemId);
      case 'RESOLUTION_CONFLICT':
        throw new ReviewResolutionConflictError(outcome.item);
      case 'ACCOUNT_CLOSED':
        throw new FinancialAccountClosedError(outcome.item.financialAccountId);
    }
  };
}
