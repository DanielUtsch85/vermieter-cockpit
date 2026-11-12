// @vitest-environment jsdom
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { TENANT } from '../rent/fixtures.test-support';
import { rentTermPath } from '../routing';
import { PROPERTY, REALM_A } from '../transactions/fixtures.test-support';
import {
  click,
  confirmTransaction,
  csvFile,
  go,
  IMPORT,
  importCsv,
  MIETABGLEICH,
  mreWrite,
  openApp,
  openTransaction,
  settle,
  splitRent,
  suggestOctober,
  type,
  useDurchstich,
} from './walk.test-support';
import { TERM_OCT } from './fake-backend.test-support';

/**
 * Issue #353 des Projektinhabers, 2026-11-12, points 5 and 6 (the whole App against the fake backend, `fireEvent`
 * only): the `h1` names the page, a sub-page has its area in the breadcrumbs and in the browser tab, the focus lands on
 * the `h1` after a navigation, and on every page of the walk (and in every dialog of it) the headings never skip a
 * level.
 */

const backend = useDurchstich();
const REALM = 'Bestand Nord';

const levelOf = (heading: Element) => Number(heading.tagName.slice(1));

/** The headings of the page in document order, each as `h2 Korrekturen`. */
const outline = () => [...document.querySelectorAll('h1, h2, h3, h4, h5, h6')].map((h) => `h${levelOf(h)} ${h.textContent ?? ''}`);

/**
 * One `h1`, first, naming the page; after it no heading is more than one level below the heading before it (a step
 * back up is always allowed).
 */
async function expectOutline(where: string, title: string) {
  await settle();
  const headings = [...document.querySelectorAll('h1, h2, h3, h4, h5, h6')];
  expect(
    headings.filter((h) => h.tagName === 'H1').map((h) => h.textContent),
    where,
  ).toEqual([title]);
  expect(headings[0]?.tagName, where).toBe('H1');
  for (let i = 1; i < headings.length; i += 1) {
    const [before, current] = [headings[i - 1], headings[i]];
    if (before === undefined || current === undefined) continue;
    expect(levelOf(current) - levelOf(before), `${where}: ${outline().join(' > ')}`).toBeLessThanOrEqual(1);
  }
}

const h1 = () => screen.getByRole('heading', { level: 1 });

/** The rent of the walk imported, then the list of the Buchungen area. */
async function listWithRent() {
  await openApp(backend(), IMPORT);
  await importCsv(csvFile());
  await go(`/cockpit/r/${REALM_A}/buchungen`);
  await screen.findByText('Miete Oktober Testwohnung');
}
const crumbs = () => screen.queryByRole('navigation', { name: 'Brotkrumen' });

describe('page titles, breadcrumbs and focus (Issue #353 des Projektinhabers, 2026-11-12, point 5)', () => {
  it('a sub-page: the h1 names the page, the area is in the breadcrumbs and the tab; the focus lands on the h1', async () => {
    await listWithRent();
    expect(h1().textContent).toBe('Buchungen');
    expect(crumbs()).toBeNull();
    expect(document.title).toBe(`Buchungen · ${REALM} · Vermieter Cockpit`);

    fireEvent.click(screen.getByRole('link', { name: 'Buchung vom 01.10.2026 öffnen' }), { button: 0 });
    await waitFor(() => expect(h1().textContent).toBe('Buchung vom 01.10.2026'));
    expect(document.activeElement).toBe(h1());
    expect(document.title).toBe(`Buchung vom 01.10.2026 · Buchungen · ${REALM} · Vermieter Cockpit`);
    const nav = crumbs();
    if (nav === null) throw new Error('no breadcrumbs');
    expect(within(nav).getByRole('link', { name: 'Buchungen' }).getAttribute('href')).toBe(`/cockpit/r/${REALM_A}/buchungen`);
    expect(within(nav).getByText('Buchung vom 01.10.2026').getAttribute('aria-current')).toBe('page');
    // The card of the data is a section of the page, not a second title.
    expect(screen.getByRole('heading', { level: 2, name: 'Angaben zur Buchung' })).toBeTruthy();

    fireEvent.click(within(nav).getByRole('link', { name: 'Buchungen' }), { button: 0 });
    await waitFor(() => expect(h1().textContent).toBe('Buchungen'));
    expect(document.activeElement).toBe(h1());
    expect(crumbs()).toBeNull();
    expect(document.title).toBe(`Buchungen · ${REALM} · Vermieter Cockpit`);
  });

  it('the h1 keeps the focus while the page loads: one element from „Buchung“ to „Buchung vom …“', async () => {
    await listWithRent();
    const heading = h1();
    await openTransaction(backend(), 'Miete Oktober Testwohnung');
    expect(document.activeElement).toBe(heading);
    await waitFor(() => expect(heading.textContent).toBe('Buchung vom 01.10.2026'));
    expect(h1()).toBe(heading);
    expect(document.activeElement).toBe(heading);
  });

  it('import result, reconciliation and term: each names its page; an area page keeps the area as its h1', async () => {
    await openApp(backend(), IMPORT);
    await screen.findByLabelText('CSV-Datei');
    expect(h1().textContent).toBe('Import');
    await importCsv(csvFile());
    await waitFor(() => expect(h1().textContent).toMatch(/^Import vom \d{2}\.\d{2}\.\d{4}, \d{2}:\d{2}$/));
    expect(document.title).toBe(`${h1().textContent ?? ''} · Import · ${REALM} · Vermieter Cockpit`);
    expect(document.activeElement).toBe(h1());

    await go(rentTermPath(REALM_A, { mreTenantId: TENANT, mreRentTerm: TERM_OCT }));
    expect(h1().textContent).toBe('Abdeckung eines Termins');
    expect(document.title).toBe(`Abdeckung eines Termins · Mietabgleich · ${REALM} · Vermieter Cockpit`);
    expect(within(crumbs() ?? document.body).getByRole('link', { name: 'Mietabgleich' })).toBeTruthy();

    await go(MIETABGLEICH);
    expect(h1().textContent).toBe('Mietabgleich');
    expect(crumbs()).toBeNull();
  });
});

