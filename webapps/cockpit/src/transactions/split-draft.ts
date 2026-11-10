import { partitionFieldErrors, type FieldError } from '../api/errors';
import type { SplitInputDto, TransactionDetailDto, TransactionSplitDto } from '../api/transactions';
import { addCents, compareCents, decimalToCents, decimalToInput, differenceAsDecimal, parseAmountInput, type AmountProblem } from './split-amount';

/**
 * The split editor's draft (ui-guide.md §6.4, §10 step 3) and the request it becomes. Pure functions: the component
 * keeps the draft in its state, nothing else is kept in the browser (§11: no new state only in the browser beyond the
 * unsaved draft).
 */

/** The statuses whose split set may be replaced (§6.3: Splits for IMPORTED, UNREVIEWED, CLASSIFIED; api-design §33.2). */
export const SPLITTABLE_STATUSES: readonly string[] = ['IMPORTED', 'UNREVIEWED', 'CLASSIFIED'];

/** Whether the editor is offered. Any other status, an unknown one included, gets none (§7.4: no action for an unknown enum). */
export const splitsEditable = (status: string): boolean => SPLITTABLE_STATUSES.includes(status);

/** 1–100 splits (api-design.md §33.2). */
export const MIN_SPLITS = 1;
export const MAX_SPLITS = 100;

/**
 * The reference of one split. The kind decides which ids it carries, so the exclusions of §6.4 hold by construction:
 * a Loan without an object, a deposit alone, a WEG statement or Sonderumlage with its object only. The kinds of the
 * request schema that the backend refuses (`rentalContractReferenceId`, `wegId`, `maintenanceProjectId`,
 * `acquisitionId`, `taxClassificationId`; §6.4) do not exist here.
 */
export type SplitReference =
  | { readonly kind: 'none' }
  | { readonly kind: 'property'; readonly propertyReferenceId: string }
  | { readonly kind: 'loan'; readonly loanId: string }
  | { readonly kind: 'securityDeposit'; readonly securityDepositId: string }
  | { readonly kind: 'wegAnnualStatement'; readonly wegAnnualStatementId: string; readonly propertyReferenceId: string }
  | { readonly kind: 'wegSpecialAssessment'; readonly wegSpecialAssessmentId: string; readonly propertyReferenceId: string };

export type ReferenceKind = SplitReference['kind'];

export interface DraftRow {
  /** A key for React only; never sent (split ids and positions are the server's, §8). */
  readonly key: string;
  /** The amount as typed. */
  readonly amount: string;
  readonly financialCategoryCode: string;
  readonly reference: SplitReference;
  /**
   * The Loan, deposit or WEG reference the stored split had. Those are kept and can be removed, but not chosen anew:
   * their lists belong to the Finanzierung, Kautionen and WEG areas, which come after the first slice (§10).
   */
  readonly kept: SplitReference | undefined;
  readonly description: string;
}

/** The reference a stored split names (api-design.md §33.2). */
export function referenceOf(split: TransactionSplitDto): SplitReference {
  const property = split.propertyReferenceId;
  if (split.wegSpecialAssessmentId !== null && property !== null) {
    return { kind: 'wegSpecialAssessment', wegSpecialAssessmentId: split.wegSpecialAssessmentId, propertyReferenceId: property };
  }
  if (split.wegAnnualStatementId !== null && property !== null) {
    return { kind: 'wegAnnualStatement', wegAnnualStatementId: split.wegAnnualStatementId, propertyReferenceId: property };
  }
  if (split.securityDepositId !== null) return { kind: 'securityDeposit', securityDepositId: split.securityDepositId };
  if (split.loanId !== null) return { kind: 'loan', loanId: split.loanId };
  if (property !== null) return { kind: 'property', propertyReferenceId: property };
  return { kind: 'none' };
}

const isKept = (reference: SplitReference): boolean => reference.kind !== 'none' && reference.kind !== 'property';

/**
 * The draft for a stored split set: category, amount, reference and description of each split, nothing else (§8: no
 * split id, position or status back into the request). Without splits, one row over the whole amount.
 */
