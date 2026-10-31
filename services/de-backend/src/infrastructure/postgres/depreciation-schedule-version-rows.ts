import { sql, type RawBuilder, type Transaction } from 'kysely';
import {
  centsText,
  type NewScheduleVersion,
  type PartRateKind,
  type ScheduleVersion,
  type ScheduleVersionStatus,
  type VersionComponent,
  type VersionInputs,
  type VersionPart,
} from '../../domains/depreciation/index.js';
import type { BusinessDate } from '../../shared/index.js';
import type { Database } from './schema.js';

/**
 * The rows of a recorded schedule version (api-design.md §60, migration 0052): one multi-row insert per table, and the
 * version read back row by row. Amounts are `numeric(14,2)` (cents in the domain), fractions two `bigint`s, months the
 * `date` of their first day. Raw SQL: the eight tables are written and read here only.
 */

type Trx = Transaction<Database>;
const cents = (text: string): bigint => {
  const negative = text.startsWith('-');
  const [whole, fraction = ''] = text.replace('-', '').split('.') as [string, string?];
  const value = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0').slice(0, 2));
  return negative ? -value : value;
};
const frac = (n: string | number, d: string | number) => `${n}/${d}`;
const split = (f: string) => f.split('/') as [string, string];
const monthDate = (month: string) => `${month}-01`;

/** Inserts `rows` with one statement per chunk (`values` gives a row's values in `columns`' order). */
async function insertRows<T>(trx: Trx, table: string, columns: readonly string[], rows: readonly T[], values: (row: T) => readonly RawBuilder<unknown>[]) {
  for (let i = 0; i < rows.length; i += 1000) {
    const chunk = rows.slice(i, i + 1000);
    await sql`INSERT INTO ${sql.table(table)} (${sql.join(columns.map((c) => sql.ref(c)))}) VALUES ${sql.join(
      chunk.map((row) => sql`(${sql.join(values(row))})`),
    )}`.execute(trx);
  }
}
const v = (value: unknown, type?: string): RawBuilder<unknown> => (type === undefined ? sql`${value}` : sql`${value}::${sql.raw(type)}`);

