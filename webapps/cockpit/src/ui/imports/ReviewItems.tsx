import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ApiError } from '../../api/errors';
import type { ConflictingTransactionDto, ImportBatchDto, ResolveInputDto, ReviewItemDto } from '../../api/imports';
import type { MoneyValue } from '../../format/money';
import { onLinkClick } from '../../navigation';
import { importBatchPath, transactionPath } from '../../routing';
import { DateText, MoneyText, TimestampText } from '../format';
import { ConfirmStep, useConfirmStep } from '../ConfirmStep';
import type { Loadable } from '../RealmChoice';
import { buttonClass, ErrorState, isRetryable, LoadingState, Notice, ReadProblem, secondaryButtonClass } from '../states';
import { directionLabel } from '../transactions/labels';
import { ambiguityText, resolutionText, resolveRefusalText } from './import-labels';

type Resolution = ResolveInputDto['resolution'];

/** The two decisions of ui-guide.md §6.5, with their exact labels. No third one: there is no merge. */
export const RESOLUTIONS: readonly (readonly [Resolution, string])[] = [
  ['CREATE', 'Als eigenständige Buchung übernehmen'],
  ['SKIP', 'Nicht als neue Buchung übernehmen'],
];

/**
 * The confirmation step of each decision (Entscheidung des Projektinhabers, 2026-11-11: a dialog before `CREATE` and
 * `SKIP`, after the pattern of „Buchung bestätigen“): what will happen, and the button that sends it.
 */
const QUESTIONS: Readonly<Record<Resolution, { readonly title: string; readonly text: string; readonly confirm: string }>> = {
  CREATE: {
    title: 'Als eigenständige Buchung übernehmen?',
    text: 'Aus der neuen Zeile wird eine eigene Buchung angelegt, neben den vorhandenen Buchungen. Die Entscheidung ist endgültig; Zusammenführen gibt es nicht.',
    confirm: 'Jetzt übernehmen',
  },
  SKIP: {
    title: 'Nicht als neue Buchung übernehmen?',
    text: 'Aus der neuen Zeile wird keine Buchung angelegt; die vorhandenen Buchungen bleiben unverändert. Die Entscheidung ist endgültig.',
    confirm: 'Jetzt nicht übernehmen',
  },
};

/** The values both sides show; a review item's `normalizedRow` is stored JSON and read defensively. */
interface Side {
  readonly bookingDate: string | null;
  readonly valueDate: string | null;
  readonly amount: MoneyValue | null;
  readonly direction: string | null;
  readonly counterpartyNameRaw: string | null;
  readonly counterpartyIbanRaw: string | null;
  readonly description: string | null;
  readonly externalTransactionId: string | null;
}

const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);

function money(value: unknown): MoneyValue | null {
  if (typeof value !== 'object' || value === null) return null;
  const { amount, currency } = value as Record<string, unknown>;
  return typeof amount === 'string' && typeof currency === 'string' ? { amount, currency } : null;
}

export function rowSide(row: Readonly<Record<string, unknown>>): Side & { readonly position: unknown; readonly balanceAfter: string | null } {
  return {
    position: row['position'],
    bookingDate: text(row['bookingDate']),
    valueDate: text(row['valueDate']),
    amount: money(row['amount']),
    direction: text(row['direction']),
    counterpartyNameRaw: text(row['counterpartyNameRaw']),
    counterpartyIbanRaw: text(row['counterpartyIbanRaw']),
    description: text(row['description']),
    externalTransactionId: text(row['externalTransactionId']),
    balanceAfter: text(row['balanceAfter']),
  };
}

function Values({ side, children }: { readonly side: Side; readonly children?: ReactNode }) {
  const none = <span className="text-muted">Nicht verfügbar</span>;
  return (
    <dl className="grid gap-x-3 gap-y-1 sm:grid-cols-[9rem_1fr]">
      <dt className="text-muted">Buchungstag</dt>
      <dd>
        <DateText value={side.bookingDate} />
      </dd>
      <dt className="text-muted">Wertstellung</dt>
      <dd>
        <DateText value={side.valueDate} />
      </dd>
      <dt className="text-muted">Betrag</dt>
      <dd>
        <MoneyText money={side.amount} {...(side.direction === null ? {} : { direction: side.direction })} />
        {side.direction !== null && ` (${directionLabel(side.direction).text})`}
      </dd>
      <dt className="text-muted">Gegenseite</dt>
      <dd className="break-words">{[side.counterpartyNameRaw, side.counterpartyIbanRaw].filter((part) => part !== null).join(' · ') || none}</dd>
      <dt className="text-muted">Verwendungszweck</dt>
      <dd className="break-words">{side.description ?? none}</dd>
      <dt className="text-muted">Bankreferenz</dt>
      <dd className="break-words">{side.externalTransactionId ?? none}</dd>
      {children}
    </dl>
  );
}

