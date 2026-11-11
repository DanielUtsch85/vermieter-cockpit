// @vitest-environment jsdom
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { rentTermPath } from '../routing';
import { TENANT } from '../rent/fixtures.test-support';
import { PROPERTY, REALM_A, REALM_B } from '../transactions/fixtures.test-support';
import { EMAIL, TERM_OCT } from './fake-backend.test-support';
import { act, click, commands, control, go, MRE_COMMANDS, openApp, requests, settle, splitRent, type, useDurchstich } from './walk.test-support';

/**
 * Step 7 (ui-guide.md §10, §11, §12 point 5): the session and the Realm across the Durchstich. An expired token in the
 * middle of a step, a `403` and a `404`, a Realm switch, and §11's rule that no read, refetch or change of tab writes to
 * MRE. Against the whole App with a real Session and the stateful fake backend.
 */

const backend = useDurchstich();
const here = () => `${window.location.pathname}${window.location.search}`;
const EXPIRED = 'Ihre Sitzung ist abgelaufen. Bitte melden Sie sich erneut an.';
const tokenOf = (headers: Headers) => headers.get('authorization');

function signInAgain() {
  type(screen.getByLabelText('E-Mail-Adresse'), EMAIL);
  type(screen.getByLabelText('Passwort'), 'synthetisch');
  click('Anmelden');
}

describe('an expired token in the middle of a step: the sign-in, then the same URL; nothing lost or doubled on the server', () => {
  it('split: the save meets the expiry; the server is unchanged, after the sign-in the same booking is read again and saved once', async () => {
    const t = backend().seedRent('IMPORTED');
    const url = `/cockpit/r/${REALM_A}/buchungen/${t.id}`;
    await openApp(backend(), url);
    await splitRent(PROPERTY, false);
    backend().expireSession();
    click('Aufteilung speichern');
    expect(await screen.findByText(EXPIRED)).toBeTruthy();
    // The sign-in page takes the content's place; the URL stays, nothing of the booking is shown.
    expect(here()).toBe(url);
    expect(screen.queryByRole('heading', { name: /Buchung vom/ })).toBeNull();
    expect([t.version, t.splits.length, t.status]).toEqual([1, 0, 'IMPORTED']);
    const refused = requests(backend(), 'PUT', /\/splits$/);
    expect(refused).toHaveLength(1);
    signInAgain();
    await screen.findByRole('heading', { name: /Buchung vom/ });
    expect(here()).toBe(url);
    // Read again with the new session's token, in the Realm of the URL; the old draft is not sent by itself.
    const reread = requests(backend(), 'GET', `/api/v1/transactions/${t.id}`).at(-1);
    expect(tokenOf(reread?.headers ?? new Headers())).not.toBe(tokenOf(refused[0]?.headers ?? new Headers()));
    expect(reread?.headers.get('organizationid')).toBe(REALM_A);
    await settle();
    expect(requests(backend(), 'PUT', /\/splits$/)).toHaveLength(1);
    await splitRent(PROPERTY);
    await screen.findByText(/Aufteilung gespeichert \(Version 2/);
    expect(requests(backend(), 'PUT', /\/splits$/).map((s) => s.headers.get('if-match'))).toEqual(['"1"', '"1"']);
    expect(t.splits).toHaveLength(2);
    expect(backend().counters.signIns).toBe(1);
  });

  it('write-back: the click meets the expiry; MRE is not written, and after the sign-in nothing is sent again by itself', async () => {
    const t = backend().seedRent('CONFIRMED');
    const r = backend().seedReconciliation(t, { status: 'CONFIRMED', version: 2 });
    const url = `/cockpit/r/${REALM_A}/mietabgleich/${r.id}`;
    await openApp(backend(), url);
    await screen.findByRole('button', { name: 'An MRE übertragen' });
    backend().expireSession();
    click('An MRE übertragen');
    expect(await screen.findByText(EXPIRED)).toBeTruthy();
    expect(backend().counters.mreWrites).toBe(0);
    signInAgain();
    fireEvent.click(await screen.findByRole('button', { name: 'An MRE übertragen' }));
    expect(await screen.findByText('MRE: übertragen')).toBeTruthy();
    expect(here()).toBe(url);
    // One refused (old token), one written on the user's new click; MRE written once.
    expect(requests(backend(), 'POST', MRE_COMMANDS)).toHaveLength(2);
    expect(backend().counters.mreWrites).toBe(1);
  });

  it('correction: the answer is lost, then the session ends; after the sign-in the booking shows the one correction, none is made again', async () => {
    const t = backend().seedRent('CONFIRMED');
    backend().fault(`POST /api/v1/transactions/${t.id}/correct`, { lose: true });
    const url = `/cockpit/r/${REALM_A}/buchungen/${t.id}`;
    await openApp(backend(), url);
    fireEvent.click(await screen.findByRole('button', { name: 'Korrektur erfassen' }));
    type(control('korrektur-reason'), 'Verwendungszweck falsch erfasst');
    type(control('korrektur-description'), 'Miete Oktober Testwohnung (korrigiert)');
    click('Korrektur ausführen');
    expect(await screen.findByText(/Ob die Korrektur ausgeführt wurde, ist unklar/)).toBeTruthy();
    backend().expireSession();
    click('Erneut senden');
    expect(await screen.findByText(EXPIRED)).toBeTruthy();
    signInAgain();
    await screen.findByRole('heading', { name: /Buchung vom/ });
    expect(here()).toBe(url);
    // The booking as the server holds it: corrected once, with its chain; no form offers a second correction.
    expect((await screen.findAllByText(/Korrigiert/)).length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: 'Korrektur erfassen' })).toBeNull();
    expect([...backend().transactions.values()].filter((x) => x.correctionOfTransactionId === t.id)).toHaveLength(2);
    expect(requests(backend(), 'POST', `/api/v1/transactions/${t.id}/correct`)).toHaveLength(2);
  });
});

