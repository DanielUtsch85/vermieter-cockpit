import type { Kysely } from 'kysely';
import type { CategoryType, FinancialCategory, FinancialCategoryRepository } from '../../domains/ledger/index.js';
import type { Database } from './schema.js';

/** Read-only access to the seeded category catalog (migration 0008). */
export class PostgresFinancialCategoryRepository implements FinancialCategoryRepository {
  constructor(private readonly db: Kysely<Database>) {}

  async list(): Promise<readonly FinancialCategory[]> {
    const rows = await this.db.selectFrom('financial_category').selectAll().orderBy('active', 'desc').orderBy('code').execute();
    return rows.map(toDomain);
  }

  async findByCode(code: string): Promise<FinancialCategory | undefined> {
    const row = await this.db.selectFrom('financial_category').selectAll().where('code', '=', code).executeTakeFirst();
    return row === undefined ? undefined : toDomain(row);
  }
}

function toDomain(row: { code: string; name: string; category_type: string; active: boolean }): FinancialCategory {
  return { code: row.code, name: row.name, categoryType: row.category_type as CategoryType, active: row.active };
}
