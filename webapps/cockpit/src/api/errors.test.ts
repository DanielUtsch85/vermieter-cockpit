import { describe, expect, it } from 'vitest';
import { ApiError, CLIENT_CODES, errorFromAnswer, fieldMatches, partitionFieldErrors, readErrorEnvelope, readFieldErrors, readRetryAfter } from './errors';

describe('error envelope (api-design.md §12–13, ui-guide.md §7.4)', () => {
  it('reads code, message and details', () => {
    const error = errorFromAnswer(409, { error: { code: 'CONFLICT', message: 'Not current.', details: { reason: 'TRANSACTION_NOT_CURRENT' } } }, null);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 409, code: 'CONFLICT', message: 'Not current.', details: { reason: 'TRANSACTION_NOT_CURRENT' }, fields: [] });
  });

  it('keeps the envelope without details and without a message', () => {
    expect(readErrorEnvelope({ error: { code: 'NOT_FOUND' } })).toEqual({ code: 'NOT_FOUND', message: '', details: undefined });
  });

  it('a body without the envelope is CLIENT_UNEXPECTED_RESPONSE with the status, e.g. the proxy 502 page', () => {
    for (const body of [undefined, '<html>502</html>', { error: 'x' }, { error: { code: '' } }, [], { code: 'NOT_FOUND' }]) {
      expect(errorFromAnswer(502, body, null)).toMatchObject({ status: 502, code: CLIENT_CODES.unexpected, fields: [] });
    }
  });

  it('no client code collides with a backend code: all start with CLIENT_', () => {
    expect(Object.values(CLIENT_CODES).every((code) => code.startsWith('CLIENT_'))).toBe(true);
  });
});

describe('field errors (details.fields, §90, §58W, §58X)', () => {
  const fields = [
    { field: 'splits.0.amount', code: 'SCALE_EXCEEDED' },
    { field: 'splits.0.zzz', code: 'INVALID_FORMAT' },
    { field: 'splits.0.amount.zzz', code: 'INVALID_FORMAT' },
    { field: '(body)', code: 'REQUIRED' },
    { field: '', code: 'INVALID_FORMAT' },
    { field: 'status', code: 'INVALID_FORMAT' },
    { field: 'If-Match', code: 'INVALID_FORMAT' },
  ];

  it('keeps every entry in the server order, the empty name and (body) included', () => {
    const error = errorFromAnswer(400, { error: { code: 'VALIDATION_ERROR', message: 'Validation failed.', details: { fields } } }, null);
    expect(error.fields).toEqual(fields);
  });

  it('keeps the 422 VALIDATION_ERROR of the resolve of a review item as it is (§58X question 2)', () => {
    const error = errorFromAnswer(
      422,
      { error: { code: 'VALIDATION_ERROR', message: 'x', details: { fields: [{ field: 'decision', code: 'REQUIRED' }] } } },
      null,
    );
    expect(error).toMatchObject({ status: 422, code: 'VALIDATION_ERROR', fields: [{ field: 'decision', code: 'REQUIRED' }] });
  });

  it('drops malformed entries and keeps the well-formed ones', () => {
    const details = { fields: [{ field: 'a', code: 'REQUIRED' }, { field: 1, code: 'X' }, { field: 'b' }, null, 'c', { field: 'd', code: 'INVALID_FORMAT' }] };
    expect(readFieldErrors(details)).toEqual([
      { field: 'a', code: 'REQUIRED' },
      { field: 'd', code: 'INVALID_FORMAT' },
    ]);
    expect(readFieldErrors({ fields: 'nope' })).toEqual([]);
    expect(readFieldErrors(undefined)).toEqual([]);
  });

  it('a pattern matches an indexed path only with a numeric index at the star', () => {
    expect(fieldMatches('splits.*.amount', 'splits.0.amount')).toBe(true);
    expect(fieldMatches('splits.*.amount', 'splits.12.amount')).toBe(true);
    expect(fieldMatches('splits.*.amount', 'splits.amount')).toBe(false);
    expect(fieldMatches('splits.*.amount', 'splits.x.amount')).toBe(false);
    expect(fieldMatches('splits.*.amount', 'splits.0.amount.zzz')).toBe(false);
    expect(fieldMatches('description', 'description')).toBe(true);
    expect(fieldMatches('description', '')).toBe(false);
  });

  it('binds known fields to their pattern and leaves unknown fields, (body) and the empty name for the summary', () => {
    const { known, other } = partitionFieldErrors(fields, ['splits.*.amount', 'status']);
    expect(known).toEqual([
      { field: 'splits.0.amount', code: 'SCALE_EXCEEDED', pattern: 'splits.*.amount' },
      { field: 'status', code: 'INVALID_FORMAT', pattern: 'status' },
    ]);
    expect(other.map((entry) => entry.field)).toEqual(['splits.0.zzz', 'splits.0.amount.zzz', '(body)', '', 'If-Match']);
    expect(known.length + other.length).toBe(fields.length);
  });
});

describe('Retry-After', () => {
  it('reads delta seconds and an HTTP date, ignores the rest', () => {
    const now = () => Date.parse('2026-11-10T10:00:00Z');
    expect(readRetryAfter('7', now)).toBe(7);
    expect(readRetryAfter(' 0 ', now)).toBe(0);
    expect(readRetryAfter('Tue, 10 Nov 2026 10:00:30 GMT', now)).toBe(30);
    expect(readRetryAfter('Tue, 10 Nov 2026 09:00:00 GMT', now)).toBe(0);
    expect(readRetryAfter('soon', now)).toBeUndefined();
    expect(readRetryAfter(null, now)).toBeUndefined();
  });

  it('is carried on the error', () => {
    expect(errorFromAnswer(503, { error: { code: 'EXTERNAL_SYSTEM_ERROR', message: 'x' } }, '5').retryAfterSeconds).toBe(5);
  });
});