describe('heading order on every page of the walk (Issue #353 des Projektinhabers, 2026-11-12, point 6)', () => {
  it('overview, import, review items, list, detail with its sections and dialogs, rent list, match, term: no level skipped', async () => {
    await openApp(backend(), `/cockpit/r/${REALM_A}/`);
    await screen.findByText('Zugriff bestätigt für diesen Bestand');
    await expectOutline('overview', 'Übersicht');

    await go(IMPORT);
    await screen.findByLabelText('CSV-Datei');
    await expectOutline('import', 'Import');
    await importCsv(csvFile());
    const title = () => h1().textContent ?? '';
    await screen.findByRole('button', { name: 'Als eigenständige Buchung übernehmen' });
    await expectOutline('import result', title());
    click('Als eigenständige Buchung übernehmen');
    expect(screen.getByRole('dialog')).toBeTruthy();
    await expectOutline('review item step', title());
    click('Jetzt übernehmen');
    await screen.findByText(/Entschieden: /);

    await go(`/cockpit/r/${REALM_A}/buchungen`);
    await screen.findByText('Miete Oktober Testwohnung');
    await expectOutline('list', 'Buchungen');

    await openTransaction(backend(), 'Miete Oktober Testwohnung');
    await splitRent(PROPERTY, false);
    await expectOutline('detail with draft', 'Buchung vom 01.10.2026');
    click('Aufteilung speichern');
    await screen.findByText(/Aufteilung gespeichert \(Version 2/);
    await expectOutline('detail saved', 'Buchung vom 01.10.2026');
    // The card of the data and its sibling sections are all h2, their parts h3 (point 6).
    expect(outline()).toEqual([
      'h1 Buchung vom 01.10.2026',
      'h2 Angaben zur Buchung',
      'h2 Korrekturen',
      'h2 Aufteilung',
      'h2 Mietabgleich dieser Buchung',
      'h2 Bestätigen',
      'h2 Aufteilung bearbeiten',
      'h3 Aufteilungsvorschlag aus MRE',
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'Buchung bestätigen' }));
    expect(screen.getByRole('dialog', { name: 'Buchung jetzt bestätigen?' })).toBeTruthy();
    await expectOutline('confirm step', 'Buchung vom 01.10.2026');
    click('Abbrechen');
    await confirmTransaction();
    await expectOutline('confirmed', 'Buchung vom 01.10.2026');

    click('Manuell zuordnen');
    type(await screen.findByLabelText('Mieter in MRE (ID)'), TENANT);
    type(screen.getByLabelText('Miettermin (MRE-Schlüssel JJJJMMTTHH)'), TERM_OCT);
    type(screen.getByLabelText('Zuzuordnender Betrag (€)'), '850,00');
    click('Zuordnung anlegen');
    expect(screen.getByRole('dialog', { name: 'Zahlung jetzt manuell zuordnen?' })).toBeTruthy();
    await expectOutline('manual match step', 'Buchung vom 01.10.2026');
    click('Abbrechen');

    fireEvent.click(await screen.findByRole('button', { name: 'Korrektur erfassen' }));
    await expectOutline('correction form', 'Buchung vom 01.10.2026');
    // Point 9: the date fields of the correction name the field only; the browser shows its own format (mm/dd/yyyy in English).
    expect([...document.querySelectorAll<HTMLInputElement>('input[type="date"]')].map((input) => input.labels?.[0]?.textContent)).toEqual([
      'Buchungsdatum',
      'Wertstellung (optional)',
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'Stornieren' }));
    type(document.getElementById('storno-reason') as HTMLTextAreaElement, 'Doppelt erfasst');
    click('Storno ausführen');
    expect(screen.getByRole('dialog', { name: 'Buchung jetzt stornieren?' })).toBeTruthy();
    await expectOutline('reversal step', 'Buchung vom 01.10.2026');
    click('Abbrechen');

    await go(MIETABGLEICH);
    await suggestOctober();
    await screen.findByText('1 neuer Vorschlag für 2026-10 bis 2026-10.');
    await expectOutline('rent list', 'Mietabgleich');
    fireEvent.click(within(screen.getByRole('list', { name: 'Neue Vorschläge' })).getByRole('link', { name: 'Vorschlag prüfen' }), { button: 0 });
    await screen.findByRole('button', { name: 'Zuordnung bestätigen' });
    await expectOutline('suggestion', 'Zuordnung');
    click('Zuordnung bestätigen');
    await screen.findByText('Zuordnung bestätigt');
    await expectOutline('match confirmed', 'Zuordnung');
    click('An MRE übertragen');
    expect(screen.getByRole('dialog', { name: 'Zahlung jetzt an MRE übertragen?' })).toBeTruthy();
    await expectOutline('write-back step', 'Zuordnung');
    click('Abbrechen');
    await mreWrite('An MRE übertragen');
    await screen.findByText('MRE: übertragen');
    await expectOutline('written', 'Zuordnung');

    fireEvent.click(screen.getByRole('link', { name: 'Abdeckung des Termins' }), { button: 0 });
    await screen.findByRole('region', { name: 'Deckung' });
    await expectOutline('term', 'Abdeckung eines Termins');
  });
});
