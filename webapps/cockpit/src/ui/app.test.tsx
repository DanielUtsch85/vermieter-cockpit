import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import { ApiError, CLIENT_CODES } from '../api/errors';
import { fakeJwt } from '../api/fetch.test-support';
import { createQueryClient, realmKey, sessionKey } from '../query';
import { createRealmLock, type RealmLock } from '../routing';
import type { MreAuthenticator } from '../session/mre-authenticator';
import { Session } from '../session/session';
import { SessionContext } from '../session/use-session';
import { BACKEND_PIN } from '../gate/backend-pin';
import { App } from './App';
import { RealmList } from './RealmChoice';
import { importKeys } from './imports/ImportArea';
import { transactionKeys } from './transactions/TransactionsArea';
import { batch, BATCH } from '../imports/fixtures.test-support';
import { detail, page, transaction, TX } from '../transactions/fixtures.test-support';

const A = '64b7f0c2a1b2c3d4e5f60718';
const B = '64b7f0c2a1b2c3d4e5f60719';
const TOKEN = fakeJwt({ account: { email: 'admin1@example.com' }, exp: 4_000_000_000 });

/** An authenticator whose refresh answers as given; nothing here reaches a network. */
function authenticator(refresh: () => Promise<string | undefined>): MreAuthenticator {
  return { refresh, signIn: () => Promise.resolve(TOKEN), signOut: () => Promise.resolve() };
}

async function signedIn(): Promise<Session> {
  const session = new Session(authenticator(() => Promise.resolve(TOKEN)));
  await session.start();
  return session;
}

/** The App at a path, rendered to markup: what the user sees first, before any request has answered. */
function render(session: Session, path: string, options: { queryClient?: QueryClient; realmLock?: RealmLock } = {}): string {
  const [pathname = '', search = ''] = path.split(/(?=\?)/);
  Object.assign(globalThis, { window: { location: { pathname, search } } });
  const reloads: string[] = [];
  const html = renderToStaticMarkup(
    <SessionContext.Provider value={session}>
      <QueryClientProvider client={options.queryClient ?? createQueryClient()}>
        <App realmLock={options.realmLock ?? createRealmLock()} reload={() => reloads.push(path)} />
      </QueryClientProvider>
    </SessionContext.Provider>,
  );
  // Effects do not run in a render to markup: a reload is asked for by the browser only, never during rendering.
  expect(reloads).toEqual([]);
  return html;
}

afterEach(() => {
  Reflect.deleteProperty(globalThis, 'window');
});

describe('step 1, session states of the app (ui-guide.md §7.2, §7.4)', () => {
  it('loading: while the session is checked, a busy status and nothing of a Realm', () => {
    const html = render(new Session(authenticator(() => new Promise(() => undefined))), `/cockpit/r/${A}/`);
    expect(html).toContain('role="status"');
    expect(html).toContain('Sitzung wird geprüft');
    expect(html).not.toContain('Hauptnavigation');
  });

  it('an unreachable authenticator is an error with a retry, not a sign-in page', async () => {
    const session = new Session(authenticator(() => Promise.reject(new ApiError(0, CLIENT_CODES.network, 'x'))));
    await session.start();
    const html = render(session, '/cockpit/');
    expect(html).toContain('role="alert"');
    expect(html).toContain('Erneut versuchen');
    expect(html).not.toContain('Passwort');
  });

  it('signed out: the sign-in page at every URL, a deep link included, with no shell and no Realm', async () => {
    const session = new Session(authenticator(() => Promise.resolve(undefined)));
    await session.start();
    const html = render(session, `/cockpit/r/${A}/buchungen`);
    expect(html).toContain('Passwort');
    expect(html).not.toContain('Hauptnavigation');
    expect(html).not.toContain(A);
    expect(html).not.toContain('Sitzung ist abgelaufen');
  });

  it('an expired session says so on the sign-in page', async () => {
    const session = await signedIn();
    session.expire();
    expect(render(session, `/cockpit/r/${A}/`)).toContain('Ihre Sitzung ist abgelaufen');
  });
});

