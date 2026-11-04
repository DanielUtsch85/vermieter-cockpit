import type { Kysely } from 'kysely';
import type { NewStatementCostLine } from '../../domains/weg/index.js';
import { Money, type AuditActor, type BusinessDate } from '../../shared/index.js';
import type { Database } from './schema.js';
import { PostgresWegAnnualStatementRepository } from './weg-annual-statement-repository.js';

/**
 * §58M (VC-X-27, M7; Entscheidung des Projektinhabers, 2026-11-04): the anschaffungsnahe check of a WEG member is final
 * only once every financial year of its read range (S to W + 365 days) has a `CONFIRMED` statement and every
 * `NON_RECOVERABLE` line is judged. The acceptance tests whose claims need a final check file these statements: one
 * `RECOVERABLE` line each (nothing to judge) unless `costLines` are given, the periods from `firstFrom` in the first year.
 * The subtotals are the lines' sums. Synthetic. Test support only.
 */
export async function confirmedStatementsOf(
  db: Kysely<Database>,
  input: {
    readonly mreRealmId: string;
    readonly membershipId: string;
    readonly years: readonly number[];
    readonly firstFrom?: string;
    readonly costLines?: readonly NewStatementCostLine[];
  },
  actor: AuditActor,
  at: Date,
): Promise<string[]> {
  const statements = new PostgresWegAnnualStatementRepository(db);
  const eur = (amount: string) => Money.of(amount, 'EUR');
  const ids: string[] = [];
  const lines: readonly NewStatementCostLine[] = input.costLines ?? [
    {
      position: 1,
      account: 'Hausmeister (synthetisch)',
      group: 'RECOVERABLE',
      allocationKey: 'MEA',
      allocationTotal: null,
      allocationShare: null,
      totalAmount: eur('800.00'),
      unitShare: eur('100.00'),
      classification: null,
    },
  ];
  const sum = (group?: string) => lines.filter((l) => group === undefined || l.group === group).reduce((total, l) => total.add(l.unitShare), eur('0.00'));
  for (const [i, year] of input.years.entries()) {
    const created = await statements.createStatement(
      {
        mreRealmId: input.mreRealmId,
        membershipId: input.membershipId,
        financialYear: year,
        periodFrom: (i === 0 && input.firstFrom !== undefined ? input.firstFrom : `${year}-01-01`) as BusinessDate,
        periodUntil: `${year}-12-31` as BusinessDate,
        documentDate: null,
        resolutionDate: null,
        dueDate: null,
        supersedes: null,
        costLines: [...lines],
        recoverableSubtotal: sum('RECOVERABLE'),
        nonRecoverableSubtotal: sum('NON_RECOVERABLE'),
        totalCosts: sum(),
        hausgeldRequested: sum(),
        hausgeldPaid: sum(),
        reserveRequested: null,
        reservePaid: null,
        settlementPeak: eur('0.00'),
        settlementResult: null,
        reserve: null,
        sourceReferences: [],
        notes: null,
      },
      actor,
    );
    if (created.kind !== 'CREATED') throw new Error(JSON.stringify(created));
    const confirmed = await statements.confirmStatement(created.statement.id, input.mreRealmId, at, actor);
    if (confirmed.kind !== 'CONFIRMED') throw new Error(JSON.stringify(confirmed));
    ids.push(created.statement.id);
  }
  return ids;
}
