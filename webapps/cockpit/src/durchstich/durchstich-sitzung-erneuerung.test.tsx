// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PROPERTY, REALM_A } from '../transactions/fixtures.test-support';
import { findSaved } from '../ui/technical.test-support';
import { EMAIL } from './fake-backend.test-support';
import { act, click, control, CORRECT_NOW, openApp, requests, splitRent, type, useDurchstich } from './walk.test-support';

/**
 * Issue #366 (Entscheidung des Projektinhabers, 2026-11-16): the background renewal of the session against the whole App
 * and the fake backend, whose MRE side lets the 30 s access token and the 600 s refresh cookie run out on the fake clock.
 * The draft tests pin what happens today to an unsaved draft when the session runs out (it is lost: the sign-in page
 * takes the page's place, and after the sign-in the form is empty), and that the renewal prevents exactly that.
 */

const backend = useDurchstich();
const here = () => `${window.location.pathname}${window.location.search}`;
const EXPIRED = 'Ihre Sitzung ist abgelaufen. Bitte melden Sie sich erneut an.';
const MINUTE = 60_000;
/** The user does nothing for this long; the fake clock's timers (the renewal's too) fire on the way. */
const idle = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

function signInAgain() {
  type(screen.getByLabelText('E-Mail-Adresse'), EMAIL);
  type(screen.getByLabelText('Passwort'), 'synthetisch');
  click('Anmelden');
}

// Fake time that also runs on by itself, so Testing Library's waits and the walk's `settle` work unchanged.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'], shouldAdvanceTime: true });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

async function openSplitDraft(keepAlive: boolean) {
  const t = backend().seedRent('IMPORTED');
  const url = `/cockpit/r/${REALM_A}/buchungen/${t.id}`;
  await openApp(backend(), url, keepAlive ? {} : { keepAlive: false });
  await splitRent(PROPERTY, false);
  return { t, url };
}

async function openCorrectionDraft(keepAlive: boolean) {
  const t = backend().seedRent('CONFIRMED');
  const url = `/cockpit/r/${REALM_A}/buchungen/${t.id}`;
  await openApp(backend(), url, keepAlive ? {} : { keepAlive: false });
  fireEvent.click(await screen.findByRole('button', { name: 'Korrektur erfassen' }));
  type(control('korrektur-reason'), 'Verwendungszweck falsch erfasst');
  type(control('korrektur-description'), 'Miete Oktober Testwohnung (korrigiert)');
  return { t, url };
}

