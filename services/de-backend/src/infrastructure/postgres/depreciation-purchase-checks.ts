import type { Transaction } from 'kysely';
import type { PurchaseCheckFacts, ScheduleRead } from '../../domains/depreciation/index.js';
import { TAX_RULES } from '../../domains/tax-rules/index.js';
import type { AnschaffungsnaheCheck, NotFinalReason } from '../../domains/taxation/index.js';
import type { BusinessDate, RuleRegistry } from '../../shared/index.js';
import type { Database } from './schema.js';
import { effectsOf } from './tax-treatment-effects.js';

const notFinalFor = (c: AnschaffungsnaheCheck, reason: NotFinalReason) => c.flags.some((f) => f.code === 'NOT_FINAL' && f.details.reasons.includes(reason));

/**
 * What the release stage reads of the anschaffungsnahe checks (VC-X-45, A1, 236-4; §58B): each Acquisition's check
 * status, its open flag `WEG_HAUSGELD_MAINTENANCE_NOT_COUNTED`, whether it is not final for `WEG_STATEMENT_MISSING` (from the window's first year) and its summed sources' treatments, from Taxation's derivation (`effectsOf`, the check's own
 * functions) in the caller's transaction, as Depreciation's plain `PurchaseCheckFacts`. Only for a building with a
 * purchase (a separate asset has no purchase component). Reads only; never an input of a figure or a fingerprint.
 */
export async function purchaseChecksIn(
  trx: Transaction<Database>,
  read: ScheduleRead,
  mreRealmId: string,
  today: BusinessDate,
  registry: RuleRegistry = TAX_RULES,
): Promise<readonly PurchaseCheckFacts[]> {
  if (read.asset.assetType !== 'BUILDING' || read.acquisitions.length === 0) return [];
  const { checks } = await effectsOf(trx, registry, mreRealmId, read.asset.propertyReferenceId, today);
  return checks.map((c) => ({
    acquisitionId: c.acquisitionId,
    status: c.status,
    wegHausgeldMaintenanceNotCounted: c.flags.some((f) => f.code === 'WEG_HAUSGELD_MAINTENANCE_NOT_COUNTED'),
    // §58M (Entscheidung des Projektinhabers, 2026-11-05): not final for a missing statement, from the window's first year.
    wegStatementMissingFrom: c.window !== null && notFinalFor(c, 'WEG_STATEMENT_MISSING') ? Number(c.window.from.slice(0, 4)) : null,
    // 236-4: the summed sources (the lower bound's list, §59F) with their current treatment.
    summedSources: c.sources.map((e) => ({ taxYear: e.taxYear, treatment: e.treatment })),
  }));
}
