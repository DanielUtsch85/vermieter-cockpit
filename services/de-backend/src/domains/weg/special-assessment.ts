import type { AuditActor, BusinessDate, Money, VersionConflict } from '../../shared/index.js';
import { centsOf, eur } from './economic-plan.js';
import type { Page, PageRequest } from './weg.js';

/**
 * The Sonderumlage of one unit (data-model.md §32, api-design.md §51A, phase-6-plan P6-D7): a resolution of the WEG the
 * owner pays on top of the Hausgeld, in instalments, and later what the WEG used it for. Like the reserve contribution
 * it is money given to the WEG (`WEG_FUNDS`), not yet an expense: what counts for tax is the use (BFH IX R 19/24),
 * which Phase 7 classifies. Paid, outstanding and `SETTLED` are derived from the counted cash, never stored (as P5-D2).
 */

export type WegSpecialAssessmentId = string & { readonly __brand: 'WegSpecialAssessmentId' };

export const ASSESSMENT_PURPOSES = ['MAINTENANCE', 'MODERNISATION', 'LIQUIDITY', 'OTHER'] as const;
export type AssessmentPurpose = (typeof ASSESSMENT_PURPOSES)[number];

/** Stored: `ACTIVE` → `VOID`. Read: `SETTLED` when nothing is outstanding. */
export const ASSESSMENT_STATUSES = ['ACTIVE', 'SETTLED', 'VOID'] as const;
export type AssessmentStatus = (typeof ASSESSMENT_STATUSES)[number];

export interface Instalment {
  readonly position: number;
  readonly dueDate: BusinessDate;
  readonly amount: Money;
}

export interface AssessmentUse {
  readonly position: number;
  readonly date: BusinessDate;
  readonly description: string;
  readonly unitShare: Money;
}

/** What create and amend carry (§51A). */
export interface AssessmentContent {
  readonly description: string;
  readonly purpose: AssessmentPurpose;
  readonly totalAmount: Money | null;
  readonly unitShare: Money;
  readonly instalments: readonly Instalment[];
  readonly sourceReferences: readonly string[];
  readonly notes: string | null;
}

export interface NewSpecialAssessment extends AssessmentContent {
  readonly mreRealmId: string;
  readonly membershipId: string;
  readonly resolutionDate: BusinessDate;
}

export interface SpecialAssessment extends NewSpecialAssessment {
  readonly id: WegSpecialAssessmentId;
  readonly uses: readonly AssessmentUse[];
  /** As stored: `ACTIVE` or `VOID`. */
  readonly storedStatus: 'ACTIVE' | 'VOID';
  readonly voidedAt: Date | null;
  readonly voidReason: string | null;
  readonly createdAt: Date;
  readonly version: number;
}

/** A payment or refund that counts, signed: an `OUTFLOW` positive, an `INFLOW` negative. */
export interface AssessmentPayment {
  readonly transactionId: string;
  readonly bookingDate: BusinessDate;
  readonly amount: Money;
}

export type AssessmentFlag =
  | { readonly code: 'OVERPAID'; readonly details: { readonly amount: Money } }
  | { readonly code: 'USES_EXCEED_PAID'; readonly details: { readonly uses: Money; readonly paid: Money } }
  | { readonly code: 'UNCOUNTED_PAYMENTS'; readonly details: { readonly transactionIds: readonly string[] } };

export interface AssessmentView extends SpecialAssessment {
  readonly status: AssessmentStatus;
  readonly paid: Money;
  readonly outstanding: Money;
  readonly payments: readonly AssessmentPayment[];
  readonly instalmentsCovered: readonly (Instalment & { readonly covered: Money; readonly overdue: boolean })[];
  readonly flags: readonly AssessmentFlag[];
}

const sum = (amounts: readonly Money[]): bigint => amounts.reduce((total, m) => total + centsOf(m), 0n);

