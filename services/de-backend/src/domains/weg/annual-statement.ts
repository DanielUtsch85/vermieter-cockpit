import type { AuditActor, BusinessDate, Money, VersionConflict } from '../../shared/index.js';
import { centsOf, eur, type CostGroup } from './economic-plan.js';
import type { Page, PageRequest } from './weg.js';

/**
 * The Jahresabrechnung of one unit (data-model.md §30–§31, api-design.md §50, phase-6-plan P6-D5, P6-D8), as the
 * Verwalter's Einzelabrechnung prints it: cost lines in the two printed groups with their allocation, the advances
 * requested and paid, the Abrechnungsspitze and -ergebnis, and the development of the reserve. Everything is kept as
 * printed; the statement's own check is a list of flags, never a refusal (BR-WEG-006). It never creates cash and never
 * re-splits a confirmed split (BR-WEG-007); its ledger effects are §51's.
 */

export type WegAnnualStatementId = string & { readonly __brand: 'WegAnnualStatementId' };

export const STATEMENT_STATUSES = ['DRAFT', 'CONFIRMED', 'SUPERSEDED', 'VOID'] as const;
export type StatementStatus = (typeof STATEMENT_STATUSES)[number];

export const CLASSIFICATIONS = ['RECOVERABLE', 'NON_RECOVERABLE', 'RESERVE'] as const;
export type Classification = (typeof CLASSIFICATIONS)[number];

export const CLASSIFICATION_SOURCES = ['USER', 'PREVIOUS_STATEMENT', 'PRINTED_GROUP'] as const;
export type ClassificationSource = (typeof CLASSIFICATION_SOURCES)[number];

export const RESERVE_SOURCES = ['ANNUAL_STATEMENT', 'ASSET_REPORT'] as const;
export type ReserveSource = (typeof RESERVE_SOURCES)[number];

export const RESERVE_LINE_KINDS = ['OPENING', 'CONTRIBUTION', 'INTEREST', 'WITHDRAWAL', 'OTHER'] as const;
export type ReserveLineKind = (typeof RESERVE_LINE_KINDS)[number];

/** A printed cost line as entered; `classification` null takes the default (P6-D8). */
export interface NewStatementCostLine {
  readonly position: number;
  readonly account: string;
  readonly group: CostGroup;
  readonly allocationKey: string;
  /** Decimals as printed, at most three places, shortest form (`"10000"`, `"125.5"`); `share ≤ total`. */
  readonly allocationTotal: string | null;
  readonly allocationShare: string | null;
  /** Signed: a credit line such as an income is negative. */
  readonly totalAmount: Money;
  readonly unitShare: Money;
  readonly classification: Classification | null;
}

/** A stored line: the classification resolved on write, with where it came from. */
export interface StatementCostLine extends Omit<NewStatementCostLine, 'classification'> {
  readonly classification: Classification;
  readonly classificationSource: ClassificationSource;
}

export interface ReserveLine {
  readonly position: number;
  readonly description: string;
  readonly kind: ReserveLineKind;
  /** The WEG's figures; null where not printed. */
  readonly opening: Money | null;
  readonly addition: Money | null;
  readonly withdrawal: Money | null;
  readonly closing: Money | null;
}

export interface ReserveSection {
  readonly source: ReserveSource;
  readonly lines: readonly ReserveLine[];
  readonly unitShareOpening: Money | null;
  readonly unitShareClosing: Money | null;
}

/** The printed totals (signed Money). */
export interface StatementTotals {
  readonly recoverableSubtotal: Money;
  readonly nonRecoverableSubtotal: Money;
  readonly totalCosts: Money;
  readonly hausgeldRequested: Money;
  readonly hausgeldPaid: Money;
  readonly reserveRequested: Money | null;
  readonly reservePaid: Money | null;
  /** The Abrechnungsspitze: > 0 a back-payment, < 0 a credit. */
  readonly settlementPeak: Money;
  /** The Abrechnungsergebnis, when printed. */
  readonly settlementResult: Money | null;
}

/** What create and replace carry (§50), besides the membership. */
export interface StatementContent<Line = NewStatementCostLine> extends StatementTotals {
  readonly financialYear: number;
  readonly periodFrom: BusinessDate;
  readonly periodUntil: BusinessDate;
  readonly documentDate: BusinessDate | null;
  readonly resolutionDate: BusinessDate | null;
  readonly dueDate: BusinessDate | null;
  readonly supersedes: string | null;
  readonly costLines: readonly Line[];
  readonly reserve: ReserveSection | null;
  readonly sourceReferences: readonly string[];
  readonly notes: string | null;
}

