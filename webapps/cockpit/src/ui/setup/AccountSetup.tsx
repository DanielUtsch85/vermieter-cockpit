import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { newIdempotencyKey, type DeClient } from '../../api/client';
import { ApiError, partitionFieldErrors } from '../../api/errors';
import { createFinancialAccount, type CreateFinancialAccountInputDto } from '../../api/setup';
import { listFinancialAccounts, type FinancialAccountDto } from '../../api/transactions';
import { AREAS, areaPath } from '../../routing';
import { ACCOUNT_TYPES, accountTypeLabel, checkAccount, ibanRequired, type AccountType } from '../../setup/account-draft';
import { describeFieldError } from '../error-text';
import { Link } from '../Link';
import { PageTitle } from '../PageTitle';
import { buttonClass, ErrorState, isRetryable, LoadingState, Notice, ReadProblem, secondaryButtonClass } from '../states';
import { inputClass } from '../transactions/SplitRows';
import { transactionKeys } from '../transactions/TransactionsArea';
import { accountStatusLabel } from '../transactions/labels';
import { ACCOUNT_PROBLEM_TEXTS, accountRefusalText } from './setup-labels';
import { SETUP_LABELS } from './setup-links';

/** The inputs a server's field error is bound to (`details.fields`, api-design.md §29.2); the rest stays in the summary. */
const FIELDS = { accountType: 'konto-art', displayName: 'konto-name', iban: 'konto-iban' } as const;

/** One intent of the user: the body and its key. The same body keeps the key; a changed one gets a new key (ui-guide.md §7.3). */
interface Intent {
  readonly key: string;
  readonly payload: string;
}

const importArea = AREAS.find((area) => area.id === 'import');

/**
 * „Konto anlegen“ (Issue #365; api-design.md §29.1): the Realm's accounts and the form for a new one. Creating is not
 * irreversible, so there is no confirmation step: one click sends one `POST` with the `Idempotency-Key` of the intent; a
 * second click while it runs does nothing, and a lost answer offers the same body with the same key again. The IBAN is
 * required for bank accounts and checked here as the backend checks it (Entscheidung des Projektinhabers, 2026-11-16).
 */
export function AccountSetup(props: {
  readonly client: DeClient;
  readonly realmId: string;
  readonly epoch: number;
  /** A new `Idempotency-Key`; `crypto.randomUUID` unless a test passes its own. */
  readonly newKey?: () => string;
}) {
  const queryClient = useQueryClient();
  const accounts = useQuery({
    queryKey: transactionKeys.accounts(props.realmId, props.epoch),
    queryFn: ({ signal }) => listFinancialAccounts(props.client, signal),
  });
  const [created, setCreated] = useState<FinancialAccountDto | undefined>(undefined);

  return (
    <>
      <PageTitle title={SETUP_LABELS.konto} />
      <section aria-labelledby="konten" className="rounded-card border border-border bg-surface p-6">
        <h2 id="konten" className="mb-2 text-section font-semibold">
          Konten dieses Bestands
        </h2>
        {accounts.isPending ? (
          <LoadingState label="Konten werden geladen …" />
        ) : accounts.isError ? (
          <ReadProblem error={accounts.error} onRetry={() => void accounts.refetch()} />
        ) : (
          <AccountList accounts={accounts.data.items} total={accounts.data.total} />
        )}
      </section>
      <section aria-labelledby="konto-neu" className="rounded-card border border-border bg-surface p-6">
        <h2 id="konto-neu" className="mb-2 text-section font-semibold">
          Neues Konto
        </h2>
        {created === undefined ? (
          <AccountForm
            create={(body, key) => createFinancialAccount(props.client, body, key)}
            newKey={props.newKey ?? newIdempotencyKey}
            onCreated={(account) => {
              setCreated(account);
              void queryClient.invalidateQueries({ queryKey: transactionKeys.accounts(props.realmId, props.epoch) });
            }}
          />
        ) : (
          <Created account={created} realmId={props.realmId} onNext={() => setCreated(undefined)} />
        )}
      </section>
    </>
  );
}

