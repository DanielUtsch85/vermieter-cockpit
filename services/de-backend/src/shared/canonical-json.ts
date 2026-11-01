import { Money } from './money.js';
import { centsOf } from './cents.js';

/**
 * Canonical JSON and the fingerprint port, shared by every domain that hashes what a person saw or recorded
 * (api-design.md §60 "Reproducible"; §58E plans the Taxation acknowledgements on the same helpers). Moved here from
 * `domains/depreciation/fingerprint.ts` (which re-exports them) because Taxation may not import Depreciation
 * (`src/architecture.test.ts`). The SHA-256 adapter is `infrastructure/hashing/sha256-fingerprinter.ts`; no Node module
 * here.
 */

/** The port of every fingerprint and hash of §60: SHA-256 over the UTF-8 bytes of `text`, 64 lower-case hex characters. */
export interface Fingerprinter {
  sha256Hex(text: string): string;
}

/** Cents as a decimal string with two places (`60000n` → `"600.00"`, `-5n` → `"-0.05"`). */
export function centsText(cents: bigint): string {
  const abs = cents < 0n ? -cents : cents;
  return `${cents < 0n ? '-' : ''}${abs / 100n}.${(abs % 100n).toString().padStart(2, '0')}`;
}

/**
 * The canonical JSON of §60: keys sorted, no whitespace, Money as `{ amount, currency }` with the amount a decimal string
 * of two places (`"600"` and `"600.00"` are the same Money), `bigint` as its decimal text, lists in the order given
 * (the callers sort them as §59A and §59B list them). `undefined` members are left out, as `JSON.stringify` does.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  if (value instanceof Money) return canonicalJson({ amount: centsText(centsOf(value)), currency: value.currency });
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return JSON.stringify(value);
    case 'number':
      if (!Number.isFinite(value)) throw new Error('canonicalJson: a number must be finite');
      return JSON.stringify(value);
    case 'bigint':
      return JSON.stringify(value.toString());
    case 'object': {
      if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v === undefined ? null : v)).join(',')}]`;
      const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
    }
    default:
      throw new Error(`canonicalJson: unsupported ${typeof value}`);
  }
}

/** A fingerprint: 64 lower-case hex characters (§60's `expectedInputFingerprint`, the stored hashes). */
export const FINGERPRINT = /^[0-9a-f]{64}$/;
