// @vitest-environment jsdom
import { fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { REALM_A } from '../transactions/fixtures.test-support';
import { click, commands, go, MIETABGLEICH, openApp, requests, suggestOctober, useDurchstich } from './walk.test-support';

/**
 * #381 part 2 in the Durchstich (api-design.md §30.1A, VC-X-81; Entscheidung des Projektinhabers, 2026-11-17): the
 * Buchungsliste shows a confirmed rent payment as „Miete nicht zugeordnet“ before and „Miete zugeordnet“ after the
 * confirmed match, and the shortcut „Mietanteil noch frei“ finds it before and not after. Against the whole App and the
 * stateful fake backend, whose list answers each item's `rentAllocation` by the backend's own rule and DTO mapping
 * (`rentAllocationOf`, `toRentAllocationDto`). The confirmed booking is seeded (`seedRent`); no write but the match.
 */

const backend = useDurchstich();
const LIST = `/cockpit/r/${REALM_A}/buchungen`;
/** The status cell of the list's only row of that booking date. */
const statusCell = async () => {
  const link = await screen.findByRole('link', { name: 'Buchung vom 01.10.2026 öffnen' });
  const row = link.closest('tr');
  if (row === null) throw new Error('no row');
  return row.querySelectorAll('td')[4]?.textContent;
};
const shortcut = () => screen.getByRole<HTMLInputElement>('checkbox', { name: 'Mietanteil noch frei' });

describe('Mietzuordnung in der Buchungsliste (§30.1A)', () => {
  it('„Miete nicht zugeordnet“ and found by „Mietanteil noch frei“ before the match; „Miete zugeordnet“ and not found after it', async () => {
    const t = backend().seedRent('CONFIRMED');
    await openApp(backend(), LIST);
    expect(await statusCell()).toBe('BestätigtMiete nicht zugeordnet');

    // The shortcut: one request with rentAllocation=NONE,PARTIAL, the URL says the same, the booking is listed.
    fireEvent.click(shortcut());
    click('Filter anwenden');
    expect(await statusCell()).toBe('BestätigtMiete nicht zugeordnet');
    expect(window.location.search).toBe('?rentAllocation=NONE%2CPARTIAL');
    expect(shortcut().checked).toBe(true);
    expect(requests(backend(), 'GET', '/api/v1/transactions').at(-1)?.search).toBe('?rentAllocation=NONE%2CPARTIAL&page=1&pageSize=50');

    // Confirm the October match on the page „Mietabgleich“ (suggest, review, confirm), as the main walk does.
    await go(MIETABGLEICH);
    await suggestOctober();
    await screen.findByText('1 neuer Vorschlag für 2026-10 bis 2026-10.');
    fireEvent.click(within(screen.getByRole('list', { name: 'Neue Vorschläge' })).getByRole('link', { name: 'Vorschlag prüfen' }), { button: 0 });
    fireEvent.click(await screen.findByRole('button', { name: 'Zuordnung bestätigen' }));
    await screen.findByText('Zuordnung bestätigt');

    // The shortcut's list (restored from the URL) no longer holds it; without the filter it reads „Miete zugeordnet“.
    await go(`${LIST}?rentAllocation=NONE%2CPARTIAL`);
    expect(await screen.findByText('Keine Buchung passt zu diesen Filtern.')).toBeTruthy();
    expect(shortcut().checked).toBe(true);
    await go(LIST);
    expect(await statusCell()).toBe('BestätigtMiete zugeordnet');
    // Still „Bestätigt“: the match never sets RECONCILED (§35.4, P4-D3).
    expect(t.status).toBe('CONFIRMED');
    expect(commands(backend())).toEqual([
      'POST /api/v1/rent-reconciliations/suggest',
      `POST /api/v1/rent-reconciliations/${[...backend().reconciliations.keys()][0] ?? ''}/confirm`,
    ]);
  });
});
