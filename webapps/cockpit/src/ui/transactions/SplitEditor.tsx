import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { ifMatchForVersion } from '../../api/client';
import { ApiError, type FieldError } from '../../api/errors';
import type { SplitInputDto, SplitsSaved, TransactionDetailDto, TransactionRead } from '../../api/transactions';
import {
  addRow,
  bindSplitFieldErrors,
  checkDraft,
  draftFromDetail,
  draftDiffers,
  draftFromSplits,
  firstBoundControl,
  MAX_SPLITS,
  removeRow,
  splitsEditable,
  toSplitsRequest,
  type DraftRow,
} from '../../transactions/split-draft';
import { decimalToCents } from '../../transactions/split-amount';
import { buttonClass, ErrorState, isRetryable, Notice, secondaryButtonClass } from '../states';
import { statusLabel } from './labels';
import type { References } from './references';
import { SplitConflict, type ConflictState } from './SplitConflict';
import { ReferenceNotes, SplitRow, Totals } from './SplitRows';

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
  /**
   * Whether the draft differs from the stored split set (`draftDiffers`), on every change and `false` when the editor
   * goes; the page locks „Buchung bestätigen“ while it does (Entscheidung des Projektinhabers, 2026-11-11).
   */
  readonly onDraftChange?: (unsaved: boolean) => void;
  /**
   * Step 8 (Entscheidung des Projektinhabers, 2026-11-11): a section shown above the rows that may replace the draft
   * with rows of its own (the rent split proposal, §6.6). `apply` only sets the draft; nothing is sent until „Aufteilung
   * speichern“. `disabled` while a save runs, a conflict is open or the set can no longer be changed.
   */
  readonly proposal?: (draft: DraftSlot) => ReactNode;
}

/** What the editor hands a proposal section: replace the draft (the builder gets the editor's row keys), or not now. */
export interface DraftSlot {
  /** The Transaction as the editor knows it now (its version moves with every save). */
  readonly transaction: TransactionDetailDto;
  readonly apply: (build: (newKey: () => string) => readonly DraftRow[] | undefined) => void;
  readonly disabled: boolean;
}

/**
 * The split editor (ui-guide.md §6.4, §10 step 3: "Split-Editor mit exakter Summe und If-Match"). 1–100 rows of
 * category, amount, reference and description in the Transaction's currency; the rest is shown live; saving is offered
 * only when the amounts cover the Transaction's amount exactly, to the cent, without tolerance and without a direction
 * per split. Saving sends the whole set with `If-Match` (§7.3, §8) and takes the `ETag` of the answer for the next one.
 * A `412` keeps the draft and lets the user decide (§11); a lost answer offers to send the same set again, never a new
 * one. The draft is the only state of the browser and ends with the page (§11). „Entwurf verwerfen“ puts the stored
 * split set back into the draft; it sends nothing.
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
  const unsaved = useMemo(() => draftDiffers(rows, transaction.splits, transaction.amount.amount), [rows, transaction.splits, transaction.amount.amount]);
  const onDraftChange = useRef(props.onDraftChange);
  onDraftChange.current = props.onDraftChange;
  useEffect(() => {
    onDraftChange.current?.(unsaved);
  }, [unsaved]);
  useEffect(
    () => () => {
      onDraftChange.current?.(false);
    },
    [],
  );

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

  /** Back to the stored split set as the editor knows it; any refusal or kept conflict of the old draft goes with it. */
  const discard = () => {
    setRows(draftFromDetail(transaction, newKey));
    setRefusal(undefined);
    setConflict(undefined);
    setSavedVersion(undefined);
  };

  const slot: DraftSlot = {
    transaction,
    disabled: !editable || blocked,
    apply: (build) => {
      if (!editable || blocked) return;
      const next = build(newKey);
      if (next !== undefined && next.length > 0) restructure(next);
    },
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
      {props.proposal?.(slot)}
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
          {unsaved && (
            <button type="button" className={secondaryButtonClass} disabled={blocked} onClick={discard}>
              Entwurf verwerfen
            </button>
          )}
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
