import { sql, type Transaction } from 'kysely';
import { componentIdOf, type CapitalizedItem, type ItemRef } from '../../domains/depreciation/index.js';
import { capitalizedItemsOf, type CapitalizedSource, type CapitalizedSourceInput, type ViewOwnership } from '../../domains/taxation/index.js';
import { moneyOfCents, centsOf, type BusinessDate } from '../../shared/index.js';
import type { Database } from './schema.js';

/**
 * Where Depreciation and Taxation meet (api-design.md §59B "no cycle", P8-D11): the capitalised items of a
 * PropertyReference, derived by Taxation (`capitalizedItemsOf`, the tax-year view's own functions) and handed to
 * Depreciation as its own input type (`CapitalizedItem`), inside the caller's transaction, so the schedule's snapshot
 * holds them too. The sources are read by a reader the caller passes in (the tax repository's `capitalizedSources`):
 * this module imports no repository, so the tax repository can reach it later without a module cycle (§58C "VC-8-05").
 */

/**
 * The counting sources of a PropertyReference whose current classification is `CAPITALIZED` (every year), and the
 * sources named in `also` whatever their meaning (a separate asset's links, §59B "Later, on read"), each with its
 * classification's `anschaffungsnaheAcquisitionId`.
 */
export type CapitalizedSourcesReader = (
  trx: Transaction<Database>,
  mreRealmId: string,
  propertyReferenceId: string,
  today: BusinessDate,
  also: readonly ItemRef[],
) => Promise<readonly CapitalizedSourceInput[]>;

/** A `CapitalizedSource` of Taxation as Depreciation's `CapitalizedItem`: a field-for-field copy. */
export function toCapitalizedItem(source: CapitalizedSource, propertyReferenceId: string): CapitalizedItem {
  return {
    sourceType: source.sourceType,
    sourceId: source.sourceId,
    sourcePosition: source.sourcePosition,
    propertyReferenceId: source.propertyReferenceId ?? propertyReferenceId,
    date: source.date,
    dateSource: source.dateSource,
    taxYear: source.taxYear,
    lineAmount: source.lineAmount,
    netAmount: source.netAmount,
    classificationId: source.classificationId,
    reviewState: source.reviewState,
    taxCategory: source.taxCategory,
    anschaffungsnaheAcquisitionId: source.anschaffungsnaheAcquisitionId,
    loan: source.loan === null ? null : { loanId: source.loan.loanId, allocationSetId: source.loan.allocationSetId, share: source.loan.share },
    constructionPeriodInterestId: source.constructionPeriodInterestId,
    counts: source.counts,
    treatment: source.treatment,
    parts: source.parts.map((p) => ({ participant: p.participant, ownershipIds: p.ownershipIds, share: p.share, amount: p.amount })),
    flags: source.flags,
  };
}

/** A source named by a link that Taxation no longer places in `capitalized`: its meaning, without parts (not computed). */
function linkedOnly(input: CapitalizedSourceInput, propertyReferenceId: string): CapitalizedItem {
  const m = input.meaning;
  const split = m.sourceType === 'TRANSACTION_SPLIT';
  const cents = centsOf(m.amount);
  return {
    sourceType: m.sourceType,
    sourceId: m.sourceId,
    sourcePosition: split ? null : m.sourcePosition,
    propertyReferenceId: m.propertyReferenceId ?? propertyReferenceId,
    date: split ? m.bookingDate : m.date,
    dateSource: split ? 'BOOKING' : m.dateSource,
    taxYear: m.taxYear,
    lineAmount: moneyOfCents(split && m.direction === 'INFLOW' ? -cents : cents, m.amount.currency),
    netAmount: m.netAmount,
    classificationId: m.classificationId,
    reviewState: m.reviewState,
    taxCategory: m.taxCategory,
    anschaffungsnaheAcquisitionId: input.anschaffungsnaheAcquisitionId,
    counts: m.counts,
    treatment: m.treatment,
    parts: [],
    flags: [],
  };
}

const keyOf = (ref: { readonly sourceType: string; readonly sourceId: string; readonly sourcePosition: number | null }) => componentIdOf(ref as ItemRef);

/**
 * The capitalised items of the PropertyReference over every year (§59B), with §58C's parts over its `VALID`
 * Ownerships, plus the items named in `also` that are no longer capitalised. In the caller's transaction.
 */
export async function capitalizedItemsIn(
  trx: Transaction<Database>,
  mreRealmId: string,
  propertyReferenceId: string,
  today: BusinessDate,
  capitalizedSources: CapitalizedSourcesReader,
  also: readonly ItemRef[] = [],
): Promise<CapitalizedItem[]> {
  const sources = await capitalizedSources(trx, mreRealmId, propertyReferenceId, today, also);
  const ownerships = await trx
    .selectFrom('ownership')
    .select([
      'id',
      'owner_party_id',
      'share_numerator',
      'share_denominator',
      sql<string>`to_char(valid_from, 'YYYY-MM-DD')`.as('valid_from'),
      sql<string | null>`to_char(valid_until, 'YYYY-MM-DD')`.as('valid_until'),
    ])
    .where('mre_realm_id', '=', mreRealmId)
    .where('property_reference_id', '=', propertyReferenceId)
    .where('status', '=', 'VALID')
    .orderBy('id')
    .execute();
  const view: ViewOwnership[] = ownerships.map((o) => ({
    id: o.id,
    partyId: o.owner_party_id,
    share: { numerator: o.share_numerator, denominator: o.share_denominator },
    validFrom: o.valid_from as BusinessDate,
    validUntil: o.valid_until as BusinessDate | null,
  }));
  // §59E "Exactly once": the two reads of the sources are disjoint (0027), so a source twice is an internal error,
  // never a second component.
  const keys = sources.map(({ meaning: m }) =>
    keyOf({ sourceType: m.sourceType, sourceId: m.sourceId, sourcePosition: m.sourceType === 'TRANSACTION_SPLIT' ? null : m.sourcePosition }),
  );
  const twice = keys.find((k, i) => keys.indexOf(k) !== i);
  if (twice !== undefined)
    throw new Error(`Capitalised source ${twice} read twice for PropertyReference ${propertyReferenceId} (api-design §59E: exactly once)`);
  const items = capitalizedItemsOf(sources, view, propertyReferenceId).map((s) => toCapitalizedItem(s, propertyReferenceId));
  const known = new Set(items.map(keyOf));
  const wanted = new Set(also.map(keyOf));
  for (const input of sources) {
    const m = input.meaning;
    const key = keyOf({ sourceType: m.sourceType, sourceId: m.sourceId, sourcePosition: m.sourceType === 'TRANSACTION_SPLIT' ? null : m.sourcePosition });
    if (wanted.has(key) && !known.has(key)) {
      items.push(linkedOnly(input, propertyReferenceId));
      known.add(key);
    }
  }
  return items;
}
