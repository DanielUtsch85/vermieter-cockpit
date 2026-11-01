import {
  compareYear,
  liveSchedule,
  planRecord,
  recordFingerprint,
  reproduce,
  changedDetails,
  type Fingerprinter,
  type RecordRefusal,
  type RecordRequest,
  type Reproduction,
  type ScheduleVersion,
  type ScheduleVersionRepository,
  type ScheduleVersionStatus,
} from '../domains/depreciation/index.js';
import { businessDayOf } from '../domains/ledger/index.js';
import { TAX_RULES } from '../domains/tax-rules/index.js';
import type { RuleRegistry } from '../shared/index.js';
import type { RealmPrincipal } from './access.js';
import { DepreciationAssetNotActiveError, DepreciationAssetNotFoundError } from './depreciation-assets.js';
import { ConcurrentUpdateError, IdempotencyKeyConflictError } from './errors.js';

/**
 * Recorded depreciation schedule versions (api-design.md §60, backlog VC-8-04; P8-D10): the record command and the
 * reads. The record command is behind the installation's recording switch (`DEPRECIATION_RECORDING_ENABLED`, decided
 * 2026-10-31, second and third set): while it is off the command's first statement refuses it, before any repository
 * call (no transaction, no key, no lock, no read). The reads never look at the switch.
 */

/** The installation's recording switch is off (→ 409 RECORDING_NOT_ENABLED, §60 "The recording switch"). */
export class RecordingNotEnabledError extends Error {
  override readonly name = 'RecordingNotEnabledError';

  constructor() {
    super('Recording depreciation schedule versions is not enabled in this installation');
  }
}

/** `throughYear` after today's year in Europe/Berlin (→ 400 OUT_OF_RANGE with `details.max`, §60 "Body"). */
export class ThroughYearInFutureError extends Error {
  override readonly name = 'ThroughYearInFutureError';

  constructor(readonly max: number) {
    super(`throughYear is after ${max}`);
  }
}

export class ScheduleVersionNotFoundError extends Error {
  override readonly name = 'ScheduleVersionNotFoundError';

  constructor(readonly versionId: string) {
    super(`Schedule version ${versionId} not found`);
  }
}

/** A refusal of the record command's steps 4–9 (§60 "Error answers"), its `details` as the API answers them. */
export class ScheduleVersionRefusedError extends Error {
  override readonly name = 'ScheduleVersionRefusedError';

  constructor(
    readonly assetId: string,
    readonly refusal: Exclude<RecordRefusal, { kind: 'ASSET_NOT_ACTIVE' }>,
  ) {
    super(refusal.kind);
  }
}

type Clock = { readonly now?: () => Date };
const nowOf = (deps: Clock) => (deps.now ?? (() => new Date()))();

export interface RecordScheduleVersionDeps extends Clock {
  readonly repository: ScheduleVersionRepository;
  /** The installation's switch, read once at startup (`config.ts`); no default: whoever builds the use case states it. */
  readonly recordingEnabled: boolean;
  readonly fingerprinter: Fingerprinter;
  readonly registry?: RuleRegistry;
  /** Attempts of the whole transaction on a serialisation failure (§60: a retry up to three times). */
  readonly attempts?: number;
}

export type RecordScheduleVersion = (
  input: RecordRequest & { readonly principal: RealmPrincipal; readonly assetId: string; readonly idempotencyKey?: string },
) => Promise<{ readonly version: ScheduleVersion; readonly created: boolean; readonly replayed: boolean }>;

