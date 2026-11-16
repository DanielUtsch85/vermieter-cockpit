// @vitest-environment jsdom
import { fireEvent } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, CLIENT_CODES } from '../api/errors';
import { fakeJwt } from '../api/fetch.test-support';
import { INPUT_EVENTS, INPUT_WINDOW_MS, KEEP_ALIVE_INTERVAL_MS, keepSessionAlive, REFRESH_TOKEN_LIFETIME_MS } from './keep-alive';
import type { MreAuthenticator } from './mre-authenticator';
import { Session } from './session';

/**
 * Issue #366 (Entscheidung des Projektinhabers, 2026-11-16): the background renewal against a real Session with an MRE
 * authenticator that counts its refresh calls, on vitest's fake clock; input and visibility come as DOM events.
 */

const T0 = Date.parse('2026-11-16T09:00:00Z');
const SECOND = 1000;
const MINUTE = 60 * SECOND;
let tokenNumber = 0;
/** An MRE access token as the authenticator issues it now: 30 s of life. */
const accessToken = () => fakeJwt({ account: { email: 'admin@example.invalid' }, exp: Math.floor(Date.now() / 1000) + 30, n: ++tokenNumber });

let visibility: DocumentVisibilityState = 'visible';
const setVisibility = (state: DocumentVisibilityState) => {
  visibility = state;
  fireEvent(document, new Event('visibilitychange'));
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  visibility = 'visible';
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  Reflect.deleteProperty(document, 'visibilityState');
});

async function signedIn() {
  const refresh = vi.fn<MreAuthenticator['refresh']>(() => Promise.resolve(accessToken()));
  const mre: MreAuthenticator = { signIn: () => Promise.resolve(accessToken()), refresh, signOut: () => Promise.resolve() };
  const session = new Session(mre);
  await session.signIn('admin@example.invalid', 'synthetisch');
  const stop = keepSessionAlive(session);
  return { session, refresh, stop, mre };
}

/** Lets the fake clock run; the renewal's refresh answers on the way. */
const wait = (ms: number) => vi.advanceTimersByTimeAsync(ms);
const renewedAt = (session: Session) => {
  const state = session.getState();
  return state.status === 'signedIn' ? state.renewedAt?.getTime() : undefined;
};

describe('the interval: derived from the 600 s refresh token', () => {
  it('240 s, two attempts fit into one refresh token life with time to spare', () => {
    expect(KEEP_ALIVE_INTERVAL_MS).toBe(240_000);
    expect(2 * KEEP_ALIVE_INTERVAL_MS).toBeLessThan(REFRESH_TOKEN_LIFETIME_MS);
    expect(INPUT_WINDOW_MS).toBe(30 * MINUTE);
  });
});

describe('renewal while the tab is visible and the last input lies within 30 minutes', () => {
  it('renews 240 s after the sign-in and every 240 s after that; the session shows each renewal', async () => {
    const { session, refresh } = await signedIn();
    expect(renewedAt(session)).toBeUndefined();
    await wait(KEEP_ALIVE_INTERVAL_MS - 1);
    expect(refresh).toHaveBeenCalledTimes(0);
    await wait(1);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(renewedAt(session)).toBe(T0 + 240 * SECOND);
    fireEvent.keyDown(document, { key: 'a' });
    await wait(KEEP_ALIVE_INTERVAL_MS);
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(renewedAt(session)).toBe(T0 + 480 * SECOND);
    expect(session.getState().status).toBe('signedIn');
  });

  it('with an input every few minutes the session is renewed for an hour, never more than 240 s apart', async () => {
    const { session, refresh } = await signedIn();
    const times: number[] = [];
    session.subscribe(() => times.push(Date.now()));
    for (let minute = 0; minute < 60; minute += 5) {
      fireEvent.pointerDown(document.body);
      await wait(5 * MINUTE);
    }
    expect(refresh).toHaveBeenCalledTimes(15);
    expect(times.map((time, i) => time - (times[i - 1] ?? T0))).toEqual(Array.from({ length: 15 }, () => KEEP_ALIVE_INTERVAL_MS));
  });

  it('a key, a press, a click, a changed field and the wheel count as input; mouse movement and scrolling do not', async () => {
    expect(INPUT_EVENTS).toEqual(['keydown', 'pointerdown', 'click', 'input', 'change', 'wheel']);
    const { refresh } = await signedIn();
    // 29 minutes after the sign-in only movement and scrolling: the renewal still runs until minute 30 after the sign-in.
    await wait(29 * MINUTE);
    fireEvent.mouseMove(document.body);
    fireEvent.scroll(window);
    fireEvent.scroll(document.body);
    await wait(20 * MINUTE);
    expect(refresh).toHaveBeenCalledTimes(7);
    const inputs: [string, (target: Element) => void][] = [
      ['keydown', (target) => fireEvent.keyDown(target, { key: 'x' })],
      ['pointerdown', (target) => fireEvent.pointerDown(target)],
      ['click', (target) => fireEvent.click(target)],
      ['input', (target) => fireEvent.input(target, { target: { value: 'x' } })],
      ['change', (target) => fireEvent.change(target, { target: { value: 'y' } })],
      ['wheel', (target) => fireEvent.wheel(target)],
    ];
    const field = document.body.appendChild(document.createElement('input'));
    let calls = 7;
    for (const [name, fire] of inputs) {
      // Each one alone wakes the waiting renewal at once (it is long due) and starts the rhythm again.
      fire(field);
      await wait(0);
      calls += 1;
      expect(refresh, name).toHaveBeenCalledTimes(calls);
      await wait(INPUT_WINDOW_MS + 10 * MINUTE);
      calls += 7;
      expect(refresh, name).toHaveBeenCalledTimes(calls);
    }
    field.remove();
  });
});

