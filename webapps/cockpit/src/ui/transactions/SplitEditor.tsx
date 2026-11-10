import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { ifMatchForVersion } from '../../api/client';
import { ApiError, type FieldError } from '../../api/errors';
import type { SplitInputDto, SplitsSaved, TransactionDetailDto, TransactionRead } from '../../api/transactions';
import { negateDecimal } from '../../format/money';
import {
  addRow,
  bindSplitFieldErrors,
  checkDraft,
  controlId,
  draftFromDetail,
  draftFromSplits,
  firstBoundControl,
  MAX_SPLITS,
  referenceKinds,
  removeRow,
  splitsEditable,
  toSplitsRequest,
  withReferenceKind,
  type DraftRow,
  type ReferenceKind,
  type RowControl,
  type RowProblem,
} from '../../transactions/split-draft';
import { decimalToCents } from '../../transactions/split-amount';
import { describeFieldError } from '../error-text';
import { MoneyText } from '../format';
import { buttonClass, ErrorState, isRetryable, Notice, secondaryButtonClass } from '../states';
import { statusLabel } from './labels';
import { categoryName, propertyName, type References } from './references';
import { SplitConflict, type ConflictState } from './SplitConflict';

/** What was sent last: a retry after a lost answer sends exactly this again (ui-guide.md §7.3, §11). */
interface Sent {
  readonly body: { readonly splits: readonly SplitInputDto[] };
  readonly ifMatch: string;
}

/** A refusal of the last save; `retry` only while the draft is the one sent and reading again may help. */
interface Refusal {
  readonly error: unknown;
  readonly retry: Sent | undefined;
  readonly bound: ReadonlyMap<string, readonly FieldError[]>;
}

const NO_BINDING: ReadonlyMap<string, readonly FieldError[]> = new Map();

export interface SplitEditorProps {
  /** The Transaction as read with its `ETag` (`GET /transactions/{id}`). */
  readonly transaction: TransactionDetailDto;
  readonly etag: string | undefined;
  readonly references: References;
  /** `PUT …/splits` for this Transaction in this Realm (api/transactions.ts `putSplits`). */
  readonly save: (body: Sent['body'], ifMatch: string) => Promise<SplitsSaved>;
  /** Reads the Transaction again (after a `412`). */
  readonly reload: () => Promise<TransactionRead>;
  readonly onSaved?: (saved: SplitsSaved) => void;
}

const AMOUNT_TEXTS: Readonly<Record<RowProblem, string>> = {
  EMPTY: 'Betrag fehlt.',
  NEGATIVE: 'Ein Teilbetrag ist nie negativ; die Richtung steht an der Buchung.',
  TOO_MANY_DECIMALS: 'Höchstens zwei Nachkommastellen; es wird nicht gerundet.',
  AMBIGUOUS: 'Mehrdeutig: bitte mit Dezimalkomma schreiben, z. B. 1234,56 oder 1.234,56.',
  INVALID: 'Kein Betrag: Ziffern mit Dezimalkomma, z. B. 1.234,56.',
  TOO_LARGE: 'Höchstens 18 Stellen vor dem Komma.',
  CATEGORY_MISSING: 'Kategorie wählen.',
  PROPERTY_MISSING: 'Objekt wählen.',
};

const REFERENCE_LABELS: Readonly<Record<ReferenceKind, string>> = {
  none: 'Kein Bezug',
  property: 'Objekt',
  loan: 'Darlehen (bestehender Bezug)',
  securityDeposit: 'Kaution (bestehender Bezug)',
  wegAnnualStatement: 'WEG-Jahresabrechnung (bestehender Bezug)',
  wegSpecialAssessment: 'Sonderumlage (bestehender Bezug)',
};

const inputClass = 'min-h-touch w-full rounded-input border border-border bg-surface px-3 text-base';

/**
 * The split editor (ui-guide.md §6.4, §10 step 3: "Split-Editor mit exakter Summe und If-Match"). 1–100 rows of
 * category, amount, reference and description in the Transaction's currency; the rest is shown live; saving is offered
 * only when the amounts cover the Transaction's amount exactly, to the cent, without tolerance and without a direction
 * per split. Saving sends the whole set with `If-Match` (§7.3, §8) and takes the `ETag` of the answer for the next one.
 * A `412` keeps the draft and lets the user decide (§11); a lost answer offers to send the same set again, never a new
 * one. The draft is the only state of the browser and ends with the page (§11).
 */
