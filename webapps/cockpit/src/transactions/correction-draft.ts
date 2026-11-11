import { partitionFieldErrors, type FieldError } from '../api/errors';
import type { CorrectInputDto, ReverseInputDto, TransactionDetailDto, TransactionDto } from '../api/transactions';
import { compareCents, decimalToCents, decimalToInput, parseAmountInput, type AmountProblem } from './split-amount';
import { bindSplitFieldErrors, checkDraft, draftFromDetail, toSplitsRequest, type DraftCheck, type DraftRow } from './split-draft';

/**
 * Step 4 of the first slice (ui-guide.md §10 "Bestätigung und Korrektur"): which Transaction may be confirmed or
 * corrected, the correction form's draft and the request it becomes, and the `Idempotency-Key` of one intent. Pure
 * functions; the components keep the draft in their state (§11: nothing but the unsaved draft lives in the browser).
 */

/**
 * The statuses `POST …/confirm` takes (api-design.md §34.2, `planConfirm`): `IMPORTED`, `UNREVIEWED` and `CLASSIFIED`.
 * The server needs a stored split set that covers the amount (`SPLITS_MISSING` without one); a split set moves the
 * first two to `CLASSIFIED` (§33), so in practice it is `CLASSIFIED`. `CONFIRMED` and `RECONCILED` would be a no-op,
 * `CORRECTED` and `IGNORED` are refused (`NOT_CONFIRMABLE`); none of them is offered.
 */
export const CONFIRMABLE_STATUSES: readonly string[] = ['IMPORTED', 'UNREVIEWED', 'CLASSIFIED'];

/** Whether "Buchung bestätigen" is offered: a confirmable status and a stored split set (the server re-checks both). */
/** Status and splits as read; a status is a string here, so one the client does not know is simply not offered (§7.4). */
interface ConfirmFacts {
  readonly status: string;
  readonly splits: readonly unknown[];
}

export const confirmable = (t: ConfirmFacts): boolean => CONFIRMABLE_STATUSES.includes(t.status) && t.splits.length > 0;

/** A confirmable status without splits: the page says to split first instead of offering a button the server refuses. */
export const needsSplitsBeforeConfirm = (t: ConfirmFacts): boolean => CONFIRMABLE_STATUSES.includes(t.status) && t.splits.length === 0;

/**
 * Whether "Korrigieren" is offered (api-design.md §35.1, §35.4): `CONFIRMED` and not itself a reversal. `RECONCILED`,
 * `CORRECTED` (the original of a chain is never edited, §6.3), unconfirmed, ignored and unknown statuses get none.
 */
export const correctable = (t: { readonly status: string; readonly correctionRole: string | null }): boolean =>
  t.status === 'CONFIRMED' && t.correctionRole !== 'REVERSAL';

/**
 * Whether „Stornieren“ is offered (api-design.md §35.9: refused as `correct` is): exactly where „Korrigieren“ is,
 * `CONFIRMED` and not itself a reversal (ui-guide.md §6.3: "fachlich erlaubte Korrektur/Storno"). Its own action
 * (§4.4), never a variant of the correction form.
 */
export const reversible = correctable;

/** The correction form: the original's values to start with; what differs from them is the replacement (§35.2). */
export interface CorrectionDraft {
  readonly reason: string;
  /** As typed, German (`850,00`). */
  readonly amount: string;
  readonly direction: string;
  readonly bookingDate: string;
  /** `''`: no value date. */
  readonly valueDate: string;
  /** `''`: no description. */
  readonly description: string;
  /** `''`: no object. */
  readonly propertyReferenceId: string;
  /** Whether the replacement gets its own split set; otherwise the server copies the original's (§35.2). */
  readonly changeSplits: boolean;
  readonly rows: readonly DraftRow[];
}

export function correctionDraftFrom(t: TransactionDetailDto, newKey: () => string): CorrectionDraft {
  return {
    reason: '',
    amount: decimalToInput(t.amount.amount) ?? t.amount.amount,
    direction: t.direction,
    bookingDate: t.bookingDate,
    valueDate: t.valueDate ?? '',
    description: t.description ?? '',
    propertyReferenceId: t.propertyReferenceId ?? '',
    changeSplits: false,
    rows: draftFromDetail(t, newKey),
  };
}

/** The reason is 1–500 characters after trimming (§35.2). */
export const MAX_REASON = 500;

export type CorrectionField = 'reason' | 'amount' | 'direction' | 'bookingDate' | 'valueDate' | 'description' | 'propertyReferenceId';