describe('no renewal when hidden or without input', () => {
  it('a hidden tab does not renew; visible again it renews at once when due, and keeps the rhythm when not', async () => {
    const { refresh } = await signedIn();
    setVisibility('hidden');
    await wait(9 * MINUTE);
    expect(refresh).toHaveBeenCalledTimes(0);
    setVisibility('visible');
    await wait(0);
    expect(refresh).toHaveBeenCalledTimes(1);
    // Hidden and visible again before the next renewal is due: nothing at once, the next one at its time.
    setVisibility('hidden');
    await wait(MINUTE);
    setVisibility('visible');
    await wait(0);
    expect(refresh).toHaveBeenCalledTimes(1);
    await wait(KEEP_ALIVE_INTERVAL_MS - MINUTE);
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it('visible again after more than 30 minutes without input: no renewal; the next input renews', async () => {
    const { refresh } = await signedIn();
    setVisibility('hidden');
    await wait(31 * MINUTE);
    setVisibility('visible');
    await wait(10 * MINUTE);
    expect(refresh).toHaveBeenCalledTimes(0);
    fireEvent.keyDown(document, { key: 'Tab' });
    await wait(0);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('after 30 minutes without input the renewal stops; with new input it resumes', async () => {
    const { refresh } = await signedIn();
    await wait(2 * 60 * MINUTE);
    // At 4, 8, … 28 minutes; the one due at 32 minutes is not made.
    expect(refresh).toHaveBeenCalledTimes(7);
    expect(vi.getTimerCount()).toBe(0);
    fireEvent.keyDown(document, { key: 'a' });
    await wait(0);
    expect(refresh).toHaveBeenCalledTimes(8);
    await wait(KEEP_ALIVE_INTERVAL_MS);
    expect(refresh).toHaveBeenCalledTimes(9);
  });

  it('an input at minute 20 holds the renewal until minute 50', async () => {
    const { refresh } = await signedIn();
    await wait(20 * MINUTE);
    fireEvent.pointerDown(document.body);
    await wait(60 * MINUTE);
    // Every 240 s from the sign-in up to minute 48 (12 times); the one due at minute 52 is past the window.
    expect(refresh).toHaveBeenCalledTimes(12);
  });
});

describe('one refresh at a time, with the renewal on demand', () => {
  it('a background renewal and an on-demand renewal at the same moment share one refresh call', async () => {
    const { session, refresh } = await signedIn();
    let answer: (token: string) => void = () => undefined;
    refresh.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          answer = resolve;
        }),
    );
    await wait(KEEP_ALIVE_INTERVAL_MS);
    expect(refresh).toHaveBeenCalledTimes(1);
    // The 30 s token ran out long ago: a request now needs a renewal and joins the one on its way.
    const onDemand = session.accessToken();
    const alsoOnDemand = session.renew();
    expect(refresh).toHaveBeenCalledTimes(1);
    const token = accessToken();
    answer(token);
    await expect(onDemand).resolves.toBe(token);
    await expect(alsoOnDemand).resolves.toBe(token);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('a renewal on demand (a request, Jetzt erneuern) moves the next background renewal 240 s after it', async () => {
    const { session, refresh } = await signedIn();
    await wait(100 * SECOND);
    await session.renew();
    expect(refresh).toHaveBeenCalledTimes(1);
    await wait(KEEP_ALIVE_INTERVAL_MS - 1);
    expect(refresh).toHaveBeenCalledTimes(1);
    await wait(1);
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(renewedAt(session)).toBe(T0 + 100 * SECOND + KEEP_ALIVE_INTERVAL_MS);
  });
});

describe('failures: no loop, no aggressive retry', () => {
  it('a 403 from the background refresh ends the session as expired (sign-in page, return URL kept); nothing is tried again', async () => {
    const { session, refresh } = await signedIn();
    refresh.mockResolvedValueOnce(undefined);
    await wait(KEEP_ALIVE_INTERVAL_MS);
    expect(session.getState()).toEqual({ status: 'signedOut', expired: true });
    await expect(session.accessToken()).rejects.toMatchObject({ code: CLIENT_CODES.sessionExpired });
    expect(vi.getTimerCount()).toBe(0);
    fireEvent.keyDown(document, { key: 'a' });
    setVisibility('hidden');
    setVisibility('visible');
    await wait(2 * 60 * MINUTE);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('no answer from the authenticator: the session stays, one more attempt an interval later, still within the token life', async () => {
    const { session, refresh } = await signedIn();
    refresh.mockRejectedValueOnce(new ApiError(0, CLIENT_CODES.network, 'The MRE authenticator did not answer.'));
    await wait(KEEP_ALIVE_INTERVAL_MS);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(session.getState().status).toBe('signedIn');
    // No input after the failure: the next attempt comes from the catch alone.
    await wait(KEEP_ALIVE_INTERVAL_MS - 1);
    expect(refresh).toHaveBeenCalledTimes(1);
    await wait(1);
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(renewedAt(session)).toBe(T0 + 2 * KEEP_ALIVE_INTERVAL_MS);
    expect(2 * KEEP_ALIVE_INTERVAL_MS).toBeLessThan(REFRESH_TOKEN_LIFETIME_MS);
  });
});

describe('clean-up: sign-out and the end of the App', () => {
  function watchListeners() {
    const added: unknown[][] = [];
    const removed: unknown[][] = [];
    vi.spyOn(document, 'addEventListener').mockImplementation(function (this: Document, ...args: Parameters<Document['addEventListener']>) {
      added.push(args);
      EventTarget.prototype.addEventListener.apply(this, args);
    });
    vi.spyOn(document, 'removeEventListener').mockImplementation(function (this: Document, ...args: Parameters<Document['removeEventListener']>) {
      removed.push(args);
      EventTarget.prototype.removeEventListener.apply(this, args);
    });
    return { added, removed };
  }

  it('sign-out removes every timer and listener; nothing is renewed after it; a new sign-in starts the renewal again', async () => {
    const listeners = watchListeners();
    const { session, refresh } = await signedIn();
    expect(listeners.added.map((args) => args[0])).toEqual([...INPUT_EVENTS, 'visibilitychange']);
    expect(vi.getTimerCount()).toBe(1);
    await session.signOut();
    expect(vi.getTimerCount()).toBe(0);
    expect(listeners.removed).toEqual(listeners.added);
    fireEvent.keyDown(document, { key: 'a' });
    setVisibility('hidden');
    setVisibility('visible');
    await wait(60 * MINUTE);
    expect(refresh).toHaveBeenCalledTimes(0);
    await session.signIn('admin@example.invalid', 'synthetisch');
    expect(vi.getTimerCount()).toBe(1);
    await wait(KEEP_ALIVE_INTERVAL_MS);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('the returned stop (the App unmounts) removes every timer and listener and no longer follows the session', async () => {
    const listeners = watchListeners();
    const { session, refresh, stop } = await signedIn();
    stop();
    expect(vi.getTimerCount()).toBe(0);
    expect(listeners.removed).toEqual(listeners.added);
    await session.renew();
    expect(vi.getTimerCount()).toBe(0);
    fireEvent.keyDown(document, { key: 'a' });
    await wait(60 * MINUTE);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('keeps nothing in browser storage or a cookie of its own', async () => {
    const storage = [vi.spyOn(Storage.prototype, 'setItem'), vi.spyOn(Storage.prototype, 'getItem')];
    const { stop } = await signedIn();
    fireEvent.keyDown(document, { key: 'a' });
    await wait(30 * MINUTE);
    stop();
    for (const spy of storage) expect(spy).not.toHaveBeenCalled();
    expect(document.cookie).toBe('');
  });
});
