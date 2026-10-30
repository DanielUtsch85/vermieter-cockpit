import { describe, expect, it } from 'vitest';
import type { BusinessDate } from '../../shared/index.js';
import {
  advisorsOf,
  assetFingerprint,
  entryAcquisitionRefusal,
  planAssetAmend,
  planAssetConfirm,
  writtenEntries,
  type DepreciationAsset,
  type DepreciationAssetId,
  type EntryAcquisition,
  type NewDepreciationAsset,
  type ShorterUsefulLife,
} from './asset.js';

/**
 * VC-8-01 domain (api-design.md §59): the amend as a difference by `acquisitionId` with its review-state resets, the
 * confirm's order of refusals, the entries' Acquisition checks and the create fingerprint. Synthetic ids and texts.
 */
const day = (value: string) => value as BusinessDate;
const PR = '0000eeee-0000-4000-8000-000000000001';
const ACQ_1 = '0000cccc-0000-4000-8000-000000000001';
const ACQ_2 = '0000cccc-0000-4000-8000-000000000002';
const ACQ_3 = '0000cccc-0000-4000-8000-000000000003';
const ADVISOR = '0000ffff-0000-4000-8000-000000000001';
const evidence = { source: 'Gutachten zur Restnutzungsdauer', date: day('2026-06-15'), documentReference: 'Gutachten Nr. 0000-SYN' };

const entry = (acquisitionId: string, overrides: Partial<ShorterUsefulLife> = {}): ShorterUsefulLife => ({
  acquisitionId,
  usefulLifeYears: 30,
  evidence,
  reviewState: 'CONFIRMED',
  advisorPartyId: null,
  ...overrides,
});
const asset = (overrides: Partial<DepreciationAsset> = {}): DepreciationAsset => ({
  id: '0000dddd-0000-4000-8000-000000000001' as DepreciationAssetId,
  mreRealmId: 'realm-synthetic',
  propertyReferenceId: PR,
  assetType: 'BUILDING',
  depreciationMethod: 'LINEAR_7_4',
  status: 'ACTIVE',
  buildingCompletionYear: 1995,
  sourceReferences: ['Teilungserklärung, Anlage 1'],
  reviewState: 'ADVISOR_CONFIRMED',
  advisorPartyId: ADVISOR,
  shorterUsefulLives: [entry(ACQ_1), entry(ACQ_2, { reviewState: 'ADVISOR_CONFIRMED', advisorPartyId: ADVISOR })],
  notes: null,
  voidedAt: null,
  voidReason: null,
  createdAt: new Date('2026-10-30T09:00:00Z'),
  version: 3,
  ...overrides,
});

