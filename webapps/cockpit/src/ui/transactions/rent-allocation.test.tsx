// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import { createDeClient } from '../../api/client';
import { ApiError, CLIENT_CODES } from '../../api/errors';
import { countingTokens, json, scriptedFetch } from '../../api/fetch.test-support';
import { listTransactions, rentAllocationValid, type TransactionListItemDto } from '../../api/transactions';
import { readListParams, toSearch, type ListParams } from '../../transactions/list-params';
import { account, allocation, category, listItem, page, property, REALM_A, TX } from '../../transactions/fixtures.test-support';
import { FilterBar } from './FilterBar';
import { rentAllocationLabel } from './labels';
import type { References } from './references';
import { TransactionListView } from './TransactionList';

/**
 * #381 part 2 (api-design.md §30.1A, VC-X-81; Entscheidung des Projektinhabers, 2026-11-17): the rent allocation of a
 * confirmed rent payment as a badge under its status, the shortcut „Mietanteil noch frei“ (`rentAllocation=NONE,PARTIAL`)
 * in the filter bar, and the client's check of the field. Synthetic data only.
 */

const NBSP = ' ';
const loaded: References = {
  accounts: { status: 'success', data: page([account()]) },
  properties: { status: 'success', data: page([property()]) },
  categories: { status: 'success', data: [category()] },
};
const nothing = () => undefined;
const rentPayment = (overrides: Partial<TransactionListItemDto> = {}) => listItem({ status: 'CONFIRMED', direction: 'INFLOW', ...overrides });
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/[ \t\n]+/g, ' ');
const table = (items: readonly TransactionListItemDto[], search = '') =>
  renderToStaticMarkup(
    <TransactionListView
      realmId={REALM_A}
      params={readListParams(search)}
      list={{ status: 'success', data: page(items) }}
      references={loaded}
      onFilter={nothing}
      onRetry={nothing}
    />,
  );

afterEach(cleanup);

describe('the badge under the status (§30.1A, open question 7)', () => {
  it('each state says itself; PARTIAL names the free rest in the list s money format; none for null', () => {
    const cells = (html: string) =>
      [...html.matchAll(/<td class="p-3"><div class="flex flex-col items-start gap-1">(.*?)<\/div><\/td>/g)].map((m) => text(m[1] ?? '').trim());
    const html = table([
      rentPayment({ transactionId: `${TX.slice(0, -1)}1`, rentAllocation: allocation('850.00', '850.00', '0.00') }),
      rentPayment({ transactionId: `${TX.slice(0, -1)}2`, rentAllocation: allocation('850.00', '600.00', '250.00') }),
      rentPayment({ transactionId: `${TX.slice(0, -1)}3`, rentAllocation: allocation('850.00', '0.00', '850.00') }),
      rentPayment({ transactionId: `${TX.slice(0, -1)}4`, rentAllocation: null }),
      listItem({ transactionId: `${TX.slice(0, -1)}5`, status: 'IMPORTED' }),
    ]);
    expect(cells(html)).toEqual([
      'Bestätigt Miete zugeordnet',
      `Bestätigt Miete teilweise zugeordnet · noch frei 250,00${NBSP}€`,
      'Bestätigt Miete nicht zugeordnet',
      'Bestätigt',
      'Importiert · zu prüfen',
    ]);
  });

  it('the colour only repeats the text: FULL success, NONE and PARTIAL warning (open, to check)', () => {
    expect(rentAllocationLabel(allocation('850.00', '850.00', '0.00'))).toEqual({ text: 'Miete zugeordnet', tone: 'success', known: true });
    expect(rentAllocationLabel(allocation('850.00', '0.00', '850.00'))).toEqual({ text: 'Miete nicht zugeordnet', tone: 'warning', known: true });
    expect(rentAllocationLabel(allocation('1234.50', '0.01', '1234.49'))).toEqual({
      text: `Miete teilweise zugeordnet · noch frei 1.234,49${NBSP}€`,
      tone: 'warning',
      known: true,
    });
    // Never „offen“: „offene Miete“ reads as the tenant's arrear.
    expect(
      JSON.stringify(['NONE', 'PARTIAL', 'FULL'].map((state) => rentAllocationLabel({ state, freeAmount: { amount: '1.00', currency: 'EUR' } }))),
    ).not.toMatch(/offen/i);
  });
});

/** The bar for a URL; every applied filter is kept as the search part it navigates to. */
function bar(search: string, errors: ReadonlyMap<string, readonly { field: string; code: string }[]> = new Map()) {
  const applied: string[] = [];
  render(
    <FilterBar
      params={readListParams(search)}
      references={loaded}
      errors={errors}
      resetHref="/cockpit/r/x/buchungen"
      onFilter={(params: ListParams) => applied.push(toSearch(params))}
    />,
  );
  return applied;
}
const shortcut = () => screen.getByRole<HTMLInputElement>('checkbox', { name: 'Mietanteil noch frei' });
const apply = () => fireEvent.click(screen.getByRole('button', { name: 'Filter anwenden' }));