/** Writes the version's header and rows; returns its id. The guards of 0052 check the rest. */
export async function insertVersion(trx: Trx, mreRealmId: string, versionNumber: number, version: NewScheduleVersion, id?: string): Promise<string> {
  const a = version.inputs.asset;
  const { rows } = await sql<{ id: string }>`
    INSERT INTO depreciation_schedule_version (id, mre_realm_id, asset_id, property_reference_id, version_number, status, from_year, through_year,
      computed_on, calculation_version, currency, asset_type, depreciation_method, building_completion_year, description, useful_life_years,
      acquired_on, asset_review_state, asset_version, input_fingerprint, output_fingerprint, reason, recorded_by)
    VALUES (coalesce(${id ?? null}::uuid, gen_random_uuid()), ${mreRealmId}, ${version.assetId}, ${version.propertyReferenceId}, ${versionNumber}, 'CURRENT', ${version.fromYear}, ${version.throughYear},
      ${version.computedOn}, ${version.calculationVersion}, ${version.inputs.currency}, ${a.assetType}, ${a.depreciationMethod}, ${a.buildingCompletionYear},
      ${a.description}, ${a.usefulLifeYears}, ${a.acquiredOn}, ${a.reviewState}, ${a.assetVersion}, ${version.inputFingerprint}, ${version.outputFingerprint},
      ${version.reason}, ${version.recordedBy})
    RETURNING id
  `.execute(trx);
  const versionId = (rows[0] as { id: string }).id;
  const head = [v(versionId, 'uuid'), v(mreRealmId)];
  await insertRows(
    trx,
    'depreciation_schedule_version_rule',
    ['version_id', 'mre_realm_id', 'rule_code', 'rule_version', 'rule_version_hash', 'first_year', 'last_year'],
    version.inputs.rules,
    (r) => [...head, v(r.ruleCode), v(r.version), v(r.ruleVersionHash), v(r.firstYear), v(r.lastYear)],
  );
  await insertRows(trx, 'depreciation_schedule_version_component', COMPONENT_COLUMNS, version.inputs.components, (c) => [
    ...head,
    v(version.propertyReferenceId, 'uuid'),
    ...componentValues(c),
  ]);
  const parts = version.inputs.components.flatMap((c) => c.parts.map((p) => ({ c, p })));
  await insertRows(trx, 'depreciation_schedule_version_part', PART_COLUMNS, parts, ({ c, p }) => [...head, v(c.componentId), ...partValues(p)]);
  const fractions = parts.flatMap(({ c, p }) => p.fractions.map((f) => ({ c, p, f })));
  await insertRows(
    trx,
    'depreciation_schedule_version_fraction',
    ['version_id', 'mre_realm_id', 'component_id', 'part_key', 'month', 'fraction_numerator', 'fraction_denominator'],
    fractions,
    ({ c, p, f }) => [
      ...head,
      v(c.componentId),
      v(p.partKey),
      v(monthDate(f.month), 'date'),
      v(split(f.fraction)[0], 'bigint'),
      v(split(f.fraction)[1], 'bigint'),
    ],
  );
  await insertRows(
    trx,
    'depreciation_schedule_version_year',
    ['version_id', 'mre_realm_id', 'year', 'amount', 'residual_value', 'input_fingerprint', 'output_fingerprint'],
    version.years,
    (y) => [...head, v(y.year), v(centsText(y.amount), 'numeric'), v(centsText(y.residualValue), 'numeric'), v(y.inputFingerprint), v(y.outputFingerprint)],
  );
  await insertRows(
    trx,
    'depreciation_schedule_entry',
    [
      'version_id',
      'mre_realm_id',
      'year',
      'component_id',
      'part_key',
      'months',
      'fraction_numerator',
      'fraction_denominator',
      'amount',
      'cumulative',
      'residual_value',
    ],
    version.entries,
    (e) => [
      ...head,
      v(e.year),
      v(e.componentId),
      v(e.partKey),
      v(e.months),
      v(e.fraction === null ? null : split(e.fraction)[0], 'bigint'),
      v(e.fraction === null ? null : split(e.fraction)[1], 'bigint'),
      v(centsText(e.amount), 'numeric'),
      v(centsText(e.cumulative), 'numeric'),
      v(centsText(e.residualValue), 'numeric'),
    ],
  );
  await insertRows(
    trx,
    'depreciation_schedule_version_flag',
    ['version_id', 'mre_realm_id', 'year', 'component_id', 'part_key', 'code', 'level'],
    version.flags,
    (f) => [...head, v(f.year, 'integer'), v(f.componentId, 'text'), v(f.partKey, 'text'), v(f.code), v(f.level)],
  );
  return versionId;
}

const COMPONENT_COLUMNS = [
  'version_id', 'mre_realm_id', 'property_reference_id', 'component_id', 'kind', 'position', 'basis_amount', 'start_date', 'start_date_source',
  'start_method', 'start_month', 'rate_kind', 'useful_life_years', 'acquisition_id', 'purchase_price', 'counted_cost_ids', 'counted_costs_total',
  'excluded_cost_ids', 'excluded_costs_total', 'allocation_id', 'allocation_review_state', 'total_allocable_amount', 'building_amount',
  'shorter_life_review_state', 'source_type', 'source_id', 'source_position', 'classification_id', 'classification_review_state', 'tax_category',
  'item_date', 'item_date_source', 'item_tax_year', 'anschaffungsnahe_acquisition_id',
]; // prettier-ignore

