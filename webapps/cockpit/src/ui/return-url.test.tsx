// @vitest-environment jsdom
import { QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeJwt, json } from '../api/fetch.test-support';
import { createQueryClient } from '../query';
import { createRealmLock } from '../routing';
import { clearCacheWhenSessionEnds } from '../session/cache-binding';
import type { MreAuthenticator } from '../session/mre-authenticator';
import { Session } from '../session/session';
import { SessionContext } from '../session/use-session';
import { category, page, property, REALM_A, REALM_B, transaction } from '../transactions/fixtures.test-support';
import { App } from './App';

/**
 * The way back after an expired session (Entscheidung des Projektinhabers, 2026-11-10, to #319 question 5): after
 * „Sitzung abgelaufen“ and a new sign-in the user is at the URL they were at, path and search, as with the deep link of
 * check 12 in #319. Nothing is stored for it: the sign-in page is shown in place of the content and the address bar
 * keeps the URL, so the app renders that URL again once signed in. The Realm lock still decides about the Realm.
 */

const OLD = fakeJwt({ account: { email: 'admin1@example.com' }, exp: 4_000_000_000, n: 1 });
const NEW = fakeJwt({ account: { email: 'admin1@example.com' }, exp: 4_000_000_000, n: 2 });
const DEEP = `/cockpit/r/${REALM_A}/buchungen?status=IMPORTED,UNREVIEWED&provenance=BANK_CSV&page=2&pageSize=25`;

/** A synthetic MRE and DE: a token is accepted while the server holds it; the expiry drops the old session's token. */
function server() {
  const state = { tokens: new Set([OLD]), refreshCookie: true, lists: [] as string[], realms: [] as (string | null)[] };
  const fetch = vi.fn((input: string, init: RequestInit = {}) => {
    const url = new URL(input, 'https://cockpit.internal');
    const token = new Headers(init.headers).get('authorization')?.replace('Bearer ', '') ?? '';
    if (!state.tokens.has(token)) return Promise.resolve(json(401, { error: { code: 'UNAUTHENTICATED', message: 'x' } }));
    state.realms.push(new Headers(init.headers).get('organizationid'));
    const answers: Record<string, () => unknown> = {
      '/api/v2/realms': () => [{ _id: REALM_A, name: 'Bestand Nord' }],
      '/api/v1/health': () => ({ status: 'ok', mreRealmId: REALM_A }),
      '/api/v1/financial-accounts': () => page([]),
      '/api/v1/property-references': () => page([property()]),
      '/api/v1/financial-categories': () => ({ items: [category()] }),
      '/api/v1/transactions': () => {
        state.lists.push(url.search);
        return page([transaction({ description: `Liste ${state.tokens.has(NEW) ? 'neu' : 'alt'}` })], { page: 2, pageSize: 25, total: 60 });
      },
    };
    const answer = answers[url.pathname];
    return Promise.resolve(answer === undefined ? json(404, { error: { code: 'NOT_FOUND', message: 'x' } }) : json(200, answer()));
  });
  const mre: MreAuthenticator = {
    refresh: () => Promise.resolve(state.refreshCookie ? OLD : undefined),
    signIn: () => {
      state.tokens.add(NEW);
      state.refreshCookie = true;
      return Promise.resolve(NEW);
    },
    signOut: () => Promise.resolve(),
  };
  /** The MRE session ends (10 minutes without a request): the token and the refresh cookie are no longer accepted. */
  const expire = () => {
    state.tokens.delete(OLD);
    state.refreshCookie = false;
  };
  return { state, fetch, mre, expire };
}

async function openApp(path: string) {
  window.history.replaceState(null, '', path);
  const backend = server();
  vi.stubGlobal('fetch', backend.fetch);
  const session = new Session(backend.mre);
  const queryClient = createQueryClient();
  clearCacheWhenSessionEnds(session, queryClient);
  const reloads: string[] = [];
  await session.start();
  render(
    <SessionContext.Provider value={session}>
      <QueryClientProvider client={queryClient}>
        <App realmLock={createRealmLock()} reload={() => reloads.push(window.location.pathname)} />
      </QueryClientProvider>
    </SessionContext.Provider>,
  );
  return { backend, session, queryClient, reloads };
}

