import type { AssetReviewState, EntryChange, UsefulLifeEvidence } from './asset.js';

/**
 * The method status of a purchase (api-design.md §59C, backlog VC-X-37, which subsumes VC-X-32): one entry per
 * Acquisition on the building asset (`purchaseMethods`, beside `shorterUsefulLives` and on the same amend and review
 * pattern) stating how the purchase was acquired and depreciated so far, with evidence. `methodStatus` is derived,
 * never stored: `STANDARD` exactly when the facts match the rule's `methodStatus.standard`, else `NOT_SUPPORTED` with
 * its `causes`. The schedule computes a purchase only under a confirmed `STANDARD` entry: an unknown method is never
 * assumed linear (Prüfbericht 2026-11-01, Frage 2).
 */

export const CONSIDERATIONS = ['PAID', 'PARTLY_PAID', 'UNPAID'] as const;
export type Consideration = (typeof CONSIDERATIONS)[number];
export const PURCHASE_METHODS = ['LINEAR_7_4', 'DEGRESSIVE_7_5', 'DEGRESSIVE_7_5A', 'OTHER'] as const;
export type PurchaseMethodCode = (typeof PURCHASE_METHODS)[number];
export const SPECIAL_DEPRECIATIONS = ['SPECIAL_7B', 'INCREASED_7H', 'INCREASED_7I', 'OTHER'] as const;
export type SpecialDepreciation = (typeof SPECIAL_DEPRECIATIONS)[number];
export const MAX_PURCHASE_METHODS = 20;

/** The causes of `NOT_SUPPORTED`, in the order of §59C's table. */
export const METHOD_CAUSES = [
  'PARTLY_PAID',
  'UNPAID',
  'METHOD_DEGRESSIVE_7_5',
  'METHOD_DEGRESSIVE_7_5A',
  'METHOD_OTHER',
  'SPECIAL_7B',
  'INCREASED_7H',
  'INCREASED_7I',
  'SPECIAL_OTHER',
  'SUBSIDIES_RECEIVED',
  'NEW_BUILDING_BY_CONVERSION',
  'OTHER_SPECIAL_CASE',
] as const;
export type MethodCause = (typeof METHOD_CAUSES)[number];
export type MethodStatus = 'STANDARD' | 'NOT_SUPPORTED';

/** The two reasons of the gate (§59C "The gate in the schedule"), both open. */
export const METHOD_REASONS = ['DEPRECIATION_METHOD_NOT_CONFIRMED', 'DEPRECIATION_METHOD_NOT_SUPPORTED'] as const;
export type MethodReason = (typeof METHOD_REASONS)[number];

/** The facts of an entry: a change of any of them resets its review state (§59C). */
export interface PurchaseMethodFacts {
  readonly consideration: Consideration;
  readonly method: PurchaseMethodCode;
  /** In `SPECIAL_DEPRECIATIONS` order, each once; `[]` states that none was claimed. */
  readonly specialDepreciation: readonly SpecialDepreciation[];
  readonly subsidiesReceived: boolean;
  readonly newBuildingByConversion: boolean;
  readonly otherSpecialCase: boolean;
}

/** One purchase's method entry (§59C "The model"). */
export interface PurchaseMethod extends PurchaseMethodFacts {
  readonly acquisitionId: string;
  /** Set exactly when `otherSpecialCase`; not a fact (a changed note keeps the review state). */
  readonly otherSpecialCaseNote: string | null;
  readonly evidence: UsefulLifeEvidence;
  readonly reviewState: AssetReviewState;
  readonly advisorPartyId: string | null;
  readonly notes: string | null;
}

/** An entry as an amend names it: its review state and advisor are optional (an unchanged entry keeps its own). */
export type PurchaseMethodAmendment = Omit<PurchaseMethod, 'reviewState' | 'advisorPartyId'> & {
  readonly reviewState?: AssetReviewState;
  readonly advisorPartyId?: string | null;
};

/** One entry an amend adds, changes or removes (the AuditRecord's `changedPurchaseMethods`). */
export interface ChangedPurchaseMethod {
  readonly acquisitionId: string;
  readonly change: EntryChange;
  readonly from: PurchaseMethod | null;
  readonly to: PurchaseMethod | null;
}

