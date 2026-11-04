import { sql, type Transaction } from 'kysely';
import {
  costLineNotCounted,
  costLineRuleOn,
  planCostLineClassification,
  type CostLineFacts,
  type CostLineGroup,
  type CreateClassificationOutcome,
  type NewTaxClassification,
  type RuleRef,
  type RuleRegistry,
  type TaxClassification,
  type WegNotCounted,
} from '../../domains/taxation/index.js';
import type { BusinessDate, Money } from '../../shared/index.js';
import { fromNumericAmount } from './money-column.js';
import type { Database } from './schema.js';

/**
 * The classification of a WEG statement cost line (api-design.md §58M, VC-X-27): the create's plan and §57's source
 * state. Statement → classification (P7-D9, as a withdrawal's): the statement row is written first (a no-op), then the
 * line is read and the current classification of the line is taken `FOR UPDATE`.
 */

/** The cost line at `position` of the statement `statementId`, with its statement; `undefined` without such a line. */
async function costLineFactsOf(trx: Transaction<Database>, mreRealmId: string, statementId: string, position: number): Promise<CostLineFacts | undefined> {
  const row = await trx
    .selectFrom('weg_statement_cost_line as l')
    .innerJoin('weg_annual_statement as st', 'st.id', 'l.statement_id')
    .innerJoin('weg_membership as m', 'm.id', 'st.membership_id')
    .select([
      'st.id',
      'st.status',
      'st.superseded_by_id',
      sql<string>`to_char(st.period_from, 'YYYY-MM-DD')`.as('period_from'),
      sql<string>`to_char(st.period_until, 'YYYY-MM-DD')`.as('period_until'),
      'm.property_reference_id',
      'l.position',
      'l.account',
      'l.classification',
      sql<string>`l.unit_share::text`.as('unit_share'),
      'l.currency',
    ])
    .where('l.statement_id', '=', statementId)
    .where('l.position', '=', position)
    .where('st.mre_realm_id', '=', mreRealmId)
    .executeTakeFirst();
  if (row === undefined) return undefined;
  return {
    statementId: row.id,
    status: row.status,
    supersededBy: row.superseded_by_id,
    periodFrom: row.period_from as BusinessDate,
    periodUntil: row.period_until as BusinessDate,
    propertyReferenceId: row.property_reference_id,
    position: row.position,
    account: row.account,
    classification: row.classification as CostLineGroup,
    unitShare: fromNumericAmount(row.unit_share, row.currency),
  };
}

export type CostLinePlan =
  | {
      readonly kind: 'PLANNED';
      readonly current: { readonly id: string; readonly version: number } | undefined;
      readonly rule: RuleRef;
      readonly costLine: { readonly unitShare: Money };
    }
  | Exclude<CreateClassificationOutcome, { readonly kind: 'CREATED' | 'REPLAYED' }>;

/** A create's plan for a cost line (§58M), in §58B's order of checks; nothing written but the statement's no-op. */
export async function planCostLine(trx: Transaction<Database>, registry: RuleRegistry, classification: NewTaxClassification): Promise<CostLinePlan> {
  const realm = classification.mreRealmId;
  const position = classification.sourcePosition ?? null;
  const locked = await trx
    .updateTable('weg_annual_statement')
    .set((eb) => ({ version: eb.ref('version') }))
    .where('id', '=', classification.sourceId)
    .where('mre_realm_id', '=', realm)
    .returning('id')
    .executeTakeFirst();
  if (locked === undefined || position === null) return { kind: 'SOURCE_NOT_FOUND' };
  // Read after the lock, in new statements: a confirm or supersede committed meanwhile is seen.
  const facts = await costLineFactsOf(trx, realm, locked.id, position);
  if (facts === undefined) return { kind: 'SOURCE_NOT_FOUND' };
  const current = await trx
    .selectFrom('tax_classification')
    .select(['id', 'version'])
    .where('weg_annual_statement_id', '=', locked.id)
    .where('weg_cost_line_position', '=', position)
    .where('superseded_at', 'is', null)
    .forUpdate()
    .executeTakeFirst();
  const plan = planCostLineClassification(facts, current?.id ?? null, classification, registry);
  if (plan.kind !== 'CLASSIFY') return plan;
  return { kind: 'PLANNED', current, rule: plan.rule, costLine: plan.costLine };
}

/** §57's source state of a cost line's classification: whether its line and statement still count (read without a lock). */
export async function costLineNotCountedOf(trx: Transaction<Database>, registry: RuleRegistry, current: TaxClassification): Promise<WegNotCounted | null> {
  // The line exists while its classification does (0068's foreign key), and a confirmed statement's lines never change.
  const facts = await costLineFactsOf(trx, current.mreRealmId, current.sourceId, current.sourcePosition ?? 0);
  if (facts === undefined) throw new Error(`TaxClassification ${current.id}: its cost line is gone`);
  return costLineNotCounted(facts, costLineRuleOn(registry, facts.periodUntil)?.parameters.hausgeldMaintenance?.judgedLines);
}
