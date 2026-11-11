import { describe, expect, it } from 'vitest';
import { showsAllRows, withAllRows } from './row-view';

/** „Alle Zeilen“ as `zeilen=alle` (Entscheidung des Projektinhabers, 2026-11-11, zu #344): reading and writing the URL. */

describe('showsAllRows: only exactly zeilen=alle shows every row', () => {
  it('zeilen=alle, also beside other parameters and with or without the question mark', () => {
    for (const search of ['?zeilen=alle', 'zeilen=alle', '?a=1&zeilen=alle', '?zeilen=alle&a=1']) expect(showsAllRows(search), search).toBe(true);
  });

  it('counter-check: absent, empty, unknown or differently written is the default view', () => {
    for (const search of ['', '?', '?a=1', '?zeilen', '?zeilen=', '?zeilen=ALLE', '?zeilen=all', '?Zeilen=alle', '?zeilen=alle%20', '?zeile=alle']) {
      expect(showsAllRows(search), search).toBe(false);
    }
  });
});

describe('withAllRows: sets or removes the parameter and keeps every other one byte for byte', () => {
  it('on: appends zeilen=alle, replacing any earlier value of it', () => {
    expect(withAllRows('', true)).toBe('?zeilen=alle');
    expect(withAllRows('?a=1&status=IMPORTED,UNREVIEWED&b=%C3%A4', true)).toBe('?a=1&status=IMPORTED,UNREVIEWED&b=%C3%A4&zeilen=alle');
    expect(withAllRows('?zeilen=xyz&a=1&zeilen=alle', true)).toBe('?a=1&zeilen=alle');
  });

  it('off: removes every value of it; nothing left is no search part at all', () => {
    expect(withAllRows('?zeilen=alle', false)).toBe('');
    expect(withAllRows('?a=1&zeilen=alle&b=2', false)).toBe('?a=1&b=2');
    expect(withAllRows('?zeilen&a=1', false)).toBe('?a=1');
    expect(withAllRows('', false)).toBe('');
  });

  it('counter-check: a parameter that only looks alike is kept', () => {
    expect(withAllRows('?zeilenx=1&Zeilen=alle', false)).toBe('?zeilenx=1&Zeilen=alle');
  });
});
