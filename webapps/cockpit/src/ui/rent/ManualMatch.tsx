import { useEffect, useRef, useState, type FormEvent } from 'react';
import { newIdempotencyKey } from '../../api/client';
import { ApiError, partitionFieldErrors } from '../../api/errors';
import type { CreateReconciliationInputDto, ReconciliationChanged, TransactionRentCoverageDto } from '../../api/rent-reconciliations';
import type { MoneyValue } from '../../format/money';
import { checkMatchAmount, checkTenantId, checkTermKey, hasFreeCash, type MatchAmountProblem } from '../../rent/split-proposal';
import { decimalToInput } from '../../transactions/split-amount';
import { ConfirmStep, useConfirmStep } from '../ConfirmStep';
import { describeFieldError } from '../error-text';
import { MoneyText } from '../format';
import { buttonClass, ErrorState, isRetryable, Notice, secondaryButtonClass } from '../states';
import { inputClass } from '../transactions/SplitRows';
import { rentRefusalText } from './rent-labels';
import { ReconciliationBadges, ReconciliationLink, TenantText, TermLink, TermText } from './RentParts';

const AMOUNT_TEXTS: Readonly<Record<MatchAmountProblem, string>> = {
  EMPTY: 'Bitte einen Betrag angeben.',
  NEGATIVE: 'Der Betrag ist nie negativ.',
  TOO_MANY_DECIMALS: 'Höchstens zwei Nachkommastellen.',
  AMBIGUOUS: 'Mehrdeutig: bitte mit Komma schreiben (z. B. 1.234,00 oder 1234,56).',
  INVALID: 'Kein Betrag.',
  TOO_LARGE: 'Der Betrag ist zu groß.',
  NOT_POSITIVE: 'Der Betrag muss größer als 0,00 € sein.',
  ABOVE_AVAILABLE: 'Mehr als der noch freie Mietanteil der Buchung.',
};
const TENANT_TEXTS = {
  TENANT_MISSING: 'Bitte die ID des Mieters in MRE angeben.',
  TENANT_INVALID: 'Eine MRE-ID hat 24 Zeichen 0–9 und a–f (Kleinbuchstaben).',
} as const;
const TERM_TEXTS = {
  TERM_MISSING: 'Bitte den Miettermin angeben.',
  TERM_INVALID: 'Ein Miettermin ist der MRE-Schlüssel JJJJMMTTHH mit gültigem Datum, z. B. 2026100100.',
} as const;

/** The fields the form binds a server's field error to (`details.fields`, §58X); the rest stays in the summary. */
const FIELDS = ['mreTenantId', 'mreRentTerm', 'matchedAmount', 'matchedAmount.amount'] as const;

/** One intent of the user: the body and its key. The same body keeps the key; a changed one gets a new key. */
interface Intent {
  readonly key: string;
  readonly payload: string;
}

/**
 * „Manuell zuordnen“ (api-design.md §37.1 `POST /rent-reconciliations`; ui-guide.md §6.6; Entscheidung des
 * Projektinhabers, 2026-11-11): for what the suggest run leaves alone (partial, collective and overpayments, ambiguous
 * amounts, §37.3), the user matches the free rent cash of a confirmed inflow to one MRE term, named by the Tenant's MRE
 * id and the term key, with an amount up to the free cash. Its own action: the form, then a confirmation step that says
 * what happens; only „Jetzt zuordnen“ sends, once, with the intent's `Idempotency-Key`. The match is created
 * `CONFIRMED` in DE; nothing goes to MRE (BR-MRE-005): „An MRE übertragen“ stays a separate step on the match.
 */
