import type { ColumnType, Generated } from 'kysely';

/**
 * Kysely table types for the DE database, matching the migrations. Snake_case
 * columns stay inside infrastructure; repositories map them to domain types.
 */

/** jsonb: written as a JSON string, read back parsed by `pg`. */
type Json<T> = ColumnType<T, string, string>;

export interface PropertyReferenceTable {
  id: Generated<string>;
  mre_realm_id: string;
  mre_property_id: string;
  external_reference_state: string;
  display_name: string | null;
  cached_address: Json<Record<string, string> | null> | null;
  /** NUMERIC: written and read as a decimal string. */
  cached_surface: string | null;
  last_refreshed_at: Date | null;
  created_at: Generated<Date>;
  created_by: string;
  updated_at: Generated<Date>;
  version: Generated<number>;
}

export interface AuditRecordTable {
  id: Generated<string>;
  entity_type: string;
  entity_id: string;
  action: string;
  occurred_at: Generated<Date>;
  actor_type: 'USER' | 'SYSTEM';
  actor_id: string | null;
  metadata: Json<Record<string, unknown> | null> | null;
  previous_version: number | null;
  new_version: number | null;
}

export interface Database {
  property_reference: PropertyReferenceTable;
  audit_record: AuditRecordTable;
}
