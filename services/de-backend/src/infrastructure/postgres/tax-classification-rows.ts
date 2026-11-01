import { sql, type Transaction } from 'kysely';
import {
  wegSourceKey,
  type SourceType,
  type StoredReviewState,
  type TaxCategory,
  type TaxClassification,
  type TaxClassificationId,
  type Treatment,
  type WegSourceFacts,
} from '../../domains/taxation/index.js';
import type { BusinessDate } from '../../shared/index.js';
import { fromNumericAmount } from './money-column.js';
import type { Database } from './schema.js';

/** The TaxClassification rows (§55–§58B): columns, mapping, the idempotency snapshot, and the current classification of each source. */

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const ENTITY_TYPE = 'TaxClassification';

export const COLUMNS = [
  'id',
  'mre_realm_id',
  'source_type',
  'transaction_split_id',
  'security_deposit_id',
  'weg_annual_statement_id',
  'weg_reserve_position',
  sql<string | null>`weg_withdrawal_unit_share::text`.as('weg_withdrawal_unit_share'),
  'weg_special_assessment_id',
  'weg_use_position',
  sql<string | null>`to_char(weg_use_date, 'YYYY-MM-DD')`.as('weg_use_date'),
  sql<string | null>`weg_use_unit_share::text`.as('weg_use_unit_share'),
  'tax_category',
  'treatment',
  'review_state',
  'rule_code',
  'rule_version',
  'treatment_rule_code',
  'treatment_rule_version',
  'advisor_party_id',
  'notes',
  'source_references',
  'tax_year',
  'refund_of_year',
  sql<string | null>`to_char(deposit_closing_date, 'YYYY-MM-DD')`.as('deposit_closing_date'),
  sql<string | null>`deposit_retained_amount::text`.as('deposit_retained_amount'),
  sql<string | null>`net_amount::text`.as('net_amount'),
  'annually_recurring',
  'distribution_years',
  'mostly_residential_confirmed',
  'anschaffungsnahe_acquisition_id',
  'construction_period_interest_id',
  'supersedes_id',
  'superseded_by',
  'superseded_at',
  'created_at',
  'created_by',
  'version',
] as const;

interface ClassificationRow {
  id: string;
  mre_realm_id: string;
  source_type: string;
  transaction_split_id: string | null;
  security_deposit_id: string | null;
  weg_annual_statement_id: string | null;
  weg_reserve_position: number | null;
  weg_withdrawal_unit_share: string | null;
  weg_special_assessment_id: string | null;
  weg_use_position: number | null;
  weg_use_date: string | null;
  weg_use_unit_share: string | null;
  tax_category: string;
  treatment: string | null;
  review_state: string;
  rule_code: string;
  rule_version: number;
  treatment_rule_code: string | null;
  treatment_rule_version: number | null;
  advisor_party_id: string | null;
  notes: string | null;
  source_references: string[];
  tax_year: number | null;
  refund_of_year: number | null;
  deposit_closing_date: string | null;
  deposit_retained_amount: string | null;
  net_amount: string | null;
  annually_recurring: boolean;
  distribution_years: number | null;
  mostly_residential_confirmed: boolean | null;
  anschaffungsnahe_acquisition_id: string | null;
  construction_period_interest_id: string | null;
  supersedes_id: string | null;
  superseded_by: string | null;
  superseded_at: Date | null;
  created_at: Date;
  created_by: string;
  version: number;
}

/** The current classification of each WEG source, by `sourceType/sourceId/position`. */
export async function currentOfWeg(trx: Transaction<Database>, facts: readonly WegSourceFacts[]): Promise<Map<string, TaxClassification>> {
  const statements = [...new Set(facts.filter((f) => f.sourceType === 'WEG_RESERVE_WITHDRAWAL').map((f) => f.sourceId))];
  const assessments = [...new Set(facts.filter((f) => f.sourceType === 'WEG_ASSESSMENT_USE').map((f) => f.sourceId))];
  if (statements.length === 0 && assessments.length === 0) return new Map();
  const rows = await trx
    .selectFrom('tax_classification')
    .select(COLUMNS)
    .where('superseded_at', 'is', null)
    .where((eb) =>
      eb.or([
        ...(statements.length === 0 ? [] : [eb('weg_annual_statement_id', 'in', statements)]),
        ...(assessments.length === 0 ? [] : [eb('weg_special_assessment_id', 'in', assessments)]),
      ]),
    )
    .execute();
  return new Map(rows.map((r) => toDomain(r)).map((c) => [wegSourceKey(c), c]));
}

