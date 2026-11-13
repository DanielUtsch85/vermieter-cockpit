// @vitest-environment jsdom
import { act as testingLibraryAct, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDeClient } from '../../api/client';
import { countingTokens, envelope, json, scriptedFetch, type Call } from '../../api/fetch.test-support';
import { confirmTransaction, type Confirmed, type TransactionDetailDto } from '../../api/transactions';
import { detail, REALM_A, split, transaction, TX } from '../../transactions/fixtures.test-support';
import { ConfirmAction } from './ConfirmAction';
import { expectSaved } from '../technical.test-support';

/**
 * Step 4, „Buchung bestätigen“ as a component (jsdom, `fireEvent` only): every confirm goes through the real client
 * (`confirmTransaction`) to a scripted fetch, so the tests read the request as it leaves the browser.
 */

const act = testingLibraryAct as unknown as (callback: () => void | Promise<void>) => Promise<void>;
const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

const CLASSIFIED = detail({ status: 'CLASSIFIED', version: 4, splits: [split({ amount: { amount: '850.00', currency: 'EUR' } })] });
const confirmedAnswer = () => json(200, transaction({ status: 'CONFIRMED', version: 5, confirmedAt: '2026-03-05T10:00:00.000Z' }), { etag: '"5"' });

function setup(options: { transaction?: TransactionDetailDto; etag?: string | undefined; stale?: boolean; answers?: Parameters<typeof scriptedFetch> } = {}) {
  const { fetch, calls } = scriptedFetch(...(options.answers ?? []));
  const de = createDeClient({ tokens: countingTokens(), realmId: REALM_A, fetch });
  const onConfirmed = vi.fn<(confirmed: Confirmed) => void>();
  const reload = vi.fn<() => void>();
  const props = (t: TransactionDetailDto, stale: boolean) => (
    <ConfirmAction
      transaction={t}
      etag={'etag' in options ? options.etag : '"4"'}
      stale={stale}
      confirm={(ifMatch) => confirmTransaction(de, TX, ifMatch)}
      onConfirmed={onConfirmed}
      reload={reload}
    />
  );
  const view = render(props(options.transaction ?? CLASSIFIED, options.stale ?? false));
  return { calls, onConfirmed, reload, unmount: view.unmount, rerender: (t: TransactionDetailDto, stale = false) => view.rerender(props(t, stale)) };
}