function AccountList({ accounts, total }: { readonly accounts: readonly FinancialAccountDto[]; readonly total: number }) {
  if (accounts.length === 0) return <p className="text-muted">In diesem Bestand gibt es noch kein Konto. Ohne Konto ist kein Import möglich.</p>;
  return (
    <>
      <ul aria-label="Konten" className="flex flex-col divide-y divide-border">
        {accounts.map((a) => (
          <li key={a.financialAccountId} className="flex flex-col gap-1 py-2">
            <span className="font-semibold">{a.displayName}</span>
            <span className="text-label text-muted">
              {[accountTypeLabel(a.accountType), a.iban ?? 'ohne IBAN', a.status === 'OPEN' ? '' : accountStatusLabel(a.status).text]
                .filter((part) => part !== '')
                .join(' · ')}
            </span>
          </li>
        ))}
      </ul>
      {total > accounts.length && <p className="text-label text-muted">{`Gezeigt werden ${accounts.length} von ${total} Konten.`}</p>}
    </>
  );
}

function Created(props: { readonly account: FinancialAccountDto; readonly realmId: string; readonly onNext: () => void }) {
  const a = props.account;
  const answer = useRef<HTMLDivElement>(null);
  useEffect(() => answer.current?.focus(), []);
  return (
    <div ref={answer} tabIndex={-1} role="status" className="flex flex-col gap-3">
      <Notice tone="success">
        <p>{`Konto „${a.displayName}“ angelegt (${accountTypeLabel(a.accountType)}, ${a.iban === null ? 'ohne IBAN' : `IBAN ${a.iban}`}).`}</p>
        {importArea !== undefined && (
          <p>
            <Link href={areaPath(props.realmId, importArea)}>Zum Import</Link>
          </p>
        )}
      </Notice>
      <div>
        <button type="button" className={secondaryButtonClass} onClick={props.onNext}>
          Weiteres Konto anlegen
        </button>
      </div>
    </div>
  );
}

