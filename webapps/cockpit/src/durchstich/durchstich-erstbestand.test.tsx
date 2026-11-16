// @vitest-environment jsdom
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { REALM_A } from '../transactions/fixtures.test-support';
import { MRE_LINKED, MRE_UNLINKED, MRE_UNLINKED_NAME } from './fake-setup.test-support';
import {
  click,
  commands,
  control,
  csvFile,
  IMPORT,
  importCsv,
  openApp,
  openTransaction,
  requests,
  showAllRows,
  splitRent,
  type,
  useDurchstich,
} from './walk.test-support';

/**
 * A fresh Realm in the cockpit (Issue #365, Abnahme: „Ein neuer Bestand kommt ohne API-Aufruf bis zum ersten Import
 * und zur ersten Aufteilung mit Objektbezug“): the empty choices say what is missing and link to where it comes from
 * (Entscheidung des Projektinhabers, 2026-11-16), and the whole way from an empty Realm to an import and a split with an
 * object runs through the UI only. The fake starts Realm A without account, linked object and booking (`fresh`); its
 * two properties exist in MRE only.
 */

const backend = useDurchstich();
const KONTO = `/cockpit/r/${REALM_A}/einrichtung/konto`;
const OBJEKTE = `/cockpit/r/${REALM_A}/einrichtung/objekte`;
const IBAN = 'DE89370400440532013000';

/** Realm A without linked objects; its account and bookings stay. */
const unlink = () => {
  const refs = backend().setup.references;
  for (let i = refs.length - 1; i >= 0; i -= 1) if (refs[i]?.mreRealmId === REALM_A) refs.splice(i, 1);
};
const nav = (name: string) => fireEvent.click(within(screen.getByRole('navigation', { name: 'Hauptnavigation' })).getByRole('link', { name }), { button: 0 });
const linkIn = (element: HTMLElement, name: string) => within(element).getByRole('link', { name });

describe('empty choices say what is missing and link to where it comes from', () => {
  it('the import without an account links to Konto anlegen, which then leads back to the import', async () => {
    backend().fresh();
    await openApp(backend(), IMPORT);
    const empty = await screen.findByText(/In diesem Bestand gibt es noch kein Finanzkonto\. Ohne Konto ist kein Import möglich\./);
    expect(empty.textContent).toContain('mit der IBAN des Kontos');
    const link = linkIn(empty, 'Konto anlegen');
    expect(link.getAttribute('href')).toBe(KONTO);
    expect(screen.queryByRole('form', { name: 'Datei importieren' })).toBeNull();
    fireEvent.click(link, { button: 0 });
    expect(await screen.findByRole('form', { name: 'Konto anlegen' })).toBeTruthy();
  });

  it('the split editor object choice without linked objects links to Objekte verknüpfen', async () => {
    unlink();
    backend().seedRent('IMPORTED');
    await openApp(backend(), `/cockpit/r/${REALM_A}/buchungen`);
    await openTransaction(backend(), 'Miete Oktober Testwohnung');
    await waitFor(() => control('split-0-reference'));
    expect(screen.queryByText(/noch kein Objekt aus MicroRealEstate verknüpft/)).toBeNull();
    type(control('split-0-reference'), 'property');
    const hint = await screen.findByText(/In diesem Bestand ist noch kein Objekt aus MicroRealEstate verknüpft; die Auswahl ist leer\./);
    expect(
      within(control('split-0-property'))
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['Objekt wählen']);
    const link = linkIn(hint, 'Objekte verknüpfen');
    expect(link.getAttribute('href')).toBe(OBJEKTE);
    fireEvent.click(link, { button: 0 });
    expect(await screen.findByRole('heading', { level: 1, name: 'Objekte verknüpfen' })).toBeTruthy();
  });

  it('the object filter of the list without linked objects links to Objekte verknüpfen', async () => {
    unlink();
    await openApp(backend(), `/cockpit/r/${REALM_A}/buchungen`);
    const filter = await screen.findByRole('form', { name: 'Filter der Buchungsliste' });
    const hint = await within(filter).findByText(/noch kein Objekt aus MicroRealEstate verknüpft/);
    expect(linkIn(hint, 'Objekte verknüpfen').getAttribute('href')).toBe(OBJEKTE);
  });

  it('counter-check: with a linked object neither the split editor nor the filter shows the hint', async () => {
    backend().seedRent('IMPORTED');
    await openApp(backend(), `/cockpit/r/${REALM_A}/buchungen`);
    await screen.findByRole('form', { name: 'Filter der Buchungsliste' });
    await openTransaction(backend(), 'Miete Oktober Testwohnung');
    await waitFor(() => control('split-0-reference'));
    type(control('split-0-reference'), 'property');
    await waitFor(() => expect(within(control('split-0-property')).getAllByRole('option')).toHaveLength(2));
    expect(screen.queryByText(/noch kein Objekt aus MicroRealEstate verknüpft/)).toBeNull();
  });
});

