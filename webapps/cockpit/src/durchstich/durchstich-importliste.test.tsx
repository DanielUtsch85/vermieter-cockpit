// @vitest-environment jsdom
import { fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { REALM_A } from '../transactions/fixtures.test-support';
import { CSV_NAME } from './fake-backend.test-support';
import { go, IMPORT, importCsv, openApp, requests, useDurchstich } from './walk.test-support';

/**
 * Issue #369's acceptance against the App and the stateful fake backend (`fireEvent` only): an import with open review
 * items is reached again without its address, from „Bisherige Importe“ under the import form (api-design.md §32.6;
 * Entscheidung des Projektinhabers, 2026-11-16), and after the decision the list says the import is completed.
 */

const backend = useDurchstich();
const list = () => screen.findByRole('region', { name: 'Bisherige Importe' });

describe('Bisherige Importe in the Durchstich (#369)', () => {
  it('an import with open review items is found again from the import page, decided there, and then listed as completed', async () => {
    await openApp(backend(), IMPORT);
    expect(await within(await list()).findByText('Noch keine Importe in diesem Bestand.')).toBeTruthy();
    await importCsv();
    const batchPath = window.location.pathname;

    // Away from the import, then back to the import page by the navigation: the address of the batch is not needed.
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Hauptnavigation' })).getByRole('link', { name: 'Buchungen' }), { button: 0 });
    await screen.findByRole('heading', { name: 'Buchungen' });
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Hauptnavigation' })).getByRole('link', { name: 'Import' }), { button: 0 });
    const highlighted = await within(await list()).findByRole('listitem', { name: `${CSV_NAME}, Klärfälle offen` });
    expect(within(highlighted).getByText('1 offener Klärfall')).toBeTruthy();
    expect(highlighted.textContent).toContain('2 neue Buchungen');
    fireEvent.click(within(highlighted).getByRole('link', { name: 'Klärfälle bearbeiten' }), { button: 0 });
    expect(window.location.pathname).toBe(batchPath);
    await screen.findByRole('article', { name: /Klärfall Zeile/ });

    fireEvent.click(await screen.findByRole('button', { name: 'Nicht als neue Buchung übernehmen' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Jetzt nicht übernehmen' }));
    await screen.findByText(/Entschieden: /);
    await go(IMPORT);
    const completed = await within(await list()).findByRole('listitem', { name: CSV_NAME });
    expect(within(completed).getByText('Abgeschlossen')).toBeTruthy();
    expect(within(completed).getByRole('link', { name: 'Ergebnis öffnen' }).getAttribute('href')).toBe(batchPath);

    // Each read of the list is the first page of Realm A, without a filter.
    const reads = requests(backend(), 'GET', '/api/v1/imports');
    expect(reads.length).toBeGreaterThanOrEqual(3);
    expect(reads.every((s) => s.search === '?page=1&pageSize=20' && s.headers.get('organizationid') === REALM_A)).toBe(true);
  });
});
