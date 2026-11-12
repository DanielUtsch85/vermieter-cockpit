import { useEffect, useRef, useState } from 'react';
import { ApiError } from '../../api/errors';
import type { ReconciliationChanged, RentReconciliationDto } from '../../api/rent-reconciliations';
import { checkReason, MAX_REASON, releaseOffer, removalOffer, writeBackOffer } from '../../rent/reconciliation-rules';
import { ConfirmStep, useConfirmStep } from '../ConfirmStep';
import { TimestampText } from '../format';
import { buttonClass, ErrorState, Notice, secondaryButtonClass } from '../states';
import { rentRefusalText } from './rent-labels';
import { useCommand } from './use-command';

type Action = 'writeBack' | 'release' | 'remove';

const DONE: Readonly<Record<Action, string>> = {
  writeBack: 'An MRE übertragen: die Zahlung steht jetzt im Termin in MRE.',
  release: 'Zuordnung aufgehoben. In MRE wurde dabei nichts geändert.',
  remove: 'Die Zahlung von DE wurde aus MRE entfernt. Die übrigen Zahlungen des Termins blieben unverändert.',
};

/** The two actions that write into MRE get a confirmation step first (Entscheidung des Projektinhabers, 2026-11-11). */
type MreWrite = Exclude<Action, 'release'>;

const QUESTIONS: Readonly<Record<MreWrite, { readonly title: string; readonly text: string; readonly confirm: string; readonly sending: string }>> = {
  writeBack: {
    title: 'Zahlung jetzt an MRE übertragen?',
    text: 'DE schreibt jetzt in MRE: die Zahlung wird mit dem bestätigten Betrag in den Termin des Mieters eingetragen. Die übrigen Zahlungen des Termins bleiben unverändert.',
    confirm: 'Jetzt an MRE übertragen',
    sending: 'Wird übertragen …',
  },
  remove: {
    title: 'Zahlung jetzt aus MRE entfernen?',
    text: 'DE schreibt jetzt in MRE: die Zahlung mit der Kennung dieser Zuordnung wird aus dem Termin des Mieters entfernt. Die übrigen Zahlungen des Termins bleiben unverändert.',
    confirm: 'Jetzt aus MRE entfernen',
    sending: 'Wird entfernt …',
  },
};

/**
 * The actions after a confirmation (ui-guide.md §6.6 step 7, §11; api-design.md §37.1, §37.4, §37.5), each a separate
 * explicit click and never run by rendering, a refetch or a tab change:
 * - „An MRE übertragen“ for a `CONFIRMED` match that is not written (or failed);
 * - „Zuordnung aufheben“ for a `CONFIRMED` match, with a required reason. DE only: it removes nothing from MRE;
 * - „Aus MRE entfernen“ after the release, when DE's payment is or may be in MRE (`REMOVAL_REQUIRED`, `REMOVAL_FAILED`).
 * Every refusal but a `412` reads the detail again once (a failed write is recorded, a concurrent one is running); a
 * `Retry-After` or a running write locks the buttons for that time; nothing is ever sent again by itself. Both MRE
 * writes open a confirmation step first; only its confirm button sends.
 */