function AccountForm(props: {
  readonly create: (body: CreateFinancialAccountInputDto, key: string) => Promise<FinancialAccountDto>;
  readonly newKey: () => string;
  readonly onCreated: (account: FinancialAccountDto) => void;
}) {
  const [accountType, setAccountType] = useState<AccountType>('BANK');
  const [displayName, setDisplayName] = useState('');
  const [iban, setIban] = useState('');
  const [tried, setTried] = useState(false);
  const [sending, setSending] = useState(false);
  const [refusal, setRefusal] = useState<{ readonly error: unknown; readonly retry: boolean } | undefined>(undefined);
  const intent = useRef<Intent | undefined>(undefined);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  const problem = useRef<HTMLDivElement>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (refusal !== undefined) problem.current?.focus();
  }, [refusal]);

  const checked = checkAccount({ accountType, displayName, iban });
  const problems = checked.ok ? [] : checked.problems;
  const required = ibanRequired(accountType);

  const send = () => {
    if (!checked.ok || inFlight.current) return;
    const payload = JSON.stringify(checked.body);
    if (intent.current?.payload !== payload) intent.current = { key: props.newKey(), payload };
    const key = intent.current.key;
    inFlight.current = true;
    setSending(true);
    setRefusal(undefined);
    props
      .create(checked.body, key)
      .then(
        (account) => {
          if (!mounted.current) return;
          intent.current = undefined;
          props.onCreated(account);
        },
        (error: unknown) => {
          if (mounted.current) setRefusal({ error, retry: isRetryable(error) });
        },
      )
      .finally(() => {
        inFlight.current = false;
        if (mounted.current) setSending(false);
      });
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    setTried(true);
    send();
  };
  /** A changed value is a new intent: the offer to send the earlier body again goes, its refusal text stays. */
  const change = (set: () => void) => {
    set();
    setRefusal((current) => (current === undefined ? undefined : { ...current, retry: false }));
  };

  const serverFields = refusal?.error instanceof ApiError ? partitionFieldErrors(refusal.error.fields, Object.keys(FIELDS)).known : [];
  const hint = (name: keyof typeof FIELDS, local: readonly string[]) => {
    const texts = [
      ...(tried ? local : []),
      ...serverFields.filter((entry) => entry.pattern === name).map((entry) => `Vom Server abgelehnt: ${describeFieldError(entry).text}`),
    ];
    return texts.length === 0 ? undefined : texts.join(' ');
  };
  const nameHint = hint(
    'displayName',
    problems.filter((p) => p === 'NAME_MISSING' || p === 'NAME_TOO_LONG').map((p) => ACCOUNT_PROBLEM_TEXTS[p]),
  );
  const ibanHint = hint(
    'iban',
    problems.filter((p) => p === 'IBAN_MISSING' || p === 'IBAN_INVALID').map((p) => ACCOUNT_PROBLEM_TEXTS[p]),
  );
  const typeHint = hint('accountType', []);
  const aria = (name: keyof typeof FIELDS, text: string | undefined, more: readonly string[] = []) => {
    const ids = [...more, ...(text === undefined ? [] : [`${FIELDS[name]}-fehler`])];
    return { 'aria-invalid': text !== undefined, ...(ids.length === 0 ? {} : { 'aria-describedby': ids.join(' ') }) };
  };
  const errorText = (name: keyof typeof FIELDS, text: string | undefined) =>
    text === undefined ? null : (
      <p id={`${FIELDS[name]}-fehler`} className="text-label text-danger-text">
        {text}
      </p>
    );

  return (
    <form aria-label="Konto anlegen" noValidate onSubmit={submit} className="flex flex-col gap-4">
      {refusal !== undefined && (
        <div ref={problem} tabIndex={-1}>
          <ErrorState error={refusal.error}>
            {accountRefusalText(refusal.error) !== undefined && <p className="mt-2">{accountRefusalText(refusal.error)}</p>}
            {refusal.retry && intent.current !== undefined && (
              <div className="mt-3 flex flex-wrap items-center gap-4">
                <p>
                  Ob das Konto angelegt wurde, ist unklar. „Erneut senden“ schickt dieselben Angaben mit demselben Schlüssel; das Konto entsteht nie doppelt.
                </p>
                <button type="button" className={secondaryButtonClass} disabled={sending} onClick={send}>
                  Erneut senden
                </button>
              </div>
            )}
          </ErrorState>
        </div>
      )}
      <div className="flex flex-col gap-1">
        <label htmlFor={FIELDS.accountType} className="font-semibold">
          Kontoart
        </label>
        <select
          id={FIELDS.accountType}
          className={inputClass}
          value={accountType}
          disabled={sending}
          onChange={(event) => change(() => setAccountType(ACCOUNT_TYPES.find((t) => t.code === event.target.value)?.code ?? 'BANK'))}
          {...aria('accountType', typeHint)}
        >
          {ACCOUNT_TYPES.map((type) => (
            <option key={type.code} value={type.code}>
              {type.label}
            </option>
          ))}
        </select>
        {errorText('accountType', typeHint)}
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor={FIELDS.displayName} className="font-semibold">
          Name
        </label>
        <input
          id={FIELDS.displayName}
          type="text"
          autoComplete="off"
          className={inputClass}
          value={displayName}
          readOnly={sending}
          onChange={(event) => change(() => setDisplayName(event.target.value))}
          {...aria('displayName', nameHint)}
        />
        {errorText('displayName', nameHint)}
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor={FIELDS.iban} className="font-semibold">
          {required ? 'IBAN' : 'IBAN (optional)'}
        </label>
        <input
          id={FIELDS.iban}
          type="text"
          autoComplete="off"
          spellCheck={false}
          className={`${inputClass} font-mono`}
          value={iban}
          readOnly={sending}
          onChange={(event) => change(() => setIban(event.target.value))}
          {...aria('iban', ibanHint, ['konto-iban-info'])}
        />
        <p id="konto-iban-info" className="text-label text-muted">
          {required
            ? 'Pflicht für ein Bankkonto: der Import mit der Vorlage „VR-Banking“ prüft die IBAN der Datei gegen das Konto. Eine IBAN lässt sich später nicht nachtragen.'
            : 'Für eine Kasse oder ein Verrechnungskonto optional. Ohne IBAN ist kein Import mit der Vorlage „VR-Banking“ möglich, und eine IBAN lässt sich später nicht nachtragen.'}
        </p>
        {errorText('iban', ibanHint)}
      </div>
      <p className="text-muted">Währung: Euro (EUR), die einzige, die das Cockpit führt.</p>
      {sending && <p role="status">Konto wird angelegt …</p>}
      <div>
        <button type="submit" className={buttonClass} disabled={sending}>
          {sending ? 'Konto wird angelegt …' : 'Konto anlegen'}
        </button>
      </div>
    </form>
  );
}
