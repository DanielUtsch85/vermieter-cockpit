import { describe, expect, it } from 'vitest';
import { ApiError } from '../api/errors';
import {
  checkConfirmAmount,
  checkReason,
  checkSuggestWindow,
  decidable,
  MIN_WAIT_SECONDS,
  releaseOffer,
  removalOffer,
  suggestBookingRange,
  termDate,
  waitAfter,
  writeBackOffer,
  type OfferFacts,
} from './reconciliation-rules';

const NOW = Date.parse('2026-03-06T10:00:00.000Z');
const LIVE = '2026-03-06T10:01:00.000Z';
const OVER = '2026-03-06T09:59:59.000Z';
const facts = (status: string, mreWriteBackState: string, mreWriteBackLeaseUntil: string | null = null): OfferFacts => ({
  status,
  mreWriteBackState,
  mreWriteBackLeaseUntil,
});

describe('the suggest window (api-design.md §37.3: YYYY-MM, at most twelve months)', () => {
  it('twelve months are fine, thirteen are not; inverted and malformed months are refused', () => {
    expect(checkSuggestWindow('2026-01', '2026-12')).toBeUndefined();
    expect(checkSuggestWindow('2026-03', '2026-03')).toBeUndefined();
    expect(checkSuggestWindow('2025-12', '2026-11')).toBeUndefined();
    expect(checkSuggestWindow('2026-01', '2027-01')).toBe('TOO_LONG');
    expect(checkSuggestWindow('2026-04', '2026-03')).toBe('INVERTED');
    expect(checkSuggestWindow('2026-13', '2026-12')).toBe('FROM_INVALID');
    expect(checkSuggestWindow('2026-1', '2026-12')).toBe('FROM_INVALID');
    expect(checkSuggestWindow('2026-01', '')).toBe('TO_INVALID');
    expect(checkSuggestWindow('03.2026', '2026-04')).toBe('FROM_INVALID');
  });

  it('the booking range of the run: from the 15th of the month before to the last day of the last month', () => {
    expect(suggestBookingRange('2026-03', '2026-04')).toEqual({ bookingDateFrom: '2026-02-15', bookingDateTo: '2026-04-30' });
    expect(suggestBookingRange('2026-01', '2026-02')).toEqual({ bookingDateFrom: '2025-12-15', bookingDateTo: '2026-02-28' });
    expect(suggestBookingRange('2028-02', '2028-02')).toEqual({ bookingDateFrom: '2028-01-15', bookingDateTo: '2028-02-29' });
    expect(suggestBookingRange('2100-02', '2100-02')?.bookingDateTo).toBe('2100-02-28');
    expect(suggestBookingRange('2000-02', '2000-02')?.bookingDateTo).toBe('2000-02-29');
    expect(suggestBookingRange('x', '2026-02')).toBeUndefined();
  });
});

describe('MRE term keys (ui-guide.md §5.2: a key YYYYMMDDHH, never a timestamp)', () => {
  it('the date a term names, as text; an impossible date or hour is none', () => {
    expect(termDate('2026030100')).toBe('2026-03-01');
    expect(termDate('2026022923')).toBeUndefined();
    expect(termDate('2028022900')).toBe('2028-02-29');
    expect(termDate('2026033124')).toBeUndefined();
    expect(termDate('2026130100')).toBeUndefined();
    expect(termDate('202603010')).toBeUndefined();
  });
});

describe('the amount of „Zuordnung bestätigen“ (§37.3, P4-D5: lower, never higher; strings, no float)', () => {
  const suggested = { amount: '850.00', currency: 'EUR' };
  it('equal is fine, reduced is fine, one cent more is refused; the string is exact', () => {
    expect(checkConfirmAmount('850,00', suggested)).toEqual({ ok: true, amount: { amount: '850.00', currency: 'EUR' } });
    expect(checkConfirmAmount('850', suggested)).toEqual({ ok: true, amount: { amount: '850.00', currency: 'EUR' } });
    expect(checkConfirmAmount('849,99', suggested)).toEqual({ ok: true, amount: { amount: '849.99', currency: 'EUR' } });
    expect(checkConfirmAmount('0,01', suggested)).toEqual({ ok: true, amount: { amount: '0.01', currency: 'EUR' } });
    expect(checkConfirmAmount('850,01', suggested)).toEqual({ ok: false, problem: 'ABOVE_SUGGESTION' });
    expect(checkConfirmAmount('1.850,00', suggested)).toEqual({ ok: false, problem: 'ABOVE_SUGGESTION' });
  });

  it('zero, negative, ambiguous and three places are refused, never rounded', () => {
    expect(checkConfirmAmount('0,00', suggested)).toEqual({ ok: false, problem: 'NOT_POSITIVE' });
    expect(checkConfirmAmount('-1', suggested)).toEqual({ ok: false, problem: 'NEGATIVE' });
    expect(checkConfirmAmount('849.99', suggested)).toEqual({ ok: false, problem: 'AMBIGUOUS' });
    expect(checkConfirmAmount('849,999', suggested)).toEqual({ ok: false, problem: 'TOO_MANY_DECIMALS' });
    expect(checkConfirmAmount('', suggested)).toEqual({ ok: false, problem: 'EMPTY' });
  });

  it('beyond 2^53 cents the comparison stays exact', () => {
    const large = { amount: '123456789012345678.90', currency: 'EUR' };
    expect(checkConfirmAmount('123.456.789.012.345.678,90', large)).toEqual({ ok: true, amount: large });
    expect(checkConfirmAmount('123.456.789.012.345.678,91', large)).toEqual({ ok: false, problem: 'ABOVE_SUGGESTION' });
    expect(checkConfirmAmount('123.456.789.012.345.678,89', large)).toEqual({ ok: true, amount: { amount: '123456789012345678.89', currency: 'EUR' } });
  });
});