export function ManualMatch(props: {
  readonly realmId: string;
  readonly coverage: TransactionRentCoverageDto;
  readonly create: (body: CreateReconciliationInputDto, idempotencyKey: string) => Promise<ReconciliationChanged>;
  readonly onCreated: () => void;
  /** A new `Idempotency-Key`; `crypto.randomUUID` unless a test passes its own. */
  readonly newKey?: () => string;
}) {
  const c = props.coverage;
  const free: MoneyValue | null = c.available;
  const [open, setOpen] = useState(false);
  const [tenant, setTenant] = useState('');
  const [term, setTerm] = useState('');
  const [amount, setAmount] = useState('');
  const [tried, setTried] = useState(false);
  const [sending, setSending] = useState(false);
  const [refusal, setRefusal] = useState<{ readonly error: unknown; readonly retry: boolean } | undefined>(undefined);
  const [done, setDone] = useState<ReconciliationChanged | undefined>(undefined);
  const step = useConfirmStep<'match'>();
  const intent = useRef<Intent | undefined>(undefined);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  const answer = useRef<HTMLDivElement>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (done !== undefined || refusal !== undefined) answer.current?.focus();
  }, [done, refusal]);

  if (done !== undefined) {
    const r = done.reconciliation;
    return (
      <div ref={answer} tabIndex={-1} role="status" className="mt-4">
        <Notice tone="success">
          {'Manuell zugeordnet: '}
          <MoneyText money={r.matchedAmount} /> · <TenantText id={r.mreTenantId} /> · <TermText term={r.mreRentTerm} /> <ReconciliationBadges r={r} />
          <p>An MRE wurde nichts übertragen; „An MRE übertragen“ ist ein eigener Schritt an der Zuordnung.</p>
          <p>
            <ReconciliationLink realmId={props.realmId} id={r.reconciliationId} /> · <TermLink realmId={props.realmId} r={r} />
          </p>
        </Notice>
        <button
          type="button"
          className={`${secondaryButtonClass} mt-3`}
          onClick={() => {
            // The next match starts from the free cash as read now (the page reads the coverage again after a match).
            setDone(undefined);
            setTerm('');
            setAmount(free === null ? '' : (decimalToInput(free.amount) ?? ''));
            setTried(false);
          }}
        >
          Weitere Zuordnung erfassen
        </button>
      </div>
    );
  }

  if (!c.counted || c.direction !== 'INFLOW' || !hasFreeCash(free)) return null;

  const tenantProblem = checkTenantId(tenant);
  const termProblem = checkTermKey(term);
  const checked = checkMatchAmount(amount, free);
  const valid = tenantProblem === undefined && termProblem === undefined && checked.ok;
  const body = (): CreateReconciliationInputDto | undefined =>
    checked.ok && valid ? { transactionId: c.transactionId, mreTenantId: tenant.trim(), mreRentTerm: term.trim(), matchedAmount: checked.amount } : undefined;

  const send = (sent: CreateReconciliationInputDto, key: string) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setSending(true);
    setRefusal(undefined);
    props
      .create(sent, key)
      .then(
        (created) => {
          if (!mounted.current) return;
          intent.current = undefined;
          step.close();
          setDone(created);
          props.onCreated();
        },
        (error: unknown) => {
          if (!mounted.current) return;
          step.close();
          setRefusal({ error, retry: isRetryable(error) });
        },
      )
      .finally(() => {
        inFlight.current = false;
        if (mounted.current) setSending(false);
      });
  };
  const confirm = () => {
    const sent = body();
    if (sent === undefined) return;
    const payload = JSON.stringify(sent);
    if (intent.current?.payload !== payload) intent.current = { key: (props.newKey ?? newIdempotencyKey)(), payload };
    send(sent, intent.current.key);
  };
  const ask = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setTried(true);
    if (valid && !sending) step.ask('match');
  };
  /** A changed value is a new intent: the retry of the old one goes, its refusal text stays. */
  const change = (set: (value: string) => void) => (value: string) => {
    set(value);
    setRefusal((current) => (current === undefined ? undefined : { ...current, retry: false }));
  };

  const serverFields = refusal?.error instanceof ApiError ? partitionFieldErrors(refusal.error.fields, [...FIELDS]).known : [];
  const fieldHint = (names: readonly string[], local: string | undefined, id: string) => {
    const server = serverFields.filter((entry) => names.includes(entry.field)).map((entry) => `Vom Server abgelehnt: ${describeFieldError(entry).text}`);
    const texts = [...(tried && local !== undefined ? [local] : []), ...server];
    return texts.length === 0 ? null : (
      <p id={id} className="text-label text-danger-text">
        {texts.join(' ')}
      </p>
    );
  };
  const invalid = (names: readonly string[], local: string | undefined) =>
    (tried && local !== undefined) || serverFields.some((entry) => names.includes(entry.field));
  const tenantHint = fieldHint(['mreTenantId'], tenantProblem === undefined ? undefined : TENANT_TEXTS[tenantProblem], 'zuordnen-mieter-hinweis');
  const termHint = fieldHint(['mreRentTerm'], termProblem === undefined ? undefined : TERM_TEXTS[termProblem], 'zuordnen-termin-hinweis');
  const amountHint = fieldHint(['matchedAmount', 'matchedAmount.amount'], checked.ok ? undefined : AMOUNT_TEXTS[checked.problem], 'zuordnen-betrag-hinweis');
  const sent = body();

  return (
    <div className="mt-4 flex flex-col gap-3 border-t border-border pt-4">
      <h3 id="manuell-zuordnen" className="font-semibold">
        Manuell zuordnen
      </h3>
      {!open ? (
        <>
          <p className="text-muted">
            Für Teil-, Sammel- und Überzahlungen, die der Vorschlagslauf nicht zuordnet: den freien Mietanteil einem Termin eines Mieters in MRE zuordnen.
          </p>
          <div>
            <button
              type="button"
              className={secondaryButtonClass}
              onClick={() => {
                setOpen(true);
                if (amount === '') setAmount(decimalToInput(free.amount) ?? '');
              }}
            >
              Manuell zuordnen
            </button>
          </div>
        </>
      ) : (
        <>
          {refusal !== undefined && (
            <div ref={answer} tabIndex={-1}>
              <ErrorState error={refusal.error}>
                {rentRefusalText(refusal.error) !== undefined && <p className="mt-2">{rentRefusalText(refusal.error)}</p>}
                {refusal.retry && intent.current !== undefined && (
                  <div className="mt-3 flex flex-wrap items-center gap-4">
                    <p>
                      Ob die Zuordnung angelegt wurde, ist unklar. „Erneut senden“ schickt dieselbe Zuordnung mit demselben Schlüssel; sie entsteht nie doppelt.
                    </p>
                    <button type="button" className={secondaryButtonClass} disabled={sending} onClick={confirm}>
                      Erneut senden
                    </button>
                  </div>
                )}
              </ErrorState>
            </div>
          )}
          <form aria-label="Manuelle Zuordnung erfassen" noValidate onSubmit={ask} className="flex flex-wrap items-start gap-4">
            <div className="flex flex-col gap-1">
              <label htmlFor="zuordnen-mieter" className="text-label text-muted">
                Mieter in MRE (ID)
              </label>
              <input
                id="zuordnen-mieter"
                className={`${inputClass} font-mono`}
                value={tenant}
                spellCheck={false}
                readOnly={step.asking !== undefined}
                aria-invalid={invalid(['mreTenantId'], tenantProblem)}
                aria-describedby={tenantHint === null ? undefined : 'zuordnen-mieter-hinweis'}
                onChange={(event) => change(setTenant)(event.target.value)}
              />
              {tenantHint}
            </div>
            <div className="flex flex-col gap-1">
              <label htmlFor="zuordnen-termin" className="text-label text-muted">
                Miettermin (MRE-Schlüssel JJJJMMTTHH)
              </label>
              <input
                id="zuordnen-termin"
                className={`${inputClass} font-mono`}
                value={term}
                inputMode="numeric"
                readOnly={step.asking !== undefined}
                aria-invalid={invalid(['mreRentTerm'], termProblem)}
                aria-describedby={termHint === null ? undefined : 'zuordnen-termin-hinweis'}
                onChange={(event) => change(setTerm)(event.target.value)}
              />
              {termHint}
            </div>
            <div className="flex flex-col gap-1">
              <label htmlFor="zuordnen-betrag" className="text-label text-muted">
                Zuzuordnender Betrag (€)
              </label>
              <input
                id="zuordnen-betrag"
                className={inputClass}
                inputMode="decimal"
                value={amount}
                readOnly={step.asking !== undefined}
                aria-invalid={invalid(['matchedAmount', 'matchedAmount.amount'], checked.ok ? undefined : checked.problem)}
                aria-describedby={['zuordnen-betrag-frei', amountHint === null ? undefined : 'zuordnen-betrag-hinweis'].filter(Boolean).join(' ')}
                onChange={(event) => change(setAmount)(event.target.value)}
              />
              <p id="zuordnen-betrag-frei" className="text-label text-muted">
                {'Noch frei: '}
                <MoneyText money={free} />
                {'. Weniger ist möglich; der Rest bleibt frei.'}
              </p>
              {amountHint}
            </div>
            {step.asking === 'match' && sent !== undefined ? (
              <div className="basis-full">
                <ConfirmStep
                  level={4}
                  id="zuordnen-frage"
                  title="Zahlung jetzt manuell zuordnen?"
                  confirmLabel="Jetzt zuordnen"
                  sendingLabel="Wird zugeordnet …"
                  sending={sending}
                  disabled={false}
                  onConfirm={confirm}
                  onCancel={step.cancel}
                >
                  <p>
                    <MoneyText money={sent.matchedAmount} />
                    {' dieser Buchung werden in DE dem Termin '}
                    <TermText term={sent.mreRentTerm} />
                    {' des Mieters '}
                    <TenantText id={sent.mreTenantId} />
                    {' zugeordnet (Status „Zuordnung bestätigt“). DE prüft den Termin dabei in MRE.'}
                  </p>
                  <p>An MRE wird nichts übertragen; das ist danach ein eigener Schritt. Eine falsche Zuordnung wird aufgehoben, nicht geändert.</p>
                </ConfirmStep>
              </div>
            ) : (
              <div className="flex basis-full flex-wrap items-center gap-4">
                <button ref={step.trigger('match')} type="submit" className={buttonClass} disabled={sending}>
                  Zuordnung anlegen
                </button>
              </div>
            )}
          </form>
        </>
      )}
    </div>
  );
}
