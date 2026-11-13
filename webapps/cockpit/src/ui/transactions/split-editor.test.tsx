// @vitest-environment jsdom
import { act as testingLibraryAct, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDeClient } from '../../api/client';
import { countingTokens, envelope, json, scriptedFetch, type Call } from '../../api/fetch.test-support';
import { putSplits, type SplitsSaved, type TransactionDetailDto, type TransactionRead, type TransactionSplitsDto } from '../../api/transactions';
import { category, detail, page, property, PROPERTY, REALM_A, split, TX } from '../../transactions/fixtures.test-support';
import type { References } from './references';
import { SplitEditor } from './SplitEditor';
import { findSaved } from '../technical.test-support';

/**
 * Step 3 as component tests (jsdom and Testing Library with `fireEvent`; Entscheidung des Projektinhabers, 2026-11-10):
 * the editor is rendered and clicked, its effects run, and every save goes through the real client (`putSplits`) to a
 * scripted fetch, so the tests read the request as it would leave the browser.
 */

const NBSP = '\u00a0';
/**
 * Testing Library's `act` (React 18.3's `React.act` at run time). `@types/react` 18.2 does not declare `React.act`, so
 * Testing Library's declaration of it does not resolve; the type is given here.
 */
const act = testingLibraryAct as unknown as (callback: () => void | Promise<void>) => Promise<void>;
/** Lets every pending answer and state update settle inside `act`. */
const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
const LOAN = '6b4f8c7e-9d0a-4b12-8d34-d5e6f708192a';

const references: References = {
  accounts: { status: 'success', data: page([]) },
  properties: { status: 'success', data: page([property()]) },
  categories: {
    status: 'success',
    data: [
      category(),
      category({ code: 'RENT_OPERATING_COST_ADVANCE', name: 'Nebenkostenvorauszahlung' }),
      category({ code: 'LOAN_INTEREST', name: 'Darlehenszinsen', categoryType: 'FINANCING' }),
      category({ code: 'OLD_FEE', name: 'Alte Gebühr', active: false }),
    ],
  },
};

/** The stored set of `fillTwoRows`, as the backend answers it. */
const STORED = [
  split(),
  split({
    splitId: '7c5a9d8f-0e1b-4c23-9e45-e6f708192a3b',
    position: 2,
    amount: { amount: '150.00', currency: 'EUR' },
    financialCategoryCode: 'RENT_OPERATING_COST_ADVANCE',
    propertyReferenceId: null,
  }),
];

function answer(overrides: Partial<TransactionSplitsDto> = {}, splits = STORED): TransactionSplitsDto {
  return { transactionId: TX, amount: { amount: '850.00', currency: 'EUR' }, direction: 'INFLOW', status: 'CLASSIFIED', version: 4, splits, ...overrides };
}

interface Setup {
  readonly calls: Call[];
  readonly reload: ReturnType<typeof vi.fn<() => Promise<TransactionRead>>>;
  readonly onSaved: ReturnType<typeof vi.fn<(saved: SplitsSaved) => void>>;
  readonly onDraftChange: ReturnType<typeof vi.fn<(unsaved: boolean) => void>>;
  readonly unmount: () => void;
}

function setup(
  options: {
    transaction?: TransactionDetailDto;
    etag?: string | undefined;
    answers?: Parameters<typeof scriptedFetch>;
    reload?: () => Promise<TransactionRead>;
  } = {},
): Setup {
  const { fetch, calls } = scriptedFetch(...(options.answers ?? []));
  const de = createDeClient({ tokens: countingTokens(), realmId: REALM_A, fetch });
  const reload = vi.fn<() => Promise<TransactionRead>>(options.reload ?? (() => Promise.reject(new Error('no reload in this test'))));
  const onSaved = vi.fn<(saved: SplitsSaved) => void>();
  const onDraftChange = vi.fn<(unsaved: boolean) => void>();
  const view = render(
    <SplitEditor
      transaction={options.transaction ?? detail()}
      etag={'etag' in options ? options.etag : '"3"'}
      references={references}
      save={(body, ifMatch) => putSplits(de, TX, body, ifMatch)}
      reload={reload}
      onSaved={onSaved}
      onDraftChange={onDraftChange}
    />,
  );
  return { calls, reload, onSaved, onDraftChange, unmount: view.unmount };
}