/** The rule's parameter `methodStatus` of `DE_AFA_BUILDING_LINEAR@1`/`@2` (§59C "The rule"). */
export interface MethodStatusParameters {
  readonly required: boolean;
  readonly standard: {
    readonly consideration: readonly string[];
    readonly methods: readonly string[];
    readonly specialDepreciation: readonly string[];
    readonly subsidiesReceived: boolean;
    readonly newBuildingByConversion: boolean;
    readonly otherSpecialCase: boolean;
  };
  readonly confirmedReviewStates: readonly string[];
  readonly legalBasis: string;
  readonly source: string;
}

/** The special depreciations in their canonical order, each once (the order an entry is stored and compared in). */
export const canonicalSpecial = (values: readonly SpecialDepreciation[]): SpecialDepreciation[] => SPECIAL_DEPRECIATIONS.filter((v) => values.includes(v));

const SPECIAL_CAUSE: Readonly<Record<SpecialDepreciation, MethodCause>> = {
  SPECIAL_7B: 'SPECIAL_7B',
  INCREASED_7H: 'INCREASED_7H',
  INCREASED_7I: 'INCREASED_7I',
  OTHER: 'SPECIAL_OTHER',
};

/**
 * `methodStatus` and its `causes` (§59C): `STANDARD` exactly when every fact matches the rule's `standard`; each fact
 * that differs is a cause, in the table's order. The judgement is the rule's, never a constant (AGENTS.md §16).
 */
export function methodStatusOf(facts: PurchaseMethodFacts, parameters: MethodStatusParameters): { methodStatus: MethodStatus; causes: string[] } {
  const standard = parameters.standard;
  const causes: string[] = [];
  if (!standard.consideration.includes(facts.consideration)) causes.push(facts.consideration);
  if (!standard.methods.includes(facts.method)) causes.push(`METHOD_${facts.method}`);
  for (const s of canonicalSpecial(facts.specialDepreciation)) if (!standard.specialDepreciation.includes(s)) causes.push(SPECIAL_CAUSE[s]);
  if (facts.subsidiesReceived !== standard.subsidiesReceived) causes.push('SUBSIDIES_RECEIVED');
  if (facts.newBuildingByConversion !== standard.newBuildingByConversion) causes.push('NEW_BUILDING_BY_CONVERSION');
  if (facts.otherSpecialCase !== standard.otherSpecialCase) causes.push('OTHER_SPECIAL_CASE');
  const rank = (c: string) => {
    const i = (METHOD_CAUSES as readonly string[]).indexOf(c);
    return i < 0 ? METHOD_CAUSES.length : i;
  };
  causes.sort((a, b) => rank(a) - rank(b));
  return { methodStatus: causes.length === 0 ? 'STANDARD' : 'NOT_SUPPORTED', causes };
}

/**
 * The method reason of a purchase component (§59C "The gate"): `null` only for a confirmed `STANDARD` entry. Without
 * the rule's parameter nothing can be judged, so the purchase is not confirmed (never assumed linear).
 */
export function methodReasonOf(
  acquisitionId: string,
  entry: PurchaseMethod | undefined,
  parameters: MethodStatusParameters | undefined,
  newBuildingInCompletionYear: boolean,
): { readonly code: MethodReason; readonly details: Record<string, unknown> } | null {
  const status = entry === undefined || parameters === undefined ? undefined : methodStatusOf(entry, parameters);
  const confirmed = entry !== undefined && parameters !== undefined && parameters.confirmedReviewStates.includes(entry.reviewState);
  if (!confirmed || status === undefined) {
    return {
      code: 'DEPRECIATION_METHOD_NOT_CONFIRMED',
      details: {
        acquisitionId,
        reviewState: entry?.reviewState ?? null,
        methodStatus: status?.methodStatus ?? null,
        causes: status?.causes ?? null,
        newBuildingInCompletionYear,
      },
    };
  }
  if (status.methodStatus === 'STANDARD') return null;
  return { code: 'DEPRECIATION_METHOD_NOT_SUPPORTED', details: { acquisitionId, reviewState: entry.reviewState, causes: status.causes } };
}