export interface NewAnnualStatement extends StatementContent {
  readonly mreRealmId: string;
  readonly membershipId: string;
}

export interface AnnualStatement extends StatementContent<StatementCostLine> {
  readonly id: WegAnnualStatementId;
  readonly mreRealmId: string;
  readonly membershipId: string;
  readonly status: StatementStatus;
  readonly supersededBy: string | null;
  readonly confirmedAt: Date | null;
  readonly voidedAt: Date | null;
  readonly voidReason: string | null;
  readonly createdAt: Date;
  readonly version: number;
}

export type StatementFlag =
  | { readonly code: 'LINES_DIFFER_FROM_SUBTOTAL'; readonly details: { readonly group: CostGroup; readonly lines: Money; readonly printed: Money } }
  | { readonly code: 'SUBTOTALS_DIFFER_FROM_TOTAL'; readonly details: { readonly subtotals: Money; readonly printed: Money } }
  | { readonly code: 'SETTLEMENT_DIFFERS'; readonly details: { readonly derived: Money; readonly printed: Money } }
  | { readonly code: 'RESULT_DIFFERS'; readonly details: { readonly derived: Money; readonly printed: Money } }
  | { readonly code: 'LINE_SHARE_DIFFERS'; readonly details: { readonly position: number; readonly derived: Money; readonly printed: Money } }
  | { readonly code: 'RESERVE_DIFFERS'; readonly details: { readonly position: number; readonly derived: Money; readonly printed: Money } }
  | { readonly code: 'CLASSIFIED_AGAINST_GROUP'; readonly details: { readonly positions: readonly number[] } };

export interface StatementView extends AnnualStatement {
  /** The lines' `unitShare` summed per classification (§51 builds on it). */
  readonly byClassification: Readonly<Record<Classification, Money>>;
  readonly flags: readonly StatementFlag[];
}

/** A quantity of up to three decimals in thousandths, exact. */
const thousandths = (quantity: string): bigint => {
  const [whole, fraction = ''] = quantity.split('.') as [string, string?];
  return BigInt(whole) * 1000n + BigInt(fraction.padEnd(3, '0'));
};

/** The shortest form of a quantity (`"10000.000"` → `"10000"`, `"125.500"` → `"125.5"`). */
export function normalizeQuantity(quantity: string): string {
  const units = thousandths(quantity);
  const whole = (units / 1000n).toString();
  const fraction = (units % 1000n).toString().padStart(3, '0').replace(/0+$/, '');
  return fraction === '' ? whole : `${whole}.${fraction}`;
}

export const compareQuantities = (a: string, b: string): number => {
  const difference = thousandths(a) - thousandths(b);
  return difference < 0n ? -1 : difference > 0n ? 1 : 0;
};

/** `cents × share / total`, rounded half away from zero (commercial rounding, for signed lines); `total > 0`. */
function lineShare(cents: bigint, share: bigint, total: bigint): bigint {
  const magnitude = (2n * (cents < 0n ? -cents : cents) * share + total) / (2n * total);
  return cents < 0n ? -magnitude : magnitude;
}

const sum = (amounts: readonly Money[]): bigint => amounts.reduce((total, m) => total + centsOf(m), 0n);
const abs = (value: bigint) => (value < 0n ? -value : value);