/** Why the instalments are not valid (§51A): their sum is not the unit's share, or the due dates do not increase. */
export function instalmentsRefusal(
  content: Pick<AssessmentContent, 'unitShare' | 'instalments'>,
): 'INSTALMENTS_DO_NOT_SUM' | 'DUE_DATES_NOT_INCREASING' | undefined {
  const ordered = [...content.instalments].sort((a, b) => a.position - b.position);
  if (ordered.some((instalment, i) => i > 0 && instalment.dueDate <= (ordered[i - 1] as Instalment).dueDate)) return 'DUE_DATES_NOT_INCREASING';
  if (sum(ordered.map((i) => i.amount)) !== centsOf(content.unitShare)) return 'INSTALMENTS_DO_NOT_SUM';
  return undefined;
}

/**
 * The derived figures of §51A at `asOf`: paid (the counted cash), outstanding, the instalments covered in due order
 * (first due, first covered) and overdue when due before `asOf` and not fully covered, the status and the flags.
 */
export function deriveAssessment(
  assessment: SpecialAssessment,
  payments: readonly AssessmentPayment[],
  uncountedTransactionIds: readonly string[],
  asOf: BusinessDate,
): AssessmentView {
  const paid = sum(payments.map((p) => p.amount));
  const outstanding = centsOf(assessment.unitShare) - paid;
  let left = paid < 0n ? 0n : paid;
  const instalmentsCovered = [...assessment.instalments]
    .sort((a, b) => (a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : a.position - b.position))
    .map((instalment) => {
      const due = centsOf(instalment.amount);
      const covered = left < due ? left : due;
      left -= covered;
      return { ...instalment, covered: eur(covered), overdue: instalment.dueDate < asOf && covered < due };
    });
  const flags: AssessmentFlag[] = [];
  if (outstanding < 0n) flags.push({ code: 'OVERPAID', details: { amount: eur(-outstanding) } });
  const uses = sum(assessment.uses.map((u) => u.unitShare));
  if (uses > paid) flags.push({ code: 'USES_EXCEED_PAID', details: { uses: eur(uses), paid: eur(paid) } });
  if (uncountedTransactionIds.length > 0) flags.push({ code: 'UNCOUNTED_PAYMENTS', details: { transactionIds: [...new Set(uncountedTransactionIds)].sort() } });
  const status: AssessmentStatus = assessment.storedStatus === 'VOID' ? 'VOID' : outstanding <= 0n ? 'SETTLED' : 'ACTIVE';
  const ordered = [...payments].sort((a, b) =>
    a.bookingDate < b.bookingDate ? -1 : a.bookingDate > b.bookingDate ? 1 : a.transactionId < b.transactionId ? -1 : a.transactionId > b.transactionId ? 1 : 0,
  );
  return { ...assessment, status, paid: eur(paid), outstanding: eur(outstanding), payments: ordered, instalmentsCovered, flags };
}

const moneyKey = (m: Money | null) => (m === null ? null : m.amount);
const instalmentsKey = (instalments: readonly Instalment[]) =>
  JSON.stringify([...instalments].sort((a, b) => a.position - b.position).map((i) => [i.position, i.dueDate, i.amount.amount]));
const contentKey = (c: AssessmentContent) =>
  JSON.stringify([c.description, c.purpose, moneyKey(c.totalAmount), c.unitShare.amount, instalmentsKey(c.instalments), c.sourceReferences, c.notes]);

/** Whether an amend changes nothing (a `200` no-op). */
export const sameAssessmentContent = (a: AssessmentContent, b: AssessmentContent) => contentKey(a) === contentKey(b);

/** The fields an amend changed, for its AuditRecord. */
export function changedAssessmentFields(a: AssessmentContent, b: AssessmentContent): string[] {
  const fields: [string, unknown, unknown][] = [
    ['description', a.description, b.description],
    ['purpose', a.purpose, b.purpose],
    ['totalAmount', moneyKey(a.totalAmount), moneyKey(b.totalAmount)],
    ['unitShare', a.unitShare.amount, b.unitShare.amount],
    ['instalments', instalmentsKey(a.instalments), instalmentsKey(b.instalments)],
    ['sourceReferences', JSON.stringify(a.sourceReferences), JSON.stringify(b.sourceReferences)],
    ['notes', a.notes, b.notes],
  ];
  return fields.filter(([, x, y]) => x !== y).map(([name]) => name);
}

