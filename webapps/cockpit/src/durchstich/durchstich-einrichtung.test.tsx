// @vitest-environment jsdom
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { envelope, json } from '../api/fetch.test-support';
import { account, REALM_A, REALM_B } from '../transactions/fixtures.test-support';
import { MRE_LINKED, MRE_UNLINKED, MRE_UNLINKED_NAME } from './fake-setup.test-support';
import { button, click, control, openApp, requests, settle, twice, type, useDurchstich } from './walk.test-support';

/**
 * The setup of a Realm in the cockpit (Issue #365; Entscheidung des Projektinhabers, 2026-11-16): „Konto anlegen“ with the
 * IBAN required for bank and deposit accounts (optional for cash, clearing and other accounts, #372) and checked as the
 * backend checks it, and „Objekte verknüpfen“ from MRE's list of the
 * Realm, against the real UI and the stateful fake DE and MRE (answers through the backend's own mappings, bodies checked
 * with the routes' own schemas). Synthetic IBANs only (the standard German example IBAN).
 */

const backend = useDurchstich();
const KONTO = `/cockpit/r/${REALM_A}/einrichtung/konto`;
const OBJEKTE = `/cockpit/r/${REALM_A}/einrichtung/objekte`;
const IBAN = 'DE89370400440532013000';
const ACCOUNTS = '/api/v1/financial-accounts';
const LINK = '/api/v1/property-references/link';

async function openAccountForm(path = KONTO) {
  await openApp(backend(), path);
  await screen.findByRole('form', { name: 'Konto anlegen' });
}
const fill = (values: { type?: string; name?: string; iban?: string }) => {
  if (values.type !== undefined) type(control('konto-art'), values.type);
  if (values.name !== undefined) type(control('konto-name'), values.name);
  if (values.iban !== undefined) type(control('konto-iban'), values.iban);
};
const accountPosts = () => requests(backend(), 'POST', ACCOUNTS);
const bodyOf = (index: number) => JSON.parse(accountPosts()[index]?.body ?? 'null') as unknown;

