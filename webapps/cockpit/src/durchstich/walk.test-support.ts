import { QueryClientProvider } from '@tanstack/react-query';
import { act as testingLibraryAct, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeAll, beforeEach, expect, vi } from 'vitest';
import { navigate } from '../navigation';
import { createQueryClient } from '../query';
import { createRealmLock, transactionPath } from '../routing';
import { clearCacheWhenSessionEnds } from '../session/cache-binding';
import { Session } from '../session/session';
import { SessionContext } from '../session/use-session';
import { REALM_A } from '../transactions/fixtures.test-support';
import { App } from '../ui/App';
import { createBackend, CSV_NAME, DURCHSTICH_CSV, type Backend, type Sent } from './fake-backend.test-support';
import { loadRealMappings, type RealMappings } from './real-mappings.test-support';

/**
 * The user's steps through the whole cockpit (App, a real Session, the real DE client and its cache binding), with
 * `fireEvent` only (Entscheidung des Projektinhabers, 2026-11-10). Each step does what a user does and waits for what the
 * user then sees; the requests are asserted by the tests from `backend.sent`.
 */

/** `act` typed as it is used here (the library's overloads are not resolved by the type-checked lint). */
export const act = testingLibraryAct as unknown as (callback: () => void | Promise<void>) => Promise<void>;
export const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

const actEnvironment = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };

/**
 * The hooks of every Durchstich file: the backend's mappings once, a fresh backend per test, and the console watched
 * (ui-guide.md §11: no token, no bank data, no whole server answer in the console; the cockpit writes nothing there).
 * Returns the current test's backend.
 */
export function useDurchstich(): () => Backend {
  let real: RealMappings | undefined;
  let backend: Backend | undefined;
  let consoleCalls: unknown[][] = [];
  beforeAll(async () => {
    real = await loadRealMappings();
  });
  beforeEach(() => {
    if (real === undefined) throw new Error('mappings not loaded');
    backend = createBackend(real);
    // What Testing Library sets up itself where test globals exist (it cannot register its hooks without them): React
    // knows it runs under act, so an update outside act would be reported, and this file's own act calls are expected.
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
    consoleCalls = [];
    for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        consoleCalls.push([method, ...args]);
      });
    }
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    delete actEnvironment.IS_REACT_ACT_ENVIRONMENT;
    window.history.replaceState(null, '', '/');
    expect(consoleCalls, 'console output of the cockpit').toEqual([]);
  });
  return () => {
    if (backend === undefined) throw new Error('no backend outside a test');
    return backend;
  };
}

export const IMPORT = `/cockpit/r/${REALM_A}/import`;
export const MIETABGLEICH = `/cockpit/r/${REALM_A}/mietabgleich`;

export async function openApp(backend: Backend, path: string) {
  window.history.replaceState(null, '', path);
  vi.stubGlobal('fetch', backend.fetch);
  const session = new Session(backend.mre);
  const queryClient = createQueryClient();
  clearCacheWhenSessionEnds(session, queryClient);
  const reloads: string[] = [];
  await session.start();
  const app = createElement(App, { realmLock: createRealmLock(), reload: () => reloads.push(window.location.pathname) });
  render(createElement(SessionContext.Provider, { value: session }, createElement(QueryClientProvider, { client: queryClient }, app)));
  return { session, queryClient, reloads };
}

export const go = (path: string) => act(() => navigate(path));
export const click = (name: string | RegExp) => fireEvent.click(screen.getByRole('button', { name }));
/** Two clicks on the same button in one event batch, before React renders it busy or disabled (a double click). */
export const twice = async (name: string | RegExp) => {
  const target = await screen.findByRole('button', { name });
  await act(async () => {
    fireEvent.click(target);
    fireEvent.click(target);
  });
};
export const button = (name: string | RegExp) => screen.getByRole<HTMLButtonElement>('button', { name });
export const type = (element: Element, value: string) => fireEvent.change(element, { target: { value } });
export const control = (id: string) => {
  const element = document.getElementById(id);
  if (element === null) throw new Error(`no control ${id}`);
  return element as HTMLInputElement & HTMLSelectElement & HTMLTextAreaElement;
};

/** The requests of one route (`POST /api/v1/…`), in order. */
export const requests = (backend: Backend, method: string, path: string | RegExp): Sent[] =>
  backend.sent.filter((s) => s.method === method && (typeof path === 'string' ? s.path === path : path.test(s.path)));
