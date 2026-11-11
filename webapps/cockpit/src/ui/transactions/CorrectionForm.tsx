import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { ifMatchForVersion, newIdempotencyKey } from '../../api/client';
import { ApiError } from '../../api/errors';
import type { CorrectInputDto, CorrectionResultDto, TransactionDetailDto, TransactionDto } from '../../api/transactions';
import {
  bindCorrectionFieldErrors,
  checkCorrection,
  correctable,
  correctionDraftFrom,
  intentFor,
  MAX_REASON,
  toCorrectRequest,
  type BoundCorrectionErrors,
  type CorrectionDraft,
  type CorrectionField,
  type CorrectionIntent,
  type CorrectionProblem,
} from '../../transactions/correction-draft';
import { addRow, firstBoundControl, MAX_SPLITS, removeRow, type DraftRow } from '../../transactions/split-draft';
import { buttonClass, ErrorState, isRetryable, Notice, secondaryButtonClass } from '../states';
import { CorrectionRefusal, CorrectionResult } from './CorrectionResult';
import { directionLabel, statusLabel } from './labels';
import type { References } from './references';
import { AMOUNT_TEXTS, Field, inputClass, ReferenceNotes, SplitRow, Totals } from './SplitRows';

/** What was sent: „Erneut senden“ sends exactly this again, body, `If-Match` and key (ui-guide.md §7.3, §11). */
interface Sent {
  readonly body: CorrectInputDto;
  readonly ifMatch: string;
  readonly key: string;
}

interface Refusal {
  readonly error: unknown;
  readonly retry: Sent | undefined;
  readonly bound: BoundCorrectionErrors;
}

const PREFIX = 'korrektur-';
const fieldId = (field: CorrectionField) => `${PREFIX}${field}`;
const NO_BINDING: BoundCorrectionErrors = { fields: new Map(), rows: new Map() };

const PROBLEM_TEXTS: Readonly<Record<CorrectionProblem, string>> = {
  ...AMOUNT_TEXTS,
  NEGATIVE: 'Der Betrag ist nie negativ; die Richtung wird eigens gewählt.',
  REASON_MISSING: 'Grund angeben.',
  REASON_TOO_LONG: `Höchstens ${MAX_REASON} Zeichen.`,
  DIRECTION_INVALID: 'Richtung wählen.',
  BOOKING_DATE_MISSING: 'Buchungsdatum angeben.',
  DATE_INVALID: 'Kein Datum.',
  DESCRIPTION_TOO_LONG: `Höchstens ${MAX_REASON} Zeichen.`,
};

const CHANGE_LABELS: Readonly<Record<CorrectionField | 'splits', string>> = {
  reason: 'Grund',
  amount: 'Betrag',
  direction: 'Richtung',
  bookingDate: 'Buchungsdatum',
  valueDate: 'Wertstellung',
  description: 'Verwendungszweck',
  propertyReferenceId: 'Objekt',
  splits: 'Aufteilung',
};

export interface CorrectionFormProps {
  readonly realmId: string;
  /** The original as last read, with its `ETag` (`If-Match` of `correct` is the original's version, §16.1). */
  readonly transaction: TransactionDetailDto;
  readonly etag: string | undefined;
  /** The detail is being read again or its last read failed: nothing is sent on a state that may be stale. */
  readonly stale: boolean;
  readonly references: References;
  readonly correct: (body: CorrectInputDto, ifMatch: string, idempotencyKey: string) => Promise<CorrectionResultDto & { readonly replacement: TransactionDto }>;
  readonly onCorrected: () => void;
  readonly reload: () => void;
  /** A new `Idempotency-Key`; `crypto.randomUUID` unless a test passes its own. */
  readonly newKey?: () => string;
}

/**
 * „Korrigieren“ (ui-guide.md §6.3, §8, §10 step 4; api-design.md §35): a confirmed Transaction is never changed; the
 * form says what the replacement changes, and the server writes the reversal and the replacement in one step. Only the
 * changed fields are sent; a changed amount needs the replacement's own splits (step 3's rows, exact sum, no floating
 * point). `If-Match` is the original's `ETag`; the `Idempotency-Key` belongs to the intent (`intentFor`): the same body
 * keeps it across a lost answer, a changed one gets a new one. The answer is the chain, shown with links; the original
 * is `CORRECTED` from then on and never offered for editing again.
 */
