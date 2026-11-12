import type { ReactNode } from 'react';
import type { FieldError } from '../../api/errors';
import { negateDecimal } from '../../format/money';
import {
  controlId,
  referenceKinds,
  withReferenceKind,
  type DraftRow,
  type ReferenceKind,
  type RowControl,
  type RowProblem,
} from '../../transactions/split-draft';
import { describeFieldError } from '../error-text';
import { MoneyText } from '../format';
import { secondaryButtonClass } from '../states';
import { NamedId } from '../technical';
import { categoryName, propertyName, type References } from './references';

/**
 * The rows of a split set and their sum (ui-guide.md §6.4): shared by the split editor (step 3) and the replacement's
 * splits of a correction (step 4), so both read amounts the same way (split-amount.ts, no floating point) and bind the
 * same field names. `idPrefix` keeps the ids of two forms on one page apart; the field-error map stays keyed by
 * `controlId` without it.
 */

export const AMOUNT_TEXTS: Readonly<Record<RowProblem, string>> = {
  EMPTY: 'Betrag fehlt.',
  NEGATIVE: 'Ein Teilbetrag ist nie negativ; die Richtung steht an der Buchung.',
  TOO_MANY_DECIMALS: 'Höchstens zwei Nachkommastellen; es wird nicht gerundet.',
  AMBIGUOUS: 'Mehrdeutig: bitte mit Dezimalkomma schreiben, z. B. 1234,56 oder 1.234,56.',
  INVALID: 'Kein Betrag: Ziffern mit Dezimalkomma, z. B. 1.234,56.',
  TOO_LARGE: 'Höchstens 18 Stellen vor dem Komma.',
  CATEGORY_MISSING: 'Kategorie wählen.',
  PROPERTY_MISSING: 'Objekt wählen.',
};

export const REFERENCE_LABELS: Readonly<Record<ReferenceKind, string>> = {
  none: 'Kein Bezug',
  property: 'Objekt',
  loan: 'Darlehen (bestehender Bezug)',
  securityDeposit: 'Kaution (bestehender Bezug)',
  wegAnnualStatement: 'WEG-Jahresabrechnung (bestehender Bezug)',
  wegSpecialAssessment: 'Sonderumlage (bestehender Bezug)',
};

export const inputClass = 'min-h-touch w-full rounded-input border border-border bg-surface px-3 text-base';

/** Amount, sum and the live rest (§6.4: exact sum; the rest names what is left or too much). */
export function Totals(props: {
  readonly idPrefix?: string;
  readonly amount: string;
  readonly currency: string;
  readonly sum: string;
  readonly rest: string;
  readonly exact: boolean;
}) {
  const over = props.rest.startsWith('-');
  const restText = props.exact
    ? 'Die Teilbeträge decken den Betrag der Buchung genau.'
    : over
      ? 'Zu viel verteilt: die Teilbeträge übersteigen den Betrag der Buchung.'
      : 'Noch nicht verteilt: die Teilbeträge decken den Betrag der Buchung nicht.';
  return (
    <div className="flex flex-col gap-1">
      <dl className="grid max-w-md grid-cols-[1fr_auto] gap-x-4">
        <dt className="text-muted">Betrag der Buchung</dt>
        <dd className="text-right">
          <MoneyText money={{ amount: props.amount, currency: props.currency }} />
        </dd>
        <dt className="text-muted">Summe der Teilbeträge</dt>
        <dd className="text-right" data-testid={`${props.idPrefix ?? ''}split-sum`}>
          <MoneyText money={{ amount: props.sum, currency: props.currency }} />
        </dd>
        <dt className="font-semibold">Rest</dt>
        <dd className="text-right font-semibold" data-testid={`${props.idPrefix ?? ''}split-rest-amount`}>
          <MoneyText money={{ amount: over ? negateDecimal(props.rest) : props.rest, currency: props.currency }} />
          {over ? ' zu viel' : ''}
        </dd>
      </dl>
      <p id={`${props.idPrefix ?? ''}split-rest`} role="status" aria-live="polite" className={props.exact ? 'text-success-text' : 'text-warning-text'}>
        {restText}
      </p>
    </div>
  );
}

