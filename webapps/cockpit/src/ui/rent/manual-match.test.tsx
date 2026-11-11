// @vitest-environment jsdom
import { act as testingLibraryAct, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDeClient } from '../../api/client';
import { countingTokens, envelope, json, scriptedFetch, type Call } from '../../api/fetch.test-support';
import { createReconciliation, type TransactionRentCoverageDto } from '../../api/rent-reconciliations';
import { confirmed, TENANT, TERM, transactionCoverage } from '../../rent/fixtures.test-support';
import { REALM_A, REALM_B, TX } from '../../transactions/fixtures.test-support';
import { TransactionRentSection } from './TransactionRent';

/**
 * Step 8, „Manuell zuordnen“ (Entscheidung des Projektinhabers, 2026-11-11; api-design.md §37.1; ui-guide.md §6.6):
 * its own action in the booking's rent section, with a confirmation step; the real client to a scripted fetch,
 * `fireEvent` only, synthetic ids and amounts only.
 */

const act = testingLibraryAct as unknown as (callback: () => void | Promise<void>) => Promise<void>;
const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
const EUR = (amount: string) => ({ amount, currency: 'EUR' });
const FREE = transactionCoverage({ matchedTotal: EUR('0.00'), available: EUR('850.00'), reconciliations: [] });
const created = (amount = '850.00', overrides = {}) => confirmed(amount, { confidence: null, suggestionReason: null, version: 1, ...overrides });

function setup(options: { coverage?: TransactionRentCoverageDto; answers?: Parameters<typeof scriptedFetch>; realm?: string } = {}) {
  const { fetch, calls } = scriptedFetch(...(options.answers ?? []));
  const de = createDeClient({ tokens: countingTokens(), realmId: options.realm ?? REALM_A, fetch });
  const onCreated = vi.fn();
  const view = render(
    <TransactionRentSection
      realmId={REALM_A}
      coverage={{ status: 'success', data: options.coverage ?? FREE }}
      onRetry={() => undefined}
      create={(body, k) => createReconciliation(de, body, k)}
      onCreated={onCreated}
    />,
  );
  return { calls, onCreated, view };
}

const type = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
const click = (name: string | RegExp) => fireEvent.click(screen.getByRole('button', { name }));
const button = (name: string | RegExp) => screen.getByRole<HTMLButtonElement>('button', { name });
const posts = (calls: readonly Call[]) => calls.filter((call) => call.method === 'POST');

function fill(amount?: string) {
  click('Manuell zuordnen');
  type('Mieter in MRE (ID)', TENANT);
  type('Miettermin (MRE-Schlüssel JJJJMMTTHH)', TERM);
  if (amount !== undefined) type('Zuzuordnender Betrag (€)', amount);
}

afterEach(cleanup);