/** Expiry as the user meets it: the next request is refused, the renewal too, and the sign-in page says so. */
async function expireOnNextRequest(backend: ReturnType<typeof server>, queryClient: ReturnType<typeof createQueryClient>) {
  backend.expire();
  void queryClient.invalidateQueries();
  await screen.findByText('Ihre Sitzung ist abgelaufen. Bitte melden Sie sich erneut an.');
}

function signInAgain() {
  fireEvent.change(screen.getByLabelText('E-Mail-Adresse'), { target: { value: 'admin1@example.com' } });
  fireEvent.change(screen.getByLabelText('Passwort'), { target: { value: 'synthetisch' } });
  fireEvent.click(screen.getByRole('button', { name: 'Anmelden' }));
}

const here = () => `${window.location.pathname}${window.location.search}`;

beforeEach(() => {
  // The way back needs no browser storage: every access is a failure of the test.
  for (const name of ['localStorage', 'sessionStorage'] as const) {
    vi.spyOn(window, name, 'get').mockImplementation(() => {
      throw new Error(`${name} used`);
    });
  }
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.history.replaceState(null, '', '/');
});

describe('the way back after an expired session (#319 question 5, check 12)', () => {
  it('expiry on a deep link with filters, sign-in again: the same path and search, the list of the new session', async () => {
    const { backend, queryClient } = await openApp(DEEP);
    await screen.findByText('Liste alt');
    const before = backend.state.lists.length;
    await expireOnNextRequest(backend, queryClient);
    // The sign-in page takes the content's place; the URL stays as it was, nothing of the list is shown.
    expect(here()).toBe(DEEP);
    expect(screen.queryByText('Liste alt')).toBeNull();
    expect(screen.queryByRole('navigation', { name: 'Hauptnavigation' })).toBeNull();
    signInAgain();
    await screen.findByText('Liste neu');
    expect(here()).toBe(DEEP);
    // The list of the URL, asked again with the new session, filters and page unchanged, in the Realm of the URL.
    expect(backend.state.lists.slice(before).at(-1)).toBe('?status=IMPORTED%2CUNREVIEWED&provenance=BANK_CSV&page=2&pageSize=25');
    expect(backend.state.realms.filter((realm) => realm !== null && realm !== REALM_A)).toEqual([]);
    expect((document.querySelector('input[name="status"][value="UNREVIEWED"]') as HTMLInputElement).checked).toBe(true);
    expect((document.querySelector('input[name="provenance"][value="BANK_CSV"]') as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText('Seite 2 von 3 · 60 Buchungen')).toBeTruthy();
  });

  it('counter-check: no stored target, the Realm lock still holds; another Realm in the address bar loads afresh', async () => {
    const { backend, queryClient, reloads } = await openApp(DEEP);
    await screen.findByText('Liste alt');
    await expireOnNextRequest(backend, queryClient);
    // While the sign-in page is shown, the history moves to another Realm (back button, a link of another tab).
    window.history.pushState(null, '', `/cockpit/r/${REALM_B}/buchungen?status=CONFIRMED`);
    fireEvent(window, new PopStateEvent('popstate'));
    signInAgain();
    // Not the URL of the expiry (nothing was kept of it) and not Realm B from this memory: the page is loaded afresh.
    await screen.findByText('Die Seite wird für den anderen Bestand neu geladen …');
    expect(here()).toBe(`/cockpit/r/${REALM_B}/buchungen?status=CONFIRMED`);
    expect(reloads).toEqual([`/cockpit/r/${REALM_B}/buchungen`]);
    expect(screen.queryByText('Liste neu')).toBeNull();
    expect(backend.state.realms.includes(REALM_B)).toBe(false);
  });
});
