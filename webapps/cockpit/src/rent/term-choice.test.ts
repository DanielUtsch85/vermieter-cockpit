import { describe, expect, it } from 'vitest';
import { rentTenant, tenantTerms, TENANT, TERM } from './fixtures.test-support';
import { monthText, tenantOptionText, termListNote, termOptionText, termWindow } from './term-choice';

/** #364 (§37.7): the window around a booking and the texts of the two lists; ids only, never a name. */
const NBSP = '\u00a0';

describe('termWindow: from the month before the booking to the month after', () => {
  it('within a year, across the turn of the year both ways, and at most twelve months', () => {
    expect(termWindow('2026-10-01')).toEqual({ from: '2026-09', to: '2026-11' });
    expect(termWindow('2027-01-31')).toEqual({ from: '2026-12', to: '2027-02' });
    expect(termWindow('2026-12-15')).toEqual({ from: '2026-11', to: '2027-01' });
  });

  it('no window for a date that is none', () => {
    for (const date of ['', '2026-13-01', '2026-00-10', '01.10.2026', '2026-10']) expect(termWindow(date), date).toBeUndefined();
  });

  it('monthText', () => {
    expect(monthText('2026-09')).toBe('09.2026');
  });
});

describe('the texts of the lists', () => {
  it('a Tenant: the MRE id, the latest term and the count, singular and plural', () => {
    expect(tenantOptionText(rentTenant())).toBe(`${TENANT} · zuletzt Termin 01.03.2026 · 2 Zuordnungen`);
    expect(tenantOptionText(rentTenant({ reconciliationCount: 1 }))).toBe(`${TENANT} · zuletzt Termin 01.03.2026 · 1 Zuordnung`);
  });

  it('a term in MRE with due and open; one only DE knows; one without MRE', () => {
    const [, march] = tenantTerms().items;
    if (march === undefined) throw new Error('fixture');
    expect(termOptionText(march)).toBe(`Termin 01.03.2026 (${TERM}) · Soll 850,00${NBSP}€ · offen 550,00${NBSP}€`);
    expect(termOptionText({ ...march, inMre: false, amountDue: null, coverage: null, openAmount: null })).toBe(
      `Termin 01.03.2026 (${TERM}) · in MRE nicht mehr geführt · zugeordnet 300,00${NBSP}€`,
    );
    expect(termOptionText({ ...march, inMre: null, amountDue: null, coverage: null, openAmount: null })).toBe(
      `Termin 01.03.2026 (${TERM}) · zugeordnet 300,00${NBSP}€`,
    );
  });

  it('the note on MRE side: nothing when terms are listed, else why', () => {
    expect(termListNote(tenantTerms())).toBeUndefined();
    expect(termListNote(tenantTerms({ items: [] }))).toBe('MRE führt für diesen Mieter von 02.2026 bis 04.2026 keinen Termin.');
    expect(termListNote(tenantTerms({ mreStatus: 'NOT_RETURNED', items: [] }))).toMatch(/^MRE führt diesen Mieter im Bestand nicht \(mehr\)/);
    expect(termListNote(tenantTerms({ mreStatus: 'UNAVAILABLE', items: [] }))).toMatch(/^MRE war nicht erreichbar/);
  });
});
