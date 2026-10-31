import { sql, type Transaction } from 'kysely';
import {
  normalizeQuantity,
  type AnnualStatement,
  type Classification,
  type ClassificationSource,
  type CostGroup,
  type ReserveSection,
  type StatementStatus,
  type WegAnnualStatementId,
} from '../../domains/weg/index.js';
import { Money, type BusinessDate } from '../../shared/index.js';
import { fromNumericAmount } from './money-column.js';
import type { Database } from './schema.js';

/** The rows of the Jahresabrechnung port (api-design.md §50): statements, cost lines, the stored reserve, their reads and their mapping. */

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const date = <C extends string>(column: C) => sql<string>`to_char(${sql.ref(column)}, 'YYYY-MM-DD')`.as(column);
export const optionalDate = <C extends string>(column: C) => sql<string | null>`to_char(${sql.ref(column)}, 'YYYY-MM-DD')`.as(column);
const amount = <C extends string>(column: C) => sql<string>`${sql.ref(column)}::text`.as(column);
const optionalAmount = <C extends string>(column: C) => sql<string | null>`${sql.ref(column)}::text`.as(column);

/** Every column, Money as exact text and dates as `YYYY-MM-DD`. */
export const COLUMNS = [
  'id',
  'mre_realm_id',
  'membership_id',
  'financial_year',
  date('period_from'),
  date('period_until'),
  optionalDate('document_date'),
  optionalDate('resolution_date'),
  optionalDate('due_date'),
  'supersedes_id',
  'superseded_by_id',
  amount('recoverable_subtotal'),
  amount('non_recoverable_subtotal'),
  amount('total_costs'),
  amount('hausgeld_requested'),
  amount('hausgeld_paid'),
  optionalAmount('reserve_requested'),
  optionalAmount('reserve_paid'),
  amount('settlement_peak'),
  optionalAmount('settlement_result'),
  'reserve',
  'status',
  'confirmed_at',
  'voided_at',
  'void_reason',
  'source_references',
  'notes',
  'created_at',
  'version',
] as const;

export const LINE_COLUMNS = [
  'statement_id',
  'position',
  'account',
  'cost_group',
  'allocation_key',
  optionalAmount('allocation_total'),
  optionalAmount('allocation_share'),
  amount('total_amount'),
  amount('unit_share'),
  'classification',
  'classification_source',
] as const;

export interface StatementRow {
  id: string;
  mre_realm_id: string;
  membership_id: string;
  financial_year: number;
  period_from: string;
  period_until: string;
  document_date: string | null;
  resolution_date: string | null;
  due_date: string | null;
  supersedes_id: string | null;
  superseded_by_id: string | null;
  recoverable_subtotal: string;
  non_recoverable_subtotal: string;
  total_costs: string;
  hausgeld_requested: string;
  hausgeld_paid: string;
  reserve_requested: string | null;
  reserve_paid: string | null;
  settlement_peak: string;
  settlement_result: string | null;
  reserve: unknown;
  status: string;
  confirmed_at: Date | null;
  voided_at: Date | null;
  void_reason: string | null;
  source_references: string[];
  notes: string | null;
  created_at: Date;
  version: number;
}

export interface LineRow {
  statement_id: string;
  position: number;
  account: string;
  cost_group: string;
  allocation_key: string;
  allocation_total: string | null;
  allocation_share: string | null;
  total_amount: string;
  unit_share: string;
  classification: string;
  classification_source: string;
}

type MoneyJson = { amount: string; currency: string } | null;

/** The reserve section as stored in `reserve` (jsonb), Money as its JSON. */
export interface StoredReserve {
  source: ReserveSection['source'];
  lines: {
    position: number;
    description: string;
    kind: string;
    opening: MoneyJson;
    addition: MoneyJson;
    withdrawal: MoneyJson;
    closing: MoneyJson;
    /** VC-7-03 (§58B): absent on lines stored before, and on lines without one. */
    date?: string;
  }[];
  unitShareOpening: MoneyJson;
  unitShareClosing: MoneyJson;
}

export async function readOne(trx: Transaction<Database>, id: string): Promise<AnnualStatement> {
  return toStatement(trx, await trx.selectFrom('weg_annual_statement').select(COLUMNS).where('id', '=', id).executeTakeFirstOrThrow());
}

export async function toStatement(trx: Transaction<Database>, row: StatementRow): Promise<AnnualStatement> {
  return toDomain(row, await trx.selectFrom('weg_statement_cost_line').select(LINE_COLUMNS).where('statement_id', '=', row.id).execute());
}

const money = (value: string) => fromNumericAmount(value, 'EUR');
const moneyOrNull = (value: string | null) => (value === null ? null : money(value));
const fromJson = (json: MoneyJson) => (json === null ? null : Money.fromJSON(json));
const toJson = (m: Money | null): MoneyJson => (m === null ? null : m.toJSON());

