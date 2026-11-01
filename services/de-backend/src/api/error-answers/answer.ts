import type { AccessError } from '../../application/index.js';
import type { FieldError } from '../validation.js';

/** An error's HTTP answer, as the error handler sends it (api-design.md §12–13). */
export interface ErrorAnswer {
  readonly status: number;
  readonly code: string;
  readonly message: string;
  readonly details?: Record<string, unknown>;
  readonly headers?: Readonly<Record<string, string>>;
}

export const answer = (status: number, code: string, message: string, details?: Record<string, unknown>): ErrorAnswer =>
  details === undefined ? { status, code, message } : { status, code, message, details };

export const validation = (fields: readonly FieldError[]): ErrorAnswer => answer(400, 'VALIDATION_ERROR', 'Validation failed.', { fields });

const ACCESS: Record<AccessError['code'], ErrorAnswer> = {
  UNAUTHENTICATED: { status: 401, code: 'UNAUTHORIZED', message: 'A valid MRE access token is required.', headers: { 'WWW-Authenticate': 'Bearer' } },
  FORBIDDEN: { status: 403, code: 'FORBIDDEN', message: 'No access to this Realm.' },
  AUTH_UNAVAILABLE: { status: 503, code: 'EXTERNAL_SYSTEM_ERROR', message: 'Authentication service unavailable.' },
};

/** An access refusal (VC-0-08); 401 carries `WWW-Authenticate: Bearer`. */
export const access = (code: AccessError['code']): ErrorAnswer => ACCESS[code];

type ErrorClass<E> = new (...args: never[]) => E;

/** One row of the table: an error class and its answer. */
export const on = <E>(type: ErrorClass<E>, toAnswer: (error: E) => ErrorAnswer) => ({ type, toAnswer: toAnswer as (error: unknown) => ErrorAnswer });