describe('Konto anlegen: reachable from the overview, IBAN required for bank accounts', () => {
  it('the overview links both setup pages; the account page is a sub-page of the overview with the accounts listed', async () => {
    await openApp(backend(), `/cockpit/r/${REALM_A}/`);
    const setup = await screen.findByRole('region', { name: 'Einrichtung' });
    expect(within(setup).getByRole('link', { name: 'Objekte verknüpfen' }).getAttribute('href')).toBe(OBJEKTE);
    fireEvent.click(within(setup).getByRole('link', { name: 'Konto anlegen' }), { button: 0 });
    expect(await screen.findByRole('heading', { level: 1, name: 'Konto anlegen' })).toBeTruthy();
    expect(within(screen.getByRole('navigation', { name: 'Brotkrumen' })).getByRole('link', { name: 'Übersicht' })).toBeTruthy();
    const list = await screen.findByRole('list', { name: 'Konten' });
    expect(list.textContent).toContain('Girokonto Testbank');
    expect(list.textContent).toContain('Bankkonto · DE00 0000 0000 0000 0000 01');
    expect(screen.getByLabelText('IBAN')).toBeTruthy();
    expect(screen.getByText(/Eine IBAN lässt sich später nicht nachtragen\./)).toBeTruthy();
  });

  it('a bank account without IBAN or with a wrong check digit is refused at the input; nothing is sent', async () => {
    await openAccountForm();
    fill({ name: 'Girokonto Neu' });
    click('Konto anlegen');
    expect(screen.getByText(/Für diese Kontoart ist die IBAN Pflicht/)).toBeTruthy();
    expect(control('konto-iban').getAttribute('aria-invalid')).toBe('true');
    fill({ iban: 'DE89 3704 0044 0532 0130 01' });
    click('Konto anlegen');
    expect(screen.getByText(/Keine gültige IBAN: Aufbau oder Prüfziffer stimmen nicht/)).toBeTruthy();
    fill({ type: 'SECURITY_DEPOSIT', iban: '' });
    expect(screen.getByLabelText('IBAN')).toBeTruthy();
    click('Konto anlegen');
    expect(screen.getByText(/Für diese Kontoart ist die IBAN Pflicht/)).toBeTruthy();
    fill({ type: 'BANK', name: ' ', iban: IBAN });
    click('Konto anlegen');
    expect(screen.getByText('Bitte einen Namen für das Konto angeben.')).toBeTruthy();
    await settle();
    expect(accountPosts()).toEqual([]);
  });

  it('one POST with the exact body, the Realm and an Idempotency-Key; the new account is listed and offered to the import', async () => {
    await openAccountForm();
    fill({ name: '  Girokonto Neu ', iban: 'de89 3704 0044 0532 0130 00' });
    click('Konto anlegen');
    expect(await screen.findByText(`Konto „Girokonto Neu“ angelegt (Bankkonto, IBAN ${IBAN}).`)).toBeTruthy();
    const [post] = accountPosts();
    expect(bodyOf(0)).toEqual({ accountType: 'BANK', displayName: 'Girokonto Neu', currency: 'EUR', iban: IBAN });
    expect(post?.headers.get('organizationid')).toBe(REALM_A);
    expect(post?.headers.get('content-type')).toBe('application/json');
    expect(post?.headers.get('idempotency-key')).toMatch(/^[0-9a-f-]{36}$/);
    expect(post?.headers.has('if-match')).toBe(false);
    await waitFor(() => expect(screen.getByRole('list', { name: 'Konten' }).textContent).toContain(`Girokonto Neu`));
    expect(backend().setup.accounts.filter((a) => a.mreRealmId === REALM_A)).toHaveLength(2);
    fireEvent.click(screen.getByRole('link', { name: 'Zum Import' }), { button: 0 });
    const select = await screen.findByLabelText('Konto');
    expect(within(select).getByRole('option', { name: `Girokonto Neu · ${IBAN}` })).toBeTruthy();
  });

  it('a cash, a clearing and an other account may go without IBAN; the body then has no iban', async () => {
    await openAccountForm();
    fill({ type: 'CASH', name: 'Handkasse' });
    expect(screen.getByLabelText('IBAN (optional)')).toBeTruthy();
    expect(screen.getByText(/Ohne IBAN ist kein Import mit der Vorlage „VR-Banking“ möglich/)).toBeTruthy();
    click('Konto anlegen');
    expect(await screen.findByText('Konto „Handkasse“ angelegt (Kasse, ohne IBAN).')).toBeTruthy();
    click('Weiteres Konto anlegen');
    fill({ type: 'LOAN_SETTLEMENT', name: 'Verrechnung Darlehen' });
    click('Konto anlegen');
    expect(await screen.findByText('Konto „Verrechnung Darlehen“ angelegt (Verrechnungskonto (Darlehen), ohne IBAN).')).toBeTruthy();
    // A payment service has no IBAN (Entscheidung des Projektinhabers, 2026-11-16, #372).
    click('Weiteres Konto anlegen');
    fill({ type: 'OTHER', name: 'Zahlungsdienst' });
    expect(screen.getByLabelText('IBAN (optional)')).toBeTruthy();
    expect(screen.getByText(/oder ein sonstiges Konto \(etwa einen Zahlungsdienst\) optional/)).toBeTruthy();
    click('Konto anlegen');
    expect(await screen.findByText('Konto „Zahlungsdienst“ angelegt (Sonstiges Konto, ohne IBAN).')).toBeTruthy();
    expect([bodyOf(0), bodyOf(1), bodyOf(2)]).toEqual([
      { accountType: 'CASH', displayName: 'Handkasse', currency: 'EUR' },
      { accountType: 'LOAN_SETTLEMENT', displayName: 'Verrechnung Darlehen', currency: 'EUR' },
      { accountType: 'OTHER', displayName: 'Zahlungsdienst', currency: 'EUR' },
    ]);
    expect(new Set(accountPosts().map((p) => p.headers.get('idempotency-key'))).size).toBe(3);
  });

  it('a double click sends one request and creates one account', async () => {
    await openAccountForm();
    fill({ name: 'Girokonto Neu', iban: IBAN });
    await twice('Konto anlegen');
    await screen.findByText(/Konto „Girokonto Neu“ angelegt/);
    expect(accountPosts()).toHaveLength(1);
    expect(backend().setup.accounts.filter((a) => a.displayName === 'Girokonto Neu')).toHaveLength(1);
  });

  it('a lost answer offers the same body with the same key; the account exists once; a changed body gets a new key', async () => {
    await openAccountForm();
    fill({ name: 'Girokonto Neu', iban: IBAN });
    backend().fault(`POST ${ACCOUNTS}`, { lose: true }, { lose: true });
    click('Konto anlegen');
    expect(await screen.findByText(/Ob das Konto angelegt wurde, ist unklar/)).toBeTruthy();
    click('Erneut senden');
    expect(await screen.findByText(/Ob das Konto angelegt wurde, ist unklar/)).toBeTruthy();
    click('Erneut senden');
    await screen.findByText(/Konto „Girokonto Neu“ angelegt/);
    const keys = accountPosts().map((p) => p.headers.get('idempotency-key'));
    expect(keys).toHaveLength(3);
    expect(new Set(keys).size).toBe(1);
    expect(accountPosts().map((p) => p.body)).toEqual(Array(3).fill(accountPosts()[0]?.body));
    expect(backend().setup.accounts.filter((a) => a.displayName === 'Girokonto Neu')).toHaveLength(1);

    click('Weiteres Konto anlegen');
    backend().fault(`POST ${ACCOUNTS}`, { lose: true });
    fill({ name: 'Girokonto Zwei', iban: IBAN });
    click('Konto anlegen');
    await screen.findByText(/Ob das Konto angelegt wurde, ist unklar/);
    fill({ name: 'Girokonto Drei' });
    expect(screen.queryByRole('button', { name: 'Erneut senden' })).toBeNull();
    click('Konto anlegen');
    await screen.findByText(/Konto „Girokonto Drei“ angelegt/);
    const [, , , second, third] = accountPosts();
    expect(second?.headers.get('idempotency-key')).not.toBe(third?.headers.get('idempotency-key'));
  });

  it('refusals: field errors at their inputs, 409 and 403 in German, the form kept', async () => {
    await openAccountForm();
    backend().fault(
      `POST ${ACCOUNTS}`,
      { answer: () => envelope(400, 'VALIDATION_ERROR', { fields: [{ field: 'iban', code: 'INVALID_FORMAT' }] }) },
      { answer: () => envelope(409, 'CONFLICT') },
      { answer: () => envelope(403, 'FORBIDDEN') },
    );
    fill({ name: 'Girokonto Neu', iban: IBAN });
    click('Konto anlegen');
    expect(await screen.findByText('Kein Konto angelegt: der Server hat die Angaben abgelehnt.')).toBeTruthy();
    expect(screen.getByText('Vom Server abgelehnt: ungültig oder nicht vorgesehen')).toBeTruthy();
    expect(control('konto-iban').getAttribute('aria-invalid')).toBe('true');
    click('Konto anlegen');
    expect(await screen.findByText(/Kein neues Konto angelegt: derselbe Vorgang wurde schon mit anderen Angaben gesendet/)).toBeTruthy();
    click('Konto anlegen');
    expect(await screen.findByText('Kein Zugriff')).toBeTruthy();
    expect(screen.getByText('Kein Konto angelegt.')).toBeTruthy();
    expect(control('konto-name').value).toBe('Girokonto Neu');
    expect(screen.queryByRole('button', { name: 'Erneut senden' })).toBeNull();
  });

  it('realm isolation: the account belongs to its Realm; an answer of another Realm is refused, never shown', async () => {
    backend().fault(`POST ${ACCOUNTS}`, { answer: () => json(201, account({ mreRealmId: REALM_B, displayName: 'Girokonto Neu', iban: IBAN })) });
    await openAccountForm();
    fill({ name: 'Girokonto Neu', iban: IBAN });
    click('Konto anlegen');
    expect(await screen.findByText('Antwort eines anderen Bestands')).toBeTruthy();
    expect(screen.queryByText(/Konto „Girokonto Neu“ angelegt/)).toBeNull();
    click('Konto anlegen');
    await screen.findByText(/Konto „Girokonto Neu“ angelegt/);
    expect(
      backend()
        .setup.accounts.filter((a) => a.displayName === 'Girokonto Neu')
        .map((a) => a.mreRealmId),
    ).toEqual([REALM_A]);
    expect(backend().sent.every((s) => s.headers.get('organizationid') !== REALM_B)).toBe(true);
  });

  it('the account list of another Realm shows only its own accounts', async () => {
    backend().setup.accounts.push(account({ mreRealmId: REALM_B, financialAccountId: 'c2be5b4a-6d7f-4a89-9bac-4c5d6e7f8091', displayName: 'Konto B' }));
    await openAccountForm(`/cockpit/r/${REALM_B}/einrichtung/konto`);
    const list = await screen.findByRole('list', { name: 'Konten' });
    expect(list.textContent).toContain('Konto B');
    expect(list.textContent).not.toContain('Girokonto Testbank');
  });
});