describe('an unsaved draft and the end of the session (Entscheidung des Projektinhabers, 2026-11-16)', () => {
  it('today, without the background renewal: a split draft left for 11 minutes is lost; sign-in page on save, same URL, nothing sent, the form empty after the sign-in', async () => {
    const { t, url } = await openSplitDraft(false);
    await idle(11 * MINUTE);
    // Only the refresh of the start: nothing renewed the 600 s refresh cookie.
    expect(backend().counters.refreshes).toBe(1);
    click('Aufteilung speichern');
    expect(await screen.findByText(EXPIRED)).toBeTruthy();
    expect(here()).toBe(url);
    // The 30 s token had run out, so the session renewed it before sending: the refresh was refused (403) and the
    // split was never sent. The draft lived only in the page, which the sign-in page replaced.
    expect(backend().counters.refreshes).toBe(2);
    expect(requests(backend(), 'PUT', /\/splits$/)).toHaveLength(0);
    expect(screen.queryByRole('heading', { name: /Buchung vom/ })).toBeNull();
    expect(document.getElementById('split-0-amount')).toBeNull();
    signInAgain();
    await screen.findByRole('heading', { name: /Buchung vom/ });
    expect(here()).toBe(url);
    await waitFor(() => control('split-0-amount'));
    // The form as it opens for an unsplit booking (the whole amount, no category), not the draft (700,00 Kaltmiete).
    expect([control('split-0-category').value, control('split-0-amount').value]).toEqual(['', '850,00']);
    expect(document.getElementById('split-1-amount')).toBeNull();
    expect([t.version, t.splits.length, t.status]).toEqual([1, 0, 'IMPORTED']);
  });

  it('with the background renewal and an input within 30 minutes: the same split draft survives the 11 minutes and is saved once', async () => {
    const { t, url } = await openSplitDraft(true);
    await idle(11 * MINUTE);
    // Renewed in the background after 4 and 8 minutes.
    expect(backend().counters.refreshes).toBe(3);
    click('Aufteilung speichern');
    await findSaved(/Aufteilung gespeichert \(Status/, 2);
    expect(screen.queryByText(EXPIRED)).toBeNull();
    expect(here()).toBe(url);
    const puts = requests(backend(), 'PUT', /\/splits$/);
    expect(puts.map((s) => s.headers.get('if-match'))).toEqual(['"1"']);
    // The draft as typed 11 minutes earlier: Kaltmiete 700,00 on the object and Nebenkosten 150,00.
    const sent = JSON.parse(puts[0]?.body ?? '{}') as { splits: { financialCategoryCode: string; amount: { amount: string } }[] };
    expect(sent.splits.map((s) => [s.financialCategoryCode, s.amount.amount])).toEqual([
      ['RENT_BASE', '700.00'],
      ['RENT_OPERATING_COST_ADVANCE', '150.00'],
    ]);
    expect(t.splits).toHaveLength(2);
    expect(backend().counters.signIns).toBe(0);
  });

  it('today, without the background renewal: a correction draft left for 11 minutes is lost; nothing corrected, after the sign-in the form is closed and empty', async () => {
    const { t, url } = await openCorrectionDraft(false);
    await idle(11 * MINUTE);
    click('Korrektur ausführen');
    click(CORRECT_NOW);
    expect(await screen.findByText(EXPIRED)).toBeTruthy();
    expect(here()).toBe(url);
    expect(requests(backend(), 'POST', `/api/v1/transactions/${t.id}/correct`)).toHaveLength(0);
    signInAgain();
    fireEvent.click(await screen.findByRole('button', { name: 'Korrektur erfassen' }));
    expect(control('korrektur-reason').value).toBe('');
    expect(t.status).toBe('CONFIRMED');
    expect([...backend().transactions.values()].filter((x) => x.correctionOfTransactionId === t.id)).toHaveLength(0);
  });

  it('with the background renewal and an input within 30 minutes: the same correction draft survives and is carried out once', async () => {
    const { t, url } = await openCorrectionDraft(true);
    await idle(11 * MINUTE);
    click('Korrektur ausführen');
    click(CORRECT_NOW);
    await screen.findByRole('heading', { name: 'Korrektur ausgeführt' });
    expect(here()).toBe(url);
    expect(requests(backend(), 'POST', `/api/v1/transactions/${t.id}/correct`)).toHaveLength(1);
    expect(t.status).toBe('CORRECTED');
    expect(backend().counters.signIns).toBe(0);
  });
});

describe('the limits of the background renewal in the App', () => {
  it('after 30 minutes without input the session runs out as today: the next click meets the sign-in page, the URL is kept', async () => {
    const { t, url } = await openSplitDraft(true);
    await idle(45 * MINUTE);
    // Renewed at 4, 8, … 28 minutes (7 times) after the last input, then no more; the cookie ran out at 38 minutes.
    expect(backend().counters.refreshes).toBe(1 + 7);
    click('Aufteilung speichern');
    expect(await screen.findByText(EXPIRED)).toBeTruthy();
    expect(here()).toBe(url);
    // The click as input and the save share one refused refresh; nothing is tried again.
    expect(backend().counters.refreshes).toBe(1 + 7 + 1);
    expect(requests(backend(), 'PUT', /\/splits$/)).toHaveLength(0);
    await idle(30 * MINUTE);
    expect(backend().counters.refreshes).toBe(1 + 7 + 1);
    expect(t.splits).toHaveLength(0);
  });

  it('the overview line Sitzung erneuert shows the background renewal', async () => {
    const start = Date.now();
    const { session } = await openApp(backend(), `/cockpit/r/${REALM_A}/`);
    const line = async () => (await screen.findByText('Sitzung erneuert')).parentElement?.textContent ?? '';
    expect(await line()).toContain('Seit der Anmeldung noch nicht');
    await idle(4 * MINUTE);
    expect(backend().counters.refreshes).toBe(2);
    const state = session.getState();
    const renewedAt = state.status === 'signedIn' ? state.renewedAt : undefined;
    // Renewed 240 s after the start (the fake clock also runs on by itself for a few milliseconds).
    expect((renewedAt?.getTime() ?? 0) - start).toBeGreaterThanOrEqual(4 * MINUTE);
    expect((renewedAt?.getTime() ?? 0) - start).toBeLessThan(4 * MINUTE + 5_000);
    const time = new Intl.DateTimeFormat('de-DE', { timeStyle: 'medium', timeZone: 'Europe/Berlin' }).format(renewedAt);
    expect(await line()).toContain(`zuletzt um ${time}`);
  });

  it('a hidden tab does not renew; the session then runs out as today', async () => {
    await openApp(backend(), `/cockpit/r/${REALM_A}/`);
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    try {
      fireEvent(document, new Event('visibilitychange'));
      await idle(11 * MINUTE);
      expect(backend().counters.refreshes).toBe(1);
    } finally {
      Reflect.deleteProperty(document, 'visibilityState');
    }
    fireEvent(document, new Event('visibilitychange'));
    expect(await screen.findByText(EXPIRED)).toBeTruthy();
    expect(backend().counters.refreshes).toBe(2);
  });
});
