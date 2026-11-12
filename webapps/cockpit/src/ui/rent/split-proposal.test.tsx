// @vitest-environment jsdom
import { QueryClientProvider } from '@tanstack/react-query';
import { act as testingLibraryAct, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { createDeClient } from '../../api/client';
import { countingTokens, envelope, json, routedFetch, type Call } from '../../api/fetch.test-support';
import type { TransactionDetailDto } from '../../api/transactions';
import { createQueryClient } from '../../query';
import { splitProposal, TENANT, TENANT_2, TERM, TERM_2 } from '../../rent/fixtures.test-support';
import { category, detail, page, property, REALM_A, split, TX } from '../../transactions/fixtures.test-support';
import { TransactionsArea } from '../transactions/TransactionsArea';

/**
 * Step 8, the split proposal (Entscheidung des Projektinhabers, 2026-11-11; ui-guide.md §6.6 steps 2 and 3, §6.4): the
 * whole Buchungen area in jsdom with `fireEvent` only, the real client to a routed fetch, synthetic data only. The
 * proposal is read, shown with its source and taken over into the split editor's draft; nothing is saved before
 * „Aufteilung speichern“, nothing is confirmed, matched or written to MRE.
 */

const act = testingLibraryAct as unknown as (callback: () => void | Promise<void>) => Promise<void>;
const NBSP = ' ';
const DETAIL = `GET /api/v1/transactions/${TX}`;
const PROPOSAL = 'GET /api/v1/rent-reconciliations/split-proposal';
const PUT = `PUT /api/v1/transactions/${TX}/splits`;
const routeOf = (call: Call) => `${call.method} ${new URL(call.url, 'https://cockpit.internal').pathname}`;
const commands = (calls: readonly Call[]) => calls.filter((call) => call.method !== 'GET').map(routeOf);
const proposals = (calls: readonly Call[]) =>
  calls.filter((call) => routeOf(call) === PROPOSAL).map((call) => Object.fromEntries(new URL(call.url, 'https://cockpit.internal').searchParams));
const imported = (amount: string, overrides: Partial<TransactionDetailDto> = {}) =>
  json(200, detail({ amount: { amount, currency: 'EUR' }, version: 3, ...overrides }), { etag: '"3"' });

function area(routes: Record<string, (() => Response)[]>) {
  const { fetch, calls } = routedFetch({
    'GET /api/v1/financial-accounts': [() => json(200, page([]))],
    'GET /api/v1/property-references': [() => json(200, page([property()]))],
    'GET /api/v1/financial-categories': [() => json(200, { items: [category(), category({ code: 'RENT_OPERATING_COST_ADVANCE', name: 'Nebenkosten' })] })],
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

const type = (element: Element, value: string) => fireEvent.change(element, { target: { value } });
const click = (name: string | RegExp) => fireEvent.click(screen.getByRole('button', { name }));
const button = (name: string | RegExp) => screen.getByRole<HTMLButtonElement>('button', { name });
const control = (id: string) => document.getElementById(id) as HTMLInputElement & HTMLSelectElement;
const rows = () =>
  Array.from({ length: 20 }, (_, i) => control(`split-${i}-amount`))
    .filter((input) => input !== null)
    .map((input, i) => [control(`split-${i}-category`).value, input.value]);

async function choose(tenant: string, term: string) {
  type(await screen.findByLabelText('Mieter in MRE (ID)'), tenant);
  type(screen.getByLabelText('Miettermin (MRE-Schlüssel JJJJMMTTHH)'), term);
  click('Vorschlag laden');
}

afterEach(cleanup);

describe('the proposal starts collapsed (Issue #353 des Projektinhabers, 2026-11-12, point 9)', () => {
  it('a details block, closed, its first sentence as the summary; the heading stays visible as a section of the editor', async () => {
    area({ [DETAIL]: [() => imported('850.00')] });
    const region = await screen.findByRole('region', { name: 'Aufteilungsvorschlag aus MRE' });
    expect(within(region).getByRole('heading', { level: 3, name: 'Aufteilungsvorschlag aus MRE' })).toBeTruthy();
    const block = region.querySelector('details');
    expect(block?.open).toBe(false);
    expect(block?.querySelector('summary')?.textContent).toBe('Für einen Mieteingang: Mieter und Miettermin in MRE wählen, bei einer Sammelzahlung mehrere.');
    // The rest of the explanation and the form are inside the block, not in its summary.
    expect(block?.textContent).toContain('Das ist weder „Buchung bestätigen“ noch eine Mietzuordnung noch eine Übertragung an MRE.');
    expect(block?.querySelector('summary')?.textContent).not.toContain('Kaltmiete');
    expect(block?.contains(screen.getByRole('form', { name: 'Termin für den Vorschlag wählen' }))).toBe(true);
  });
});

describe('step 8: a collective payment for two months (§6.6 steps 2 and 3)', () => {
  it('both terms read and shown with their source; taken over into the draft only; the sum is the payment; saved only by the save', async () => {
    const saved = [
      split({ amount: { amount: '700.00', currency: 'EUR' }, propertyReferenceId: null }),
      split({ position: 2, financialCategoryCode: 'RENT_OPERATING_COST_ADVANCE', propertyReferenceId: null, amount: { amount: '150.00', currency: 'EUR' } }),
      split({ position: 3, amount: { amount: '700.00', currency: 'EUR' }, propertyReferenceId: null }),
      split({ position: 4, financialCategoryCode: 'RENT_OPERATING_COST_ADVANCE', propertyReferenceId: null, amount: { amount: '150.00', currency: 'EUR' } }),
    ];
    const calls = area({
      [DETAIL]: [() => imported('1700.00'), () => imported('1700.00', { status: 'CLASSIFIED', version: 4, splits: saved })],
      [PROPOSAL]: [
        () => json(200, splitProposal({ amount: '1700.00' })),
        () => json(200, splitProposal({ amount: '1700.00', term: TERM_2 })),
        () => json(200, splitProposal({ amount: '1700.00' }, { flags: [{ code: 'ALREADY_SPLIT' }] })),
        () => json(200, splitProposal({ amount: '1700.00', term: TERM_2 }, { flags: [{ code: 'ALREADY_SPLIT' }] })),
      ],
      [PUT]: [
        () =>
          json(
            200,
            { transactionId: TX, amount: { amount: '1700.00', currency: 'EUR' }, direction: 'INFLOW', status: 'CLASSIFIED', version: 4, splits: saved },
            { etag: '"4"' },
          ),
      ],
    });
    await choose(TENANT, TERM);
    await choose(TENANT, TERM_2);
    const cards = await screen.findByRole('list', { name: 'Gewählte Termine' });
    await waitFor(() => expect(within(cards).getAllByText('Sollbetrag des Termins (MRE)')).toHaveLength(2));
    expect(proposals(calls)).toEqual([
      { transactionId: TX, mreTenantId: TENANT, mreRentTerm: TERM },
      { transactionId: TX, mreTenantId: TENANT, mreRentTerm: TERM_2 },
    ]);
    expect(cards.textContent).toContain('Quelle: Mietvertrag in MRE');
    expect(cards.textContent).toContain(
      `Die Zahlung liegt 850,00${NBSP}€ über dem Sollbetrag dieses Termins (Überzahlung, oder eine Sammelzahlung für mehrere Termine).`,
    );
    // No name is ever shown or guessed: the Tenant only by its MRE id.
    expect(within(cards).getAllByText(TENANT)).toHaveLength(2);
    const table = screen.getByRole('table', { name: 'Vorgeschlagene Aufteilung' });
    expect(
      within(table)
        .getAllByRole('row')
        .slice(1)
        .map((row) => row.querySelectorAll('td')[1]?.textContent),
    ).toEqual([`700,00${NBSP}€`, `150,00${NBSP}€`, `700,00${NBSP}€`, `150,00${NBSP}€`, `0,00${NBSP}€`]);
    expect(screen.getByText(/gegenüber der Summe der Sollbeträge \(MRE\) 1\.700,00.€: deckt sie genau\./)).toBeTruthy();

    click('Vorschlag in Aufteilung übernehmen');
    expect(rows()).toEqual([
      ['RENT_BASE', '700,00'],
      ['RENT_OPERATING_COST_ADVANCE', '150,00'],
      ['RENT_BASE', '700,00'],
      ['RENT_OPERATING_COST_ADVANCE', '150,00'],
    ]);
    expect(screen.getByText(/Vorschlag in den Entwurf übernommen\. Noch ist nichts gespeichert/)).toBeTruthy();
    expect(commands(calls)).toEqual([]);
    click('Entwurf verwerfen');
    expect(rows()).toEqual([['', '1700,00']]);
    expect(commands(calls)).toEqual([]);

    click('Vorschlag in Aufteilung übernehmen');
    click('Aufteilung speichern');
    await screen.findByText(/Aufteilung gespeichert \(Version 4/);
    expect(commands(calls)).toEqual([PUT]);
    const put = calls.find((call) => routeOf(call) === PUT);
    expect(put?.headers.get('if-match')).toBe('"3"');
    expect(JSON.parse(put?.body ?? 'null')).toEqual({
      splits: [
        { amount: { amount: '700.00', currency: 'EUR' }, financialCategoryCode: 'RENT_BASE' },
        { amount: { amount: '150.00', currency: 'EUR' }, financialCategoryCode: 'RENT_OPERATING_COST_ADVANCE' },
        { amount: { amount: '700.00', currency: 'EUR' }, financialCategoryCode: 'RENT_BASE' },
        { amount: { amount: '150.00', currency: 'EUR' }, financialCategoryCode: 'RENT_OPERATING_COST_ADVANCE' },
      ],
    });
    // After the save the note goes: something is saved now; nothing was confirmed, matched or written to MRE.
    await waitFor(() => expect(screen.queryByText(/Noch ist nichts gespeichert/)).toBeNull());
    expect(calls.some((call) => /confirm|rent-reconciliations$|write-back/.test(routeOf(call)) && call.method !== 'GET')).toBe(false);
  });
});

describe('step 8: the draft lock of #344 holds for a proposal taken over', () => {
  it('a classified booking: the proposal makes an unsaved draft, Buchung bestaetigen is locked until saved or discarded', async () => {
    const stored = [split({ amount: { amount: '850.00', currency: 'EUR' }, propertyReferenceId: null })];
    const calls = area({
      [DETAIL]: [() => imported('850.00', { status: 'CLASSIFIED', splits: stored })],
      [PROPOSAL]: [() => json(200, splitProposal({}, { flags: [{ code: 'ALREADY_SPLIT' }] }))],
    });
    await choose(TENANT, TERM);
    await screen.findByText('Die Buchung ist schon aufgeteilt; der Vorschlag beachtet die gespeicherte Aufteilung nicht.');
    await waitFor(() => expect(button('Buchung bestätigen').disabled).toBe(false));
    click('Vorschlag in Aufteilung übernehmen');
    expect(button('Buchung bestätigen').disabled).toBe(true);
    expect(screen.getByText('Zuerst Aufteilung speichern oder verwerfen')).toBeTruthy();
    fireEvent.click(button('Buchung bestätigen'));
    expect(screen.queryByRole('dialog')).toBeNull();
    click('Entwurf verwerfen');
    expect(rows()).toEqual([['RENT_BASE', '850,00']]);
    expect(button('Buchung bestätigen').disabled).toBe(false);
    expect(commands(calls)).toEqual([]);
  });
});

describe('step 8: partial, over and multi-Tenant payments; refusals; what is not offered', () => {
  it('a partial payment: the advance is cut, the shortfall said with its source, the draft covers the payment', async () => {
    area({ [DETAIL]: [() => imported('800.00')], [PROPOSAL]: [() => json(200, splitProposal({ amount: '800.00' }))] });
    await choose(TENANT, TERM);
    await screen.findByText(/Die Zahlung liegt 50,00.€ unter dem Sollbetrag dieses Termins/);
    expect(screen.getByText(/50,00.€ weniger \(Teilzahlung\)/)).toBeTruthy();
    click('Vorschlag in Aufteilung übernehmen');
    expect(rows()).toEqual([
      ['RENT_BASE', '700,00'],
      ['RENT_OPERATING_COST_ADVANCE', '100,00'],
    ]);
    expect(button('Aufteilung speichern').disabled).toBe(false);
  });

  it('an overpayment: the remainder is shown and taken over as a row without a category; saving waits for it', async () => {
    const calls = area({ [DETAIL]: [() => imported('900.00')], [PROPOSAL]: [() => json(200, splitProposal({ amount: '900.00' }))] });
    await choose(TENANT, TERM);
    const table = await screen.findByRole('table', { name: 'Vorgeschlagene Aufteilung' });
    expect(within(table).getByText('Nicht zugeordneter Rest').closest('tr')?.textContent).toContain(`50,00${NBSP}€`);
    expect(screen.getByText(/50,00.€ mehr \(Überzahlung\)/)).toBeTruthy();
    click('Vorschlag in Aufteilung übernehmen');
    expect(rows()).toEqual([
      ['RENT_BASE', '700,00'],
      ['RENT_OPERATING_COST_ADVANCE', '150,00'],
      ['', '50,00'],
    ]);
    expect(button('Aufteilung speichern').disabled).toBe(true);
    type(control('split-2-category'), 'RENT_BASE');
    expect(button('Aufteilung speichern').disabled).toBe(false);
    expect(commands(calls)).toEqual([]);
  });

  it('two Tenants in one payment: each line names its Tenant and term; a term the payment no longer reaches adds nothing', async () => {
    area({
      [DETAIL]: [() => imported('1000.00')],
      [PROPOSAL]: [
        () => json(200, splitProposal({ amount: '1000.00' })),
        () => json(200, splitProposal({ amount: '1000.00', tenant: TENANT_2, rent: '300.00', charges: '0.00' })),
      ],
    });
    await choose(TENANT, TERM);
    await choose(TENANT_2, TERM);
    const table = await screen.findByRole('table', { name: 'Vorgeschlagene Aufteilung' });
    const lines = within(table)
      .getAllByRole('row')
      .slice(1, -1)
      .map((row) => row.textContent);
    expect(lines).toHaveLength(3);
    expect(lines[2]).toContain(TENANT_2);
    expect(lines[2]).toContain('gekürzt auf den Rest der Zahlung');
    click('Vorschlag in Aufteilung übernehmen');
    expect(rows().map((row) => row[1])).toEqual(['700,00', '150,00', '150,00']);
  });

  it('wrong keys and a term chosen twice: said at the field, nothing is read; a double click reads once', async () => {
    const calls = area({ [DETAIL]: [() => imported('850.00')], [PROPOSAL]: [() => json(200, splitProposal())] });
    await choose('Erika Beispiel', '2026-10');
    expect(screen.getByText('Eine MRE-ID hat 24 Zeichen 0–9 und a–f (Kleinbuchstaben).')).toBeTruthy();
    expect(screen.getByText(/Ein Miettermin ist der MRE-Schlüssel JJJJMMTTHH/)).toBeTruthy();
    expect(control('vorschlag-mieter').getAttribute('aria-invalid')).toBe('true');
    expect(proposals(calls)).toEqual([]);
    type(control('vorschlag-mieter'), TENANT);
    type(control('vorschlag-termin'), TERM);
    await act(() => {
      click('Vorschlag laden');
      click('Vorschlag laden');
    });
    await screen.findByText('Sollbetrag des Termins (MRE)');
    expect(within(screen.getByRole('list', { name: 'Gewählte Termine' })).getAllByRole('listitem')).toHaveLength(1);
    expect(proposals(calls)).toHaveLength(1);
    type(control('vorschlag-termin'), TERM);
    click('Vorschlag laden');
    expect(screen.getByText('Dieser Termin dieses Mieters ist schon gewählt.')).toBeTruthy();
    expect(proposals(calls)).toHaveLength(1);
  });

  it('a term MRE does not have and an unconfirmable state: the refusal said per term, nothing to take over until removed', async () => {
    area({
      [DETAIL]: [() => imported('850.00')],
      [PROPOSAL]: [() => json(200, splitProposal()), () => envelope(422, 'MRE_RENT_TERM_NOT_FOUND', { mreTenantId: TENANT, mreRentTerm: TERM_2 })],
    });
    await choose(TENANT, TERM);
    await choose(TENANT, TERM_2);
    await screen.findByText('MRE hat diesen Mietertermin nicht geliefert. Bitte den Mieter und den Termin in MRE prüfen.');
    expect(screen.queryByRole('button', { name: 'Vorschlag in Aufteilung übernehmen' })).toBeNull();
    expect(screen.getByText(/Übernehmen erst, wenn jeder gewählte Termin gelesen ist/)).toBeTruthy();
    const cards = within(screen.getByRole('list', { name: 'Gewählte Termine' })).getAllByRole('listitem');
    fireEvent.click(within(cards[1] as HTMLElement).getByRole('button', { name: 'Termin entfernen' }));
    expect(button('Vorschlag in Aufteilung übernehmen').disabled).toBe(false);
  });

  it('NOT_PROPOSABLE is explained; a confirmed booking and an outflow get no proposal at all', async () => {
    area({
      [DETAIL]: [() => imported('850.00')],
      [PROPOSAL]: [() => envelope(409, 'CONFLICT', { reason: 'NOT_PROPOSABLE', direction: 'INFLOW', status: 'CONFIRMED' })],
    });
    await choose(TENANT, TERM);
    await screen.findByText(/Einen Aufteilungsvorschlag gibt es nur für einen noch nicht bestätigten Zahlungseingang/);
    cleanup();
    area({ [DETAIL]: [() => json(200, detail({ direction: 'OUTFLOW' }), { etag: '"3"' })] });
    await screen.findByRole('form', { name: 'Aufteilung bearbeiten' });
    expect(screen.queryByRole('region', { name: 'Aufteilungsvorschlag aus MRE' })).toBeNull();
    cleanup();
    area({ [DETAIL]: [() => json(200, detail({ status: 'CONFIRMED', splits: [split({ amount: { amount: '850.00', currency: 'EUR' } })] }), { etag: '"3"' })] });
    await screen.findByRole('heading', { name: 'Angaben zur Buchung' });
    expect(screen.queryByRole('region', { name: 'Aufteilungsvorschlag aus MRE' })).toBeNull();
    expect(screen.queryByLabelText('Miettermin (MRE-Schlüssel JJJJMMTTHH)')).toBeNull();
  });
});

describe('step 8: the proposal goes when a re-read shows the booking confirmed (#346 review, hint H1)', () => {
  it('editor open on an unconfirmed booking, a 412 re-read answers CONFIRMED: the proposal region is gone, the editor with the kept draft stands', async () => {
    const stored = [split({ amount: { amount: '850.00', currency: 'EUR' }, propertyReferenceId: null })];
    const calls = area({
      [DETAIL]: [
        () => imported('850.00'),
        () => json(200, detail({ amount: { amount: '850.00', currency: 'EUR' }, status: 'CONFIRMED', version: 5, splits: stored }), { etag: '"5"' }),
      ],
      [PUT]: [() => envelope(412, 'VERSION_CONFLICT', { expectedVersions: [3], currentVersion: 5 })],
    });
    // First answer of DETAIL: unconfirmed, the editor with the proposal section is open.
    expect(await screen.findByRole('region', { name: 'Aufteilungsvorschlag aus MRE' })).toBeTruthy();
    type(control('split-0-category'), 'RENT_BASE');
    type(control('split-0-amount'), '850,00');
    click('Aufteilung speichern');
    await screen.findByRole('heading', { name: 'Inzwischen geändert' });
    // The re-read (second answer of DETAIL): meanwhile confirmed elsewhere.
    click('Entwurf behalten und Serverstand ansehen');
    await screen.findByText('Aktueller Stand auf dem Server: Version 5, Status „Bestätigt“');
    expect(screen.queryByRole('region', { name: 'Aufteilungsvorschlag aus MRE' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Vorschlag laden' })).toBeNull();
    const editor = screen.getByRole('region', { name: 'Aufteilung bearbeiten' });
    expect(within(editor).getByText(/ihre Aufteilung kann nicht mehr geändert werden/)).toBeTruthy();
    expect(rows()).toEqual([['RENT_BASE', '850,00']]);
    expect(button('Aufteilung speichern').disabled).toBe(true);
    expect(calls.filter((call) => routeOf(call) === DETAIL)).toHaveLength(2);
    expect(proposals(calls)).toEqual([]);
    expect(commands(calls)).toEqual([PUT]);
  });
});