describe('the shortcut „Mietanteil noch frei“ (§30.1A, open question 8)', () => {
  it('writes rentAllocation=NONE,PARTIAL into the URL, with the other filters; unset, it writes none', () => {
    const applied = bar('?status=CONFIRMED');
    expect(shortcut().checked).toBe(false);
    fireEvent.click(shortcut());
    apply();
    fireEvent.click(shortcut());
    apply();
    expect(applied).toEqual(['?status=CONFIRMED&rentAllocation=NONE%2CPARTIAL', '?status=CONFIRMED']);
  });

  it('is restored from the URL, in either order of the states, and kept by „Filter anwenden“', () => {
    const applied = bar('?rentAllocation=PARTIAL,NONE&current=true');
    expect(shortcut().checked).toBe(true);
    apply();
    expect(applied).toEqual(['?current=true&rentAllocation=NONE%2CPARTIAL']);
  });

  it('a URL with another state: the box is unset, the note names the state, „Filter anwenden“ drops it', () => {
    const applied = bar('?rentAllocation=FULL');
    expect(shortcut().checked).toBe(false);
    const note = screen.getByText(/Aus der Adresse gilt für diese Liste auch die Mietzuordnung: Miete zugeordnet\./);
    expect(shortcut().getAttribute('aria-describedby')).toBe(note.id);
    apply();
    expect(applied).toEqual(['']);
  });

  it('a refusal of rentAllocation is shown at the checkbox and focuses it', () => {
    bar('?rentAllocation=OPEN', new Map([['rentAllocation', [{ field: 'rentAllocation', code: 'INVALID_FORMAT' }]]]));
    const box = shortcut();
    expect(box.getAttribute('aria-invalid')).toBe('true');
    const described = (box.getAttribute('aria-describedby') ?? '').split(' ');
    expect(described).toContain('filter-rentAllocation-fehler');
    expect(document.getElementById('filter-rentAllocation-fehler')?.textContent).not.toBe('');
    expect(document.activeElement).toBe(box);
  });
});

describe('the client s check of rentAllocation (§30.1A): an answer that breaks it is refused, never shown', () => {
  const valid = (overrides: Partial<TransactionListItemDto>) => rentAllocationValid(rentPayment(overrides));

  it('accepts null, and each state whose amounts agree', () => {
    expect(valid({ rentAllocation: null })).toBe(true);
    expect(valid({ status: 'IMPORTED', rentAllocation: null })).toBe(true);
    expect(valid({ rentAllocation: allocation('850.00', '0.00', '850.00') })).toBe(true);
    expect(valid({ rentAllocation: allocation('850.00', '0.01', '849.99') })).toBe(true);
    expect(valid({ rentAllocation: allocation('850.00', '850.00', '0.00') })).toBe(true);
    expect(valid({ status: 'RECONCILED', rentAllocation: allocation('999999999999999999.99', '0.01', '999999999999999999.98') })).toBe(true);
  });

  it('refuses a missing field, a field on what cannot be allocated, a wrong state, sum or currency, and a non-decimal amount', () => {
    const partial = allocation('850.00', '600.00', '250.00');
    const { rentAllocation: _dropped, ...withoutField } = rentPayment();
    expect(rentAllocationValid(withoutField as TransactionListItemDto)).toBe(false);
    expect(valid({ status: 'CLASSIFIED', rentAllocation: partial })).toBe(false);
    expect(valid({ status: 'CORRECTED', rentAllocation: partial })).toBe(false);
    expect(valid({ correctionRole: 'REVERSAL', rentAllocation: partial })).toBe(false);
    expect(valid({ direction: 'OUTFLOW', rentAllocation: partial })).toBe(false);
    expect(valid({ rentAllocation: { ...partial, state: 'FULL' } })).toBe(false);
    expect(valid({ rentAllocation: { ...partial, state: 'OPEN' as never } })).toBe(false);
    expect(valid({ rentAllocation: { ...partial, freeAmount: { amount: '250.01', currency: 'EUR' } } })).toBe(false);
    expect(valid({ rentAllocation: { ...partial, freeAmount: { amount: '250.00', currency: 'USD' } } })).toBe(false);
    expect(valid({ rentAllocation: { ...partial, rentAmount: { amount: '850', currency: 'EUR' } } })).toBe(false);
    expect(valid({ rentAllocation: { ...partial, allocatedAmount: { amount: 600 as never, currency: 'EUR' } } })).toBe(false);
    expect(valid({ rentAllocation: allocation('0.00', '0.00', '0.00') })).toBe(false);
  });

  it('listTransactions refuses the whole page for one broken item', async () => {
    const broken = rentPayment({ rentAllocation: { ...allocation('850.00', '600.00', '250.00'), state: 'NONE' } });
    const { fetch } = scriptedFetch(json(200, page([rentPayment(), broken])));
    const client = createDeClient({ tokens: countingTokens(), realmId: REALM_A, fetch });
    const error = await listTransactions(client, { page: '1', pageSize: '50' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe(CLIENT_CODES.unexpected);
  });
});
