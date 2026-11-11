import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ImportBatchDto, ReviewItemDto } from '../api/imports';
import type {
  RentReconciliationDto,
  RentReconciliationReadDto,
  SuggestResultDto,
  TermCoverageDto,
  TransactionRentCoverageDto,
} from '../api/rent-reconciliations';
import type { TransactionDto, TransactionSplitDto, TransactionSplitsDto } from '../api/transactions';

/**
 * The backend's own DTO mappings and request schemas, loaded in the test only (ui-guide.md §12: API mocks derived only
 * from the real DTO mappings). The fake backend of the Durchstich keeps its state as the backend's domain objects
 * (`Money`, `Date`) and answers every read and command through these functions, so an answer the cockpit sees has
 * exactly the shape the routes send; every request body it receives is checked with the route's own schema. The bundle
 * takes nothing of this: it is loaded by path, like `import-config.test.ts` does.
 */
const backendSrc = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../services/de-backend/src');
const load = async <T>(path: string): Promise<T> => (await import(/* @vite-ignore */ resolve(backendSrc, path))) as T;

/** The backend's `Money` (shared/money.ts): exact decimal arithmetic, never a float. */
export interface Money {
  toJSON(): { amount: string; currency: string };
  add(other: Money): Money;
  subtract(other: Money): Money;
  compare(other: Money): -1 | 0 | 1;
  isZero(): boolean;
  equals(other: Money): boolean;
}

interface MoneyClass {
  of(amount: string, currency: string): Money;
  zero(currency: string): Money;
  sum(amounts: readonly Money[], currency: string): Money;
}

export interface Schema {
  safeParse(value: unknown): { success: boolean };
}

export interface RealMappings {
  readonly Money: MoneyClass;
  readonly transaction: (t: unknown) => TransactionDto;
  readonly split: (s: unknown) => TransactionSplitDto;
  readonly splits: (t: unknown, s: readonly unknown[]) => TransactionSplitsDto;
  readonly batch: (b: unknown) => ImportBatchDto;
  readonly reviewItem: (i: unknown, conflicts: ReadonlyMap<string, unknown>) => ReviewItemDto;
  readonly reconciliation: (r: unknown) => RentReconciliationDto;
  readonly reconciliationRead: (read: { reconciliation: unknown; mrePresence: null }) => RentReconciliationReadDto;
  readonly suggest: (result: { from: string; to: string; items: readonly unknown[]; skipped: { unconfirmed: number; noRentCash: number } }) => SuggestResultDto;
  readonly term: (t: unknown) => TermCoverageDto;
  readonly transactionRent: (t: unknown) => TransactionRentCoverageDto;
  readonly schemas: {
    /** One split of `PUT …/splits` and of a correction's replacement. */
    readonly split: Schema;
    readonly correct: Schema;
    readonly metadata: Schema;
    readonly resolve: Schema;
    readonly suggest: Schema;
    readonly confirm: Schema;
    readonly reason: Schema;
  };
}

export async function loadRealMappings(): Promise<RealMappings> {
  const shared = await load<{ Money: MoneyClass }>('shared/index.ts');
  const dto = await load<{ toDto: RealMappings['transaction']; toSplitDto: RealMappings['split']; split: Schema; correctBody: Schema }>(
    'api/transaction-dto.ts',
  );
  const splits = await load<{ toSplitsDto: RealMappings['splits'] }>('api/transaction-splits.ts');
  const imports = await load<{ toDto: RealMappings['batch']; toItemDto: RealMappings['reviewItem']; metadataSchema: Schema; resolveBody: Schema }>(
    'api/imports.ts',
  );
  const rent = await load<{
    toDto: RealMappings['reconciliation'];
    toReadDto: RealMappings['reconciliationRead'];
    toSuggestDto: RealMappings['suggest'];
    toTermDto: RealMappings['term'];
    toTransactionDto: RealMappings['transactionRent'];
    suggestBody: Schema;
    confirmBody: Schema;
    releaseBody: Schema;
  }>('api/rent-reconciliations.ts');
  return {
    Money: shared.Money,
    transaction: dto.toDto,
    split: dto.toSplitDto,
    splits: splits.toSplitsDto,
    batch: imports.toDto,
    reviewItem: imports.toItemDto,
    reconciliation: rent.toDto,
    reconciliationRead: rent.toReadDto,
    suggest: rent.toSuggestDto,
    term: rent.toTermDto,
    transactionRent: rent.toTransactionDto,
    schemas: {
      split: dto.split,
      correct: dto.correctBody,
      metadata: imports.metadataSchema,
      resolve: imports.resolveBody,
      suggest: rent.suggestBody,
      confirm: rent.confirmBody,
      reason: rent.releaseBody,
    },
  };
}