describe('a token refused within the session: renewed once, the same request once more', () => {
  it('write-back: the 30 s token ran out; renewed through the refresh cookie, the same write-back sent once more, MRE written once', async () => {
    const t = backend().seedRent('CONFIRMED');
    const r = backend().seedReconciliation(t, { status: 'CONFIRMED', version: 2 });
    await openApp(backend(), `/cockpit/r/${REALM_A}/mietabgleich/${r.id}`);
    await screen.findByRole('button', { name: 'An MRE übertragen' });
    backend().expireAccessTokens();
    click('An MRE übertragen');
    expect(await screen.findByText('MRE: übertragen')).toBeTruthy();
    const sent = requests(backend(), 'POST', MRE_COMMANDS);
    expect(sent).toHaveLength(2);
    expect(tokenOf(sent[0]?.headers ?? new Headers())).not.toBe(tokenOf(sent[1]?.headers ?? new Headers()));
    expect(sent.map((s) => s.headers.get('if-match'))).toEqual(['"2"', '"2"']);
    expect(backend().counters.mreWrites).toBe(1);
    expect(screen.queryByText(EXPIRED)).toBeNull();
  });

  it('the renewed token is refused again: the session ends with the sign-in page; the command is not sent a third time', async () => {
    const t = backend().seedRent('CONFIRMED');
    const r = backend().seedReconciliation(t);
    await openApp(backend(), `/cockpit/r/${REALM_A}/mietabgleich/${r.id}`);
    await screen.findByRole('button', { name: 'Zuordnung bestätigen' });
    backend().refuseAllTokens = true;
    click('Zuordnung bestätigen');
    expect(await screen.findByText(EXPIRED)).toBeTruthy();
    await settle();
    const sent = requests(backend(), 'POST', `/api/v1/rent-reconciliations/${r.id}/confirm`);
    expect(sent).toHaveLength(2);
    expect(tokenOf(sent[0]?.headers ?? new Headers())).not.toBe(tokenOf(sent[1]?.headers ?? new Headers()));
    expect(r.status).toBe('SUGGESTED');
  });

  it('the MRE sign-in does not answer the renewal: no answer is said, nothing written; read again on request once it answers', async () => {
    const t = backend().seedRent('CONFIRMED');
    const r = backend().seedReconciliation(t, { status: 'CONFIRMED', version: 2 });
    await openApp(backend(), `/cockpit/r/${REALM_A}/mietabgleich/${r.id}`);
    await screen.findByRole('button', { name: 'An MRE übertragen' });
    backend().expireAccessTokens();
    backend().authenticatorUp = false;
    click('An MRE übertragen');
    expect((await screen.findAllByText('Keine Antwort')).length).toBeGreaterThan(0);
    expect(screen.queryByText('MRE: übertragen')).toBeNull();
    expect(backend().counters.mreWrites).toBe(0);
    await settle();
    expect(requests(backend(), 'POST', MRE_COMMANDS)).toHaveLength(1);
    backend().authenticatorUp = true;
    click('Erneut laden');
    fireEvent.click(await screen.findByRole('button', { name: 'An MRE übertragen' }));
    expect(await screen.findByText('MRE: übertragen')).toBeTruthy();
    expect(backend().counters.mreWrites).toBe(1);
  });
});