describe('step 1, the Realm choice (§47.2 point 3)', () => {
  it('loading, then the Realms as links into each Realm', async () => {
    const session = await signedIn();
    expect(render(session, '/cockpit/')).toContain('Bestände werden geladen');
    const queryClient = createQueryClient();
    queryClient.setQueryData(sessionKey(0, 'realms'), [
      { id: A, name: 'Bestand Nord' },
      { id: B, name: '' },
    ]);
    const html = render(session, '/cockpit/', { queryClient });
    expect(html).toContain(`href="/cockpit/r/${A}/"`);
    expect(html).toContain('Bestand Nord');
    expect(html).toContain(`href="/cockpit/r/${B}/"`);
    expect(html).toContain('Ohne Namen');
  });

  it('empty: no Realm for the account is said, not shown as an error', () => {
    const html = renderToStaticMarkup(<RealmList realms={{ status: 'success', data: [] }} />);
    expect(html).toContain('Zu Ihrem Konto gibt es keinen Bestand');
    expect(html).not.toContain('role="alert"');
  });

  it('error: a 403 (no landlord account) and a 503 with Retry-After are errors, never an empty list', () => {
    const forbidden = renderToStaticMarkup(<RealmList realms={{ status: 'error', error: new ApiError(403, CLIENT_CODES.unexpected, 'x') }} />);
    expect(forbidden).toContain('role="alert"');
    expect(forbidden).toContain('verweigert diesem Konto die Liste der Bestände');
    expect(forbidden).not.toContain('keinen Bestand');
    const unavailable = renderToStaticMarkup(
      <RealmList realms={{ status: 'error', error: new ApiError(503, 'EXTERNAL_SYSTEM_ERROR', 'x', undefined, [], 7) }} />,
    );
    expect(unavailable).toContain('Dienst nicht erreichbar');
    expect(unavailable).toContain('in 7 Sekunden');
    const lost = renderToStaticMarkup(<RealmList realms={{ status: 'error', error: new ApiError(0, CLIENT_CODES.network, 'x') }} />);
    expect(lost).toContain('unklar');
  });
});

describe('step 1, a Realm in the URL (§47.2 point 3, ui-guide.md §7.3)', () => {
  const health = (realmId: string) => ({ status: 'ok', mreRealmId: realmId });

  it('loading: the shell with the Realm of the URL, its content only after DE confirmed access', async () => {
    const html = render(await signedIn(), `/cockpit/r/${A}/`);
    expect(html).toContain('Hauptnavigation');
    expect(html).toContain(A);
    expect(html).toContain('Zugriff auf den Bestand wird geprüft');
    expect(html).not.toContain('Arbeitsbereiche');
  });

  it('success: the overview of the Realm with its name from the Realm list', async () => {
    const queryClient = createQueryClient();
    queryClient.setQueryData(realmKey(A, 0, 'health'), health(A));
    queryClient.setQueryData(sessionKey(0, 'realms'), [{ id: A, name: 'Bestand Nord' }]);
    const html = render(await signedIn(), `/cockpit/r/${A}/`, { queryClient });
    expect(html).toContain('Zugriff bestätigt für diesen Bestand');
    expect(html).toContain(`<span title="${A}">Bestand Nord</span>`);
    expect(html).toContain('Arbeitsbereiche');
    // The MRE ObjectIds of the Realm and of DE's answer: in the collapsed technical details only (Issue #352, point 3).
    const details = /<details[^>]*>.*<\/details>/s.exec(html)?.[0] ?? '';
    expect(details).toContain('<summary class="min-h-touch cursor-pointer py-2">Technische Angaben</summary>');
    expect(details).toContain(`<dt>Bestand (MRE-ID)</dt><dd class="min-w-0 break-all font-mono">${A}</dd>`);
    expect(details).toContain(`<dt>Zugriff bestätigt für</dt><dd class="min-w-0 break-all font-mono">${A}</dd>`);
    const main = html.slice(html.indexOf('<main'));
    // Outside them, the id is in no text (only in links and in the tooltip of the name).
    expect(main.replace(details, '').replace(/<[^>]+>/g, ' ')).not.toContain(A);
  });

  it('a Realm without a name: the id stays visible, as the only way to tell it', async () => {
    const queryClient = createQueryClient();
    queryClient.setQueryData(realmKey(A, 0, 'health'), health(A));
    queryClient.setQueryData(sessionKey(0, 'realms'), [{ id: B, name: 'Bestand Sued' }]);
    const html = render(await signedIn(), `/cockpit/r/${A}/`, { queryClient });
    expect(html).toContain(`<span class="text-muted">Name nicht verfügbar</span> <code class="font-mono text-label">${A}</code>`);
  });

  it('the answer of another Realm is never shown for the Realm of the URL', async () => {
    const queryClient = createQueryClient();
    queryClient.setQueryData(realmKey(B, 0, 'health'), health(B));
    const html = render(await signedIn(), `/cockpit/r/${A}/`, { queryClient });
    expect(html).toContain('Zugriff auf den Bestand wird geprüft');
    expect(html).not.toContain(B);
    expect(html).not.toContain('Zugriff bestätigt');
  });

  it('the answer of an earlier session is never shown in a new one (epoch in the key)', async () => {
    const session = await signedIn();
    await session.signOut();
    await session.signIn('admin1@example.com', 'x');
    expect(session.getState()).toMatchObject({ status: 'signedIn', epoch: 1 });
    const queryClient = createQueryClient();
    queryClient.setQueryData(realmKey(A, 0, 'health'), health(A));
    const html = render(session, `/cockpit/r/${A}/`, { queryClient });
    expect(html).toContain('Zugriff auf den Bestand wird geprüft');
    expect(html).not.toContain('Zugriff bestätigt');
  });

  it('another Realm in the same document is not rendered from memory: the page is loaded afresh', async () => {
    const session = await signedIn();
    const realmLock = createRealmLock();
    const queryClient = createQueryClient();
    queryClient.setQueryData(realmKey(A, 0, 'health'), health(A));
    expect(render(session, `/cockpit/r/${A}/`, { queryClient, realmLock })).toContain('Zugriff bestätigt');
    const switched = render(session, `/cockpit/r/${B}/`, { queryClient, realmLock });
    expect(switched).toContain('Bestand wird gewechselt');
    expect(switched).not.toContain('Hauptnavigation');
    expect(switched).not.toContain(A);
    expect(render(session, `/cockpit/r/${A}/import`, { queryClient, realmLock })).toContain('Hauptnavigation');
  });

  it('the Realm lock: the first Realm is the document Realm, every other one asks for a reload', () => {
    const lock = createRealmLock();
    expect(lock(A)).toBe('show');
    expect(lock(A)).toBe('show');
    expect(lock(B)).toBe('reload');
    expect(lock(A)).toBe('show');
    expect(createRealmLock()(B)).toBe('show');
  });

  it('a path that is no page of the cockpit is not found, never another Realm', async () => {
    const html = render(await signedIn(), `/cockpit/r/${A}/finanzierung`);
    expect(html).toContain('Seite nicht gefunden');
    expect(html).not.toContain('Hauptnavigation');
  });
});