export const isMethodReason = (code: string) => (METHOD_REASONS as readonly string[]).includes(code);

const sameFacts = (a: PurchaseMethodFacts, b: PurchaseMethodFacts) =>
  a.consideration === b.consideration &&
  a.method === b.method &&
  canonicalSpecial(a.specialDepreciation).join() === canonicalSpecial(b.specialDepreciation).join() &&
  a.subsidiesReceived === b.subsidiesReceived &&
  a.newBuildingByConversion === b.newBuildingByConversion &&
  a.otherSpecialCase === b.otherSpecialCase;

const sameEvidence = (a: UsefulLifeEvidence, b: UsefulLifeEvidence) =>
  a.source === b.source && a.date === b.date && a.documentReference === b.documentReference;

export const samePurchaseMethod = (a: PurchaseMethod, b: PurchaseMethod) =>
  sameFacts(a, b) &&
  a.otherSpecialCaseNote === b.otherSpecialCaseNote &&
  sameEvidence(a.evidence, b.evidence) &&
  a.notes === b.notes &&
  a.reviewState === b.reviewState &&
  a.advisorPartyId === b.advisorPartyId;

/**
 * The entry an amend leaves (§59C): a changed fact takes the state the body gives (default `UNREVIEWED`), as §59's
 * shorter life; a changed `evidence`, `notes` or note alone keeps the entry's state and advisor.
 */
export function nextPurchaseMethod(current: PurchaseMethod | undefined, named: PurchaseMethodAmendment): PurchaseMethod {
  const base = {
    acquisitionId: named.acquisitionId,
    consideration: named.consideration,
    method: named.method,
    specialDepreciation: canonicalSpecial(named.specialDepreciation),
    subsidiesReceived: named.subsidiesReceived,
    newBuildingByConversion: named.newBuildingByConversion,
    otherSpecialCase: named.otherSpecialCase,
    otherSpecialCaseNote: named.otherSpecialCaseNote,
    evidence: named.evidence,
    notes: named.notes,
  };
  if (current === undefined || !sameFacts(current, base) || named.reviewState !== undefined) {
    return { ...base, reviewState: named.reviewState ?? 'UNREVIEWED', advisorPartyId: named.advisorPartyId ?? null };
  }
  return { ...base, reviewState: current.reviewState, advisorPartyId: current.advisorPartyId };
}

/** The difference of two entry lists by `acquisitionId` (added, changed, removed; an unchanged one is not listed). */
export function changedPurchaseMethods(old: readonly PurchaseMethod[], next: readonly PurchaseMethod[]): ChangedPurchaseMethod[] {
  const before = new Map(old.map((e) => [e.acquisitionId, e]));
  const after = new Map(next.map((e) => [e.acquisitionId, e]));
  return [...new Set([...before.keys(), ...after.keys()])].sort().flatMap((acquisitionId): ChangedPurchaseMethod[] => {
    const from = before.get(acquisitionId) ?? null;
    const to = after.get(acquisitionId) ?? null;
    if (from === null) return [{ acquisitionId, change: 'ADDED', from, to }];
    if (to === null) return [{ acquisitionId, change: 'REMOVED', from, to }];
    return samePurchaseMethod(from, to) ? [] : [{ acquisitionId, change: 'CHANGED', from, to }];
  });
}

/** An entry's part of the idempotency fingerprint (§59C: the entries ordered by `acquisitionId`). */
export const purchaseMethodFingerprint = (e: PurchaseMethod) => [
  e.acquisitionId,
  e.consideration,
  e.method,
  canonicalSpecial(e.specialDepreciation),
  e.subsidiesReceived,
  e.newBuildingByConversion,
  e.otherSpecialCase,
  e.otherSpecialCaseNote,
  e.evidence.source,
  e.evidence.date,
  e.evidence.documentReference,
  e.reviewState,
  e.advisorPartyId,
  e.notes,
];
