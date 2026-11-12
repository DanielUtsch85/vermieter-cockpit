// @vitest-environment jsdom
import { fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { PROPERTY, REALM_A } from '../transactions/fixtures.test-support';
import {
  csvFile,
  go,
  IMPORT,
  importCsv,
  MIETABGLEICH,
  openApp,
  openTransaction,
  resolveCreate,
  settle,
  splitRent,
  suggestOctober,
  useDurchstich,
} from './walk.test-support';

/**
 * Issue #352 des Projektinhabers, 2026-11-12, point 3, acceptance: no text of the cockpit says „If-Match“ or „ETag“
 * outside a `<details>` block „Technische Angaben“. Walked through every page and dialog that sends a version (the
 * whole App against the fake backend, `fireEvent` only); the headers themselves are asserted by the Durchstich and the
 * component tests.
 */

const backend = useDurchstich();
const TECHNICAL = /If-Match|ETag/;

/** The text a user reads without opening a „Technische Angaben“ block. */
function visibleText(): string {
  const copy = document.body.cloneNode(true) as HTMLElement;
  for (const details of copy.querySelectorAll('details')) details.remove();
  return copy.textContent ?? '';
}

/** The text of the collapsed blocks: where the version and the ids are kept. */
const detailsText = () => [...document.querySelectorAll('details')].map((d) => d.textContent ?? '').join(' | ');

async function expectNoTechnicalText(where: string) {
  await settle();
  expect(visibleText(), where).not.toMatch(TECHNICAL);
  for (const details of document.querySelectorAll('details')) {
    expect(details.open, where).toBe(false);
    expect(details.querySelector('summary')?.textContent, where).toBe('Technische Angaben');
  }
}

describe('no If-Match and no ETag in the visible text (Issue #352, point 3)', () => {
  it('overview, import, booking with split, confirm, correction and reversal forms, rent match and its MRE steps', async () => {
    await openApp(backend(), `/cockpit/r/${REALM_A}/`);
    await screen.findByText('Zugriff bestätigt für diesen Bestand');
    await expectNoTechnicalText('overview');
    expect(visibleText()).not.toMatch(/Durchstich|Backend-Stand/);
    expect(detailsText()).toContain(REALM_A);

    await go(IMPORT);
    await importCsv(csvFile());
    await expectNoTechnicalText('import result');
    await resolveCreate();
    await expectNoTechnicalText('review item decided');

    await openTransaction(backend(), 'Miete Oktober Testwohnung');
    await splitRent(PROPERTY, false);
    await expectNoTechnicalText('split draft');
    fireEvent.click(screen.getByRole('button', { name: 'Aufteilung speichern' }));
    await screen.findByText(/Aufteilung gespeichert \(Version 2/);
    await expectNoTechnicalText('split saved');
    await screen.findByText(/ETag "2"/);
    expect(detailsText()).toContain(backend().tx('Miete Oktober Testwohnung').id);

    fireEvent.click(screen.getByRole('button', { name: 'Buchung bestätigen' }));
    expect(within(screen.getByRole('region', { name: 'Bestätigen' })).getByRole('dialog')).toBeTruthy();
    await expectNoTechnicalText('confirm step');
    fireEvent.click(screen.getByRole('button', { name: 'Jetzt bestätigen' }));
    await screen.findByText(/Buchung bestätigt \(Version 3/);
    await expectNoTechnicalText('confirmed');

    fireEvent.click(await screen.findByRole('button', { name: 'Korrektur erfassen' }));
    await expectNoTechnicalText('correction form');
    fireEvent.click(screen.getByRole('button', { name: 'Stornieren' }));
    fireEvent.change(document.getElementById('storno-reason') as HTMLTextAreaElement, { target: { value: 'Doppelt erfasst' } });
    fireEvent.click(screen.getByRole('button', { name: 'Storno ausführen' }));
    expect(screen.getByRole('button', { name: 'Jetzt stornieren' })).toBeTruthy();
    await expectNoTechnicalText('reversal step');
    fireEvent.click(screen.getByRole('button', { name: 'Abbrechen' }));

    await go(MIETABGLEICH);
    await suggestOctober();
    await screen.findByText('1 neuer Vorschlag für 2026-10 bis 2026-10.');
    await expectNoTechnicalText('rent suggestions');
    fireEvent.click(within(screen.getByRole('list', { name: 'Neue Vorschläge' })).getByRole('link', { name: 'Vorschlag prüfen' }), { button: 0 });
    fireEvent.click(await screen.findByRole('button', { name: 'Zuordnung bestätigen' }));
    await screen.findByText('Zuordnung bestätigt');
    await expectNoTechnicalText('rent match confirmed');
    expect(detailsText()).toMatch(/Version\s*2 \(ETag "2"\)/);
    fireEvent.click(screen.getByRole('button', { name: 'An MRE übertragen' }));
    expect(screen.getByRole('dialog', { name: 'Zahlung jetzt an MRE übertragen?' })).toBeTruthy();
    await expectNoTechnicalText('write-back step');
    // The exception of the rent area (Entscheidung des Projektinhabers, 2026-11-11): Tenant id and term key stay visible.
    const [rec] = [...backend().reconciliations.values()];
    expect(visibleText()).toContain(rec?.mreTenantId ?? 'no reconciliation');
    expect(visibleText()).toContain(rec?.mreRentTerm ?? 'no reconciliation');
  }, 30_000);
});
