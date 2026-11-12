// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { readListParams, toSearch, type ListParams } from '../../transactions/list-params';
import { account, category, page, property } from '../../transactions/fixtures.test-support';
import { FilterBar } from './FilterBar';
import type { References } from './references';
import { TransactionListView } from './TransactionList';

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
    fireEvent.click(status('Abgeglichen'));
    apply();
    fireEvent.click(shortcut());
    apply();
    expect(applied).toEqual(['?reviewable=true', '?status=RECONCILED', '?reviewable=true']);
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
    expect(status('Aus Bankimport (CSV)').checked).toBe(true);
    // An unapplied choice in the bar: it belongs to the old URL and must not survive the move.
    fireEvent.click(shortcut());
    rerender(list('?status=IGNORED,CONFIRMED'));
    expect(shortcut().checked).toBe(false);
    expect(status('Ignoriert').checked).toBe(true);
    expect(status('Bestätigt').checked).toBe(true);
    expect(statusBoxes().every((box) => !box.disabled)).toBe(true);
    expect(status('Aus Bankimport (CSV)').checked).toBe(false);
    rerender(list('?reviewable=true'));
    expect(shortcut().checked).toBe(true);
    expect(statusBoxes().every((box) => !box.checked && box.disabled)).toBe(true);
  });
});
