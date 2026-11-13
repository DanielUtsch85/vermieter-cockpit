import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ifMatchForVersion } from '../../api/client';
import { ApiError } from '../../api/errors';
import type { Confirmed, TransactionDetailDto } from '../../api/transactions';
import { confirmable, needsSplitsBeforeConfirm } from '../../transactions/correction-draft';
import { ConfirmStep } from '../ConfirmStep';
import { buttonClass, ErrorState, isRetryable, Notice, secondaryButtonClass } from '../states';
import { TechnicalDetails, versionText } from '../technical';
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

/** The id of the lock's hint, named by the buttons it disables (`aria-describedby`). */
const LOCK_HINT = 'bestaetigen-sperre';

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
 * result after the answer (§11). While the split editor holds a draft that differs from the stored split set, the
 * button is locked with „Zuerst Aufteilung speichern oder verwerfen“ (Entscheidung des Projektinhabers, 2026-11-11):
 * a confirm would freeze the stored set, not the one on the screen.
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
  /** The split editor holds a draft that differs from the stored split set: nothing can be confirmed until it is saved or discarded. */
  readonly draftUnsaved?: boolean;
}) {
  const t = props.transaction;
  const [stage, setStage] = useState<Stage>({ kind: 'idle' });
  const [done, setDone] = useState<Confirmed | undefined>(undefined);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  const trigger = useRef<HTMLButtonElement>(null);
  const result = useRef<HTMLDivElement>(null);
  const returnFocus = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
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
  const draftUnsaved = props.draftUnsaved === true;

  if (done !== undefined) {
    return (
      <ConfirmCard>
        <div ref={result} tabIndex={-1} role="status">
          <Notice tone="success">{`Buchung bestätigt (Status „${statusLabel(done.transaction.status).text}“). Die Aufteilung ist jetzt unveränderlich.`}</Notice>
          <TechnicalDetails entries={[['Version', versionText(done.transaction.version, done.etag)]]} />
        </div>
      </ConfirmCard>
    );
  }
  if (needsSplitsBeforeConfirm(t)) {
    return (
      <ConfirmCard>
        <p className="text-muted">Bestätigen ist möglich, sobald die Aufteilung gespeichert ist (Abschnitt „Aufteilung bearbeiten“).</p>
      </ConfirmCard>
    );
  }
  if (!confirmable(t) && stage.kind !== 'refused') return null;

  return (
    <ConfirmCard>
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
        <ConfirmStep
          id="bestaetigen-frage"
          title="Buchung jetzt bestätigen?"
          confirmLabel="Jetzt bestätigen"
          sendingLabel="Wird bestätigt …"
          sending={stage.kind === 'sending'}
          disabled={props.stale || draftUnsaved}
          describedBy={draftUnsaved ? LOCK_HINT : undefined}
          onConfirm={() => send(ifMatch)}
          onCancel={cancel}
        >
          <p>
            {`Bestätigt wird die gespeicherte Aufteilung. Danach sind Betrag, Datum, Konto und Aufteilung unveränderlich; ändern lässt sich die Buchung nur noch über eine Korrektur oder ein Storno.`}
          </p>
        </ConfirmStep>
      ) : (
        confirmable(t) && (
          <div className="flex flex-wrap items-center gap-4">
            <button
              ref={trigger}
              type="button"
              className={buttonClass}
              disabled={props.stale || draftUnsaved}
              aria-describedby={draftUnsaved ? LOCK_HINT : undefined}
              onClick={() => setStage({ kind: 'asking' })}
            >
              Buchung bestätigen
            </button>
          </div>
        )
      )}
      {draftUnsaved && confirmable(t) && (
        <p id={LOCK_HINT} className="text-label font-semibold">
          Zuerst Aufteilung speichern oder verwerfen
        </p>
      )}
    </ConfirmCard>
  );
}

/**
 * The card „Bestätigen“ (Issue #352 des Projektinhabers, 2026-11-12, point 4; as „Übertragung an MRE und Aufheben“ of
 * the rent area): what confirming does, then the button, the lock of an unsaved draft, the confirmation step and the
 * answer, all inside it.
 */
function ConfirmCard({ children }: { readonly children: ReactNode }) {
  return (
    <section aria-labelledby="bestaetigen" className="rounded-card border border-border bg-surface p-6">
      <h2 id="bestaetigen" className="mb-2 text-section font-semibold">
        Bestätigen
      </h2>
      <p className="mb-3 text-muted">
        Mit der Bestätigung wird die gespeicherte Aufteilung eingefroren. Danach lässt sich die Buchung nur noch über eine Korrektur oder ein Storno ändern.
      </p>
      <div className="flex flex-col gap-3">{children}</div>
    </section>
  );
}
