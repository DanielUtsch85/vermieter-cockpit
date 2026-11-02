import type { NewTaxClassification, Performance } from '../../domains/taxation/index.js';
import type { BusinessDate } from '../../shared/index.js';

/**
 * §59F (VC-X-38): the fixtures of the repository tests state the period of performance a classification needs (a
 * capitalised building item, a capitalisation on the check, a summed source of the check). By default the work was
 * performed on the source's own date, so every figure stays where it was before VC-X-38; a test that is about the
 * performance passes its own (or `null`). Synthetic data only.
 */

interface Queryable {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

const INTEREST_LINES = ['LOAN_INTEREST', 'FINANCING_COSTS'];

/** Whether the classification takes a performance at all (the API's rule and 0058's CHECK; interest never). */
export const takesPerformance = (c: Pick<NewTaxClassification, 'sourceType' | 'taxCategory' | 'treatment'>) =>
  c.sourceType !== 'DEPOSIT_CLOSING' &&
  c.treatment !== 'NOT_RELEVANT' &&
  c.treatment !== null &&
  !INTEREST_LINES.includes(c.taxCategory) &&
  (c.taxCategory === 'MAINTENANCE' || c.taxCategory === 'WEG_SPENDING' || c.treatment === 'CAPITALIZED');

/** The source's own date (booking, withdrawal or use date); `null` for a split whose financial category is interest. */
export async function sourceDateOf(db: Queryable, c: Pick<NewTaxClassification, 'sourceType' | 'sourceId' | 'sourcePosition'>): Promise<BusinessDate | null> {
  if (c.sourceType === 'TRANSACTION_SPLIT') {
    const { rows } = await db.query(
      `SELECT to_char(t.booking_date, 'YYYY-MM-DD') AS d, fc.code AS code FROM transaction_split s
         JOIN ledger_transaction t ON t.id = s.transaction_id JOIN financial_category fc ON fc.id = s.financial_category_id WHERE s.id = $1`,
      [c.sourceId],
    );
    const row = rows[0];
    return row === undefined || INTEREST_LINES.includes(row['code'] as string) ? null : (row['d'] as BusinessDate);
  }
  if (c.sourceType === 'WEG_ASSESSMENT_USE') {
    const { rows } = await db.query(
      `SELECT u ->> 'date' AS d FROM weg_special_assessment a, jsonb_array_elements(a.uses) u WHERE a.id = $1 AND (u ->> 'position')::int = $2`,
      [c.sourceId, c.sourcePosition ?? 0],
    );
    return (rows[0]?.['d'] as BusinessDate | undefined) ?? null;
  }
  if (c.sourceType === 'WEG_RESERVE_WITHDRAWAL') {
    const { rows } = await db.query(
      `SELECT coalesce(l ->> 'date', to_char(st.period_until, 'YYYY-MM-DD')) AS d
         FROM weg_annual_statement st, jsonb_array_elements(coalesce(st.reserve -> 'lines', '[]'::jsonb)) l
        WHERE st.id = $1 AND (l ->> 'position')::int = $2`,
      [c.sourceId, c.sourcePosition ?? 0],
    );
    return (rows[0]?.['d'] as BusinessDate | undefined) ?? null;
  }
  return null;
}

/** The classification with a performance on its source's date, unless it states one (or `null`) or takes none. */
export async function performedOnSourceDate<C extends NewTaxClassification>(db: Queryable, c: C): Promise<C> {
  if (c.performance !== undefined || !takesPerformance(c)) return c;
  const date = await sourceDateOf(db, c);
  const performance: Performance | null = date === null ? null : { from: date, until: date, progress: [], progressEstimated: null };
  return performance === null ? c : { ...c, performance };
}
