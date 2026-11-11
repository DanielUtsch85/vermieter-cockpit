// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { ImportBatchDto } from '../../api/imports';
import { batch, BATCH, ITEM, mixedBatch } from '../../imports/fixtures.test-support';
import { REALM_A, TX } from '../../transactions/fixtures.test-support';
import { ImportResult } from './ImportResult';

/**
 * The row table of the import result (Entscheidung des Projektinhabers, 2026-11-11): by default only the rows with a
 * hint (`rowHasHint`), „Alle Zeilen“ as a toggle button with `aria-pressed`, the counters always as the server sent
 * them, and an empty filtered view that says so with the number of all rows (jsdom, `fireEvent` only).
 */

afterEach(cleanup);

const show = (b: ImportBatchDto) => render(<ImportResult realmId={REALM_A} batch={b} accounts={[]} />);
const positions = () =>
  screen
    .queryAllByRole('row')
    .slice(1)
    .map((row) => row.querySelectorAll('td')[0]?.textContent);
const toggle = () => screen.getByRole<HTMLButtonElement>('button', { name: 'Alle Zeilen' });
const counters = () => [...(document.querySelector('dl[aria-label="Zähler"]') as HTMLElement).querySelectorAll('dd')].map((dd) => dd.textContent);

const PLAIN_ONLY = batch({
  transactionCount: 1,
  duplicateCount: 2,
  rows: [
    { outcome: 'created', position: 1, transactionId: TX },
    { outcome: 'duplicate', position: 2, duplicateOf: 'TRANSACTION', transactionId: TX },
    { outcome: 'duplicate', position: 3, duplicateOf: 'RESOLVED_REVIEW_ITEM', reviewItemId: ITEM, importBatchId: BATCH, resolution: 'SKIP' },
  ],
});

describe('the row table of the import result', () => {
  it('by default hides the new bookings and plain duplicates; review items, errors and skipped rows stay, in file order', () => {
    show(mixedBatch({ transactionCount: 11, duplicateCount: 12, needsReviewCount: 13, errorCount: 14, skippedCount: 15 }));
    expect(positions()).toEqual(['3', '4', '5', '6']);
    expect(screen.getByText('Angezeigt: 4 von 6 Zeilen, nur Zeilen mit Hinweis.')).toBeTruthy();
    expect(counters()).toEqual(['11', '12', '13', '14', '15']);
    expect(toggle().getAttribute('aria-pressed')).toBe('false');
  });

  it('Alle Zeilen shows every row and is pressed; pressed again it hides them again; the counters never change', () => {
    show(mixedBatch({ transactionCount: 11, duplicateCount: 12, needsReviewCount: 13, errorCount: 14, skippedCount: 15 }));
    fireEvent.click(toggle());
    expect(positions()).toEqual(['1', '2', '3', '4', '5', '6']);
    expect(toggle().getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByText('Angezeigt: alle 6 Zeilen, davon 4 mit Hinweis.')).toBeTruthy();
    expect(counters()).toEqual(['11', '12', '13', '14', '15']);
    fireEvent.click(toggle());
    expect(positions()).toEqual(['3', '4', '5', '6']);
    expect(toggle().getAttribute('aria-pressed')).toBe('false');
    expect(counters()).toEqual(['11', '12', '13', '14', '15']);
  });

  it('the toggle is a button of its own that the keyboard reaches and that names the table it controls', () => {
    show(mixedBatch());
    const button = toggle();
    expect(button.tagName).toBe('BUTTON');
    expect(button.getAttribute('type')).toBe('button');
    expect(button.tabIndex).toBe(0);
    button.focus();
    expect(document.activeElement).toBe(button);
    expect(document.getElementById(button.getAttribute('aria-controls') ?? '')?.tagName).toBe('TABLE');
  });

  it('no row with a hint: says so with the number of all rows; the toggle shows them, the counters stay', () => {
    show(PLAIN_ONLY);
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.getByText('Keine Zeilen mit Hinweis. Die Datei hat 3 Zeilen; „Alle Zeilen“ zeigt sie.')).toBeTruthy();
    expect(screen.getByText('Angezeigt: 0 von 3 Zeilen, nur Zeilen mit Hinweis.')).toBeTruthy();
    expect(counters()).toEqual(['1', '2', '0', '0', '0']);
    fireEvent.click(toggle());
    expect(positions()).toEqual(['1', '2', '3']);
    expect(screen.queryByText(/Keine Zeilen mit Hinweis/)).toBeNull();
    expect(counters()).toEqual(['1', '2', '0', '0', '0']);
  });

  it('one row says Zeile; a file without data rows offers no toggle', () => {
    show(batch({ rows: [{ outcome: 'created', position: 1, transactionId: TX }] }));
    expect(screen.getByText('Keine Zeilen mit Hinweis. Die Datei hat 1 Zeile; „Alle Zeilen“ zeigt sie.')).toBeTruthy();
    cleanup();
    show(batch({ rows: [] }));
    expect(screen.getByText('Die Datei enthielt keine Datenzeile.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Alle Zeilen' })).toBeNull();
  });
});
