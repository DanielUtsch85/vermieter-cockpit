// @vitest-environment jsdom
import { act as testingLibraryAct, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDeClient } from '../../api/client';
import { countingTokens, envelope, json, scriptedFetch, type Call } from '../../api/fetch.test-support';
import { releaseReconciliation, removeFromMre, writeBackToMre, type RentReconciliationDto } from '../../api/rent-reconciliations';
import { confirmed, REC, REC_2, released, written } from '../../rent/fixtures.test-support';
import { MIN_WAIT_SECONDS } from '../../rent/reconciliation-rules';
import { REALM_A } from '../../transactions/fixtures.test-support';
import { MreActions } from './MreActions';

/**
 * Step 6, „An MRE übertragen“, „Zuordnung aufheben“ and „Aus MRE entfernen“ (jsdom, `fireEvent` only, the real client to
 * a scripted fetch): three separate clicks, each offered only in its state, never sent by rendering, and a concurrent
 * write answered by waiting and reading again, never by a retry loop (ui-guide.md §6.6, §11).
 */

const act = testingLibraryAct as unknown as (callback: () => void | Promise<void>) => Promise<void>;
const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
const NOW = Date.parse('2026-03-06T10:00:00.000Z');

function setup(options: { r?: RentReconciliationDto; answers?: Parameters<typeof scriptedFetch>; stale?: boolean } = {}) {
  const { fetch, calls } = scriptedFetch(...(options.answers ?? []));
  const de = createDeClient({ tokens: countingTokens(), realmId: REALM_A, fetch });
  const onChanged = vi.fn<() => void>();
  const reload = vi.fn<() => void>();
  const view = (r: RentReconciliationDto, stale: boolean) => (
    <MreActions
      realmId={REALM_A}
      reconciliation={r}
      etag={`"${r.version}"`}
      stale={stale}
      writeBack={(ifMatch) => writeBackToMre(de, REC, ifMatch)}
      release={(reason, ifMatch) => releaseReconciliation(de, REC, reason, ifMatch)}
      remove={(ifMatch) => removeFromMre(de, REC, ifMatch)}
      onChanged={onChanged}
      reload={reload}
      now={() => NOW}
    />
  );
  const rendered = render(view(options.r ?? confirmed(), options.stale ?? false));
  return { calls, onChanged, reload, unmount: rendered.unmount, rerender: (r: RentReconciliationDto, stale = false) => rendered.rerender(view(r, stale)) };
}

