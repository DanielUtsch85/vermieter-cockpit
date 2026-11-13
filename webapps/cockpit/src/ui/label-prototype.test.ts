import { describe, expect, it } from 'vitest';
import { ApiError } from '../api/errors';
import { describeFieldError } from './error-text';
import { ambiguityText, batchStatusText, importRefusalText, orderText, previousExportText, resolutionText, rowErrorText } from './imports/import-labels';
import {
  confidenceText,
  mrePaymentTypeText,
  reconciliationStatusLabel,
  suggestionReasonText,
  writeBackErrorText,
  writeBackStateLabel,
} from './rent/rent-labels';
import { accountStatusLabel, correctionRoleLabel, directionLabel, provenanceLabel, statusLabel } from './transactions/labels';

/**
 * Review of #355, H1: the label tables look a code up with `Object.hasOwn`, so a code from the server or MRE that is
 * the name of an `Object.prototype` member (`toString`, `constructor`, …) is an unknown code and shown with its code,
 * never the prototype's function. One line per table; each must turn red when its `hasOwn` becomes `in`.
 */

const KEYS = ['toString', 'constructor', 'hasOwnProperty', 'valueOf', '__proto__'] as const;

const TABLES: readonly (readonly [table: string, actual: (key: string) => unknown, expected: (key: string) => unknown])[] = [
  ['transactions STATUS', (k) => statusLabel(k).text, (k) => `Unbekannter Status (${k})`],
  ['transactions PROVENANCE', (k) => provenanceLabel(k).text, (k) => `Unbekannte Herkunft (${k})`],
  ['transactions DIRECTION', (k) => directionLabel(k).text, (k) => `Unbekannte Richtung (${k})`],
  ['transactions CORRECTION_ROLE', (k) => correctionRoleLabel(k).text, (k) => `Unbekannte Rolle (${k})`],
  ['transactions ACCOUNT_STATUS', (k) => accountStatusLabel(k).text, (k) => `unbekannter Status (${k})`],
  ['rent reconciliation status', (k) => reconciliationStatusLabel(k).text, (k) => `Unbekannter Status (${k})`],
  ['rent write-back state', (k) => writeBackStateLabel(k).text, (k) => `MRE: unbekannter Stand (${k})`],
  ['rent MRE_PAYMENT_TYPES', (k) => mrePaymentTypeText(k), (k) => `Unbekannte Zahlungsart (${k})`],
  ['rent CONFIDENCE', (k) => confidenceText(k), (k) => `unbekannt (${k})`],
  ['rent SUGGESTION_REASON', (k) => suggestionReasonText(k), (k) => `Unbekannter Grund (${k})`],
  ['rent WRITE_BACK_ERRORS', (k) => writeBackErrorText(k), (k) => `Fehler ${k}`],
  ['import BATCH_STATUS', (k) => batchStatusText(k), (k) => `Unbekannter Status (${k})`],
  ['import AMBIGUITY', (k) => ambiguityText(k), (k) => `Unbekannter Grund (${k})`],
  ['import RESOLUTION', (k) => resolutionText(k), (k) => `Unbekannte Entscheidung (${k})`],
  ['import ORDER', (k) => orderText(k), (k) => `unbekannte Reihenfolge (${k})`],
  ['import PREVIOUS_EXPORT', (k) => previousExportText(k), (k) => `Unbekanntes Ergebnis (${k})`],
  ['import ROW_CODES', (k) => rowErrorText({ field: 'betrag', code: k }), (k) => ({ name: 'betrag', text: `Code ${k}` })],
  ['import IMPORT_ERROR', (k) => importRefusalText(new ApiError(422, 'IMPORT_ERROR', 'x', { reason: k }))[0], (k) => `Grund ${k}.`],
  ['import IBAN_REASONS', (k) => importRefusalText(new ApiError(422, 'ACCOUNT_IBAN_MISMATCH', 'x', { reason: k }))[0], (k) => `Grund ${k}.`],
  ['error-text SPECIAL_FIELD_NAMES and FIELD_CODE_TEXTS', (k) => describeFieldError({ field: k, code: k }), (k) => ({ name: k, text: `Code ${k}` })],
];

describe('prototype keys are unknown codes in every hasOwn label table (review of #355, H1)', () => {
  it.each(TABLES)('%s shows a prototype key with its code', (_table, actual, expected) => {
    for (const key of KEYS) expect(actual(key), key).toEqual(expected(key));
  });
});