function componentValues(c: VersionComponent): RawBuilder<unknown>[] {
  const q = c.acquisition;
  const i = c.item;
  const money = (x: bigint | undefined) => v(x === undefined ? null : centsText(x), 'numeric');
  return [
    v(c.componentId), v(c.kind), v(c.position), money(c.basis), v(c.start.date, 'date'), v(c.start.dateSource), v(c.start.method),
    v(c.start.month === null ? null : monthDate(c.start.month), 'date'), v(c.rate.kind), v(c.rate.usefulLifeYears, 'integer'),
    v(q?.acquisitionId ?? null, 'uuid'), money(q?.purchasePrice), v(q === null ? null : q.countedCostIds, 'uuid[]'), money(q?.countedCostsTotal),
    v(q === null ? null : q.excludedCostIds, 'uuid[]'), money(q?.excludedCostsTotal), v(q?.allocationId ?? null, 'uuid'), v(q?.allocationReviewState ?? null, 'text'),
    money(q?.totalAllocableAmount), money(q?.buildingAmount), v(q?.shorterLifeReviewState ?? null, 'text'),
    v(i?.sourceType ?? null, 'text'), v(i?.sourceId ?? null, 'uuid'), v(i?.sourcePosition ?? null, 'integer'), v(i?.classificationId ?? null, 'uuid'),
    v(i?.classificationReviewState ?? null, 'text'), v(i?.taxCategory ?? null, 'text'), v(i?.itemDate ?? null, 'date'), v(i?.itemDateSource ?? null, 'text'),
    v(i?.itemTaxYear ?? null, 'integer'), v(i?.anschaffungsnaheAcquisitionId ?? null, 'uuid'),
  ]; // prettier-ignore
}

const PART_COLUMNS = [
  'version_id', 'mre_realm_id', 'component_id', 'part_key', 'owner_party_id', 'ownership_ids', 'share_numerator', 'share_denominator',
  'weight_numerator', 'weight_denominator', 'basis_amount', 'first_month', 'rate_kind', 'useful_life_years', 'tenure_from', 'last_day',
  'last_day_source', 'pool_key',
]; // prettier-ignore

function partValues(p: VersionPart): RawBuilder<unknown>[] {
  return [
    v(p.partKey), v(p.ownerPartyId, 'uuid'), v(p.ownershipIds, 'uuid[]'), v(split(p.share)[0], 'bigint'), v(split(p.share)[1], 'bigint'),
    v(split(p.weight)[0], 'bigint'), v(split(p.weight)[1], 'bigint'), v(centsText(p.basis), 'numeric'), v(monthDate(p.firstMonth), 'date'),
    v(p.rateKind), v(p.usefulLifeYears, 'integer'), v(p.tenureFrom, 'date'), v(p.lastDay, 'date'), v(p.lastDaySource, 'text'), v(p.poolKey, 'text'),
  ]; // prettier-ignore
}

// ---------------------------------------------------------------------------------------------------------------------
// Reading a version back

type Row = Record<string, unknown>;
const text = (x: unknown) => x as string;
const day = (x: unknown) => (x === null ? null : (x as string)) as BusinessDate | null;
const month = (x: unknown) => (x as string).slice(0, 7);
const num = (x: unknown) => (x === null ? null : Number(x));

/** The header columns, dates as text and amounts as text (exact). */
export const HEADER = sql`v.id, v.asset_id, v.property_reference_id, v.version_number, v.status, v.superseded_by_id, v.superseded_at, v.from_year,
  v.through_year, to_char(v.computed_on, 'YYYY-MM-DD') AS computed_on, v.calculation_version, v.currency, v.asset_type, v.depreciation_method,
  v.building_completion_year, v.description, v.useful_life_years, to_char(v.acquired_on, 'YYYY-MM-DD') AS acquired_on, v.asset_review_state,
  v.asset_version, v.input_fingerprint, v.output_fingerprint, v.reason, v.recorded_at, v.recorded_by, v.version,
  (SELECT p.id FROM depreciation_schedule_version p WHERE p.asset_id = v.asset_id AND p.version_number = v.version_number - 1) AS supersedes_id`;