/** Every command (anything but GET) that reached the server, as `METHOD path`. */
export const commands = (backend: Backend) => backend.sent.filter((s) => s.method !== 'GET').map((s) => `${s.method} ${s.path}`);
export const MRE_COMMANDS = /\/(write-back-to-mre|remove-from-mre)$/;

export function csvFile(content = DURCHSTICH_CSV, name = CSV_NAME): File {
  return new File([content], name, { type: 'text/csv' });
}

/** Steps 1–2 of the import (ui-guide.md §6.5): file and account, then „Import ausführen“. */
export async function chooseFile(file = csvFile()) {
  fireEvent.change(await screen.findByLabelText('CSV-Datei'), { target: { files: [file] } });
}

export async function importCsv(file = csvFile(), press: (name: string) => unknown = click) {
  await chooseFile(file);
  await press('Import ausführen');
  await screen.findByRole('heading', { name: 'Ergebnis des Imports' });
}

/** CREATE as the user decides it: the button opens the confirmation step, „Jetzt übernehmen“ sends (2026-11-11). */
export async function resolveCreate(press: (name: string) => unknown = click) {
  await screen.findByRole('button', { name: 'Als eigenständige Buchung übernehmen' });
  await press('Als eigenständige Buchung übernehmen');
  await press('Jetzt übernehmen');
  await screen.findByText(/Entschieden: /);
}

/** The confirm buttons of the confirmation steps before the two MRE writes (Entscheidung des Projektinhabers, 2026-11-11). */
export const WRITE_BACK_NOW = 'Jetzt an MRE übertragen';
export const REMOVE_NOW = 'Jetzt aus MRE entfernen';

/** Opens the step of an MRE write with its button and sends it with the step's confirm button. */
export async function mreWrite(action: 'An MRE übertragen' | 'Aus MRE entfernen', press: (name: string) => unknown = click) {
  await screen.findByRole('button', { name: action });
  await press(action);
  await press(action === 'An MRE übertragen' ? WRITE_BACK_NOW : REMOVE_NOW);
}

/** Only the rows with a hint are shown by default; this shows every row of the import result. */
export const showAllRows = () => fireEvent.click(screen.getByRole('button', { name: 'Alle Zeilen' }));

export const openTransaction = (backend: Backend, description: string) => go(transactionPath(REALM_A, backend.tx(description).id));

/** Step 3: 850,00 € as Kaltmiete 700,00 on the object and Nebenkosten 150,00. */
export async function splitRent(property: string, save: boolean | ((name: string) => unknown) = true) {
  await waitFor(() => control('split-0-amount'));
  type(control('split-0-category'), 'RENT_BASE');
  type(control('split-0-amount'), '700,00');
  type(control('split-0-reference'), 'property');
  type(control('split-0-property'), property);
  click('Teilbetrag hinzufügen');
  type(control('split-1-category'), 'RENT_OPERATING_COST_ADVANCE');
  type(control('split-1-amount'), '150,00');
  if (save !== false) await (save === true ? click : save)('Aufteilung speichern');
}

export async function confirmTransaction(press: (name: string) => unknown = click) {
  fireEvent.click(await screen.findByRole('button', { name: 'Buchung bestätigen' }));
  await press('Jetzt bestätigen');
  await screen.findByText(/Buchung bestätigt \(Status/);
}

export async function suggestOctober(press: (name: string) => unknown = click) {
  type(await screen.findByLabelText('Erster Monat'), '2026-10');
  type(screen.getByLabelText('Letzter Monat'), '2026-10');
  await press('Vorschläge ermitteln');
}

export async function release(reason = 'Falsche Buchung zugeordnet', press: (name: string) => unknown = click) {
  type(await screen.findByLabelText('Grund für das Aufheben (Pflicht)'), reason);
  await press('Zuordnung aufheben');
}

export async function correctDescription(text = 'Miete Oktober Testwohnung (korrigiert)', press: (name: string) => unknown = click) {
  fireEvent.click(await screen.findByRole('button', { name: 'Korrektur erfassen' }));
  type(control('korrektur-reason'), 'Verwendungszweck falsch erfasst');
  type(control('korrektur-description'), text);
  await press('Korrektur ausführen');
}

/** „Stornieren“ (Entscheidung des Projektinhabers, 2026-11-11): the button, the reason, „Storno ausführen“, „Jetzt stornieren“. */
export async function reverseBooking(reason = 'Doppelt erfasst', press: (name: string) => unknown = click) {
  fireEvent.click(await screen.findByRole('button', { name: 'Stornieren' }));
  type(control('storno-reason'), reason);
  await press('Storno ausführen');
  await press('Jetzt stornieren');
}