const trigger = () => screen.getByRole<HTMLButtonElement>('button', { name: 'Buchung bestätigen' });
const confirmNow = () => screen.getByRole<HTMLButtonElement>('button', { name: /Jetzt bestätigen|Wird bestätigt/ });
const posts = (calls: readonly Call[]) => calls.filter((call) => call.method === 'POST');

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('step 4, Buchung bestaetigen (ui-guide.md §4.4, §6.3, §7.3, §8)', () => {
  it('is its own action with a confirmation step; the step takes the focus and sends nothing by itself', async () => {
    const { calls } = setup();
    fireEvent.click(trigger());
    const heading = screen.getByRole('heading', { name: 'Buchung jetzt bestätigen?' });
    expect(document.activeElement).toBe(heading);
    expect(screen.getByRole('dialog', { name: 'Buchung jetzt bestätigen?' })).toBeTruthy();
    await settle();
    expect(calls).toHaveLength(0);
  });

  it('Jetzt bestaetigen sends one POST with the If-Match of the detail; green only after the answer, then the page reads again', async () => {
    let answer: (response: Response) => void = () => undefined;
    const pending = new Promise<Response>((resolve) => {
      answer = resolve;
    });
    const { calls, onConfirmed } = setup({ answers: [() => pending] });
    fireEvent.click(trigger());
    fireEvent.click(confirmNow());
    await settle();
    expect(posts(calls)).toHaveLength(1);
    expect(calls[0]?.url).toBe(`/api/v1/transactions/${TX}/confirm`);
    expect(calls[0]?.headers.get('if-match')).toBe('"4"');
    expect(calls[0]?.body).toBeUndefined();
    // No optimistic state: until the server answers, nothing says „bestätigt“.
    expect(screen.queryByText(/Buchung bestätigt/)).toBeNull();
    expect(confirmNow().disabled).toBe(true);
    expect(confirmNow().textContent).toBe('Wird bestätigt …');
    expect(onConfirmed).not.toHaveBeenCalled();
    await act(async () => {
      answer(confirmedAnswer());
      await pending;
    });
    await settle();
    const done = expectSaved(screen.getByText('Buchung bestätigt (Status „Bestätigt“). Die Aufteilung ist jetzt unveränderlich.'), 5);
    expect(document.activeElement).toBe(done.closest('[tabindex="-1"]'));
    expect(onConfirmed).toHaveBeenCalledTimes(1);
    expect(onConfirmed.mock.calls[0]?.[0]).toMatchObject({ etag: '"5"', transaction: { status: 'CONFIRMED' } });
    expect(screen.queryByRole('button', { name: 'Buchung bestätigen' })).toBeNull();
  });

  it('without an ETag the version of the detail is the If-Match', async () => {
    const { calls } = setup({ etag: undefined, answers: [confirmedAnswer()] });
    fireEvent.click(trigger());
    fireEvent.click(confirmNow());
    await settle();
    expect(calls[0]?.headers.get('if-match')).toBe('"4"');
  });

  it('a double click sends one request', async () => {
    const { calls } = setup({ answers: [confirmedAnswer(), confirmedAnswer()] });
    fireEvent.click(trigger());
    await act(() => {
      fireEvent.click(confirmNow());
      fireEvent.click(confirmNow());
    });
    await settle();
    expect(posts(calls)).toHaveLength(1);
  });

  it('Abbrechen and Escape send nothing and give the focus back to the button', async () => {
    const { calls } = setup();
    fireEvent.click(trigger());
    fireEvent.click(screen.getByRole('button', { name: 'Abbrechen' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(trigger());
    fireEvent.click(trigger());
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(trigger());
    await settle();
    expect(calls).toHaveLength(0);
  });

  it('a status the server does not confirm gets no button; a confirmable one without splits says to split first', () => {
    for (const status of ['CONFIRMED', 'RECONCILED', 'CORRECTED', 'IGNORED', 'SOMETHING_NEW']) {
      setup({ transaction: detail({ status: status as never, splits: [split()] }) });
      expect(screen.queryByRole('button', { name: 'Buchung bestätigen' }), status).toBeNull();
      cleanup();
    }
    for (const status of ['IMPORTED', 'UNREVIEWED', 'CLASSIFIED']) {
      setup({ transaction: detail({ status: status as never, splits: [] }) });
      expect(screen.queryByRole('button', { name: 'Buchung bestätigen' }), status).toBeNull();
      expect(screen.getByText(/Bestätigen ist möglich, sobald die Aufteilung gespeichert ist/)).toBeTruthy();
      cleanup();
    }
    setup({ transaction: detail({ status: 'IMPORTED', splits: [split()] }) });
    expect(trigger()).toBeTruthy();
  });

  it('while the detail is read again or its read failed, nothing can be confirmed', () => {
    const { rerender } = setup({ stale: true });
    expect(trigger().disabled).toBe(true);
    rerender(CLASSIFIED, false);
    fireEvent.click(trigger());
    rerender(CLASSIFIED, true);
    expect(confirmNow().disabled).toBe(true);
  });

  it('412 keeps everything, sends nothing again and reads only on request', async () => {
    const { calls, reload, onConfirmed } = setup({ answers: [envelope(412, 'VERSION_CONFLICT', { expectedVersions: [4], currentVersion: 5 })] });
    fireEvent.click(trigger());
    fireEvent.click(confirmNow());
    await settle();
    expect(screen.getByText('Inzwischen geändert')).toBeTruthy();
    expect(screen.getByText(/Es wurde nichts bestätigt und nichts wird von selbst wiederholt/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Erneut senden' })).toBeNull();
    expect(reload).not.toHaveBeenCalled();
    expect(onConfirmed).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Aktuellen Stand laden' }));
    expect(reload).toHaveBeenCalledTimes(1);
    await settle();
    expect(posts(calls)).toHaveLength(1);
  });

  it('no answer: Erneut senden sends the same confirm with the same If-Match', async () => {
    const { calls } = setup({ answers: [new TypeError('network down'), confirmedAnswer()] });
    fireEvent.click(trigger());
    fireEvent.click(confirmNow());
    await settle();
    expect(screen.getByText(/Ob die Buchung bestätigt wurde, ist unklar/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Erneut senden' }));
    await settle();
    expect(posts(calls).map((call) => call.headers.get('if-match'))).toEqual(['"4"', '"4"']);
    expect(screen.getByText(/Buchung bestätigt/)).toBeTruthy();
  });

  it('refusals are explained from code and reason; an unknown reason or code is shown, never swallowed', async () => {
    const cases: [Response, RegExp][] = [
      [envelope(409, 'INVARIANT_VIOLATION', { reason: 'SPLITS_MISSING' }), /noch nicht aufgeteilt/],
      [envelope(409, 'INVARIANT_VIOLATION', { reason: 'SPLIT_SUM_MISMATCH', expected: {}, actual: {} }), /decken den Betrag der Buchung nicht genau/],
      [envelope(409, 'CONFLICT', { reason: 'NOT_CONFIRMABLE', status: 'IGNORED' }), /Status „Ignoriert“ und kann nicht bestätigt werden/],
      [envelope(422, 'REVIEW_REQUIRED', { reason: 'INACTIVE_CATEGORY', financialCategoryCodes: ['OLD_FEE'] }), /nicht mehr aktiv \(OLD_FEE\)/],
      [envelope(409, 'CONFLICT', { reason: 'BRAND_NEW' }), /Grund BRAND_NEW\./],
      [envelope(418, 'TEAPOT'), /HTTP 418, Code TEAPOT\./],
    ];
    for (const [response, text] of cases) {
      const { calls } = setup({ answers: [response] });
      fireEvent.click(trigger());
      fireEvent.click(confirmNow());
      await settle();
      expect(screen.getByText(text), String(text)).toBeTruthy();
      expect(screen.queryByText(/Buchung bestätigt/)).toBeNull();
      expect(screen.queryByRole('button', { name: 'Erneut senden' })).toBeNull();
      expect(posts(calls)).toHaveLength(1);
      cleanup();
    }
  });

  it('an answer after the page is gone changes nothing', async () => {
    let answer: (response: Response) => void = () => undefined;
    const pending = new Promise<Response>((resolve) => {
      answer = resolve;
    });
    const { onConfirmed, unmount } = setup({ answers: [() => pending] });
    fireEvent.click(trigger());
    fireEvent.click(confirmNow());
    await settle();
    unmount();
    await act(async () => {
      answer(confirmedAnswer());
      await pending;
    });
    expect(onConfirmed).not.toHaveBeenCalled();
  });
});

describe('the card Bestaetigen (Issue #352 des Projektinhabers, 2026-11-12, point 4)', () => {
  const card = () => screen.getByRole('region', { name: 'Bestätigen' });

  it('a card with its title and what confirming does; the button inside it, no technical text', () => {
    setup();
    const section = card();
    expect(section.tagName).toBe('SECTION');
    expect(within(section).getByRole('heading', { level: 2, name: 'Bestätigen' })).toBeTruthy();
    expect(section.textContent).toContain(
      'Mit der Bestätigung wird die gespeicherte Aufteilung eingefroren. Danach lässt sich die Buchung nur noch über eine Korrektur oder ein Storno ändern.',
    );
    expect(within(section).getByRole('button', { name: 'Buchung bestätigen' })).toBe(trigger());
    expect(section.textContent).not.toMatch(/If-Match|ETag/);
  });

  it('the confirmation step and the answer appear inside the same card', async () => {
    setup({ answers: [confirmedAnswer] });
    fireEvent.click(trigger());
    const dialog = within(card()).getByRole('dialog', { name: 'Buchung jetzt bestätigen?' });
    // The step says what the card says: afterwards only a correction or a reversal (review of #354).
    expect(dialog.textContent).toContain('ändern lässt sich die Buchung nur noch über eine Korrektur oder ein Storno.');
    fireEvent.click(confirmNow());
    await settle();
    expect(within(card()).getByRole('status').textContent).toContain('Buchung bestätigt (Status „Bestätigt“)');
    expect(screen.getAllByRole('region')).toHaveLength(1);
  });

  it('the lock of an unsaved draft is inside the card and named by the button', () => {
    const de = createDeClient({ tokens: countingTokens(), realmId: REALM_A, fetch: scriptedFetch().fetch });
    render(
      <ConfirmAction
        transaction={CLASSIFIED}
        etag={'"4"'}
        stale={false}
        confirm={(ifMatch) => confirmTransaction(de, TX, ifMatch)}
        onConfirmed={() => undefined}
        reload={() => undefined}
        draftUnsaved
      />,
    );
    const hint = within(card()).getByText('Zuerst Aufteilung speichern oder verwerfen');
    expect(trigger().disabled).toBe(true);
    expect(trigger().getAttribute('aria-describedby')).toBe(hint.id);
  });

  it('a booking without splits gets the card with its hint; a status that cannot be confirmed gets none', () => {
    setup({ transaction: detail({ status: 'IMPORTED', splits: [] }) });
    expect(card().textContent).toContain('Bestätigen ist möglich, sobald die Aufteilung gespeichert ist');
    expect(screen.queryByRole('button', { name: 'Buchung bestätigen' })).toBeNull();
    cleanup();
    setup({ transaction: detail({ status: 'CONFIRMED', splits: [split()] }) });
    expect(screen.queryByRole('region', { name: 'Bestätigen' })).toBeNull();
  });
});