/** The statement's own check (§50) and the sums per classification. Exact in cents; derived on read, never stored. */
export function deriveStatement(statement: StatementContent<StatementCostLine>): Pick<StatementView, 'byClassification' | 'flags'> {
  const flags: StatementFlag[] = [];
  for (const group of ['RECOVERABLE', 'NON_RECOVERABLE'] as const) {
    const lines = sum(statement.costLines.filter((line) => line.group === group).map((line) => line.unitShare));
    const printed = group === 'RECOVERABLE' ? statement.recoverableSubtotal : statement.nonRecoverableSubtotal;
    if (lines !== centsOf(printed)) flags.push({ code: 'LINES_DIFFER_FROM_SUBTOTAL', details: { group, lines: eur(lines), printed } });
  }
  const subtotals = centsOf(statement.recoverableSubtotal) + centsOf(statement.nonRecoverableSubtotal);
  if (subtotals !== centsOf(statement.totalCosts)) {
    flags.push({ code: 'SUBTOTALS_DIFFER_FROM_TOTAL', details: { subtotals: eur(subtotals), printed: statement.totalCosts } });
  }
  const peak = centsOf(statement.totalCosts) - centsOf(statement.hausgeldRequested);
  if (peak !== centsOf(statement.settlementPeak)) {
    flags.push({ code: 'SETTLEMENT_DIFFERS', details: { derived: eur(peak), printed: statement.settlementPeak } });
  }
  if (statement.settlementResult !== null) {
    const result = centsOf(statement.totalCosts) - centsOf(statement.hausgeldPaid);
    if (result !== centsOf(statement.settlementResult)) {
      flags.push({ code: 'RESULT_DIFFERS', details: { derived: eur(result), printed: statement.settlementResult } });
    }
  }
  for (const line of statement.costLines) {
    if (line.allocationTotal === null || line.allocationShare === null) continue;
    const total = thousandths(line.allocationTotal);
    if (total === 0n) continue;
    const derived = lineShare(centsOf(line.totalAmount), thousandths(line.allocationShare), total);
    if (abs(derived - centsOf(line.unitShare)) > 1n) {
      flags.push({ code: 'LINE_SHARE_DIFFERS', details: { position: line.position, derived: eur(derived), printed: line.unitShare } });
    }
  }
  for (const line of statement.reserve?.lines ?? []) {
    // Nothing is estimated: without a printed opening and closing there is nothing to compare.
    if (line.opening === null || line.closing === null) continue;
    const derived = centsOf(line.opening) + (line.addition === null ? 0n : centsOf(line.addition)) - (line.withdrawal === null ? 0n : centsOf(line.withdrawal));
    if (derived !== centsOf(line.closing))
      flags.push({ code: 'RESERVE_DIFFERS', details: { position: line.position, derived: eur(derived), printed: line.closing } });
  }
  const against = statement.costLines.filter((line) => line.classification !== line.group).map((line) => line.position);
  if (against.length > 0) flags.push({ code: 'CLASSIFIED_AGAINST_GROUP', details: { positions: against } });
  const byClass = (classification: Classification) =>
    eur(sum(statement.costLines.filter((line) => line.classification === classification).map((line) => line.unitShare)));
  return { byClassification: { RECOVERABLE: byClass('RECOVERABLE'), NON_RECOVERABLE: byClass('NON_RECOVERABLE'), RESERVE: byClass('RESERVE') }, flags };
}

export const viewStatement = (statement: AnnualStatement): StatementView => ({ ...statement, ...deriveStatement(statement) });

/**
 * The classification of each line, resolved on write (P6-D8, review on #148): the user's; else that of the line with
 * the same `account` in the membership's last `CONFIRMED` statement of an earlier year (`previous`, by account); else
 * the printed group.
 */
export function resolveClassifications(lines: readonly NewStatementCostLine[], previous: ReadonlyMap<string, Classification>): StatementCostLine[] {
  return lines.map(({ classification, ...line }) => {
    if (classification !== null) return { ...line, classification, classificationSource: 'USER' };
    const earlier = previous.get(line.account);
    if (earlier !== undefined) return { ...line, classification: earlier, classificationSource: 'PREVIOUS_STATEMENT' };
    return { ...line, classification: line.group, classificationSource: 'PRINTED_GROUP' };
  });
}

/** By account, the classification of the first line by position of the given statement's lines. */
export function classificationsByAccount(lines: readonly Pick<StatementCostLine, 'account' | 'position' | 'classification'>[]): Map<string, Classification> {
  const byAccount = new Map<string, Classification>();
  for (const line of [...lines].sort((a, b) => a.position - b.position)) if (!byAccount.has(line.account)) byAccount.set(line.account, line.classification);
  return byAccount;
}

const moneyKey = (m: Money | null) => (m === null ? null : m.amount);

const reserveKey = (reserve: ReserveSection | null) =>
  reserve === null
    ? null
    : [
        reserve.source,
        reserve.lines.map((l) => [l.position, l.description, l.kind, moneyKey(l.opening), moneyKey(l.addition), moneyKey(l.withdrawal), moneyKey(l.closing)]),
        moneyKey(reserve.unitShareOpening),
        moneyKey(reserve.unitShareClosing),
      ];

