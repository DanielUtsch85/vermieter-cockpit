import { useQuery, type QueryKey } from '@tanstack/react-query';
import type { PageDto } from '@vermieter-cockpit/de-backend/client-contract';
import type { RentTenantDto, TenantTermsDto, TermWindow } from '../../api/rent-reconciliations';
import { checkTenantId } from '../../rent/split-proposal';
import { monthText, tenantOptionText, termListNote, termOptionText, termWindow } from '../../rent/term-choice';
import { inputClass } from '../transactions/SplitRows';

/** Where the two lists come from: `GET …/tenants` and `GET …/terms/{mreTenantId}?from&to` (api-design.md §37.7). */
export interface RentChoiceSource {
  readonly tenantsKey: QueryKey;
  readonly loadTenants: (signal: AbortSignal) => Promise<PageDto<RentTenantDto>>;
  readonly termsKey: (mreTenantId: string, window: TermWindow) => QueryKey;
  readonly loadTerms: (mreTenantId: string, window: TermWindow, signal: AbortSignal) => Promise<TenantTermsDto>;
}

/** The lists and the booking date their window is set around. */
export interface RentChoices {
  readonly source: RentChoiceSource;
  /** The Transaction's booking date (`YYYY-MM-DD`). */
  readonly bookingDate: string;
}

const NOTE = 'text-label text-muted';

/**
 * Choosing the Tenant and the term from lists (#364; api-design.md §37.7; Entscheidung des Projektinhabers, 2026-11-16):
 * „Mieter aus bisherigen Zuordnungen“ lists the MRE ids of the Realm's reconciliations, without names; „Miettermin aus
 * MRE“ lists the chosen Tenant's terms from the second month before to the month after the booking. A choice only fills the
 * fields beside it (the MRE id and the term key), which stay editable: the id of a Tenant without an earlier match is
 * typed there, and so is a key outside the window or while MRE is not reachable. Nothing is sent by choosing.
 */
export function TenantTermChoice(props: {
  readonly choices: RentChoices;
  /** The prefix of the element ids, unique on the page. */
  readonly idPrefix: string;
  readonly tenant: string;
  readonly term: string;
  readonly onTenant: (mreTenantId: string) => void;
  readonly onTerm: (mreRentTerm: string) => void;
  readonly disabled: boolean;
}) {
  const { source, bookingDate } = props.choices;
  const tenants = useQuery({ queryKey: source.tenantsKey, queryFn: ({ signal }) => source.loadTenants(signal) });
  const tenant = props.tenant.trim();
  const months = termWindow(bookingDate);
  const tenantOk = checkTenantId(tenant) === undefined;
  const terms = useQuery({
    queryKey: months === undefined ? ['no-window'] : source.termsKey(tenant, months),
    queryFn: ({ signal }) => (months === undefined ? Promise.reject(new Error('No window.')) : source.loadTerms(tenant, months, signal)),
    enabled: tenantOk && months !== undefined,
  });
  const listed = tenants.data?.items ?? [];
  const items = tenantOk ? (terms.data?.items ?? []) : [];
  const tenantValue = listed.some((t) => t.mreTenantId === tenant) ? tenant : '';
  const termValue = items.some((i) => i.mreRentTerm === props.term.trim()) ? props.term.trim() : '';

  const tenantNote =
    tenants.status === 'pending'
      ? 'Mieter werden gelesen …'
      : tenants.status === 'error'
        ? 'Die Mieter konnten nicht gelesen werden; die ID bitte unten eintippen.'
        : listed.length === 0
          ? 'Noch keine Zuordnung in diesem Bestand: die MRE-ID des Mieters bitte unten eintippen.'
          : (tenants.data?.total ?? 0) > listed.length
            ? `Die ${listed.length} zuletzt zugeordneten von ${tenants.data?.total ?? 0} Mietern, nur mit MRE-ID. Andere bitte unten eintippen.`
            : 'Nur mit MRE-ID, ohne Namen. Ein Mieter ohne bisherige Zuordnung: die ID unten eintippen.';
  const termNote = !tenantOk
    ? 'Erst den Mieter wählen oder seine ID eintippen.'
    : terms.status === 'pending'
      ? 'Termine werden aus MRE gelesen …'
      : terms.status === 'error'
        ? 'Die Termine konnten nicht gelesen werden; der Terminschlüssel kann unten eingetippt werden.'
        : termListNote(terms.data);

  return (
    <div className="flex basis-full flex-wrap items-start gap-4">
      <div className="flex max-w-full flex-col gap-1">
        <label htmlFor={`${props.idPrefix}-mieter-liste`} className="text-label text-muted">
          Mieter aus bisherigen Zuordnungen
        </label>
        <select
          id={`${props.idPrefix}-mieter-liste`}
          className={`${inputClass} max-w-full font-mono`}
          value={tenantValue}
          disabled={props.disabled || listed.length === 0}
          aria-describedby={`${props.idPrefix}-mieter-liste-hinweis`}
          onChange={(event) => {
            if (event.target.value === '') return;
            props.onTenant(event.target.value);
            props.onTerm('');
          }}
        >
          <option value="">{listed.length === 0 ? 'Keine Liste' : 'Bitte wählen'}</option>
          {listed.map((t) => (
            <option key={t.mreTenantId} value={t.mreTenantId}>
              {tenantOptionText(t)}
            </option>
          ))}
        </select>
        <p id={`${props.idPrefix}-mieter-liste-hinweis`} className={NOTE}>
          {tenantNote}
        </p>
      </div>
      <div className="flex max-w-full flex-col gap-1">
        <label htmlFor={`${props.idPrefix}-termin-liste`} className="text-label text-muted">
          Miettermin aus MRE
        </label>
        <select
          id={`${props.idPrefix}-termin-liste`}
          className={`${inputClass} max-w-full`}
          value={termValue}
          disabled={props.disabled || items.length === 0}
          aria-describedby={`${props.idPrefix}-termin-liste-hinweis`}
          onChange={(event) => {
            if (event.target.value !== '') props.onTerm(event.target.value);
          }}
        >
          <option value="">{items.length === 0 ? 'Keine Liste' : 'Bitte wählen'}</option>
          {items.map((i) => (
            <option key={i.mreRentTerm} value={i.mreRentTerm}>
              {termOptionText(i)}
            </option>
          ))}
        </select>
        <p id={`${props.idPrefix}-termin-liste-hinweis`} className={NOTE}>
          {months === undefined
            ? 'Das Buchungsdatum ist nicht lesbar; den Terminschlüssel bitte unten eintippen.'
            : `Termine von ${monthText(months.from)} bis ${monthText(months.to)}, um das Buchungsdatum.`}
          {termNote === undefined ? '' : ` ${termNote}`}
        </p>
      </div>
    </div>
  );
}
