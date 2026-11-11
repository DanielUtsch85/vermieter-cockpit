// @vitest-environment jsdom
import { act as testingLibraryAct, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDeClient } from '../../api/client';
import { countingTokens, envelope, json, scriptedFetch, type Call } from '../../api/fetch.test-support';
import { confirmReconciliation, rejectReconciliation, type RentReconciliationDto } from '../../api/rent-reconciliations';
import { confirmed, reconciliation, REC } from '../../rent/fixtures.test-support';
import { REALM_A } from '../../transactions/fixtures.test-support';
import { DecisionActions } from './DecisionActions';

/**
 * Step 6, the decisions on a suggestion (jsdom, `fireEvent` only, the real client to a scripted fetch): „Zuordnung
 * bestätigen“ with an amount never above the suggestion, reject with a required reason; each its own click, one request
 * per click, no write to MRE (ui-guide.md §4.4, §6.6, §7.3).
 */

const act = testingLibraryAct as unknown as (callback: () => void | Promise<void>) => Promise<void>;
const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

function setup(options: { r?: RentReconciliationDto; answers?: Parameters<typeof scriptedFetch>; stale?: boolean } = {}) {
  const { fetch, calls } = scriptedFetch(...(options.answers ?? []));
  const de = createDeClient({ tokens: countingTokens(), realmId: REALM_A, fetch });
  const onChanged = vi.fn<() => void>();
  const reload = vi.fn<() => void>();
  const view = (r: RentReconciliationDto, etag: string, stale: boolean) => (
    <DecisionActions
      reconciliation={r}
      etag={etag}
      stale={stale}
      confirm={(amount, ifMatch) => confirmReconciliation(de, REC, amount, ifMatch)}
      reject={(reason, ifMatch) => rejectReconciliation(de, REC, reason, ifMatch)}
      onChanged={onChanged}
      reload={reload}
    />
  );
  const rendered = render(view(options.r ?? reconciliation(), '"1"', options.stale ?? false));
  return { calls, onChanged, reload, unmount: rendered.unmount, rerender: (r: RentReconciliationDto, etag: string) => rendered.rerender(view(r, etag, false)) };
}