export function SplitRow(props: {
  /** Prefixes the ids of the row's controls, so two forms with rows can share a page (step 4's correction). */
  readonly idPrefix?: string;
  readonly row: DraftRow;
  readonly index: number;
  readonly currency: string;
  readonly problems: readonly RowProblem[];
  readonly bound: ReadonlyMap<string, readonly FieldError[]>;
  readonly references: References;
  readonly canRemove: boolean;
  readonly onChange: (update: (row: DraftRow) => DraftRow) => void;
  readonly onRemove: () => void;
}) {
  const { row, index, references } = props;
  const prefix = props.idPrefix ?? '';
  const local = (control: RowControl): readonly string[] =>
    props.problems
      .filter((p) =>
        control === 'category'
          ? p === 'CATEGORY_MISSING'
          : control === 'property'
            ? p === 'PROPERTY_MISSING'
            : control === 'amount' && p !== 'CATEGORY_MISSING' && p !== 'PROPERTY_MISSING',
      )
      .map((p) => AMOUNT_TEXTS[p]);
  const field = (control: RowControl, label: string, render: (aria: Record<string, string | boolean | undefined>) => ReactNode) => (
    <Field id={prefix + controlId(index, control)} label={label} local={local(control)} server={props.bound.get(controlId(index, control))} render={render} />
  );
  const categories = references.categories.status === 'success' ? references.categories.data : [];
  const active = categories.filter((c) => c.active);
  const current = row.financialCategoryCode;
  const properties = references.properties.status === 'success' ? references.properties.data.items : [];
  const reference = row.reference;

  return (
    <fieldset className="grid gap-3 rounded-card border border-border p-4 md:grid-cols-2">
      <legend className="px-1 font-semibold">{`Teilbetrag ${index + 1}`}</legend>
      {field('category', 'Kategorie', (aria) => (
        <select
          id={prefix + controlId(index, 'category')}
          value={current}
          className={inputClass}
          onChange={(event) => props.onChange((r) => ({ ...r, financialCategoryCode: event.target.value }))}
          {...aria}
        >
          <option value="">Kategorie wählen</option>
          {active.map((c) => (
            <option key={c.code} value={c.code}>
              {c.name}
            </option>
          ))}
          {current !== '' && !active.some((c) => c.code === current) && (
            <option value={current}>{`${categoryName(references, current) ?? 'Kategorie'} ${current} (nicht wählbar)`}</option>
          )}
        </select>
      ))}
      {field('amount', `Betrag in ${props.currency}`, (aria) => (
        <input
          id={prefix + controlId(index, 'amount')}
          type="text"
          inputMode="decimal"
          autoComplete="off"
          value={row.amount}
          className={`${inputClass} text-right tabular-nums`}
          onChange={(event) => props.onChange((r) => ({ ...r, amount: event.target.value }))}
          {...aria}
        />
      ))}
      {field('reference', 'Bezug', (aria) => (
        <select
          id={prefix + controlId(index, 'reference')}
          value={reference.kind}
          className={inputClass}
          onChange={(event) => props.onChange((r) => withReferenceKind(r, event.target.value as ReferenceKind))}
          {...aria}
        >
          {referenceKinds(row).map((kind) => (
            <option key={kind} value={kind}>
              {REFERENCE_LABELS[kind]}
            </option>
          ))}
        </select>
      ))}
      {reference.kind === 'property' &&
        field('property', 'Objekt', (aria) => (
          <select
            id={prefix + controlId(index, 'property')}
            value={reference.propertyReferenceId}
            className={inputClass}
            onChange={(event) => props.onChange((r) => ({ ...r, reference: { kind: 'property', propertyReferenceId: event.target.value } }))}
            {...aria}
          >
            <option value="">Objekt wählen</option>
            {properties.map((p) => (
              <option key={p.propertyReferenceId} value={p.propertyReferenceId}>
                {p.displayName ?? `Objekt ohne Namen (${p.propertyReferenceId})`}
              </option>
            ))}
            {reference.propertyReferenceId !== '' && !properties.some((p) => p.propertyReferenceId === reference.propertyReferenceId) && (
              <option value={reference.propertyReferenceId}>{`Objekt ${reference.propertyReferenceId}`}</option>
            )}
          </select>
        ))}
      {reference.kind !== 'none' && reference.kind !== 'property' && (
        <KeptReference idPrefix={prefix} index={index} reference={reference} references={references} bound={props.bound} />
      )}
      {field('description', 'Beschreibung (optional)', (aria) => (
        <input
          id={prefix + controlId(index, 'description')}
          type="text"
          maxLength={500}
          value={row.description}
          className={inputClass}
          onChange={(event) => props.onChange((r) => ({ ...r, description: event.target.value }))}
          {...aria}
        />
      ))}
      <div className="flex items-end">
        <button type="button" className={secondaryButtonClass} disabled={!props.canRemove} onClick={props.onRemove}>
          {`Teilbetrag ${index + 1} entfernen`}
        </button>
      </div>
    </fieldset>
  );
}