const control = (id: string) => {
  const element = document.getElementById(id);
  if (element === null) throw new Error(`no control ${id}`);
  return element as HTMLInputElement & HTMLSelectElement;
};
const amount = (row: number) => control(`split-${row}-amount`);
const type = (element: HTMLElement, value: string) => fireEvent.change(element, { target: { value } });
const saveButton = () => screen.getByRole<HTMLButtonElement>('button', { name: /Aufteilung speichern|Wird gespeichert/ });
const form = () => screen.getByRole('form', { name: 'Aufteilung bearbeiten' });
const addButton = () => screen.getByRole<HTMLButtonElement>('button', { name: 'Teilbetrag hinzufügen' });
const sentBody = (call: Call | undefined) => JSON.parse(call?.body ?? 'null') as { splits: Record<string, unknown>[] };
const restText = () => screen.getByTestId('split-rest-amount').textContent;

/** Two rows over 850,00 €: Kaltmiete 700 on the object, Nebenkosten 150. */
function fillTwoRows(second = '150,00') {
  type(control('split-0-category'), 'RENT_BASE');
  type(amount(0), '700,00');
  type(control('split-0-reference'), 'property');
  type(control('split-0-property'), PROPERTY);
  fireEvent.click(addButton());
  type(control('split-1-category'), 'RENT_OPERATING_COST_ADVANCE');
  type(amount(1), second);
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('step 3, the exact sum (ui-guide.md §6.4: no rounding tolerance)', () => {
  it('save is enabled only when the amounts cover the Transaction to the cent', async () => {
    const { calls } = setup();
    fillTwoRows();
    expect(restText()).toBe(`0,00${NBSP}€`);
    expect(screen.getByText('Die Teilbeträge decken den Betrag der Buchung genau.')).toBeTruthy();
    expect(saveButton().disabled).toBe(false);

    type(amount(1), '149,99');
    expect(restText()).toBe(`0,01${NBSP}€`);
    expect(screen.getByText(/Noch nicht verteilt/)).toBeTruthy();
    expect(saveButton().disabled).toBe(true);

    type(amount(1), '150,01');
    expect(restText()).toBe(`0,01${NBSP}€ zu viel`);
    expect(screen.getByText(/Zu viel verteilt/)).toBeTruthy();
    expect(saveButton().disabled).toBe(true);
    fireEvent.submit(form());
    await settle();
    expect(calls).toHaveLength(0);
  });

  it('a fitting sum with a missing category is not saved', async () => {
    const { calls } = setup();
    type(amount(0), '850');
    expect(restText()).toBe(`0,00${NBSP}€`);
    expect(saveButton().disabled).toBe(true);
    expect(screen.getByText('Kategorie wählen.')).toBeTruthy();
    fireEvent.submit(form());
    await settle();
    expect(calls).toHaveLength(0);
  });

  it('beyond 2^53 cents: the rest is exact and the amounts are sent as typed', async () => {
    const big = detail({ amount: { amount: '999999999999999999.99', currency: 'EUR' } });
    const { calls } = setup({ transaction: big, answers: [json(200, answer({ amount: big.amount }), { etag: '"4"' })] });
    type(control('split-0-category'), 'RENT_BASE');
    type(amount(0), '999.999.999.999.999.000,00');
    expect(restText()).toBe(`999,99${NBSP}€`);
    fireEvent.click(addButton());
    type(control('split-1-category'), 'RENT_BASE');
    type(amount(1), '999,98');
    expect(restText()).toBe(`0,01${NBSP}€`);
    expect(saveButton().disabled).toBe(true);
    type(amount(1), '999,99');
    fireEvent.click(saveButton());
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(sentBody(calls[0]).splits.map((s) => s['amount'])).toEqual([
      { amount: '999999999999999000.00', currency: 'EUR' },
      { amount: '999.99', currency: 'EUR' },
    ]);
  });
});

describe('step 3, amount input (ui-guide.md §5.2)', () => {
  const cases: readonly (readonly [typed: string, message: string | undefined])[] = [
    ['1,5', undefined],
    ['1.234,56', undefined],
    ['  850,00  ', undefined],
    ['0,001', 'Höchstens zwei Nachkommastellen; es wird nicht gerundet.'],
    ['-850,00', 'Ein Teilbetrag ist nie negativ; die Richtung steht an der Buchung.'],
    ['', 'Betrag fehlt.'],
    ['   ', 'Betrag fehlt.'],
    ['1.234', 'Mehrdeutig: bitte mit Dezimalkomma schreiben, z. B. 1234,56 oder 1.234,56.'],
    ['850.00', 'Mehrdeutig: bitte mit Dezimalkomma schreiben, z. B. 1234,56 oder 1.234,56.'],
    ['8 50', 'Kein Betrag: Ziffern mit Dezimalkomma, z. B. 1.234,56.'],
  ];

  it('each typed form is read or named at its input, marked for assistive technology', () => {
    setup();
    for (const [typed, message] of cases) {
      type(amount(0), typed);
      const input = amount(0);
      if (message === undefined) {
        expect(input.getAttribute('aria-invalid'), typed).toBeNull();
      } else {
        expect(input.getAttribute('aria-invalid'), typed).toBe('true');
        expect(document.getElementById(input.getAttribute('aria-describedby') ?? '')?.textContent, typed).toBe(message);
      }
    }
  });

  it('a typed amount counts exactly as typed: 1.234,56 + 0,44 cover 1.235,00 and are sent as 1234.56 and 0.44', async () => {
    const t = detail({ amount: { amount: '1235.00', currency: 'EUR' } });
    const stored = [
      split({ amount: { amount: '1234.56', currency: 'EUR' } }),
      split({ position: 2, amount: { amount: '0.44', currency: 'EUR' }, propertyReferenceId: null }),
    ];
    const { calls } = setup({ transaction: t, answers: [json(200, answer({ amount: t.amount }, stored), { etag: '"4"' })] });
    type(control('split-0-category'), 'RENT_BASE');
    type(amount(0), ' 1.234,56');
    fireEvent.click(addButton());
    type(control('split-1-category'), 'RENT_BASE');
    type(amount(1), '0,44 ');
    expect(screen.getByTestId('split-sum').textContent).toBe(`1.235,00${NBSP}€`);
    fireEvent.click(saveButton());
    await screen.findByText(/Aufteilung gespeichert/);
    expect(sentBody(calls[0]).splits.map((s) => (s['amount'] as { amount: string }).amount)).toEqual(['1234.56', '0.44']);
    // The draft shows the stored set: the same amounts, no cent lost or added.
    expect([amount(0).value, amount(1).value]).toEqual(['1234,56', '0,44']);
    expect(screen.getByTestId('split-sum').textContent).toBe(`1.235,00${NBSP}€`);
  });
});

describe('step 3, 1 to 100 splits (api-design.md §33.2)', () => {
  it('one row cannot be removed; 100 rows offer no 101st', () => {
    setup();
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Teilbetrag 1 entfernen' }).disabled).toBe(true);
    const hundred = Array.from({ length: 100 }, (_, i) => split({ splitId: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, position: i + 1 }));
    cleanup();
    setup({ transaction: detail({ amount: { amount: '70000.00', currency: 'EUR' }, splits: hundred }) });
    expect(screen.getAllByRole('group')).toHaveLength(100);
    expect(addButton().disabled).toBe(true);
    expect(screen.getByText('Höchstens 100 Teilbeträge.')).toBeTruthy();
    fireEvent.click(addButton());
    expect(screen.getAllByRole('group')).toHaveLength(100);
    expect(saveButton().disabled).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Teilbetrag 100 entfernen' }));
    expect(addButton().disabled).toBe(false);
  });
});

describe('step 3, If-Match and the new ETag (ui-guide.md §7.3, §8)', () => {
  it('the first save sends the ETag of the detail; the next one the ETag of the answer', async () => {
    const { calls, onSaved } = setup({
      answers: [json(200, answer(), { etag: '"4"' }), json(200, answer({ version: 5 }), { etag: '"5"' })],
    });
    fillTwoRows();
    fireEvent.click(saveButton());
    await findSaved(/Aufteilung gespeichert \(Status/, 4);
    expect(calls[0]?.headers.get('if-match')).toBe('"3"');
    expect(onSaved).toHaveBeenCalledTimes(1);
    type(control('split-0-description'), 'Kaltmiete Maerz');
    fireEvent.click(saveButton());
    await findSaved(/Aufteilung gespeichert \(Status/, 5);
    expect(calls[1]?.headers.get('if-match')).toBe('"4"');
    expect(sentBody(calls[1]).splits[0]?.['description']).toBe('Kaltmiete Maerz');
  });

  it('without an ETag header the version of the detail is the tag', async () => {
    const { calls } = setup({ etag: undefined, transaction: detail({ version: 9 }), answers: [json(200, answer({ version: 10 }))] });
    fillTwoRows();
    fireEvent.click(saveButton());
    await findSaved(/Aufteilung gespeichert \(Status/, 10);
    expect(calls[0]?.headers.get('if-match')).toBe('"9"');
  });

  it('nothing of the detail but the input fields is sent: no split id, position, status or direction', async () => {
    const stored = detail({
      status: 'CLASSIFIED',
      splits: [split({ description: 'alt' }), split({ splitId: 'b', position: 2, amount: { amount: '150.00', currency: 'EUR' } })],
    });
    const { calls } = setup({ transaction: stored, answers: [json(200, answer(), { etag: '"4"' })] });
    expect(saveButton().disabled).toBe(false);
    fireEvent.click(saveButton());
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(sentBody(calls[0])).toEqual({
      splits: [
        { amount: { amount: '700.00', currency: 'EUR' }, financialCategoryCode: 'RENT_BASE', propertyReferenceId: PROPERTY, description: 'alt' },
        { amount: { amount: '150.00', currency: 'EUR' }, financialCategoryCode: 'RENT_BASE', propertyReferenceId: PROPERTY },
      ],
    });
  });
});

describe('step 3, 412 keeps the draft (ui-guide.md §7.3, §11)', () => {
  const server = detail({
    version: 5,
    description: 'inzwischen geaendert',
    splits: [split({ amount: { amount: '850.00', currency: 'EUR' }, financialCategoryCode: 'RENT_OPERATING_COST_ADVANCE' })],
  });

  it('shows the conflict, keeps every typed value and sends nothing by itself', async () => {
    const { calls, reload } = setup({ answers: [envelope(412, 'VERSION_CONFLICT', { expectedVersions: [3], currentVersion: 5 })] });
    fillTwoRows();
    type(control('split-1-description'), 'Entwurf');
    fireEvent.click(saveButton());
    const heading = await screen.findByRole('heading', { name: 'Inzwischen geändert' });
    expect(document.activeElement).toBe(heading);
    expect(screen.getByText(/auf dem Server jetzt Version 5/)).toBeTruthy();
    expect([amount(0).value, amount(1).value, control('split-1-description').value]).toEqual(['700,00', '150,00', 'Entwurf']);
    expect(saveButton().disabled).toBe(true);
    await settle();
    expect(calls).toHaveLength(1);
    expect(reload).not.toHaveBeenCalled();
  });

  it('keep the draft: the server state is read and shown, the next save goes with its ETag only on a new click', async () => {
    const { calls, reload } = setup({
      answers: [envelope(412, 'VERSION_CONFLICT', { expectedVersions: [3], currentVersion: 5 }), json(200, answer({ version: 6 }), { etag: '"6"' })],
      reload: () => Promise.resolve({ transaction: server, etag: '"5"' }),
    });
    fillTwoRows();
    fireEvent.click(saveButton());
    fireEvent.click(await screen.findByRole('button', { name: 'Entwurf behalten und Serverstand ansehen' }));
    const shown = await screen.findByRole('list', { name: 'Aufteilung auf dem Server' });
    expect(within(shown).getByText(/Nebenkostenvorauszahlung/)).toBeTruthy();
    expect(screen.getByText(/Aktueller Stand auf dem Server: Version 5/)).toBeTruthy();
    expect(reload).toHaveBeenCalledTimes(1);
    expect([amount(0).value, amount(1).value]).toEqual(['700,00', '150,00']);
    expect(calls).toHaveLength(1);
    fireEvent.click(saveButton());
    await findSaved(/Aufteilung gespeichert \(Status/, 6);
    expect(calls[1]?.headers.get('if-match')).toBe('"5"');
    expect(sentBody(calls[1]).splits).toHaveLength(2);
  });

  it('load the server state: the draft becomes the stored set and its ETag the base', async () => {
    const { calls } = setup({
      answers: [envelope(412, 'VERSION_CONFLICT', { expectedVersions: [3], currentVersion: 5 }), json(200, answer({ version: 6 }), { etag: '"6"' })],
      reload: () => Promise.resolve({ transaction: server, etag: '"5"' }),
    });
    fillTwoRows();
    fireEvent.click(saveButton());
    fireEvent.click(await screen.findByRole('button', { name: 'Serverstand laden (Entwurf verwerfen)' }));
    await waitFor(() => expect(screen.queryAllByRole('group')).toHaveLength(1));
    expect(amount(0).value).toBe('850,00');
    expect(control('split-0-category').value).toBe('RENT_OPERATING_COST_ADVANCE');
    expect(calls).toHaveLength(1);
    // The new base is the server's ETag: the next save sends it as If-Match (the header, not a text; Issue #352, point 3).
    expect(document.body.textContent).not.toMatch(/If-Match|ETag/);
    fireEvent.click(saveButton());
    await findSaved(/Aufteilung gespeichert \(Status/, 6);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.headers.get('if-match')).toBe('"5"');
  });

  it('a server state that no longer allows splits keeps the draft visible and offers no save', async () => {
    const confirmed = detail({ status: 'CONFIRMED', version: 5, splits: server.splits });
    const { calls } = setup({
      answers: [envelope(412, 'VERSION_CONFLICT', { currentVersion: 5 })],
      reload: () => Promise.resolve({ transaction: confirmed, etag: '"5"' }),
    });
    fillTwoRows();
    fireEvent.click(saveButton());
    fireEvent.click(await screen.findByRole('button', { name: 'Entwurf behalten und Serverstand ansehen' }));
    expect(await screen.findByText(/kann nicht mehr geändert werden/)).toBeTruthy();
    expect(amount(0).value).toBe('700,00');
    expect(saveButton().disabled).toBe(true);
    fireEvent.submit(form());
    await settle();
    expect(calls).toHaveLength(1);
  });

  it('a failed read keeps the draft and offers to read again', async () => {
    setup({
      answers: [envelope(412, 'VERSION_CONFLICT', { currentVersion: 5 })],
      reload: () => Promise.reject(new Error('read failed')),
    });
    fillTwoRows();
    fireEvent.click(saveButton());
    fireEvent.click(await screen.findByRole('button', { name: 'Entwurf behalten und Serverstand ansehen' }));
    expect(await screen.findByRole('button', { name: 'Erneut lesen' })).toBeTruthy();
    expect(screen.getByText(/Ihr Entwurf ist erhalten/)).toBeTruthy();
    expect(amount(0).value).toBe('700,00');
  });
});

describe('step 3, refusals (ui-guide.md §7.4)', () => {
  it('field errors are bound to the inputs their dotted name points at; the summary names all of them', async () => {
    const fields = [
      { field: 'splits.1.amount.amount', code: 'SCALE_EXCEEDED' },
      { field: 'splits.1.amount', code: 'INVALID_FORMAT' },
      { field: 'splits.0.zzz', code: 'INVALID_FORMAT' },
      { field: '(body)', code: 'INVALID_FORMAT' },
    ];
    setup({ answers: [envelope(400, 'VALIDATION_ERROR', { fields })] });
    fillTwoRows();
    fireEvent.click(saveButton());
    const summary = await screen.findByRole('list', { name: 'Abgelehnte Angaben' });
    expect(
      within(summary)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual([
      'splits.1.amount.amount: zu viele Nachkommastellen',
      'splits.1.amount: ungültig oder nicht vorgesehen',
      'splits.0.zzz: ungültig oder nicht vorgesehen',
      'Anfrageinhalt: ungültig oder nicht vorgesehen',
    ]);
    const input = amount(1);
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(document.getElementById(input.getAttribute('aria-describedby') ?? '')?.textContent).toBe(
      'Vom Server abgelehnt: zu viele Nachkommastellen Vom Server abgelehnt: ungültig oder nicht vorgesehen',
    );
    expect(amount(0).getAttribute('aria-invalid')).toBeNull();
    expect(document.activeElement).toBe(input);
    // A refusal is no lost answer: nothing to send again.
    expect(screen.queryByRole('button', { name: 'Erneut senden' })).toBeNull();
    // A new row moves the indices the errors name: the refusal is cleared, nothing stays bound to a wrong input.
    fireEvent.click(addButton());
    expect(screen.queryByRole('list', { name: 'Abgelehnte Angaben' })).toBeNull();
    expect(amount(1).getAttribute('aria-invalid')).toBeNull();
  });

  it('an unknown code and an unknown reason are still shown as text, never an empty state', async () => {
    setup({ answers: [envelope(409, 'SOMETHING_NEW', { reason: 'NEW_REASON' }), envelope(418, 'TEAPOT')] });
    fillTwoRows();
    fireEvent.click(saveButton());
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Code SOMETHING_NEW');
    expect(alert.textContent).toContain('Grund NEW_REASON.');
    fireEvent.click(saveButton());
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('HTTP 418, Code TEAPOT.'));
  });

  it('a frozen Transaction is explained by its reason', async () => {
    setup({ answers: [envelope(409, 'CONFLICT', { reason: 'TRANSACTION_FROZEN', status: 'CONFIRMED' })] });
    fillTwoRows();
    fireEvent.click(saveButton());
    expect((await screen.findByRole('alert')).textContent).toContain('ihre Aufteilung ist eingefroren');
  });
});

describe('step 3, double click and lost answers (ui-guide.md §7.3, §11, §12 point 5)', () => {
  it('a double click and a double submit send one request', async () => {
    let resolve: (response: Response) => void = () => undefined;
    const { calls } = setup({ answers: [() => new Promise<Response>((r) => (resolve = r))] });
    fillTwoRows();
    fireEvent.click(saveButton());
    fireEvent.click(saveButton());
    fireEvent.submit(form());
    fireEvent.submit(form());
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(saveButton().textContent).toBe('Wird gespeichert …');
    resolve(json(200, answer(), { etag: '"4"' }));
    await settle();
    await screen.findByText(/Aufteilung gespeichert/);
    expect(calls).toHaveLength(1);
  });

  it('two clicks before React renders again still send one request', async () => {
    let resolve: (response: Response) => void = () => undefined;
    const { calls } = setup({ answers: [() => new Promise<Response>((r) => (resolve = r))] });
    fillTwoRows();
    await act(() => {
      fireEvent.click(saveButton());
      fireEvent.click(saveButton());
    });
    await waitFor(() => expect(calls).toHaveLength(1));
    resolve(json(200, answer(), { etag: '"4"' }));
    await settle();
    await screen.findByText(/Aufteilung gespeichert/);
    expect(calls).toHaveLength(1);
  });

  it('no answer: the same set is sent again with the same If-Match, no new intent, no Idempotency-Key', async () => {
    const { calls } = setup({ answers: [new TypeError('network down'), json(200, answer(), { etag: '"4"' })] });
    fillTwoRows();
    fireEvent.click(saveButton());
    expect((await screen.findByRole('alert')).textContent).toContain('Ob die Anfrage ausgeführt wurde, ist unklar.');
    fireEvent.click(screen.getByRole('button', { name: 'Erneut senden' }));
    await screen.findByText(/Aufteilung gespeichert/);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.body).toBe(calls[0]?.body);
    expect(calls[1]?.headers.get('if-match')).toBe(calls[0]?.headers.get('if-match'));
    expect(calls.map((call) => call.headers.has('idempotency-key'))).toEqual([false, false]);
  });

  it('once the draft changes, "Erneut senden" is gone: the old set is no longer the intent', async () => {
    setup({ answers: [new TypeError('network down')] });
    fillTwoRows();
    fireEvent.click(saveButton());
    await screen.findByRole('button', { name: 'Erneut senden' });
    type(amount(1), '149,99');
    expect(screen.queryByRole('button', { name: 'Erneut senden' })).toBeNull();
  });

  it('an answer after the editor is gone (Realm switch, navigation) changes nothing', async () => {
    let resolve: (response: Response) => void = () => undefined;
    const { calls, onSaved, unmount } = setup({ answers: [() => new Promise<Response>((r) => (resolve = r))] });
    const errors = vi.spyOn(console, 'error');
    fillTwoRows();
    fireEvent.click(saveButton());
    await waitFor(() => expect(calls).toHaveLength(1));
    unmount();
    resolve(json(200, answer(), { etag: '"4"' }));
    await settle();
    expect(onSaved).not.toHaveBeenCalled();
    expect(errors).not.toHaveBeenCalled();
  });
});

describe('step 3, references (ui-guide.md §6.4)', () => {
  it('a new row offers no reference the backend refuses, and an object only from the list', () => {
    setup();
    const kinds = [...control('split-0-reference').options].map((option) => option.text);
    expect(kinds).toEqual(['Kein Bezug', 'Objekt']);
    const page = document.body.textContent ?? '';
    for (const refused of ['wegId', 'rentalContractReferenceId', 'maintenanceProjectId', 'acquisitionId', 'taxClassificationId', 'Mietvertrag', 'Erwerb']) {
      expect(page).not.toContain(refused);
    }
    type(control('split-0-reference'), 'property');
    expect([...control('split-0-property').options].map((option) => option.text)).toEqual(['Objekt wählen', 'Testhaus Wohnung 1']);
    const categories = [...control('split-0-category').options].map((option) => option.text);
    expect(categories).toEqual(['Kategorie wählen', 'Kaltmiete', 'Nebenkostenvorauszahlung', 'Darlehenszinsen']);
  });

  it('a stored Loan reference is kept as it is, and switching to an object drops it from the request', async () => {
    const stored = detail({
      direction: 'OUTFLOW',
      status: 'CLASSIFIED',
      splits: [split({ amount: { amount: '850.00', currency: 'EUR' }, financialCategoryCode: 'LOAN_INTEREST', propertyReferenceId: null, loanId: LOAN })],
    });
    const { calls } = setup({ transaction: stored, answers: [json(200, answer(), { etag: '"4"' }), json(200, answer({ version: 5 }), { etag: '"5"' })] });
    expect(control('split-0-reference').value).toBe('loan');
    expect(screen.getByText(LOAN)).toBeTruthy();
    fireEvent.click(saveButton());
    await findSaved(/Aufteilung gespeichert \(Status/, 4);
    expect(sentBody(calls[0]).splits[0]).toEqual({ amount: { amount: '850.00', currency: 'EUR' }, financialCategoryCode: 'LOAN_INTEREST', loanId: LOAN });
  });

  it('switching a kept Loan reference to an object removes the loanId', async () => {
    const stored = detail({ splits: [split({ amount: { amount: '850.00', currency: 'EUR' }, propertyReferenceId: null, loanId: LOAN })] });
    const { calls } = setup({ transaction: stored, answers: [json(200, answer(), { etag: '"4"' })] });
    type(control('split-0-reference'), 'property');
    expect(saveButton().disabled).toBe(true);
    type(control('split-0-property'), PROPERTY);
    fireEvent.click(saveButton());
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(sentBody(calls[0]).splits[0]).toEqual({
      amount: { amount: '850.00', currency: 'EUR' },
      financialCategoryCode: 'RENT_BASE',
      propertyReferenceId: PROPERTY,
    });
  });
});

describe('the unsaved draft and Entwurf verwerfen (Entscheidung des Projektinhabers, 2026-11-11)', () => {
  const stored = () => detail({ status: 'CLASSIFIED', version: 3, splits: STORED });
  const last = (mock: Setup['onDraftChange']) => mock.mock.calls.at(-1)?.[0];

  it('reports a clean draft, a change, and the change typed back; Entwurf verwerfen only while it differs', () => {
    const { onDraftChange } = setup({ transaction: stored(), etag: '"3"' });
    expect(last(onDraftChange)).toBe(false);
    expect(screen.queryByRole('button', { name: 'Entwurf verwerfen' })).toBeNull();
    fireEvent.change(document.getElementById('split-0-amount') as HTMLInputElement, { target: { value: '650,00' } });
    expect(last(onDraftChange)).toBe(true);
    expect(screen.getByRole('button', { name: 'Entwurf verwerfen' })).toBeTruthy();
    fireEvent.change(document.getElementById('split-0-amount') as HTMLInputElement, { target: { value: '700' } });
    expect(last(onDraftChange)).toBe(false);
    expect(screen.queryByRole('button', { name: 'Entwurf verwerfen' })).toBeNull();
  });

  it('Entwurf verwerfen restores the stored set row for row, clears a refusal and sends nothing', async () => {
    const { calls, onDraftChange } = setup({ transaction: stored(), etag: '"3"', answers: [envelope(409, 'CONFLICT', { reason: 'SPLIT_SUM_MISMATCH' })] });
    fireEvent.change(document.getElementById('split-0-amount') as HTMLInputElement, { target: { value: '600,00' } });
    fireEvent.change(document.getElementById('split-1-amount') as HTMLInputElement, { target: { value: '250,00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Teilbetrag hinzufügen' }));
    fireEvent.click(screen.getByRole('button', { name: 'Teilbetrag 3 entfernen' }));
    fireEvent.click(screen.getByRole('button', { name: 'Aufteilung speichern' }));
    await settle();
    expect(screen.getByRole('alert')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Entwurf verwerfen' }));
    expect(['split-0-amount', 'split-1-amount'].map((id) => (document.getElementById(id) as HTMLInputElement).value)).toEqual(['700,00', '150,00']);
    expect(document.getElementById('split-2-amount')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(last(onDraftChange)).toBe(false);
    expect(calls.filter((call) => call.method === 'PUT')).toHaveLength(1);
  });

  it('a save makes the draft the stored set (clean); leaving the editor reports clean', async () => {
    const { onDraftChange, unmount } = setup({
      transaction: stored(),
      etag: '"3"',
      answers: [
        json(
          200,
          answer(
            { version: 4 },
            STORED.map((s, i) => (i === 0 ? { ...s, amount: { amount: '600.00', currency: 'EUR' } } : { ...s, amount: { amount: '250.00', currency: 'EUR' } })),
          ),
          { etag: '"4"' },
        ),
      ],
    });
    fireEvent.change(document.getElementById('split-0-amount') as HTMLInputElement, { target: { value: '600,00' } });
    fireEvent.change(document.getElementById('split-1-amount') as HTMLInputElement, { target: { value: '250,00' } });
    expect(last(onDraftChange)).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Aufteilung speichern' }));
    await findSaved(/Aufteilung gespeichert \(Status/, 4);
    expect(last(onDraftChange)).toBe(false);
    fireEvent.change(document.getElementById('split-0-amount') as HTMLInputElement, { target: { value: '1,00' } });
    expect(last(onDraftChange)).toBe(true);
    unmount();
    expect(last(onDraftChange)).toBe(false);
  });
});