/** The whole version (`full`), or its header, rule rows and year rows only (the list, §60 "Reads"). */
export async function readVersions(trx: Trx, headers: readonly Row[], full: boolean): Promise<ScheduleVersion[]> {
  if (headers.length === 0) return [];
  const ids = headers.map((h) => text(h['id']));
  const of = async (query: RawBuilder<Row>) => (await query.execute(trx)).rows;
  const where = sql`version_id = ANY(${ids}::uuid[])`;
  const rules = await of(sql`SELECT * FROM depreciation_schedule_version_rule WHERE ${where} ORDER BY rule_code, rule_version`);
  const years = await of(sql`SELECT version_id, year, amount::text AS amount, residual_value::text AS residual_value, input_fingerprint, output_fingerprint
    FROM depreciation_schedule_version_year WHERE ${where} ORDER BY year`);
  const components = full
    ? await of(sql`SELECT *, basis_amount::text AS basis, purchase_price::text AS price, counted_costs_total::text AS counted, excluded_costs_total::text AS excluded,
        total_allocable_amount::text AS total, building_amount::text AS building, to_char(start_date, 'YYYY-MM-DD') AS start_day,
        to_char(start_month, 'YYYY-MM') AS start_ym, to_char(item_date, 'YYYY-MM-DD') AS item_day
        FROM depreciation_schedule_version_component WHERE ${where} ORDER BY position`)
    : [];
  const parts = full
    ? await of(sql`SELECT *, basis_amount::text AS basis, to_char(first_month, 'YYYY-MM') AS first_ym, to_char(tenure_from, 'YYYY-MM-DD') AS tenure_day,
        to_char(last_day, 'YYYY-MM-DD') AS last_day_text FROM depreciation_schedule_version_part WHERE ${where} ORDER BY component_id, part_key`)
    : [];
  const fractions = full
    ? await of(sql`SELECT version_id, component_id, part_key, to_char(month, 'YYYY-MM') AS month, fraction_numerator, fraction_denominator
        FROM depreciation_schedule_version_fraction WHERE ${where} ORDER BY month`)
    : [];
  const entries = full
    ? await of(sql`SELECT version_id, year, component_id, part_key, months, fraction_numerator, fraction_denominator, amount::text AS amount,
        cumulative::text AS cumulative, residual_value::text AS residual_value FROM depreciation_schedule_entry WHERE ${where}
        ORDER BY year, component_id, part_key`)
    : [];
  const flags = full
    ? await of(sql`SELECT * FROM depreciation_schedule_version_flag WHERE ${where} ORDER BY year NULLS FIRST, code, component_id, part_key`)
    : [];
  return headers.map((h) => {
    const id = text(h['id']);
    const mine = (rows: readonly Row[]) => rows.filter((r) => r['version_id'] === id);
    const inputs: VersionInputs = {
      currency: text(h['currency']),
      asset: {
        assetType: text(h['asset_type']),
        depreciationMethod: text(h['depreciation_method']),
        buildingCompletionYear: num(h['building_completion_year']),
        description: h['description'] as string | null,
        usefulLifeYears: num(h['useful_life_years']),
        acquiredOn: day(h['acquired_on']),
        reviewState: text(h['asset_review_state']),
        assetVersion: Number(h['asset_version']),
      },
      calculationVersion: Number(h['calculation_version']),
      rules: mine(rules).map((r) => ({
        ruleCode: text(r['rule_code']),
        version: Number(r['rule_version']),
        ruleVersionHash: text(r['rule_version_hash']),
        firstYear: Number(r['first_year']),
        lastYear: Number(r['last_year']),
      })),
      components: mine(components).map((c) => componentOf(c, mine(parts), mine(fractions))),
    };
    return {
      versionId: id,
      assetId: text(h['asset_id']),
      propertyReferenceId: text(h['property_reference_id']),
      versionNumber: Number(h['version_number']),
      status: text(h['status']) as ScheduleVersionStatus,
      supersedesVersionId: (h['supersedes_id'] as string | null) ?? null,
      supersededByVersionId: (h['superseded_by_id'] as string | null) ?? null,
      supersededAt: (h['superseded_at'] as Date | null) ?? null,
      fromYear: Number(h['from_year']),
      throughYear: Number(h['through_year']),
      reason: text(h['reason']),
      recordedAt: h['recorded_at'] as Date,
      recordedBy: text(h['recorded_by']),
      computedOn: text(h['computed_on']) as BusinessDate,
      calculationVersion: Number(h['calculation_version']),
      inputFingerprint: text(h['input_fingerprint']),
      outputFingerprint: text(h['output_fingerprint']),
      inputs,
      years: mine(years).map((y) => ({
        year: Number(y['year']),
        amount: cents(text(y['amount'])),
        residualValue: cents(text(y['residual_value'])),
        inputFingerprint: text(y['input_fingerprint']),
        outputFingerprint: text(y['output_fingerprint']),
      })),
      entries: mine(entries).map((e) => ({
        year: Number(e['year']),
        componentId: text(e['component_id']),
        partKey: text(e['part_key']),
        months: Number(e['months']),
        fraction: e['fraction_numerator'] === null ? null : frac(text(e['fraction_numerator']), text(e['fraction_denominator'])),
        amount: cents(text(e['amount'])),
        cumulative: cents(text(e['cumulative'])),
        residualValue: cents(text(e['residual_value'])),
      })),
      flags: mine(flags).map((f) => ({
        year: num(f['year']),
        componentId: (f['component_id'] as string | null) ?? null,
        partKey: (f['part_key'] as string | null) ?? null,
        code: text(f['code']),
        level: text(f['level']) as 'OPEN' | 'INFORMATIVE',
      })),
      version: Number(h['version']),
    };
  });
}

