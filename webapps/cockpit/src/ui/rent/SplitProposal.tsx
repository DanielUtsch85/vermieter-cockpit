import { useQueries, type QueryKey } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { ApiError } from '../../api/errors';
import type { RentSplitProposalDto, RentTermRef } from '../../api/rent-reconciliations';
import { formatMoney } from '../../format/money';
import { checkTenantId, checkTermKey, combineProposals, draftFromProposal, sameTerm, type TenantIdProblem, type TermProblem } from '../../rent/split-proposal';
import { addCents, decimalToCents, differenceAsDecimal } from '../../transactions/split-amount';
import { splitsEditable } from '../../transactions/split-draft';
import { MoneyText } from '../format';
import { ErrorState, LoadingState, Notice, secondaryButtonClass } from '../states';
import { IdText } from '../IdText';
import type { DraftSlot } from '../transactions/SplitEditor';
import { inputClass } from '../transactions/SplitRows';
import { categoryName, type References } from '../transactions/references';
import { rentRefusalText } from './rent-labels';
import { TenantText, TermText } from './RentParts';

const INPUT_TEXTS: Readonly<Record<TenantIdProblem | TermProblem | 'DUPLICATE', string>> = {
  TENANT_MISSING: 'Bitte die ID des Mieters in MRE angeben.',
  TENANT_INVALID: 'Eine MRE-ID hat 24 Zeichen 0–9 und a–f (Kleinbuchstaben).',
  TERM_MISSING: 'Bitte den Miettermin angeben.',
  TERM_INVALID: 'Ein Miettermin ist der MRE-Schlüssel JJJJMMTTHH mit gültigem Datum, z. B. 2026100100.',
  DUPLICATE: 'Dieser Termin dieses Mieters ist schon gewählt.',
};

const money = (amount: string, currency: string) => <MoneyText money={{ amount, currency }} />;

/** A proposal's flags (api-design.md §37.6) in German; an unknown one with its code, never dropped (§7.4). */
function FlagText({ flag, currency }: { readonly flag: RentSplitProposalDto['flags'][number]; readonly currency: string }) {
  if (flag.code === 'AMOUNT_DIFFERS_FROM_TERM' && 'details' in flag && 'difference' in flag.details) {
    const difference = flag.details.difference.amount;
    const under = difference.startsWith('-');
    return (
      <>
        {`Die Zahlung liegt ${formatMoney({ amount: under ? difference.slice(1) : difference, currency }) ?? difference} ${under ? 'unter' : 'über'} dem Sollbetrag dieses Termins `}
        {under ? '(Teilzahlung).' : '(Überzahlung, oder eine Sammelzahlung für mehrere Termine).'}
      </>
    );
  }
  if (flag.code === 'TERM_HAS_ADJUSTMENTS' && 'details' in flag && 'adjustments' in flag.details) {
    return (
      <>
        {'Der Termin hat in MRE Anpassungen (Schulden, Nachlässe, Umsatzsteuer) von '}
        <MoneyText money={flag.details.adjustments} />
        {'. Sie werden nicht aufgeteilt; ein Anteil der Zahlung dafür bleibt als Rest stehen.'}
      </>
    );
  }
  if (flag.code === 'ALREADY_SPLIT') return <>Die Buchung ist schon aufgeteilt; der Vorschlag beachtet die gespeicherte Aufteilung nicht.</>;
  return (
    <>
      {'Hinweis des Servers '}
      <IdText id={flag.code} />
    </>
  );
}

