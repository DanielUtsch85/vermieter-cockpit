// @vitest-environment jsdom
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { envelope } from '../api/fetch.test-support';
import { TENANT } from '../rent/fixtures.test-support';
import { rentTermPath } from '../routing';
import { PROPERTY, REALM_A } from '../transactions/fixtures.test-support';
import { TERM_OCT } from './fake-backend.test-support';
import {
  button,
  chooseFile,
  click,
  commands,
  control,
  correctDescription,
  csvFile,
  go,
  IMPORT,
  importCsv,
  MRE_COMMANDS,
  openApp,
  requests,
  settle,
  splitRent,
  type,
  useDurchstich,
} from './walk.test-support';

/**
 * Step 7 (ui-guide.md §10, §11, §12 point 5): the conflict and error cases at the point of the Durchstich where they
 * happen, against the whole App and the stateful fake backend. Each case says what the user sees and which requests
 * went out (count, headers, keys), and that the server state is what it must be: nothing written twice, nothing
 * overwritten silently, nothing claimed paid without MRE. The steps before the one under test are seeded in the backend
 * (`seedRent`, `seedReconciliation`) rather than walked again; durchstich.test.tsx walks them once.
 */

const backend = useDurchstich();
const PUT_SPLITS = /\/transactions\/[^/]+\/splits$/;
const ifMatches = (method: string, path: string | RegExp) => requests(backend(), method, path).map((s) => s.headers.get('if-match'));