/** A Loan, deposit or WEG reference kept from the stored split: shown with its id, removable, not chosen here. */
function KeptReference(props: {
  readonly idPrefix: string;
  readonly index: number;
  readonly reference: Exclude<DraftRow['reference'], { kind: 'none' } | { kind: 'property' }>;
  readonly references: References;
  readonly bound: ReadonlyMap<string, readonly FieldError[]>;
}) {
  const r = props.reference;
  const id =
    r.kind === 'loan'
      ? r.loanId
      : r.kind === 'securityDeposit'
        ? r.securityDepositId
        : r.kind === 'wegAnnualStatement'
          ? r.wegAnnualStatementId
          : r.wegSpecialAssessmentId;
  const property = 'propertyReferenceId' in r ? r.propertyReferenceId : undefined;
  const errors = props.bound.get(controlId(props.index, 'property'));
  const propertyId = props.idPrefix + controlId(props.index, 'property');
  return (
    <div className="flex flex-col gap-1 md:col-span-2">
      <p className="text-label text-muted">
        {`${REFERENCE_LABELS[r.kind]}: `}
        <code className="font-mono">{id}</code>
      </p>
      {property !== undefined && (
        <p id={propertyId} tabIndex={-1} className="text-label text-muted" aria-invalid={errors === undefined ? undefined : true}>
          {'Objekt: '}
          <NamedId name={propertyName(props.references, property)} id={property} />
        </p>
      )}
      {errors !== undefined && <p className="text-label text-danger-text">{errors.map((e) => describeFieldError(e).text).join(', ')}</p>}
    </div>
  );
}

export function Field(props: {
  readonly id: string;
  readonly label: string;
  readonly local: readonly string[];
  readonly server: readonly FieldError[] | undefined;
  readonly render: (aria: Record<string, string | boolean | undefined>) => ReactNode;
}) {
  const messages = [...props.local, ...(props.server ?? []).map((entry) => `Vom Server abgelehnt: ${describeFieldError(entry).text}`)];
  const messageId = `${props.id}-hinweis`;
  const aria = messages.length === 0 ? {} : { 'aria-invalid': true, 'aria-describedby': messageId };
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={props.id} className="text-label text-muted">
        {props.label}
      </label>
      {props.render(aria)}
      {messages.length > 0 && (
        <p id={messageId} className="text-label text-danger-text">
          {messages.join(' ')}
        </p>
      )}
    </div>
  );
}

/** What the choice lists cannot offer (§3.3; first page of 200, Entscheidung des Projektinhabers, 2026-11-10). */
export function ReferenceNotes({ references }: { readonly references: References }) {
  const notes: string[] = [];
  const lists = [
    ['Objekte', references.properties],
    ['Kategorien', references.categories],
  ] as const;
  for (const [label, list] of lists) {
    if (list.status === 'pending') notes.push(`${label} werden geladen …`);
    if (list.status === 'error') notes.push(`${label} konnten nicht geladen werden; die Auswahl zeigt nur die gespeicherten Werte.`);
    if (list.status === 'success' && 'total' in list.data && list.data.total > list.data.items.length) {
      notes.push(`Die Auswahl zeigt die ersten ${list.data.items.length} von ${list.data.total} ${label}.`);
    }
  }
  if (notes.length === 0) return null;
  return (
    <ul role="status" className="text-label text-muted">
      {notes.map((note) => (
        <li key={note}>{note}</li>
      ))}
    </ul>
  );
}