export type CorrectionProblem =
  AmountProblem | 'REASON_MISSING' | 'REASON_TOO_LONG' | 'DIRECTION_INVALID' | 'BOOKING_DATE_MISSING' | 'DATE_INVALID' | 'DESCRIPTION_TOO_LONG';

export interface CorrectionCheck {
  readonly problems: ReadonlyMap<CorrectionField, readonly CorrectionProblem[]>;
  /** The fields that differ from the original, in form order (what the replacement changes). */
  readonly changed: readonly (CorrectionField | 'splits')[];
  /** The replacement's amount as the API's decimal string, when readable: what its splits must cover. */
  readonly amount: string | undefined;
  /** The replacement's split set against its amount, when it gets its own. */
  readonly splits: DraftCheck | undefined;
  /** A changed amount with the original's splits copied: they cover the old amount, never the new one (§35.2). */
  readonly splitsRequired: boolean;
  readonly complete: boolean;
}

const DIRECTIONS = ['INFLOW', 'OUTFLOW'] as const;
const BUSINESS_DATE = /^\d{4}-\d{2}-\d{2}$/;
const orNull = (value: string): string | null => (value.trim() === '' ? null : value.trim());

/** The form against the original it corrects. Sendable only when every field is readable and something changes. */
export function checkCorrection(draft: CorrectionDraft, original: TransactionDto): CorrectionCheck {
  const problems = new Map<CorrectionField, CorrectionProblem[]>();
  const add = (field: CorrectionField, problem: CorrectionProblem) => problems.set(field, [...(problems.get(field) ?? []), problem]);
  const reason = draft.reason.trim();
  if (reason === '') add('reason', 'REASON_MISSING');
  if (reason.length > MAX_REASON) add('reason', 'REASON_TOO_LONG');
  const parsed = parseAmountInput(draft.amount);
  if (!parsed.ok) add('amount', parsed.problem);
  if (!(DIRECTIONS as readonly string[]).includes(draft.direction)) add('direction', 'DIRECTION_INVALID');
  if (draft.bookingDate === '') add('bookingDate', 'BOOKING_DATE_MISSING');
  else if (!BUSINESS_DATE.test(draft.bookingDate)) add('bookingDate', 'DATE_INVALID');
  if (draft.valueDate !== '' && !BUSINESS_DATE.test(draft.valueDate)) add('valueDate', 'DATE_INVALID');
  if (draft.description.trim().length > MAX_REASON) add('description', 'DESCRIPTION_TOO_LONG');

  const originalCents = decimalToCents(original.amount.amount);
  const amountChanged = parsed.ok && (originalCents === undefined || compareCents(parsed.cents, originalCents) !== 0);
  const changed: (CorrectionField | 'splits')[] = [];
  if (amountChanged) changed.push('amount');
  if (draft.direction !== original.direction) changed.push('direction');
  if (draft.bookingDate !== original.bookingDate) changed.push('bookingDate');
  if (orNull(draft.valueDate) !== original.valueDate) changed.push('valueDate');
  if (orNull(draft.description) !== original.description) changed.push('description');
  if (orNull(draft.propertyReferenceId) !== original.propertyReferenceId) changed.push('propertyReferenceId');
  if (draft.changeSplits) changed.push('splits');

  const amount = parsed.ok ? parsed.amount : undefined;
  const splits = draft.changeSplits ? checkDraft(draft.rows, amount ?? original.amount.amount) : undefined;
  const splitsRequired = amountChanged && !draft.changeSplits;
  const complete = problems.size === 0 && changed.length > 0 && !splitsRequired && (splits === undefined || (amount !== undefined && splits.complete));
  return { problems, changed, amount, splits, splitsRequired, complete };
}

/**
 * The request of `POST …/correct` (api-design.md §35.2; ui-guide.md §5.3, §8): the trimmed reason and only the fields
 * that differ from the original; an emptied value date, description or object as `null`. Never an id, status, version
 * or position copied from the detail: the server copies what is omitted. Throws for a form that is not complete.
 */
