import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { ifMatchForVersion } from '../../api/client';
import { ApiError } from '../../api/errors';
import type { Confirmed, TransactionDetailDto } from '../../api/transactions';
import { confirmable, needsSplitsBeforeConfirm } from '../../transactions/correction-draft';
import { buttonClass, ErrorState, isRetryable, Notice, secondaryButtonClass } from '../states';
import { statusLabel } from './labels';

/** `409`/`422` reasons of `confirm` (api-design.md §34.2): said in German, an unknown one with its code. */
function reasonText(error: unknown): string | undefined {
  if (!(error instanceof ApiError)) return undefined;
  const details = error.details ?? {};
  const reason = details['reason'];
  if (typeof reason !== 'string') return undefined;
  switch (reason) {
    case 'SPLITS_MISSING':
      return 'Die Buchung ist noch nicht aufgeteilt. Erst die Aufteilung speichern, dann bestätigen.';
    case 'SPLIT_SUM_MISMATCH':
      return 'Die gespeicherten Teilbeträge decken den Betrag der Buchung nicht genau. Bitte die Aufteilung korrigieren.';
    case 'NOT_CONFIRMABLE':
      return `Die Buchung hat den Status „${statusLabel(String(details['status'])).text}“ und kann nicht bestätigt werden.`;
    case 'INACTIVE_CATEGORY': {
      const codes = Array.isArray(details['financialCategoryCodes']) ? details['financialCategoryCodes'].map(String) : [];
      return `Eine Kategorie der Aufteilung ist nicht mehr aktiv (${codes.join(', ')}). Bitte neu aufteilen, dann bestätigen.`;
    }
    default:
      return `Grund ${reason}.`;
  }
}

type Stage =
  | { readonly kind: 'idle' }
  | { readonly kind: 'asking' }
  | { readonly kind: 'sending' }
  | { readonly kind: 'refused'; readonly error: unknown; readonly retry: string | undefined };

/**
 * „Buchung bestätigen“ (ui-guide.md §4.4: its own action; §6.3; §10 step 4). Offered only where the server takes it
 * (`confirmable`); a confirmable status without splits says to split first. A click opens a confirmation step; only
 * „Jetzt bestätigen“ sends `POST …/confirm` with the `ETag` of the detail as `If-Match` (§7.3, §8). Nothing turns
 * green before the server's answer (§7.3: no optimistic financial state); after it the page reads the Transaction
 * again. A `412` keeps everything as it is and reads only on request; no answer offers the same request again (a
 * repeated confirm is a no-op). Focus goes into the step, back to the button on „Abbrechen“ or Escape, and to the
 * result after the answer (§11).
 */