describe('409: the action does not fit the server state (ALREADY_*, a write running in MRE, REMOVAL_TOO_EARLY)', () => {
  it('ALREADY_RESOLVED: decided in another tab; explained with the other decision, nothing sent again, the reload shows it', async () => {
    await openApp(backend(), IMPORT);
    await importCsv();
    await screen.findByRole('button', { name: 'Als eigenständige Buchung übernehmen' });
    // Another tab skipped the item meanwhile.
    const [item] = [...backend().items.values()];
    Object.assign(item ?? {}, {
      status: 'RESOLVED',
      resolution: 'SKIP',
      resolvedBy: 'zweiter-tab@example.invalid',
      resolvedAt: new Date('2026-11-11T09:30:00Z'),
    });
    click('Als eigenständige Buchung übernehmen');
    expect(await screen.findByText(/Der Klärfall ist bereits anders entschieden \(„Nicht als neue Buchung übernommen“\)/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Erneut senden' })).toBeNull();
    const before = backend().transactions.size;
    click('Stand neu laden');
    expect(await screen.findByText(/Entschieden: Nicht als neue Buchung übernommen/)).toBeTruthy();
    expect(requests(backend(), 'POST', /\/resolve$/)).toHaveLength(1);
    expect(backend().transactions.size).toBe(before);
  });

  it('TRANSACTION_RENT_RECONCILED: the correction waits for the release; the link opens the match, nothing is released by itself', async () => {
    const t = backend().seedRent('CONFIRMED');
    const r = backend().seedReconciliation(t, { status: 'CONFIRMED', version: 2 });
    await openApp(backend(), `/cockpit/r/${REALM_A}/buchungen/${t.id}`);
    await correctDescription();
    expect(await screen.findByText(/Zuerst muss die Zuordnung im Mietabgleich aufgehoben werden/)).toBeTruthy();
    fireEvent.click(screen.getByRole('link', { name: 'Mietzuordnung öffnen und aufheben' }), { button: 0 });
    expect(await screen.findByRole('button', { name: 'Zuordnung aufheben' })).toBeTruthy();
    expect(commands(backend())).toEqual([`POST /api/v1/transactions/${t.id}/correct`]);
    expect([t.status, r.status]).toEqual(['CONFIRMED', 'CONFIRMED']);
  });

  it('WRITE_BACK_IN_PROGRESS: another tab writes; the detail is read once, the running write is said, MRE gets one payment only', async () => {
    const t = backend().seedRent('CONFIRMED');
    const r = backend().seedReconciliation(t, { status: 'CONFIRMED', version: 2 });
    await openApp(backend(), `/cockpit/r/${REALM_A}/mietabgleich/${r.id}`);
    await screen.findByRole('button', { name: 'An MRE übertragen' });
    backend().startForeignWriteBack(r.id);
    const reads = requests(backend(), 'GET', `/api/v1/rent-reconciliations/${r.id}`).length;
    click('An MRE übertragen');
    expect(await screen.findByText(/Ein Schreibvorgang in MRE läuft bis/)).toBeTruthy();
    expect(screen.getByText('MRE: Übertragung läuft')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'An MRE übertragen' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Zuordnung aufheben' })).toBeNull();
    await settle();
    expect(requests(backend(), 'GET', `/api/v1/rent-reconciliations/${r.id}`).length - reads).toBe(1);
    // The other write ends; the user reads again and sees it written, once.
    backend().finishForeignWriteBack(r.id);
    click('Stand neu laden');
    expect(await screen.findByText('MRE: übertragen')).toBeTruthy();
    expect(requests(backend(), 'POST', MRE_COMMANDS)).toHaveLength(1);
    expect(backend().counters.mreWrites).toBe(1);
    expect(backend().mreTerm.payments.filter((p) => p.reference === `DE-RPR-${r.id}`)).toHaveLength(1);
  });

  it('WRITE_BACK_IN_PROGRESS with Retry-After: the actions wait that long, then are offered again; nothing is sent by itself', async () => {
    // The backend sends no Retry-After with this 409 today (#339, question 3); the client honours one when it comes.
    const t = backend().seedRent('CONFIRMED');
    const r = backend().seedReconciliation(t, { status: 'CONFIRMED', version: 2 });
    backend().fault(`POST /api/v1/rent-reconciliations/${r.id}/write-back-to-mre`, {
      answer: () => envelope(409, 'CONFLICT', { reason: 'WRITE_BACK_IN_PROGRESS', reconciliationId: r.id }, { 'retry-after': '1' }),
    });
    await openApp(backend(), `/cockpit/r/${REALM_A}/mietabgleich/${r.id}`);
    fireEvent.click(await screen.findByRole('button', { name: 'An MRE übertragen' }));
    expect(await screen.findByText(/Bitte warten/)).toBeTruthy();
    expect(button('An MRE übertragen').disabled).toBe(true);
    expect(button('Zuordnung aufheben').disabled).toBe(true);
    await waitFor(() => expect(button('An MRE übertragen').disabled).toBe(false), { timeout: 3000 });
    await settle();
    expect(requests(backend(), 'POST', MRE_COMMANDS)).toHaveLength(1);
    expect(backend().counters.mreWrites).toBe(0);
  });

  it('REMOVAL_TOO_EARLY: the removal waits until notBefore, then is offered again; no second request by itself', async () => {
    const t = backend().seedRent('CONFIRMED');
    const r = backend().seedReconciliation(t, { status: 'RELEASED', mreWriteBackState: 'REMOVAL_REQUIRED', version: 5 });
    backend().fault(`POST /api/v1/rent-reconciliations/${r.id}/remove-from-mre`, {
      answer: () => envelope(409, 'CONFLICT', { reason: 'REMOVAL_TOO_EARLY', notBefore: new Date(Date.now() + 1200).toISOString() }),
    });
    await openApp(backend(), `/cockpit/r/${REALM_A}/mietabgleich/${r.id}`);
    fireEvent.click(await screen.findByRole('button', { name: 'Aus MRE entfernen' }));
    expect(await screen.findByText(/Bitte warten/)).toBeTruthy();
    expect(button('Aus MRE entfernen').disabled).toBe(true);
    await waitFor(() => expect(button('Aus MRE entfernen').disabled).toBe(false), { timeout: 3000 });
    expect(requests(backend(), 'POST', MRE_COMMANDS)).toHaveLength(1);
    click('Aus MRE entfernen');
    expect(await screen.findByText('MRE: entfernt')).toBeTruthy();
    expect(requests(backend(), 'POST', MRE_COMMANDS)).toHaveLength(2);
  });
});

describe('412: changed in the meantime; the draft stays, nothing is overwritten silently', () => {
  it('split: another tab changed the booking; the draft stays value for value, the server is unchanged; the next save goes with the new version', async () => {
    const t = backend().seedRent('IMPORTED');
    await openApp(backend(), `/cockpit/r/${REALM_A}/buchungen/${t.id}`);
    await splitRent(PROPERTY, false);
    // While the draft is typed, another tab changes the booking.
    Object.assign(t, { version: 2, description: 'Miete Oktober (anderer Tab)' });
    const reads = requests(backend(), 'GET', `/api/v1/transactions/${t.id}`).length;
    click('Aufteilung speichern');
    await screen.findByRole('heading', { name: 'Inzwischen geändert' });
    expect([control('split-0-amount').value, control('split-1-amount').value]).toEqual(['700,00', '150,00']);
    expect(t.splits).toEqual([]);
    await settle();
    // Nothing by itself: no second save, no read that would replace the draft.
    expect(requests(backend(), 'PUT', PUT_SPLITS)).toHaveLength(1);
    expect(requests(backend(), 'GET', `/api/v1/transactions/${t.id}`)).toHaveLength(reads);
    click('Entwurf behalten und Serverstand ansehen');
    await screen.findByText(/Aktueller Stand auf dem Server: Version 2/);
    click('Aufteilung speichern');
    await screen.findByText(/Aufteilung gespeichert \(Version 3/);
    expect(ifMatches('PUT', PUT_SPLITS)).toEqual(['"1"', '"2"']);
    expect(t.splits.map((s) => s.amount.toJSON().amount)).toEqual(['700.00', '150.00']);
    expect(t.description).toBe('Miete Oktober (anderer Tab)');
  });

  it('rent match: the amount typed stays after a 412, the state is read only on request, then confirmed with the new version', async () => {
    const t = backend().seedRent('CONFIRMED');
    const r = backend().seedReconciliation(t);
    await openApp(backend(), `/cockpit/r/${REALM_A}/mietabgleich/${r.id}`);
    type(await screen.findByLabelText('Zu bestätigender Betrag (€)'), '800,00');
    r.version = 2;
    const reads = requests(backend(), 'GET', `/api/v1/rent-reconciliations/${r.id}`).length;
    click('Zuordnung bestätigen');
    expect(await screen.findByText(/Betrag und Grund bleiben stehen/)).toBeTruthy();
    expect(control('bestaetigen-betrag').value).toBe('800,00');
    expect(r.status).toBe('SUGGESTED');
    await settle();
    expect(requests(backend(), 'GET', `/api/v1/rent-reconciliations/${r.id}`)).toHaveLength(reads);
    click('Aktuellen Stand laden');
    await waitFor(() => expect(button('Zuordnung bestätigen').disabled).toBe(false));
    click('Zuordnung bestätigen');
    expect(await screen.findByText('Zuordnung bestätigt')).toBeTruthy();
    expect(ifMatches('POST', `/api/v1/rent-reconciliations/${r.id}/confirm`)).toEqual(['"1"', '"2"']);
    expect(r.matchedAmount.toJSON()).toEqual({ amount: '800.00', currency: 'EUR' });
  });
});

describe('413 and the size cap of the import', () => {
  it('413 from the server: the size is explained, no resend is offered, nothing imported', async () => {
    // The server stays authoritative over the cap (imports.ts answers 413 VALIDATION_ERROR with maxBytes).
    backend().fault('POST /api/v1/imports/bank-transactions', { answer: () => envelope(413, 'VALIDATION_ERROR', { maxBytes: 5 * 1024 * 1024 }) });
    await openApp(backend(), IMPORT);
    const before = backend().transactions.size;
    await chooseFile();
    click('Import ausführen');
    expect(await screen.findByText('Zu groß')).toBeTruthy();
    expect(screen.getByText(/Der Server nimmt höchstens 5 MiB an/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Dieselbe Datei erneut senden' })).toBeNull();
    expect(window.location.pathname).toBe(IMPORT);
    expect(backend().transactions.size).toBe(before);
    expect(requests(backend(), 'POST', '/api/v1/imports/bank-transactions')).toHaveLength(1);
  });

  it('a file over 5 MiB is not sent at all', async () => {
    await openApp(backend(), IMPORT);
    await chooseFile(csvFile('x'.repeat(5 * 1024 * 1024 + 1)));
    expect(screen.getByText(/Die Datei ist größer als 5 MiB/)).toBeTruthy();
    expect(button('Import ausführen').disabled).toBe(true);
    fireEvent.submit(screen.getByRole('form', { name: 'Datei importieren' }));
    await settle();
    expect(commands(backend())).toEqual([]);
  });
});

describe('MRE unreachable: no coverage claimed, the write-back refused and recorded, nothing claimed paid', () => {
  it('DE cannot verify the token with MRE: 503 at the access check, said with its wait, checked again only on request', async () => {
    backend().guardUp = false;
    await openApp(backend(), `/cockpit/r/${REALM_A}/buchungen`);
    expect(await screen.findByText('Dienst nicht erreichbar')).toBeTruthy();
    expect(screen.getByText(/Frühestens in 5 Sekunden erneut versuchen/)).toBeTruthy();
    await settle();
    expect(requests(backend(), 'GET', '/api/v1/health')).toHaveLength(1);
    backend().guardUp = true;
    click('Erneut prüfen');
    expect(await screen.findByText('Gutschrift Testversicherung')).toBeTruthy();
    expect(requests(backend(), 'GET', '/api/v1/health')).toHaveLength(2);
    expect(commands(backend())).toEqual([]);
  });

  it('coverage of the term: UNAVAILABLE, no statement about payment, DE matches still listed', async () => {
    const t = backend().seedRent('CONFIRMED');
    backend().seedReconciliation(t, { status: 'CONFIRMED', version: 2 });
    backend().mreUp = false;
    await openApp(backend(), rentTermPath(REALM_A, { mreTenantId: TENANT, mreRentTerm: TERM_OCT }));
    expect(await screen.findByText(/MRE war nicht erreichbar oder antwortete unerwartet/)).toBeTruthy();
    expect(screen.getByText(/Keine Aussage möglich/)).toBeTruthy();
    expect(screen.queryByText(/Offener Betrag/)).toBeNull();
    expect(document.body.textContent).not.toMatch(/bezahlt|Vollständig zugeordnet|(?<![\d.])0,00/);
    expect(within(screen.getByRole('list', { name: 'Zuordnungen in DE' })).getByText(/850,00/)).toBeTruthy();
    expect(commands(backend())).toEqual([]);
  });

  it('write-back while MRE is down: 503 explained, FAILED read back, the button waits for Retry-After, then succeeds on a new click', async () => {
    const t = backend().seedRent('CONFIRMED');
    const r = backend().seedReconciliation(t, { status: 'CONFIRMED', version: 2 });
    backend().mreUp = false;
    await openApp(backend(), `/cockpit/r/${REALM_A}/mietabgleich/${r.id}`);
    fireEvent.click(await screen.findByRole('button', { name: 'An MRE übertragen' }));
    expect(await screen.findByText('Dienst nicht erreichbar')).toBeTruthy();
    expect(await screen.findByText('MRE: Übertragung fehlgeschlagen')).toBeTruthy();
    expect(screen.queryByText('MRE: übertragen')).toBeNull();
    expect(screen.queryByText(/die Zahlung steht jetzt im Termin in MRE/)).toBeNull();
    expect(button('An MRE übertragen').disabled).toBe(true);
    expect(backend().mreTerm.payments.map((p) => p.reference)).toEqual([null]);
    backend().mreUp = true;
    await waitFor(() => expect(button('An MRE übertragen').disabled).toBe(false), { timeout: 3000 });
    expect(requests(backend(), 'POST', MRE_COMMANDS)).toHaveLength(1);
    click('An MRE übertragen');
    expect(await screen.findByText('MRE: übertragen')).toBeTruthy();
    expect(ifMatches('POST', MRE_COMMANDS)).toEqual(['"2"', '"3"']);
    expect(backend().counters.mreWrites).toBe(1);
  });

  it('suggest while MRE is down: nothing written, the wait is said', async () => {
    backend().seedRent('CONFIRMED');
    backend().mreUp = false;
    await openApp(backend(), `/cockpit/r/${REALM_A}/mietabgleich`);
    type(await screen.findByLabelText('Erster Monat'), '2026-10');
    type(screen.getByLabelText('Letzter Monat'), '2026-10');
    click('Vorschläge ermitteln');
    expect(await screen.findByText(/Es wurde nichts geschrieben/)).toBeTruthy();
    expect(screen.getByText(/Frühestens in 10 Sekunden/)).toBeTruthy();
    expect(backend().reconciliations.size).toBe(0);
  });
});

describe('a lost answer: the same intent again, the server deduplicates, nothing booked twice', () => {
  it('correction: Erneut senden repeats body, If-Match and Idempotency-Key; one reversal and one replacement', async () => {
    const t = backend().seedRent('CONFIRMED');
    backend().fault(`POST /api/v1/transactions/${t.id}/correct`, { lose: true });
    await openApp(backend(), `/cockpit/r/${REALM_A}/buchungen/${t.id}`);
    await correctDescription();
    expect(await screen.findByText(/Ob die Korrektur ausgeführt wurde, ist unklar/)).toBeTruthy();
    expect(t.status).toBe('CORRECTED');
    click('Erneut senden');
    await screen.findByRole('heading', { name: 'Korrektur ausgeführt' });
    const sent = requests(backend(), 'POST', `/api/v1/transactions/${t.id}/correct`);
    expect(sent).toHaveLength(2);
    const key = sent[0]?.headers.get('idempotency-key');
    expect(key).toMatch(/^[\x21-\x7e]{1,255}$/);
    expect(sent.map((s) => s.headers.get('idempotency-key'))).toEqual([key, key]);
    expect(sent.map((s) => s.headers.get('if-match'))).toEqual(['"3"', '"3"']);
    expect(sent[1]?.body).toBe(sent[0]?.body);
    const chain = [...backend().transactions.values()].filter((x) => x.correctionOfTransactionId === t.id);
    expect(chain.map((x) => x.correctionRole).sort()).toEqual(['REPLACEMENT', 'REVERSAL']);
  });

  it('import: the same file again; its rows come back as duplicates, no booking twice', async () => {
    backend().fault('POST /api/v1/imports/bank-transactions', { lose: true });
    await openApp(backend(), IMPORT);
    await chooseFile();
    click('Import ausführen');
    expect(await screen.findByText(/Ob die Datei importiert wurde, ist unklar/)).toBeTruthy();
    const after = backend().transactions.size;
    click('Dieselbe Datei erneut senden');
    await screen.findByRole('heading', { name: 'Ergebnis des Imports' });
    const rows = screen.getAllByRole('row').slice(1);
    expect(rows.map((row) => row.querySelectorAll('td')[1]?.textContent)).toEqual(['Duplikat', 'Duplikat', 'Klärfall']);
    expect(backend().transactions.size).toBe(after);
    const [first, second] = requests(backend(), 'POST', '/api/v1/imports/bank-transactions');
    expect(second?.form?.get('metadata')).toBe(first?.form?.get('metadata'));
    expect(second?.form?.get('file')).toBe(first?.form?.get('file'));
  });

  it('confirm: the same confirm again is a no-op on the server; the booking is confirmed once', async () => {
    const t = backend().seedRent('CLASSIFIED');
    backend().fault(`POST /api/v1/transactions/${t.id}/confirm`, { lose: true });
    await openApp(backend(), `/cockpit/r/${REALM_A}/buchungen/${t.id}`);
    fireEvent.click(await screen.findByRole('button', { name: 'Buchung bestätigen' }));
    click('Jetzt bestätigen');
    expect(await screen.findByText(/Ob die Buchung bestätigt wurde, ist unklar/)).toBeTruthy();
    click('Erneut senden');
    await screen.findByText(/Buchung bestätigt \(Version 3/);
    expect(ifMatches('POST', /\/confirm$/)).toEqual(['"2"', '"2"']);
    expect([t.status, t.version]).toEqual(['CONFIRMED', 3]);
  });

  it('split: the same set again with the same If-Match; the server keeps one version, nothing doubled', async () => {
    const t = backend().seedRent('IMPORTED');
    backend().fault(`PUT /api/v1/transactions/${t.id}/splits`, { lose: true });
    await openApp(backend(), `/cockpit/r/${REALM_A}/buchungen/${t.id}`);
    await splitRent(PROPERTY);
    expect(await screen.findByText(/Ob die Aufteilung gespeichert wurde, ist unklar/)).toBeTruthy();
    expect([t.version, t.splits.length]).toEqual([2, 2]);
    click('Erneut senden');
    await screen.findByText(/Aufteilung gespeichert \(Version 2/);
    const sent = requests(backend(), 'PUT', PUT_SPLITS);
    expect(sent.map((s) => s.headers.get('if-match'))).toEqual(['"1"', '"1"']);
    expect(sent[1]?.body).toBe(sent[0]?.body);
    expect(sent.some((s) => s.headers.has('idempotency-key'))).toBe(false);
    expect([t.version, t.splits.length]).toEqual([2, 2]);
  });

  it('write-back: no answer; the detail is read again and shows it written; no second write to MRE', async () => {
    const t = backend().seedRent('CONFIRMED');
    const r = backend().seedReconciliation(t, { status: 'CONFIRMED', version: 2 });
    backend().fault(`POST /api/v1/rent-reconciliations/${r.id}/write-back-to-mre`, { lose: true });
    await openApp(backend(), `/cockpit/r/${REALM_A}/mietabgleich/${r.id}`);
    fireEvent.click(await screen.findByRole('button', { name: 'An MRE übertragen' }));
    expect(await screen.findByText('Keine Antwort')).toBeTruthy();
    expect(await screen.findByText('MRE: übertragen')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'An MRE übertragen' })).toBeNull();
    expect(requests(backend(), 'POST', MRE_COMMANDS)).toHaveLength(1);
    expect(backend().counters.mreWrites).toBe(1);
  });
});

describe('an unknown enum or a new error code is text, never a blank page', () => {
  it('a new booking status and a new refusal code are shown with their code; the page stays', async () => {
    const t = backend().seedRent('CLASSIFIED');
    backend().fault(`POST /api/v1/transactions/${t.id}/confirm`, { answer: () => envelope(409, 'BRAND_NEW_CODE', { reason: 'BRAND_NEW_REASON' }) });
    await openApp(backend(), `/cockpit/r/${REALM_A}/buchungen/${t.id}`);
    fireEvent.click(await screen.findByRole('button', { name: 'Buchung bestätigen' }));
    click('Jetzt bestätigen');
    expect(await screen.findByText(/Code BRAND_NEW_CODE/)).toBeTruthy();
    expect(screen.getByRole('heading', { name: /Buchung vom/ })).toBeTruthy();
    expect(t.status).toBe('CLASSIFIED');
    t.status = 'ARCHIVED_IN_FUTURE';
    await go(`/cockpit/r/${REALM_A}/buchungen`);
    expect(await screen.findByText(/ARCHIVED_IN_FUTURE/)).toBeTruthy();
    expect(commands(backend())).toEqual([`POST /api/v1/transactions/${t.id}/confirm`]);
  });

  it('a new booking status on the detail: shown with its code; no split, confirm or correction is offered', async () => {
    const t = backend().seedRent('CLASSIFIED');
    t.status = 'PARKED_IN_FUTURE';
    await openApp(backend(), `/cockpit/r/${REALM_A}/buchungen/${t.id}`);
    expect((await screen.findAllByText(/PARKED_IN_FUTURE/)).length).toBeGreaterThan(0);
    expect(screen.getByRole('heading', { name: /Buchung vom/ })).toBeTruthy();
    for (const name of ['Buchung bestätigen', 'Aufteilung speichern', 'Korrektur erfassen']) expect(screen.queryByRole('button', { name })).toBeNull();
    expect(commands(backend())).toEqual([]);
  });

  it('a new MRE state of a match: shown with its code, no MRE action offered', async () => {
    const t = backend().seedRent('CONFIRMED');
    const r = backend().seedReconciliation(t, { status: 'CONFIRMED', mreWriteBackState: 'QUEUED_IN_FUTURE', version: 2 });
    await openApp(backend(), `/cockpit/r/${REALM_A}/mietabgleich/${r.id}`);
    expect(await screen.findByText(/QUEUED_IN_FUTURE/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'An MRE übertragen' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Aus MRE entfernen' })).toBeNull();
    expect(commands(backend())).toEqual([]);
  });
});