export function CorrectionForm(props: CorrectionFormProps) {
  const keys = useRef(0);
  const newRowKey = () => `korrektur-zeile-${(keys.current += 1)}`;
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<CorrectionDraft>(() => correctionDraftFrom(props.transaction, newRowKey));
  const [sending, setSending] = useState(false);
  const [refusal, setRefusal] = useState<Refusal | undefined>(undefined);
  const [result, setResult] = useState<(CorrectionResultDto & { readonly replacement: TransactionDto }) | undefined>(undefined);
  const intent = useRef<CorrectionIntent | undefined>(undefined);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const t = props.transaction;
  const check = useMemo(() => checkCorrection(draft, t), [draft, t]);
  const allowed = correctable(t);
  const bound = refusal?.bound ?? NO_BINDING;
  const canSend = open && allowed && !props.stale && !sending && check.complete;

  useEffect(() => {
    if (open) heading.current?.focus();
  }, [open]);
  useEffect(() => {
    const field = (['reason', 'amount', 'direction', 'bookingDate', 'valueDate', 'description', 'propertyReferenceId'] as const).find((f) =>
      bound.fields.has(f),
    );
    const row = firstBoundControl(bound.rows, draft.rows.length);
    const id = field !== undefined ? fieldId(field) : row === undefined ? undefined : PREFIX + row;
    if (id !== undefined) document.getElementById(id)?.focus();
    // Only when a refusal arrives (a new binding), not on every keystroke.
  }, [bound]);

  const send = (sent: Sent) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setSending(true);
    setRefusal(undefined);
    const rowCount = sent.body.replacement.splits?.length ?? 0;
    props
      .correct(sent.body, sent.ifMatch, sent.key)
      .then(
        (answer) => {
          if (!mounted.current) return;
          // Done: the form gives way to the chain; a next correction (of the replacement) is a new page and a new intent.
          setResult(answer);
          props.onCorrected();
        },
        (error: unknown) => {
          if (!mounted.current) return;
          const fields = error instanceof ApiError ? error.fields : [];
          setRefusal({ error, retry: isRetryable(error) ? sent : undefined, bound: bindCorrectionFieldErrors(fields, rowCount) });
        },
      )
      .finally(() => {
        inFlight.current = false;
        if (mounted.current) setSending(false);
      });
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canSend) return;
    const body = toCorrectRequest(draft, t);
    intent.current = intentFor(intent.current, body, props.newKey ?? newIdempotencyKey);
    send({ body, ifMatch: props.etag ?? ifMatchForVersion(t.version), key: intent.current.key });
  };

  /** A changed value keeps the field errors; „Erneut senden“ goes, since the body is no longer the one sent. */
  const change = (update: (current: CorrectionDraft) => CorrectionDraft) => {
    setDraft(update);
    setRefusal((current) => (current === undefined ? undefined : { ...current, retry: undefined }));
  };
  /** Adding or removing a split row moves the indices the field errors name: the refusal is cleared. */
  const restructure = (rows: readonly DraftRow[]) => {
    setDraft((current) => ({ ...current, rows }));
    setRefusal(undefined);
  };

  if (result !== undefined) return <CorrectionResult realmId={props.realmId} result={result} />;

  return (
    <section aria-labelledby="korrigieren" className="flex flex-col gap-4 rounded-card border border-border bg-surface p-6">
      <h3 id="korrigieren" ref={heading} tabIndex={-1} className="text-section font-semibold">
        Korrigieren
      </h3>
      {!open ? (
        <>
          <p className="text-muted">
            Eine bestätigte Buchung wird nie geändert. Eine Korrektur storniert sie und legt eine Ersatzbuchung mit den richtigen Angaben an; beide bleiben mit
            ihr verknüpft.
          </p>
          <div>
            <button type="button" className={secondaryButtonClass} disabled={!allowed} onClick={() => setOpen(true)}>
              Korrektur erfassen
            </button>
          </div>
        </>
      ) : (
        <>
          {!allowed && (
            <Notice tone="warning">
              {`Die Buchung hat jetzt den Status „${statusLabel(t.status).text}“ und kann hier nicht mehr korrigiert werden. Ihr Entwurf bleibt bis zum Verlassen der Seite sichtbar.`}
            </Notice>
          )}
          {refusal !== undefined && (
            <ErrorState error={refusal.error}>
              <CorrectionRefusal realmId={props.realmId} error={refusal.error} onReload={props.reload} />
              {refusal.retry !== undefined && (
                <div className="mt-3 flex flex-wrap items-center gap-4">
                  <p>
                    Ob die Korrektur ausgeführt wurde, ist unklar. „Erneut senden“ schickt genau dieselbe Korrektur mit demselben Schlüssel; sie wird nie
                    doppelt ausgeführt.
                  </p>
                  <button type="button" className={secondaryButtonClass} disabled={sending} onClick={() => refusal.retry !== undefined && send(refusal.retry)}>
                    Erneut senden
                  </button>
                </div>
              )}
            </ErrorState>
          )}
          <form aria-label="Korrektur erfassen" noValidate onSubmit={submit} className="flex flex-col gap-4">
            <CorrectionFields
              draft={draft}
              transaction={t}
              check={check}
              bound={bound}
              references={props.references}
              change={change}
              restructure={restructure}
              newRowKey={newRowKey}
            />
            <p id="korrektur-aenderungen" role="status" aria-live="polite">
              {check.changed.length === 0
                ? 'Noch keine Änderung: die Ersatzbuchung muss sich vom Original unterscheiden.'
                : `Die Ersatzbuchung ändert: ${check.changed.map((c) => CHANGE_LABELS[c]).join(', ')}. Alles andere übernimmt sie aus dem Original.`}
              {check.splitsRequired ? ' Bei geändertem Betrag braucht die Ersatzbuchung eine eigene Aufteilung über den neuen Betrag.' : ''}
            </p>
            <div className="flex flex-wrap items-center gap-4">
              <button type="submit" className={buttonClass} disabled={!canSend} aria-describedby="korrektur-aenderungen">
                {sending ? 'Korrektur wird ausgeführt …' : 'Korrektur ausführen'}
              </button>
              <span className="text-label text-muted">{`Gesendet wird mit If-Match ${props.etag ?? ifMatchForVersion(t.version)}.`}</span>
            </div>
          </form>
        </>
      )}
    </section>
  );
}

