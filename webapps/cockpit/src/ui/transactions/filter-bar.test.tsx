// @vitest-environment jsdom
import { QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { createDeClient } from '../../api/client';
import { countingTokens, json, routedFetch } from '../../api/fetch.test-support';
import { createQueryClient } from '../../query';
import { readListParams, toApiQuery, toSearch, type ListParams } from '../../transactions/list-params';
import { account, category, page, property, REALM_A } from '../../transactions/fixtures.test-support';
import { FilterBar } from './FilterBar';
import { statusLabel } from './labels';
import type { References } from './references';
import { TransactionListView } from './TransactionList';
import { TransactionsArea } from './TransactionsArea';

/**
 * „Nur zu prüfende“ as a shortcut (Entscheidung des Projektinhabers, 2026-11-10, to #323 F3): while `reviewable` is set,
 * the status choice is empty and locked, so the bar never writes a URL with both. Both stay URL parameters, and a URL
 * that holds both is still asked as it is (the backend's AND, api-design.md §30.1).
 */

const loaded: References = {
  accounts: { status: 'success', data: page([account()]) },
  properties: { status: 'success', data: page([property()]) },
  categories: { status: 'success', data: [category()] },
};

/** The bar for a URL; every applied filter is kept as the search part it navigates to. */
function bar(search: string) {
  const applied: string[] = [];
  render(
    <FilterBar
      params={readListParams(search)}
      references={loaded}
      errors={new Map()}
      resetHref="/cockpit/r/x/buchungen"
      onFilter={(params: ListParams) => applied.push(toSearch(params))}
    />,
  );
  return applied;
}

const shortcut = () => screen.getByRole<HTMLInputElement>('checkbox', { name: 'Nur zu prüfende (Importiert oder Ungeprüft)' });
const statusBoxes = () => [...document.querySelectorAll<HTMLInputElement>('input[name="status"]')];
const status = (name: string) => screen.getByRole<HTMLInputElement>('checkbox', { name });
const apply = () => fireEvent.click(screen.getByRole('button', { name: 'Filter anwenden' }));
const LOCK_NOTE = 'Gesperrt, solange „Nur zu prüfende“ gesetzt ist.';

/** Every applied URL: never `status` together with `reviewable`. */
const neverBoth = (applied: readonly string[]) => {
  for (const search of applied) {
    const query = new URLSearchParams(search);
    expect(query.has('status') && query.has('reviewable'), search).toBe(false);
  }
};

afterEach(cleanup);

describe('the shortcut Nur pruefbare in the filter bar (#323 F3)', () => {
  it('is a labelled checkbox in the tab order, reached by its name', () => {
    bar('');
    const box = shortcut();
    expect(box.type).toBe('checkbox');
    expect(box.disabled).toBe(false);
    expect(box.tabIndex).toBe(0);
    box.focus();
    expect(document.activeElement).toBe(box);
    expect(box.closest('label')?.textContent).toBe('Nur zu prüfende (Importiert oder Ungeprüft)');
  });

  it('setting it clears and locks the status choice; the URL it writes holds reviewable only', () => {
    const applied = bar('?status=CONFIRMED,CLASSIFIED&provenance=BANK_CSV');
    expect(status('Bestätigt').checked).toBe(true);
    expect(statusBoxes().every((box) => !box.disabled)).toBe(true);
    fireEvent.click(shortcut());
    expect(shortcut().checked).toBe(true);
    expect(statusBoxes().every((box) => !box.checked && box.disabled)).toBe(true);
    expect(screen.getByText(LOCK_NOTE)).toBeTruthy();
    expect(document.getElementById('filter-status')?.getAttribute('aria-describedby')).toBe('filter-status-gesperrt');
    apply();
    expect(applied).toEqual(['?provenance=BANK_CSV&reviewable=true']);
  });

  it('unsetting it unlocks the status choice, still empty; a status chosen then is written without reviewable', () => {
    const applied = bar('?reviewable=true');
    expect(statusBoxes().every((box) => box.disabled)).toBe(true);
    fireEvent.click(shortcut());
    expect(shortcut().checked).toBe(false);
    expect(statusBoxes().every((box) => !box.disabled && !box.checked)).toBe(true);
    expect(screen.queryByText(LOCK_NOTE)).toBeNull();
    fireEvent.click(status('Ungeprüft'));
    expect(status('Ungeprüft').checked).toBe(true);
    apply();
    expect(applied).toEqual(['?status=UNREVIEWED']);
  });

  it('back and forth: the bar never writes both, whatever was chosen in between', () => {
    const applied = bar('?status=IMPORTED');
    fireEvent.click(shortcut());
    apply();
    fireEvent.click(shortcut());
    fireEvent.click(status('Ignoriert'));
    apply();
    fireEvent.click(shortcut());
    apply();
    expect(applied).toEqual(['?reviewable=true', '?status=IGNORED', '?reviewable=true']);
    neverBoth(applied);
  });

  it('a URL with both (typed or bookmarked): reviewable set, status shown empty and locked and named; applying drops it', () => {
    const applied = bar('?status=CONFIRMED&reviewable=true&pageSize=100');
    expect(shortcut().checked).toBe(true);
    expect(statusBoxes().every((box) => !box.checked && box.disabled)).toBe(true);
    // The list of this URL is still asked with both (AND): the bar says which status narrows it until the next apply.
    expect(screen.getByText(/Aus der Adresse gilt für diese Liste zusätzlich der Status: Bestätigt\. Mit „Filter anwenden“ entfällt er\./)).toBeTruthy();
    apply();
    expect(applied).toEqual(['?reviewable=true&pageSize=100']);
  });

  it('counter-check: without the shortcut the status choice is free and named in the URL; current is no shortcut', () => {
    const applied = bar('?status=CONFIRMED&current=true');
    expect(shortcut().checked).toBe(false);
    expect(status('Bestätigt').checked).toBe(true);
    expect(statusBoxes().every((box) => !box.disabled)).toBe(true);
    expect(screen.queryByText(LOCK_NOTE)).toBeNull();
    expect(document.getElementById('filter-status')?.hasAttribute('aria-describedby')).toBe(false);
    fireEvent.click(status('Ignoriert'));
    apply();
    expect(applied).toEqual(['?status=CONFIRMED%2CIGNORED&current=true']);
  });
});

describe('the bar follows the URL of the list (#334 H1: the key on FilterBar in TransactionList)', () => {
  it('a list rerendered with another URL shows the new URL selection in the bar, not the one chosen before', () => {
    const list = (search: string) => (
      <TransactionListView
        realmId="64b7f0c2a1b2c3d4e5f60718"
        params={readListParams(search)}
        list={{ status: 'success', data: page([]) }}
        references={loaded}
        onFilter={() => undefined}
        onRetry={() => undefined}
      />
    );
    const { rerender } = render(list('?reviewable=true&provenance=BANK_CSV'));
    expect(shortcut().checked).toBe(true);
    expect(status('Bankimport (CSV)').checked).toBe(true);
    // An unapplied choice in the bar: it belongs to the old URL and must not survive the move.
    fireEvent.click(shortcut());
    rerender(list('?status=IGNORED,CONFIRMED'));
    expect(shortcut().checked).toBe(false);
    expect(status('Ignoriert').checked).toBe(true);
    expect(status('Bestätigt').checked).toBe(true);
    expect(statusBoxes().every((box) => !box.disabled)).toBe(true);
    expect(status('Bankimport (CSV)').checked).toBe(false);
    rerender(list('?reviewable=true'));
    expect(shortcut().checked).toBe(true);
    expect(statusBoxes().every((box) => !box.checked && box.disabled)).toBe(true);
  });
});

/**
 * Issue #381 part 1: „Abgeglichen“ aus dem Statusfilter der Buchungsliste nehmen; die Kurzwahl heißt „Nur aktuelle
 * (bestätigt, ohne Storno und Korrigierte)“; die Beschriftung in labels.ts bleibt für später (Entscheidung des
 * Projektinhabers, 2026-11-16). No step sets `RECONCILED` yet (api-design.md §37, P4-D3).
 */
describe('the status filter offers no status that no booking can have (#381 part 1)', () => {
  const CURRENT = 'Nur aktuelle (bestätigt, ohne Storno und Korrigierte)';
  const URL_NOTE = /Aus der Adresse gilt für diese Liste auch der Status: Abgeglichen\. Der Filter bietet ihn nicht an; mit „Filter anwenden“ entfällt er\./;
  const boxLabels = () => statusBoxes().map((box) => box.closest('label')?.textContent);

  it('the status boxes are the six a booking can have, without Abgeglichen; the label of RECONCILED stays', () => {
    bar('');
    expect(boxLabels()).toEqual(['Importiert · zu prüfen', 'Ungeprüft', 'Aufgeteilt', 'Bestätigt', 'Korrigiert/storniert', 'Ignoriert']);
    expect(screen.queryByRole('checkbox', { name: 'Abgeglichen' })).toBeNull();
    expect(screen.queryByText(/abgeglichen/i)).toBeNull();
    // labels.ts keeps it for later: a RECONCILED booking (none today) is still named in the table and the detail.
    expect(statusLabel('RECONCILED')).toEqual({ text: 'Abgeglichen', tone: 'success', known: true });
  });

  it('the shortcut is named Nur aktuelle (bestaetigt, ohne Storno und Korrigierte) and still writes current=true', () => {
    const applied = bar('');
    const box = screen.getByRole<HTMLInputElement>('checkbox', { name: CURRENT });
    expect(box.closest('label')?.textContent).toBe(CURRENT);
    fireEvent.click(box);
    apply();
    expect(applied).toEqual(['?current=true']);
    expect(toApiQuery(readListParams(applied[0] ?? ''))).toEqual({ current: 'true', page: '1', pageSize: '50' });
  });

  it('an old bookmark with RECONCILED: the list of the URL is asked as it is, the bar names it; applying drops it, the rest kept', () => {
    const search = '?status=CONFIRMED,RECONCILED&provenance=BANK_CSV&current=true&pageSize=100';
    expect(toApiQuery(readListParams(search))['status']).toBe('CONFIRMED,RECONCILED');
    const applied = bar(search);
    expect(status('Bestätigt').checked).toBe(true);
    expect(statusBoxes().filter((box) => box.checked)).toHaveLength(1);
    const note = screen.getByText(URL_NOTE);
    expect(note.textContent).toContain('„Abgeglichen“ vergibt noch kein Schritt; keine Buchung hat diesen Status.');
    expect(document.getElementById('filter-status')?.getAttribute('aria-describedby')).toBe(note.id);
    apply();
    expect(applied).toEqual(['?status=CONFIRMED&provenance=BANK_CSV&current=true&pageSize=100']);
  });

  it('an old bookmark with RECONCILED alone: no box set, the note shown; applying drops the status only', () => {
    const applied = bar('?status=RECONCILED&bookingDateFrom=2026-11-01');
    expect(statusBoxes().every((box) => !box.checked && !box.disabled)).toBe(true);
    expect(screen.getByText(URL_NOTE)).toBeTruthy();
    apply();
    expect(applied).toEqual(['?bookingDateFrom=2026-11-01']);
  });

  it('the page of such a bookmark loads: one list request with the URL status, an empty result, the bar with its note', async () => {
    const { fetch, calls } = routedFetch({
      'GET /api/v1/financial-accounts': [() => json(200, page([]))],
      'GET /api/v1/property-references': [() => json(200, page([property()]))],
      'GET /api/v1/financial-categories': [() => json(200, { items: [category()] })],
      'GET /api/v1/transactions': [() => json(200, page([]))],
    });
    const client = createDeClient({ tokens: countingTokens(), realmId: REALM_A, fetch });
    render(
      <QueryClientProvider client={createQueryClient()}>
        <TransactionsArea client={client} realmId={REALM_A} epoch={1} transactionId={undefined} search="?status=RECONCILED" />
      </QueryClientProvider>,
    );
    expect(await screen.findByText(/Keine Buchung passt/)).toBeTruthy();
    expect(screen.getByText(URL_NOTE)).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    const lists = calls.filter((call) => new URL(call.url, 'https://cockpit.internal').pathname === '/api/v1/transactions');
    expect(lists.map((call) => new URL(call.url, 'https://cockpit.internal').searchParams.get('status'))).toEqual(['RECONCILED']);
  });

  it('counter-check: offered statuses only, or an unknown code (refused by the backend), show no note', () => {
    for (const search of ['?status=CONFIRMED,IGNORED', '?status=SOMETHING_NEW']) {
      bar(search);
      expect(screen.queryByText(/Aus der Adresse gilt/), search).toBeNull();
      expect(document.getElementById('filter-status')?.hasAttribute('aria-describedby'), search).toBe(false);
      cleanup();
    }
  });
});
