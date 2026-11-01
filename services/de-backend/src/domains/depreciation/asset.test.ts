import { describe, expect, it } from 'vitest';
import type { BusinessDate } from '../../shared/index.js';
import {
  addedItems,
  advisorsOf,
  amendFieldsNotAllowed,
  assetFingerprint,
  entryAcquisitionRefusal,
  itemLinkRefusal,
  planAssetAmend,
  planAssetConfirm,
  writtenEntries,
  type DepreciationAsset,
  type DepreciationAssetId,
  type EntryAcquisition,
  type FoundItem,
  type NewDepreciationAsset,
  type ShorterUsefulLife,
} from './asset.js';
import type { ItemRef } from './capitalized-item.js';

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
  description: null,
  usefulLifeYears: null,
  usefulLifeBasis: null,
  acquiredOn: null,
  items: [],
  sourceReferences: ['Teilungserklärung, Anlage 1'],
  reviewState: 'ADVISOR_CONFIRMED',
  advisorPartyId: ADVISOR,
  shorterUsefulLives: [entry(ACQ_1), entry(ACQ_2, { reviewState: 'ADVISOR_CONFIRMED', advisorPartyId: ADVISOR })],
  purchaseMethods: [],
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
    description: null,
    usefulLifeYears: null,
    usefulLifeBasis: null,
    acquiredOn: null,
    items: [],
    sourceReferences: [],
    reviewState: 'UNREVIEWED',
    advisorPartyId: null,
    shorterUsefulLives: [entry(ACQ_1), entry(ACQ_2)],
    purchaseMethods: [],
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
        purchaseMethods: [],
      }),
    ).toEqual([OTHER, ADVISOR]);
  });
});