export function ConfirmAction(props: {
  readonly transaction: TransactionDetailDto;
  readonly etag: string | undefined;
  /** The detail is being read again or its last read failed: no action on a state that may be stale. */
  readonly stale: boolean;
  readonly confirm: (ifMatch: string) => Promise<Confirmed>;
  readonly onConfirmed: (confirmed: Confirmed) => void;
  /** Reads the Transaction again (after a `412`), on the user's request only. */
  readonly reload: () => void;
}) {
  const t = props.transaction;
  const [stage, setStage] = useState<Stage>({ kind: 'idle' });
  const [done, setDone] = useState<Confirmed | undefined>(undefined);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  const trigger = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLHeadingElement>(null);
  const result = useRef<HTMLDivElement>(null);
  const returnFocus = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (stage.kind === 'asking') dialog.current?.focus();
    if (stage.kind === 'refused' || done !== undefined) result.current?.focus();
    if (stage.kind === 'idle' && returnFocus.current) {
      returnFocus.current = false;
      trigger.current?.focus();
    }
  }, [stage, done]);

  const ifMatch = props.etag ?? ifMatchForVersion(t.version);
  const send = (tag: string) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setStage({ kind: 'sending' });
    props
      .confirm(tag)
      .then(
        (confirmed) => {
          if (!mounted.current) return;
          setDone(confirmed);
          setStage({ kind: 'idle' });
          props.onConfirmed(confirmed);
        },
        (error: unknown) => {
          if (mounted.current) setStage({ kind: 'refused', error, retry: isRetryable(error) ? tag : undefined });
        },
      )
      .finally(() => {
        inFlight.current = false;
      });
  };
  const cancel = () => {
    returnFocus.current = true;
    setStage({ kind: 'idle' });
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape' && stage.kind === 'asking') cancel();
  };

  if (done !== undefined) {
    return (
      <div ref={result} tabIndex={-1} role="status">
        <Notice tone="success">{`Buchung bestätigt (Version ${done.transaction.version}, Status „${statusLabel(done.transaction.status).text}“). Die Aufteilung ist jetzt unveränderlich.`}</Notice>
      </div>
    );
  }
  if (needsSplitsBeforeConfirm(t)) {
    return <p className="text-muted">Bestätigen ist möglich, sobald die Aufteilung gespeichert ist (Abschnitt „Aufteilung bearbeiten“).</p>;
  }
  if (!confirmable(t) && stage.kind !== 'refused') return null;

  return (
    <div className="flex flex-col gap-3" onKeyDown={onKeyDown}>
      {stage.kind === 'refused' && (
        <div ref={result} tabIndex={-1}>
          <ErrorState error={stage.error}>
            {stage.error instanceof ApiError && stage.error.status === 412 ? (
              <>
                <p className="mt-2">Die Buchung wurde seit dem Laden geändert. Es wurde nichts bestätigt und nichts wird von selbst wiederholt.</p>
                <button
                  type="button"
                  className={`${secondaryButtonClass} mt-3`}
                  onClick={() => {
                    returnFocus.current = true;
                    setStage({ kind: 'idle' });
                    props.reload();
                  }}
                >
                  Aktuellen Stand laden
                </button>
              </>
            ) : (
              <>
                {reasonText(stage.error) !== undefined && <p className="mt-2">{reasonText(stage.error)}</p>}
                {stage.retry !== undefined && (
                  <div className="mt-3 flex flex-wrap items-center gap-4">
                    <p>
                      Ob die Buchung bestätigt wurde, ist unklar. „Erneut senden“ schickt dieselbe Bestätigung mit derselben Version; war sie schon bestätigt,
                      ändert sich nichts.
                    </p>
                    <button type="button" className={secondaryButtonClass} onClick={() => stage.retry !== undefined && send(stage.retry)}>
                      Erneut senden
                    </button>
                  </div>
                )}
              </>
            )}
          </ErrorState>
        </div>
      )}
      {stage.kind === 'asking' || stage.kind === 'sending' ? (
        <div role="dialog" aria-labelledby="bestaetigen-frage" className="rounded-card border border-border bg-surface p-4">
          <h4 id="bestaetigen-frage" ref={dialog} tabIndex={-1} className="font-semibold">
            Buchung jetzt bestätigen?
          </h4>
          <p>
            {`Bestätigt wird die gespeicherte Aufteilung (Version ${t.version}). Danach sind Betrag, Datum, Konto und Aufteilung unveränderlich; ändern lässt sich die Buchung nur noch über eine Korrektur. Nicht gespeicherte Änderungen im Abschnitt „Aufteilung bearbeiten“ werden nicht übernommen.`}
          </p>
          <div className="mt-3 flex flex-wrap gap-4">
            <button type="button" className={buttonClass} disabled={stage.kind === 'sending' || props.stale} onClick={() => send(ifMatch)}>
              {stage.kind === 'sending' ? 'Wird bestätigt …' : 'Jetzt bestätigen'}
            </button>
            <button type="button" className={secondaryButtonClass} disabled={stage.kind === 'sending'} onClick={cancel}>
              Abbrechen
            </button>
          </div>
        </div>
      ) : (
        confirmable(t) && (
          <div className="flex flex-wrap items-center gap-4">
            <button ref={trigger} type="button" className={buttonClass} disabled={props.stale} onClick={() => setStage({ kind: 'asking' })}>
              Buchung bestätigen
            </button>
            <span className="text-label text-muted">{`Gesendet wird mit If-Match ${ifMatch}.`}</span>
          </div>
        )
      )}
    </div>
  );
}
