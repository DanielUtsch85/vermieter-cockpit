import type { FieldError } from '@vermieter-cockpit/de-backend/client-contract';

export type { FieldError };

/**
 * Codes the client gives an answer that is not the backend's error envelope. They start with `CLIENT_`, which no
 * backend code does (api-design.md §12–13), so they never mix with a server code.
 */
export const CLIENT_CODES = {
  /** No answer at all: network down, proxy unreachable, request aborted. The outcome is unknown (ui-guide.md §7.4). */
  network: 'CLIENT_NETWORK_ERROR',
  /** An answer without the envelope, e.g. an HTML 502 page of the proxy, or a 2xx body that is not JSON. */
  unexpected: 'CLIENT_UNEXPECTED_RESPONSE',
  /** The MRE session ended: the refresh was refused or a renewed token was refused again (mre-integration.md §47.2). */
  sessionExpired: 'CLIENT_SESSION_EXPIRED',
  /** An answer whose `mreRealmId` is not the Realm the request was made for: never shown (ui-guide.md §7.3). */
  realmMismatch: 'CLIENT_REALM_MISMATCH',
} as const;

/** One refusal, as `{ error: { code, message, details? } }` of api-design.md §12–13 reads (ui-guide.md §7.4). */
export class ApiError extends Error {
  override readonly name = 'ApiError';

  constructor(
    /** HTTP status; 0 when no answer arrived. */
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: Readonly<Record<string, unknown>> | undefined = undefined,
    /** `details.fields` (§90): one entry per refused input, in the server's order. */
    readonly fields: readonly FieldError[] = [],
    /** `Retry-After` in seconds, when the answer carried one (e.g. a concurrent MRE write-back, a 503). */
    readonly retryAfterSeconds: number | undefined = undefined,
  ) {
    super(message);
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** The envelope's content, or undefined when the body is not an error envelope. */
export function readErrorEnvelope(body: unknown): { code: string; message: string; details: Record<string, unknown> | undefined } | undefined {
  if (!isRecord(body) || !isRecord(body['error'])) return undefined;
  const { code, message, details } = body['error'];
  if (typeof code !== 'string' || code === '') return undefined;
  return { code, message: typeof message === 'string' ? message : '', details: isRecord(details) ? details : undefined };
}

/**
 * `details.fields`: every well-formed entry, in order. An entry is kept whatever its name, including `(body)` (an error of
 * the whole body), dotted paths with an index (`splits.0.amount`, §58X), header names (`If-Match`) and the empty name
 * `""` of an empty query or body key (Entscheidung des Projektinhabers, 2026-11-10). Malformed entries are dropped.
 */
export function readFieldErrors(details: Readonly<Record<string, unknown>> | undefined): FieldError[] {
  const fields = details?.['fields'];
  if (!Array.isArray(fields)) return [];
  return fields.filter((entry): entry is FieldError => isRecord(entry) && typeof entry['field'] === 'string' && typeof entry['code'] === 'string');
}

/** `Retry-After` as seconds: delta-seconds or an HTTP date (RFC 9110 §10.2.3); undefined when absent or unreadable. */
export function readRetryAfter(header: string | null, now: () => number = Date.now): number | undefined {
  if (header === null) return undefined;
  const value = header.trim();
  if (/^\d+$/.test(value)) return Number(value);
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, Math.ceil((date - now()) / 1000));
}

/** The error for a non-2xx answer: the envelope when there is one, otherwise `CLIENT_UNEXPECTED_RESPONSE`. */
export function errorFromAnswer(status: number, body: unknown, retryAfter: string | null): ApiError {
  const envelope = readErrorEnvelope(body);
  const retryAfterSeconds = readRetryAfter(retryAfter);
  if (envelope === undefined) {
    return new ApiError(status, CLIENT_CODES.unexpected, `HTTP ${status} without an error envelope.`, undefined, [], retryAfterSeconds);
  }
  return new ApiError(status, envelope.code, envelope.message, envelope.details, readFieldErrors(envelope.details), retryAfterSeconds);
}

/**
 * Whether a field name matches a form's pattern. A pattern names a field as the backend does (dotted, §58X), with `*`
 * for an array index: `splits.*.amount` matches `splits.0.amount` and `splits.12.amount`, not `splits.amount`.
 */
export function fieldMatches(pattern: string, field: string): boolean {
  const want = pattern.split('.');
  const got = field.split('.');
  return want.length === got.length && want.every((segment, i) => (segment === '*' ? /^\d+$/.test(got[i] ?? '') : segment === got[i]));
}

/**
 * Splits field errors into those a form can bind to one of its inputs and the rest. A field the form does not know is
 * an unknown field (Entscheidung des Projektinhabers, 2026-11-09, §58W question 3: the UI recognises "unknown" by not
 * knowing the name); `(body)` and `""` are never a form input. The rest must be shown, never swallowed (ui-guide.md §7.4).
 */
export function partitionFieldErrors(
  fields: readonly FieldError[],
  knownPatterns: readonly string[],
): { readonly known: readonly (FieldError & { readonly pattern: string })[]; readonly other: readonly FieldError[] } {
  const known: (FieldError & { pattern: string })[] = [];
  const other: FieldError[] = [];
  for (const entry of fields) {
    const pattern = knownPatterns.find((candidate) => fieldMatches(candidate, entry.field));
    if (pattern === undefined) other.push(entry);
    else known.push({ ...entry, pattern });
  }
  return { known, other };
}
