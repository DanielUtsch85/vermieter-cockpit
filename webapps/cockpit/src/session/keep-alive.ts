import type { Session } from './session';

/**
 * Background renewal of the MRE session (Issue #366; Entscheidung des Projektinhabers, 2026-11-16): the session is
 * renewed through the same refresh call as on demand (`Session.renew`, mre-integration.md §47.2 point 1), but only while
 * the tab is visible and the user's last input lies at most 30 minutes back. Without input the session runs out as
 * before, so an open tab alone does not hold it for good. A hidden tab never renews; when it becomes visible again
 * within the 30 minutes, a due renewal is made at once. A refresh refused with `403` ends the session the usual way
 * (`Session.expire`: sign-in page, the URL kept); a refresh without an answer is tried once more after the same interval,
 * never in a loop. Nothing is stored outside this closure's memory.
 */

/**
 * The life of MRE's refresh token in production (`services/authenticator/src/routes/landlord.js` at the pinned baseline):
 * 600 s from its issue. Every refresh spends it and sets a new one, so each renewal starts the 600 s afresh.
 */
export const REFRESH_TOKEN_LIFETIME_MS = 600_000;

/**
 * A renewal is due this long after the last one: two fifths of the refresh token's life, 240 s. A renewal that gets no
 * answer is tried once more after the same time, at 480 s, still 120 s before the token runs out; a timer the browser
 * delays by a minute is also still in time.
 */
export const KEEP_ALIVE_INTERVAL_MS = (REFRESH_TOKEN_LIFETIME_MS * 2) / 5;

/** Renewal only while the last input lies at most this long back (Entscheidung des Projektinhabers, 2026-11-16). */
export const INPUT_WINDOW_MS = 30 * 60_000;

/**
 * What counts as an input of the user: a key, a press of mouse, pen or finger, a click (also by key), a changed field
 * (typing, a choice, the browser's autofill) and the mouse wheel. Not counted: mouse movement and `scroll`, which also
 * fire without the user's intent (a resting hand, a page that scrolls itself); scrolling by key or touch starts with
 * `keydown` or `pointerdown`. Listened to on the document in the capture phase, so no handler of the page can hide one.
 */
export const INPUT_EVENTS = ['keydown', 'pointerdown', 'click', 'input', 'change', 'wheel'] as const;

export interface KeepAliveEnvironment {
  readonly document: Document;
  readonly now: () => number;
}

/** Starts the renewal for the session's sign-ins; the returned function stops it and removes every timer and listener. */
export function keepSessionAlive(session: Session, environment: Partial<KeepAliveEnvironment> = {}): () => void {
  const doc = environment.document ?? globalThis.document;
  const now = environment.now ?? (() => Date.now());
  const listenerOptions = { capture: true, passive: true } as const;
  let armed = false;
  let lastInput = 0;
  let dueAt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const clear = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  const schedule = () => {
    clear();
    if (armed) timer = setTimeout(tick, Math.max(0, dueAt - now()));
  };

  /** Renews when due, visible and within the input window; otherwise waits for the due time, visibility or input. */
  function tick() {
    timer = undefined;
    if (!armed) return;
    if (now() < dueAt) {
      schedule();
      return;
    }
    if (doc.visibilityState !== 'visible' || now() - lastInput > INPUT_WINDOW_MS) return;
    // No second attempt before the interval, whatever the answer: a success reschedules through the session's
    // notification, a refusal (`403`) ends the session there, no answer leaves this due time.
    dueAt = now() + KEEP_ALIVE_INTERVAL_MS;
    session.renew().catch(() => {
      schedule();
    });
  }

  const onInput = () => {
    lastInput = now();
    if (timer === undefined) tick();
  };
  const onVisibility = () => {
    if (doc.visibilityState === 'visible' && timer === undefined) tick();
  };

  const arm = () => {
    armed = true;
    // The sign-in (or the opening of the page with a running session) is the first input.
    lastInput = now();
    for (const type of INPUT_EVENTS) doc.addEventListener(type, onInput, listenerOptions);
    doc.addEventListener('visibilitychange', onVisibility);
  };
  const disarm = () => {
    armed = false;
    clear();
    for (const type of INPUT_EVENTS) doc.removeEventListener(type, onInput, listenerOptions);
    doc.removeEventListener('visibilitychange', onVisibility);
  };

  // Every notification while signed in is a sign-in or a renewal (in the background or on demand): the next one is due
  // an interval later. Any other state (signed out, expired, checking) stops the renewal.
  const onSession = () => {
    if (session.getState().status !== 'signedIn') {
      if (armed) disarm();
      return;
    }
    if (!armed) arm();
    dueAt = now() + KEEP_ALIVE_INTERVAL_MS;
    schedule();
  };

  const unsubscribe = session.subscribe(onSession);
  onSession();
  return () => {
    unsubscribe();
    disarm();
  };
}