export function draftFromSplits(splits: readonly TransactionSplitDto[], amount: string, newKey: () => string): DraftRow[] {
  if (splits.length === 0) {
    return [{ key: newKey(), amount: decimalToInput(amount) ?? '', financialCategoryCode: '', reference: { kind: 'none' }, kept: undefined, description: '' }];
  }
  return splits.map((split) => {
    const reference = referenceOf(split);
    return {
      key: newKey(),
      amount: decimalToInput(split.amount.amount) ?? split.amount.amount,
      financialCategoryCode: split.financialCategoryCode,
      reference,
      kept: isKept(reference) ? reference : undefined,
      description: split.description ?? '',
    };
  });
}

export const draftFromDetail = (t: TransactionDetailDto, newKey: () => string): DraftRow[] => draftFromSplits(t.splits, t.amount.amount, newKey);

/** The kinds a row offers: none, an object, and the kept reference of its stored split. */
export function referenceKinds(row: DraftRow): readonly ReferenceKind[] {
  return row.kept === undefined ? ['none', 'property'] : ['none', 'property', row.kept.kind];
}

/** Changing the kind removes the ids the new kind does not use (§6.4: "Nicht verwendete Referenzen … gezielt entfernen"). */
export function withReferenceKind(row: DraftRow, kind: ReferenceKind): DraftRow {
  if (kind === 'none') return { ...row, reference: { kind: 'none' } };
  if (kind === 'property') {
    const property = 'propertyReferenceId' in row.reference ? row.reference.propertyReferenceId : '';
    return { ...row, reference: { kind: 'property', propertyReferenceId: property } };
  }
  return row.kept?.kind === kind ? { ...row, reference: row.kept } : row;
}

export function addRow(rows: readonly DraftRow[], newKey: () => string): readonly DraftRow[] {
  if (rows.length >= MAX_SPLITS) return rows;
  return [...rows, { key: newKey(), amount: '', financialCategoryCode: '', reference: { kind: 'none' }, kept: undefined, description: '' }];
}

export function removeRow(rows: readonly DraftRow[], key: string): readonly DraftRow[] {
  return rows.length <= MIN_SPLITS ? rows : rows.filter((row) => row.key !== key);
}

export type RowProblem = AmountProblem | 'CATEGORY_MISSING' | 'PROPERTY_MISSING';

export interface DraftCheck {
  /** Per row, in order: what keeps it from being sent. */
  readonly problems: readonly (readonly RowProblem[])[];
  /** The sum of the readable amounts, as the API's decimal string. */
  readonly sum: string;
  /** Transaction amount minus the sum, signed: `0.00` when it is covered exactly. */
  readonly rest: string;
  readonly exact: boolean;
  readonly countOk: boolean;
  /** Every row readable and complete, 1–100 rows, and the sum equal to the amount exactly (no tolerance, §6.4). */
  readonly complete: boolean;
}

/** The draft against the Transaction's amount. An unreadable Transaction amount is never covered. */
export function checkDraft(rows: readonly DraftRow[], transactionAmount: string): DraftCheck {
  let sum = '0';
  const problems = rows.map((row) => {
    const found: RowProblem[] = [];
    const parsed = parseAmountInput(row.amount);
    if (parsed.ok) sum = addCents(sum, parsed.cents);
    else found.push(parsed.problem);
    if (row.financialCategoryCode === '') found.push('CATEGORY_MISSING');
    if ('propertyReferenceId' in row.reference && row.reference.propertyReferenceId === '') found.push('PROPERTY_MISSING');
    return found;
  });
  const total = decimalToCents(transactionAmount);
  const exact = total !== undefined && compareCents(sum, total) === 0;
  const countOk = rows.length >= MIN_SPLITS && rows.length <= MAX_SPLITS;
  return {
    problems,
    sum: differenceAsDecimal(sum, '0'),
    rest: total === undefined ? '0.00' : differenceAsDecimal(total, sum),
    exact,
    countOk,
    complete: exact && countOk && problems.every((found) => found.length === 0),
  };
}