describe('step 2, the Buchungen area in the app (ui-guide.md §6.3, §7.3, §10)', () => {
  const health = (realmId: string) => ({ status: 'ok', mreRealmId: realmId });
  const firstPage = { page: '1', pageSize: '50' };

  function seeded(realmId: string, epoch = 0): QueryClient {
    const queryClient = createQueryClient();
    queryClient.setQueryData(realmKey(realmId, epoch, 'health'), health(realmId));
    return queryClient;
  }

  it('the list of the Realm of the URL, its filters read from the URL', async () => {
    const queryClient = seeded(A);
    queryClient.setQueryData(transactionKeys.list(A, 0, { status: 'IMPORTED', ...firstPage }), page([transaction({ mreRealmId: A })]));
    const html = render(await signedIn(), `/cockpit/r/${A}/buchungen?status=IMPORTED&q=frei`, { queryClient });
    expect(html).toContain('<h1 tabindex="-1" class="text-title font-semibold">Buchungen</h1>');
    expect(html).toContain('Miete Maerz Testwohnung');
    expect(html).toContain('name="status" checked="" value="IMPORTED"');
    expect(html).not.toContain('noch nicht verfügbar');
  });

  it('loading until the list of this Realm and session answered: a list of another Realm or session is never shown', async () => {
    const queryClient = seeded(A);
    queryClient.setQueryData(transactionKeys.list(B, 0, firstPage), page([transaction({ mreRealmId: B, description: 'Fremder Bestand' })]));
    queryClient.setQueryData(transactionKeys.list(A, 1, firstPage), page([transaction({ mreRealmId: A, description: 'Andere Sitzung' })]));
    const html = render(await signedIn(), `/cockpit/r/${A}/buchungen`, { queryClient });
    expect(html).toContain('Buchungen werden geladen');
    expect(html).not.toContain('Fremder Bestand');
    expect(html).not.toContain('Andere Sitzung');
    expect(html).not.toContain(B);
  });

  it('a Transaction at its own URL, its detail cached per Realm', async () => {
    const queryClient = seeded(A);
    queryClient.setQueryData(transactionKeys.detail(A, 0, TX), { transaction: detail({ mreRealmId: A }), etag: '"3"' });
    const html = render(await signedIn(), `/cockpit/r/${A}/buchungen/${TX.toUpperCase()}`, { queryClient });
    // The detail of Realm A from its cache; its title „Buchung vom 01.03.2026“ is set by the page (durchstich-seiten.test.tsx).
    expect(html).toContain('<h2 id="buchung" class="text-section font-semibold">Angaben zur Buchung</h2>');
    expect(html).toContain('Miete Maerz Testwohnung');
    const other = seeded(B);
    other.setQueryData(transactionKeys.detail(A, 0, TX), { transaction: detail({ mreRealmId: A }), etag: '"3"' });
    expect(render(await signedIn(), `/cockpit/r/${B}/buchungen/${TX}`, { queryClient: other })).toContain('Buchung wird geladen');
  });

  it('the overview says what the Buchungen, Import and Mietabgleich areas offer, the whole scope of each', async () => {
    const html = render(await signedIn(), `/cockpit/r/${A}/`, { queryClient: seeded(A) });
    // Issue #352 point 2: every step is built, the Buchungen area names its whole scope.
    expect(html).toContain('· Liste mit Filtern, Detail, Aufteilung, Bestätigen, Korrigieren und Stornieren</span>');
    // Step 5 replaced the placeholder of the Import area: what it offers, nothing left for later.
    expect(html).toContain('· Datei und Konto wählen, Import ausführen, Ergebnis und Klärfälle</span>');
    expect(html).not.toContain('Schritt 5');
    // Step 6 replaced the placeholder of the Mietabgleich area.
    expect(html).toContain(
      '· Vorschläge ermitteln und prüfen, Zuordnung bestätigen, an MRE übertragen, aufheben und aus MRE entfernen, Abdeckung je Termin</span>',
    );
    expect(html).not.toContain('Schritt 6');
  });

  it('the overview names no step of the Durchstich and no commit, not even in the technical details', async () => {
    const html = render(await signedIn(), `/cockpit/r/${A}/`, { queryClient: seeded(A) });
    expect(html).toContain('Arbeitsbereiche');
    for (const stale of [
      'Durchstich',
      'entsteht im',
      'Integrations-Gate',
      'Backend-Stand',
      'Routen im Inventar',
      'noch nicht verfügbar',
      'github.com',
      BACKEND_PIN.commit.slice(0, 7),
    ]) {
      expect(html).not.toContain(stale);
    }
    expect(html).not.toMatch(/\b[0-9a-f]{40}\b/);
  });
});