export function SplitEditor(props: SplitEditorProps) {
  const keys = useRef(0);
  const newKey = () => `zeile-${(keys.current += 1)}`;
  const [transaction, setTransaction] = useState(props.transaction);
  const [rows, setRows] = useState<readonly DraftRow[]>(() => draftFromDetail(props.transaction, newKey));
  const [base, setBase] = useState(() => props.etag ?? ifMatchForVersion(props.transaction.version));
  const [sending, setSending] = useState(false);
  const [refusal, setRefusal] = useState<Refusal | undefined>(undefined);
  const [conflict, setConflict] = useState<ConflictState | undefined>(undefined);
  const [savedVersion, setSavedVersion] = useState<number | undefined>(undefined);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const currency = transaction.amount.currency;
  const check = useMemo(() => checkDraft(rows, transaction.amount.amount), [rows, transaction.amount.amount]);
  const editable = splitsEditable(transaction.status);
  const bound = refusal?.bound ?? NO_BINDING;
  const blocked = sending || (conflict !== undefined && conflict.stage !== 'kept');
  const canSave = editable && check.complete && !blocked;

  useEffect(() => {
    const id = firstBoundControl(bound, rows.length);
    if (id !== undefined) document.getElementById(id)?.focus();
    // Only when a refusal arrives (a new map), not on every keystroke.
  }, [bound]);

  const send = (sent: Sent) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setSending(true);
    setRefusal(undefined);
    setSavedVersion(undefined);
    const rowCount = sent.body.splits.length;
    props
      .save(sent.body, sent.ifMatch)
      .then(
        (saved) => {
          if (!mounted.current) return;
          const { result } = saved;
          setBase(saved.etag);
          setTransaction((current) => ({ ...current, status: result.status, version: result.version, amount: result.amount, splits: result.splits }));
          setRows(draftFromSplits(result.splits, result.amount.amount, newKey));
          setConflict(undefined);
          setSavedVersion(result.version);
          props.onSaved?.(saved);
        },
        (error: unknown) => {
          if (!mounted.current) return;
          if (error instanceof ApiError && error.status === 412) {
            setConflict({ stage: 'ask', error });
            return;
          }
          const fields = error instanceof ApiError ? error.fields : [];
          setRefusal({ error, retry: isRetryable(error) ? sent : undefined, bound: bindSplitFieldErrors(fields, rowCount) });
        },
      )
      .finally(() => {
        inFlight.current = false;
        if (mounted.current) setSending(false);
      });
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canSave) return;
    send({ body: toSplitsRequest(rows, currency), ifMatch: base });
  };

  /** A changed value keeps the refusal's field errors; the same set can no longer be resent as "the same intent". */
  const change = (key: string, update: (row: DraftRow) => DraftRow) => {
    setRows((current) => current.map((row) => (row.key === key ? update(row) : row)));
    setRefusal((current) => (current === undefined ? undefined : { ...current, retry: undefined }));
    setSavedVersion(undefined);
  };
  /** Adding or removing a row moves the indices the field errors name: the refusal is cleared. */
  const restructure = (next: readonly DraftRow[]) => {
    setRows(next);
    setRefusal(undefined);
    setSavedVersion(undefined);
  };

  const resolveConflict = (keep: boolean) => {
    setConflict({ stage: 'reading', keep });
    props.reload().then(
      (read) => {
        if (!mounted.current) return;
        setBase(read.etag ?? ifMatchForVersion(read.transaction.version));
        setTransaction(read.transaction);
        if (keep) {
          setConflict({ stage: 'kept', server: read.transaction });
        } else {
          setRows(draftFromDetail(read.transaction, newKey));
          setConflict(undefined);
        }
      },
      (error: unknown) => {
        if (mounted.current) setConflict({ stage: 'failed', keep, error });
      },
    );
  };

  if (decimalToCents(transaction.amount.amount) === undefined) {
    return (
      <EditorFrame>
        <Notice tone="warning">Der Betrag der Buchung ist nicht lesbar; die Aufteilung kann hier nicht bearbeitet werden.</Notice>
      </EditorFrame>
    );
  }

  return (
    <EditorFrame>
      <p className="text-muted">
        Die Teilbeträge ersetzen die gespeicherte Aufteilung vollständig. Sie haben keine eigene Richtung und müssen den Betrag der Buchung genau decken.
      </p>
      {!editable && (
        <Notice tone="warning">
          {`Die Buchung hat jetzt den Status „${statusLabel(transaction.status).text}“; ihre Aufteilung kann nicht mehr geändert werden. Ihr Entwurf bleibt bis zum Verlassen der Seite sichtbar.`}
        </Notice>
      )}
      {conflict !== undefined && <SplitConflict state={conflict} references={props.references} onDecide={resolveConflict} />}
      {refusal !== undefined && (
        <ErrorState error={refusal.error}>
          <ConflictReason error={refusal.error} />
          {refusal.retry !== undefined && (
            <div className="mt-3 flex flex-wrap items-center gap-4">
              <p>Ob die Aufteilung gespeichert wurde, ist unklar. „Erneut senden“ schickt genau dieselbe Aufteilung mit derselben Version.</p>
              <button
                type="button"
                className={secondaryButtonClass}
                disabled={sending}
                onClick={() => {
                  if (refusal.retry !== undefined) send(refusal.retry);
                }}
              >
                Erneut senden
              </button>
            </div>
          )}
        </ErrorState>
      )}
      {savedVersion !== undefined && (
        <Notice tone="success">{`Aufteilung gespeichert (Version ${savedVersion}, Status „${statusLabel(transaction.status).text}“).`}</Notice>
      )}
      <form aria-label="Aufteilung bearbeiten" noValidate onSubmit={submit} className="flex flex-col gap-4">
        {rows.map((row, index) => (
          <SplitRow
            key={row.key}
            row={row}
            index={index}
            currency={currency}
            problems={check.problems[index] ?? []}
            bound={bound}
            references={props.references}
            canRemove={rows.length > 1}
            onChange={(update) => change(row.key, update)}
            onRemove={() => restructure(removeRow(rows, row.key))}
          />
        ))}
        <ReferenceNotes references={props.references} />
        <div className="flex flex-wrap items-center gap-4">
          <button type="button" className={secondaryButtonClass} disabled={rows.length >= MAX_SPLITS} onClick={() => restructure(addRow(rows, newKey))}>
            Teilbetrag hinzufügen
          </button>
          {rows.length >= MAX_SPLITS && <span className="text-label text-muted">Höchstens {MAX_SPLITS} Teilbeträge.</span>}
        </div>
        <Totals amount={transaction.amount.amount} currency={currency} sum={check.sum} rest={check.rest} exact={check.exact} />
        <div className="flex flex-wrap items-center gap-4">
          <button type="submit" className={buttonClass} disabled={!canSave} aria-describedby="split-rest">
            {sending ? 'Wird gespeichert …' : 'Aufteilung speichern'}
          </button>
          <span className="text-label text-muted">{`Gesendet wird mit If-Match ${base}.`}</span>
        </div>
      </form>
    </EditorFrame>
  );
}

