import type { PurchaseMethod } from '../../domains/depreciation/index.js';
import type { BusinessDate } from '../../shared/index.js';

/**
 * §59C (VC-X-37): a purchase computes only under a confirmed `STANDARD` method entry. The fixtures of the tests that
 * build a computable purchase record one with the asset (create or amend); nothing else about them changes. Synthetic.
 */
export const standardMethod = (acquisitionId: string, overrides: Partial<PurchaseMethod> = {}): PurchaseMethod => ({
  acquisitionId,
  consideration: 'PAID',
  method: 'LINEAR_7_4',
  specialDepreciation: [],
  subsidiesReceived: false,
  newBuildingByConversion: false,
  otherSpecialCase: false,
  otherSpecialCaseNote: null,
  evidence: { source: 'Kaufvertrag und Anlage V (synthetisch)', date: '2026-06-15' as BusinessDate, documentReference: null },
  reviewState: 'CONFIRMED',
  advisorPartyId: null,
  notes: null,
  ...overrides,
});

/** The same entry as an API body names it (§59C "API"). */
export const standardMethodBody = (acquisitionId: string, overrides: Record<string, unknown> = {}) => ({
  acquisitionId,
  consideration: 'PAID',
  method: 'LINEAR_7_4',
  specialDepreciation: [],
  subsidiesReceived: false,
  newBuildingByConversion: false,
  otherSpecialCase: false,
  evidence: { source: 'Kaufvertrag und Anlage V (synthetisch)', date: '2026-06-15' },
  reviewState: 'CONFIRMED',
  ...overrides,
});
