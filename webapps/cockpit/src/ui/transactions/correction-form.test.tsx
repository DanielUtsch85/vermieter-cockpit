// @vitest-environment jsdom
import { act as testingLibraryAct, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDeClient } from '../../api/client';
import { countingTokens, envelope, json, scriptedFetch, type Call } from '../../api/fetch.test-support';
import { correctTransaction, type TransactionDetailDto } from '../../api/transactions';
import {
  category,
  correctionAnswer,
  detail,
  page,
  property,
  PROPERTY,
  REALM_A,
  split,
  TX,
  TX_REPLACEMENT,
  TX_REVERSAL,
} from '../../transactions/fixtures.test-support';
import { CorrectionForm } from './CorrectionForm';
import type { References } from './references';

/**
 * Step 4, „Korrigieren“ as a component (jsdom, `fireEvent` only): every correction goes through the real client
 * (`correctTransaction`) to a scripted fetch; the keys come from a counter, so a test sees which intent a request was.
 */

const act = testingLibraryAct as unknown as (callback: () => void | Promise<void>) => Promise<void>;
const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
const NBSP = ' ';

const references: References = {
  accounts: { status: 'success', data: page([]) },
  properties: { status: 'success', data: page([property()]) },
  categories: { status: 'success', data: [category(), category({ code: 'RENT_OPERATING_COST_ADVANCE', name: 'Nebenkostenvorauszahlung' })] },
};

const ORIGINAL = detail({
  status: 'CONFIRMED',
  version: 4,
  confirmedAt: '2026-03-05T10:00:00.000Z',
  confirmedBy: 'vermieter@example.invalid',
  splits: [
    split(),
    split({
      splitId: '7c5a9d8f-0e1b-4c23-9e45-e6f708192a3b',
      position: 2,
      amount: { amount: '150.00', currency: 'EUR' },
      financialCategoryCode: 'RENT_OPERATING_COST_ADVANCE',
      propertyReferenceId: null,
    }),
  ],
});

function setup(options: { transaction?: TransactionDetailDto; stale?: boolean; answers?: Parameters<typeof scriptedFetch> } = {}) {
  const { fetch, calls } = scriptedFetch(...(options.answers ?? []));
  const de = createDeClient({ tokens: countingTokens(), realmId: REALM_A, fetch });
  const onCorrected = vi.fn<() => void>();
  const reload = vi.fn<() => void>();
  let keys = 0;
  const form = (t: TransactionDetailDto, stale: boolean) => (
    <CorrectionForm
      realmId={REALM_A}
      transaction={t}
      etag={`"${t.version}"`}
      stale={stale}
      references={references}
      correct={(body, ifMatch, key) => correctTransaction(de, TX, body, ifMatch, key)}
      onCorrected={onCorrected}
      reload={reload}
      newKey={() => `absicht-${(keys += 1)}`}
    />
  );
  const view = render(form(options.transaction ?? ORIGINAL, options.stale ?? false));
  return { calls, onCorrected, reload, unmount: view.unmount, rerender: (t: TransactionDetailDto, stale = false) => view.rerender(form(t, stale)) };
}

const control = (id: string) => {
  const element = document.getElementById(id);
  if (element === null) throw new Error(`no control ${id}`);
  return element as HTMLInputElement & HTMLSelectElement & HTMLTextAreaElement;
};
const type = (element: HTMLElement, value: string) => fireEvent.change(element, { target: { value } });
const open = () => fireEvent.click(screen.getByRole('button', { name: 'Korrektur erfassen' }));
const sendButton = () => screen.getByRole<HTMLButtonElement>('button', { name: /Korrektur ausführen|Korrektur wird ausgeführt/ });
const send = () => fireEvent.click(sendButton());
const posts = (calls: readonly Call[]) => calls.filter((call) => call.method === 'POST');
const sent = (call: Call | undefined) => JSON.parse(call?.body ?? 'null') as { reason: string; replacement: Record<string, unknown> };

