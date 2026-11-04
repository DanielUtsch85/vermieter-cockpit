import { sql, type Transaction } from 'kysely';
import type { CostLineGroup, HausgeldInput } from '../../domains/taxation/index.js';
import type { BusinessDate } from '../../shared/index.js';
import { fromNumericAmount } from './money-column.js';
import type { Database } from './schema.js';
import { currentOfCostLines } from './tax-classification-rows.js';

/**
 * What the anschaffungsnahe check reads of the Hausgeld around one PropertyReference (api-design.md §58M, VC-X-27), in
 * the caller's snapshot: the `CONFIRMED` statements of its memberships with their cost lines and each line's current
 * classification, and its `ACTIVE` memberships (for the financial years that need a statement). Reads only; the check
 * decides which statements and lines it reads (the read range, the rule's `judgedLines`). The view never reads this.
 */
export async function hausgeldContextOf(trx: Transaction<Database>, mreRealmId: string, propertyReferenceId: string): Promise<HausgeldInput> {
  const members = await trx
    .selectFrom('weg_membership as m')
    .innerJoin('weg as w', 'w.id', 'm.weg_id')
    .select([
      'm.id',
      'm.status',
      sql<string>`to_char(m.valid_from, 'YYYY-MM-DD')`.as('valid_from'),
      sql<string | null>`to_char(m.valid_until, 'YYYY-MM-DD')`.as('valid_until'),
      'w.financial_year_start_month',
    ])
    .where('m.mre_realm_id', '=', mreRealmId)
    .where('m.property_reference_id', '=', propertyReferenceId)
    .orderBy('m.id')
    .execute();
  if (members.length === 0) return { statements: [], memberships: [] };
  const statements = await trx
    .selectFrom('weg_annual_statement')
    .select([
      'id',
      'membership_id',
      'financial_year',
      sql<string>`to_char(period_from, 'YYYY-MM-DD')`.as('period_from'),
      sql<string>`to_char(period_until, 'YYYY-MM-DD')`.as('period_until'),
    ])
    .where('mre_realm_id', '=', mreRealmId)
    .where(
      'membership_id',
      'in',
      members.map((m) => m.id),
    )
    .where('status', '=', 'CONFIRMED')
    .orderBy('id')
    .execute();
  const ids = statements.map((s) => s.id);
  const lines =
    ids.length === 0
      ? []
      : await trx
          .selectFrom('weg_statement_cost_line')
          .select(['statement_id', 'position', 'account', 'classification', sql<string>`unit_share::text`.as('unit_share'), 'currency'])
          .where('statement_id', 'in', ids)
          .orderBy('statement_id')
          .orderBy('position')
          .execute();
  const current = await currentOfCostLines(trx, ids);
  return {
    statements: statements.map((s) => ({
      id: s.id,
      membershipId: s.membership_id,
      financialYear: s.financial_year,
      periodFrom: s.period_from as BusinessDate,
      periodUntil: s.period_until as BusinessDate,
      lines: lines
        .filter((l) => l.statement_id === s.id)
        .map((l) => ({
          position: l.position,
          account: l.account,
          classification: l.classification as CostLineGroup,
          unitShare: fromNumericAmount(l.unit_share, l.currency),
          current: current.get(`${s.id}/${l.position}`) ?? null,
        })),
    })),
    memberships: members
      .filter((m) => m.status === 'ACTIVE')
      .map((m) => ({
        id: m.id,
        validFrom: m.valid_from as BusinessDate,
        validUntil: m.valid_until as BusinessDate | null,
        financialYearStartMonth: m.financial_year_start_month,
      })),
  };
}
