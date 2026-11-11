// @vitest-environment jsdom
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { REALM_A } from '../transactions/fixtures.test-support';
import { click, commands, go, openApp, release, requests, reverseBooking, twice, useDurchstich } from './walk.test-support';

/**
 * „Stornieren“ in the Durchstich (Entscheidung des Projektinhabers, 2026-11-11; api-design.md §35.9): against the whole
 * App and the stateful fake backend, which checks the body with the route's own schema (`reverseBody`), `If-Match` and
 * the `Idempotency-Key` in the route's own scope. The confirmed booking is seeded (`seedRent`); durchstich.test.tsx
 * walks the steps before it.
 */

const backend = useDurchstich();
const json = (body: string | undefined) => (body === undefined ? null : (JSON.parse(body) as unknown));

describe('„Stornieren“ in the Durchstich (§35.9)', () => {
  it('a confirmed booking is reversed: one request, the original CORRECTED with no replacement, the chain on the page', async () => {
    const t = backend().seedRent('CONFIRMED');
    const before = backend().transactions.size;
    await openApp(backend(), `/cockpit/r/${REALM_A}/buchungen/${t.id}`);
    await reverseBooking('Doppelt erfasst', twice);
    await screen.findByRole('heading', { name: 'Storno ausgeführt' });
    expect([t.status, t.version, t.replacementTransactionId]).toEqual(['CORRECTED', 4, null]);
    expect(t.description).toBe('Miete Oktober Testwohnung');
    const chain = [...backend().transactions.values()].filter((x) => x.correctionOfTransactionId === t.id);
    expect(chain.map((x) => [x.correctionRole, x.direction, x.amount.toJSON().amount, x.status])).toEqual([['REVERSAL', 'OUTFLOW', '850.00', 'CONFIRMED']]);
    expect(t.reversalTransactionId).toBe(chain[0]?.id);
    expect(backend().transactions.size).toBe(before + 1);
    const sent = requests(backend(), 'POST', `/api/v1/transactions/${t.id}/reverse`);
    expect(commands(backend())).toEqual([`POST /api/v1/transactions/${t.id}/reverse`]);
    expect(json(sent[0]?.body)).toEqual({ reason: 'Doppelt erfasst' });
    expect(sent[0]?.headers.get('if-match')).toBe('"3"');
    expect(sent[0]?.headers.get('idempotency-key')).toMatch(/^[\x21-\x7e]{1,255}$/);
    // The page reads the booking again: CORRECTED, linked to its reversal, nothing to correct or reverse any more.
    const links = within(await screen.findByRole('region', { name: 'Korrekturen' }));
    await waitFor(() => expect(links.getAllByRole('link').map((a) => a.textContent)).toEqual(['Storno dieser Buchung']));
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Korrektur erfassen' }).disabled).toBe(true);
    // The reversal itself is offered neither for correction nor for reversal.
    fireEvent.click(links.getByRole('link'), { button: 0 });
    await screen.findByText(/Storno zur/);
    expect(screen.queryByRole('button', { name: 'Stornieren' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Korrektur erfassen' })).toBeNull();
    expect(commands(backend())).toHaveLength(1);
  });

  it('a lost answer: Erneut senden repeats body, If-Match and key; the server answers the stored reversal, one reversal only', async () => {
    const t = backend().seedRent('CONFIRMED');
    backend().fault(`POST /api/v1/transactions/${t.id}/reverse`, { lose: true });
    await openApp(backend(), `/cockpit/r/${REALM_A}/buchungen/${t.id}`);
    await reverseBooking();
    expect(await screen.findByText(/Ob das Storno ausgeführt wurde, ist unklar/)).toBeTruthy();
    expect(t.status).toBe('CORRECTED');
    click('Erneut senden');
    await screen.findByRole('heading', { name: 'Storno ausgeführt' });
    const sent = requests(backend(), 'POST', `/api/v1/transactions/${t.id}/reverse`);
    expect(sent.map((s) => s.headers.get('idempotency-key'))).toEqual([0, 1].map(() => sent[0]?.headers.get('idempotency-key')));
    expect(sent.map((s) => s.headers.get('if-match'))).toEqual(['"3"', '"3"']);
    expect(sent[1]?.body).toBe(sent[0]?.body);
    expect([...backend().transactions.values()].filter((x) => x.correctionOfTransactionId === t.id)).toHaveLength(1);
  });

  it('TRANSACTION_RENT_RECONCILED: refused and explained, the link opens the match; after the release the reversal goes through', async () => {
    const t = backend().seedRent('CONFIRMED');
    const r = backend().seedReconciliation(t, { status: 'CONFIRMED', version: 2 });
    const detail = `/cockpit/r/${REALM_A}/buchungen/${t.id}`;
    await openApp(backend(), detail);
    await reverseBooking();
    expect(await screen.findByText(/Solange er besteht, kann sie nicht storniert werden/)).toBeTruthy();
    expect(screen.getByText(/danach ist das Storno möglich/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Erneut senden' })).toBeNull();
    expect([t.status, r.status]).toEqual(['CONFIRMED', 'CONFIRMED']);
    expect(commands(backend())).toEqual([`POST /api/v1/transactions/${t.id}/reverse`]);
    fireEvent.click(screen.getByRole('link', { name: 'Mietzuordnung öffnen und aufheben' }), { button: 0 });
    await release('Doppelt gebuchte Zahlung');
    await screen.findByText('MRE: nicht übertragen');
    await go(detail);
    await reverseBooking();
    await screen.findByRole('heading', { name: 'Storno ausgeführt' });
    expect([t.status, r.status]).toEqual(['CORRECTED', 'RELEASED']);
    expect(commands(backend())).toEqual([
      `POST /api/v1/transactions/${t.id}/reverse`,
      `POST /api/v1/rent-reconciliations/${r.id}/release`,
      `POST /api/v1/transactions/${t.id}/reverse`,
    ]);
    const keys = requests(backend(), 'POST', `/api/v1/transactions/${t.id}/reverse`).map((s) => s.headers.get('idempotency-key'));
    expect(new Set(keys).size).toBe(2);
    expect(backend().counters.mreWrites).toBe(0);
  });
});
