import type { AuditActor, Money, VersionConflict } from '../../shared/index.js';
import type { DepositState, DepositView } from './figures.js';

/**
 * SecurityDeposit (data-model.md §26, api-design.md §47.1, phase-5-plan P5-D1/D2/D4): the landlord-side record of one
 * rental deposit (Kaution) held for one MRE Tenant (the lease, P5-D1). Its cash is ledger cash, linked through splits
 * (VC-5-02); its amounts are derived on read (VC-5-03). Status `ACTIVE` → `VOID` here; `CLOSED` comes with VC-5-04.
 */

export type SecurityDepositId = string & { readonly __brand: 'SecurityDepositId' };

export const DEPOSIT_STATUSES = ['ACTIVE', 'CLOSED', 'VOID'] as const;
export type DepositStatus = (typeof DEPOSIT_STATUSES)[number];

/** Where `expectedAmount` came from on create; an amend sets `REQUEST`. */
export const EXPECTED_AMOUNT_SOURCES = ['REQUEST', 'MRE_GUARANTY'] as const;
export type ExpectedAmountSource = (typeof EXPECTED_AMOUNT_SOURCES)[number];

/** The fields `amend` may change while the deposit is `ACTIVE`. */
export interface DepositAmendable {
  /** > 0, EUR. */
  readonly expectedAmount: Money;
  readonly holdingFinancialAccountId: string | null;
  readonly interestBearing: boolean;
  readonly notes: string | null;
}

export interface SecurityDeposit extends DepositAmendable {
  readonly id: SecurityDepositId;
  readonly mreRealmId: string;
  readonly status: DepositStatus;
  readonly mreTenantId: string;
  readonly expectedAmountSource: ExpectedAmountSource;
  readonly voidedAt: Date | null;
  readonly voidReason: string | null;
  readonly createdAt: Date;
  readonly version: number;
}

/** A validated deposit about to be created; `expectedAmount` null takes MRE's `guaranty` (P5-D1). */
export interface DepositRequest {
  readonly mreRealmId: string;
  readonly mreTenantId: string;
  readonly expectedAmount: Money | null;
  readonly holdingFinancialAccountId: string | null;
  readonly interestBearing: boolean;
  readonly notes: string | null;
}

export interface NewDeposit extends DepositAmendable {
  readonly mreRealmId: string;
  readonly mreTenantId: string;
  readonly expectedAmountSource: ExpectedAmountSource;
}

export const AMENDABLE_FIELDS = ['expectedAmount', 'holdingFinancialAccountId', 'interestBearing', 'notes'] as const;
export type AmendableField = (typeof AMENDABLE_FIELDS)[number];
export type DepositChanges = { readonly [F in AmendableField]?: DepositAmendable[F] };

/**
 * The deposit to write: the request's amount, else MRE's `guaranty` (P5-D1), already rounded half-up to the cent by
 * the client (P5-D9) and `null` for MRE's default `0`; undefined when neither gives a positive amount.
 */
export function resolveNew(request: DepositRequest, guaranty: Money | null): NewDeposit | undefined {
  const fromMre = request.expectedAmount === null && guaranty !== null && guaranty.isPositive() ? guaranty : undefined;
  const expectedAmount = request.expectedAmount ?? fromMre;
  if (expectedAmount === undefined) return undefined;
  return {
    mreRealmId: request.mreRealmId,
    mreTenantId: request.mreTenantId,
    expectedAmount,
    expectedAmountSource: request.expectedAmount === null ? 'MRE_GUARANTY' : 'REQUEST',
    holdingFinancialAccountId: request.holdingFinancialAccountId,
    interestBearing: request.interestBearing,
    notes: request.notes,
  };
}

/** Identity of a create request for `Idempotency-Key` replays: the normalized body. */
export function createFingerprint(request: DepositRequest): string {
  return JSON.stringify([
    request.mreTenantId,
    request.expectedAmount?.amount ?? null,
    request.holdingFinancialAccountId,
    request.interestBearing,
    request.notes,
  ]);
}

const same = (field: AmendableField, x: DepositAmendable, y: DepositAmendable) =>
  field === 'expectedAmount' ? x.expectedAmount.equals(y.expectedAmount) : x[field] === y[field];

export type AmendPlan =
  | {
      readonly kind: 'AMEND';
      readonly values: DepositAmendable;
      readonly changed: readonly AmendableField[];
      /** The holding account this amend names anew, to check. */
      readonly newHoldingAccountId: string | null;
    }
  /** Every given value equals the current one: a 200 no-op, answered whatever the version (§16.1). */
  | { readonly kind: 'UNCHANGED' }
  /** Not `ACTIVE` (→ 409 DEPOSIT_NOT_ACTIVE). */
  | { readonly kind: 'DEPOSIT_NOT_ACTIVE'; readonly status: DepositStatus };

export function planAmend(current: SecurityDeposit, changes: DepositChanges): AmendPlan {
  if (current.status !== 'ACTIVE') return { kind: 'DEPOSIT_NOT_ACTIVE', status: current.status };
  const values: DepositAmendable = {
    expectedAmount: changes.expectedAmount ?? current.expectedAmount,
    holdingFinancialAccountId: changes.holdingFinancialAccountId === undefined ? current.holdingFinancialAccountId : changes.holdingFinancialAccountId,
    interestBearing: changes.interestBearing ?? current.interestBearing,
    notes: changes.notes === undefined ? current.notes : changes.notes,
  };
  const changed = AMENDABLE_FIELDS.filter((field) => !same(field, values, current));
  if (changed.length === 0) return { kind: 'UNCHANGED' };
  const newHoldingAccountId = changed.includes('holdingFinancialAccountId') ? values.holdingFinancialAccountId : null;
  return { kind: 'AMEND', values, changed, newHoldingAccountId };
}