describe('the reason of reject and release (§37.1, §37.3: 1–500 after trimming)', () => {
  it('required, trimmed, at most 500 characters', () => {
    expect(checkReason('')).toBe('REASON_MISSING');
    expect(checkReason('   ')).toBe('REASON_MISSING');
    expect(checkReason(' x ')).toBeUndefined();
    expect(checkReason('x'.repeat(500))).toBeUndefined();
    expect(checkReason('x'.repeat(501))).toBe('REASON_TOO_LONG');
  });
});

describe('which action a state offers (ui-guide.md §6.6, §11: release and removal separate, in the right status)', () => {
  it('only a suggestion is decided', () => {
    expect(decidable({ status: 'SUGGESTED' })).toBe(true);
    for (const status of ['CONFIRMED', 'REJECTED', 'RELEASED', 'NEW_STATUS']) expect(decidable({ status })).toBe(false);
  });

  it('write-back: CONFIRMED and NOT_WRITTEN or FAILED, or an expired PENDING; nothing else', () => {
    expect(writeBackOffer(facts('CONFIRMED', 'NOT_WRITTEN'), NOW)).toBe('offer');
    expect(writeBackOffer(facts('CONFIRMED', 'FAILED'), NOW)).toBe('offer');
    expect(writeBackOffer(facts('CONFIRMED', 'PENDING', OVER), NOW)).toBe('offer');
    expect(writeBackOffer(facts('CONFIRMED', 'PENDING', LIVE), NOW)).toBe('running');
    expect(writeBackOffer(facts('CONFIRMED', 'PENDING', 'nonsense'), NOW)).toBe('running');
    expect(writeBackOffer(facts('CONFIRMED', 'WRITTEN'), NOW)).toBe('none');
    expect(writeBackOffer(facts('CONFIRMED', 'NEW_STATE'), NOW)).toBe('none');
    for (const status of ['SUGGESTED', 'REJECTED', 'RELEASED', 'NEW_STATUS']) expect(writeBackOffer(facts(status, 'NOT_WRITTEN'), NOW)).toBe('none');
  });

  it('release: CONFIRMED in a known state, not while a write-back runs; never on RELEASED', () => {
    for (const state of ['NOT_WRITTEN', 'WRITTEN', 'FAILED']) expect(releaseOffer(facts('CONFIRMED', state), NOW)).toBe('offer');
    expect(releaseOffer(facts('CONFIRMED', 'PENDING', LIVE), NOW)).toBe('running');
    expect(releaseOffer(facts('CONFIRMED', 'PENDING', OVER), NOW)).toBe('offer');
    expect(releaseOffer(facts('CONFIRMED', 'NEW_STATE'), NOW)).toBe('none');
    for (const status of ['SUGGESTED', 'REJECTED', 'RELEASED']) expect(releaseOffer(facts(status, 'REMOVAL_REQUIRED'), NOW)).toBe('none');
  });

  it('removal: RELEASED and REMOVAL_REQUIRED, REMOVAL_FAILED or an expired REMOVING; never before the release', () => {
    expect(removalOffer(facts('RELEASED', 'REMOVAL_REQUIRED'), NOW)).toBe('offer');
    expect(removalOffer(facts('RELEASED', 'REMOVAL_FAILED'), NOW)).toBe('offer');
    expect(removalOffer(facts('RELEASED', 'REMOVING', OVER), NOW)).toBe('offer');
    expect(removalOffer(facts('RELEASED', 'REMOVING', LIVE), NOW)).toBe('running');
    for (const state of ['NOT_WRITTEN', 'REMOVED', 'NEW_STATE']) expect(removalOffer(facts('RELEASED', state), NOW)).toBe('none');
    for (const state of ['WRITTEN', 'FAILED', 'REMOVAL_REQUIRED']) expect(removalOffer(facts('CONFIRMED', state), NOW)).toBe('none');
  });
});

describe('the wait after a refusal (ui-guide.md §6.6: respect Retry-After, no tight loop)', () => {
  const conflict = (details: Record<string, unknown>, retryAfter?: number) => new ApiError(409, 'CONFLICT', '', details, [], retryAfter);
  it('Retry-After when given; REMOVAL_TOO_EARLY until notBefore; a running write or a 503 at least the minimum', () => {
    expect(waitAfter(conflict({ reason: 'WRITE_BACK_IN_PROGRESS' }, 30), NOW)).toBe(30);
    expect(waitAfter(conflict({ reason: 'WRITE_BACK_IN_PROGRESS' }), NOW)).toBe(MIN_WAIT_SECONDS);
    expect(waitAfter(new ApiError(503, 'EXTERNAL_SYSTEM_ERROR', ''), NOW)).toBe(MIN_WAIT_SECONDS);
    expect(waitAfter(new ApiError(503, 'EXTERNAL_SYSTEM_ERROR', '', undefined, [], 12), NOW)).toBe(12);
    expect(waitAfter(conflict({ reason: 'REMOVAL_TOO_EARLY', notBefore: '2026-03-06T10:01:30.500Z' }), NOW)).toBe(91);
    expect(waitAfter(conflict({ reason: 'REMOVAL_TOO_EARLY', notBefore: 'x' }), NOW)).toBe(MIN_WAIT_SECONDS);
  });

  it('counter-check: other refusals and errors not of the API ask for no wait', () => {
    expect(waitAfter(conflict({ reason: 'NOT_WRITABLE' }), NOW)).toBe(0);
    expect(waitAfter(new ApiError(412, 'PRECONDITION_FAILED', ''), NOW)).toBe(0);
    expect(waitAfter(new Error('x'), NOW)).toBe(0);
  });
});
