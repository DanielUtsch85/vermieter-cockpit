// @vitest-environment jsdom
import { QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { createDeClient } from '../../api/client';
import { countingTokens, envelope, json, routedFetch, type Call } from '../../api/fetch.test-support';
import { createReconciliation, getTenantTerms, listRentTenants } from '../../api/rent-reconciliations';
import { createQueryClient } from '../../query';
import { confirmed, rentTenant, splitProposal, TENANT, TENANT_2, TERM, TERM_2, tenantTerms, transactionCoverage } from '../../rent/fixtures.test-support';
import { category, detail, page, property, REALM_A, TX } from '../../transactions/fixtures.test-support';
import { TransactionsArea } from '../transactions/TransactionsArea';
import { rentKeys } from './rent-keys';
import { TransactionRentSection } from './TransactionRent';

/**
 * #364 (api-design.md §37.7; Entscheidung des Projektinhabers, 2026-11-16): the Tenant and the term chosen from lists in
 * „Aufteilungsvorschlag aus MRE“ and „Manuell zuordnen“, without typing an id or a key; the typed id and key stay
 * possible. jsdom with `fireEvent` only, the real client to a routed fetch, synthetic ids and amounts only.
 */
const TENANTS = 'GET /api/v1/rent-reconciliations/tenants';
const TERMS = `GET /api/v1/rent-reconciliations/terms/${TENANT}`;
const TERMS_2 = `GET /api/v1/rent-reconciliations/terms/${TENANT_2}`;
const PROPOSAL = 'GET /api/v1/rent-reconciliations/split-proposal';
const EUR = (amount: string) => ({ amount, currency: 'EUR' });
const NBSP = '\u00a0';
const url = (call: Call) => new URL(call.url, 'https://cockpit.internal');
const routeOf = (call: Call) => `${call.method} ${url(call).pathname}`;
const reads = (calls: readonly Call[], route: string) =>
  calls.filter((call) => routeOf(call) === route).map((call) => Object.fromEntries(url(call).searchParams));
const select = (label: string) => screen.getByLabelText<HTMLSelectElement>(label);
const input = (label: string) => screen.getByLabelText<HTMLInputElement>(label);
const pick = (label: string, value: string) => fireEvent.change(select(label), { target: { value } });
const click = (name: string | RegExp) => fireEvent.click(screen.getByRole('button', { name }));
const optionTexts = (label: string) => Array.from(select(label).options).map((o) => o.textContent);
const WINDOW = { from: '2026-01', to: '2026-04' };

/** „Manuell zuordnen“ of a counted inflow of 2 March 2026 with the lists, 550,00 € free. */
function manual() {
  const { fetch, calls } = routedFetch({
    [TENANTS]: [() => json(200, page([rentTenant()]))],
    [TERMS]: [() => json(200, tenantTerms())],
    'POST /api/v1/rent-reconciliations': [
      () => json(201, confirmed('550.00', { mreRentTerm: TERM, confidence: null, suggestionReason: null }), { etag: '"1"' }),
    ],
  });
  const de = createDeClient({ tokens: countingTokens(), realmId: REALM_A, fetch });
  const source = {
    tenantsKey: rentKeys.tenants(REALM_A, 1),
    loadTenants: (signal: AbortSignal) => listRentTenants(de, signal),
    termsKey: (tenant: string, w: { from: string; to: string }) => rentKeys.tenantTerms(REALM_A, 1, tenant, w.from, w.to),
    loadTerms: (tenant: string, w: { from: string; to: string }, signal: AbortSignal) => getTenantTerms(de, tenant, w, signal),
  };
  render(
    <QueryClientProvider client={createQueryClient()}>
      <TransactionRentSection
        realmId={REALM_A}
        coverage={{ status: 'success', data: transactionCoverage({ matchedTotal: EUR('0.00'), available: EUR('550.00'), reconciliations: [] }) }}
        onRetry={() => undefined}
        create={(body, key) => createReconciliation(de, body, key)}
        choices={{ source, bookingDate: '2026-03-02' }}
      />
    </QueryClientProvider>,
  );
  return calls;
}

/** The Buchungen area on an unconfirmed inflow of 1 March 2026 (`detail()`), with the proposal's routes. */
function area(routes: Record<string, (() => Response)[]>) {
  const { fetch, calls } = routedFetch({
    'GET /api/v1/financial-accounts': [() => json(200, page([]))],
    'GET /api/v1/property-references': [() => json(200, page([property()]))],
    'GET /api/v1/financial-categories': [() => json(200, { items: [category(), category({ code: 'RENT_OPERATING_COST_ADVANCE', name: 'Nebenkosten' })] })],
    [`GET /api/v1/transactions/${TX}`]: [() => json(200, detail({ amount: EUR('850.00'), version: 3 }), { etag: '"3"' })],
    ...routes,
  });
  const client = createDeClient({ tokens: countingTokens(), realmId: REALM_A, fetch });
  render(
    <QueryClientProvider client={createQueryClient()}>
      <TransactionsArea client={client} realmId={REALM_A} epoch={1} transactionId={TX} search="" />
    </QueryClientProvider>,
  );
  return calls;
}

async function openProposal() {
  const region = await screen.findByRole('region', { name: 'Aufteilungsvorschlag aus MRE' });
  fireEvent.click(within(region).getByText(/^Für einen Mieteingang/));
  return region;
}

afterEach(cleanup);

describe('Aufteilungsvorschlag aus MRE: Tenant and term from the lists (#364)', () => {
  it('the Tenant from the list and the term from its list fill the fields; the proposal is read for them; nothing typed, nothing sent', async () => {
    const calls = area({
      [TENANTS]: [() => json(200, page([rentTenant(), rentTenant({ mreTenantId: TENANT_2, reconciliationCount: 1 })], { pageSize: 200 }))],
      [TERMS]: [() => json(200, tenantTerms())],
      [PROPOSAL]: [() => json(200, splitProposal({ amount: '850.00' }))],
    });
    await openProposal();
    await waitFor(() => expect(optionTexts('Mieter aus bisherigen Zuordnungen')).toHaveLength(3));
    expect(optionTexts('Mieter aus bisherigen Zuordnungen')).toEqual([
      'Bitte wählen',
      `${TENANT} · zuletzt Termin 01.03.2026 · 2 Zuordnungen`,
      `${TENANT_2} · zuletzt Termin 01.03.2026 · 1 Zuordnung`,
    ]);
    expect(select('Miettermin aus MRE').disabled).toBe(true);
    pick('Mieter aus bisherigen Zuordnungen', TENANT);
    expect(input('Mieter in MRE (ID)').value).toBe(TENANT);
    await waitFor(() => expect(select('Miettermin aus MRE').disabled).toBe(false));
    // The window: the second month before the booking (1 March 2026) to the month after.
    expect(reads(calls, TERMS)).toEqual([WINDOW]);
    expect(screen.getByText(/Termine von 01\.2026 bis 04\.2026, um das Buchungsdatum\./)).toBeTruthy();
    expect(optionTexts('Miettermin aus MRE')).toEqual([
      'Bitte wählen',
      `Termin 01.04.2026 (${TERM_2}) · Soll 850,00${NBSP}€ · offen 850,00${NBSP}€`,
      `Termin 01.03.2026 (${TERM}) · Soll 850,00${NBSP}€ · offen 550,00${NBSP}€`,
    ]);
    pick('Miettermin aus MRE', TERM);
    expect(input('Miettermin (MRE-Schlüssel JJJJMMTTHH)').value).toBe(TERM);
    click('Vorschlag laden');
    await screen.findByText('Sollbetrag des Termins (MRE)');
    expect(reads(calls, PROPOSAL)).toEqual([{ transactionId: TX, mreTenantId: TENANT, mreRentTerm: TERM }]);
    expect(reads(calls, TENANTS)).toEqual([{ page: '1', pageSize: '200' }]);
    expect(calls.filter((call) => call.method !== 'GET')).toEqual([]);
  });

  it('another Tenant from the list clears the term chosen for the first', async () => {
    area({
      [TENANTS]: [() => json(200, page([rentTenant(), rentTenant({ mreTenantId: TENANT_2 })]))],
      [TERMS]: [() => json(200, tenantTerms())],
      [TERMS_2]: [() => json(200, tenantTerms({ mreTenantId: TENANT_2 }))],
    });
    await openProposal();
    await waitFor(() => expect(optionTexts('Mieter aus bisherigen Zuordnungen')).toHaveLength(3));
    pick('Mieter aus bisherigen Zuordnungen', TENANT);
    await waitFor(() => expect(select('Miettermin aus MRE').disabled).toBe(false));
    pick('Miettermin aus MRE', TERM);
    pick('Mieter aus bisherigen Zuordnungen', TENANT_2);
    expect([input('Mieter in MRE (ID)').value, input('Miettermin (MRE-Schlüssel JJJJMMTTHH)').value]).toEqual([TENANT_2, '']);
  });

  it('another Tenant id typed in the field also clears the term chosen for the first; the same id kept keeps it (#375 review)', async () => {
    area({
      [TENANTS]: [() => json(200, page([rentTenant()]))],
      [TERMS]: [() => json(200, tenantTerms())],
    });
    await openProposal();
    await waitFor(() => expect(optionTexts('Mieter aus bisherigen Zuordnungen')).toHaveLength(2));
    pick('Mieter aus bisherigen Zuordnungen', TENANT);
    await waitFor(() => expect(select('Miettermin aus MRE').disabled).toBe(false));
    pick('Miettermin aus MRE', TERM);
    // Only spaces around the same id: still this Tenant, the term stays.
    fireEvent.change(input('Mieter in MRE (ID)'), { target: { value: ` ${TENANT} ` } });
    expect(input('Miettermin (MRE-Schlüssel JJJJMMTTHH)').value).toBe(TERM);
    fireEvent.change(input('Mieter in MRE (ID)'), { target: { value: TENANT_2 } });
    expect([input('Mieter in MRE (ID)').value, input('Miettermin (MRE-Schlüssel JJJJMMTTHH)').value]).toEqual([TENANT_2, '']);
  });

  it('more Tenants than the list holds: the note says how many of how many and to type the others; a full list says nothing of it', async () => {
    const many = Array.from({ length: 200 }, (_, i) => rentTenant({ mreTenantId: `6512f0c2a1b2c3d4e5f6${i.toString(16).padStart(4, '0')}` }));
    area({ [TENANTS]: [() => json(200, page(many, { pageSize: 200, total: 201 }))] });
    await openProposal();
    await screen.findByText('Die 200 zuletzt zugeordneten von 201 Mietern, nur mit MRE-ID. Andere bitte unten eintippen.');
    expect(optionTexts('Mieter aus bisherigen Zuordnungen')).toHaveLength(201);
    cleanup();
    area({ [TENANTS]: [() => json(200, page(many, { pageSize: 200, total: 200 }))] });
    await openProposal();
    await screen.findByText('Nur mit MRE-ID, ohne Namen. Ein Mieter ohne bisherige Zuordnung: die ID unten eintippen.');
    expect(screen.queryByText(/zuletzt zugeordneten von/)).toBeNull();
  });

  it('a Tenant without an earlier match: the list is empty and says so, the typed id gets its terms', async () => {
    const calls = area({
      [TENANTS]: [() => json(200, page([]))],
      [`GET /api/v1/rent-reconciliations/terms/${TENANT_2}`]: [() => json(200, tenantTerms({ mreTenantId: TENANT_2 }))],
    });
    await openProposal();
    await screen.findByText('Noch keine Zuordnung in diesem Bestand: die MRE-ID des Mieters bitte unten eintippen.');
    expect(select('Mieter aus bisherigen Zuordnungen').disabled).toBe(true);
    // A half-typed id asks nothing.
    fireEvent.change(input('Mieter in MRE (ID)'), { target: { value: TENANT_2.slice(0, 10) } });
    expect(screen.getByText(/Erst den Mieter wählen oder seine ID eintippen\./)).toBeTruthy();
    fireEvent.change(input('Mieter in MRE (ID)'), { target: { value: TENANT_2 } });
    await waitFor(() => expect(select('Miettermin aus MRE').disabled).toBe(false));
    expect(reads(calls, `GET /api/v1/rent-reconciliations/terms/${TENANT_2}`)).toEqual([WINDOW]);
    pick('Miettermin aus MRE', TERM_2);
    expect(input('Miettermin (MRE-Schlüssel JJJJMMTTHH)').value).toBe(TERM_2);
  });

  it('MRE not reachable or the Tenant not listed: the note says so; only DE terms; the typed key still works', async () => {
    const [, march] = tenantTerms().items;
    if (march === undefined) throw new Error('fixture');
    const deOnly = { ...march, inMre: null, amountDue: null, coverage: null, openAmount: null };
    area({
      [TENANTS]: [() => json(200, page([rentTenant()]))],
      [TERMS]: [() => json(200, tenantTerms({ mreStatus: 'UNAVAILABLE', items: [deOnly] }))],
    });
    await openProposal();
    await waitFor(() => expect(optionTexts('Mieter aus bisherigen Zuordnungen')).toHaveLength(2));
    pick('Mieter aus bisherigen Zuordnungen', TENANT);
    await screen.findByText(/MRE war nicht erreichbar\. Gezeigt sind nur die Zuordnungen in DE/);
    expect(optionTexts('Miettermin aus MRE')).toEqual(['Bitte wählen', `Termin 01.03.2026 (${TERM}) · zugeordnet 300,00${NBSP}€`]);
    fireEvent.change(input('Miettermin (MRE-Schlüssel JJJJMMTTHH)'), { target: { value: TERM_2 } });
    expect(select('Miettermin aus MRE').value).toBe('');
  });

  it('a list that cannot be read: the fields stay and say how to go on', async () => {
    area({
      [TENANTS]: [() => envelope(503, 'EXTERNAL_SYSTEM_ERROR')],
      [TERMS]: [() => envelope(500, 'INTERNAL_ERROR')],
    });
    await openProposal();
    await screen.findByText('Die Mieter konnten nicht gelesen werden; die ID bitte unten eintippen.');
    fireEvent.change(input('Mieter in MRE (ID)'), { target: { value: TENANT } });
    await screen.findByText(/Die Termine konnten nicht gelesen werden; der Terminschlüssel kann unten eingetippt werden\./);
    expect(input('Miettermin (MRE-Schlüssel JJJJMMTTHH)').disabled).toBe(false);
  });
});

describe('Manuell zuordnen: Tenant and term from the lists (#364)', () => {
  it('chosen, not typed; the confirmation names them and locks the lists; one POST with exactly them', async () => {
    const calls = manual();
    click('Manuell zuordnen');
    await waitFor(() => expect(optionTexts('Mieter aus bisherigen Zuordnungen')).toHaveLength(2));
    pick('Mieter aus bisherigen Zuordnungen', TENANT);
    await waitFor(() => expect(select('Miettermin aus MRE').disabled).toBe(false));
    pick('Miettermin aus MRE', TERM);
    click('Zuordnung anlegen');
    const dialog = screen.getByRole('dialog', { name: 'Zahlung jetzt manuell zuordnen?' });
    expect(dialog.textContent).toContain(TENANT);
    expect(dialog.textContent).toContain(`01.03.2026 (${TERM})`);
    expect([select('Mieter aus bisherigen Zuordnungen').disabled, select('Miettermin aus MRE').disabled]).toEqual([true, true]);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Jetzt zuordnen' }));
    await screen.findByText(/Manuell zugeordnet/);
    const posts = calls.filter((call) => call.method === 'POST');
    expect(posts.map((call) => JSON.parse(call.body ?? '{}') as unknown)).toEqual([
      { transactionId: TX, mreTenantId: TENANT, mreRentTerm: TERM, matchedAmount: EUR('550.00') },
    ]);
  });

  it('another Tenant id typed in the field clears the term chosen from the list; the same id with spaces keeps it (#375, #376 review)', async () => {
    manual();
    click('Manuell zuordnen');
    await waitFor(() => expect(optionTexts('Mieter aus bisherigen Zuordnungen')).toHaveLength(2));
    pick('Mieter aus bisherigen Zuordnungen', TENANT);
    await waitFor(() => expect(select('Miettermin aus MRE').disabled).toBe(false));
    pick('Miettermin aus MRE', TERM);
    expect(input('Miettermin (MRE-Schlüssel JJJJMMTTHH)').value).toBe(TERM);
    // Only spaces around the same id: still this Tenant, the term stays.
    fireEvent.change(input('Mieter in MRE (ID)'), { target: { value: ` ${TENANT} ` } });
    expect(input('Miettermin (MRE-Schlüssel JJJJMMTTHH)').value).toBe(TERM);
    fireEvent.change(input('Mieter in MRE (ID)'), { target: { value: TENANT_2 } });
    expect([input('Mieter in MRE (ID)').value, input('Miettermin (MRE-Schlüssel JJJJMMTTHH)').value]).toEqual([TENANT_2, '']);
  });
});
