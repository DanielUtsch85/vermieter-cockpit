// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ImportBatchDto } from '../../api/imports';
import { batch, BATCH, ITEM, mixedBatch } from '../../imports/fixtures.test-support';
import { useLocationSearch } from '../../navigation';
import { REALM_A, TX } from '../../transactions/fixtures.test-support';
import { technicalBlocks, visibleText } from '../technical.test-support';
import { ImportResult } from './ImportResult';

/**
 * The row table of the import result (Entscheidung des Projektinhabers, 2026-11-11): by default only the rows with a
 * hint (`rowHasHint`), „Alle Zeilen“ as a toggle button with `aria-pressed`, the counters always as the server sent
 * them, and an empty filtered view that says so with the number of all rows (jsdom, `fireEvent` only). The toggle is
 * the URL's `zeilen=alle` (Entscheidung des Projektinhabers, 2026-11-11, zu #344), read here as the app reads it.
 */

const PAGE = `/cockpit/r/${REALM_A}/import/${BATCH}`;

beforeEach(() => window.history.replaceState(null, '', PAGE));
afterEach(cleanup);

/** The result with the URL's search part, as ImportArea passes it. */
function Shown({ batch: b }: { readonly batch: ImportBatchDto }) {
  return <ImportResult realmId={REALM_A} batch={b} accounts={[]} search={useLocationSearch()} />;
}

const show = (b: ImportBatchDto) => render(<Shown batch={b} />);
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

const here = () => `${window.location.pathname}${window.location.search}${window.location.hash}`;
const ALL = (b = mixedBatch()) => batch({ ...b, transactionCount: 11, duplicateCount: 12, needsReviewCount: 13, errorCount: 14, skippedCount: 15 });

describe('Alle Zeilen in the URL as zeilen=alle (Entscheidung des Projektinhabers, 2026-11-11, zu #344)', () => {
  it('without the parameter the default view: only rows with a hint, not pressed, the URL untouched', () => {
    show(ALL());
    expect(positions()).toEqual(['3', '4', '5', '6']);
    expect(toggle().getAttribute('aria-pressed')).toBe('false');
    expect(counters()).toEqual(['11', '12', '13', '14', '15']);
    expect(here()).toBe(PAGE);
  });

  it('a deep link with zeilen=alle opens the full view, pressed, with the counters', () => {
    window.history.replaceState(null, '', `${PAGE}?zeilen=alle`);
    show(ALL());
    expect(positions()).toEqual(['1', '2', '3', '4', '5', '6']);
    expect(toggle().getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByText('Angezeigt: alle 6 Zeilen, davon 4 mit Hinweis.')).toBeTruthy();
    expect(counters()).toEqual(['11', '12', '13', '14', '15']);
    expect(here()).toBe(`${PAGE}?zeilen=alle`);
  });

  it('the toggle replaces the URL in place: on adds zeilen=alle, off removes it; other parameters and the fragment stay', () => {
    window.history.replaceState({ kept: 1 }, '', `${PAGE}?a=1&status=IMPORTED,UNREVIEWED&b=%C3%A4#zeilen`);
    const entries = window.history.length;
    show(ALL());
    expect(positions()).toEqual(['3', '4', '5', '6']);
    const button = toggle();
    button.focus();
    fireEvent.click(button);
    expect(here()).toBe(`${PAGE}?a=1&status=IMPORTED,UNREVIEWED&b=%C3%A4&zeilen=alle#zeilen`);
    expect(positions()).toEqual(['1', '2', '3', '4', '5', '6']);
    expect(toggle().getAttribute('aria-pressed')).toBe('true');
    expect(counters()).toEqual(['11', '12', '13', '14', '15']);
    expect(document.activeElement).toBe(toggle());
    fireEvent.click(toggle());
    expect(here()).toBe(`${PAGE}?a=1&status=IMPORTED,UNREVIEWED&b=%C3%A4#zeilen`);
    expect(positions()).toEqual(['3', '4', '5', '6']);
    expect(toggle().getAttribute('aria-pressed')).toBe('false');
    expect(counters()).toEqual(['11', '12', '13', '14', '15']);
    // Replace, not push: no new history entry, the state of the entry kept.
    expect(window.history.length).toBe(entries);
    expect(window.history.state).toEqual({ kept: 1 });
  });

  it('the toggle alone: on gives only zeilen=alle, off leaves no search part at all', () => {
    show(ALL());
    fireEvent.click(toggle());
    expect(here()).toBe(`${PAGE}?zeilen=alle`);
    fireEvent.click(toggle());
    expect(here()).toBe(PAGE);
  });

  it('an unknown, empty or differently written value is the default view; the toggle then sets exactly zeilen=alle', () => {
    for (const search of ['?zeilen=ALLE', '?zeilen=all', '?zeilen=', '?zeilen', '?zeilen=alle%20', '?Zeilen=alle', '?zeilen=hinweis']) {
      window.history.replaceState(null, '', `${PAGE}${search}`);
      show(ALL());
      expect(positions(), search).toEqual(['3', '4', '5', '6']);
      expect(toggle().getAttribute('aria-pressed'), search).toBe('false');
      expect(counters(), search).toEqual(['11', '12', '13', '14', '15']);
      cleanup();
    }
    window.history.replaceState(null, '', `${PAGE}?zeilen=xyz&x=1&zeilen=alle`);
    show(ALL());
    expect(positions()).toEqual(['3', '4', '5', '6']);
    fireEvent.click(toggle());
    expect(here()).toBe(`${PAGE}?x=1&zeilen=alle`);
    fireEvent.click(toggle());
    expect(here()).toBe(`${PAGE}?x=1`);
  });

  it('the counters are shown in both views and with an unknown value, always as the server sent them', () => {
    for (const search of ['', '?zeilen=alle', '?zeilen=unbekannt']) {
      window.history.replaceState(null, '', `${PAGE}${search}`);
      show(PLAIN_ONLY);
      expect(screen.getByRole('heading', { name: 'Zähler' })).toBeTruthy();
      expect(counters(), search).toEqual(['1', '2', '0', '0', '0']);
      cleanup();
    }
  });
});

