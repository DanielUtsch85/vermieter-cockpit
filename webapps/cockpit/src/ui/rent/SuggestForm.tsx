import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ApiError, partitionFieldErrors } from '../../api/errors';
import type { SuggestInputDto, SuggestResultDto } from '../../api/rent-reconciliations';
import { AREAS, areaPath } from '../../routing';
import { checkSuggestWindow, MAX_SUGGEST_MONTHS, suggestBookingRange, type WindowProblem } from '../../rent/reconciliation-rules';
import { describeFieldError } from '../error-text';
import { MoneyText } from '../format';
import { buttonClass, ErrorState, isRetryable, Notice } from '../states';
import { Link, ReconciliationLink, TenantText, TermText } from './RentParts';
import { useCommand } from './use-command';

const WINDOW_TEXTS: Readonly<Record<WindowProblem, string>> = {
  FROM_INVALID: 'Bitte den ersten Monat angeben (JJJJ-MM).',
  TO_INVALID: 'Bitte den letzten Monat angeben (JJJJ-MM).',
  INVERTED: 'Der letzte Monat liegt vor dem ersten.',
  TOO_LONG: `Höchstens ${MAX_SUGGEST_MONTHS} Monate auf einmal.`,
};

const buchungen = AREAS.find((area) => area.id === 'buchungen');

function bookingsHref(realmId: string, window: SuggestInputDto, status: string): string {
  const range = suggestBookingRange(window.from, window.to);
  const search = new URLSearchParams({ status, ...(range === undefined ? {} : range) });
  return buchungen === undefined ? '' : areaPath(realmId, buchungen, `?${search.toString()}`);
}

/**
 * What a suggest run says (ui-guide.md §6.6, api-design.md §37.3, §37.6): the suggestions it wrote, and the inflows of
 * the window no rule could see, with a link to them in Buchungen. An empty run is never "alle Mieten bezahlt".
 */
function SuggestOutcome({ realmId, result }: { readonly realmId: string; readonly result: SuggestResultDto }) {
  const { unconfirmed, noRentCash } = result.skipped;
  const window = { from: result.from, to: result.to };
  return (
    <div className="flex flex-col gap-3">
      {result.items.length === 0 ? (
        <Notice tone="info">
          <p className="font-semibold">{`Keine neuen Vorschläge für ${result.from} bis ${result.to}.`}</p>
          <p>
            „Keine Vorschläge“ heißt nicht „alle Mieten bezahlt“. Vorgeschlagen wird nur, was eindeutig passt: Teil-, Sammel- und Überzahlungen ordnet der Lauf
            nicht zu, und offene Vorschläge früherer Läufe stehen in der Liste unten.
          </p>
        </Notice>
      ) : (
        <Notice tone="success">
          <p className="font-semibold">{`${result.items.length} ${result.items.length === 1 ? 'neuer Vorschlag' : 'neue Vorschläge'} für ${result.from} bis ${result.to}.`}</p>
          <p>Noch ist nichts bestätigt und nichts an MRE übertragen. Bitte jeden Vorschlag einzeln prüfen.</p>
          <ul aria-label="Neue Vorschläge" className="mt-2 flex flex-col gap-1">
            {result.items.map((r) => (
              <li key={r.reconciliationId}>
                <MoneyText money={r.matchedAmount} /> · <TenantText id={r.mreTenantId} /> · <TermText term={r.mreRentTerm} /> ·{' '}
                <ReconciliationLink realmId={realmId} id={r.reconciliationId}>
                  Vorschlag prüfen
                </ReconciliationLink>
              </li>
            ))}
          </ul>
        </Notice>
      )}
      {unconfirmed > 0 && (
        <Notice tone="warning">
          {`${unconfirmed} ${unconfirmed === 1 ? 'Zahlungseingang' : 'Zahlungseingänge'} im Zeitraum ${unconfirmed === 1 ? 'ist' : 'sind'} noch nicht bestätigt und konnte${unconfirmed === 1 ? '' : 'n'} nicht berücksichtigt werden. Erst aufteilen und „Buchung bestätigen“, dann erneut ermitteln. `}
          <Link href={bookingsHref(realmId, window, 'IMPORTED,UNREVIEWED,CLASSIFIED')}>Unbestätigte Buchungen des Zeitraums</Link>
        </Notice>
      )}
      {noRentCash > 0 && (
        <Notice tone="warning">
          {`${noRentCash} ${noRentCash === 1 ? 'bestätigter Zahlungseingang hat' : 'bestätigte Zahlungseingänge haben'} keinen Anteil in einer Mietkategorie. Bitte prüfen, ob darunter Miete ist (z. B. falsch kategorisiert). `}
          <Link href={bookingsHref(realmId, window, 'CONFIRMED,RECONCILED')}>Bestätigte Buchungen des Zeitraums</Link>
        </Notice>
      )}
      {unconfirmed === 0 && noRentCash === 0 && <p className="text-muted">Im Zeitraum wurde kein Zahlungseingang übersprungen.</p>}
    </div>
  );
}

