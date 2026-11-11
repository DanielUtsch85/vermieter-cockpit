// @vitest-environment jsdom
import { act as testingLibraryAct, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDeClient } from '../../api/client';
import { countingTokens, envelope, json, scriptedFetch, type Call } from '../../api/fetch.test-support';
import { reverseTransaction, type TransactionDetailDto } from '../../api/transactions';
import { correctionAnswer, detail, REALM_A, REALM_B, reversalAnswer, split, TX, TX_REPLACEMENT, TX_REVERSAL } from '../../transactions/fixtures.test-support';
import { ReverseForm } from './ReverseForm';

/**
 * „Stornieren“ as a component (api-design.md §35.9; Entscheidung des Projektinhabers, 2026-11-11; jsdom, `fireEvent`
 * only): every reversal goes through the real client (`reverseTransaction`) to a scripted fetch; the keys come from a
 * counter, so a test sees which intent a request was.
 */

const act = testingLibraryAct as unknown as (callback: () => void | Promise<void>) => Promise<void>;
const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

const ORIGINAL = detail({
  status: 'CONFIRMED',
  version: 4,
  confirmedAt: '2026-03-05T10:00:00.000Z',
  confirmedBy: 'vermieter@example.invalid',
  splits: [split({ amount: { amount: '850.00', currency: 'EUR' } })],
});
const REASON = 'Doppelt erfasst';

function setup(options: { transaction?: TransactionDetailDto; answers?: Parameters<typeof scriptedFetch> } = {}) {
  const { fetch, calls } = scriptedFetch(...(options.answers ?? []));
  const de = createDeClient({ tokens: countingTokens(), realmId: REALM_A, fetch });
  const onReversed = vi.fn<() => void>();
  const reload = vi.fn<() => void>();
  let keys = 0;
  const form = (t: TransactionDetailDto, stale: boolean) => (
    <ReverseForm
      realmId={REALM_A}
      transaction={t}
      etag={`"${t.version}"`}
      stale={stale}
      reverse={(body, ifMatch, key) => reverseTransaction(de, TX, body, ifMatch, key)}
      onReversed={onReversed}
      reload={reload}
      newKey={() => `absicht-${(keys += 1)}`}
    />
  );
  const view = render(form(options.transaction ?? ORIGINAL, false));
  return { calls, onReversed, reload, unmount: view.unmount, rerender: (t: TransactionDetailDto, stale = false) => view.rerender(form(t, stale)) };
}

const reasonField = () => {
  const element = document.getElementById('storno-reason');
  if (element === null) throw new Error('no reason field');
  return element as HTMLTextAreaElement;
};
const typeReason = (value: string) => fireEvent.change(reasonField(), { target: { value } });
const button = (name: string | RegExp) => screen.getByRole<HTMLButtonElement>('button', { name });
const open = () => fireEvent.click(button('Stornieren'));
const ask = () => fireEvent.click(button('Storno ausführen'));
const confirmNow = () => fireEvent.click(button(/Jetzt stornieren|Wird storniert/));
const posts = (calls: readonly Call[]) => calls.filter((call) => call.method === 'POST');
const counter = () => document.getElementById('storno-reason-zaehler')?.textContent;