export function toStoredReserve(reserve: ReserveSection): StoredReserve {
  return {
    source: reserve.source,
    lines: reserve.lines.map((l) => ({
      position: l.position,
      description: l.description,
      kind: l.kind,
      opening: toJson(l.opening),
      addition: toJson(l.addition),
      withdrawal: toJson(l.withdrawal),
      closing: toJson(l.closing),
      ...(l.date === null || l.date === undefined ? {} : { date: l.date }),
    })),
    unitShareOpening: toJson(reserve.unitShareOpening),
    unitShareClosing: toJson(reserve.unitShareClosing),
  };
}

/** The stored `reserve` jsonb as the domain's section (also read by Taxation, §58B, without the cost lines). */
export const reserveFromJson = (stored: unknown): ReserveSection | null => (stored === null ? null : fromStoredReserve(stored as StoredReserve));

function fromStoredReserve(stored: StoredReserve): ReserveSection {
  return {
    source: stored.source,
    lines: stored.lines.map((l) => ({
      position: l.position,
      description: l.description,
      kind: l.kind as ReserveSection['lines'][number]['kind'],
      opening: fromJson(l.opening),
      addition: fromJson(l.addition),
      withdrawal: fromJson(l.withdrawal),
      closing: fromJson(l.closing),
      date: (l.date ?? null) as BusinessDate | null,
    })),
    unitShareOpening: fromJson(stored.unitShareOpening),
    unitShareClosing: fromJson(stored.unitShareClosing),
  };
}

export function toDomain(row: StatementRow, lines: readonly LineRow[]): AnnualStatement {
  return {
    id: row.id as WegAnnualStatementId,
    mreRealmId: row.mre_realm_id,
    membershipId: row.membership_id,
    financialYear: row.financial_year,
    periodFrom: row.period_from as BusinessDate,
    periodUntil: row.period_until as BusinessDate,
    documentDate: row.document_date as BusinessDate | null,
    resolutionDate: row.resolution_date as BusinessDate | null,
    dueDate: row.due_date as BusinessDate | null,
    supersedes: row.supersedes_id,
    supersededBy: row.superseded_by_id,
    recoverableSubtotal: money(row.recoverable_subtotal),
    nonRecoverableSubtotal: money(row.non_recoverable_subtotal),
    totalCosts: money(row.total_costs),
    hausgeldRequested: money(row.hausgeld_requested),
    hausgeldPaid: money(row.hausgeld_paid),
    reserveRequested: moneyOrNull(row.reserve_requested),
    reservePaid: moneyOrNull(row.reserve_paid),
    settlementPeak: money(row.settlement_peak),
    settlementResult: moneyOrNull(row.settlement_result),
    costLines: [...lines]
      .sort((a, b) => a.position - b.position)
      .map((l) => ({
        position: l.position,
        account: l.account,
        group: l.cost_group as CostGroup,
        allocationKey: l.allocation_key,
        allocationTotal: l.allocation_total === null ? null : normalizeQuantity(l.allocation_total),
        allocationShare: l.allocation_share === null ? null : normalizeQuantity(l.allocation_share),
        totalAmount: money(l.total_amount),
        unitShare: money(l.unit_share),
        classification: l.classification as Classification,
        classificationSource: l.classification_source as ClassificationSource,
      })),
    reserve: row.reserve === null ? null : fromStoredReserve(row.reserve as StoredReserve),
    status: row.status as StatementStatus,
    confirmedAt: row.confirmed_at,
    voidedAt: row.voided_at,
    voidReason: row.void_reason,
    sourceReferences: row.source_references,
    notes: row.notes,
    createdAt: row.created_at,
    version: row.version,
  };
}

/** The created rows as JSON for the idempotency store: timestamps as ISO strings. */
interface StatementSnapshot {
  readonly row: Omit<StatementRow, 'created_at' | 'confirmed_at' | 'voided_at'> & { readonly created_at: string };
  readonly lines: readonly LineRow[];
}

export async function snapshotOf(trx: Transaction<Database>, id: string): Promise<StatementSnapshot> {
  const {
    created_at,
    confirmed_at: _confirmed,
    voided_at: _voided,
    ...row
  } = await trx.selectFrom('weg_annual_statement').select(COLUMNS).where('id', '=', id).executeTakeFirstOrThrow();
  const lines = await trx.selectFrom('weg_statement_cost_line').select(LINE_COLUMNS).where('statement_id', '=', id).execute();
  return { row: { ...row, created_at: created_at.toISOString() }, lines };
}

/** Written by snapshotOf in the same codebase, so its shape is trusted; a created statement is a `DRAFT`. */
export function fromSnapshot(result: unknown): AnnualStatement {
  const { row, lines } = result as StatementSnapshot;
  return toDomain({ ...row, created_at: new Date(row.created_at), confirmed_at: null, voided_at: null }, lines);
}