/** Reason and a new description: the smallest correction. */
function describeAnew(description = 'Korrigierter Verwendungszweck') {
  open();
  type(control('korrektur-reason'), 'Falscher Verwendungszweck');
  type(control('korrektur-description'), description);
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('step 4, the correction form (ui-guide.md §6.3, §8; api-design.md §35.2)', () => {
  it('is opened on request, takes the focus, and sends only with a reason and a change', async () => {
    const { calls } = setup();
    open();
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Korrigieren' }));
    expect(sendButton().disabled).toBe(true);
    expect(screen.getByText(/Noch keine Änderung/)).toBeTruthy();
    type(control('korrektur-description'), 'Neu');
    expect(sendButton().disabled).toBe(true);
    expect(screen.getByText('Grund angeben.')).toBeTruthy();
    type(control('korrektur-reason'), 'Tippfehler');
    expect(sendButton().disabled).toBe(false);
    expect(screen.getByText(/Die Ersatzbuchung ändert: Verwendungszweck\./)).toBeTruthy();
    await settle();
    expect(calls).toHaveLength(0);
  });

  it('sends If-Match of the original, a key and only the changed fields; never ids, status or version of the detail', async () => {
    const { calls } = setup({ answers: [json(201, correctionAnswer({ description: 'Korrigierter Verwendungszweck' }))] });
    describeAnew();
    send();
    await settle();
    const call = posts(calls)[0];
    expect(call?.url).toBe(`/api/v1/transactions/${TX}/correct`);
    expect(call?.headers.get('if-match')).toBe('"4"');
    expect(call?.headers.get('idempotency-key')).toBe('absicht-1');
    expect(sent(call)).toEqual({ reason: 'Falscher Verwendungszweck', replacement: { description: 'Korrigierter Verwendungszweck' } });
    for (const forbidden of ['transactionId', 'mreRealmId', 'status', 'version', 'splitId', 'position', 'provenance', 'confirmedAt', 'financialAccountId']) {
      expect(call?.body, forbidden).not.toContain(forbidden);
    }
  });

  it('shows the chain with links and focus; the original is never offered for editing again', async () => {
    const { onCorrected } = setup({ answers: [json(201, correctionAnswer({ description: 'Korrigierter Verwendungszweck' }))] });
    describeAnew();
    send();
    await settle();
    const heading = screen.getByRole('heading', { name: 'Korrektur ausgeführt' });
    expect(document.activeElement).toBe(heading);
    const chain = screen.getByRole('list', { name: 'Korrekturkette' });
    const links = within(chain).getAllByRole('link');
    expect(links.map((a) => a.textContent)).toEqual(['Original', 'Storno', 'Ersatzbuchung']);
    expect(links.map((a) => a.getAttribute('href'))).toEqual([TX, TX_REVERSAL, TX_REPLACEMENT].map((id) => `/cockpit/r/${REALM_A}/buchungen/${id}`));
    expect(within(chain).getByText('Korrigiert/storniert')).toBeTruthy();
    expect(onCorrected).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('form', { name: 'Korrektur erfassen' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Korrektur erfassen' })).toBeNull();
  });

  it('a changed amount needs the replacement splits; sent exactly as typed, the chain shows the same amounts', async () => {
    const { calls } = setup({
      answers: [json(201, correctionAnswer({ amount: { amount: '1234.56', currency: 'EUR' } }))],
    });
    open();
    type(control('korrektur-reason'), 'Betrag falsch erfasst');
    type(control('korrektur-amount'), '1.234,56');
    expect(sendButton().disabled).toBe(true);
    expect(screen.getByText(/braucht die Ersatzbuchung eine eigene Aufteilung/)).toBeTruthy();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Aufteilung der Ersatzbuchung ändern' }));
    expect(control('korrektur-split-0-amount').value).toBe('700,00');
    type(control('korrektur-split-0-amount'), '1.084,56');
    expect(screen.getByTestId('korrektur-split-rest-amount').textContent).toBe(`0,00${NBSP}€`);
    type(control('korrektur-split-1-amount'), '150,01');
    expect(screen.getByTestId('korrektur-split-rest-amount').textContent).toBe(`0,01${NBSP}€ zu viel`);
    expect(sendButton().disabled).toBe(true);
    type(control('korrektur-split-1-amount'), '150,00');
    send();
    await settle();
    const body = sent(posts(calls)[0]);
    expect(body.replacement['amount']).toEqual({ amount: '1234.56', currency: 'EUR' });
    expect((body.replacement['splits'] as { amount: { amount: string } }[]).map((s) => s.amount.amount)).toEqual(['1084.56', '150.00']);
    expect(JSON.stringify(body.replacement['splits'])).not.toContain('splitId');
    const chain = screen.getByRole('list', { name: 'Korrekturkette' });
    // Original and reversal keep the original's amount, the reversal in the opposite direction; the replacement as typed.
    expect(screen.getByTestId(`kette-${TX}`).textContent).toContain(`850,00${NBSP}€`);
    expect(screen.getByTestId(`kette-${TX_REVERSAL}`).textContent).toContain(`-850,00${NBSP}€`);
    expect(screen.getByTestId(`kette-${TX_REPLACEMENT}`).textContent).toContain(`1.234,56${NBSP}€`);
    expect(screen.getByTestId(`kette-${TX}`).textContent).not.toContain('-850');
    expect(chain).toBeTruthy();
  });

  it('no answer: Erneut senden and a second click on the unchanged form keep body, If-Match and key', async () => {
    const { calls } = setup({ answers: [new TypeError('network down'), new TypeError('network down'), json(201, correctionAnswer())] });
    describeAnew();
    send();
    await settle();
    expect(screen.getByText(/Ob die Korrektur ausgeführt wurde, ist unklar/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Erneut senden' }));
    await settle();
    send();
    await settle();
    const three = posts(calls);
    expect(three).toHaveLength(3);
    expect(three.map((c) => c.headers.get('idempotency-key'))).toEqual(['absicht-1', 'absicht-1', 'absicht-1']);
    expect(three.map((c) => c.headers.get('if-match'))).toEqual(['"4"', '"4"', '"4"']);
    expect(new Set(three.map((c) => c.body)).size).toBe(1);
  });

  it('a changed body after a lost answer is a new intent: new key, and Erneut senden is gone', async () => {
    const { calls } = setup({ answers: [new TypeError('network down'), json(201, correctionAnswer())] });
    describeAnew();
    send();
    await settle();
    type(control('korrektur-description'), 'Doch anders');
    expect(screen.queryByRole('button', { name: 'Erneut senden' })).toBeNull();
    send();
    await settle();
    expect(posts(calls).map((c) => c.headers.get('idempotency-key'))).toEqual(['absicht-1', 'absicht-2']);
    expect(sent(posts(calls)[1]).replacement).toEqual({ description: 'Doch anders' });
  });

  it('a double click sends one request', async () => {
    const { calls } = setup({ answers: [json(201, correctionAnswer()), json(201, correctionAnswer())] });
    describeAnew();
    await act(() => {
      send();
      send();
      fireEvent.submit(screen.getByRole('form', { name: 'Korrektur erfassen' }));
    });
    await settle();
    expect(posts(calls)).toHaveLength(1);
  });

  it('412 keeps the draft value for value, sends nothing again and reads only on request', async () => {
    const { calls, reload } = setup({ answers: [envelope(412, 'VERSION_CONFLICT', { expectedVersions: [4], currentVersion: 5 })] });
    describeAnew();
    type(control('korrektur-bookingDate'), '2026-03-04');
    send();
    await settle();
    expect(screen.getByText('Inzwischen geändert')).toBeTruthy();
    expect(control('korrektur-reason').value).toBe('Falscher Verwendungszweck');
    expect(control('korrektur-description').value).toBe('Korrigierter Verwendungszweck');
    expect(control('korrektur-bookingDate').value).toBe('2026-03-04');
    expect(screen.queryByRole('button', { name: 'Erneut senden' })).toBeNull();
    expect(reload).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Aktuellen Stand laden' }));
    expect(reload).toHaveBeenCalledTimes(1);
    await settle();
    expect(posts(calls)).toHaveLength(1);
  });

  it('field errors are bound to their inputs by dotted name; the summary keeps every entry in server order', async () => {
    const fields = [
      { field: 'replacement.splits.1.amount.amount', code: 'SCALE_EXCEEDED' },
      { field: 'reason', code: 'REQUIRED' },
      { field: 'replacement.bookingDate', code: 'OUT_OF_RANGE' },
      { field: 'replacement.financialAccountId', code: 'CURRENCY_MISMATCH' },
      { field: '(body)', code: 'SOMETHING_NEW' },
    ];
    setup({ answers: [envelope(400, 'VALIDATION_ERROR', { fields })] });
    describeAnew();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Aufteilung der Ersatzbuchung ändern' }));
    send();
    await settle();
    expect(control('korrektur-reason').getAttribute('aria-invalid')).toBe('true');
    expect(control('korrektur-bookingDate').getAttribute('aria-invalid')).toBe('true');
    expect(control('korrektur-split-1-amount').getAttribute('aria-invalid')).toBe('true');
    expect(control('korrektur-split-0-amount').hasAttribute('aria-invalid')).toBe(false);
    expect(control('korrektur-description').hasAttribute('aria-invalid')).toBe(false);
    expect(document.activeElement).toBe(control('korrektur-reason'));
    const summary = screen.getByRole('list', { name: 'Abgelehnte Angaben' });
    expect(
      within(summary)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual([
      'replacement.splits.1.amount.amount: zu viele Nachkommastellen',
      'reason: fehlt',
      'replacement.bookingDate: außerhalb des zulässigen Bereichs',
      'replacement.financialAccountId: Währungen passen nicht zusammen',
      'Anfrageinhalt: Code SOMETHING_NEW',
    ]);
    expect(screen.queryByRole('button', { name: 'Erneut senden' })).toBeNull();
  });

  it('a confirmed rent reconciliation: the release comes first, explained; nothing links to a flow that does not exist', async () => {
    setup({ answers: [envelope(409, 'CONFLICT', { reason: 'TRANSACTION_RENT_RECONCILED', reconciliationIds: ['8d6b0e9f-1a2c-4d34-8f56-f708192a3b4c'] })] });
    describeAnew();
    send();
    await settle();
    const alert = screen.getByRole('alert');
    expect(within(alert).getByText(/durch einen bestätigten Mietabgleich mit einer Mietforderung verknüpft/)).toBeTruthy();
    expect(within(alert).getByText(/Zuerst muss der Mietabgleich freigegeben werden/)).toBeTruthy();
    expect(within(alert).getByText('8d6b0e9f-1a2c-4d34-8f56-f708192a3b4c')).toBeTruthy();
    expect(within(alert).queryAllByRole('link')).toHaveLength(0);
    expect(within(alert).queryAllByRole('button')).toHaveLength(0);
    // The draft stays for after the release.
    expect(control('korrektur-description').value).toBe('Korrigierter Verwendungszweck');
  });

  it('ALREADY_CORRECTED links the existing correction; other reasons and unknown codes are said, never swallowed', async () => {
    const cases: [Response, RegExp][] = [
      [envelope(409, 'CONFLICT', { reason: 'NO_CHANGE' }), /gleicht dem Original in jedem Feld/],
      [envelope(409, 'CONFLICT', { reason: 'NOT_CORRECTABLE', status: 'CONFIRMED', correctionRole: 'REVERSAL' }), /Ein Storno wird nie korrigiert/],
      [envelope(409, 'CONFLICT', { reason: 'NOT_CORRECTABLE', status: 'RECONCILED' }), /Status „Abgeglichen“ und kann nicht korrigiert werden/],
      [envelope(422, 'REVIEW_REQUIRED', { reason: 'INACTIVE_CATEGORY', financialCategoryCodes: ['OLD_FEE'] }), /nicht mehr aktiv \(OLD_FEE\)/],
      [envelope(409, 'CONFLICT', { reason: 'BRAND_NEW' }), /Grund BRAND_NEW\./],
      [envelope(418, 'TEAPOT'), /HTTP 418, Code TEAPOT\./],
    ];
    for (const [response, text] of cases) {
      setup({ answers: [response] });
      describeAnew();
      send();
      await settle();
      expect(screen.getByText(text), String(text)).toBeTruthy();
      cleanup();
    }
    setup({
      answers: [envelope(409, 'CONFLICT', { reason: 'ALREADY_CORRECTED', reversalTransactionId: TX_REVERSAL, replacementTransactionId: TX_REPLACEMENT })],
    });
    describeAnew();
    send();
    await settle();
    const links = within(screen.getByRole('alert')).getAllByRole('link');
    expect(links.map((a) => [a.textContent, a.getAttribute('href')])).toEqual([
      ['Vorhandenes Storno', `/cockpit/r/${REALM_A}/buchungen/${TX_REVERSAL}`],
      ['Vorhandene Ersatzbuchung', `/cockpit/r/${REALM_A}/buchungen/${TX_REPLACEMENT}`],
    ]);
  });

  it('while the detail is read again nothing is sent; a read that is no longer correctable keeps the draft and sends nothing', async () => {
    const { calls, rerender } = setup();
    describeAnew();
    rerender(ORIGINAL, true);
    expect(sendButton().disabled).toBe(true);
    rerender({ ...ORIGINAL, status: 'CORRECTED', version: 5 });
    expect(screen.getByText(/Status „Korrigiert\/storniert“ und kann hier nicht mehr korrigiert werden/)).toBeTruthy();
    expect(control('korrektur-description').value).toBe('Korrigierter Verwendungszweck');
    expect(sendButton().disabled).toBe(true);
    fireEvent.submit(screen.getByRole('form', { name: 'Korrektur erfassen' }));
    await settle();
    expect(calls).toHaveLength(0);
  });

  it('an emptied value date, description and object are sent as null; a new object as its id', async () => {
    const original = { ...ORIGINAL, propertyReferenceId: PROPERTY };
    const { calls } = setup({ transaction: original, answers: [json(201, correctionAnswer())] });
    open();
    expect(control('korrektur-propertyReferenceId').value).toBe(PROPERTY);
    type(control('korrektur-reason'), 'Angaben entfernen');
    type(control('korrektur-valueDate'), '');
    type(control('korrektur-description'), '');
    type(control('korrektur-propertyReferenceId'), '');
    send();
    await settle();
    expect(sent(posts(calls)[0]).replacement).toEqual({ valueDate: null, description: null, propertyReferenceId: null });
  });

  it('an answer after the page is gone changes nothing', async () => {
    let answer: (response: Response) => void = () => undefined;
    const pending = new Promise<Response>((resolve) => {
      answer = resolve;
    });
    const { onCorrected, unmount } = setup({ answers: [() => pending] });
    describeAnew();
    send();
    await settle();
    unmount();
    await act(async () => {
      answer(json(201, correctionAnswer()));
      await pending;
    });
    expect(onCorrected).not.toHaveBeenCalled();
  });
});
