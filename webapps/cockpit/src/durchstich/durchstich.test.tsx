// @vitest-environment jsdom
import { fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { PROPERTY, REALM_A } from '../transactions/fixtures.test-support';
import { ACCOUNT_IBAN, CSV_NAME, DURCHSTICH_CSV, TERM_OCT } from './fake-backend.test-support';
import {
  click,
  commands,
  confirmTransaction,
  control,
  correctDescription,
  csvFile,
  go,
  IMPORT,
  importCsv,
  MIETABGLEICH,
  mreWrite,
  openApp,
  openTransaction,
  release,
  requests,
  resolveCreate,
  showAllRows,
  splitRent,
  suggestOctober,
  twice,
  type,
  useDurchstich,
} from './walk.test-support';
import { findSaved } from '../ui/technical.test-support';

/**
 * Step 7 of the first slice (ui-guide.md §10, §12 point 3): the whole Durchstich in one place, against the real UI
 * (App, a real Session, the real DE client) and a stateful fake DE and MRE that answers through the backend's own DTO
 * mappings. Import → review item → split → confirm → rent suggestion → confirm the match → write-back → release →
 * removal → correction. The error and conflict cases at the points where they happen are in durchstich-fehler.test.tsx
 * (409, 412, 413, MRE unreachable, lost answer, double click, unknown codes) and durchstich-sitzung.test.tsx (expired
 * token, 403, 404, Realm switch, no MRE write by reading).
 */

const backend = useDurchstich();
const json = (body: string | undefined) => JSON.parse(body ?? 'null') as unknown;
const rowOutcomes = () =>
  screen
    .getAllByRole('row')
    .slice(1)
    .map((row) => row.querySelectorAll('td')[1]?.textContent);

/** The whole walk; `press` is how each command button is clicked (once, or twice in one event batch). */
async function walk(press: (name: string) => unknown) {
  await openApp(backend(), IMPORT);

  // 1. Import: one POST, the result at its own URL, the colliding row as a review item of this batch; decided once.
  await importCsv(csvFile(), press);
  // By default only the row with a hint (the review item); every row with „Alle Zeilen“.
  expect(rowOutcomes()).toEqual(['Klärfall']);
  showAllRows();
  expect(rowOutcomes()).toEqual(['Neu angelegt', 'Neu angelegt', 'Klärfall']);
  const [upload] = requests(backend(), 'POST', '/api/v1/imports/bank-transactions');
  expect(JSON.parse(upload?.form?.get('metadata') as string)).toEqual({
    financialAccountId: '0b8f2c1e-3d4a-4b5c-8d6e-7f8091a2b3c4',
    adapterId: 'generic-csv',
    adapterVersion: '2',
    preset: 'vr-banking',
  });
  expect((upload?.form?.get('file') as File).name).toBe(CSV_NAME);
  await resolveCreate(press);
  const created = backend().tx('Gutschrift Testversicherung Nachtrag');
  expect(created.status).toBe('IMPORTED');
  fireEvent.click(screen.getByRole('link', { name: 'Angelegte Buchung öffnen' }), { button: 0 });
  expect(await screen.findByText('Gutschrift Testversicherung Nachtrag')).toBeTruthy();

  // 2. Split the rent exactly (Kaltmiete on the object, Nebenkosten), then confirm it: each with the version read.
  const rent = backend().tx('Miete Oktober Testwohnung');
  await openTransaction(backend(), 'Miete Oktober Testwohnung');
  await splitRent(PROPERTY, press);
  await findSaved(/Aufteilung gespeichert \(Status/, 2);
  await confirmTransaction(press);
  expect(rent.status).toBe('CONFIRMED');
  const section = await screen.findByRole('region', { name: 'Mietabgleich dieser Buchung' });
  await within(section).findByText('Mietanteil der Buchung');
  expect(section.textContent).toMatch(/Mietanteil der Buchung850,00\s€Davon bestätigt zugeordnet0,00\s€Noch frei850,00\s€/);

  // 3. Rent: suggest October, review the suggestion, confirm it; MRE is not touched by that.
  await go(MIETABGLEICH);
  await suggestOctober(press);
  await screen.findByText('1 neuer Vorschlag für 2026-10 bis 2026-10.');
  const [rec] = [...backend().reconciliations.values()];
  if (rec === undefined) throw new Error('no suggestion');
  expect([rec.status, rec.mreRentTerm, rec.transactionId]).toEqual(['SUGGESTED', TERM_OCT, rent.id]);
  fireEvent.click(within(screen.getByRole('list', { name: 'Neue Vorschläge' })).getByRole('link', { name: 'Vorschlag prüfen' }), { button: 0 });
  await screen.findByRole('button', { name: 'Zuordnung bestätigen' });
  await press('Zuordnung bestätigen');
  await screen.findByText('Zuordnung bestätigt');
  expect(backend().counters.mreWrites).toBe(0);

  // 4. Write back, release, remove: three separate clicks; MRE holds DE's payment in between, and only then.
  await mreWrite('An MRE übertragen', press);
  await screen.findByText('MRE: übertragen');
  expect(backend().mreTerm.payments.map((p) => p.reference)).toEqual([null, `DE-RPR-${rec.id}`]);
  await release(undefined, press);
  await screen.findByText('MRE: Entfernen erforderlich');
  expect(backend().mreTerm.payments).toHaveLength(2);
  await mreWrite('Aus MRE entfernen', press);
  await screen.findByText('MRE: entfernt');
  expect(backend().mreTerm.payments.map((p) => p.reference)).toEqual([null]);

  // 5. Correct the released booking: reversal and replacement; the original is CORRECTED, never changed in place.
  await openTransaction(backend(), 'Miete Oktober Testwohnung');
  await correctDescription(undefined, press);
  await screen.findByRole('heading', { name: 'Korrektur ausgeführt' });
  expect(rent.status).toBe('CORRECTED');
  expect(rent.description).toBe('Miete Oktober Testwohnung');
  const chain = [...backend().transactions.values()].filter((t) => t.correctionOfTransactionId === rent.id);
  expect(chain.map((t) => [t.correctionRole, t.description])).toEqual([
    ['REVERSAL', 'Miete Oktober Testwohnung'],
    ['REPLACEMENT', 'Miete Oktober Testwohnung (korrigiert)'],
  ]);

  // Every command exactly once, in the user's order, with the version read and the bodies as decided.
  const item = [...backend().items.values()][0];
  const R = `/api/v1/rent-reconciliations/${rec.id}`;
  expect(commands(backend())).toEqual([
    'POST /api/v1/imports/bank-transactions',
    `POST /api/v1/imports/${item?.importBatchId ?? ''}/review-items/${item?.id ?? ''}/resolve`,
    `PUT /api/v1/transactions/${rent.id}/splits`,
    `POST /api/v1/transactions/${rent.id}/confirm`,
    'POST /api/v1/rent-reconciliations/suggest',
    `POST ${R}/confirm`,
    `POST ${R}/write-back-to-mre`,
    `POST ${R}/release`,
    `POST ${R}/remove-from-mre`,
    `POST /api/v1/transactions/${rent.id}/correct`,
  ]);
  const writes = backend().sent.filter((s) => s.method !== 'GET');
  expect(writes.map((s) => s.headers.get('if-match'))).toEqual([null, null, '"1"', '"2"', null, '"1"', '"2"', '"3"', '"4"', '"3"']);
  // Only the correction carries an Idempotency-Key (§7.3: not glued to every route); the import dedups by its rows.
  expect(writes.map((s) => s.headers.has('idempotency-key'))).toEqual([false, false, false, false, false, false, false, false, false, true]);
  expect(writes.map((s) => json(s.body))).toEqual([
    null,
    { resolution: 'CREATE' },
    {
      splits: [
        { amount: { amount: '700.00', currency: 'EUR' }, financialCategoryCode: 'RENT_BASE', propertyReferenceId: PROPERTY },
        { amount: { amount: '150.00', currency: 'EUR' }, financialCategoryCode: 'RENT_OPERATING_COST_ADVANCE' },
      ],
    },
    null,
    { from: '2026-10', to: '2026-10' },
    { matchedAmount: { amount: '850.00', currency: 'EUR' } },
    null,
    { reason: 'Falsche Buchung zugeordnet' },
    null,
    { reason: 'Verwendungszweck falsch erfasst', replacement: { description: 'Miete Oktober Testwohnung (korrigiert)' } },
  ]);
  // MRE written exactly twice (write-back and removal), DE always for Realm A, the token only in its header.
  expect(backend().counters.mreWrites).toBe(2);
  expect(
    backend()
      .sent.filter((s) => s.path.startsWith('/api/v1/'))
      .every((s) => s.headers.get('organizationid') === REALM_A),
  ).toBe(true);
  expect(backend().sent.every((s) => !s.search.includes('token') && !s.path.includes('DE00'))).toBe(true);
}

describe('the Durchstich, start to end (ui-guide.md §10, §12 point 3)', () => {
  it('import, review item, split, confirm, suggest, confirm the match, write back, release, remove, correct: one click and one request each', async () => {
    await walk(click);
  });

  it('a double click on every command button of the walk: still one request each, the same server state (§12 point 5)', async () => {
    await walk(twice);
  });
});

describe('§11: amounts never through floating point', () => {
  it('beyond 2^53 cents and 0,10 + 0,20: split, confirmed, suggested and matched to the cent, sent and shown as typed', async () => {
    const big = `Testkonto;${ACCOUNT_IBAN};01.10.2026;01.10.2026;Erika Beispiel;DE00 0000 0000 0000 0000 02;Miete Oktober Testwohnung;90.071.992.547.409,93;EUR;90.071.992.547.409,93`;
    await openApp(backend(), IMPORT);
    await importCsv(csvFile([DURCHSTICH_CSV.split('\n')[0], big].join('\n')));
    const rent = backend().tx('Miete Oktober Testwohnung');
    expect(rent.amount.toJSON().amount).toBe('90071992547409.93');
    await openTransaction(backend(), 'Miete Oktober Testwohnung');
    expect((await screen.findAllByText(/90\.071\.992\.547\.409,93/)).length).toBeGreaterThan(0);
    await splitRent(PROPERTY, false);
    type(control('split-0-amount'), '0,10');
    type(control('split-1-amount'), '0,20');
    click('Teilbetrag hinzufügen');
    type(control('split-2-category'), 'RENT_BASE');
    type(control('split-2-amount'), '90.071.992.547.409,63');
    click('Aufteilung speichern');
    await findSaved(/Aufteilung gespeichert \(Status/, 2);
    const [put] = requests(backend(), 'PUT', /\/splits$/);
    expect((json(put?.body) as { splits: { amount: { amount: string } }[] }).splits.map((s) => s.amount.amount)).toEqual(['0.10', '0.20', '90071992547409.63']);
    await confirmTransaction();
    await go(MIETABGLEICH);
    await suggestOctober();
    await screen.findByText('1 neuer Vorschlag für 2026-10 bis 2026-10.');
    fireEvent.click(within(screen.getByRole('list', { name: 'Neue Vorschläge' })).getByRole('link', { name: 'Vorschlag prüfen' }), { button: 0 });
    expect((await screen.findByLabelText<HTMLInputElement>('Zu bestätigender Betrag (€)')).value).toBe('90071992547409,93');
    click('Zuordnung bestätigen');
    await screen.findByText('Zuordnung bestätigt');
    expect(json(requests(backend(), 'POST', /rent-reconciliations\/[^/]+\/confirm$/)[0]?.body)).toEqual({
      matchedAmount: { amount: '90071992547409.93', currency: 'EUR' },
    });
    expect(document.body.textContent).toContain('90.071.992.547.409,93');
    expect(document.body.textContent).not.toMatch(/90\.071\.992\.547\.409,9[24]|e\+\d/);
  });
});
