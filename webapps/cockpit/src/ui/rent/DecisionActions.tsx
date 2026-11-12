import { useEffect, useRef, useState } from 'react';
import { ApiError } from '../../api/errors';
import type { ReconciliationChanged, RentReconciliationDto } from '../../api/rent-reconciliations';
import type { MoneyValue } from '../../format/money';
import { checkConfirmAmount, checkReason, decidable, MAX_REASON, type AmountCheck, type ReasonProblem } from '../../rent/reconciliation-rules';
import { decimalToInput } from '../../transactions/split-amount';
import { MoneyText } from '../format';
import { buttonClass, ErrorState, isRetryable, Notice, secondaryButtonClass } from '../states';
import { rentRefusalText } from './rent-labels';
import { useCommand } from './use-command';

const AMOUNT_TEXTS: Readonly<Record<Exclude<AmountCheck, { ok: true }>['problem'], string>> = {
  EMPTY: 'Bitte einen Betrag angeben.',
  NEGATIVE: 'Der Betrag ist nie negativ.',
  TOO_MANY_DECIMALS: 'Höchstens zwei Nachkommastellen.',
  AMBIGUOUS: 'Mehrdeutig: bitte mit Komma schreiben (z. B. 1.234,00 oder 1234,56).',
  INVALID: 'Kein Betrag.',
  TOO_LARGE: 'Der Betrag ist zu groß.',
  NOT_POSITIVE: 'Der Betrag muss größer als 0,00 € sein.',
  ABOVE_SUGGESTION: 'Höher als der Vorschlag: bestätigt werden kann nur der vorgeschlagene Betrag oder weniger.',
};

const REASON_TEXTS: Readonly<Record<ReasonProblem, string>> = {
  REASON_MISSING: 'Ein Grund ist Pflicht.',
  REASON_TOO_LONG: `Höchstens ${MAX_REASON} Zeichen.`,
};

type Action = 'confirm' | 'reject';

/**
 * A suggestion's two decisions (ui-guide.md §6.6 step 6; api-design.md §37.3): „Zuordnung bestätigen“ with the amount
 * the user checked (the suggested one or less, never more; strings, no float), or reject with a required reason. Each is
 * its own click and sends one request with the version read as `If-Match`. Confirming writes nothing to MRE: the
 * transfer is the separate action „An MRE übertragen“ (§4.4). A `412` keeps the amount and the reason and reads again
 * only on request; no answer offers the same request again (both commands are no-ops when repeated).
 */
