import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ifMatchForVersion, newIdempotencyKey } from '../../api/client';
import { ApiError } from '../../api/errors';
import type { ReversalResultDto, ReverseInputDto, TransactionDetailDto } from '../../api/transactions';
import {
  checkReverseReason,
  intentFor,
  MAX_REASON,
  reversible,
  toReverseRequest,
  type CorrectionIntent,
  type ReasonProblem,
} from '../../transactions/correction-draft';
import { ConfirmStep, useConfirmStep } from '../ConfirmStep';
import { buttonClass, ErrorState, isRetryable, Notice, secondaryButtonClass } from '../states';
import { CorrectionRefusal, ReversalResult } from './CorrectionResult';
import { statusLabel } from './labels';
import { Field, inputClass } from './SplitRows';

/** What was sent: „Erneut senden“ sends exactly this again, body, `If-Match` and key (ui-guide.md §7.3, §11). */
interface Sent {
  readonly body: ReverseInputDto;
  readonly ifMatch: string;
  readonly key: string;
}

interface Refusal {
  readonly error: unknown;
  readonly retry: Sent | undefined;
}

const REASON_ID = 'storno-reason';
const COUNT_ID = 'storno-reason-zaehler';

const PROBLEM_TEXTS: Readonly<Record<ReasonProblem, string>> = {
  REASON_MISSING: 'Grund angeben.',
  REASON_TOO_LONG: `Höchstens ${MAX_REASON} Zeichen.`,
};

export interface ReverseFormProps {
  readonly realmId: string;
  /** The original as last read, with its `ETag` (`If-Match` of `reverse` is the original's version, §16.1). */
  readonly transaction: TransactionDetailDto;
  readonly etag: string | undefined;
  /** The detail is being read again or its last read failed: nothing is sent on a state that may be stale. */
  readonly stale: boolean;
  readonly reverse: (body: ReverseInputDto, ifMatch: string, idempotencyKey: string) => Promise<ReversalResultDto>;
  readonly onReversed: () => void;
  readonly reload: () => void;
  /** A new `Idempotency-Key`; `crypto.randomUUID` unless a test passes its own. */
  readonly newKey?: () => string;
}

/**
 * „Stornieren“ (api-design.md §35.9; ui-guide.md §4.4, §6.3; Entscheidung des Projektinhabers, 2026-11-11): its own
 * action next to „Korrigieren“, offered where it is (`reversible`). The form takes only the reason (trimmed, 1–500
 * characters, counted as it is sent); „Storno ausführen“ opens the confirmation step (`ConfirmStep`), which says that
 * the reversal is final and that no replacement follows, also not later; only „Jetzt stornieren“ sends. `If-Match` is
 * the original's `ETag`; the `Idempotency-Key` belongs to the intent (`intentFor`): the same reason keeps it across a
 * lost answer, a changed one gets a new one, a success ends it. The answer is the chain original → reversal.
 */