const button = (name: string) => screen.queryByRole<HTMLButtonElement>('button', { name });
const writeBack = () => screen.getByRole<HTMLButtonElement>('button', { name: /An MRE übertragen|Wird übertragen/ });
const buttons = () => screen.queryAllByRole('button').map((b) => b.textContent);
const posts = (calls: readonly Call[]) => calls.filter((call) => call.method === 'POST');

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('step 6, An MRE uebertragen (ui-guide.md §6.6 step 7; api-design.md §37.4)', () => {
  it('nothing is sent by rendering or rendering again; only the click sends one POST without a body, with If-Match', async () => {
    const { calls, rerender, onChanged } = setup({ answers: [json(200, written(), { etag: '"4"' })] });
    rerender(confirmed());
    rerender(confirmed(), true);
    rerender(confirmed());
    await settle();
    expect(calls).toHaveLength(0);
    fireEvent.click(writeBack());
    fireEvent.click(writeBack());
    await settle();
    expect(posts(calls)).toHaveLength(1);
    expect(calls[0]?.url).toBe(`/api/v1/rent-reconciliations/${REC}/write-back-to-mre`);
    expect(calls[0]?.body).toBeUndefined();
    expect(calls[0]?.headers.get('if-match')).toBe('"2"');
    expect(calls[0]?.headers.has('idempotency-key')).toBe(false);
    expect(screen.getByRole('status').textContent).toContain('An MRE übertragen: die Zahlung steht jetzt im Termin in MRE.');
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it('two clicks in one event batch, before the button is disabled, still send one request', async () => {
    const { calls } = setup({ answers: [json(200, written())] });
    const target = writeBack();
    await act(() => {
      fireEvent.click(target);
      fireEvent.click(target);
    });
    await settle();
    expect(posts(calls)).toHaveLength(1);
  });

  it('offered only for a confirmed match that is not written, failed, or whose attempt expired', () => {
    const offered = (r: RentReconciliationDto) => {
      const { unmount } = setup({ r });
      const shown = button('An MRE übertragen') !== null;
      unmount();
      return shown;
    };
    expect(offered(confirmed())).toBe(true);
    expect(offered(confirmed('850.00', { mreWriteBackState: 'FAILED', mreWriteBackError: 'MRE_UNAVAILABLE' }))).toBe(true);
    expect(offered(confirmed('850.00', { mreWriteBackState: 'PENDING', mreWriteBackLeaseUntil: '2026-03-06T09:00:00.000Z' }))).toBe(true);
    expect(offered(confirmed('850.00', { mreWriteBackState: 'PENDING', mreWriteBackLeaseUntil: '2026-03-06T10:01:00.000Z' }))).toBe(false);
    expect(offered(written())).toBe(false);
    expect(offered(confirmed('850.00', { mreWriteBackState: 'NEW_STATE' as RentReconciliationDto['mreWriteBackState'] }))).toBe(false);
    for (const state of ['REMOVAL_REQUIRED', 'REMOVAL_FAILED', 'REMOVED', 'NOT_WRITTEN'] as const) expect(offered(released(state))).toBe(false);
  });

  it('on a stale state (read again or its read failed) no MRE action can be clicked', async () => {
    for (const r of [confirmed(), written(), released('REMOVAL_REQUIRED')]) {
      const { calls, unmount } = setup({ r, stale: true });
      fireEvent.change(screen.queryByLabelText('Grund für das Aufheben (Pflicht)') ?? document.createElement('input'), { target: { value: 'Grund' } });
      const shown = screen.getAllByRole<HTMLButtonElement>('button');
      expect(shown.length).toBeGreaterThan(0);
      expect(shown.every((b) => b.disabled)).toBe(true);
      for (const b of shown) fireEvent.click(b);
      await settle();
      expect(calls).toHaveLength(0);
      unmount();
    }
  });

  it('a running write says so and offers only reading again', async () => {
    const { calls, reload } = setup({ r: confirmed('850.00', { mreWriteBackState: 'PENDING', mreWriteBackLeaseUntil: '2026-03-06T10:01:00.000Z' }) });
    expect(screen.getByText(/Ein Schreibvorgang in MRE läuft bis/)).toBeTruthy();
    expect(buttons()).toEqual(['Stand neu laden']);
    expect(screen.getByText(/Aufheben ist erst möglich/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Stand neu laden' }));
    expect(reload).toHaveBeenCalledTimes(1);
    await settle();
    expect(calls).toHaveLength(0);
  });

  it('409 WRITE_BACK_IN_PROGRESS with Retry-After: the detail is read once, the actions wait exactly that long, nothing is sent again (fake timers)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const flush = () =>
      act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
    const { calls, reload } = setup({
      answers: [envelope(409, 'CONFLICT', { reason: 'WRITE_BACK_IN_PROGRESS', reconciliationId: REC_2 }, { 'retry-after': '30' })],
    });
    fireEvent.click(writeBack());
    await flush();
    expect(screen.getByRole('alert').textContent).toContain('Für diesen Mieter läuft gerade eine Übertragung an MRE');
    expect(reload).toHaveBeenCalledTimes(1);
    expect(writeBack().disabled).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(29_999);
    });
    expect(writeBack().disabled).toBe(true);
    expect(posts(calls)).toHaveLength(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(writeBack().disabled).toBe(false);
    // Waiting much longer sends nothing by itself: only a click would.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10 * 60_000);
    });
    expect(posts(calls)).toHaveLength(1);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('without Retry-After a running write still waits the minimum; a 503 records FAILED and is read again (fake timers)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const flush = () =>
      act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
    const { calls, reload } = setup({
      answers: [
        envelope(409, 'CONFLICT', { reason: 'WRITE_BACK_IN_PROGRESS', reconciliationId: REC_2 }),
        envelope(503, 'EXTERNAL_SYSTEM_ERROR', { reason: 'MRE_UNAVAILABLE', mreWriteBackState: 'FAILED' }, { 'retry-after': '3' }),
      ],
    });
    fireEvent.click(writeBack());
    await flush();
    expect(writeBack().disabled).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(MIN_WAIT_SECONDS * 1000 - 1);
    });
    expect(writeBack().disabled).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    fireEvent.click(writeBack());
    await flush();
    expect(screen.getByRole('alert').textContent).toContain('MRE war nicht erreichbar. Die Zuordnung bleibt bestehen');
    expect(screen.getByRole('alert').textContent).toContain('Frühestens in 3 Sekunden erneut versuchen.');
    expect(reload).toHaveBeenCalledTimes(2);
    expect(posts(calls)).toHaveLength(2);
  });

  it('a 412 is not read by itself and nothing is sent again; the state is read on request', async () => {
    const { calls, reload } = setup({ answers: [envelope(412, 'PRECONDITION_FAILED', { currentVersion: 3 })] });
    fireEvent.click(writeBack());
    await settle();
    expect(reload).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toContain('Es wurde nichts gesendet');
    fireEvent.click(screen.getByRole('button', { name: 'Aktuellen Stand laden' }));
    expect(reload).toHaveBeenCalledTimes(1);
    await settle();
    expect(posts(calls)).toHaveLength(1);
  });

  it('MRE refusals are explained: a payment changed by hand, a term not round-trippable, an unknown reason with its code', async () => {
    const { reload } = setup({
      answers: [
        envelope(409, 'CONFLICT', { reason: 'MRE_PAYMENT_CHANGED', mreWriteBackState: 'FAILED' }),
        envelope(409, 'CONFLICT', { reason: 'MRE_TERM_NOT_ROUND_TRIPPABLE', mreWriteBackState: 'NOT_WRITTEN' }),
        envelope(409, 'CONFLICT', { reason: 'BRAND_NEW' }),
      ],
    });
    fireEvent.click(writeBack());
    await settle();
    expect(screen.getByRole('alert').textContent).toContain('Die Zahlung von DE wurde in MRE von Hand geändert. DE repariert in MRE nichts');
    fireEvent.click(writeBack());
    await settle();
    expect(screen.getByRole('alert').textContent).toContain('Bitte die Zahlung in MRE von Hand erfassen');
    fireEvent.click(writeBack());
    await settle();
    expect(screen.getByRole('alert').textContent).toContain('Grund BRAND_NEW.');
    expect(reload).toHaveBeenCalledTimes(3);
  });
});

