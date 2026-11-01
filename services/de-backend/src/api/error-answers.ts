import { ACQUISITION_ANSWERS } from './error-answers/acquisition.js';
import type { ErrorAnswer } from './error-answers/answer.js';
import { COMMON_ANSWERS } from './error-answers/common.js';
import { DEPRECIATION_ANSWERS } from './error-answers/depreciation.js';
import { FINANCING_ANSWERS } from './error-answers/financing.js';
import { LEDGER_ANSWERS } from './error-answers/ledger.js';
import { OWNERSHIP_ANSWERS } from './error-answers/ownership.js';
import { PARTY_ANSWERS } from './error-answers/party.js';
import { PROPERTY_REFERENCE_ANSWERS } from './error-answers/property-reference.js';
import { RENT_RECONCILIATION_ANSWERS } from './error-answers/rent-reconciliation.js';
import { RENTAL_CONTRACT_REFERENCE_ANSWERS } from './error-answers/rental-contract-reference.js';
import { SECURITY_DEPOSIT_ANSWERS } from './error-answers/security-deposit.js';
import { TAXATION_ANSWERS } from './error-answers/taxation.js';
import { WEG_ANSWERS } from './error-answers/weg.js';

export { access, type ErrorAnswer } from './error-answers/answer.js';
export { violationDto } from './error-answers/acquisition.js';

/**
 * The central error table (#89, api-design.md §12–13): each error class a use case throws, mapped to its HTTP answer.
 * The error handler answers from it; routes pass errors on with `next(error)`. A route keeps its own answer only where
 * it depends on the request (field errors named after the request's body, a message naming what was not done).
 *
 * One table per module under `error-answers/`, named after the application module that throws the error (#191); this
 * file only composes them. The lookup takes the first row whose class the error is an instance of. Every class in the
 * table extends `Error` directly and appears once, so no row shadows another and the order of the tables does not
 * change an answer. A subclass of a class in the table would have to come before it.
 */
const TABLE = [
  ...COMMON_ANSWERS,
  ...PARTY_ANSWERS,
  ...PROPERTY_REFERENCE_ANSWERS,
  ...RENTAL_CONTRACT_REFERENCE_ANSWERS,
  ...ACQUISITION_ANSWERS,
  ...OWNERSHIP_ANSWERS,
  ...LEDGER_ANSWERS,
  ...FINANCING_ANSWERS,
  ...RENT_RECONCILIATION_ANSWERS,
  ...SECURITY_DEPOSIT_ANSWERS,
  ...WEG_ANSWERS,
  ...TAXATION_ANSWERS,
  ...DEPRECIATION_ANSWERS,
];

/** The answer for an error a use case threw, or undefined (→ 500). */
export function answerFor(error: unknown): ErrorAnswer | undefined {
  return TABLE.find((entry) => error instanceof entry.type)?.toAnswer(error);
}
