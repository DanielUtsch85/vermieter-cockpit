import type { Kysely } from 'kysely';
import {
  deriveDepositTaxMeaning,
  type DepositTaxMeaning,
  type RuleRegistry,
  type TaxListItem,
  type TaxMeaning,
  type TaxMeaningFilter,
  type TaxPage,
  type TaxPageRequest,
  type WegTaxMeaning,
} from '../../domains/taxation/index.js';
import type { BusinessDate } from '../../shared/index.js';
import type { Database } from './schema.js';
import { UUID, currentOfDeposits } from './tax-classification-rows.js';
import { factsQuery, meaningsOf, toRead, depositFactsOf } from './tax-source-facts.js';
import { effectsOf, splitWithEffects, wegWithEffects } from './tax-treatment-effects.js';
import { taxYearSnapshot, yearItems } from './tax-year-reads.js';

/** The meanings (§55, §58A, §58B): of one split, deposit, withdrawal or use, and the per-property list of a year. */

export async function findTaxMeaning(
  db: Kysely<Database>,
  registry: RuleRegistry,
  splitId: string,
  mreRealmId: string,
  today: BusinessDate,
): Promise<TaxMeaning | undefined> {
  if (!UUID.test(splitId)) return undefined;
  return db
    .transaction()
    .setIsolationLevel('repeatable read')
    .setAccessMode('read only')
    .execute(async (trx) => {
      const row = await factsQuery(trx, mreRealmId).where('s.id', '=', splitId).executeTakeFirst();
      if (row === undefined) return undefined;
      const [pair] = await meaningsOf(trx, registry, mreRealmId, [toRead(row)], today);
      if (pair === undefined) return undefined;
      const effects = await effectsOf(trx, registry, mreRealmId, pair.meaning.propertyReferenceId, today);
      return splitWithEffects(pair, effects);
    });
}

export async function findDepositTaxMeaning(
  db: Kysely<Database>,
  registry: RuleRegistry,
  depositId: string,
  mreRealmId: string,
  today: BusinessDate,
): Promise<DepositTaxMeaning | undefined> {
  if (!UUID.test(depositId)) return undefined;
  return db
    .transaction()
    .setIsolationLevel('repeatable read')
    .setAccessMode('read only')
    .execute(async (trx) => {
      const [facts] = await depositFactsOf(trx, mreRealmId, [depositId]);
      if (facts === undefined) return undefined;
      const current = await currentOfDeposits(trx, [depositId]);
      return deriveDepositTaxMeaning(facts, current.get(depositId) ?? null, registry, today);
    });
}

/** One `REPEATABLE READ READ ONLY` snapshot (§58B): the source of the Realm, with its parts and the check's flags. */
export async function wegMeaning(
  db: Kysely<Database>,
  registry: RuleRegistry,
  table: 'weg_annual_statement' | 'weg_special_assessment',
  sourceType: 'WEG_RESERVE_WITHDRAWAL' | 'WEG_ASSESSMENT_USE',
  sourceId: string,
  position: number,
  mreRealmId: string,
  today: BusinessDate,
): Promise<WegTaxMeaning | undefined> {
  if (!UUID.test(sourceId)) return undefined;
  return db
    .transaction()
    .setIsolationLevel('repeatable read')
    .setAccessMode('read only')
    .execute(async (trx) => {
      const row = await trx
        .selectFrom(table)
        .innerJoin('weg_membership as m', 'm.id', `${table}.membership_id`)
        .select('m.property_reference_id')
        .where(`${table}.id`, '=', sourceId)
        .where(`${table}.mre_realm_id`, '=', mreRealmId)
        .executeTakeFirst();
      if (row === undefined) return undefined;
      const effects = await effectsOf(trx, registry, mreRealmId, row.property_reference_id, today);
      const facts = effects.weg.facts.find((f) => f.sourceType === sourceType && f.sourceId === sourceId && f.sourcePosition === position);
      return facts === undefined ? undefined : wegWithEffects(registry, facts, effects, today);
    });
}

export async function listTaxMeanings(
  db: Kysely<Database>,
  registry: RuleRegistry,
  propertyReferenceId: string,
  mreRealmId: string,
  year: number,
  filter: TaxMeaningFilter,
  page: TaxPageRequest,
  today: BusinessDate,
): Promise<TaxPage<TaxListItem> | undefined> {
  if (!UUID.test(propertyReferenceId)) return undefined;
  return taxYearSnapshot(db, async (trx) => {
    const reference = await trx
      .selectFrom('property_reference')
      .select('id')
      .where('id', '=', propertyReferenceId)
      .where('mre_realm_id', '=', mreRealmId)
      .executeTakeFirst();
    if (reference === undefined) return undefined;
    const { entries } = await yearItems(trx, registry, mreRealmId, propertyReferenceId, year, today);
    const filtered = entries
      .filter((e) => e.listed)
      .map((e) => e.item)
      .filter(
        (m) =>
          (filter.reviewStates === undefined || filter.reviewStates.length === 0 || filter.reviewStates.includes(m.reviewState)) &&
          (filter.origins === undefined || filter.origins.length === 0 || filter.origins.includes(m.origin)) &&
          (filter.taxCategories === undefined || filter.taxCategories.length === 0 || filter.taxCategories.includes(m.taxCategory)) &&
          (filter.sourceTypes === undefined || filter.sourceTypes.length === 0 || filter.sourceTypes.includes(m.sourceType)),
      );
    const pageItems = filtered.slice((page.page - 1) * page.pageSize, page.page * page.pageSize);
    return { items: pageItems, page: page.page, pageSize: page.pageSize, total: filtered.length };
  });
}