describe('step 5, the Import area in the app (ui-guide.md §3.1, §6.5)', () => {
  const seeded = (realmId: string) => {
    const queryClient = createQueryClient();
    queryClient.setQueryData(realmKey(realmId, 0, 'health'), { status: 'ok', mreRealmId: realmId });
    return queryClient;
  };

  it('the area is the import, no placeholder: the upload at …/import, one batch at …/import/<id>, cached per Realm', async () => {
    const upload = render(await signedIn(), `/cockpit/r/${A}/import`, { queryClient: seeded(A) });
    expect(upload).toContain('<h1 tabindex="-1" class="text-title font-semibold">Import</h1>');
    expect(upload).toContain('Konten werden geladen');
    expect(upload).not.toContain('noch nicht verfügbar');
    const queryClient = seeded(A);
    queryClient.setQueryData(importKeys.batch(A, 0, BATCH), batch({ mreRealmId: A }));
    const result = render(await signedIn(), `/cockpit/r/${A}/import/${BATCH.toUpperCase()}`, { queryClient });
    expect(result).toContain('Ergebnis des Imports');
    expect(result).toContain(BATCH);
    const other = seeded(B);
    other.setQueryData(importKeys.batch(A, 0, BATCH), batch({ mreRealmId: A }));
    const foreign = render(await signedIn(), `/cockpit/r/${B}/import/${BATCH}`, { queryClient: other });
    expect(foreign).toContain('Ergebnis des Imports wird geladen');
    expect(foreign).not.toContain('Ergebnis des Imports</h2>');
  });
});