export function ReverseForm(props: ReverseFormProps) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [sending, setSending] = useState(false);
  const [refusal, setRefusal] = useState<Refusal | undefined>(undefined);
  const [result, setResult] = useState<ReversalResultDto | undefined>(undefined);
  const step = useConfirmStep<'reverse'>();
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
  useEffect(() => {
    if (open) heading.current?.focus();
  }, [open]);

  const t = props.transaction;
  const check = checkReverseReason(reason);
  const allowed = reversible(t);
  const ifMatch = props.etag ?? ifMatchForVersion(t.version);
  const sendable = open && allowed && !props.stale && check.problems.length === 0;
  const serverReason = refusal?.error instanceof ApiError ? refusal.error.fields.filter((entry) => entry.field === 'reason') : [];

  const send = (sent: Sent) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setSending(true);
    setRefusal(undefined);
    props
      .reverse(sent.body, sent.ifMatch, sent.key)
      .then(
        (answer) => {
          if (!mounted.current) return;
          // Done: the intent ends; the form gives way to the chain.
          intent.current = undefined;
          setResult(answer);
          props.onReversed();
        },
        (error: unknown) => {
          if (!mounted.current) return;
          step.close();
          setRefusal({ error, retry: isRetryable(error) ? sent : undefined });
        },
      )
      .finally(() => {
        inFlight.current = false;
        if (mounted.current) setSending(false);
      });
  };

  const ask = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (sendable && !sending) step.ask('reverse');
  };
  const confirm = () => {
    if (!sendable) return;
    const body = toReverseRequest(reason);
    intent.current = intentFor(intent.current, body, props.newKey ?? newIdempotencyKey);
    send({ body, ifMatch, key: intent.current.key });
  };
  /** A changed reason is a new body: „Erneut senden“ goes, the refusal's text stays. */
  const change = (value: string) => {
    setReason(value);
    setRefusal((current) => (current === undefined ? undefined : { ...current, retry: undefined }));
  };

  if (result !== undefined) return <ReversalResult realmId={props.realmId} result={result} />;

  return (
    <section aria-labelledby="stornieren" className="flex flex-col gap-4 rounded-card border border-border bg-surface p-6">
      <h2 id="stornieren" ref={heading} tabIndex={-1} className="text-section font-semibold">
        Stornieren
      </h2>
      {!open ? (
        <>
          <p className="text-muted">
            Für eine bestätigte Buchung, die es gar nicht geben dürfte (etwa doppelt erfasst). Ein Storno hebt sie mit einer Gegenbuchung auf; es gibt keine
            Ersatzbuchung. Das ist endgültig.
          </p>
          <div>
            <button type="button" className={secondaryButtonClass} disabled={!allowed} onClick={() => setOpen(true)}>
              Stornieren
            </button>
          </div>
        </>
      ) : (
        <>
          {!allowed && (
            <Notice tone="warning">
              {`Die Buchung hat jetzt den Status „${statusLabel(t.status).text}“ und kann hier nicht mehr storniert werden. Ihr Grund bleibt bis zum Verlassen der Seite sichtbar.`}
            </Notice>
          )}
          {refusal !== undefined && (
            <ErrorState error={refusal.error}>
              <CorrectionRefusal realmId={props.realmId} error={refusal.error} onReload={props.reload} command="reverse" />
              {refusal.retry !== undefined && (
                <div className="mt-3 flex flex-wrap items-center gap-4">
                  <p>
                    Ob das Storno ausgeführt wurde, ist unklar. „Erneut senden“ schickt genau dasselbe Storno mit demselben Schlüssel; es wird nie doppelt
                    ausgeführt.
                  </p>
                  <button type="button" className={secondaryButtonClass} disabled={sending} onClick={() => refusal.retry !== undefined && send(refusal.retry)}>
                    Erneut senden
                  </button>
                </div>
              )}
            </ErrorState>
          )}
          <form aria-label="Storno erfassen" noValidate onSubmit={ask} className="flex flex-col gap-4">
            <Field
              id={REASON_ID}
              label="Grund des Stornos (Pflicht)"
              local={check.problems.map((p) => PROBLEM_TEXTS[p])}
              server={serverReason.length === 0 ? undefined : serverReason}
              render={(aria) => (
                <textarea
                  id={REASON_ID}
                  value={reason}
                  rows={2}
                  className={inputClass}
                  readOnly={step.asking !== undefined}
                  onChange={(e) => change(e.target.value)}
                  {...aria}
                  aria-describedby={[aria['aria-describedby'], COUNT_ID].filter((id) => typeof id === 'string').join(' ')}
                />
              )}
            />
            <p id={COUNT_ID} className="text-label text-muted" aria-live="polite">
              {`${check.length} von ${MAX_REASON} Zeichen`}
            </p>
            {step.asking === 'reverse' ? (
              <ConfirmStep
                id="storno-frage"
                title="Buchung jetzt stornieren?"
                confirmLabel="Jetzt stornieren"
                sendingLabel="Wird storniert …"
                sending={sending}
                disabled={!sendable}
                onConfirm={confirm}
                onCancel={step.cancel}
              >
                <p>
                  {`Das Storno ist endgültig: DE legt eine Gegenbuchung an, die Buchung (Version ${t.version}) wird „Korrigiert/storniert“ und zählt nicht mehr. Es gibt keine Ersatzbuchung, auch später nicht; wer sie doch braucht, legt eine neue Buchung an.`}
                </p>
                <p>{`Grund: „${reason.trim()}“`}</p>
              </ConfirmStep>
            ) : (
              <div className="flex flex-wrap items-center gap-4">
                <button ref={step.trigger('reverse')} type="submit" className={buttonClass} disabled={!sendable || sending}>
                  Storno ausführen
                </button>
              </div>
            )}
          </form>
        </>
      )}
    </section>
  );
}