describe('Durchstich of a fresh Realm: account, link, import, split with an object, through the UI only', () => {
  it('from an empty Realm to the first import and the first split with an object, with no request outside the UI', async () => {
    backend().fresh();
    await openApp(backend(), `/cockpit/r/${REALM_A}/`);

    // 1. Konto anlegen, from the overview.
    fireEvent.click(linkIn(await screen.findByRole('region', { name: 'Einrichtung' }), 'Konto anlegen'), { button: 0 });
    expect(await screen.findByText(/In diesem Bestand gibt es noch kein Konto/)).toBeTruthy();
    type(control('konto-name'), 'Girokonto Neu');
    type(control('konto-iban'), IBAN);
    click('Konto anlegen');
    await screen.findByText(`Konto „Girokonto Neu“ angelegt (Bankkonto, IBAN ${IBAN}).`);
    const created = backend().setup.accounts.find((a) => a.mreRealmId === REALM_A);

    // 2. Objekte verknüpfen, from the overview: both MRE properties.
    nav('Übersicht');
    fireEvent.click(linkIn(await screen.findByRole('region', { name: 'Einrichtung' }), 'Objekte verknüpfen'), { button: 0 });
    await screen.findByRole('list', { name: 'Objekte in MicroRealEstate' });
    click('Testhaus Wohnung 1 verknüpfen');
    await screen.findByText('„Testhaus Wohnung 1“ ist verknüpft.');
    click(`${MRE_UNLINKED_NAME} verknüpfen`);
    await screen.findByText(`„${MRE_UNLINKED_NAME}“ ist verknüpft.`);
    const second = backend().setup.references.find((r) => r.mreRealmId === REALM_A && r.mrePropertyId === MRE_UNLINKED);

    // 3. Import: the one account is chosen; the rows of the file become bookings.
    nav('Import');
    const select = await screen.findByLabelText<HTMLSelectElement>('Konto');
    expect(select.value).toBe(created?.financialAccountId);
    await importCsv(csvFile());
    showAllRows();
    expect(screen.getAllByText('Neu angelegt')).toHaveLength(3);
    const [upload] = requests(backend(), 'POST', '/api/v1/imports/bank-transactions');
    expect(JSON.parse(upload?.form?.get('metadata') as string)).toMatchObject({ financialAccountId: created?.financialAccountId });

    // 4. The rent, opened from the list, split with the newly linked object.
    nav('Buchungen');
    fireEvent.click(await screen.findByRole('link', { name: 'Buchung vom 01.10.2026 öffnen' }), { button: 0 });
    await splitRent(second?.propertyReferenceId ?? '');
    await screen.findByText(/Aufteilung gespeichert \(Status/);
    const [put] = requests(backend(), 'PUT', /\/splits$/);
    const splits = (JSON.parse(put?.body ?? '{}') as { splits: { propertyReferenceId?: string }[] }).splits;
    expect(splits[0]?.propertyReferenceId).toBe(second?.propertyReferenceId);
    expect(
      backend()
        .tx('Miete Oktober Testwohnung')
        .splits.map((s) => s.propertyReferenceId),
    ).toEqual([second?.propertyReferenceId, null]);

    // Every command came from the clicks above; nothing was seeded through the API.
    const rent = backend().tx('Miete Oktober Testwohnung');
    expect(commands(backend())).toEqual([
      'POST /api/v1/financial-accounts',
      'POST /api/v1/property-references/link',
      'POST /api/v1/property-references/link',
      'POST /api/v1/imports/bank-transactions',
      `PUT /api/v1/transactions/${rent.id}/splits`,
    ]);
    expect(
      backend()
        .setup.references.filter((r) => r.mreRealmId === REALM_A)
        .map((r) => r.mrePropertyId),
    ).toEqual([MRE_LINKED, MRE_UNLINKED]);
    expect(rent.financialAccountId).toBe(created?.financialAccountId);
  });
});