describe('step 6, Zuordnung aufheben and Aus MRE entfernen are separate (ui-guide.md §6.6, §11)', () => {
  it('a written match offers release, never removal; release needs a reason and says it removes nothing from MRE', async () => {
    const { calls, onChanged } = setup({ r: written(), answers: [json(200, released('REMOVAL_REQUIRED'))] });
    expect(button('Aus MRE entfernen')).toBeNull();
    expect(button('An MRE übertragen')).toBeNull();
    expect(screen.getByText(/Aufheben ist kein Entfernen aus MRE: danach wird „Aus MRE entfernen“ angeboten/)).toBeTruthy();
    expect(button('Zuordnung aufheben')?.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Grund für das Aufheben (Pflicht)'), { target: { value: ' Falsche Buchung ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Zuordnung aufheben' }));
    await settle();
    expect(posts(calls)).toHaveLength(1);
    expect(calls[0]?.url).toBe(`/api/v1/rent-reconciliations/${REC}/release`);
    expect(calls[0]?.body).toBe('{"reason":"Falsche Buchung"}');
    expect(calls[0]?.headers.get('if-match')).toBe('"4"');
    expect(screen.getByRole('status').textContent).toContain('Zuordnung aufgehoben. In MRE wurde dabei nichts geändert.');
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(calls.some((call) => call.url.endsWith('remove-from-mre'))).toBe(false);
  });

  it('after the release, in REMOVAL_REQUIRED or REMOVAL_FAILED: removal only, as its own click', async () => {
    const { calls } = setup({ r: released('REMOVAL_REQUIRED'), answers: [json(200, released('REMOVED', { version: 6 }))] });
    expect(buttons()).toEqual(['Aus MRE entfernen']);
    await settle();
    expect(calls).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Aus MRE entfernen' }));
    fireEvent.click(screen.getByRole('button', { name: /Aus MRE entfernen|Wird entfernt/ }));
    await settle();
    expect(posts(calls)).toHaveLength(1);
    expect(calls[0]?.url).toBe(`/api/v1/rent-reconciliations/${REC}/remove-from-mre`);
    expect(calls[0]?.body).toBeUndefined();
    expect(calls[0]?.headers.get('if-match')).toBe('"5"');
    cleanup();
    setup({ r: released('REMOVAL_FAILED', { mreWriteBackError: 'MRE_UNAVAILABLE' }) });
    expect(buttons()).toEqual(['Aus MRE entfernen']);
  });

  it('a release that was never written, a removed one, a suggestion or a rejection offer nothing', () => {
    for (const r of [
      released('NOT_WRITTEN'),
      released('REMOVED'),
      confirmed('850.00', { status: 'SUGGESTED', confirmedAt: null }),
      confirmed('850.00', { status: 'REJECTED' }),
    ]) {
      const { unmount } = setup({ r });
      expect(buttons()).toEqual([]);
      unmount();
    }
  });

  it('REMOVAL_TOO_EARLY: the time is said, the removal waits until notBefore, the detail is read once (fake timers)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(NOW);
    const { calls, reload } = setup({
      r: released('REMOVAL_REQUIRED'),
      answers: [envelope(409, 'CONFLICT', { reason: 'REMOVAL_TOO_EARLY', notBefore: '2026-03-06T10:00:20.000Z' })],
    });
    fireEvent.click(screen.getByRole('button', { name: 'Aus MRE entfernen' }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByRole('alert').textContent).toContain('Entfernen ist frühestens ab 06.03.2026, 11:00 möglich');
    expect(reload).toHaveBeenCalledTimes(1);
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Aus MRE entfernen' }).disabled).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Aus MRE entfernen' }).disabled).toBe(false);
    expect(posts(calls)).toHaveLength(1);
  });
});