describe('a separate asset (VC-8-03, §59B)', () => {
  const SPLIT_1 = '0000eeee-0000-4000-8000-000000000061';
  const SPLIT_2 = '0000eeee-0000-4000-8000-000000000062';
  const USE = '0000eeee-0000-4000-8000-000000000091';
  const split = (sourceId: string): ItemRef => ({ sourceType: 'TRANSACTION_SPLIT', sourceId, sourcePosition: null });
  const kitchen = (overrides: Partial<DepreciationAsset> = {}) =>
    asset({
      assetType: 'SEPARATE_ASSET',
      depreciationMethod: 'LINEAR_7_1',
      buildingCompletionYear: null,
      description: 'Einbauküche (synthetisch)',
      usefulLifeYears: 10,
      usefulLifeBasis: 'BFH IX R 14/15 (B8)',
      acquiredOn: day('2027-04-20'),
      items: [split(SPLIT_1)],
      shorterUsefulLives: [],
      purchaseMethods: [],
      reviewState: 'CONFIRMED',
      advisorPartyId: null,
      ...overrides,
    });

  it('amend: the items as a difference (changedItems), a changed useful life, date or list resets the review state', () => {
    const plan = planAssetAmend(kitchen(), { items: [split(SPLIT_2), { sourceType: 'WEG_ASSESSMENT_USE', sourceId: USE, sourcePosition: 2 }] });
    expect(plan.changedItems).toEqual([
      { item: split(SPLIT_1), change: 'REMOVED' },
      { item: split(SPLIT_2), change: 'ADDED' },
      { item: { sourceType: 'WEG_ASSESSMENT_USE', sourceId: USE, sourcePosition: 2 }, change: 'ADDED' },
    ]);
    expect(addedItems(plan).map((i) => i.sourceId)).toEqual([SPLIT_2, USE]);
    expect(plan.reviewStateReset).toEqual({ from: 'CONFIRMED', to: 'UNREVIEWED' });
    for (const amendment of [{ usefulLifeYears: 8 }, { acquiredOn: day('2027-05-01') }]) {
      expect(planAssetAmend(kitchen(), amendment).next.reviewState).toBe('UNREVIEWED');
    }
    // The description and the basis of the useful life are facts too, but not of the figure: no reset.
    const text = planAssetAmend(kitchen(), { description: 'Küche, Wohnung 3', usefulLifeBasis: 'Herstellerangabe' });
    expect([text.changed, text.next.reviewState, Object.keys(text.changes)]).toEqual([true, 'CONFIRMED', ['description', 'usefulLifeBasis']]);
    // The same list in another order is no change: nothing is re-linked.
    expect(planAssetAmend(kitchen({ items: [split(SPLIT_1), split(SPLIT_2)] }), { items: [split(SPLIT_2), split(SPLIT_1)] }).changed).toBe(false);
  });

  it('amend: the fields of the other type are NOT_ALLOWED; confirm needs no completion year', () => {
    expect(amendFieldsNotAllowed('BUILDING', { usefulLifeYears: 10, items: [] })).toEqual(['usefulLifeYears', 'items']);
    expect(amendFieldsNotAllowed('SEPARATE_ASSET', { buildingCompletionYear: 1995, shorterUsefulLives: [] })).toEqual([
      'buildingCompletionYear',
      'shorterUsefulLives',
    ]);
    expect(amendFieldsNotAllowed('SEPARATE_ASSET', { description: 'x', notes: null })).toEqual([]);
    expect(planAssetConfirm(kitchen({ reviewState: 'UNREVIEWED' }), 'CONFIRMED', null)).toEqual({ kind: 'CONFIRM', changed: true });
  });

  it('the fingerprint covers the separate asset’s facts and its items', () => {
    const created = (overrides: Partial<NewDepreciationAsset> = {}): NewDepreciationAsset => {
      const { id: _id, status: _s, voidedAt: _v, voidReason: _r, createdAt: _c, version: _n, ...facts } = kitchen();
      return { ...facts, ...overrides };
    };
    for (const change of [
      { description: 'y' },
      { usefulLifeYears: 9 },
      { usefulLifeBasis: 'z' },
      { acquiredOn: day('2027-04-21') },
      { items: [split(SPLIT_2)] },
    ]) {
      expect(assetFingerprint(created(change))).not.toBe(assetFingerprint(created()));
    }
    expect(assetFingerprint(created({ items: [split(SPLIT_2), split(SPLIT_1)] }))).toBe(assetFingerprint(created({ items: [split(SPLIT_1), split(SPLIT_2)] })));
  });

  it('itemLinkRefusal: each check over all items, in §59B’s order', () => {
    const items = [split(SPLIT_1), split(SPLIT_2)];
    const capitalized = { counts: true, treatment: 'CAPITALIZED', reviewState: 'USER_CONFIRMED', anschaffungsnaheAcquisitionId: null };
    const found = (map: Record<string, FoundItem | undefined>) => (i: ItemRef) => map[i.sourceId];
    const none = () => undefined;
    const ok = { propertyReferenceId: PR, meaning: capitalized };
    // Unknown first, even when another item is of another PropertyReference.
    expect(itemLinkRefusal(items, found({ [SPLIT_1]: { propertyReferenceId: 'other' } }), PR, none)).toEqual({ kind: 'ITEM_NOT_FOUND', item: split(SPLIT_2) });
    expect(itemLinkRefusal(items, found({ [SPLIT_1]: ok, [SPLIT_2]: { propertyReferenceId: null } }), PR, none)).toEqual({
      kind: 'ITEM_NOT_OF_PROPERTY',
      item: split(SPLIT_2),
      propertyReferenceId: null,
    });
    const deductible = { propertyReferenceId: PR, meaning: { ...capitalized, treatment: 'DEDUCTIBLE' } };
    const anschaffungsnah = { propertyReferenceId: PR, meaning: { ...capitalized, anschaffungsnaheAcquisitionId: ACQ_1 } };
    expect(itemLinkRefusal(items, found({ [SPLIT_1]: anschaffungsnah, [SPLIT_2]: deductible }), PR, none)).toEqual({
      kind: 'ITEM_NOT_CAPITALIZED',
      item: split(SPLIT_2),
      counts: true,
      treatment: 'DEDUCTIBLE',
      reviewState: 'USER_CONFIRMED',
    });
    expect(
      itemLinkRefusal(items, found({ [SPLIT_1]: ok, [SPLIT_2]: { propertyReferenceId: PR, meaning: { ...capitalized, counts: false } } }), PR, none),
    ).toMatchObject({
      kind: 'ITEM_NOT_CAPITALIZED',
      counts: false,
    });
    expect(itemLinkRefusal(items, found({ [SPLIT_1]: ok, [SPLIT_2]: anschaffungsnah }), PR, (i) => (i.sourceId === SPLIT_1 ? 'asset-x' : undefined))).toEqual({
      kind: 'ITEM_ANSCHAFFUNGSNAHE',
      item: split(SPLIT_2),
      acquisitionId: ACQ_1,
    });
    expect(itemLinkRefusal(items, found({ [SPLIT_1]: ok, [SPLIT_2]: ok }), PR, (i) => (i.sourceId === SPLIT_2 ? 'asset-x' : undefined))).toEqual({
      kind: 'ITEM_IN_OTHER_ASSET',
      item: split(SPLIT_2),
      assetId: 'asset-x',
    });
    // A NEEDS_REVIEW CAPITALIZED item may be linked: the read shows ITEM_CLASSIFICATION_NEEDS_REVIEW.
    expect(
      itemLinkRefusal(
        items,
        found({ [SPLIT_1]: ok, [SPLIT_2]: { propertyReferenceId: PR, meaning: { ...capitalized, reviewState: 'NEEDS_REVIEW' } } }),
        PR,
        none,
      ),
    ).toBeUndefined();
  });
});
