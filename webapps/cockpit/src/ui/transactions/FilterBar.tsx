import { useEffect, useState, type ChangeEvent, type FormEvent, type ReactNode } from 'react';
import type { FieldError } from '../../api/errors';
import { formatBusinessDate } from '../../format/dates';
import { filterValues, PAGE_SIZES, paramsFromForm, reviewableSet, type FilterName, type ListParams } from '../../transactions/list-params';
import { describeFieldError } from '../error-text';
import { Link } from '../Link';
import { buttonClass } from '../states';
import { accountStatusLabel, PROVENANCE_CODES, provenanceLabel, STATUS_CODES, statusLabel } from './labels';
import type { References } from './references';

/** The controls of the filter bar, in screen order: the order in which the first refused one gets the focus. */
export const FILTER_CONTROLS: readonly string[] = [
  'financialAccountId',
  'propertyReferenceId',
  'financialCategoryCode',
  'status',
  'provenance',
  'reviewable',
  'current',
  'bookingDateFrom',
  'bookingDateTo',
  'pageSize',
];

export const controlId = (name: string): string => `filter-${name}`;
const errorId = (name: string): string => `filter-${name}-fehler`;
const STATUS_LOCK_NOTE = 'filter-status-gesperrt';

/** The id of the first control with a field error (ui-guide.md §4.3: a form error focuses the first wrong field). */
export function firstInvalidControl(errors: ReadonlyMap<string, readonly FieldError[]>): string | undefined {
  const name = FILTER_CONTROLS.find((control) => errors.has(control));
  return name === undefined ? undefined : controlId(name);
}

const fieldText = (entries: readonly FieldError[]): string => entries.map((entry) => describeFieldError(entry).text).join(', ');

function Control(props: {
  readonly name: string;
  readonly label: string;
  readonly errors: ReadonlyMap<string, readonly FieldError[]>;
  readonly children: (aria: Record<string, string | boolean | undefined>) => ReactNode;
}) {
  const entries = props.errors.get(props.name);
  const aria = entries === undefined ? {} : { 'aria-invalid': true, 'aria-describedby': errorId(props.name) };
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <label htmlFor={controlId(props.name)} className="text-label text-muted">
        {props.label}
      </label>
      {props.children(aria)}
      {entries !== undefined && (
        <p id={errorId(props.name)} className="text-label text-danger-text">
          {fieldText(entries)}
        </p>
      )}
    </div>
  );
}

/**
 * `w-full min-w-0`: a select is as wide as its longest option; without these it pushed the page past 390 px (Issue #352
 * des Projektinhabers, 2026-11-12, point 1, ui-guide.md §4.2: the page never scrolls sideways). The option text is cut
 * in the closed control only; the open list shows it whole.
 */
const inputClass = 'min-h-touch w-full min-w-0 rounded-input border border-border bg-surface px-3 text-base';

/** The current value as an option even when its list has not loaded or does not hold it, so a filter never vanishes. */
function extraOption(value: string | undefined, known: boolean, text: string) {
  return value !== undefined && !known ? <option value={value}>{text}</option> : null;
}

/**
 * The filters of `GET /transactions` (ui-guide.md §6.3), nothing else: no free-text search, no sort, no counterparty
 * (§6.1: gaps). Accounts, objects and categories are chosen by name from their lists (§5.3, §13), never typed as ids.
 * A refused value is marked at its control and named in the error summary above the list (§7.4).
 */