/**
 * „Vorschläge ermitteln“ (ui-guide.md §6.6 step 5; api-design.md §37.3): `POST /rent-reconciliations/suggest` for a
 * window of at most twelve months, sent only on the click. It writes `SUGGESTED` reconciliations in DE and nothing in
 * MRE; a repeat writes nothing new, so a lost answer may be sent again. MRE unreachable is a `503` with nothing written.
 */
export function SuggestForm(props: {
  readonly realmId: string;
  readonly suggest: (body: SuggestInputDto) => Promise<SuggestResultDto>;
  readonly onSuggested: () => void;
}) {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [tried, setTried] = useState(false);
  const answer = useRef<HTMLDivElement>(null);
  const command = useCommand<'suggest', SuggestResultDto>({ onDone: () => props.onSuggested() });
  const { stage } = command;
  useEffect(() => {
    if (stage.kind === 'refused' || stage.kind === 'done') answer.current?.focus();
  }, [stage]);

  const problem = checkSuggestWindow(from.trim(), to.trim());
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setTried(true);
    if (problem !== undefined) return;
    const body: SuggestInputDto = { from: from.trim(), to: to.trim() };
    command.run('suggest', () => props.suggest(body), isRetryable);
  };
  const refusal = stage.kind === 'refused' && stage.error instanceof ApiError ? stage.error : undefined;
  const fields = partitionFieldErrors(refusal?.fields ?? [], ['from', 'to']);
  const fieldText = (name: string) =>
    fields.known
      .filter((entry) => entry.field === name)
      .map((entry) => (entry.code === 'RANGE_TOO_LONG' ? WINDOW_TEXTS.TOO_LONG : describeFieldError(entry).text));
  const clientField = problem === undefined ? undefined : problem === 'FROM_INVALID' ? 'from' : 'to';
  const fieldHint = (name: 'from' | 'to') => {
    const server = fieldText(name);
    if (server.length > 0) return server.join(', ');
    return tried && problem !== undefined && clientField === name ? WINDOW_TEXTS[problem] : undefined;
  };

  return (
    <section aria-labelledby="vorschlaege-ermitteln" className="rounded-card border border-border bg-surface p-6">
      <h2 id="vorschlaege-ermitteln" className="mb-2 text-section font-semibold">
        Vorschläge ermitteln
      </h2>
      <p className="text-muted">
        Sucht für bestätigte Zahlungseingänge den passenden Mietertermin in MRE (höchstens {MAX_SUGGEST_MONTHS} Monate). Es entstehen nur Vorschläge; bestätigt
        und an MRE übertragen wird jeder einzeln.
      </p>
      <form className="mt-3 flex flex-wrap items-end gap-4" noValidate onSubmit={submit}>
        {(['from', 'to'] as const).map((name) => {
          const hint = fieldHint(name);
          return (
            <div key={name} className="flex flex-col gap-1">
              <label htmlFor={`vorschlag-${name}`} className="font-semibold">
                {name === 'from' ? 'Erster Monat' : 'Letzter Monat'}
              </label>
              <input
                id={`vorschlag-${name}`}
                type="month"
                placeholder="JJJJ-MM"
                className="rounded-input border border-border px-3 py-2"
                value={name === 'from' ? from : to}
                aria-invalid={hint !== undefined}
                aria-describedby={hint === undefined ? undefined : `vorschlag-${name}-fehler`}
                onChange={(event) => (name === 'from' ? setFrom : setTo)(event.target.value)}
              />
              {hint !== undefined && (
                <p id={`vorschlag-${name}-fehler`} className="text-label text-danger-text">
                  {hint}
                </p>
              )}
            </div>
          );
        })}
        <button type="submit" className={buttonClass} disabled={stage.kind === 'sending' || command.waiting}>
          {stage.kind === 'sending' ? 'Vorschläge werden ermittelt …' : 'Vorschläge ermitteln'}
        </button>
      </form>
      <div ref={answer} tabIndex={-1} className="mt-4">
        {stage.kind === 'done' && <SuggestOutcome realmId={props.realmId} result={stage.value} />}
        {stage.kind === 'refused' && (
          <ErrorState error={stage.error}>
            {refusal !== undefined && refusal.status === 503 && <p className="mt-2">Es wurde nichts geschrieben.</p>}
            {stage.retry !== undefined && (
              <p className="mt-2">Ob Vorschläge geschrieben wurden, ist unklar. Erneut ermitteln schreibt nichts doppelt; die Liste unten zeigt den Stand.</p>
            )}
            {command.waiting && <p className="mt-2">Erneut ermitteln ist erst nach der vom Server genannten Wartezeit möglich.</p>}
          </ErrorState>
        )}
      </div>
    </section>
  );
}
