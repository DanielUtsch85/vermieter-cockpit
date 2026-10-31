import { sql, type Transaction } from 'kysely';
import {
  meaFromColumns,
  type MembershipStatus,
  type Weg,
  type WegId,
  type WegMembership,
  type WegMembershipId,
  type WegStatus,
} from '../../domains/weg/index.js';
import type { BusinessDate } from '../../shared/index.js';
import type { Database } from './schema.js';

/** The WEG and membership rows of the WEG port (api-design.md §49.1–§49.2), their reads and their mapping. */

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const WEG_ENTITY = 'Weg';
export const MEMBERSHIP_ENTITY = 'WegMembership';

export const WEG_COLUMNS = [
  'id',
  'mre_realm_id',
  'status',
  'display_name',
  'administrator_party_id',
  'financial_year_start_month',
  'notes',
  'voided_at',
  'void_reason',
  'created_at',
  'version',
] as const;

export interface WegRow {
  id: string;
  mre_realm_id: string;
  status: string;
  display_name: string;
  administrator_party_id: string | null;
  financial_year_start_month: number;
  notes: string | null;
  voided_at: Date | null;
  void_reason: string | null;
  created_at: Date;
  version: number;
}

/** Every column, the MEA as exact text and the dates as `YYYY-MM-DD`. */
export const MEMBERSHIP_COLUMNS = [
  'id',
  'mre_realm_id',
  'weg_id',
  'property_reference_id',
  sql<string>`mea_numerator::text`.as('mea_numerator'),
  sql<string>`mea_denominator::text`.as('mea_denominator'),
  sql<string>`to_char(valid_from, 'YYYY-MM-DD')`.as('valid_from'),
  sql<string | null>`to_char(valid_until, 'YYYY-MM-DD')`.as('valid_until'),
  'status',
  'voided_at',
  'void_reason',
  'source_references',
  'notes',
  'created_at',
  'version',
] as const;

export interface MembershipRow {
  id: string;
  mre_realm_id: string;
  weg_id: string;
  property_reference_id: string;
  mea_numerator: string;
  mea_denominator: string;
  valid_from: string;
  valid_until: string | null;
  status: string;
  voided_at: Date | null;
  void_reason: string | null;
  source_references: string[];
  notes: string | null;
  created_at: Date;
  version: number;
}

/** Thrown inside the transaction to roll back the key claim and every write together. */
export class Rejected<T extends { readonly kind: string }> extends Error {
  constructor(readonly outcome: T) {
    super(outcome.kind);
  }
}

export async function readWeg(trx: Transaction<Database>, id: string): Promise<Weg> {
  return toWeg(await trx.selectFrom('weg').select(WEG_COLUMNS).where('id', '=', id).executeTakeFirstOrThrow());
}

export async function readMembership(trx: Transaction<Database>, id: string): Promise<WegMembership> {
  return toMembership(await trx.selectFrom('weg_membership').select(MEMBERSHIP_COLUMNS).where('id', '=', id).executeTakeFirstOrThrow());
}

export function toWeg(row: WegRow): Weg {
  return {
    id: row.id as WegId,
    mreRealmId: row.mre_realm_id,
    status: row.status as WegStatus,
    displayName: row.display_name,
    administratorPartyId: row.administrator_party_id,
    financialYearStartMonth: row.financial_year_start_month,
    notes: row.notes,
    voidedAt: row.voided_at,
    voidReason: row.void_reason,
    createdAt: row.created_at,
    version: row.version,
  };
}

export function toMembership(row: MembershipRow): WegMembership {
  return {
    id: row.id as WegMembershipId,
    mreRealmId: row.mre_realm_id,
    wegId: row.weg_id,
    propertyReferenceId: row.property_reference_id,
    mea: meaFromColumns(row.mea_numerator, row.mea_denominator),
    validFrom: row.valid_from as BusinessDate,
    validUntil: row.valid_until as BusinessDate | null,
    status: row.status as MembershipStatus,
    voidedAt: row.voided_at,
    voidReason: row.void_reason,
    sourceReferences: row.source_references,
    notes: row.notes,
    createdAt: row.created_at,
    version: row.version,
  };
}

/** A created record as JSON for the idempotency store; timestamps as ISO strings. */
type Snapshot<T extends { readonly createdAt: Date; readonly voidedAt: Date | null }> = Omit<T, 'createdAt' | 'voidedAt'> & {
  readonly createdAt: string;
  readonly voidedAt: string | null;
};

export function toWegSnapshot(weg: Weg): Snapshot<Weg> {
  return { ...weg, createdAt: weg.createdAt.toISOString(), voidedAt: weg.voidedAt?.toISOString() ?? null };
}

/** Written by toWegSnapshot in the same codebase, so its shape is trusted. */
export function fromWegSnapshot(result: unknown): Weg {
  const snapshot = result as Snapshot<Weg>;
  return { ...snapshot, createdAt: new Date(snapshot.createdAt), voidedAt: snapshot.voidedAt === null ? null : new Date(snapshot.voidedAt) };
}

export function toMembershipSnapshot(membership: WegMembership): Snapshot<WegMembership> {
  return { ...membership, createdAt: membership.createdAt.toISOString(), voidedAt: membership.voidedAt?.toISOString() ?? null };
}

export function fromMembershipSnapshot(result: unknown): WegMembership {
  const snapshot = result as Snapshot<WegMembership>;
  return { ...snapshot, createdAt: new Date(snapshot.createdAt), voidedAt: snapshot.voidedAt === null ? null : new Date(snapshot.voidedAt) };
}