describe('Objekte verknüpfen: MRE list of the Realm, already linked shown, one link per click', () => {
  const mreList = () => backend().sent.filter((s) => s.method === 'GET' && s.path === '/api/v2/properties');
  async function openLinkPage(path = OBJEKTE) {
    await openApp(backend(), path);
    return screen.findByRole('list', { name: 'Objekte in MicroRealEstate' });
  }
  const item = (list: HTMLElement, name: string) => {
    const found = within(list)
      .getAllByRole('listitem')
      .find((li) => li.textContent?.includes(name));
    if (found === undefined) throw new Error(`no item ${name}`);
    return found;
  };

  it('lists MRE properties of the Realm with organizationid; the linked one is marked, the other offers Verknüpfen', async () => {
    const list = await openLinkPage();
    expect(mreList().map((s) => s.headers.get('organizationid'))).toEqual([REALM_A]);
    expect(within(item(list, 'Testhaus Wohnung 1')).getByText('Verknüpft')).toBeTruthy();
    expect(within(item(list, 'Testhaus Wohnung 1')).queryByRole('button')).toBeNull();
    expect(within(item(list, MRE_UNLINKED_NAME)).getByRole('button', { name: `${MRE_UNLINKED_NAME} verknüpfen` })).toBeTruthy();
    expect(list.textContent).toContain(MRE_LINKED);
  });

  it('Verknüpfen sends the exact body once; the property is then marked linked and offered in the split editor', async () => {
    const list = await openLinkPage();
    await twice(`${MRE_UNLINKED_NAME} verknüpfen`);
    expect(await screen.findByText(`„${MRE_UNLINKED_NAME}“ ist verknüpft.`)).toBeTruthy();
    const posts = requests(backend(), 'POST', LINK);
    expect(posts).toHaveLength(1);
    expect(JSON.parse(posts[0]?.body ?? 'null')).toEqual({ mreRealmId: REALM_A, mrePropertyId: MRE_UNLINKED });
    expect(posts[0]?.headers.has('idempotency-key')).toBe(false);
    expect(posts[0]?.headers.get('organizationid')).toBe(REALM_A);
    await waitFor(() => expect(within(item(list, MRE_UNLINKED_NAME)).getByText('Verknüpft')).toBeTruthy());
    expect(
      backend()
        .setup.references.filter((r) => r.mreRealmId === REALM_A)
        .map((r) => r.mrePropertyId),
    ).toEqual([MRE_LINKED, MRE_UNLINKED]);
  });

  it('refusals in German: 404 not in MRE, 503 MRE unavailable (offered again), nothing shown as linked', async () => {
    backend().fault(`POST ${LINK}`, { answer: () => envelope(404, 'NOT_FOUND') });
    const list = await openLinkPage();
    click(`${MRE_UNLINKED_NAME} verknüpfen`);
    expect(await screen.findByText(/Nicht verknüpft: das Objekt ist in MicroRealEstate in diesem Bestand nicht \(mehr\) vorhanden/)).toBeTruthy();
    expect(within(item(list, MRE_UNLINKED_NAME)).queryByText('Verknüpft')).toBeNull();
    backend().mreUp = false;
    click(`${MRE_UNLINKED_NAME} verknüpfen`);
    expect(await screen.findByText(/Nicht verknüpft: MicroRealEstate ist nicht erreichbar/)).toBeTruthy();
    expect(screen.getByText(/Erneut „Verknüpfen“ legt keine zweite Verknüpfung an/)).toBeTruthy();
    backend().mreUp = true;
    click(`${MRE_UNLINKED_NAME} verknüpfen`);
    await screen.findByText(`„${MRE_UNLINKED_NAME}“ ist verknüpft.`);
    expect(backend().setup.references.filter((r) => r.mrePropertyId === MRE_UNLINKED)).toHaveLength(1);
  });

  it('realm isolation: Realm B lists only its own MRE properties and links; an answer of another Realm is refused', async () => {
    const list = await openLinkPage(`/cockpit/r/${REALM_B}/einrichtung/objekte`);
    expect(list.textContent).toContain('Haus B');
    expect(list.textContent).not.toContain('Testhaus');
    expect(within(item(list, 'Haus B')).getByText('Verknüpft')).toBeTruthy();
    expect(mreList().map((s) => s.headers.get('organizationid'))).toEqual([REALM_B]);
    expect(backend().sent.every((s) => s.headers.get('organizationid') !== REALM_A)).toBe(true);
  });

  it('an answer that names another Realm is refused and the property stays unlinked on the page', async () => {
    const other = { ...backend().setup.references[0], mreRealmId: REALM_B, mrePropertyId: MRE_UNLINKED };
    backend().fault(`POST ${LINK}`, { answer: () => json(201, other) });
    const list = await openLinkPage();
    click(`${MRE_UNLINKED_NAME} verknüpfen`);
    expect(await screen.findByText('Antwort eines anderen Bestands')).toBeTruthy();
    expect(within(item(list, MRE_UNLINKED_NAME)).queryByText('Verknüpft')).toBeNull();
    expect(button(`${MRE_UNLINKED_NAME} verknüpfen`).disabled).toBe(false);
  });

  it('MRE without properties says where they come from', async () => {
    backend().setup.mreProperties.set(REALM_A, []);
    await openApp(backend(), OBJEKTE);
    expect(await screen.findByText(/In MicroRealEstate gibt es in diesem Bestand noch kein Objekt/)).toBeTruthy();
  });

  it('an unreachable MRE gateway is shown as an error, never as an empty list', async () => {
    backend().mreUp = false;
    await openApp(backend(), OBJEKTE);
    expect(await screen.findByText('Die Objektliste von MicroRealEstate konnte nicht gelesen werden.')).toBeTruthy();
    expect(screen.queryByText(/noch kein Objekt/)).toBeNull();
    backend().mreUp = true;
    click('Erneut laden');
    expect(await screen.findByRole('list', { name: 'Objekte in MicroRealEstate' })).toBeTruthy();
  });
});