export function toCorrectRequest(draft: CorrectionDraft, original: TransactionDto): CorrectInputDto {
  const check = checkCorrection(draft, original);
  if (!check.complete || check.amount === undefined) throw new TypeError('The correction is not complete.');
  const currency = original.amount.currency;
  const has = (field: CorrectionField | 'splits') => check.changed.includes(field);
  return {
    reason: draft.reason.trim(),
    replacement: {
      ...(has('amount') ? { amount: { amount: check.amount, currency } } : {}),
      ...(has('direction') ? { direction: draft.direction as (typeof DIRECTIONS)[number] } : {}),
      ...(has('bookingDate') ? { bookingDate: draft.bookingDate } : {}),
      ...(has('valueDate') ? { valueDate: orNull(draft.valueDate) } : {}),
      ...(has('description') ? { description: orNull(draft.description) } : {}),
      ...(has('propertyReferenceId') ? { propertyReferenceId: orNull(draft.propertyReferenceId) } : {}),
      ...(has('splits') ? { splits: [...toSplitsRequest(draft.rows, currency).splits] } : {}),
    },
  };
}

export type ReasonProblem = 'REASON_MISSING' | 'REASON_TOO_LONG';

/** The reason of `reverse` (§35.9), as the correction's: 1–500 characters after trimming; the length counted trimmed. */
export function checkReverseReason(reason: string): { readonly length: number; readonly problems: readonly ReasonProblem[] } {
  const trimmed = reason.trim();
  const problems: ReasonProblem[] = [];
  if (trimmed === '') problems.push('REASON_MISSING');
  if (trimmed.length > MAX_REASON) problems.push('REASON_TOO_LONG');
  return { length: trimmed.length, problems };
}

/** The request of `POST …/reverse` (§35.9): the trimmed reason and nothing else. Throws for a reason that is not sendable. */
export function toReverseRequest(reason: string): ReverseInputDto {
  if (checkReverseReason(reason).problems.length > 0) throw new TypeError('The reason is not sendable.');
  return { reason: reason.trim() };
}

/**
 * One business intent of the user (ui-guide.md §7.3): its `Idempotency-Key` and the body it was made for. The same body
 * sent again (a retry after a lost answer, "Erneut senden", another click on the unchanged form) keeps the key; a
 * changed body is a new intent with a new key; after a success there is no intent left, so the next one is new. Each form
 * keeps its own intent: a reversal never reuses a correction's key (the server scopes them apart, §15, §35.9).
 */
export interface CorrectionIntent {
  readonly key: string;
  readonly payload: string;
}

export function intentFor(previous: CorrectionIntent | undefined, body: CorrectInputDto | ReverseInputDto, newKey: () => string): CorrectionIntent {
  const payload = JSON.stringify(body);
  return previous !== undefined && previous.payload === payload ? previous : { key: newKey(), payload };
}

/** The form's controls by the dotted names of `details.fields` (§58X); the replacement's splits bind like step 3's. */
const FIELD_CONTROLS: readonly (readonly [pattern: string, field: CorrectionField])[] = [
  ['reason', 'reason'],
  ['replacement.amount', 'amount'],
  ['replacement.amount.amount', 'amount'],
  ['replacement.amount.currency', 'amount'],
  ['replacement.direction', 'direction'],
  ['replacement.bookingDate', 'bookingDate'],
  ['replacement.valueDate', 'valueDate'],
  ['replacement.description', 'description'],
  ['replacement.propertyReferenceId', 'propertyReferenceId'],
];

const SPLITS_PREFIX = 'replacement.';

export interface BoundCorrectionErrors {
  readonly fields: ReadonlyMap<CorrectionField, readonly FieldError[]>;
  /** By the split rows' `controlId`, for the rows that were sent. */
  readonly rows: ReadonlyMap<string, readonly FieldError[]>;
}

/**
 * Field errors bound to the form: its own fields, and `replacement.splits.N.…` to row N when splits were sent. The rest
 * (`(body)`, `Idempotency-Key`, `If-Match`, `replacement.financialAccountId`, an unknown name) binds to nothing and
 * stays in the summary only (ui-guide.md §7.4).
 */
export function bindCorrectionFieldErrors(errors: readonly FieldError[], sentRows: number): BoundCorrectionErrors {
  const fields = new Map<CorrectionField, FieldError[]>();
  for (const entry of partitionFieldErrors(
    errors,
    FIELD_CONTROLS.map(([pattern]) => pattern),
  ).known) {
    const field = FIELD_CONTROLS.find(([pattern]) => pattern === entry.pattern)?.[1];
    if (field !== undefined) fields.set(field, [...(fields.get(field) ?? []), entry]);
  }
  const splitErrors = errors
    .filter((entry) => entry.field.startsWith(`${SPLITS_PREFIX}splits.`))
    .map((entry) => ({ ...entry, field: entry.field.slice(SPLITS_PREFIX.length) }));
  return { fields, rows: bindSplitFieldErrors(splitErrors, sentRows) };
}