export function DecisionActions(props: {
  readonly reconciliation: RentReconciliationDto;
  readonly etag: string;
  /** The detail is being read again or its last read failed: no decision on a state that may be stale. */
  readonly stale: boolean;
  readonly confirm: (amount: MoneyValue, ifMatch: string) => Promise<ReconciliationChanged>;
  readonly reject: (reason: string, ifMatch: string) => Promise<ReconciliationChanged>;
  readonly onChanged: () => void;
  readonly reload: () => void;
}) {
  const r = props.reconciliation;
  const [amount, setAmount] = useState(() => decimalToInput(r.matchedAmount.amount) ?? r.matchedAmount.amount);
  const [reason, setReason] = useState('');
  const answer = useRef<HTMLDivElement>(null);
  const command = useCommand<Action, ReconciliationChanged>({
    onDone: () => props.onChanged(),
    onRefused: (_action, error) => {
      // The state changed on the server (decided elsewhere, matched in between): read it again, keep the drafts.
      if (error instanceof ApiError && error.status === 409) props.reload();
    },
  });
  const { stage } = command;
  useEffect(() => {
    if (stage.kind === 'refused' || stage.kind === 'done') answer.current?.focus();
  }, [stage]);

  if (stage.kind === 'done') {
    const done = stage.value.reconciliation;
    return (
      <div ref={answer} tabIndex={-1} role="status">
        <Notice tone="success">
          {stage.action === 'confirm' ? (
            <>
              {'Zuordnung bestätigt über '}
              <MoneyText money={done.matchedAmount} />
              {` (Version ${done.version}). An MRE wurde nichts übertragen; das ist ein eigener Schritt.`}
            </>
          ) : (
            `Vorschlag abgelehnt (Version ${done.version}). Diese Zuordnung wird nicht wieder vorgeschlagen.`
          )}
        </Notice>
      </div>
    );
  }
  if (!decidable(r) && stage.kind !== 'refused') return null;

  const checked = checkConfirmAmount(amount, r.matchedAmount);
  const reasonProblem = checkReason(reason);
  const busy = stage.kind === 'sending' || props.stale || !decidable(r);
  const sendConfirm = () => {
    if (!checked.ok) return;
    const sent = checked.amount;
    const tag = props.etag;
    command.run('confirm', () => props.confirm(sent, tag), isRetryable);
  };
  const sendReject = () => {
    if (reasonProblem !== undefined) return;
    const sent = reason.trim();
    const tag = props.etag;
    command.run('reject', () => props.reject(sent, tag), isRetryable);
  };

  return (
    <section aria-labelledby="vorschlag-pruefen" className="rounded-card border border-border bg-surface p-6">
      <h2 id="vorschlag-pruefen" className="mb-2 text-section font-semibold">
        Vorschlag prüfen
      </h2>
      <p className="text-muted">
        „Zuordnung bestätigen“ ordnet die Zahlung in DE dem Termin zu. An MRE wird dabei nichts übertragen; das ist danach ein eigener Schritt.
      </p>
      {stage.kind === 'refused' && (
        <div ref={answer} tabIndex={-1} className="mt-3">
          <ErrorState error={stage.error}>
            {stage.error instanceof ApiError && stage.error.status === 412 ? (
              <>
                <p className="mt-2">Die Zuordnung wurde seit dem Laden geändert. Es wurde nichts entschieden; Betrag und Grund bleiben stehen.</p>
                <button type="button" className={`${secondaryButtonClass} mt-3`} onClick={props.reload}>
                  Aktuellen Stand laden
                </button>
              </>
            ) : (
              <>
                {rentRefusalText(stage.error) !== undefined && <p className="mt-2">{rentRefusalText(stage.error)}</p>}
                {stage.retry !== undefined && (
                  <div className="mt-3 flex flex-wrap items-center gap-4">
                    <p>Ob die Entscheidung gespeichert wurde, ist unklar. „Erneut senden“ schickt dieselbe Entscheidung mit derselben Version.</p>
                    <button type="button" className={secondaryButtonClass} disabled={command.waiting} onClick={stage.retry}>
                      Erneut senden
                    </button>
                  </div>
                )}
              </>
            )}
          </ErrorState>
        </div>
      )}
      {decidable(r) && (
        <div className="mt-4 grid gap-6 md:grid-cols-2">
          <div className="flex flex-col gap-2">
            <label htmlFor="bestaetigen-betrag" className="font-semibold">
              Zu bestätigender Betrag (€)
            </label>
            <input
              id="bestaetigen-betrag"
              className="rounded-input border border-border px-3 py-2"
              inputMode="decimal"
              value={amount}
              aria-invalid={!checked.ok}
              aria-describedby="bestaetigen-betrag-hinweis"
              onChange={(event) => setAmount(event.target.value)}
            />
            <p id="bestaetigen-betrag-hinweis" className="text-label">
              {checked.ok ? (
                <>
                  {'Vorgeschlagen: '}
                  <MoneyText money={r.matchedAmount} />
                  {'. Weniger ist möglich, mehr nicht.'}
                </>
              ) : (
                <span className="text-danger-text">{AMOUNT_TEXTS[checked.problem]}</span>
              )}
            </p>
            <button type="button" className={buttonClass} disabled={busy || !checked.ok || command.waiting} onClick={sendConfirm}>
              {stage.kind === 'sending' && stage.action === 'confirm' ? 'Wird bestätigt …' : 'Zuordnung bestätigen'}
            </button>
          </div>
          <div className="flex flex-col gap-2">
            <label htmlFor="ablehnen-grund" className="font-semibold">
              Grund der Ablehnung (Pflicht)
            </label>
            <input
              id="ablehnen-grund"
              className="rounded-input border border-border px-3 py-2"
              value={reason}
              maxLength={MAX_REASON + 50}
              aria-describedby="ablehnen-grund-hinweis"
              onChange={(event) => setReason(event.target.value)}
            />
            <p id="ablehnen-grund-hinweis" className="text-label">
              {reasonProblem === undefined ? 'Abgelehnte Vorschläge werden nicht wieder vorgeschlagen.' : REASON_TEXTS[reasonProblem]}
            </p>
            <button type="button" className={secondaryButtonClass} disabled={busy || reasonProblem !== undefined || command.waiting} onClick={sendReject}>
              {stage.kind === 'sending' && stage.action === 'reject' ? 'Wird abgelehnt …' : 'Vorschlag ablehnen'}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
