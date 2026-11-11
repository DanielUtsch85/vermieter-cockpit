// @vitest-environment jsdom
import { fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { REALM_A, REALM_B } from '../transactions/fixtures.test-support';
import { EMAIL } from './fake-backend.test-support';
import { act, click, go, IMPORT, importCsv, openApp, showAllRows, type, useDurchstich } from './walk.test-support';

/**
 * „Alle Zeilen“ as `?zeilen=alle` across the whole App (Entscheidung des Projektinhabers, 2026-11-11, zu #344): the
 * parameter belongs to the URL of one import's result. It is not carried into another page or another Realm, the
 * Realm prefix of the path stays, and the way back after an expired session returns to the same view (path and search,
 * as the return URL of #319). Against the App with a real Session and the stateful fake backend, `fireEvent` only.
 */

const backend = useDurchstich();
const here = () => `${window.location.pathname}${window.location.search}`;
const EXPIRED = 'Ihre Sitzung ist abgelaufen. Bitte melden Sie sich erneut an.';
const outcomes = () =>
  screen
    .getAllByRole('row')
    .slice(1)
    .map((row) => row.querySelectorAll('td')[1]?.textContent);
const hrefs = () => [...document.querySelectorAll('a')].map((a) => a.getAttribute('href') ?? '');

/** Imports the synthetic file and shows every row: the batch's URL with `?zeilen=alle`. */
async function importedWithAllRows(): Promise<string> {
  await openApp(backend(), IMPORT);
  await importCsv();
  const batchPath = window.location.pathname;
  expect(batchPath).toMatch(new RegExp(`^/cockpit/r/${REALM_A}/import/[0-9a-f-]{36}$`));
  expect(outcomes()).toEqual(['Klärfall']);
  showAllRows();
  expect(here()).toBe(`${batchPath}?zeilen=alle`);
  expect(outcomes()).toEqual(['Neu angelegt', 'Neu angelegt', 'Klärfall']);
  return batchPath;
}

describe('zeilen=alle stays on the URL of its import result', () => {
  it('no link of the page carries it; another area and the same import opened by a link show their default', async () => {
    const batchPath = await importedWithAllRows();
    const links = hrefs();
    expect(links.length).toBeGreaterThan(4);
    expect(links.filter((href) => href.includes('zeilen'))).toEqual([]);
    expect(links.filter((href) => href.startsWith('/cockpit/r/')).every((href) => href.startsWith(`/cockpit/r/${REALM_A}/`))).toBe(true);
    // Another page of the Realm: its own URL, without the parameter.
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Hauptnavigation' })).getByRole('link', { name: 'Buchungen' }), { button: 0 });
    expect(here()).toBe(`/cockpit/r/${REALM_A}/buchungen`);
    await screen.findByRole('heading', { name: 'Buchungen' });
    // The same import by its link again: the default view, the parameter is not remembered anywhere else.
    await go(batchPath);
    await screen.findByRole('heading', { name: 'Ergebnis des Imports' });
    expect(outcomes()).toEqual(['Klärfall']);
    expect(screen.getByRole('button', { name: 'Alle Zeilen' }).getAttribute('aria-pressed')).toBe('false');
    // The upload page reads nothing from it.
    await go(`${IMPORT}?zeilen=alle`);
    await screen.findByLabelText('CSV-Datei');
    expect(screen.queryByRole('button', { name: 'Alle Zeilen' })).toBeNull();
  });

  it('another Realm: the Realm choice links without it, and another Realm in the address bar is a reload, never this view', async () => {
    const batchPath = await importedWithAllRows();
    const otherRealm = batchPath.replace(`/r/${REALM_A}/`, `/r/${REALM_B}/`);
    await act(() => {
      window.history.pushState(null, '', `${otherRealm}?zeilen=alle`);
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    expect(await screen.findByText('Die Seite wird für den anderen Bestand neu geladen …')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Alle Zeilen' })).toBeNull();
    expect(backend().sent.some((s) => s.headers.get('organizationid') === REALM_B)).toBe(false);
  });

  it('the Realm choice under a URL with the parameter links every Realm without it', async () => {
    await openApp(backend(), '/cockpit/?zeilen=alle');
    const choice = await screen.findByRole('list', { name: 'Bestände' });
    expect(
      within(choice)
        .getAllByRole('link')
        .map((a) => a.getAttribute('href')),
    ).toEqual([`/cockpit/r/${REALM_A}/`, `/cockpit/r/${REALM_B}/`]);
  });
});

describe('the way back after an expired session keeps the view', () => {
  it('signed in again, the same import with every row: path and zeilen=alle as before', async () => {
    const batchPath = await importedWithAllRows();
    backend().expireSession();
    click('Ergebnis neu laden');
    expect(await screen.findByText(EXPIRED)).toBeTruthy();
    expect(here()).toBe(`${batchPath}?zeilen=alle`);
    type(screen.getByLabelText('E-Mail-Adresse'), EMAIL);
    type(screen.getByLabelText('Passwort'), 'synthetisch');
    click('Anmelden');
    await screen.findByRole('heading', { name: 'Ergebnis des Imports' });
    await screen.findByRole('button', { name: 'Alle Zeilen', pressed: true });
    expect(here()).toBe(`${batchPath}?zeilen=alle`);
    expect(outcomes()).toEqual(['Neu angelegt', 'Neu angelegt', 'Klärfall']);
  });
});