function Link({ href, children }: { readonly href: string; readonly children: ReactNode }) {
  return (
    <a className="text-primary underline" href={href} onClick={(event) => onLinkClick(event, href)}>
      {children}
    </a>
  );
}

/**
 * The review items **owned by** this batch (api-design.md §32.3a; ui-guide.md §6.5): the new row and the Transactions
 * it may duplicate side by side, and the two decisions. Items of earlier batches are not listed here; their rows link
 * to their own batch, where they are decided.
 */
export function ReviewItems(props: {
  readonly realmId: string;
  readonly batch: ImportBatchDto;
  readonly items: Loadable<readonly ReviewItemDto[]>;
  /** The batch or its items are being read again, or their last read failed: no decision on a stale state. */
  readonly stale: boolean;
  readonly resolve: (item: ReviewItemDto, resolution: Resolution) => Promise<ReviewItemDto>;
  /** Reads the batch and its items again after a decision (§6.5) and invalidates the Transaction lists. */
  readonly onResolved: () => void;
  readonly onReread: () => void;
}) {
  return (
    <section aria-labelledby="import-klaerfaelle" className="rounded-card border border-border bg-surface p-6">
      <h2 id="import-klaerfaelle" className="mb-2 text-section font-semibold">
        Klärfälle
      </h2>
      {props.items.status === 'pending' ? (
        <LoadingState label="Klärfälle werden geladen …" />
      ) : props.items.status === 'error' ? (
        <ReadProblem error={props.items.error} onRetry={props.onReread} />
      ) : props.items.data.length === 0 ? (
        <p className="text-muted">Dieser Import hat keine eigenen Klärfälle.</p>
      ) : (
        <ul className="flex flex-col gap-4">
          {props.items.data.map((item) => (
            <li key={item.reviewItemId}>
              <ReviewItemCard {...props} item={item} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

type Stage =
  | { readonly kind: 'idle' }
  | { readonly kind: 'sending'; readonly resolution: Resolution }
  | { readonly kind: 'refused'; readonly error: unknown; readonly retry: Resolution | undefined }
  | { readonly kind: 'done'; readonly item: ReviewItemDto };

function ReviewItemCard(props: {
  readonly realmId: string;
  readonly item: ReviewItemDto;
  readonly stale: boolean;
  readonly resolve: (item: ReviewItemDto, resolution: Resolution) => Promise<ReviewItemDto>;
  readonly onResolved: () => void;
  readonly onReread: () => void;
}) {
  const item = props.item;
  const row = rowSide(item.normalizedRow);
  const [stage, setStage] = useState<Stage>({ kind: 'idle' });
  const inFlight = useRef(false);
  const mounted = useRef(true);
  const answer = useRef<HTMLDivElement>(null);
  const step = useConfirmStep<Resolution>();
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (stage.kind === 'refused' || stage.kind === 'done') answer.current?.focus();
  }, [stage]);

  const send = (resolution: Resolution) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setStage({ kind: 'sending', resolution });
    props
      .resolve(item, resolution)
      .then(
        (resolved) => {
          if (!mounted.current) return;
          step.close();
          setStage({ kind: 'done', item: resolved });
          props.onResolved();
        },
        (error: unknown) => {
          if (!mounted.current) return;
          step.close();
          setStage({ kind: 'refused', error, retry: isRetryable(error) ? resolution : undefined });
        },
      )
      .finally(() => {
        inFlight.current = false;
      });
  };

  const position = typeof row.position === 'number' ? `Zeile ${row.position}` : 'Zeile unbekannt';
  const conflicts: readonly ConflictingTransactionDto[] = item.conflictingTransactions ?? [];
  const missing = item.conflictingTransactionIds.filter((id) => !conflicts.some((t) => t.transactionId === id));
  const decided = stage.kind === 'done' ? stage.item : item.status === 'RESOLVED' ? item : undefined;

  return (
    <article aria-labelledby={`klaerfall-${item.reviewItemId}`} className="rounded-card border border-border p-4">
      <h3 id={`klaerfall-${item.reviewItemId}`} className="font-semibold">{`Klärfall ${position}`}</h3>
      <p>{ambiguityText(item.ambiguityReason)}</p>
      <div className="mt-3 grid gap-4 md:grid-cols-2">
        <section aria-label="Neue Zeile aus der Datei">
          <h4 className="font-semibold">Neue Zeile aus der Datei</h4>
          <Values side={row}>
            <dt className="text-muted">Saldo danach</dt>
            <dd>
              {row.balanceAfter === null ? (
                <span className="text-muted">Nicht verfügbar</span>
              ) : (
                <MoneyText money={{ amount: row.balanceAfter, currency: row.amount?.currency ?? 'EUR' }} />
              )}
            </dd>
          </Values>
        </section>
        <section aria-label="Vorhandene Buchungen">
          <h4 className="font-semibold">Vorhandene Buchungen</h4>
          {conflicts.map((t) => (
            <div key={t.transactionId} className="mb-3">
              <Values side={t}>
                <dt className="text-muted">Buchung</dt>
                <dd>
                  <Link href={transactionPath(props.realmId, t.transactionId)}>Buchung öffnen</Link>
                  {t.importBatchId !== null && (
                    <>
                      {' · '}
                      <Link href={importBatchPath(props.realmId, t.importBatchId)}>{`aus Import ${t.importBatchId.slice(0, 8)}`}</Link>
                    </>
                  )}
                </dd>
              </Values>
            </div>
          ))}
          {missing.map((id) => (
            <p key={id}>
              <Link href={transactionPath(props.realmId, id)}>{`Buchung ${id.slice(0, 8)} öffnen`}</Link> (Werte nicht mitgeliefert)
            </p>
          ))}
        </section>
      </div>
      <div ref={answer} tabIndex={-1} className="mt-3">
        {decided !== undefined ? (
          <Notice tone={stage.kind === 'done' ? 'success' : 'info'}>
            {`Entschieden: ${resolutionText(String(decided.resolution))}`}
            {decided.resolvedByAccountId !== null && ` von ${decided.resolvedByAccountId}`}
            {decided.resolvedAt !== null && (
              <>
                {' am '}
                <TimestampText value={decided.resolvedAt} />
              </>
            )}
            .
            {decided.createdTransactionId !== null && (
              <>
                {' '}
                <Link href={transactionPath(props.realmId, decided.createdTransactionId)}>Angelegte Buchung öffnen</Link>
              </>
            )}
          </Notice>
        ) : item.status !== 'PENDING' ? (
          <p>{`Unbekannter Status (${item.status}); keine Entscheidung möglich.`}</p>
        ) : (
          <>
            {stage.kind === 'refused' && (
              <ErrorState error={stage.error}>
                {resolveRefusalText(stage.error) !== undefined && <p className="mt-2">{resolveRefusalText(stage.error)}</p>}
                {stage.retry !== undefined && (
                  <p className="mt-2">
                    Ob die Entscheidung gespeichert wurde, ist unklar. „Erneut senden“ schickt dieselbe Entscheidung; war sie schon gespeichert, ändert sich
                    nichts.
                  </p>
                )}
                <div className="mt-3 flex flex-wrap gap-4">
                  {stage.retry !== undefined && (
                    <button type="button" className={secondaryButtonClass} onClick={() => stage.retry !== undefined && send(stage.retry)}>
                      Erneut senden
                    </button>
                  )}
                  {(stage.retry !== undefined || (stage.error instanceof ApiError && stage.error.status === 409)) && (
                    <button type="button" className={secondaryButtonClass} onClick={props.onReread}>
                      Stand neu laden
                    </button>
                  )}
                </div>
              </ErrorState>
            )}
            <p className="text-label text-muted">Die Entscheidung ist endgültig. Zusammenführen gibt es nicht.</p>
            {step.asking !== undefined ? (
              <div className="mt-2">
                <ConfirmStep
                  id={`klaerfall-${item.reviewItemId}-frage`}
                  title={QUESTIONS[step.asking].title}
                  confirmLabel={QUESTIONS[step.asking].confirm}
                  sendingLabel="Wird gesendet …"
                  sending={stage.kind === 'sending'}
                  disabled={props.stale}
                  onConfirm={() => step.asking !== undefined && send(step.asking)}
                  onCancel={step.cancel}
                >
                  <p>{QUESTIONS[step.asking].text}</p>
                </ConfirmStep>
              </div>
            ) : (
              <div className="mt-2 flex flex-wrap gap-4">
                {RESOLUTIONS.map(([resolution, label]) => (
                  <button
                    key={resolution}
                    ref={step.trigger(resolution)}
                    type="button"
                    className={resolution === 'CREATE' ? buttonClass : secondaryButtonClass}
                    disabled={stage.kind === 'sending' || props.stale}
                    onClick={() => step.ask(resolution)}
                  >
                    {stage.kind === 'sending' && stage.resolution === resolution ? 'Wird gesendet …' : label}
                  </button>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </article>
  );
}