const amountInput = () => screen.getByLabelText<HTMLInputElement>('Zu bestätigender Betrag (€)');
const reasonInput = () => screen.getByLabelText<HTMLInputElement>('Grund der Ablehnung (Pflicht)');
const confirmButton = () => screen.getByRole<HTMLButtonElement>('button', { name: /Zuordnung bestätigen|Wird bestätigt/ });
const rejectButton = () => screen.getByRole<HTMLButtonElement>('button', { name: /Vorschlag ablehnen|Wird abgelehnt/ });
const NBSP = '\u00a0';
const posts = (calls: readonly Call[]) => calls.filter((call) => call.method === 'POST');

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('step 6, Zuordnung bestaetigen (ui-guide.md §6.6 step 6; api-design.md §37.3)', () => {
  it('the suggested amount as it is: one POST …/confirm with If-Match and the exact string; nothing to MRE; green only after the answer', async () => {
    let answer: (response: Response) => void = () => undefined;
    const pending = new Promise<Response>((resolve) => {
      answer = resolve;
    });
    const { calls, onChanged } = setup({ answers: [() => pending] });
    expect(amountInput().value).toBe('850,00');
    fireEvent.click(confirmButton());
    await settle();
    expect(posts(calls)).toHaveLength(1);
    expect(calls[0]?.url).toBe(`/api/v1/rent-reconciliations/${REC}/confirm`);
    expect(calls[0]?.headers.get('if-match')).toBe('"1"');
    expect(calls[0]?.headers.has('idempotency-key')).toBe(false);
    expect(calls[0]?.body).toBe('{"matchedAmount":{"amount":"850.00","currency":"EUR"}}');
    expect(screen.queryByText(/Zuordnung bestätigt über/)).toBeNull();
    expect(confirmButton().textContent).toBe('Wird bestätigt …');
    answer(json(200, confirmed('850.00'), { etag: '"2"' }));
    await settle();
    expect(screen.getByRole('status').textContent).toContain(`Zuordnung bestätigt über 850,00${NBSP}€ (Version 2). An MRE wurde nichts übertragen`);
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(calls.map((call) => call.url).filter((url) => /write-back|remove-from-mre|release/.test(url))).toEqual([]);
  });

  it('a reduced amount is sent as typed; one cent more is refused before anything is sent', async () => {
    const { calls } = setup({ answers: [json(200, confirmed('849.99'))] });
    fireEvent.change(amountInput(), { target: { value: '850,01' } });
    expect(confirmButton().disabled).toBe(true);
    expect(screen.getByText(/Höher als der Vorschlag/)).toBeTruthy();
    expect(amountInput().getAttribute('aria-invalid')).toBe('true');
    fireEvent.click(confirmButton());
    await settle();
    expect(calls).toHaveLength(0);
    fireEvent.change(amountInput(), { target: { value: '849,99' } });
    expect(confirmButton().disabled).toBe(false);
    fireEvent.click(confirmButton());
    await settle();
    expect(calls[0]?.body).toBe('{"matchedAmount":{"amount":"849.99","currency":"EUR"}}');
  });

  it('zero, an ambiguous point and three places are said and never sent', async () => {
    const { calls } = setup();
    for (const [value, text] of [
      ['0', /größer als 0,00/],
      ['849.99', /Mehrdeutig/],
      ['849,999', /Höchstens zwei Nachkommastellen/],
    ] as const) {
      fireEvent.change(amountInput(), { target: { value } });
      expect(screen.getByText(text)).toBeTruthy();
      expect(confirmButton().disabled).toBe(true);
    }
    await settle();
    expect(calls).toHaveLength(0);
  });

  it('a double click sends one request', async () => {
    const { calls } = setup({ answers: [json(200, confirmed())] });
    fireEvent.click(confirmButton());
    fireEvent.click(confirmButton());
    await settle();
    expect(posts(calls)).toHaveLength(1);
  });

  it('a 412 keeps the amount and the reason and sends nothing again; the state is read only on request, then the new version is sent', async () => {
    const { calls, reload, rerender } = setup({ answers: [envelope(412, 'PRECONDITION_FAILED', { currentVersion: 2 }), json(200, confirmed('800.00'))] });
    fireEvent.change(amountInput(), { target: { value: '800,00' } });
    fireEvent.change(reasonInput(), { target: { value: 'Entwurf' } });
    fireEvent.click(confirmButton());
    await settle();
    expect(screen.getByRole('alert').textContent).toContain('Es wurde nichts entschieden');
    expect(amountInput().value).toBe('800,00');
    expect(reasonInput().value).toBe('Entwurf');
    expect(reload).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Aktuellen Stand laden' }));
    expect(reload).toHaveBeenCalledTimes(1);
    rerender(reconciliation({ version: 2 }), '"2"');
    fireEvent.click(confirmButton());
    await settle();
    expect(posts(calls)).toHaveLength(2);
    expect(calls[1]?.headers.get('if-match')).toBe('"2"');
    expect(calls[1]?.body).toBe('{"matchedAmount":{"amount":"800.00","currency":"EUR"}}');
  });

  it('no answer: „Erneut senden“ sends the same body with the same If-Match', async () => {
    const { calls } = setup({ answers: [new TypeError('offline'), json(200, confirmed('849.00'))] });
    fireEvent.change(amountInput(), { target: { value: '849' } });
    fireEvent.click(confirmButton());
    await settle();
    expect(screen.getByText(/Ob die Entscheidung gespeichert wurde, ist unklar/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Erneut senden' }));
    await settle();
    expect(posts(calls)).toHaveLength(2);
    expect(calls[1]?.body).toBe(calls[0]?.body);
    expect(calls[1]?.headers.get('if-match')).toBe('"1"');
  });

  it('409 reasons are said in German and the state is read again; an unknown reason and an unknown code with their code', async () => {
    const { reload } = setup({
      answers: [
        envelope(409, 'CONFLICT', { reason: 'SUGGESTION_STALE', openAmount: { amount: '0.00', currency: 'EUR' } }),
        envelope(422, 'ABOVE_SUGGESTION', { suggested: { amount: '850.00', currency: 'EUR' } }),
        envelope(409, 'CONFLICT', { reason: 'SOMETHING_NEW' }),
        envelope(418, 'BRAND_NEW'),
      ],
    });
    fireEvent.click(confirmButton());
    await settle();
    expect(screen.getByRole('alert').textContent).toContain('offen sind nur noch 0,00 €');
    expect(reload).toHaveBeenCalledTimes(1);
    fireEvent.click(confirmButton());
    await settle();
    expect(screen.getByRole('alert').textContent).toContain('Der Betrag liegt über dem Vorschlag (850,00 €)');
    fireEvent.click(confirmButton());
    await settle();
    expect(screen.getByRole('alert').textContent).toContain('Grund SOMETHING_NEW.');
    fireEvent.click(confirmButton());
    await settle();
    expect(screen.getByRole('alert').textContent).toContain('HTTP 418, Code BRAND_NEW');
  });

  it('nothing is offered on a stale state, and a late answer after the page was left changes nothing', async () => {
    let answer: (response: Response) => void = () => undefined;
    const pending = new Promise<Response>((resolve) => {
      answer = resolve;
    });
    const stale = setup({ stale: true });
    expect(confirmButton().disabled).toBe(true);
    expect(rejectButton().disabled).toBe(true);
    stale.unmount();
    const { onChanged, unmount } = setup({ answers: [() => pending] });
    fireEvent.click(confirmButton());
    await settle();
    unmount();
    answer(json(200, confirmed()));
    await settle();
    expect(onChanged).not.toHaveBeenCalled();
  });
});

describe('step 6, Vorschlag ablehnen (§37.3: with a required reason)', () => {
  it('no reason, no request; with one: body exactly { reason } trimmed, If-Match, then the result', async () => {
    const { calls, onChanged } = setup({ answers: [json(200, reconciliation({ status: 'REJECTED', version: 2, rejectReason: 'Andere Miete' }))] });
    expect(rejectButton().disabled).toBe(true);
    fireEvent.click(rejectButton());
    fireEvent.change(reasonInput(), { target: { value: '   ' } });
    expect(rejectButton().disabled).toBe(true);
    expect(screen.getByText('Ein Grund ist Pflicht.')).toBeTruthy();
    await settle();
    expect(calls).toHaveLength(0);
    fireEvent.change(reasonInput(), { target: { value: '  Andere Miete ' } });
    fireEvent.click(rejectButton());
    await settle();
    expect(calls[0]?.url).toBe(`/api/v1/rent-reconciliations/${REC}/reject`);
    expect(calls[0]?.body).toBe('{"reason":"Andere Miete"}');
    expect(calls[0]?.headers.get('if-match')).toBe('"1"');
    expect(screen.getByRole('status').textContent).toContain('Vorschlag abgelehnt (Version 2)');
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it('nothing to decide for any other status, a known or an unknown one', () => {
    for (const status of ['CONFIRMED', 'REJECTED', 'RELEASED', 'NEW_STATUS']) {
      const { unmount } = setup({ r: reconciliation({ status: status as RentReconciliationDto['status'] }) });
      expect(screen.queryByRole('button')).toBeNull();
      unmount();
    }
  });
});
