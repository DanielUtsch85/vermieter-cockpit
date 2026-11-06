import { checkVersion, type BusinessDate, type VersionConflict } from '../../shared/index.js';
import { ownershipStart, type Acquisition, type AcquisitionFlag } from './acquisition.js';

/**
 * Recording the transfer of economic ownership later (api-design.md §58N, VC-X-52; Entscheidung des Projektinhabers,
 * 2026-11-04, §58N Fragen 1–8): one command for a `DRAFT` and a `CONFIRMED` Acquisition without `economicTransferDate`,
 * with its evidence. The Ownerships stay (option (b)): the recorded date starts the anschaffungsnahe window (§58K) and
 * the AfA (§59A) only, `ownershipStart` keeps the contract date, and the flag `OWNERSHIP_START_BEFORE_ECONOMIC_TRANSFER`
 * names the difference.
 */

export const OWNERSHIP_START_BEFORE_ECONOMIC_TRANSFER = 'OWNERSHIP_START_BEFORE_ECONOMIC_TRANSFER';

/** The normalized body (texts trimmed; §58N "Body"). */
export interface RecordTransferDateInput {
  readonly economicTransferDate: BusinessDate;
  /** 1–10 entries, as given. */
  readonly sourceReferences: readonly string[];
  readonly notes: string | null;
}

export type RecordTransferDatePlan =
  | { readonly kind: 'RECORD'; readonly next: Acquisition }
  | { readonly kind: 'ACQUISITION_CANCELLED' }
  | { readonly kind: 'TRANSFER_DATE_ALREADY_SET'; readonly economicTransferDate: BusinessDate }
  | VersionConflict
  | { readonly kind: 'BEFORE_CONTRACT_DATE'; readonly contractDate: BusinessDate };

/**
 * §58N's order of checks after `400` and `404`: `CANCELLED` (also with a stale `If-Match`: a final status answers before
 * the version), the date already set (also when it equals the body's), `If-Match`, then the date before `contractDate`.
 * A date after today is accepted (open question 3, decided 2026-11-04). The status, `confirmedAt` and every other field
 * stay; `version` + 1.
 */
export function planRecordTransferDate(
  current: Acquisition,
  input: RecordTransferDateInput,
  at: Date,
  expectedVersions?: readonly number[],
): RecordTransferDatePlan {
  if (current.status === 'CANCELLED') return { kind: 'ACQUISITION_CANCELLED' };
  if (current.economicTransferDate !== null) return { kind: 'TRANSFER_DATE_ALREADY_SET', economicTransferDate: current.economicTransferDate };
  const conflict = checkVersion(current.version, expectedVersions);
  if (conflict !== undefined) return conflict;
  if (input.economicTransferDate < current.contractDate) return { kind: 'BEFORE_CONTRACT_DATE', contractDate: current.contractDate };
  return {
    kind: 'RECORD',
    next: {
      ...current,
      economicTransferDate: input.economicTransferDate,
      economicTransferRecordedAt: at,
      economicTransferSourceReferences: [...input.sourceReferences],
      version: current.version + 1,
    },
  };
}

/** §15: the identity of a request for `Idempotency-Key` replays (scope `acquisition.transfer-date.record`). */
export function recordTransferDateFingerprint(acquisitionId: string, input: RecordTransferDateInput): string {
  return JSON.stringify([acquisitionId.toLowerCase(), input.economicTransferDate, input.sourceReferences, input.notes]);
}

/**
 * The flag of §58N (open question 5, decided 2026-11-04, a deviation from the proposal): raised when `ownershipStart` ≠
 * `economicTransferDate`, `OPEN` when a seller of the same Acquisition in the same Realm has an AfA component (between
 * contract and transfer nobody gets AfA: a wrong figure in DE), `INFORMATIVE` otherwise (an external seller). Never on a
 * `CANCELLED` Acquisition, and never once §58Q's act aligned the Ownerships (`ownershipStart` is then the date). From
 * VC-X-57 on (§58R rule 7, Frage 5) it arises neither for a `DRAFT` nor for an Acquisition confirmed from the transfer:
 * `ownershipStart` is `economicTransferDate` for both; only legacy data keeps it.
 */
export function ownershipStartFlag(
  acquisition: { readonly id: string; readonly ownershipAlignedAt?: Date | null; readonly confirmedOwnershipStart?: BusinessDate | null } & Pick<
    Acquisition,
    'status' | 'contractDate' | 'economicTransferDate' | 'economicTransferRecordedAt'
  >,
  sellerHasAfaComponent: boolean,
): AcquisitionFlag | null {
  // A cancelled purchase has no Ownerships and no AfA: nothing to name (review of #268).
  if (acquisition.status === 'CANCELLED') return null;
  const start = ownershipStart(acquisition);
  const date = acquisition.economicTransferDate;
  if (date === null || date === start) return null;
  return {
    code: OWNERSHIP_START_BEFORE_ECONOMIC_TRANSFER,
    level: sellerHasAfaComponent ? 'OPEN' : 'INFORMATIVE',
    details: { acquisitionId: acquisition.id, ownershipStart: start, economicTransferDate: date },
  };
}

export type RecordTransferDateOutcome =
  | { readonly kind: 'RECORDED'; readonly acquisition: Acquisition; readonly replayed: boolean }
  | { readonly kind: 'NOT_FOUND' }
  | { readonly kind: 'IDEMPOTENCY_CONFLICT' }
  | Exclude<RecordTransferDatePlan, { kind: 'RECORD' }>;