export function recordScheduleVersion(deps: RecordScheduleVersionDeps): RecordScheduleVersion {
  const registry = deps.registry ?? TAX_RULES;
  const attempts = deps.attempts ?? 3;
  return async ({ principal, assetId, idempotencyKey, ...request }) => {
    // Request validation that needs the clock: still a 400, before the switch (§60, decided 2026-10-31, third set).
    const today = businessDayOf(nowOf(deps));
    const max = Number(today.slice(0, 4));
    if (request.throughYear > max) throw new ThroughYearInFutureError(max);
    // The switch, before every data access: no transaction, no key, no lock, no read (open question 9).
    if (!deps.recordingEnabled) throw new RecordingNotEnabledError();
    const normalized: RecordRequest = { ...request, acceptChangedYears: [...request.acceptChangedYears].sort((a, b) => a - b) };
    const recordedBy = principal.email;
    for (let attempt = 1; ; attempt++) {
      const outcome = await deps.repository.record({
        assetId,
        mreRealmId: principal.mreRealmId,
        actor: { actorType: 'USER', actorId: recordedBy },
        ...(idempotencyKey === undefined ? {} : { idempotency: { key: idempotencyKey, fingerprint: recordFingerprint(normalized) } }),
        decide: (read) => planRecord(read, normalized, { registry, fingerprinter: deps.fingerprinter, today, recordedBy }),
      });
      switch (outcome.kind) {
        case 'RECORDED':
          return { version: outcome.version, created: true, replayed: outcome.replayed };
        case 'UNCHANGED':
          return { version: outcome.version, created: false, replayed: outcome.replayed };
        case 'NOT_FOUND':
          throw new DepreciationAssetNotFoundError(assetId);
        case 'IDEMPOTENCY_CONFLICT':
          throw new IdempotencyKeyConflictError('Idempotency-Key was already used with a different payload');
        case 'REFUSED':
          if (outcome.refusal.kind === 'ASSET_NOT_ACTIVE') throw new DepreciationAssetNotActiveError(assetId, 'VOID');
          throw new ScheduleVersionRefusedError(assetId, outcome.refusal);
        case 'SERIALIZATION_FAILURE':
          if (attempt >= attempts) throw new ConcurrentUpdateError('The data kept changing concurrently; nothing was written');
      }
    }
  };
}

export type ListScheduleVersions = (input: {
  readonly principal: RealmPrincipal;
  readonly assetId: string;
  readonly statuses: readonly ScheduleVersionStatus[] | null;
}) => Promise<readonly ScheduleVersion[]>;

/** The list (§60 "Reads"): stored data only, newest first; a `VOID` asset's versions too. Never reads the switch. */
export function listScheduleVersions(deps: { readonly repository: ScheduleVersionRepository }): ListScheduleVersions {
  return async ({ principal, assetId, statuses }) => {
    const versions = await deps.repository.list(assetId, principal.mreRealmId, statuses);
    if (versions === undefined) throw new DepreciationAssetNotFoundError(assetId);
    return versions;
  };
}

export interface ScheduleVersionView {
  readonly version: ScheduleVersion;
  readonly reproduction: Reproduction;
  readonly comparison: {
    readonly computedOn: string;
    readonly years: readonly Record<string, unknown>[];
    readonly notRecordedYears: readonly number[];
  } | null;
}

export type GetScheduleVersion = (input: {
  readonly principal: RealmPrincipal;
  readonly assetId: string;
  readonly versionId: string;
}) => Promise<ScheduleVersionView>;

/**
 * The single version (§60 "Reads"): the stored version, its `reproduction`, and its `comparison` with today's derivation
 * for the `CURRENT` version of an `ACTIVE` asset (else `null`), from one snapshot. Never reads the switch.
 */
export function getScheduleVersion(
  deps: { readonly repository: ScheduleVersionRepository; readonly fingerprinter: Fingerprinter; readonly registry?: RuleRegistry } & Clock,
): GetScheduleVersion {
  const registry = deps.registry ?? TAX_RULES;
  return async ({ principal, assetId, versionId }) => {
    const found = await deps.repository.find(assetId, principal.mreRealmId, versionId);
    if (found === undefined) throw new ScheduleVersionNotFoundError(versionId);
    const { version, schedule } = found;
    const reproduction = reproduce(version, registry, deps.fingerprinter);
    if (version.status !== 'CURRENT' || schedule.asset.status !== 'ACTIVE') return { version, reproduction, comparison: null };
    const today = businessDayOf(nowOf(deps));
    const todayYear = Number(today.slice(0, 4));
    const live = liveSchedule(schedule, registry, deps.fingerprinter, today, Math.max(todayYear, version.throughYear));
    const years = version.years.map((y) => {
      const c = compareYear(version, live, y.year, deps.fingerprinter);
      return c.state === 'CHANGED_SINCE_RECORDED' ? { state: c.state, ...changedDetails(assetId, version, c) } : { year: y.year, state: c.state };
    });
    const notRecordedYears: number[] = [];
    for (let year = version.throughYear + 1; year <= todayYear; year++) {
      if (compareYear(version, live, year, deps.fingerprinter).state === 'NOT_RECORDED') notRecordedYears.push(year);
    }
    return { version, reproduction, comparison: { computedOn: today, years, notRecordedYears } };
  };
}