function CorrectionFields(props: {
  readonly draft: CorrectionDraft;
  readonly transaction: TransactionDetailDto;
  readonly check: ReturnType<typeof checkCorrection>;
  readonly bound: BoundCorrectionErrors;
  readonly references: References;
  readonly change: (update: (current: CorrectionDraft) => CorrectionDraft) => void;
  readonly restructure: (rows: readonly DraftRow[]) => void;
  readonly newRowKey: () => string;
}) {
  const { draft, check, change } = props;
  const currency = props.transaction.amount.currency;
  const field = (name: CorrectionField, label: string, render: (aria: Record<string, string | boolean | undefined>) => ReactNode) => (
    <Field
      id={fieldId(name)}
      label={label}
      local={(check.problems.get(name) ?? []).map((p) => PROBLEM_TEXTS[p])}
      server={props.bound.fields.get(name)}
      render={render}
    />
  );
  const set = <K extends keyof CorrectionDraft>(key: K, value: CorrectionDraft[K]) => change((current) => ({ ...current, [key]: value }));
  const properties = props.references.properties.status === 'success' ? props.references.properties.data.items : [];
  const rows = draft.rows;
  return (
    <div className="flex flex-col gap-4">
      {field('reason', 'Grund der Korrektur (Pflicht)', (aria) => (
        <textarea id={fieldId('reason')} value={draft.reason} rows={2} className={inputClass} onChange={(e) => set('reason', e.target.value)} {...aria} />
      ))}
      <div className="grid gap-3 md:grid-cols-2">
        {field('amount', `Betrag in ${currency}`, (aria) => (
          <input
            id={fieldId('amount')}
            type="text"
            inputMode="decimal"
            autoComplete="off"
            value={draft.amount}
            className={`${inputClass} text-right tabular-nums`}
            onChange={(e) => set('amount', e.target.value)}
            {...aria}
          />
        ))}
        {field('direction', 'Richtung', (aria) => (
          <select id={fieldId('direction')} value={draft.direction} className={inputClass} onChange={(e) => set('direction', e.target.value)} {...aria}>
            {['INFLOW', 'OUTFLOW'].map((d) => (
              <option key={d} value={d}>
                {directionLabel(d).text}
              </option>
            ))}
          </select>
        ))}
        {field('bookingDate', 'Buchungsdatum', (aria) => (
          <input
            id={fieldId('bookingDate')}
            type="date"
            value={draft.bookingDate}
            className={inputClass}
            onChange={(e) => set('bookingDate', e.target.value)}
            {...aria}
          />
        ))}
        {field('valueDate', 'Wertstellung (optional)', (aria) => (
          <input
            id={fieldId('valueDate')}
            type="date"
            value={draft.valueDate}
            className={inputClass}
            onChange={(e) => set('valueDate', e.target.value)}
            {...aria}
          />
        ))}
        {field('description', 'Verwendungszweck (optional)', (aria) => (
          <input
            id={fieldId('description')}
            type="text"
            value={draft.description}
            className={inputClass}
            onChange={(e) => set('description', e.target.value)}
            {...aria}
          />
        ))}
        {field('propertyReferenceId', 'Objekt der Buchung', (aria) => (
          <select
            id={fieldId('propertyReferenceId')}
            value={draft.propertyReferenceId}
            className={inputClass}
            onChange={(e) => set('propertyReferenceId', e.target.value)}
            {...aria}
          >
            <option value="">Kein Objekt</option>
            {properties.map((p) => (
              <option key={p.propertyReferenceId} value={p.propertyReferenceId}>
                {p.displayName ?? `Objekt ohne Namen (${p.propertyReferenceId})`}
              </option>
            ))}
            {draft.propertyReferenceId !== '' && !properties.some((p) => p.propertyReferenceId === draft.propertyReferenceId) && (
              <option value={draft.propertyReferenceId}>{`Objekt ${draft.propertyReferenceId}`}</option>
            )}
          </select>
        ))}
      </div>
      <label className="flex items-center gap-2">
        <input type="checkbox" checked={draft.changeSplits} onChange={(e) => set('changeSplits', e.target.checked)} />
        Aufteilung der Ersatzbuchung ändern
      </label>
      {draft.changeSplits && (
        <fieldset className="flex flex-col gap-4">
          <legend className="font-semibold">Aufteilung der Ersatzbuchung</legend>
          {rows.map((row, index) => (
            <SplitRow
              key={row.key}
              idPrefix={PREFIX}
              row={row}
              index={index}
              currency={currency}
              problems={check.splits?.problems[index] ?? []}
              bound={props.bound.rows}
              references={props.references}
              canRemove={rows.length > 1}
              onChange={(update) => change((current) => ({ ...current, rows: current.rows.map((r) => (r.key === row.key ? update(r) : r)) }))}
              onRemove={() => props.restructure(removeRow(rows, row.key))}
            />
          ))}
          <ReferenceNotes references={props.references} />
          <div>
            <button
              type="button"
              className={secondaryButtonClass}
              disabled={rows.length >= MAX_SPLITS}
              onClick={() => props.restructure(addRow(rows, props.newRowKey))}
            >
              Teilbetrag hinzufügen
            </button>
          </div>
          {check.splits !== undefined && check.amount !== undefined && (
            <Totals idPrefix={PREFIX} amount={check.amount} currency={currency} sum={check.splits.sum} rest={check.splits.rest} exact={check.splits.exact} />
          )}
        </fieldset>
      )}
    </div>
  );
}
