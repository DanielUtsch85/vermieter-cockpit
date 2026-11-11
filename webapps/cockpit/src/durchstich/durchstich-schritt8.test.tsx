// @vitest-environment jsdom
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { TENANT_2 } from '../rent/fixtures.test-support';
import { rentTermPath, transactionPath } from '../routing';
import { REALM_A } from '../transactions/fixtures.test-support';
import { click, commands, confirmTransaction, go, MIETABGLEICH, openApp, requests, twice, type, useDurchstich } from './walk.test-support';

/**
 * Step 8 in the Durchstich (Entscheidung des Projektinhabers, 2026-11-11; ui-guide.md §6.6 steps 2 and 3): against the
 * whole App and the stateful fake backend, which answers the split proposal and the manual match through the backend's
 * own mappings and checks the bodies with the routes' own schemas. The suggest run uses §37.3's exact rule here
 * (`suggestRule = 'EXACT'`), so a collective or partial payment is not suggested by itself, as in the backend. Only
 * synthetic Tenants, terms and amounts: the second synthetic Tenant, October and November 2026.
 */

const backend = useDurchstich();
const OCT = '2026100100';
const NOV = '2026110100';
const NBSP = ' ';
const body = (text: string | undefined) => (text === undefined ? null : (JSON.parse(text) as unknown));
const EUR = (amount: string) => ({ amount, currency: 'EUR' });

async function chooseTerm(term: string, press: (name: string) => unknown) {
  type(await screen.findByLabelText('Mieter in MRE (ID)'), TENANT_2);
  type(screen.getByLabelText('Miettermin (MRE-Schlüssel JJJJMMTTHH)'), term);
  await press('Vorschlag laden');
}

async function suggest(from: string, to: string, press: (name: string) => unknown) {
  await go(MIETABGLEICH);
  type(await screen.findByLabelText('Erster Monat'), from);
  type(screen.getByLabelText('Letzter Monat'), to);
  await press('Vorschläge ermitteln');
}

async function confirmSuggestion(amount: string | undefined, press: (name: string) => unknown) {
  fireEvent.click(within(await screen.findByRole('list', { name: 'Neue Vorschläge' })).getByRole('link', { name: 'Vorschlag prüfen' }), { button: 0 });
  const field = await screen.findByLabelText<HTMLInputElement>('Zu bestätigender Betrag (€)');
  if (amount !== undefined) type(field, amount);
  await press('Zuordnung bestätigen');
  await screen.findByText(/Zuordnung bestätigt über/);
}