/** The current classification of each split. */
export async function currentOf(trx: Transaction<Database>, splitIds: readonly string[]): Promise<Map<string, TaxClassification>> {
  if (splitIds.length === 0) return new Map();
  const rows = await trx
    .selectFrom('tax_classification')
    .select(COLUMNS)
    .where('transaction_split_id', 'in', [...splitIds])
    .where('superseded_at', 'is', null)
    .execute();
  return new Map(rows.map((r) => [r.transaction_split_id as string, toDomain(r)]));
}

/** The current classification of each deposit. */
export async function currentOfDeposits(trx: Transaction<Database>, depositIds: readonly string[]): Promise<Map<string, TaxClassification>> {
  if (depositIds.length === 0) return new Map();
  const rows = await trx
    .selectFrom('tax_classification')
    .select(COLUMNS)
    .where('security_deposit_id', 'in', [...depositIds])
    .where('superseded_at', 'is', null)
    .execute();
  return new Map(rows.map((r) => [r.security_deposit_id as string, toDomain(r)]));
}

export async function readOne(trx: Transaction<Database>, id: string): Promise<TaxClassification> {
  return toDomain(await trx.selectFrom('tax_classification').select(COLUMNS).where('id', '=', id).executeTakeFirstOrThrow());
}

const eurOrNull = (amount: string | null) => (amount === null ? null : fromNumericAmount(amount, 'EUR'));

export function toDomain(row: ClassificationRow): TaxClassification {
  return {
    id: row.id as TaxClassificationId,
    mreRealmId: row.mre_realm_id,
    sourceType: row.source_type as SourceType,
    sourceId: (row.transaction_split_id ?? row.security_deposit_id ?? row.weg_annual_statement_id ?? row.weg_special_assessment_id) as string,
    taxCategory: row.tax_category as TaxCategory,
    treatment: row.treatment as Treatment | null,
    reviewState: row.review_state as StoredReviewState,
    rule: { ruleCode: row.rule_code, version: row.rule_version },
    advisorPartyId: row.advisor_party_id,
    notes: row.notes,
    sourceReferences: row.source_references,
    taxYear: row.tax_year,
    refundOfYear: row.refund_of_year,
    depositClosing:
      row.deposit_closing_date === null || row.deposit_retained_amount === null
        ? null
        : { closingDate: row.deposit_closing_date as BusinessDate, retainedAmount: fromNumericAmount(row.deposit_retained_amount, 'EUR') },
    sourcePosition: row.weg_reserve_position ?? row.weg_use_position,
    reserveWithdrawal: row.weg_withdrawal_unit_share === null ? null : { unitShare: fromNumericAmount(row.weg_withdrawal_unit_share, 'EUR') },
    assessmentUse:
      row.weg_use_date === null || row.weg_use_unit_share === null
        ? null
        : { date: row.weg_use_date as BusinessDate, unitShare: fromNumericAmount(row.weg_use_unit_share, 'EUR') },
    netAmount: eurOrNull(row.net_amount),
    annuallyRecurring: row.annually_recurring,
    distributionYears: row.distribution_years,
    mostlyResidentialConfirmed: row.mostly_residential_confirmed,
    anschaffungsnaheAcquisitionId: row.anschaffungsnahe_acquisition_id,
    constructionPeriodInterestId: row.construction_period_interest_id,
    treatmentRule:
      row.treatment_rule_code === null || row.treatment_rule_version === null
        ? null
        : { ruleCode: row.treatment_rule_code, version: row.treatment_rule_version },
    supersedes: row.supersedes_id,
    supersededBy: row.superseded_by,
    supersededAt: row.superseded_at,
    createdAt: row.created_at,
    createdBy: row.created_by,
    version: row.version,
  };
}

/** The columns a snapshot of an earlier item may lack: read as null (or false). */
type LaterColumns =
  | 'security_deposit_id'
  | 'tax_year'
  | 'refund_of_year'
  | 'deposit_closing_date'
  | 'deposit_retained_amount'
  | 'weg_annual_statement_id'
  | 'weg_reserve_position'
  | 'weg_withdrawal_unit_share'
  | 'weg_special_assessment_id'
  | 'weg_use_position'
  | 'weg_use_date'
  | 'weg_use_unit_share'
  | 'net_amount'
  | 'annually_recurring'
  | 'distribution_years'
  | 'mostly_residential_confirmed'
  | 'anschaffungsnahe_acquisition_id'
  | 'treatment_rule_code'
  | 'treatment_rule_version'
  | 'construction_period_interest_id';