describe('the decided rows (Entscheidung des Projektinhabers, 2026-11-11, zu #344)', () => {
  const DECIDED = batch({
    duplicateCount: 2,
    needsReviewCount: 1,
    rows: [
      { outcome: 'duplicate', position: 1, duplicateOf: 'RESOLVED_REVIEW_ITEM', reviewItemId: ITEM, importBatchId: BATCH, resolution: 'SKIP' },
      { outcome: 'needs_review', position: 2, reviewItemId: ITEM, importBatchId: BATCH, reason: 'AMBIGUOUS_CROSS_FILE_MATCH', conflictingTransactionIds: [TX] },
      {
        outcome: 'duplicate',
        position: 3,
        duplicateOf: 'RESOLVED_REVIEW_ITEM',
        reviewItemId: ITEM,
        importBatchId: BATCH,
        resolution: 'CREATE',
        createdTransactionId: TX,
      },
    ],
  });
  const outcomes = () =>
    screen
      .queryAllByRole('row')
      .slice(1)
      .map((row) => row.querySelectorAll('td')[1]?.textContent);

  it('duplicates of a decided review item are hidden by default and shown under Alle Zeilen, by click and by deep link', () => {
    show(DECIDED);
    expect(positions()).toEqual(['2']);
    expect(screen.queryByText(/Schon als Klärfall entschieden/)).toBeNull();
    fireEvent.click(toggle());
    expect(positions()).toEqual(['1', '2', '3']);
    expect(outcomes()).toEqual(['Duplikat', 'Klärfall', 'Duplikat']);
    expect(screen.getAllByText(/Schon als Klärfall entschieden/)).toHaveLength(2);
    cleanup();
    window.history.replaceState(null, '', `${PAGE}?zeilen=alle`);
    show(DECIDED);
    expect(positions()).toEqual(['1', '2', '3']);
  });

  it('zero-amount rows stay visible in the default view, beside hidden new bookings; also with Alle Zeilen', () => {
    const zero = batch({
      transactionCount: 2,
      skippedCount: 2,
      rows: [
        { outcome: 'created', position: 1, transactionId: TX },
        { outcome: 'skipped', position: 2, reason: 'ZERO_AMOUNT' },
        { outcome: 'created', position: 3, transactionId: TX },
        { outcome: 'skipped', position: 4, reason: 'ZERO_AMOUNT' },
      ],
    });
    show(zero);
    expect(positions()).toEqual(['2', '4']);
    expect(outcomes()).toEqual(['Übersprungen', 'Übersprungen']);
    expect(screen.getAllByText('Betrag 0: kein Geldfluss, keine Buchung')).toHaveLength(2);
    expect(screen.getByText('Angezeigt: 2 von 4 Zeilen, nur Zeilen mit Hinweis.')).toBeTruthy();
    fireEvent.click(toggle());
    expect(positions()).toEqual(['1', '2', '3', '4']);
  });
});

describe('the import id in Technische Angaben (Entscheidung des Projektinhabers, 2026-11-13, zu #354 F3)', () => {
  it('the id is only in the collapsed block; status, file and account name the import visibly', () => {
    show(mixedBatch());
    const card = screen.getByRole('region', { name: 'Ergebnis des Imports' });
    expect(visibleText(card)).not.toContain(BATCH);
    expect(visibleText(document.body)).not.toContain(BATCH);
    const blocks = technicalBlocks(card);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.open).toBe(false);
    expect(blocks[0]?.textContent).toBe(`Technische AngabenImport-ID${BATCH}`);
    expect(visibleText(card)).toContain('Dateiumsaetze-oktober.csv');
  });

  it('a batch without a file name says so; the id still stays in the block', () => {
    show(mixedBatch({ sourceFilename: null }));
    const card = screen.getByRole('region', { name: 'Ergebnis des Imports' });
    expect(visibleText(card)).toContain('DateiNicht verfügbar');
    expect(visibleText(card)).not.toContain(BATCH);
    expect(technicalBlocks(card)[0]?.textContent).toContain(BATCH);
  });
});