describe('planAssetAmend (§59)', () => {
  it('a changed completion year resets the asset to UNREVIEWED and clears the advisor, recorded as a reset', () => {
    const plan = planAssetAmend(asset(), { buildingCompletionYear: 1994 });
    expect(plan.next).toMatchObject({ buildingCompletionYear: 1994, reviewState: 'UNREVIEWED', advisorPartyId: null });
    expect(plan.reviewStateReset).toEqual({ from: 'ADVISOR_CONFIRMED', to: 'UNREVIEWED' });
    expect(plan.changes).toEqual({
      buildingCompletionYear: { from: 1995, to: 1994 },
      reviewState: { from: 'ADVISOR_CONFIRMED', to: 'UNREVIEWED' },
      advisorPartyId: { from: ADVISOR, to: null },
    });
    // The entries are untouched: their own state is theirs.
    expect(plan.changedEntries).toEqual([]);
  });

  it('… kept at NEEDS_REVIEW when the body names it; no reset is recorded then', () => {
    const plan = planAssetAmend(asset(), { buildingCompletionYear: 1994, reviewState: 'NEEDS_REVIEW' });
    expect(plan.next).toMatchObject({ reviewState: 'NEEDS_REVIEW', advisorPartyId: null });
    expect(plan.reviewStateReset).toBeNull();
  });

  it('an amended year is never CONFIRMED without a new confirm; lowering the state clears the advisor', () => {
    expect(planAssetAmend(asset({ reviewState: 'CONFIRMED', advisorPartyId: null }), { buildingCompletionYear: null }).next.reviewState).toBe('UNREVIEWED');
    expect(planAssetAmend(asset(), { reviewState: 'NEEDS_REVIEW' }).next).toMatchObject({ reviewState: 'NEEDS_REVIEW', advisorPartyId: null });
    // Sources and notes are not the year: they keep the confirmation.
    expect(planAssetAmend(asset(), { sourceReferences: ['Grundbuchauszug'], notes: 'n' }).next).toMatchObject({
      reviewState: 'ADVISOR_CONFIRMED',
      advisorPartyId: ADVISOR,
    });
  });

  it('the same values are no change: a no-op', () => {
    const current = asset();
    const plan = planAssetAmend(current, {
      buildingCompletionYear: 1995,
      sourceReferences: current.sourceReferences,
      notes: null,
      shorterUsefulLives: current.shorterUsefulLives.map(({ acquisitionId, usefulLifeYears, evidence: e }) => ({
        acquisitionId,
        usefulLifeYears,
        evidence: e,
      })),
    });
    expect(plan.changed).toBe(false);
    expect(plan.changes).toEqual({});
    expect(planAssetAmend(asset({ reviewState: 'NEEDS_REVIEW', advisorPartyId: null }), { reviewState: 'NEEDS_REVIEW' }).changed).toBe(false);
  });

  it('entries matched by acquisitionId: added, changed (its state reset to the body’s, default UNREVIEWED), removed; unchanged kept', () => {
    const plan = planAssetAmend(asset(), {
      shorterUsefulLives: [
        { acquisitionId: ACQ_3, usefulLifeYears: 25, evidence },
        { acquisitionId: ACQ_2, usefulLifeYears: 28, evidence },
      ],
    });
    expect(plan.changedEntries.map((c) => [c.acquisitionId, c.change])).toEqual([
      [ACQ_1, 'REMOVED'],
      [ACQ_2, 'CHANGED'],
      [ACQ_3, 'ADDED'],
    ]);
    expect(plan.changedEntries[1]?.to).toMatchObject({ usefulLifeYears: 28, reviewState: 'UNREVIEWED', advisorPartyId: null });
    expect(plan.changedEntries[2]?.to).toMatchObject({ reviewState: 'UNREVIEWED' });
    expect(plan.next.shorterUsefulLives.map((e) => e.acquisitionId)).toEqual([ACQ_2, ACQ_3]);
    expect(writtenEntries(plan).map((e) => e.acquisitionId)).toEqual([ACQ_2, ACQ_3]);
    // The asset's own state is not the entries'.
    expect(plan.next.reviewState).toBe('ADVISOR_CONFIRMED');
  });

  it('a changed fact takes the state the body gives; an unchanged one keeps its own unless the body names another', () => {
    const named = planAssetAmend(asset(), {
      shorterUsefulLives: [
        { acquisitionId: ACQ_1, usefulLifeYears: 29, evidence, reviewState: 'NEEDS_REVIEW' },
        { acquisitionId: ACQ_2, usefulLifeYears: 30, evidence },
      ],
    });
    expect(named.next.shorterUsefulLives).toEqual([
      entry(ACQ_1, { usefulLifeYears: 29, reviewState: 'NEEDS_REVIEW' }),
      entry(ACQ_2, { reviewState: 'ADVISOR_CONFIRMED', advisorPartyId: ADVISOR }),
    ]);
    const confirmed = planAssetAmend(asset({ shorterUsefulLives: [entry(ACQ_1, { reviewState: 'UNREVIEWED' })] }), {
      shorterUsefulLives: [{ acquisitionId: ACQ_1, usefulLifeYears: 30, evidence, reviewState: 'ADVISOR_CONFIRMED', advisorPartyId: ADVISOR }],
    });
    expect(confirmed.changedEntries).toEqual([
      {
        acquisitionId: ACQ_1,
        change: 'CHANGED',
        from: entry(ACQ_1, { reviewState: 'UNREVIEWED' }),
        to: entry(ACQ_1, { reviewState: 'ADVISOR_CONFIRMED', advisorPartyId: ADVISOR }),
      },
    ]);
    // A changed evidence is a changed fact.
    const evidenceChanged = planAssetAmend(asset(), {
      shorterUsefulLives: [
        { acquisitionId: ACQ_1, usefulLifeYears: 30, evidence: { ...evidence, documentReference: null } },
        { acquisitionId: ACQ_2, usefulLifeYears: 30, evidence },
      ],
    });
    expect(evidenceChanged.changedEntries.map((c) => [c.acquisitionId, c.to?.reviewState])).toEqual([[ACQ_1, 'UNREVIEWED']]);
  });
});

