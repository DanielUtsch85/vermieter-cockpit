import { Money, type BusinessDate } from '../../shared/index.js';
import type { DepreciationAsset, DepreciationAssetId, ShorterUsefulLife } from './asset.js';
import type { ScheduleAcquisition, ScheduleInput, ScheduleOwnership } from './schedule.js';

/** Synthetic inputs of the schedule (api-design.md §59A): ACC8's purchase and its variants. No personal data. */
export const day = (value: string) => value as BusinessDate;
export const eur = (amount: string) => Money.of(amount, 'EUR');
export const PR = '0000eeee-0000-4000-8000-000000000001';
export const A = '0000aaaa-0000-4000-8000-000000000021';
export const B = '0000aaaa-0000-4000-8000-000000000022';
export const C = '0000aaaa-0000-4000-8000-000000000023';
export const D = '0000aaaa-0000-4000-8000-000000000024';
export const W = '0000cccc-0000-4000-8000-000000000001';
export const X = '0000cccc-0000-4000-8000-000000000002';
export const Y = '0000cccc-0000-4000-8000-000000000003';

export const asset = (overrides: Partial<DepreciationAsset> = {}): DepreciationAsset => ({
  id: '0000dddd-0000-4000-8000-000000000001' as DepreciationAssetId,
  mreRealmId: 'realm-synthetic',
  propertyReferenceId: PR,
  assetType: 'BUILDING',
  depreciationMethod: 'LINEAR_7_4',
  status: 'ACTIVE',
  buildingCompletionYear: 1995,
  sourceReferences: [],
  reviewState: 'CONFIRMED',
  advisorPartyId: null,
  shorterUsefulLives: [],
  notes: null,
  voidedAt: null,
  voidReason: null,
  createdAt: new Date('2026-10-30T09:00:00Z'),
  version: 1,
  ...overrides,
});

export const life = (overrides: Partial<ShorterUsefulLife> = {}): ShorterUsefulLife => ({
  acquisitionId: W,
  usefulLifeYears: 30,
  evidence: { source: 'Gutachten zur Restnutzungsdauer', date: day('2026-06-15'), documentReference: null },
  reviewState: 'CONFIRMED',
  advisorPartyId: null,
  ...overrides,
});

/** ACC8's purchase: price 300,000.00, costs 18,000.00 counted, 1,200.00 FINANCING_RELATED; building 254,400.00 of 318,000.00. */
export const acquisition = (overrides: Partial<ScheduleAcquisition> = {}): ScheduleAcquisition => ({
  id: W,
  status: 'CONFIRMED',
  purchasePrice: eur('300000.00'),
  acquiredShare: { numerator: 1, denominator: 1 },
  contractDate: day('2026-05-15'),
  economicTransferDate: day('2026-07-01'),
  sellerPartyIds: [D],
  costs: [
    { id: '0000ffff-0000-4000-8000-000000000051', category: 'REAL_ESTATE_TRANSFER_TAX', amount: eur('15000.00'), paymentStatus: 'PAID' },
    { id: '0000ffff-0000-4000-8000-000000000052', category: 'NOTARY', amount: eur('3000.00'), paymentStatus: 'PAID' },
    { id: '0000ffff-0000-4000-8000-000000000053', category: 'FINANCING_RELATED', amount: eur('1200.00'), paymentStatus: 'PAID' },
  ],
  allocation: {
    id: '0000bbbb-0000-4000-8000-000000000030',
    method: 'PURCHASE_CONTRACT',
    reviewState: 'CONFIRMED',
    totalAllocableAmount: eur('318000.00'),
    buildingAmount: eur('254400.00'),
  },
  ...overrides,
});

let ownershipCounter = 0;
export const ownership = (partyId: string, share: string, validFrom: string, validUntil: string | null, acquisitionId: string | null): ScheduleOwnership => {
  const [numerator, denominator] = share.split('/').map(Number) as [number, number];
  ownershipCounter += 1;
  return {
    id: `0000abab-0000-4000-8000-${String(ownershipCounter).padStart(12, '0')}`,
    partyId,
    share: { numerator, denominator },
    validFrom: day(validFrom),
    validUntil: validUntil === null ? null : day(validUntil),
    acquisitionId,
  };
};

/** A 3/5 and B 2/5 of W from 2026-07-01 (ACC8). */
export const acc8 = (overrides: Partial<ScheduleInput> = {}): ScheduleInput => ({
  asset: asset(),
  acquisitions: [acquisition({ acquiredShare: { numerator: 1, denominator: 1 } })],
  ownerships: [ownership(A, '3/5', '2026-07-01', null, W), ownership(B, '2/5', '2026-07-01', null, W)],
  today: day('2026-10-30'),
  from: 2026,
  to: 2027,
  ownerPartyId: null,
  ...overrides,
});