export function MreActions(props: {
  readonly realmId: string;
  readonly reconciliation: RentReconciliationDto;
  readonly etag: string;
  readonly stale: boolean;
  readonly writeBack: (ifMatch: string) => Promise<ReconciliationChanged>;
  readonly release: (reason: string, ifMatch: string) => Promise<ReconciliationChanged>;
  readonly remove: (ifMatch: string) => Promise<ReconciliationChanged>;
  readonly onChanged: () => void;
  readonly reload: () => void;
  readonly now?: () => number;
}) {
  const r = props.reconciliation;
  const now = (props.now ?? Date.now)();
  const [reason, setReason] = useState('');
  const answer = useRef<HTMLDivElement>(null);
  const step = useConfirmStep<MreWrite>();
  const command = useCommand<Action, ReconciliationChanged>({
    onDone: () => {
      step.close();
      props.onChanged();
    },
    onRefused: (_action, error) => {
      step.close();
      if (!(error instanceof ApiError && error.status === 412)) props.reload();
    },
  });
  const { stage } = command;
  useEffect(() => {
    if (stage.kind === 'refused' || stage.kind === 'done') answer.current?.focus();
  }, [stage]);

  const writeBack = writeBackOffer(r, now);
  const release = releaseOffer(r, now);
  const removal = removalOffer(r, now);
  const reasonProblem = checkReason(reason);
  // A step whose action is no longer offered (read again meanwhile) closes; it would not come back by itself.
  const withdrawn = (step.asking === 'writeBack' && writeBack !== 'offer') || (step.asking === 'remove' && removal !== 'offer');
  useEffect(() => {
    if (withdrawn) step.close();
  });
  const locked = stage.kind === 'sending' || props.stale || command.waiting;
  const run = (action: Action, call: (tag: string) => Promise<ReconciliationChanged>) => {
    const tag = props.etag;
    command.run(action, () => call(tag));
  };
  const ask = (action: MreWrite, call: (tag: string) => Promise<ReconciliationChanged>) => {
    const question = QUESTIONS[action];
    return (
      <ConfirmStep
        id={`mre-frage-${action}`}
        title={question.title}
        confirmLabel={question.confirm}
        sendingLabel={question.sending}
        sending={stage.kind === 'sending' && stage.action === action}
        disabled={locked}
        onConfirm={() => run(action, call)}
        onCancel={step.cancel}
      >
        <p>{question.text}</p>
      </ConfirmStep>
    );
  };
  const nothing = writeBack === 'none' && release === 'none' && removal === 'none';
  if (nothing && stage.kind === 'idle') return null;

  return (
    <section aria-labelledby="mre-aktionen" className="rounded-card border border-border bg-surface p-6">
      <h2 id="mre-aktionen" className="mb-2 text-section font-semibold">
        Übertragung an MRE und Aufheben
      </h2>
      <p className="text-muted">
        Drei getrennte Schritte: „An MRE übertragen“ trägt die Zahlung in MRE ein. „Zuordnung aufheben“ ändert nur DE; Aufheben ist kein Entfernen aus MRE. Eine
        übertragene Zahlung wird danach gesondert mit „Aus MRE entfernen“ entfernt.
      </p>
      <div ref={answer} tabIndex={-1} className="mt-3">
        {stage.kind === 'done' && (
          <div role="status">
            <Notice tone="success">{DONE[stage.action]}</Notice>
          </div>
        )}
        {stage.kind === 'refused' && (
          <ErrorState error={stage.error}>
            {stage.error instanceof ApiError && stage.error.status === 412 ? (
              <>
                <p className="mt-2">Die Zuordnung wurde seit dem Laden geändert. Es wurde nichts gesendet und nichts wird von selbst wiederholt.</p>
                <button type="button" className={`${secondaryButtonClass} mt-3`} onClick={props.reload}>
                  Aktuellen Stand laden
                </button>
              </>
            ) : (
              <>
                {rentRefusalText(stage.error) !== undefined && <p className="mt-2">{rentRefusalText(stage.error)}</p>}
                <p className="mt-2">Der Stand wurde neu geladen. Nichts wird von selbst wiederholt.</p>
              </>
            )}
          </ErrorState>
        )}
        {command.waiting && <p className="mt-2">Bitte warten: die Aktionen sind erst nach der vom Server genannten Wartezeit wieder möglich.</p>}
      </div>
      <div className="mt-4 flex flex-col gap-4">
        {writeBack === 'offer' && step.asking === 'writeBack' && ask('writeBack', props.writeBack)}
        {writeBack === 'offer' && step.asking !== 'writeBack' && (
          <div className="flex flex-wrap items-center gap-4">
            <button ref={step.trigger('writeBack')} type="button" className={buttonClass} disabled={locked} onClick={() => step.ask('writeBack')}>
              An MRE übertragen
            </button>
            {r.mreWriteBackState === 'FAILED' && (
              <span className="text-label text-muted">Der letzte Versuch ist fehlgeschlagen; ein neuer Versuch liest den Termin zuerst.</span>
            )}
          </div>
        )}
        {(writeBack === 'running' || removal === 'running') && (
          <div className="flex flex-wrap items-center gap-4">
            <p>
              {'Ein Schreibvorgang in MRE läuft bis '}
              <TimestampText value={r.mreWriteBackLeaseUntil} />.
            </p>
            <button type="button" className={secondaryButtonClass} disabled={props.stale} onClick={props.reload}>
              Stand neu laden
            </button>
          </div>
        )}
        {release === 'offer' && (
          <div className="flex flex-col gap-2">
            <label htmlFor="aufheben-grund" className="font-semibold">
              Grund für das Aufheben (Pflicht)
            </label>
            <input
              id="aufheben-grund"
              className="rounded-input border border-border px-3 py-2"
              value={reason}
              maxLength={MAX_REASON + 50}
              aria-describedby="aufheben-hinweis"
              onChange={(event) => setReason(event.target.value)}
            />
            <p id="aufheben-hinweis" className="text-label">
              {reasonProblem === 'REASON_TOO_LONG'
                ? `Höchstens ${MAX_REASON} Zeichen.`
                : r.mreWriteBackState === 'NOT_WRITTEN'
                  ? 'Nicht an MRE übertragen: Aufheben ändert nur DE.'
                  : 'Aufheben ist kein Entfernen aus MRE: danach wird „Aus MRE entfernen“ angeboten.'}
            </p>
            <div>
              <button
                type="button"
                className={secondaryButtonClass}
                disabled={locked || reasonProblem !== undefined}
                onClick={() => run('release', (tag) => props.release(reason.trim(), tag))}
              >
                {stage.kind === 'sending' && stage.action === 'release' ? 'Wird aufgehoben …' : 'Zuordnung aufheben'}
              </button>
            </div>
          </div>
        )}
        {release === 'running' && <p>Aufheben ist erst möglich, wenn die laufende Übertragung an MRE beendet ist.</p>}
        {removal === 'offer' && step.asking === 'remove' && ask('remove', props.remove)}
        {removal === 'offer' && step.asking !== 'remove' && (
          <div className="flex flex-wrap items-center gap-4">
            <button ref={step.trigger('remove')} type="button" className={buttonClass} disabled={locked} onClick={() => step.ask('remove')}>
              Aus MRE entfernen
            </button>
            <span className="text-label text-muted">Entfernt wird nur die Zahlung mit der Kennung dieser Zuordnung; andere Zahlungen bleiben.</span>
          </div>
        )}
      </div>
    </section>
  );
}