function EditorFrame({ children }: { readonly children: ReactNode }) {
  return (
    <section aria-labelledby="aufteilung-bearbeiten" className="flex flex-col gap-4 rounded-card border border-border bg-surface p-6">
      <h3 id="aufteilung-bearbeiten" className="text-section font-semibold">
        Aufteilung bearbeiten
      </h3>
      {children}
    </section>
  );
}

/** Amount, sum and the live rest (§6.4: exact sum; the rest names what is left or too much). */
function Totals(props: { readonly amount: string; readonly currency: string; readonly sum: string; readonly rest: string; readonly exact: boolean }) {
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
        <dd className="text-right" data-testid="split-sum">
          <MoneyText money={{ amount: props.sum, currency: props.currency }} />
        </dd>
        <dt className="font-semibold">Rest</dt>
        <dd className="text-right font-semibold" data-testid="split-rest-amount">
          <MoneyText money={{ amount: over ? negateDecimal(props.rest) : props.rest, currency: props.currency }} />
          {over ? ' zu viel' : ''}
        </dd>
      </dl>
      <p id="split-rest" role="status" aria-live="polite" className={props.exact ? 'text-success-text' : 'text-warning-text'}>
        {restText}
      </p>
    </div>
  );
}

/** `409` reasons of the route (api-design.md §33.2, §41.5): said in German, an unknown one with its code. */
const REASONS: Readonly<Record<string, string>> = {
  TRANSACTION_FROZEN: 'Die Buchung ist inzwischen bestätigt, abgeglichen, korrigiert oder ignoriert; ihre Aufteilung ist eingefroren.',
  SPLIT_SUM_MISMATCH: 'Die Summe der Teilbeträge weicht vom Betrag der Buchung ab.',
  LOAN_NOT_ACTIVE: 'Das Darlehen eines Teilbetrags ist nicht mehr aktiv.',
  LOAN_CLOSED: 'Das Darlehen eines Teilbetrags ist zum Buchungsdatum bereits abgeschlossen.',
};

function ConflictReason({ error }: { readonly error: unknown }) {
  const reason = error instanceof ApiError ? error.details?.['reason'] : undefined;
  if (typeof reason !== 'string') return null;
  return <p className="mt-2">{Object.hasOwn(REASONS, reason) ? REASONS[reason] : `Grund ${reason}.`}</p>;
}

function SplitRow(props: {
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
    <Field id={controlId(index, control)} label={label} local={local(control)} server={props.bound.get(controlId(index, control))} render={render} />
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
          id={controlId(index, 'category')}
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
          id={controlId(index, 'amount')}
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
          id={controlId(index, 'reference')}
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
            id={controlId(index, 'property')}
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
        <KeptReference index={index} reference={reference} references={references} bound={props.bound} />
      )}
      {field('description', 'Beschreibung (optional)', (aria) => (
        <input
          id={controlId(index, 'description')}
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
  const propertyId = controlId(props.index, 'property');
  const errors = props.bound.get(propertyId);
  return (
    <div className="flex flex-col gap-1 md:col-span-2">
      <p className="text-label text-muted">
        {`${REFERENCE_LABELS[r.kind]}: `}
        <code className="font-mono">{id}</code>
      </p>
      {property !== undefined && (
        <p id={propertyId} tabIndex={-1} className="text-label text-muted" aria-invalid={errors === undefined ? undefined : true}>
          {`Objekt: ${propertyName(props.references, property) ?? 'Name nicht verfügbar'} `}
          <code className="font-mono">{property}</code>
        </p>
      )}
      {errors !== undefined && <p className="text-label text-danger-text">{errors.map((e) => describeFieldError(e).text).join(', ')}</p>}
    </div>
  );
}

function Field(props: {
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
function ReferenceNotes({ references }: { readonly references: References }) {
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