/** The content as one comparable value; lines in position order. Money as amount, quantities in shortest form. */
function contentKey<Line extends NewStatementCostLine | StatementCostLine>(content: StatementContent<Line>, line: (l: Line) => unknown[]): string {
  return JSON.stringify([
    content.financialYear,
    content.periodFrom,
    content.periodUntil,
    content.documentDate,
    content.resolutionDate,
    content.dueDate,
    content.supersedes,
    ...[
      content.recoverableSubtotal,
      content.nonRecoverableSubtotal,
      content.totalCosts,
      content.hausgeldRequested,
      content.hausgeldPaid,
      content.reserveRequested,
      content.reservePaid,
      content.settlementPeak,
      content.settlementResult,
    ].map(moneyKey),
    [...content.costLines].sort((a, b) => a.position - b.position).map(line),
    reserveKey(content.reserve),
    content.sourceReferences,
    content.notes,
  ]);
}

const lineKey = (l: NewStatementCostLine | StatementCostLine) => [
  l.position,
  l.account,
  l.group,
  l.allocationKey,
  l.allocationTotal,
  l.allocationShare,
  l.totalAmount.amount,
  l.unitShare.amount,
];

/** Identity of a create for `Idempotency-Key` replays: the membership and the content as entered. */
export function statementFingerprint(statement: NewAnnualStatement): string {
  return JSON.stringify([statement.membershipId, contentKey(statement, (l) => [...lineKey(l), l.classification])]);
}

/** Whether a replace changes nothing: the stored content against the resolved new content (§50: a `200` no-op). */
export function sameContent(current: StatementContent<StatementCostLine>, next: StatementContent<StatementCostLine>): boolean {
  const key = (content: StatementContent<StatementCostLine>) => contentKey(content, (l) => [...lineKey(l), l.classification, l.classificationSource]);
  return key(current) === key(next);
}

/** The header fields a replace changed, for its AuditRecord. */
export function changedHeaderFields(current: StatementContent<StatementCostLine>, next: StatementContent<StatementCostLine>): string[] {
  const fields = [
    'financialYear',
    'periodFrom',
    'periodUntil',
    'documentDate',
    'resolutionDate',
    'dueDate',
    'supersedes',
    'recoverableSubtotal',
    'nonRecoverableSubtotal',
    'totalCosts',
    'hausgeldRequested',
    'hausgeldPaid',
    'reserveRequested',
    'reservePaid',
    'settlementPeak',
    'settlementResult',
    'notes',
  ] as const;
  const value = (content: StatementContent<StatementCostLine>, field: (typeof fields)[number]) => {
    const v = content[field];
    return v !== null && typeof v === 'object' ? v.amount : v;
  };
  const changed: string[] = fields.filter((field) => value(current, field) !== value(next, field));
  if (JSON.stringify(current.sourceReferences) !== JSON.stringify(next.sourceReferences)) changed.push('sourceReferences');
  if (JSON.stringify(reserveKey(current.reserve)) !== JSON.stringify(reserveKey(next.reserve))) changed.push('reserve');
  return changed;
}

export type InvalidSupersedesReason = 'NOT_FOUND' | 'OTHER_MEMBERSHIP' | 'OTHER_YEAR' | 'NOT_CONFIRMED';

/** §50's checks after the body, in order; shared by create and replace. */
export type StatementRefusal =
  | { readonly kind: 'MEMBERSHIP_NOT_FOUND' }
  | { readonly kind: 'PERIOD_OUTSIDE_YEAR'; readonly field: 'periodFrom' | 'periodUntil'; readonly from: BusinessDate; readonly until: BusinessDate }
  | { readonly kind: 'MEMBERSHIP_NOT_ACTIVE'; readonly membershipId: string }
  | { readonly kind: 'STATEMENT_OUTSIDE_MEMBERSHIP'; readonly validFrom: BusinessDate; readonly validUntil: BusinessDate | null }
  | { readonly kind: 'INVALID_SUPERSEDES'; readonly reason: InvalidSupersedesReason; readonly supersedes: string };

export type CreateStatementOutcome =
  | { readonly kind: 'CREATED'; readonly statement: StatementView }
  | { readonly kind: 'REPLAYED'; readonly statement: StatementView }
  | { readonly kind: 'IDEMPOTENCY_CONFLICT' }
  | StatementRefusal;