const usesKey = (uses: readonly AssessmentUse[]) =>
  JSON.stringify([...uses].sort((a, b) => a.position - b.position).map((u) => [u.position, u.date, u.description, u.unitShare.amount]));
export const sameUses = (a: readonly AssessmentUse[], b: readonly AssessmentUse[]) => usesKey(a) === usesKey(b);

/** Identity of a create for `Idempotency-Key` replays. */
export function assessmentFingerprint(assessment: NewSpecialAssessment): string {
  return JSON.stringify([assessment.membershipId, assessment.resolutionDate, contentKey(assessment)]);
}

export type CreateAssessmentOutcome =
  | { readonly kind: 'CREATED'; readonly assessment: AssessmentView }
  | { readonly kind: 'REPLAYED'; readonly assessment: AssessmentView }
  | { readonly kind: 'IDEMPOTENCY_CONFLICT' }
  | { readonly kind: 'MEMBERSHIP_NOT_FOUND' }
  | { readonly kind: 'MEMBERSHIP_NOT_ACTIVE'; readonly membershipId: string }
  | { readonly kind: 'ASSESSMENT_OUTSIDE_MEMBERSHIP'; readonly validFrom: BusinessDate; readonly validUntil: BusinessDate | null };

export type AmendAssessmentOutcome =
  | { readonly kind: 'AMENDED'; readonly assessment: AssessmentView; readonly changed: boolean }
  | { readonly kind: 'NOT_FOUND' }
  | { readonly kind: 'ASSESSMENT_NOT_ACTIVE' }
  | VersionConflict;

export type VoidAssessmentOutcome =
  | { readonly kind: 'VOIDED'; readonly assessment: AssessmentView; readonly changed: boolean }
  | { readonly kind: 'NOT_FOUND' }
  | { readonly kind: 'ASSESSMENT_HAS_SPLITS'; readonly transactionIds: readonly string[] }
  | VersionConflict;

export interface AssessmentFilter {
  readonly statuses?: readonly AssessmentStatus[];
  readonly purposes?: readonly AssessmentPurpose[];
}

/** Persistence port, implemented in infrastructure/postgres. Everything is scoped to the given Realm. */
export interface WegSpecialAssessmentRepository {
  /** Claims the key, writes the unit (no-op), locks the membership `FOR UPDATE`, checks §51A's order, inserts. */
  createAssessment(
    assessment: NewSpecialAssessment,
    actor: AuditActor,
    asOf: BusinessDate,
    idempotency?: { readonly key: string; readonly fingerprint: string },
  ): Promise<CreateAssessmentOutcome>;
  amendAssessment(
    id: string,
    mreRealmId: string,
    content: AssessmentContent,
    actor: AuditActor,
    asOf: BusinessDate,
    expectedVersions?: readonly number[],
  ): Promise<AmendAssessmentOutcome>;
  replaceUses(
    id: string,
    mreRealmId: string,
    uses: readonly AssessmentUse[],
    actor: AuditActor,
    asOf: BusinessDate,
    expectedVersions?: readonly number[],
  ): Promise<AmendAssessmentOutcome>;
  voidAssessment(
    id: string,
    mreRealmId: string,
    reason: string,
    at: Date,
    actor: AuditActor,
    asOf: BusinessDate,
    expectedVersions?: readonly number[],
  ): Promise<VoidAssessmentOutcome>;
  /** One `REPEATABLE READ READ ONLY` snapshot of the assessment and its cash. */
  findAssessment(id: string, mreRealmId: string, asOf: BusinessDate): Promise<AssessmentView | undefined>;
  /** By `resolutionDate`, `createdAt`, id; the derived status filtered; undefined for an unknown membership. */
  listAssessments(
    membershipId: string,
    mreRealmId: string,
    filter: AssessmentFilter,
    page: PageRequest,
    asOf: BusinessDate,
  ): Promise<Page<AssessmentView> | undefined>;
}