/** The created row as JSON for the idempotency store. Snapshots of VC-7-01/-02 lack the later fields (read as null). */
interface ClassificationSnapshot {
  readonly row: Omit<ClassificationRow, 'created_at' | 'superseded_at' | LaterColumns> &
    Partial<Pick<ClassificationRow, LaterColumns>> & {
      readonly created_at: string;
    };
}

export function toSnapshot(c: TaxClassification): ClassificationSnapshot {
  return {
    row: {
      id: c.id,
      mre_realm_id: c.mreRealmId,
      source_type: c.sourceType,
      transaction_split_id: c.sourceType === 'TRANSACTION_SPLIT' ? c.sourceId : null,
      security_deposit_id: c.sourceType === 'DEPOSIT_CLOSING' ? c.sourceId : null,
      weg_annual_statement_id: c.sourceType === 'WEG_RESERVE_WITHDRAWAL' ? c.sourceId : null,
      weg_reserve_position: c.sourceType === 'WEG_RESERVE_WITHDRAWAL' ? c.sourcePosition : null,
      weg_withdrawal_unit_share: c.reserveWithdrawal?.unitShare.amount ?? null,
      weg_special_assessment_id: c.sourceType === 'WEG_ASSESSMENT_USE' ? c.sourceId : null,
      weg_use_position: c.sourceType === 'WEG_ASSESSMENT_USE' ? c.sourcePosition : null,
      weg_use_date: c.assessmentUse?.date ?? null,
      weg_use_unit_share: c.assessmentUse?.unitShare.amount ?? null,
      tax_category: c.taxCategory,
      treatment: c.treatment,
      review_state: c.reviewState,
      rule_code: c.rule.ruleCode,
      rule_version: c.rule.version,
      treatment_rule_code: c.treatmentRule?.ruleCode ?? null,
      treatment_rule_version: c.treatmentRule?.version ?? null,
      advisor_party_id: c.advisorPartyId,
      notes: c.notes,
      source_references: [...c.sourceReferences],
      tax_year: c.taxYear,
      refund_of_year: c.refundOfYear,
      deposit_closing_date: c.depositClosing?.closingDate ?? null,
      deposit_retained_amount: c.depositClosing?.retainedAmount.amount ?? null,
      net_amount: c.netAmount?.amount ?? null,
      annually_recurring: c.annuallyRecurring,
      distribution_years: c.distributionYears,
      mostly_residential_confirmed: c.mostlyResidentialConfirmed,
      anschaffungsnahe_acquisition_id: c.anschaffungsnaheAcquisitionId,
      // §59E: only when set, so a snapshot of an earlier classification keeps its shape.
      ...(c.constructionPeriodInterestId === null ? {} : { construction_period_interest_id: c.constructionPeriodInterestId }),
      supersedes_id: c.supersedes,
      superseded_by: c.supersededBy,
      created_at: c.createdAt.toISOString(),
      created_by: c.createdBy,
      version: c.version,
    },
  };
}

/** Written by toSnapshot in the same codebase, so its shape is trusted; a created classification is current. */
export function fromSnapshot(result: unknown): TaxClassification {
  const { row } = result as ClassificationSnapshot;
  return toDomain({
    ...row,
    security_deposit_id: row.security_deposit_id ?? null,
    tax_year: row.tax_year ?? null,
    refund_of_year: row.refund_of_year ?? null,
    deposit_closing_date: row.deposit_closing_date ?? null,
    deposit_retained_amount: row.deposit_retained_amount ?? null,
    weg_annual_statement_id: row.weg_annual_statement_id ?? null,
    weg_reserve_position: row.weg_reserve_position ?? null,
    weg_withdrawal_unit_share: row.weg_withdrawal_unit_share ?? null,
    weg_special_assessment_id: row.weg_special_assessment_id ?? null,
    weg_use_position: row.weg_use_position ?? null,
    weg_use_date: row.weg_use_date ?? null,
    weg_use_unit_share: row.weg_use_unit_share ?? null,
    net_amount: row.net_amount ?? null,
    annually_recurring: row.annually_recurring ?? false,
    distribution_years: row.distribution_years ?? null,
    mostly_residential_confirmed: row.mostly_residential_confirmed ?? null,
    anschaffungsnahe_acquisition_id: row.anschaffungsnahe_acquisition_id ?? null,
    treatment_rule_code: row.treatment_rule_code ?? null,
    treatment_rule_version: row.treatment_rule_version ?? null,
    construction_period_interest_id: row.construction_period_interest_id ?? null,
    created_at: new Date(row.created_at),
    superseded_at: null,
  });
}