export type ReplaceStatementOutcome =
  | { readonly kind: 'REPLACED'; readonly statement: StatementView; readonly changed: boolean }
  | { readonly kind: 'NOT_FOUND' }
  | { readonly kind: 'STATEMENT_NOT_DRAFT'; readonly status: StatementStatus }
  | StatementRefusal
  | VersionConflict;

export type ConfirmStatementOutcome =
  | { readonly kind: 'CONFIRMED'; readonly statement: StatementView; readonly changed: boolean }
  | { readonly kind: 'NOT_FOUND' }
  | { readonly kind: 'STATEMENT_NOT_DRAFT'; readonly status: StatementStatus }
  | { readonly kind: 'INVALID_SUPERSEDES'; readonly reason: InvalidSupersedesReason; readonly supersedes: string }
  | { readonly kind: 'STATEMENT_EXISTS'; readonly statementId: string }
  | VersionConflict;

export type VoidStatementOutcome =
  | { readonly kind: 'VOIDED'; readonly statement: StatementView; readonly changed: boolean }
  | { readonly kind: 'NOT_FOUND' }
  | { readonly kind: 'STATEMENT_NOT_DRAFT'; readonly status: StatementStatus }
  | VersionConflict;

/** The steps of a confirm (§50) from the statement's status; `CONFIRMED` is a no-op. */
export function planConfirm(status: StatementStatus): 'CONFIRM' | 'UNCHANGED' | 'NOT_DRAFT' {
  if (status === 'DRAFT') return 'CONFIRM';
  if (status === 'CONFIRMED') return 'UNCHANGED';
  return 'NOT_DRAFT';
}

/** The steps of a void (§50): from `DRAFT` only; `VOID` is a no-op. */
export function planVoid(status: StatementStatus): 'VOID' | 'UNCHANGED' | 'NOT_DRAFT' {
  if (status === 'DRAFT') return 'VOID';
  if (status === 'VOID') return 'UNCHANGED';
  return 'NOT_DRAFT';
}

/** Why a named predecessor cannot be superseded, or undefined when it can (§50). */
export function supersedesRefusal(
  target: { readonly membershipId: string; readonly financialYear: number; readonly status: StatementStatus } | undefined,
  statement: { readonly membershipId: string; readonly financialYear: number },
): InvalidSupersedesReason | undefined {
  if (target === undefined) return 'NOT_FOUND';
  if (target.membershipId !== statement.membershipId) return 'OTHER_MEMBERSHIP';
  if (target.financialYear !== statement.financialYear) return 'OTHER_YEAR';
  if (target.status !== 'CONFIRMED') return 'NOT_CONFIRMED';
  return undefined;
}

export interface StatementFilter {
  readonly statuses?: readonly StatementStatus[];
  readonly financialYear?: number;
}

/** Persistence port, implemented in infrastructure/postgres. Everything is scoped to the given Realm. */
export interface WegAnnualStatementRepository {
  /** Claims the key, writes the unit and the WEG (no-ops), locks the membership `FOR UPDATE`, checks §50's order, inserts. */
  createStatement(
    statement: NewAnnualStatement,
    actor: AuditActor,
    idempotency?: { readonly key: string; readonly fingerprint: string },
  ): Promise<CreateStatementOutcome>;
  /** The same locks as create, then the statement `FOR UPDATE`; the whole content again while `DRAFT`. */
  replaceStatement(
    id: string,
    mreRealmId: string,
    content: StatementContent,
    actor: AuditActor,
    expectedVersions?: readonly number[],
  ): Promise<ReplaceStatementOutcome>;
  /** The superseded statement first, then this one (§50). */
  confirmStatement(id: string, mreRealmId: string, at: Date, actor: AuditActor, expectedVersions?: readonly number[]): Promise<ConfirmStatementOutcome>;
  voidStatement(
    id: string,
    mreRealmId: string,
    reason: string,
    at: Date,
    actor: AuditActor,
    expectedVersions?: readonly number[],
  ): Promise<VoidStatementOutcome>;
  findStatement(id: string, mreRealmId: string): Promise<StatementView | undefined>;
  /** The membership's statements without their lines, by `financialYear`, `createdAt`, id; undefined for an unknown membership. */
  listStatements(membershipId: string, mreRealmId: string, filter: StatementFilter, page: PageRequest): Promise<Page<StatementView> | undefined>;
}