/** A collective payment for October and November: proposal → split → confirm → suggest (none) → manual → suggest → confirm. */
async function collective(press: (name: string) => unknown) {
  backend().suggestRule = 'EXACT';
  backend().addMreTerm(TENANT_2, OCT, { rent: '700.00', charges: '150.00' });
  backend().addMreTerm(TENANT_2, NOV, { rent: '700.00', charges: '150.00' });
  // Paid on 2 November: within November's booking range (from 15 October), outside October's (to 31 October).
  const t = backend().seedInflow('Miete Oktober und November Testwohnung 2', '1700.00', '2026-11-02');
  await openApp(backend(), transactionPath(REALM_A, t.id));

  // §6.6 step 2: two terms, each read with its source; the combined proposal covers the payment exactly.
  await chooseTerm(OCT, press);
  await chooseTerm(NOV, press);
  await waitFor(() => expect(screen.getAllByText('Sollbetrag des Termins (MRE)')).toHaveLength(2));
  expect(requests(backend(), 'GET', '/api/v1/rent-reconciliations/split-proposal').map((s) => new URLSearchParams(s.search).get('mreRentTerm'))).toEqual([
    OCT,
    NOV,
  ]);
  await press('Vorschlag in Aufteilung übernehmen');
  // Only the draft: nothing is sent, the booking is unchanged.
  expect(commands(backend())).toEqual([]);
  expect([t.status, t.splits]).toEqual(['IMPORTED', []]);

  // §6.6 step 3: saved by the user's save, then confirmed: two separate commands.
  await press('Aufteilung speichern');
  await screen.findByText(/Aufteilung gespeichert \(Version 2/);
  expect(t.splits.map((s) => [s.financialCategoryCode, s.amount.toJSON().amount])).toEqual([
    ['RENT_BASE', '700.00'],
    ['RENT_OPERATING_COST_ADVANCE', '150.00'],
    ['RENT_BASE', '700.00'],
    ['RENT_OPERATING_COST_ADVANCE', '150.00'],
  ]);
  await confirmTransaction(press);
  expect(t.status).toBe('CONFIRMED');

  // Suggest: a collective payment fits no single term (§37.3), and the page says so instead of "alles bezahlt".
  await suggest('2026-10', '2026-11', press);
  await screen.findByText('Keine neuen Vorschläge für 2026-10 bis 2026-11.');
  expect(screen.getByText(/„Keine Vorschläge“ heißt nicht „alle Mieten bezahlt“/)).toBeTruthy();

  // Manual match of October (§37.1), its own action with its own confirmation step; nothing to MRE.
  await go(transactionPath(REALM_A, t.id));
  await press('Manuell zuordnen');
  type(await screen.findByLabelText('Mieter in MRE (ID)'), TENANT_2);
  type(screen.getByLabelText('Miettermin (MRE-Schlüssel JJJJMMTTHH)'), OCT);
  type(screen.getByLabelText('Zuzuordnender Betrag (€)'), '850,00');
  await press('Zuordnung anlegen');
  await press('Jetzt zuordnen');
  await screen.findByText(/Manuell zugeordnet/);

  // Now November fits exactly what is left: suggested, then confirmed as it is.
  await suggest('2026-10', '2026-11', press);
  await screen.findByText('1 neuer Vorschlag für 2026-10 bis 2026-11.');
  await confirmSuggestion(undefined, press);

  const recs = [...backend().reconciliations.values()];
  expect(recs.map((r) => [r.mreRentTerm, r.status, r.matchedAmount.toJSON().amount, r.confidence, r.mreWriteBackState])).toEqual([
    [OCT, 'CONFIRMED', '850.00', null, 'NOT_WRITTEN'],
    [NOV, 'CONFIRMED', '850.00', 'MEDIUM', 'NOT_WRITTEN'],
  ]);
  const [manual, suggested] = recs;
  expect(commands(backend())).toEqual([
    `PUT /api/v1/transactions/${t.id}/splits`,
    `POST /api/v1/transactions/${t.id}/confirm`,
    'POST /api/v1/rent-reconciliations/suggest',
    'POST /api/v1/rent-reconciliations',
    'POST /api/v1/rent-reconciliations/suggest',
    `POST /api/v1/rent-reconciliations/${suggested?.id ?? ''}/confirm`,
  ]);
  const writes = backend().sent.filter((s) => s.method !== 'GET');
  expect(writes.map((s) => body(s.body))).toEqual([
    {
      splits: [
        { amount: EUR('700.00'), financialCategoryCode: 'RENT_BASE' },
        { amount: EUR('150.00'), financialCategoryCode: 'RENT_OPERATING_COST_ADVANCE' },
        { amount: EUR('700.00'), financialCategoryCode: 'RENT_BASE' },
        { amount: EUR('150.00'), financialCategoryCode: 'RENT_OPERATING_COST_ADVANCE' },
      ],
    },
    null,
    { from: '2026-10', to: '2026-11' },
    { transactionId: t.id, mreTenantId: TENANT_2, mreRentTerm: OCT, matchedAmount: EUR('850.00') },
    { from: '2026-10', to: '2026-11' },
    { matchedAmount: EUR('850.00') },
  ]);
  expect(writes.map((s) => s.headers.get('if-match'))).toEqual(['"1"', '"2"', null, null, null, '"1"']);
  expect(writes.map((s) => s.headers.has('idempotency-key'))).toEqual([false, false, false, true, false, false]);
  expect(manual?.matchedAmount.toJSON().amount).toBe('850.00');
  // Unchanged money: split sum = payment = matched total; MRE untouched by all of it.
  expect(backend().counters.mreWrites).toBe(0);
  await go(transactionPath(REALM_A, t.id));
  const section = await screen.findByRole('region', { name: 'Mietabgleich dieser Buchung' });
  await waitFor(() =>
    expect(section.textContent).toMatch(
      new RegExp(`Mietanteil der Buchung1\\.700,00${NBSP}€Davon bestätigt zugeordnet1\\.700,00${NBSP}€Noch frei0,00${NBSP}€`),
    ),
  );
  expect(within(section).queryByRole('button', { name: 'Manuell zuordnen' })).toBeNull();
}

describe('step 8 in the Durchstich: a collective payment for two months', () => {
  it('split from the proposal, saved, confirmed, suggested, matched by hand and by suggestion: one request per click', async () => {
    await collective(click);
  });

  it('the same walk with a double click on every button: still one request each', async () => {
    await collective(twice);
  });
});

describe('step 8 in the Durchstich: a partial payment with a lowered confirmation', () => {
  it('a payment below the target: proposal with the shortfall, saved, confirmed, suggested, confirmed lowered; the rest stays open', async () => {
    backend().suggestRule = 'EXACT';
    backend().addMreTerm(TENANT_2, OCT, { rent: '700.00', charges: '150.00' });
    // An earlier part of October (50,00 €) is already matched, so 800,00 € are open.
    const part = backend().seedInflow('Teilzahlung Oktober Testwohnung 2', '50.00', '2026-10-02', true);
    backend().seedReconciliation(part, { status: 'CONFIRMED', mreTenantId: TENANT_2, mreRentTerm: OCT, confidence: null, suggestionReason: null });
    const t = backend().seedInflow('Miete Oktober Rest Testwohnung 2', '800.00', '2026-10-20');
    await openApp(backend(), transactionPath(REALM_A, t.id));

    await chooseTerm(OCT, click);
    await screen.findByText(/Die Zahlung liegt 50,00.€ unter dem Sollbetrag dieses Termins/);
    click('Vorschlag in Aufteilung übernehmen');
    expect(commands(backend())).toEqual([]);
    click('Aufteilung speichern');
    await screen.findByText(/Aufteilung gespeichert \(Version 2/);
    expect(t.splits.map((s) => [s.financialCategoryCode, s.amount.toJSON().amount])).toEqual([
      ['RENT_BASE', '700.00'],
      ['RENT_OPERATING_COST_ADVANCE', '100.00'],
    ]);
    await confirmTransaction();

    await suggest('2026-10', '2026-10', click);
    await screen.findByText('1 neuer Vorschlag für 2026-10 bis 2026-10.');
    await confirmSuggestion('750,00', click);
    const rec = [...backend().reconciliations.values()].find((r) => r.transactionId === t.id);
    expect([rec?.status, rec?.suggestedAmount.toJSON().amount, rec?.matchedAmount.toJSON().amount]).toEqual(['CONFIRMED', '800.00', '750.00']);
    expect(body(requests(backend(), 'POST', /\/confirm$/).at(-1)?.body)).toEqual({ matchedAmount: EUR('750.00') });

    // The term: 50 + 750 matched, 50 open, with its source; the booking keeps 50 free for a manual match.
    await go(rentTermPath(REALM_A, { mreTenantId: TENANT_2, mreRentTerm: OCT }));
    await screen.findByText('Teilweise zugeordnet.');
    expect(screen.getByRole('region', { name: 'Deckung' }).textContent).toMatch(
      new RegExp(`Offener Betrag: 50,00${NBSP}€ \\(Sollbetrag laut MRE abzüglich der bestätigten Zuordnungen in DE`),
    );
    await go(transactionPath(REALM_A, t.id));
    const section = await screen.findByRole('region', { name: 'Mietabgleich dieser Buchung' });
    await waitFor(() => expect(section.textContent).toMatch(new RegExp(`Noch frei50,00${NBSP}€`)));
    expect(within(section).getByRole('button', { name: 'Manuell zuordnen' })).toBeTruthy();
    expect(commands(backend())).toEqual([
      `PUT /api/v1/transactions/${t.id}/splits`,
      `POST /api/v1/transactions/${t.id}/confirm`,
      'POST /api/v1/rent-reconciliations/suggest',
      `POST /api/v1/rent-reconciliations/${rec?.id ?? ''}/confirm`,
    ]);
    expect(backend().counters.mreWrites).toBe(0);
    expect(
      backend()
        .sent.filter((s) => s.path.startsWith('/api/v1/'))
        .every((s) => s.headers.get('organizationid') === REALM_A),
    ).toBe(true);
  });
});
