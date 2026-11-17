import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ImportBatchDto, ImportBatchSummaryDto, ReviewItemDto } from '../api/imports';
import type {
  RentReconciliationDto,
  RentReconciliationReadDto,
  RentSplitProposalDto,
  RentTenantDto,
  SuggestResultDto,
  TenantTermsDto,
  TermCoverageDto,
  TransactionRentCoverageDto,
} from '../api/rent-reconciliations';
import type {
  FinancialAccountDto,
  PropertyReferenceDto,
  RentAllocationDto,
  TransactionDto,
  TransactionSplitDto,
  TransactionSplitsDto,
} from '../api/transactions';

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
  safeParse(value: unknown): { success: boolean; data?: unknown; error?: { issues: readonly { path: readonly PropertyKey[] }[] } };
}

export interface RealMappings {
  readonly Money: MoneyClass;
  readonly transaction: (t: unknown) => TransactionDto;
  /**
   * A list item's `rentAllocation` (§30.1A): the backend's rule (`isCounted`, `rentAllocationOf`) and its DTO mapping
   * (`toRentAllocationDto`), from a Transaction's status, direction, rent cash and confirmed total.
   */
  readonly rentAllocation: (input: {
    status: string;
    correctionRole: string | null;
    direction: string;
    rentCash: Money | null;
    matchedTotal: Money;
  }) => RentAllocationDto | null;
  readonly split: (s: unknown) => TransactionSplitDto;
  readonly splits: (t: unknown, s: readonly unknown[]) => TransactionSplitsDto;
  readonly batch: (b: unknown) => ImportBatchDto;
  /** One item of `GET /imports` (§32.6, #369). */
  readonly batchSummary: (b: unknown) => ImportBatchSummaryDto;
  readonly reviewItem: (i: unknown, conflicts: ReadonlyMap<string, unknown>) => ReviewItemDto;
  readonly reconciliation: (r: unknown) => RentReconciliationDto;
  readonly reconciliationRead: (read: { reconciliation: unknown; mrePresence: null }) => RentReconciliationReadDto;
  readonly suggest: (result: {
    from: string;
    to: string;
    items: readonly unknown[];
    skipped: { unconfirmed: number; noRentCash: number; decidedBefore: number };
  }) => SuggestResultDto;
  readonly term: (t: unknown) => TermCoverageDto;
  readonly transactionRent: (t: unknown) => TransactionRentCoverageDto;
  /** §37.6's answer (step 8). */
  readonly splitProposal: (p: unknown) => RentSplitProposalDto;
  /** §37.7's two reads (#364): one Tenant of the list, and a Tenant's terms. */
  readonly tenant: (t: unknown) => RentTenantDto;
  readonly tenantTerms: (t: unknown) => TenantTermsDto;
  /** §29.2's account and §23.1's reference (the setup, Issue #365). */
  readonly account: (a: unknown) => FinancialAccountDto;
  readonly propertyReference: (r: unknown) => PropertyReferenceDto;
  readonly schemas: {
    /** One split of `PUT …/splits` and of a correction's replacement. */
    readonly split: Schema;
    readonly correct: Schema;
    /** `POST …/reverse` (§35.9): `{ reason }` only. */
    readonly reverse: Schema;
    readonly metadata: Schema;
    readonly resolve: Schema;
    readonly suggest: Schema;
    readonly confirm: Schema;
    readonly reason: Schema;
    /** `POST /rent-reconciliations` (§37.1, step 8). */
    readonly create: Schema;
    /** `POST /financial-accounts` (§29.1) and `POST /property-references/link` (§23.1), Issue #365. */
    readonly createAccount: Schema;
    readonly link: Schema;
  };
}

export async function loadRealMappings(): Promise<RealMappings> {
  const shared = await load<{ Money: MoneyClass }>('shared/index.ts');
  const dto = await load<{
    toDto: RealMappings['transaction'];
    toRentAllocationDto: (allocation: unknown) => RentAllocationDto | null;
    toSplitDto: RealMappings['split'];
    split: Schema;
    correctBody: Schema;
    reverseBody: Schema;
  }>('api/transaction-dto.ts');
  const splits = await load<{ toSplitsDto: RealMappings['splits'] }>('api/transaction-splits.ts');
  const rule = await load<{
    isCounted: (status: string, correctionRole: string | null) => boolean;
    rentAllocationOf: (input: { counted: boolean; direction: string; rentCash: Money | null; matchedTotal: Money }) => unknown;
  }>('domains/rent-reconciliation/index.ts');
  const imports = await load<{
    toDto: RealMappings['batch'];
    toSummaryDto: RealMappings['batchSummary'];
    toItemDto: RealMappings['reviewItem'];
    metadataSchema: Schema;
    resolveBody: Schema;
  }>('api/imports.ts');
  const rent = await load<{
    toDto: RealMappings['reconciliation'];
    toReadDto: RealMappings['reconciliationRead'];
    toSuggestDto: RealMappings['suggest'];
    toTermDto: RealMappings['term'];
    toTransactionDto: RealMappings['transactionRent'];
    splitProposalDto: RealMappings['splitProposal'];
    toTenantDto: RealMappings['tenant'];
    toTenantTermsDto: RealMappings['tenantTerms'];
    suggestBody: Schema;
    confirmBody: Schema;
    releaseBody: Schema;
    createBody: Schema;
  }>('api/rent-reconciliations.ts');
  const accounts = await load<{ toDto: RealMappings['account']; createBody: Schema }>('api/financial-accounts.ts');
  const references = await load<{ toDto: RealMappings['propertyReference']; linkBody: Schema }>('api/property-references.ts');
  return {
    Money: shared.Money,
    transaction: dto.toDto,
    rentAllocation: ({ status, correctionRole, ...rest }) =>
      dto.toRentAllocationDto(rule.rentAllocationOf({ counted: rule.isCounted(status, correctionRole), ...rest })),
    split: dto.toSplitDto,
    splits: splits.toSplitsDto,
    batch: imports.toDto,
    batchSummary: imports.toSummaryDto,
    reviewItem: imports.toItemDto,
    reconciliation: rent.toDto,
    reconciliationRead: rent.toReadDto,
    suggest: rent.toSuggestDto,
    term: rent.toTermDto,
    transactionRent: rent.toTransactionDto,
    splitProposal: rent.splitProposalDto,
    tenant: rent.toTenantDto,
    tenantTerms: rent.toTenantTermsDto,
    account: accounts.toDto,
    propertyReference: references.toDto,
    schemas: {
      split: dto.split,
      correct: dto.correctBody,
      reverse: dto.reverseBody,
      metadata: imports.metadataSchema,
      resolve: imports.resolveBody,
      suggest: rent.suggestBody,
      confirm: rent.confirmBody,
      reason: rent.releaseBody,
      create: rent.createBody,
      createAccount: accounts.createBody,
      link: references.linkBody,
    },
  };
}