describe('Manuell zuordnen: its own action with a confirmation step', () => {
  it('opening sends nothing; the amount starts at the free rent cash; Abbrechen sends nothing and keeps the input', async () => {
    const { calls } = setup();
    fill();
    expect(screen.getByLabelText<HTMLInputElement>('Zuzuordnender Betrag (€)').value).toBe('850,00');
    click('Zuordnung anlegen');
    const dialog = screen.getByRole('dialog', { name: 'Zahlung jetzt manuell zuordnen?' });
    expect(dialog.textContent).toContain('An MRE wird nichts übertragen');
    expect(dialog.textContent).toContain(TENANT);
    expect(document.activeElement?.textContent).toBe('Zahlung jetzt manuell zuordnen?');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Abbrechen' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByLabelText<HTMLInputElement>('Mieter in MRE (ID)').value).toBe(TENANT);
    await settle();
    expect(calls).toHaveLength(0);
  });

  it('a partial match: the amount lowered, one request with exactly the body and a key, the answer shown, nothing to MRE', async () => {
    const { calls, onCreated } = setup({ answers: [json(201, created('800.00'), { etag: '"1"' })] });
    fill('800,00');
    click('Zuordnung anlegen');
    click('Jetzt zuordnen');
    await screen.findByText(/Manuell zugeordnet/);
    expect(posts(calls)).toHaveLength(1);
    expect(calls[0]?.url).toBe('/api/v1/rent-reconciliations');
    expect(JSON.parse(calls[0]?.body ?? 'null')).toEqual({ transactionId: TX, mreTenantId: TENANT, mreRentTerm: TERM, matchedAmount: EUR('800.00') });
    expect(calls[0]?.headers.get('idempotency-key')).toMatch(/^[\x21-\x7e]{1,255}$/);
    expect(calls[0]?.headers.has('if-match')).toBe(false);
    expect(screen.getByRole('status').textContent).toContain('An MRE wurde nichts übertragen');
    expect(screen.getByText('Zuordnung bestätigt')).toBeTruthy();
    expect(screen.getByText('MRE: nicht übertragen')).toBeTruthy();
    expect(onCreated).toHaveBeenCalledTimes(1);
  });

  it('a double click on Jetzt zuordnen sends one request', async () => {
    const { calls } = setup({ answers: [json(201, created())] });
    fill();
    click('Zuordnung anlegen');
    await act(() => {
      click('Jetzt zuordnen');
      fireEvent.click(screen.getByRole('button', { name: /Jetzt zuordnen|Wird zugeordnet/ }));
    });
    await screen.findByText(/Manuell zugeordnet/);
    expect(posts(calls)).toHaveLength(1);
  });

  it('a lost answer: Erneut senden sends the same body with the same key; a changed amount is a new intent', async () => {
    const lost = () => Promise.reject(new TypeError('Failed to fetch'));
    const { calls } = setup({ answers: [lost, lost, json(201, created('700.00'))] });
    fill();
    click('Zuordnung anlegen');
    click('Jetzt zuordnen');
    await screen.findByText(/Ob die Zuordnung angelegt wurde, ist unklar/);
    click('Erneut senden');
    await screen.findByText(/Ob die Zuordnung angelegt wurde, ist unklar/);
    expect(posts(calls).map((call) => call.body)).toEqual([calls[0]?.body, calls[0]?.body]);
    const [first, second] = posts(calls).map((call) => call.headers.get('idempotency-key'));
    expect(second).toBe(first);
    type('Zuzuordnender Betrag (€)', '700,00');
    expect(screen.queryByRole('button', { name: 'Erneut senden' })).toBeNull();
    click('Zuordnung anlegen');
    click('Jetzt zuordnen');
    await screen.findByText(/Manuell zugeordnet/);
    expect(posts(calls)[2]?.headers.get('idempotency-key')).not.toBe(first);
  });

  it('wrong input is said at the field and opens no step: no id, a name, a bad term, zero and more than free', async () => {
    const { calls } = setup();
    click('Manuell zuordnen');
    type('Mieter in MRE (ID)', 'Erika Beispiel');
    type('Miettermin (MRE-Schlüssel JJJJMMTTHH)', '2026-10');
    type('Zuzuordnender Betrag (€)', '850,01');
    click('Zuordnung anlegen');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByText('Eine MRE-ID hat 24 Zeichen 0–9 und a–f (Kleinbuchstaben).')).toBeTruthy();
    expect(screen.getByText(/Ein Miettermin ist der MRE-Schlüssel/)).toBeTruthy();
    expect(screen.getByText('Mehr als der noch freie Mietanteil der Buchung.')).toBeTruthy();
    expect(screen.getByLabelText('Zuzuordnender Betrag (€)').getAttribute('aria-describedby')?.split(' ')).toEqual([
      'zuordnen-betrag-frei',
      'zuordnen-betrag-hinweis',
    ]);
    type('Zuzuordnender Betrag (€)', '0,00');
    expect(screen.getByText('Der Betrag muss größer als 0,00 € sein.')).toBeTruthy();
    await settle();
    expect(calls).toHaveLength(0);
  });

  it('refusals are said in German with what to do; the input stays', async () => {
    const answers: Parameters<typeof scriptedFetch> = [
      envelope(409, 'CONFLICT', { reason: 'RENT_CASH_EXCEEDED', rentCash: EUR('850.00'), available: EUR('50.00') }),
      envelope(409, 'CONFLICT', { reason: 'ALREADY_MATCHED', reconciliationId: '8d6b0e9f-1a2c-4d34-8f56-f708192a3b4c' }),
      envelope(422, 'MRE_RENT_TERM_NOT_FOUND', { mreTenantId: TENANT, mreRentTerm: TERM }),
      envelope(409, 'CONFLICT', { reason: 'TRANSACTION_NOT_COUNTED', status: 'CLASSIFIED', correctionRole: null }),
      envelope(422, 'NO_RENT_CASH'),
      envelope(400, 'VALIDATION_ERROR', { fields: [{ field: 'mreRentTerm', code: 'INVALID_TERM' }] }),
    ];
    const texts = [
      /Der Betrag übersteigt den noch freien Mietanteil der Buchung \(frei: 50,00 €\)/,
      /Diese Buchung ist diesem Termin schon zugeordnet/,
      /MRE hat diesen Mietertermin nicht geliefert/,
      /Die Buchung ist nicht \(mehr\) bestätigt/,
      /keinen Anteil in einer Mietkategorie/,
      /Vom Server abgelehnt/,
    ];
    const { calls } = setup({ answers });
    fill();
    for (const text of texts) {
      click('Zuordnung anlegen');
      click('Jetzt zuordnen');
      await screen.findByText(text);
      expect(screen.queryByRole('button', { name: 'Erneut senden' })).toBeNull();
      expect(screen.getByLabelText<HTMLInputElement>('Mieter in MRE (ID)').value).toBe(TENANT);
    }
    expect(screen.getByLabelText('Miettermin (MRE-Schlüssel JJJJMMTTHH)').getAttribute('aria-invalid')).toBe('true');
    expect(posts(calls)).toHaveLength(6);
  });

  it('realm isolation: an answer of another Realm is not shown as a match', async () => {
    setup({ answers: [json(201, created('850.00', { mreRealmId: REALM_B }))] });
    fill();
    click('Zuordnung anlegen');
    click('Jetzt zuordnen');
    await screen.findByText('Antwort eines anderen Bestands');
    expect(screen.queryByText(/Manuell zugeordnet/)).toBeNull();
  });

  it('not offered without free rent cash, before the booking counts, or for an outflow', () => {
    for (const coverage of [
      transactionCoverage({ available: EUR('0.00') }),
      transactionCoverage({ status: 'CLASSIFIED', counted: false, available: null }),
      transactionCoverage({ direction: 'OUTFLOW' }),
      transactionCoverage({ rentCash: null, available: null }),
    ]) {
      setup({ coverage });
      expect(screen.queryByRole('button', { name: 'Manuell zuordnen' })).toBeNull();
      cleanup();
    }
  });
});

describe('Manuell zuordnen: waits for a fresh read after the match', () => {
  it('Weitere Zuordnung erfassen offers the form again with the free cash read now', async () => {
    const { view } = setup({ answers: [json(201, created('800.00'))] });
    fill('800,00');
    click('Zuordnung anlegen');
    click('Jetzt zuordnen');
    await screen.findByText(/Manuell zugeordnet/);
    view.rerender(
      <TransactionRentSection
        realmId={REALM_A}
        coverage={{ status: 'success', data: transactionCoverage({ available: EUR('50.00') }) }}
        onRetry={() => undefined}
        create={() => Promise.reject(new Error('not sent'))}
      />,
    );
    click('Weitere Zuordnung erfassen');
    await waitFor(() => expect(button('Zuordnung anlegen')).toBeTruthy());
    expect(screen.getByText(/Noch frei:/).textContent).toContain('50,00');
    expect(screen.getByLabelText<HTMLInputElement>('Zuzuordnender Betrag (€)').value).toBe('50,00');
    expect(screen.getByLabelText<HTMLInputElement>('Mieter in MRE (ID)').value).toBe(TENANT);
  });
});
