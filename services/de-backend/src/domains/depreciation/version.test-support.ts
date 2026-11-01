import { centsOf, type Money, type RuleRegistry } from '../../shared/index.js';
import type { Fingerprinter } from './fingerprint.js';
import { acquisition, acc8, asset, capitalized, day, kitchen, life, ownership, A, B, C, W, X } from './schedule.test-support.js';
import { EXTENSION, REPAIR, USE, repair, use } from './schedule-items.test-support.js';
import type { ScheduleInput, ScheduleRead } from './schedule-model.js';
import { liveSchedule, type LiveSchedule } from './version-compare.js';
import { planRecord } from './version-record.js';
import type { RecordRead, ScheduleVersion } from './version-model.js';

/**
 * The shared fixtures of the recorded-version tests (api-design.md §60): the identity `Fingerprinter` (the canonical
 * JSON itself, so a pure domain test compares the hashed text and needs no `node:crypto`; it does not meet the port's
 * 64-hex contract and never meets the database), a snapshot read of a schedule input, the e2e scenarios of §59A and
 * §59B, and a version recorded in memory. Synthetic. Test support only.
 */

export const identity: Fingerprinter = { sha256Hex: (text) => text };

export const readOf = (input: ScheduleInput, current: ScheduleVersion | null = null): ScheduleRead => ({
  asset: input.asset,
  acquisitions: input.acquisitions,
  ownerships: input.ownerships,
  capitalizedItems: input.capitalizedItems ?? [],
  links: input.links ?? [],
  ownerPartyFound: null,
  currentVersion: current,
});

export const live = (input: ScheduleInput, registry: RuleRegistry, horizon: number, today = day('2040-01-01')): LiveSchedule =>
  liveSchedule(readOf(input), registry, identity, today, horizon);

/** The scenarios the reproduction is checked on (§60 "Reproducible from the database": every e2e scenario). */
export const scenarios = (): Record<string, ScheduleInput> => ({
  'ACC8, the purchase': acc8(),
  'ACC8 with the repair and the use (POOLED_BASIS)': acc8({ capitalizedItems: [repair({ anschaffungsnaheAcquisitionId: null }), use()] }),
  'a sale with the buyer’s transfer date': acc8({
    acquisitions: [
      acquisition(),
      acquisition({
        id: X,
        contractDate: day('2030-05-01'),
        economicTransferDate: day('2030-07-01'),
        sellerPartyIds: [B],
        acquiredShare: { numerator: 2, denominator: 5 },
      }),
    ],
    ownerships: [ownership(A, '3/5', '2026-07-01', null, W), ownership(B, '2/5', '2026-07-01', '2030-06-30', W), ownership(C, '2/5', '2030-07-01', null, X)],
    capitalizedItems: [capitalized(EXTENSION, '2028-05-05', '10000.00')],
  }),
  'a shorter life, an heir and NOT_OWNED': {
    ...acc8(),
    asset: asset({ shorterUsefulLives: [life()] }),
    acquisitions: [acquisition({ acquiredShare: { numerator: 3, denominator: 5 } })],
    ownerships: [ownership(A, '3/5', '2026-07-01', null, W), ownership(C, '1/5', '2027-01-01', null, null)],
    capitalizedItems: [
      capitalized(EXTENSION, '2028-05-05', '10000.00', [
        [A, '3/5'],
        [C, '1/5'],
      ]),
    ],
  },
  'a refund after the repair': acc8({
    capitalizedItems: [repair({ anschaffungsnaheAcquisitionId: null }), capitalized(REPAIR.replace('71', '73'), '2028-04-01', '-1200.00')],
  }),
  'the Einbauküche (a separate asset)': {
    ...acc8(),
    asset: kitchen({ items: [{ sourceType: 'TRANSACTION_SPLIT', sourceId: USE.replace('91', '61'), sourcePosition: null }] }),
    capitalizedItems: [capitalized(USE.replace('91', '61'), '2027-04-20', '12000.00')],
  },
});

/** A version of `input` recorded in memory through `throughYear` (the record command's decision, no database). */
export function recordInMemory(input: ScheduleInput, registry: RuleRegistry, throughYear: number, today = day('2040-01-01')): ScheduleVersion {
  const read: RecordRead = { schedule: readOf(input), current: null };
  const probe = planRecord(
    read,
    { throughYear, reason: 'x', expectedInputFingerprint: '', acceptChangedYears: [] },
    { registry, fingerprinter: identity, today, recordedBy: 'u' },
  );
  if (probe.kind !== 'REFUSED' || probe.refusal.kind !== 'SCHEDULE_CHANGED') throw new Error(`unexpected ${probe.kind}`);
  const decision = planRecord(
    read,
    { throughYear, reason: 'x', expectedInputFingerprint: probe.refusal.currentInputFingerprint, acceptChangedYears: [] },
    { registry, fingerprinter: identity, today, recordedBy: 'u' },
  );
  if (decision.kind !== 'RECORD') throw new Error(`unexpected ${decision.kind}`);
  return {
    ...decision.version,
    versionId: '0000ffff-0000-4000-8000-000000000101',
    versionNumber: 1,
    status: 'CURRENT',
    supersedesVersionId: null,
    supersededByVersionId: null,
    supersededAt: null,
    recordedAt: new Date('2028-01-20T10:00:00Z'),
    version: 1,
  };
}

export const cents = (m: Money | null) => (m === null ? null : centsOf(m));
export { A, B, W };