/** Open, type the reason, „Storno ausführen“, „Jetzt stornieren“. */
function reverse(reason = REASON) {
  open();
  typeReason(reason);
  ask();
  confirmNow();
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('„Stornieren“: the form and its reason (api-design.md §35.9: trimmed, 1–500 characters)', () => {
  it('is its own action: a button opens the form, which takes the focus; nothing is sent by opening', async () => {
    const { calls } = setup();
    expect(screen.getByText(/es gibt keine Ersatzbuchung\. Das ist endgültig\./)).toBeTruthy();
    open();
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Stornieren' }));
    expect(screen.getByRole('form', { name: 'Storno erfassen' })).toBeTruthy();
    expect(screen.getByLabelText('Grund des Stornos (Pflicht)')).toBe(reasonField());
    expect(screen.getByText('Gesendet wird mit If-Match "4".')).toBeTruthy();
    await settle();
    expect(calls).toHaveLength(0);
  });

  it('empty, only spaces or 501 characters: not sendable, said at the field; the counter counts what is sent', async () => {
    const { calls } = setup();
    open();
    expect(button('Storno ausführen').disabled).toBe(true);
    expect(counter()).toBe('0 von 500 Zeichen');
    expect(screen.getByText('Grund angeben.')).toBeTruthy();
    expect(reasonField().getAttribute('aria-invalid')).toBe('true');
    expect(reasonField().getAttribute('aria-describedby')?.split(' ')).toEqual(['storno-reason-hinweis', 'storno-reason-zaehler']);
    typeReason('   \n\t ');
    expect(button('Storno ausführen').disabled).toBe(true);
    expect(counter()).toBe('0 von 500 Zeichen');
    expect(screen.getByText('Grund angeben.')).toBeTruthy();
    typeReason('x'.repeat(501));
    expect(button('Storno ausführen').disabled).toBe(true);
    expect(counter()).toBe('501 von 500 Zeichen');
    expect(screen.getByText('Höchstens 500 Zeichen.')).toBeTruthy();
    expect(reasonField().getAttribute('aria-describedby')?.split(' ')).toEqual(['storno-reason-hinweis', 'storno-reason-zaehler']);
    // A submit by keyboard on an unsendable form opens no dialog either.
    fireEvent.submit(screen.getByRole('form', { name: 'Storno erfassen' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    typeReason(`  ${'x'.repeat(500)}  `);
    expect(button('Storno ausführen').disabled).toBe(false);
    expect(counter()).toBe('500 von 500 Zeichen');
    expect(reasonField().hasAttribute('aria-invalid')).toBe(false);
    expect(reasonField().getAttribute('aria-describedby')).toBe('storno-reason-zaehler');
    await settle();
    expect(calls).toHaveLength(0);
  });
});

describe('„Stornieren“: the confirmation step (ConfirmStep, ui-guide.md §4.4, §11)', () => {
  it('says that it is final and that no replacement follows; opening sends nothing', async () => {
    const { calls } = setup();
    open();
    typeReason(`  ${REASON} `);
    ask();
    const dialog = screen.getByRole('dialog', { name: 'Buchung jetzt stornieren?' });
    expect(document.activeElement).toBe(within(dialog).getByRole('heading', { name: 'Buchung jetzt stornieren?' }));
    expect(within(dialog).getByText(/Das Storno ist endgültig/)).toBeTruthy();
    expect(within(dialog).getByText(/Es gibt keine Ersatzbuchung, auch später nicht/)).toBeTruthy();
    expect(within(dialog).getByText(`Grund: „${REASON}“`)).toBeTruthy();
    expect(
      within(dialog)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['Jetzt stornieren', 'Abbrechen']);
    expect(reasonField().readOnly).toBe(true);
    await settle();
    expect(calls).toHaveLength(0);
  });

  it('Abbrechen and Escape send nothing and give the focus back to „Storno ausführen“; the reason stays', async () => {
    const { calls, onReversed } = setup();
    open();
    typeReason(REASON);
    ask();
    fireEvent.click(button('Abbrechen'));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(button('Storno ausführen'));
    ask();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(button('Storno ausführen'));
    expect(reasonField().value).toBe(REASON);
    expect(reasonField().readOnly).toBe(false);
    await settle();
    expect(calls).toHaveLength(0);
    expect(onReversed).not.toHaveBeenCalled();
  });

  it('„Jetzt stornieren“ sends one request: body exactly {reason} trimmed, If-Match of the original, a key', async () => {
    const { calls } = setup({ answers: [json(201, reversalAnswer())] });
    reverse(`  ${REASON}\n`);
    await settle();
    expect(calls).toHaveLength(1);
    const call = posts(calls)[0];
    expect(call?.url).toBe(`/api/v1/transactions/${TX}/reverse`);
    expect(call?.body).toBe(JSON.stringify({ reason: REASON }));
    expect(call?.headers.get('if-match')).toBe('"4"');
    expect(call?.headers.get('idempotency-key')).toBe('absicht-1');
    expect(call?.headers.get('organizationid')).toBe(REALM_A);
  });

  it('the answer is the chain original → reversal, no replacement; heading focused, the page reads again', async () => {
    const { onReversed } = setup({ answers: [json(201, reversalAnswer())] });
    reverse();
    await settle();
    const heading = screen.getByRole('heading', { name: 'Storno ausgeführt' });
    expect(document.activeElement).toBe(heading);
    expect(screen.getByText(/es gibt keine Ersatzbuchung, auch später nicht/)).toBeTruthy();
    const chain = screen.getByRole('list', { name: 'Stornokette' });
    const links = within(chain).getAllByRole('link');
    expect(links.map((a) => a.textContent)).toEqual(['Original', 'Storno']);
    expect(links.map((a) => a.getAttribute('href'))).toEqual([TX, TX_REVERSAL].map((id) => `/cockpit/r/${REALM_A}/buchungen/${id}`));
    expect(within(chain).getByText('Korrigiert/storniert')).toBeTruthy();
    expect(screen.getByTestId(`kette-${TX_REVERSAL}`).textContent).toContain('-850,00');
    expect(screen.queryByTestId(`kette-${TX_REPLACEMENT}`)).toBeNull();
    expect(onReversed).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('form', { name: 'Storno erfassen' })).toBeNull();
  });

  it('a double click on „Jetzt stornieren“ sends one request', async () => {
    const { calls } = setup({ answers: [json(201, reversalAnswer()), json(201, reversalAnswer())] });
    open();
    typeReason(REASON);
    ask();
    await act(() => {
      confirmNow();
      confirmNow();
    });
    await settle();
    expect(posts(calls)).toHaveLength(1);
  });
});

describe('„Stornieren“: the intent and its Idempotency-Key (ui-guide.md §7.3)', () => {
  it('no answer: Erneut senden (without a second dialog) and the same reason again keep body, If-Match and key', async () => {
    const { calls } = setup({ answers: [new TypeError('network down'), new TypeError('network down'), json(201, reversalAnswer())] });
    reverse();
    await settle();
    expect(screen.getByText(/Ob das Storno ausgeführt wurde, ist unklar/)).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(button('Erneut senden'));
    await settle();
    expect(screen.queryByRole('dialog')).toBeNull();
    // The same reason, typed with other spaces, is the same body.
    typeReason(` ${REASON} `);
    ask();
    confirmNow();
    await settle();
    const three = posts(calls);
    expect(three.map((c) => c.headers.get('idempotency-key'))).toEqual(['absicht-1', 'absicht-1', 'absicht-1']);
    expect(three.map((c) => c.headers.get('if-match'))).toEqual(['"4"', '"4"', '"4"']);
    expect(three.map((c) => c.body)).toEqual([0, 1, 2].map(() => JSON.stringify({ reason: REASON })));
    expect(screen.getByRole('heading', { name: 'Storno ausgeführt' })).toBeTruthy();
  });

  it('a changed reason after a lost answer is a new intent: new key, and Erneut senden is gone', async () => {
    const { calls } = setup({ answers: [new TypeError('network down'), json(201, reversalAnswer())] });
    reverse();
    await settle();
    typeReason('Falsches Konto');
    expect(screen.queryByRole('button', { name: 'Erneut senden' })).toBeNull();
    ask();
    confirmNow();
    await settle();
    expect(posts(calls).map((c) => c.headers.get('idempotency-key'))).toEqual(['absicht-1', 'absicht-2']);
    expect(posts(calls)[1]?.body).toBe(JSON.stringify({ reason: 'Falsches Konto' }));
  });
});

describe('„Stornieren“: refusals (api-design.md §35.9, §37 P4-D7), said in German, the reason kept', () => {
  it('412 keeps the reason, sends nothing again and reads only on request', async () => {
    const { calls, reload } = setup({ answers: [envelope(412, 'VERSION_CONFLICT', { expectedVersions: [4], currentVersion: 5 })] });
    reverse();
    await settle();
    expect(screen.getByText('Inzwischen geändert')).toBeTruthy();
    expect(screen.getByText(/erst „Storno ausführen“ und „Jetzt stornieren“ senden mit der neuen Version/)).toBeTruthy();
    expect(reasonField().value).toBe(REASON);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Erneut senden' })).toBeNull();
    expect(reload).not.toHaveBeenCalled();
    fireEvent.click(button('Aktuellen Stand laden'));
    expect(reload).toHaveBeenCalledTimes(1);
    await settle();
    expect(posts(calls)).toHaveLength(1);
  });

  it('TRANSACTION_RENT_RECONCILED: the release first; each reconciliation links to its Mietabgleich page, no button', async () => {
    const ids = ['8d6b0e9f-1a2c-4d34-8f56-f708192a3b4c', '9e7c1f0a-2b3d-4e45-9a67-0819a2b3c4d5'];
    setup({ answers: [envelope(409, 'CONFLICT', { reason: 'TRANSACTION_RENT_RECONCILED', reconciliationIds: ids })] });
    reverse();
    await settle();
    const alert = screen.getByRole('alert');
    expect(within(alert).getByText(/Solange er besteht, kann sie nicht storniert werden/)).toBeTruthy();
    expect(within(alert).getByText(/Zuerst muss die Zuordnung im Mietabgleich aufgehoben werden .*; danach ist das Storno möglich\./)).toBeTruthy();
    const links = within(alert).getAllByRole('link', { name: 'Mietzuordnung öffnen und aufheben' });
    expect(links.map((link) => link.getAttribute('href'))).toEqual(ids.map((id) => `/cockpit/r/${REALM_A}/mietabgleich/${id}`));
    expect(within(alert).queryAllByRole('button')).toHaveLength(0);
    expect(reasonField().value).toBe(REASON);
  });

  it('ALREADY_CORRECTED links the existing reversal only (no replacement for a reversed original)', async () => {
    setup({ answers: [envelope(409, 'CONFLICT', { reason: 'ALREADY_CORRECTED', reversalTransactionId: TX_REVERSAL, replacementTransactionId: null })] });
    reverse();
    await settle();
    const alert = screen.getByRole('alert');
    expect(within(alert).getByText(/bereits korrigiert oder storniert; ein zweites Storno gibt es nicht/)).toBeTruthy();
    expect(
      within(alert)
        .getAllByRole('link')
        .map((a) => [a.textContent, a.getAttribute('href')]),
    ).toEqual([['Vorhandenes Storno', `/cockpit/r/${REALM_A}/buchungen/${TX_REVERSAL}`]]);
  });

  it('NOT_CORRECTABLE, unknown reasons and unknown codes are said with their code, never swallowed', async () => {
    const cases: [Response, RegExp][] = [
      [envelope(409, 'CONFLICT', { reason: 'NOT_CORRECTABLE', status: 'CONFIRMED', correctionRole: 'REVERSAL' }), /Ein Storno wird nie storniert/],
      [envelope(409, 'CONFLICT', { reason: 'NOT_CORRECTABLE', status: 'IGNORED' }), /Status „Ignoriert“ und kann nicht storniert werden/],
      [envelope(409, 'CONFLICT', { reason: 'NOT_CORRECTABLE', status: 'RECONCILED' }), /Status „Abgeglichen“ und kann nicht storniert werden/],
      [envelope(409, 'CONFLICT', { reason: 'BRAND_NEW' }), /Grund BRAND_NEW\./],
      [envelope(418, 'TEAPOT'), /HTTP 418, Code TEAPOT\./],
      [envelope(404, 'NOT_FOUND'), /nicht gefunden oder ist nicht zugänglich/],
    ];
    for (const [response, text] of cases) {
      setup({ answers: [response] });
      reverse();
      await settle();
      expect(within(screen.getByRole('alert')).getByText(text), String(text)).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Erneut senden' })).toBeNull();
      cleanup();
    }
  });

  it('a field error on reason is bound to the field; the summary keeps every entry', async () => {
    const fields = [
      { field: 'reason', code: 'TOO_LONG' },
      { field: '(body)', code: 'UNKNOWN_KEY' },
    ];
    setup({ answers: [envelope(400, 'VALIDATION_ERROR', { fields })] });
    reverse();
    await settle();
    expect(reasonField().getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByText(/Vom Server abgelehnt/)).toBeTruthy();
    expect(reasonField().getAttribute('aria-describedby')?.split(' ')).toEqual(['storno-reason-hinweis', 'storno-reason-zaehler']);
    expect(within(screen.getByRole('list', { name: 'Abgelehnte Angaben' })).getAllByRole('listitem')).toHaveLength(2);
  });

  it('an answer that carries a replacement or names another Realm is refused; no chain is shown, the reason stays', async () => {
    const chain = correctionAnswer();
    const answer = reversalAnswer();
    const wrong = [json(201, chain), json(201, { ...answer, reversal: { ...answer.reversal, mreRealmId: REALM_B } })];
    for (const response of wrong) {
      setup({ answers: [response] });
      reverse();
      await settle();
      expect(screen.getByRole('alert')).toBeTruthy();
      expect(screen.queryByRole('heading', { name: 'Storno ausgeführt' })).toBeNull();
      expect(screen.queryByRole('list', { name: 'Stornokette' })).toBeNull();
      expect(reasonField().value).toBe(REASON);
      cleanup();
    }
  });
});

describe('„Stornieren“: nothing on a stale or changed state', () => {
  it('while the detail is read again the open dialog cannot send; a read no longer reversible keeps the reason and sends nothing', async () => {
    const { calls, rerender } = setup();
    open();
    typeReason(REASON);
    ask();
    rerender(ORIGINAL, true);
    expect(button('Jetzt stornieren').disabled).toBe(true);
    expect(button('Abbrechen').disabled).toBe(false);
    rerender({ ...ORIGINAL, status: 'CORRECTED', version: 5 });
    expect(screen.getByText(/Status „Korrigiert\/storniert“ und kann hier nicht mehr storniert werden/)).toBeTruthy();
    expect(button('Jetzt stornieren').disabled).toBe(true);
    confirmNow();
    fireEvent.click(button('Abbrechen'));
    expect(button('Storno ausführen').disabled).toBe(true);
    fireEvent.submit(screen.getByRole('form', { name: 'Storno erfassen' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(reasonField().value).toBe(REASON);
    await settle();
    expect(calls).toHaveLength(0);
  });

  it('a reversal is not offered: the button is there but disabled', () => {
    setup({ transaction: { ...ORIGINAL, correctionRole: 'REVERSAL', correctionOfTransactionId: TX_REPLACEMENT } });
    expect(button('Stornieren').disabled).toBe(true);
  });

  it('an answer after the page is gone changes nothing', async () => {
    let answer: (response: Response) => void = () => undefined;
    const pending = new Promise<Response>((resolve) => {
      answer = resolve;
    });
    const { onReversed, unmount } = setup({ answers: [() => pending] });
    reverse();
    await settle();
    unmount();
    await act(async () => {
      answer(json(201, reversalAnswer()));
      await pending;
    });
    expect(onReversed).not.toHaveBeenCalled();
  });
});
