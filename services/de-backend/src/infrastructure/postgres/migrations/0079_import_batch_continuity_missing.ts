import { sql, type Kysely } from 'kysely';

/**
 * VC-X-77 (api-design.md §32.1a, data-model.md §70.6; Entscheidung des Projektinhabers, 2026-11-16): why a batch has no
 * continuity report. `NO_BALANCE_COLUMN`: the file was read without a balance column (version 1, or version 2 without
 * `balanceAfter`); `NO_ROW_WITH_BALANCE`: the column was read, but no valid row had a balance. `NULL` while a report
 * exists, and for version 2 batches stored before this migration, whose reason was never recorded. A report and a
 * reason never together. Version 1 has no balance column at all, so its earlier batches without a report get
 * `NO_BALANCE_COLUMN`; nothing else is changed.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE import_batch
      ADD COLUMN continuity_missing text,
      ADD CONSTRAINT import_batch_continuity_missing_value
        CHECK (continuity_missing IN ('NO_BALANCE_COLUMN', 'NO_ROW_WITH_BALANCE')),
      ADD CONSTRAINT import_batch_continuity_or_missing
        CHECK (continuity IS NULL OR continuity_missing IS NULL)
  `.execute(db);
  await sql`
    UPDATE import_batch SET continuity_missing = 'NO_BALANCE_COLUMN'
    WHERE continuity IS NULL AND adapter_id = 'generic-csv' AND adapter_version = '1'
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE import_batch DROP COLUMN continuity_missing`.execute(db);
}