/**
 * The request of `PUT /transactions/{id}/splits` (api-design.md §33.2, ui-guide.md §5.3, §8): the whole set, each split
 * with its amount in the Transaction's currency, its category, the ids of its reference kind and a description when one
 * is typed. No split id, position, status or direction; no UI field. Throws for a row that is not complete.
 */
export function toSplitsRequest(rows: readonly DraftRow[], currency: string): { readonly splits: readonly SplitInputDto[] } {
  return {
    splits: rows.map((row): SplitInputDto => {
      const parsed = parseAmountInput(row.amount);
      if (!parsed.ok) throw new TypeError(`Split amount not readable: ${parsed.problem}`);
      const description = row.description.trim();
      return {
        amount: { amount: parsed.amount, currency },
        financialCategoryCode: row.financialCategoryCode,
        ...referenceIds(row.reference),
        ...(description === '' ? {} : { description }),
      };
    }),
  };
}

/** The ids a reference sends: exactly those of its kind. */
function referenceIds(reference: SplitReference): Partial<SplitInputDto> {
  switch (reference.kind) {
    case 'none':
      return {};
    case 'property':
      return { propertyReferenceId: reference.propertyReferenceId };
    case 'loan':
      return { loanId: reference.loanId };
    case 'securityDeposit':
      return { securityDepositId: reference.securityDepositId };
    case 'wegAnnualStatement':
      return { wegAnnualStatementId: reference.wegAnnualStatementId, propertyReferenceId: reference.propertyReferenceId };
    case 'wegSpecialAssessment':
      return { wegSpecialAssessmentId: reference.wegSpecialAssessmentId, propertyReferenceId: reference.propertyReferenceId };
  }
}

/** The controls of one row, in screen order. */
export const ROW_CONTROLS = ['category', 'amount', 'reference', 'property', 'description'] as const;
export type RowControl = (typeof ROW_CONTROLS)[number];

export const controlId = (index: number, control: RowControl): string => `split-${index}-${control}`;

/** The names of `details.fields` (§58X: dotted with the index) that a row's control shows. */
const FIELD_CONTROLS: readonly (readonly [pattern: string, control: RowControl])[] = [
  ['splits.*.financialCategoryCode', 'category'],
  ['splits.*.amount', 'amount'],
  ['splits.*.amount.amount', 'amount'],
  ['splits.*.amount.currency', 'amount'],
  ['splits.*.propertyReferenceId', 'property'],
  ['splits.*.loanId', 'reference'],
  ['splits.*.securityDepositId', 'reference'],
  ['splits.*.wegAnnualStatementId', 'reference'],
  ['splits.*.wegSpecialAssessmentId', 'reference'],
  ['splits.*.description', 'description'],
];

/**
 * Field errors by control id for the rows that were sent; the rest (`splits`, `(body)`, `If-Match`, an index beyond
 * the rows, an unknown name) binds to nothing and stays in the summary only (ui-guide.md §7.4).
 */
export function bindSplitFieldErrors(fields: readonly FieldError[], rowCount: number): ReadonlyMap<string, readonly FieldError[]> {
  const map = new Map<string, FieldError[]>();
  for (const entry of partitionFieldErrors(
    fields,
    FIELD_CONTROLS.map(([pattern]) => pattern),
  ).known) {
    const index = Number(entry.field.split('.')[1]);
    const control = FIELD_CONTROLS.find(([pattern]) => pattern === entry.pattern)?.[1];
    if (control === undefined || index >= rowCount) continue;
    const id = controlId(index, control);
    map.set(id, [...(map.get(id) ?? []), entry]);
  }
  return map;
}

/** The first bound control in screen order (§4.3: a refused form focuses its first wrong field). */
export function firstBoundControl(bound: ReadonlyMap<string, unknown>, rowCount: number): string | undefined {
  for (let index = 0; index < rowCount; index += 1) {
    for (const control of ROW_CONTROLS) if (bound.has(controlId(index, control))) return controlId(index, control);
  }
  return undefined;
}