export function FilterBar(props: {
  readonly params: ListParams;
  readonly references: References;
  readonly errors: ReadonlyMap<string, readonly FieldError[]>;
  readonly resetHref: string;
  readonly onFilter: (params: ListParams) => void;
}) {
  const { params, references, errors } = props;
  const filters = params.filters;

  useEffect(() => {
    const id = firstInvalidControl(errors);
    if (id !== undefined) document.getElementById(id)?.focus();
  }, [errors]);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    props.onFilter(paramsFromForm(new FormData(event.currentTarget)));
  };

  const accounts = references.accounts.status === 'success' ? references.accounts.data.items : [];
  const properties = references.properties.status === 'success' ? references.properties.data.items : [];
  const categories = references.categories.status === 'success' ? references.categories.data : [];
  // „Nur zu prüfende“ is a shortcut: while it is set, the status choice is empty and locked, so the bar never offers a
  // status together with `reviewable=true` (Entscheidung des Projektinhabers, 2026-11-10). The bar is keyed by the
  // URL (TransactionList), so this state starts afresh from every URL.
  const [reviewable, setReviewable] = useState(reviewableSet(params));
  const [statuses, setStatuses] = useState<readonly string[]>(reviewableSet(params) ? [] : filterValues(params, 'status'));
  /** A status of a typed or bookmarked URL that also holds `reviewable=true`: it still narrows this list (AND). */
  const urlStatuses = reviewableSet(params) ? filterValues(params, 'status') : [];
  const toggleReviewable = (checked: boolean) => {
    setReviewable(checked);
    if (checked) setStatuses([]);
  };
  const toggleStatus = (code: string, checked: boolean) => setStatuses((current) => (checked ? [...current, code] : current.filter((value) => value !== code)));
  const provenances = filterValues(params, 'provenance');

  return (
    <form aria-label="Filter der Buchungsliste" onSubmit={submit} className="flex flex-col gap-4 rounded-card border border-border bg-surface p-4">
      <div className="grid gap-4 md:grid-cols-3">
        <Control name="financialAccountId" label="Konto" errors={errors}>
          {(aria) => (
            <select
              id={controlId('financialAccountId')}
              name="financialAccountId"
              defaultValue={filters.financialAccountId ?? ''}
              className={inputClass}
              {...aria}
            >
              <option value="">Alle Konten</option>
              {accounts.map((account) => (
                <option key={account.financialAccountId} value={account.financialAccountId}>
                  {account.displayName}
                  {account.status === 'OPEN' ? '' : ` (${accountStatusLabel(account.status).text})`}
                </option>
              ))}
              {extraOption(
                filters.financialAccountId,
                accounts.some((a) => a.financialAccountId === filters.financialAccountId),
                `Konto ${filters.financialAccountId ?? ''}`,
              )}
            </select>
          )}
        </Control>
        <Control name="propertyReferenceId" label="Objekt" errors={errors}>
          {(aria) => (
            <select
              id={controlId('propertyReferenceId')}
              name="propertyReferenceId"
              defaultValue={filters.propertyReferenceId ?? ''}
              className={inputClass}
              {...aria}
            >
              <option value="">Alle Objekte</option>
              {properties.map((property) => (
                <option key={property.propertyReferenceId} value={property.propertyReferenceId}>
                  {property.displayName ?? `Objekt ohne Namen (${property.propertyReferenceId})`}
                </option>
              ))}
              {extraOption(
                filters.propertyReferenceId,
                properties.some((p) => p.propertyReferenceId === filters.propertyReferenceId),
                `Objekt ${filters.propertyReferenceId ?? ''}`,
              )}
            </select>
          )}
        </Control>
        <Control name="financialCategoryCode" label="Kategorie einer Aufteilung" errors={errors}>
          {(aria) => (
            <select
              id={controlId('financialCategoryCode')}
              name="financialCategoryCode"
              defaultValue={filters.financialCategoryCode ?? ''}
              className={inputClass}
              {...aria}
            >
              <option value="">Alle Kategorien</option>
              {categories.map((category) => (
                <option key={category.code} value={category.code}>
                  {category.name}
                  {category.active ? '' : ' (inaktiv)'}
                </option>
              ))}
              {extraOption(
                filters.financialCategoryCode,
                categories.some((c) => c.code === filters.financialCategoryCode),
                `Kategorie ${filters.financialCategoryCode ?? ''}`,
              )}
            </select>
          )}
        </Control>
      </div>
      <PickerNotes references={references} />
      <div className="grid gap-4 md:grid-cols-2">
        <fieldset
          id={controlId('status')}
          tabIndex={-1}
          className="flex min-w-0 flex-col gap-1"
          aria-describedby={describedBy([errors.has('status') ? errorId('status') : undefined, reviewable ? STATUS_LOCK_NOTE : undefined])}
        >
          <legend className="text-label text-muted">Status</legend>
          <div className="flex flex-wrap gap-x-4">
            {STATUS_CODES.map((code) => (
              <label key={code} className={`flex min-h-touch items-center gap-2${reviewable ? ' text-muted' : ''}`}>
                <input
                  type="checkbox"
                  name="status"
                  value={code}
                  checked={statuses.includes(code)}
                  disabled={reviewable}
                  onChange={(event) => toggleStatus(code, event.currentTarget.checked)}
                />
                {statusLabel(code).text}
              </label>
            ))}
          </div>
          {reviewable && (
            <p id={STATUS_LOCK_NOTE} className="text-label text-muted">
              Gesperrt, solange „Nur zu prüfende“ gesetzt ist.
              {urlStatuses.length > 0 &&
                ` Aus der Adresse gilt für diese Liste zusätzlich der Status: ${urlStatuses.map((code) => statusLabel(code).text).join(', ')}. Mit „Filter anwenden“ entfällt er.`}
            </p>
          )}
          {errors.has('status') && (
            <p id={errorId('status')} className="text-label text-danger-text">
              {fieldText(errors.get('status') ?? [])}
            </p>
          )}
        </fieldset>
        <fieldset
          id={controlId('provenance')}
          tabIndex={-1}
          className="flex min-w-0 flex-col gap-1"
          aria-describedby={errors.has('provenance') ? errorId('provenance') : undefined}
        >
          <legend className="text-label text-muted">Herkunft</legend>
          <div className="flex flex-wrap gap-x-4">
            {PROVENANCE_CODES.map((code) => (
              <label key={code} className="flex min-h-touch items-center gap-2">
                <input type="checkbox" name="provenance" value={code} defaultChecked={provenances.includes(code)} />
                {provenanceLabel(code).text}
              </label>
            ))}
          </div>
          {errors.has('provenance') && (
            <p id={errorId('provenance')} className="text-label text-danger-text">
              {fieldText(errors.get('provenance') ?? [])}
            </p>
          )}
        </fieldset>
      </div>
      <div className="flex flex-wrap gap-x-6">
        {(
          [
            ['reviewable', 'Nur zu prüfende (Importiert oder Ungeprüft)'],
            ['current', 'Nur aktuelle (bestätigt oder abgeglichen, ohne Storno und Korrigierte)'],
          ] as const
        ).map(([name, label]) => (
          <div key={name} className="flex flex-col">
            <label className="flex min-h-touch items-center gap-2">
              <input
                id={controlId(name)}
                type="checkbox"
                name={name}
                value="true"
                {...(name === 'reviewable'
                  ? { checked: reviewable, onChange: (event: ChangeEvent<HTMLInputElement>) => toggleReviewable(event.currentTarget.checked) }
                  : { defaultChecked: filters[name] === 'true' })}
                aria-invalid={errors.has(name) ? true : undefined}
                aria-describedby={errors.has(name) ? errorId(name) : undefined}
              />
              {label}
            </label>
            {errors.has(name) && (
              <p id={errorId(name)} className="text-label text-danger-text">
                {fieldText(errors.get(name) ?? [])}
              </p>
            )}
          </div>
        ))}
      </div>
      <div className="grid gap-4 md:grid-cols-3">
        {(
          [
            ['bookingDateFrom', 'Buchungsdatum von'],
            ['bookingDateTo', 'Buchungsdatum bis'],
          ] as const satisfies readonly (readonly [FilterName, string])[]
        ).map(([name, label]) => (
          <Control key={name} name={name} label={label} errors={errors}>
            {(aria) => <input id={controlId(name)} type="date" name={name} defaultValue={dateValue(filters[name])} className={inputClass} {...aria} />}
          </Control>
        ))}
        <Control name="pageSize" label="Einträge je Seite" errors={errors}>
          {(aria) => (
            <select id={controlId('pageSize')} name="pageSize" defaultValue={params.pageSize} className={inputClass} {...aria}>
              {PAGE_SIZES.map((size) => (
                <option key={size} value={size}>
                  {size}
                </option>
              ))}
              {extraOption(params.pageSize, PAGE_SIZES.includes(params.pageSize), params.pageSize)}
            </select>
          )}
        </Control>
      </div>
      <div className="flex flex-wrap items-center gap-4">
        <button type="submit" className={buttonClass}>
          Filter anwenden
        </button>
        <Link href={props.resetHref} reload>
          Filter zurücksetzen
        </Link>
      </div>
    </form>
  );
}

/** The ids an `aria-describedby` names, or none. */
function describedBy(ids: readonly (string | undefined)[]): string | undefined {
  const present = ids.filter((id) => id !== undefined);
  return present.length === 0 ? undefined : present.join(' ');
}

/** A date input only takes `YYYY-MM-DD`; another value of the URL stays out of the input (and in the error summary). */
const dateValue = (value: string | undefined): string => (value !== undefined && formatBusinessDate(value) !== undefined ? value : '');

/** What the choice lists cannot offer: still loading, refused, or more entries than one page holds (§3.3). */
function PickerNotes({ references }: { readonly references: References }) {
  const notes: string[] = [];
  const lists = [
    ['Konten', references.accounts],
    ['Objekte', references.properties],
    ['Kategorien', references.categories],
  ] as const;
  for (const [label, list] of lists) {
    if (list.status === 'pending') notes.push(`${label} werden geladen …`);
    if (list.status === 'error') notes.push(`${label} konnten nicht geladen werden; die Auswahl zeigt nur den gesetzten Filter.`);
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