export type VoidPlan =
  | { readonly kind: 'VOID'; readonly next: SecurityDeposit }
  /** Already void: a 200 no-op whatever the reason or version; the first reason and time stay. */
  | { readonly kind: 'UNCHANGED' }
  /** Closed (VC-5-04) is not voided (→ 409 DEPOSIT_CLOSED). */
  | { readonly kind: 'DEPOSIT_CLOSED' }
  /** Splits reference the deposit, reversals included (→ 409 DEPOSIT_HAS_SPLITS; from VC-5-02). */
  | { readonly kind: 'DEPOSIT_HAS_SPLITS'; readonly transactionIds: readonly string[] };

export function planVoid(current: SecurityDeposit, reason: string, at: Date, splitTransactionIds: readonly string[]): VoidPlan {
  if (current.status === 'VOID') return { kind: 'UNCHANGED' };
  if (current.status === 'CLOSED') return { kind: 'DEPOSIT_CLOSED' };
  if (splitTransactionIds.length > 0) return { kind: 'DEPOSIT_HAS_SPLITS', transactionIds: [...new Set(splitTransactionIds)].sort() };
  return { kind: 'VOID', next: { ...current, status: 'VOID', voidedAt: at, voidReason: reason, version: current.version + 1 } };
}

/** The create's checks 2–3 (§47.1), before MRE is asked and again under the write's locks. */
export type DepositRefusal =
  | { readonly kind: 'ACCOUNT_NOT_FOUND'; readonly financialAccountId: string }
  | { readonly kind: 'NOT_A_SECURITY_DEPOSIT_ACCOUNT'; readonly financialAccountId: string; readonly accountType: string }
  | { readonly kind: 'DEPOSIT_EXISTS'; readonly securityDepositId: string };

export type CreateDepositOutcome =
  | { readonly kind: 'CREATED'; readonly deposit: DepositView }
  | { readonly kind: 'REPLAYED'; readonly deposit: DepositView }
  | { readonly kind: 'IDEMPOTENCY_CONFLICT' }
  | DepositRefusal;

/** Before MRE is asked: a replay, a key conflict or a refusal answers without an MRE read. */
export type CreatePrecheck = { readonly kind: 'PROCEED' } | Exclude<CreateDepositOutcome, { kind: 'CREATED' }>;

export type AmendDepositOutcome =
  | { readonly kind: 'AMENDED'; readonly deposit: DepositView; readonly changed: boolean }
  | { readonly kind: 'NOT_FOUND' }
  | { readonly kind: 'DEPOSIT_NOT_ACTIVE'; readonly status: DepositStatus }
  | Extract<DepositRefusal, { kind: 'ACCOUNT_NOT_FOUND' | 'NOT_A_SECURITY_DEPOSIT_ACCOUNT' }>
  | VersionConflict;

export type VoidDepositOutcome =
  | { readonly kind: 'VOIDED'; readonly deposit: DepositView; readonly changed: boolean }
  | { readonly kind: 'NOT_FOUND' }
  | Exclude<VoidPlan, { kind: 'VOID' | 'UNCHANGED' }>
  | VersionConflict;

export interface DepositFilter {
  readonly statuses?: readonly DepositStatus[];
  readonly mreTenantId?: string;
  readonly holdingFinancialAccountId?: string;
  /** The derived state (§47.3), any of them; applied before paging. */
  readonly states?: readonly DepositState[];
}

export interface DepositPage {
  readonly items: readonly DepositView[];
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
}

/** Persistence port, implemented in infrastructure/postgres. Everything is scoped to the given Realm. */
export interface SecurityDepositRepository {
  /** The recorded key, then §47.1 checks 2–3, in one read-only snapshot before the MRE read; never writes. */
  createPrecheck(request: DepositRequest, idempotency?: { readonly key: string; readonly fingerprint: string }): Promise<CreatePrecheck>;
  /** Claims the key, repeats checks 2–3 under the write's locks, writes the deposit and an AuditRecord. */
  create(deposit: NewDeposit, actor: AuditActor, idempotency?: { readonly key: string; readonly fingerprint: string }): Promise<CreateDepositOutcome>;
  /** The deposit, its figures and the counted cash (§47.3), in one snapshot. */
  findById(id: string, mreRealmId: string): Promise<DepositView | undefined>;
  /** Newest `createdAt` first, then id; filter, figures, count and page in one snapshot. */
  list(mreRealmId: string, filter: DepositFilter, page: { readonly page: number; readonly pageSize: number }): Promise<DepositPage>;
  /** A newly named holding account `FOR SHARE`, then the deposit `FOR UPDATE`, then `planAmend`. */
  amend(id: string, mreRealmId: string, changes: DepositChanges, actor: AuditActor, expectedVersions?: readonly number[]): Promise<AmendDepositOutcome>;
  /** The deposit `FOR UPDATE`, then its splits are read; no Transaction is locked (P5-D9). */
  void(id: string, mreRealmId: string, reason: string, at: Date, actor: AuditActor, expectedVersions?: readonly number[]): Promise<VoidDepositOutcome>;
}