describe('403 and 404', () => {
  it('403 on a command: no access is said, nothing changed, no other Realm asked', async () => {
    const t = backend().seedRent('CONFIRMED');
    const r = backend().seedReconciliation(t);
    await openApp(backend(), `/cockpit/r/${REALM_A}/mietabgleich/${r.id}`);
    await screen.findByRole('button', { name: 'Zuordnung bestätigen' });
    backend().forbidden.add(REALM_A);
    click('Zuordnung bestätigen');
    expect(await screen.findByText('Kein Zugriff')).toBeTruthy();
    expect(r.status).toBe('SUGGESTED');
    expect(
      backend()
        .sent.filter((s) => s.path.startsWith('/api/v1/'))
        .every((s) => s.headers.get('organizationid') === REALM_A),
    ).toBe(true);
  });

  it('403 at the access check: the Realm choice is offered, the area is not shown, nothing else is read', async () => {
    backend().forbidden.add(REALM_A);
    await openApp(backend(), `/cockpit/r/${REALM_A}/buchungen`);
    expect(await screen.findByRole('button', { name: 'Anderen Bestand wählen' })).toBeTruthy();
    expect(screen.getByText('Kein Zugriff')).toBeTruthy();
    await settle();
    expect(
      backend()
        .sent.filter((s) => s.path.startsWith('/api/v1/'))
        .map((s) => s.path),
    ).toEqual(['/api/v1/health']);
  });

  it('404: a booking of another Realm under this Realm is not found; nothing of it is shown', async () => {
    const other = [...backend().transactions.values()].find((t) => t.mreRealmId === REALM_B);
    await openApp(backend(), `/cockpit/r/${REALM_A}/buchungen/${other?.id ?? ''}`);
    expect(await screen.findByText('Nicht gefunden')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Zur Buchungsliste' })).toBeTruthy();
    expect(document.body.textContent).not.toContain('Buchung aus Bestand B');
    expect(backend().sent.some((s) => s.headers.get('organizationid') === REALM_B)).toBe(false);
  });
});

describe('a Realm switch is a full reload; nothing of the earlier Realm is shown or asked', () => {
  it('another Realm in the address bar (back button, a link of another tab): reload, no request for it from this memory', async () => {
    const t = backend().seedRent('CONFIRMED');
    const { reloads } = await openApp(backend(), `/cockpit/r/${REALM_A}/buchungen/${t.id}`);
    await screen.findByRole('heading', { name: /Buchung vom/ });
    const other = [...backend().transactions.values()].find((x) => x.mreRealmId === REALM_B);
    await act(() => {
      window.history.pushState(null, '', `/cockpit/r/${REALM_B}/buchungen/${other?.id ?? ''}`);
      fireEvent(window, new PopStateEvent('popstate'));
    });
    expect(await screen.findByText('Die Seite wird für den anderen Bestand neu geladen …')).toBeTruthy();
    expect(reloads).toEqual([`/cockpit/r/${REALM_B}/buchungen/${other?.id ?? ''}`]);
    expect(screen.queryByRole('heading', { name: /Buchung vom/ })).toBeNull();
    expect(document.body.textContent).not.toContain('Miete Oktober Testwohnung');
    await settle();
    expect(backend().sent.some((s) => s.headers.get('organizationid') === REALM_B)).toBe(false);
  });
});

describe('§11: no MRE write by rendering, a refetch, a change of tab or a remount', () => {
  it('a confirmed match offered for write-back: reads, refetches with a token renewal, tabs and the term page send no command at all', async () => {
    const t = backend().seedRent('CONFIRMED');
    const r = backend().seedReconciliation(t, { status: 'CONFIRMED', version: 2 });
    const { queryClient } = await openApp(backend(), `/cockpit/r/${REALM_A}/mietabgleich/${r.id}`);
    await screen.findByRole('button', { name: 'An MRE übertragen' });
    await act(async () => {
      await queryClient.invalidateQueries();
    });
    for (const path of [
      `/cockpit/r/${REALM_A}/mietabgleich`,
      `/cockpit/r/${REALM_A}/mietabgleich?status=CONFIRMED`,
      rentTermPath(REALM_A, { mreTenantId: TENANT, mreRentTerm: TERM_OCT }),
      `/cockpit/r/${REALM_A}/buchungen/${t.id}`,
      `/cockpit/r/${REALM_A}/`,
      `/cockpit/r/${REALM_A}/mietabgleich/${r.id}`,
    ]) {
      await go(path);
      await settle();
    }
    await screen.findByRole('button', { name: 'An MRE übertragen' });
    // A refetch that has to renew the 30 s token first: still only reads.
    backend().expireAccessTokens();
    await act(async () => {
      await queryClient.refetchQueries();
    });
    await waitFor(() => expect(control('aufheben-grund')).toBeTruthy());
    expect(commands(backend())).toEqual([]);
    expect(backend().counters.mreWrites).toBe(0);
    expect(backend().sent.some((s) => s.search.includes('checkMre'))).toBe(false);
  });
});

describe('the MRE sign-in is not reachable at start', () => {
  it('said as such, tried again only on request', async () => {
    backend().authenticatorUp = false;
    await openApp(backend(), `/cockpit/r/${REALM_A}/buchungen`);
    expect(await screen.findByText(/Die Anmeldung von MicroRealEstate antwortet nicht/)).toBeTruthy();
    expect(backend().sent).toEqual([]);
    expect(screen.getByRole('button', { name: 'Erneut versuchen' })).toBeTruthy();
  });
});
