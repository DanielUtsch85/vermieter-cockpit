// @vitest-environment jsdom
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { TENANT_2 } from '../rent/fixtures.test-support';
import { transactionPath } from '../routing';
import { PROPERTY, REALM_A } from '../transactions/fixtures.test-support';
import { findSaved } from '../ui/technical.test-support';
import { click, commands, confirmTransaction, openApp, requests, useDurchstich } from './walk.test-support';

/**
 * Issue #364 in the Durchstich (Entscheidung des Projektinhabers, 2026-11-16; api-design.md §37.7): a rent inflow is split
 * from MRE's proposal and matched by hand without typing an MRE id or a term key. The Tenant comes from the list of the
 * Realm's earlier matches, the term from the list of its terms around the booking date; the fake backend answers both
 * reads through the backend's own mappings. Synthetic Tenant, terms and amounts only.
 */
const backend = useDurchstich();
const SEP = '2026090100';
const OCT = '2026100100';
/** The window's edges for a booking of 1 October 2026: July and December lie outside, August and November inside. */
const EDGES = ['2026070100', '2026080100', '2026110100', '2026120100'];
const EUR = (amount: string) => ({ amount, currency: 'EUR' });
const NBSP = '\u00a0';
const select = (label: string) => screen.getByLabelText<HTMLSelectElement>(label);
const options = (label: string) => Array.from(select(label).options).map((o) => o.value);
const pick = (label: string, value: string) => fireEvent.change(select(label), { target: { value } });
const body = (text: string | undefined) => (text === undefined ? null : (JSON.parse(text) as unknown));

/** The Tenant and October from the two lists, once the lists are read. */
async function chooseFromLists() {
  await waitFor(() => expect(options('Mieter aus bisherigen Zuordnungen')).toContain(TENANT_2));
  pick('Mieter aus bisherigen Zuordnungen', TENANT_2);
  await waitFor(() => expect(options('Miettermin aus MRE')).toContain(OCT));
  pick('Miettermin aus MRE', OCT);
}

describe('#364 in the Durchstich: Tenant and term chosen, never typed', () => {
  it('October split from the proposal and matched by hand, the Tenant from the earlier match of September', async () => {
    backend().addMreTerm(TENANT_2, SEP, { rent: '700.00', charges: '150.00' });
    backend().addMreTerm(TENANT_2, OCT, { rent: '700.00', charges: '150.00' });
    for (const term of EDGES) backend().addMreTerm(TENANT_2, term, { rent: '700.00', charges: '150.00' });
    const september = backend().seedInflow('Miete September Testwohnung 2', '850.00', '2026-09-01', true);
    backend().seedReconciliation(september, { status: 'CONFIRMED', mreTenantId: TENANT_2, mreRentTerm: SEP, confidence: null, suggestionReason: null });
    const t = backend().seedInflow('Miete Oktober Testwohnung 2', '850.00', '2026-10-01');
    await openApp(backend(), transactionPath(REALM_A, t.id));

    // The proposal: Tenant and term from the lists; the fields beside them are filled, not typed.
    const proposal = await screen.findByRole('region', { name: 'Aufteilungsvorschlag aus MRE' });
    await chooseFromLists();
    expect(within(proposal).getByLabelText<HTMLInputElement>('Mieter in MRE (ID)').value).toBe(TENANT_2);
    expect(within(proposal).getByLabelText<HTMLInputElement>('Miettermin (MRE-Schlüssel JJJJMMTTHH)').value).toBe(OCT);
    // September is listed as matched, October as open; the window is the second month before to the month after the booking.
    expect(Array.from(select('Miettermin aus MRE').options).map((o) => o.textContent)).toEqual([
      'Bitte wählen',
      `Termin 01.11.2026 (2026110100) · Soll 850,00${NBSP}€ · offen 850,00${NBSP}€`,
      `Termin 01.10.2026 (2026100100) · Soll 850,00${NBSP}€ · offen 850,00${NBSP}€`,
      `Termin 01.09.2026 (2026090100) · Soll 850,00${NBSP}€ · offen 0,00${NBSP}€`,
      `Termin 01.08.2026 (2026080100) · Soll 850,00${NBSP}€ · offen 850,00${NBSP}€`,
    ]);
    expect(requests(backend(), 'GET', `/api/v1/rent-reconciliations/terms/${TENANT_2}`).map((s) => s.search)).toEqual(['?from=2026-08&to=2026-11']);
    click('Vorschlag laden');
    await screen.findByText('Sollbetrag des Termins (MRE)');
    click('Vorschlag in Aufteilung übernehmen');
    click('Aufteilung speichern');
    await findSaved(/Aufteilung gespeichert \(Status/, 2);
    await confirmTransaction();
    expect(t.status).toBe('CONFIRMED');

    // The manual match: the same two lists in the booking's rent section; the amount starts at the free rent cash.
    const section = await screen.findByRole('region', { name: 'Mietabgleich dieser Buchung' });
    await waitFor(() => expect(within(section).getByRole('button', { name: 'Manuell zuordnen' })).toBeTruthy());
    fireEvent.click(within(section).getByRole('button', { name: 'Manuell zuordnen' }));
    await chooseFromLists();
    click('Zuordnung anlegen');
    click('Jetzt zuordnen');
    await screen.findByText(/Manuell zugeordnet/);

    const writes = backend().sent.filter((s) => s.method !== 'GET');
    expect(commands(backend())).toEqual([
      `PUT /api/v1/transactions/${t.id}/splits`,
      `POST /api/v1/transactions/${t.id}/confirm`,
      'POST /api/v1/rent-reconciliations',
    ]);
    expect(writes.map((s) => body(s.body))).toEqual([
      {
        splits: [
          { amount: EUR('700.00'), financialCategoryCode: 'RENT_BASE', propertyReferenceId: PROPERTY },
          { amount: EUR('150.00'), financialCategoryCode: 'RENT_OPERATING_COST_ADVANCE', propertyReferenceId: PROPERTY },
        ],
      },
      null,
      { transactionId: t.id, mreTenantId: TENANT_2, mreRentTerm: OCT, matchedAmount: EUR('850.00') },
    ]);
    // Unchanged money and nothing in MRE: the whole payment is matched to October, MRE was not written.
    const october = [...backend().reconciliations.values()].filter((r) => r.mreRentTerm === OCT);
    expect(october.map((r) => [r.status, r.matchedAmount.toJSON().amount, r.mreWriteBackState])).toEqual([['CONFIRMED', '850.00', 'NOT_WRITTEN']]);
    expect(backend().counters.mreWrites).toBe(0);
    // Only the two reads of #364 were added: the Tenants and the Tenant's terms, all in this Realm.
    expect(requests(backend(), 'GET', '/api/v1/rent-reconciliations/tenants').length).toBeGreaterThan(0);
    expect(
      backend()
        .sent.filter((s) => s.path.startsWith('/api/v1/'))
        .every((s) => s.headers.get('organizationid') === REALM_A),
    ).toBe(true);
  });
});