/** One chosen term: what MRE says about it (the source of the proposal), or why it could not be read. */
function TermCard(props: {
  readonly term: RentTermRef;
  readonly read: { readonly status: string; readonly data: RentSplitProposalDto | undefined; readonly error: unknown };
  readonly currency: string;
  readonly onRemove: () => void;
  readonly removeDisabled: boolean;
}) {
  const { term, read } = props;
  const p = read.data;
  return (
    <li className="flex flex-col gap-2 rounded-card border border-border p-4">
      <p>
        <TenantText id={term.mreTenantId} /> · <TermText term={term.mreRentTerm} />
      </p>
      {read.status === 'pending' ? (
        <LoadingState label="Vorschlag wird aus MRE gelesen …" />
      ) : read.status === 'error' || p === undefined ? (
        <ErrorState error={read.error}>{rentRefusalText(read.error) !== undefined && <p className="mt-2">{rentRefusalText(read.error)}</p>}</ErrorState>
      ) : (
        <>
          <p className="text-label text-muted">
            Quelle: Mietvertrag in MRE (aktuelle Werte für diesen Termin) und Sollbetrag des Termins in MRE. Nur Beträge; Namen liest DE nicht.
          </p>
          <dl className="grid gap-x-4 sm:grid-cols-[16rem_1fr]">
            <dt className="text-muted">Kaltmiete laut Mietvertrag</dt>
            <dd>{money(p.term.rent.amount, p.term.rent.currency)}</dd>
            <dt className="text-muted">Nebenkosten laut Mietvertrag</dt>
            <dd>{money(p.term.charges.amount, p.term.charges.currency)}</dd>
            <dt className="text-muted">Anpassungen des Termins</dt>
            <dd>{money(p.term.adjustments.amount, p.term.adjustments.currency)}</dd>
            <dt className="text-muted">Sollbetrag des Termins (MRE)</dt>
            <dd>{money(p.term.due.amount, p.term.due.currency)}</dd>
          </dl>
          {p.flags.length > 0 && (
            <ul aria-label="Hinweise zum Termin" className="list-disc pl-6">
              {p.flags.map((flag, i) => (
                <li key={i}>
                  <FlagText flag={flag} currency={props.currency} />
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      <div>
        <button type="button" className={secondaryButtonClass} disabled={props.removeDisabled} onClick={props.onRemove}>
          Termin entfernen
        </button>
      </div>
    </li>
  );
}

/**
 * Step 8 (Entscheidung des Projektinhabers, 2026-11-11; ui-guide.md §6.6 steps 2 and 3, api-design.md §37.6): the split
 * proposal for an unconfirmed inflow. The user names one or more MRE terms by the Tenant's MRE id and the term key (no
 * Tenant names: Entscheidung des Projektinhabers, 2026-11-11); each is read with `GET …/split-proposal` and shown with its
 * source. Several terms make a collective payment (several months or Tenants); the combined lines never exceed the
 * payment and a remainder is shown and taken over as its own row without a category. „Vorschlag in Aufteilung
 * übernehmen“ fills the split editor's draft only: nothing is saved until „Aufteilung speichern“, nothing is confirmed,
 * matched or written to MRE (§6.6: three separate confirmations, no „Alles erledigen“). The block starts collapsed, its
 * first sentence as the summary (Issue #353 des Projektinhabers, 2026-11-12, point 9).
 */
export function SplitProposal(props: {
  readonly references: References;
  readonly slot: DraftSlot;
  readonly load: (term: RentTermRef, signal: AbortSignal) => Promise<RentSplitProposalDto>;
  /** The cache key of one term's proposal for the Transaction in this version (`rentKeys.proposal`). */
  readonly queryKey: (term: RentTermRef, version: number) => QueryKey;
}) {
  const t = props.slot.transaction;
  const [tenant, setTenant] = useState('');
  const [termKey, setTermKey] = useState('');
  const [tried, setTried] = useState(false);
  const [terms, setTerms] = useState<readonly RentTermRef[]>([]);
  /** The version the proposal was taken over at: the note goes once the draft is saved (a new version). */
  const [applied, setApplied] = useState<number | undefined>(undefined);
  const reads = useQueries({
    queries: terms.map((term) => ({
      queryKey: props.queryKey(term, props.slot.transaction.version),
      queryFn: ({ signal }: { signal: AbortSignal }) => props.load(term, signal),
    })),
  });
  if (t.direction !== 'INFLOW' || !splitsEditable(t.status)) return null;

  const currency = t.amount.currency;
  const candidate = { mreTenantId: tenant.trim(), mreRentTerm: termKey.trim() };
  const tenantProblem = checkTenantId(tenant);
  const termProblem = checkTermKey(termKey);
  const duplicate = tenantProblem === undefined && termProblem === undefined && terms.some((term) => sameTerm(term, candidate));
  const add = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setTried(true);
    if (tenantProblem !== undefined || termProblem !== undefined || duplicate) return;
    // Two submits in one event batch see the same state: the list itself refuses the second (one read per term).
    setTerms((current) => (current.some((term) => sameTerm(term, candidate)) ? current : [...current, candidate]));
    setTermKey('');
    setTried(false);
    setApplied(undefined);
  };
  const remove = (index: number) => {
    setTerms((current) => current.filter((_, i) => i !== index));
    setApplied(undefined);
  };

  const loaded = reads.every((read) => read.status === 'success') ? reads.flatMap((read) => (read.data === undefined ? [] : [read.data])) : undefined;
  const combined = loaded === undefined || loaded.length === 0 ? undefined : combineProposals(t.amount, loaded);
  const dues = loaded?.reduce<string | undefined>((sum, p) => {
    const cents = p.term.due.currency === currency ? decimalToCents(p.term.due.amount) : undefined;
    return sum === undefined || cents === undefined ? undefined : addCents(sum, cents);
  }, '0');
  const paid = decimalToCents(t.amount.amount);
  const versusDue = dues === undefined || paid === undefined ? undefined : differenceAsDecimal(paid, dues);
  const draft = combined === undefined ? undefined : draftFromProposal(combined, () => '');
  const apply = () => {
    if (combined === undefined) return;
    props.slot.apply((newKey) => draftFromProposal(combined, newKey));
    setApplied(t.version);
  };
  const hint = (id: string, problem: string | undefined) =>
    tried && problem !== undefined ? (
      <p id={id} className="text-label text-danger-text">
        {problem}
      </p>
    ) : null;
  const tenantText = tenantProblem === undefined ? undefined : INPUT_TEXTS[tenantProblem];
  const termText = termProblem === undefined ? (duplicate ? INPUT_TEXTS.DUPLICATE : undefined) : INPUT_TEXTS[termProblem];

  return (
    <section aria-labelledby="aufteilungsvorschlag" className="flex flex-col gap-2 rounded-card border border-border p-4">
      <h3 id="aufteilungsvorschlag" className="font-semibold">
        Aufteilungsvorschlag aus MRE
      </h3>
      <details>
        <summary className="min-h-touch cursor-pointer py-2 text-muted">
          Für einen Mieteingang: Mieter und Miettermin in MRE wählen, bei einer Sammelzahlung mehrere.
        </summary>
        <div className="flex flex-col gap-3">
          <p className="text-muted">
            DE liest die Beträge des Mietvertrags aus MRE und schlägt Kaltmiete und Nebenkosten vor. Übernommen wird nur in den Entwurf; gespeichert wird erst
            mit „Aufteilung speichern“. Das ist weder „Buchung bestätigen“ noch eine Mietzuordnung noch eine Übertragung an MRE.
          </p>
          <form aria-label="Termin für den Vorschlag wählen" noValidate onSubmit={add} className="flex flex-wrap items-end gap-4">
            <div className="flex flex-col gap-1">
              <label htmlFor="vorschlag-mieter" className="text-label text-muted">
                Mieter in MRE (ID)
              </label>
              <input
                id="vorschlag-mieter"
                className={`${inputClass} font-mono`}
                value={tenant}
                spellCheck={false}
                aria-invalid={tried && tenantText !== undefined}
                aria-describedby={tried && tenantText !== undefined ? 'vorschlag-mieter-hinweis' : undefined}
                onChange={(event) => setTenant(event.target.value)}
              />
              {hint('vorschlag-mieter-hinweis', tenantText)}
            </div>
            <div className="flex flex-col gap-1">
              <label htmlFor="vorschlag-termin" className="text-label text-muted">
                Miettermin (MRE-Schlüssel JJJJMMTTHH)
              </label>
              <input
                id="vorschlag-termin"
                className={`${inputClass} font-mono`}
                value={termKey}
                inputMode="numeric"
                aria-invalid={tried && termText !== undefined}
                aria-describedby={['vorschlag-termin-format', tried && termText !== undefined ? 'vorschlag-termin-hinweis' : undefined]
                  .filter(Boolean)
                  .join(' ')}
                onChange={(event) => setTermKey(event.target.value)}
              />
              <p id="vorschlag-termin-format" className="text-label text-muted">
                Monatstermine enden in MRE auf 0100, z. B. 2026100100 für Oktober 2026.
              </p>
              {hint('vorschlag-termin-hinweis', termText)}
            </div>
            <button type="submit" className={secondaryButtonClass} disabled={props.slot.disabled}>
              Vorschlag laden
            </button>
          </form>
          {terms.length > 0 && (
            <ul aria-label="Gewählte Termine" className="flex flex-col gap-2">
              {terms.map((term, index) => {
                const read = reads[index];
                return (
                  <TermCard
                    key={`${term.mreTenantId}/${term.mreRentTerm}`}
                    term={term}
                    read={{ status: read?.status ?? 'pending', data: read?.data, error: read?.error }}
                    currency={currency}
                    removeDisabled={props.slot.disabled}
                    onRemove={() => remove(index)}
                  />
                );
              })}
            </ul>
          )}
          {combined !== undefined && (
            <div className="flex flex-col gap-2">
              <table className="w-full text-left">
                <caption className="text-left font-semibold">Vorgeschlagene Aufteilung</caption>
                <thead className="border-b border-border text-label text-muted">
                  <tr>
                    <th scope="col" className="p-2">
                      Kategorie
                    </th>
                    <th scope="col" className="p-2 text-right">
                      Betrag
                    </th>
                    <th scope="col" className="p-2">
                      Termin
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {combined.lines.map((line, i) => (
                    <tr key={i}>
                      <td className="p-2">
                        <IdText
                          name={categoryName(props.references, line.financialCategoryCode)}
                          id={line.financialCategoryCode}
                          missing="Unbekannte Kategorie"
                        />
                      </td>
                      <td className="p-2 text-right">
                        {money(line.amount, currency)}
                        {line.cut && <span className="block text-label text-muted">gekürzt auf den Rest der Zahlung</span>}
                      </td>
                      <td className="p-2">
                        <TenantText id={line.source.mreTenantId} /> · <TermText term={line.source.mreRentTerm} />
                      </td>
                    </tr>
                  ))}
                  <tr>
                    <td className="p-2 font-semibold">Nicht zugeordneter Rest</td>
                    <td className="p-2 text-right font-semibold">{money(combined.remainder, currency)}</td>
                    <td className="p-2 text-muted">
                      {combined.remainder === '0.00'
                        ? 'Die Teilbeträge decken die Zahlung genau.'
                        : 'Wird als eigene Zeile ohne Kategorie übernommen; bitte selbst zuordnen.'}
                    </td>
                  </tr>
                </tbody>
              </table>
              {versusDue !== undefined && (
                <p>
                  {`Zahlung ${formatMoney(t.amount) ?? t.amount.amount} gegenüber der Summe der Sollbeträge (MRE) ${formatMoney({ amount: differenceAsDecimal(dues ?? '0', '0'), currency }) ?? ''}: `}
                  {versusDue === '0.00'
                    ? 'deckt sie genau.'
                    : versusDue.startsWith('-')
                      ? `${formatMoney({ amount: versusDue.slice(1), currency }) ?? versusDue} weniger (Teilzahlung).`
                      : `${formatMoney({ amount: versusDue, currency }) ?? versusDue} mehr (Überzahlung).`}
                </p>
              )}
              {draft === undefined ? (
                <Notice tone="warning">Der Vorschlag enthält keinen übernehmbaren Teilbetrag (oder mehr als 100 Zeilen).</Notice>
              ) : (
                <div className="flex flex-wrap items-center gap-4">
                  <button type="button" className={secondaryButtonClass} disabled={props.slot.disabled} onClick={apply}>
                    Vorschlag in Aufteilung übernehmen
                  </button>
                  <span className="text-label text-muted">Ersetzt den Entwurf unten; „Entwurf verwerfen“ stellt die gespeicherte Aufteilung wieder her.</span>
                </div>
              )}
            </div>
          )}
          {loaded === undefined && reads.some((read) => read.status === 'error') && (
            <p className="text-muted">Übernehmen erst, wenn jeder gewählte Termin gelesen ist; einen nicht lesbaren Termin bitte entfernen.</p>
          )}
          {applied === t.version && (
            <div role="status">
              <Notice tone="info">Vorschlag in den Entwurf übernommen. Noch ist nichts gespeichert: „Aufteilung speichern“ sendet die Aufteilung.</Notice>
            </div>
          )}
          {reads.some((read) => read.error instanceof ApiError && read.error.status === 503) && (
            <p className="text-muted">MRE war nicht erreichbar; der Vorschlag kann später erneut geladen werden (Termin entfernen und neu wählen).</p>
          )}
        </div>
      </details>
    </section>
  );
}