describe('planAssetConfirm (§59)', () => {
  it('VOID → ASSET_NOT_ACTIVE; no year → COMPLETION_YEAR_MISSING; CONFIRMED over ADVISOR_CONFIRMED → ADVISOR_CONFIRMED, in this order', () => {
    expect(planAssetConfirm(asset({ status: 'VOID', buildingCompletionYear: null }), 'CONFIRMED', null)).toEqual({ kind: 'ASSET_NOT_ACTIVE', status: 'VOID' });
    expect(planAssetConfirm(asset({ buildingCompletionYear: null, reviewState: 'UNREVIEWED', advisorPartyId: null }), 'CONFIRMED', null)).toEqual({
      kind: 'COMPLETION_YEAR_MISSING',
    });
    expect(planAssetConfirm(asset(), 'CONFIRMED', null)).toEqual({ kind: 'ADVISOR_CONFIRMED' });
  });

  it('the same state with the same advisor is a no-op; another advisor or a raise is a change', () => {
    expect(planAssetConfirm(asset(), 'ADVISOR_CONFIRMED', ADVISOR)).toEqual({ kind: 'CONFIRM', changed: false });
    expect(planAssetConfirm(asset(), 'ADVISOR_CONFIRMED', null)).toEqual({ kind: 'CONFIRM', changed: true });
    expect(planAssetConfirm(asset({ reviewState: 'NEEDS_REVIEW', advisorPartyId: null }), 'CONFIRMED', null)).toEqual({ kind: 'CONFIRM', changed: true });
    expect(planAssetConfirm(asset({ reviewState: 'CONFIRMED', advisorPartyId: null }), 'CONFIRMED', null)).toEqual({ kind: 'CONFIRM', changed: false });
  });
});

describe('entryAcquisitionRefusal (§59, order 4)', () => {
  const found = (...list: EntryAcquisition[]) => new Map(list.map((a) => [a.id, a]));
  const draft = (id: string, propertyReferenceId = PR, status = 'DRAFT'): EntryAcquisition => ({ id, propertyReferenceId, status });

  it('unknown or foreign (404), then of another PropertyReference (422), then CANCELLED (409), each over all entries', () => {
    const entries = [entry(ACQ_1), entry(ACQ_2), entry(ACQ_3)];
    const OTHER = '0000eeee-0000-4000-8000-000000000002';
    expect(entryAcquisitionRefusal(entries, found(draft(ACQ_1, PR, 'CANCELLED'), draft(ACQ_2, OTHER)), PR)).toEqual({
      kind: 'ACQUISITION_NOT_FOUND',
      acquisitionId: ACQ_3,
    });
    expect(entryAcquisitionRefusal(entries, found(draft(ACQ_1, PR, 'CANCELLED'), draft(ACQ_2, OTHER), draft(ACQ_3)), PR)).toEqual({
      kind: 'ACQUISITION_NOT_OF_PROPERTY',
      acquisitionId: ACQ_2,
      propertyReferenceId: OTHER,
    });
    expect(entryAcquisitionRefusal(entries, found(draft(ACQ_1, PR, 'CANCELLED'), draft(ACQ_2), draft(ACQ_3, PR, 'CONFIRMED')), PR)).toEqual({
      kind: 'ACQUISITION_CANCELLED',
      acquisitionId: ACQ_1,
    });
    expect(entryAcquisitionRefusal(entries, found(draft(ACQ_1), draft(ACQ_2), draft(ACQ_3, PR, 'CONFIRMED')), PR)).toBeUndefined();
  });
});

describe('assetFingerprint and advisorsOf', () => {
  const created = (overrides: Partial<NewDepreciationAsset> = {}): NewDepreciationAsset => ({
    mreRealmId: 'realm-synthetic',
    propertyReferenceId: PR,
    assetType: 'BUILDING',
    depreciationMethod: 'LINEAR_7_4',
    buildingCompletionYear: 1995,
    sourceReferences: [],
    reviewState: 'UNREVIEWED',
    advisorPartyId: null,
    shorterUsefulLives: [entry(ACQ_1), entry(ACQ_2)],
    notes: null,
    ...overrides,
  });

  it('the normalized body: entry order does not matter, every field does', () => {
    expect(assetFingerprint(created())).toBe(assetFingerprint(created({ shorterUsefulLives: [entry(ACQ_2), entry(ACQ_1)] })));
    expect(assetFingerprint(created())).not.toBe(assetFingerprint(created({ buildingCompletionYear: 1996 })));
    expect(assetFingerprint(created())).not.toBe(assetFingerprint(created({ shorterUsefulLives: [entry(ACQ_1, { usefulLifeYears: 31 }), entry(ACQ_2)] })));
  });

  it('the advisors named, each once, the asset’s first', () => {
    const OTHER = '0000ffff-0000-4000-8000-000000000002';
    expect(
      advisorsOf({
        advisorPartyId: OTHER,
        shorterUsefulLives: [entry(ACQ_1, { advisorPartyId: ADVISOR }), entry(ACQ_2, { advisorPartyId: OTHER }), entry(ACQ_3)],
      }),
    ).toEqual([OTHER, ADVISOR]);
  });
});