function componentOf(c: Row, parts: readonly Row[], fractions: readonly Row[]): VersionComponent {
  const componentId = text(c['component_id']);
  const acquisition = c['kind'] === 'ACQUISITION';
  return {
    componentId,
    kind: text(c['kind']) as VersionComponent['kind'],
    position: Number(c['position']),
    computable: true,
    basis: cents(text(c['basis'])),
    start: { date: day(c['start_day']), dateSource: text(c['start_date_source']), method: text(c['start_method']), month: text(c['start_ym']) },
    rate: { kind: text(c['rate_kind']) as PartRateKind, usefulLifeYears: num(c['useful_life_years']) },
    acquisition: acquisition
      ? {
          acquisitionId: text(c['acquisition_id']),
          purchasePrice: cents(text(c['price'])),
          countedCostIds: c['counted_cost_ids'] as string[],
          countedCostsTotal: cents(text(c['counted'])),
          excludedCostIds: c['excluded_cost_ids'] as string[],
          excludedCostsTotal: cents(text(c['excluded'])),
          allocationId: text(c['allocation_id']),
          allocationReviewState: text(c['allocation_review_state']),
          totalAllocableAmount: cents(text(c['total'])),
          buildingAmount: cents(text(c['building'])),
          shorterLifeReviewState: (c['shorter_life_review_state'] as string | null) ?? null,
        }
      : null,
    item: acquisition
      ? null
      : {
          sourceType: text(c['source_type']),
          sourceId: text(c['source_id']),
          sourcePosition: num(c['source_position']),
          classificationId: (c['classification_id'] as string | null) ?? null,
          classificationReviewState: text(c['classification_review_state']),
          taxCategory: text(c['tax_category']),
          itemDate: day(c['item_day']) as BusinessDate,
          itemDateSource: text(c['item_date_source']),
          itemTaxYear: Number(c['item_tax_year']),
          anschaffungsnaheAcquisitionId: (c['anschaffungsnahe_acquisition_id'] as string | null) ?? null,
        },
    parts: parts
      .filter((p) => p['component_id'] === componentId)
      .map((p) => ({
        partKey: text(p['part_key']),
        ownerPartyId: (p['owner_party_id'] as string | null) ?? null,
        ownershipIds: p['ownership_ids'] as string[],
        share: frac(text(p['share_numerator']), text(p['share_denominator'])),
        weight: frac(text(p['weight_numerator']), text(p['weight_denominator'])),
        basis: cents(text(p['basis'])),
        firstMonth: text(p['first_ym']),
        rateKind: text(p['rate_kind']) as PartRateKind,
        usefulLifeYears: num(p['useful_life_years']),
        tenureFrom: day(p['tenure_day']),
        lastDay: day(p['last_day_text']),
        lastDaySource: (p['last_day_source'] as VersionPart['lastDaySource']) ?? null,
        poolKey: (p['pool_key'] as string | null) ?? null,
        fractions: fractions
          .filter((f) => f['component_id'] === componentId && f['part_key'] === p['part_key'])
          .map((f) => ({ month: month(f['month']), fraction: frac(text(f['fraction_numerator']), text(f['fraction_denominator'])) })),
      })),
  };
}
