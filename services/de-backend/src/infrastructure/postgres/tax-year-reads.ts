import { sql, type Kysely, type Transaction } from 'kysely';
import { withValidUntil, type LoanAllocationSetView } from '../../domains/financing/index.js';
import type { ChangedEntry, RentDueDay } from '../../domains/rental-contract-reference/index.js';
import {
  depositNotCounted,
  deriveDepositTaxMeaning,
  partOf,
  wegSourceKey,
  widestWindowDays,
  type AttributionInput,
  type DepositTaxMeaning,
  type RuleRegistry,
  type SourceType,
  type TaxListItem,
  type TaxYearRead,
  type WegSourceFacts,
  type WegTaxMeaning,
} from '../../domains/taxation/index.js';
import { Money, type BusinessDate } from '../../shared/index.js';
import type { CapitalizedSourcesReader } from './capitalized-items.js';
import { setsOfLoans } from './loan-allocation-repository.js';
import type { Database } from './schema.js';
import { UUID, currentOf, currentOfDeposits } from './tax-classification-rows.js';
import { COUNTED, factsQuery, meaningsOf, yearWindow, overriddenTo, countingSplits, toRead, depositFactsOf } from './tax-source-facts.js';
import { type Effects, effectsOf, splitWithEffects, wegWithEffects } from './tax-treatment-effects.js';

/**
 * The tax year (§58A–§58C): §55's items of a year as the list and the view read them, the view's other inputs, and the
 * capitalised sources Depreciation reads (§59B).
 */

/** On one date of the per-property list: splits, deposit closings, withdrawals, uses (§58B). */
const RANK: Record<SourceType, number> = { TRANSACTION_SPLIT: 0, DEPOSIT_CLOSING: 1, WEG_RESERVE_WITHDRAWAL: 2, WEG_ASSESSMENT_USE: 3 };
const dateOf = (m: TaxListItem): string =>
  m.sourceType === 'TRANSACTION_SPLIT' ? m.bookingDate : m.sourceType === 'DEPOSIT_CLOSING' ? (m.closingDate as string) : m.date;

/**
 * The snapshot of every tax read (§55, §58C): one `REPEATABLE READ READ ONLY` transaction, so a write inside it is
 * refused (`25006`) and nothing committed meanwhile is seen.
 */
export function taxYearSnapshot<T>(db: Kysely<Database>, work: (trx: Transaction<Database>) => Promise<T>): Promise<T> {
  return db.transaction().setIsolationLevel('repeatable read').setAccessMode('read only').execute(work);
}

/**
 * The inputs of the tax-year view (§58C), in one `REPEATABLE READ READ ONLY` snapshot: the PropertyReference, the
 * owner's Party, §55's items of `year` (the very derivation of the list) with the earlier § 82b sources beside them,
 * the Realm's deposit closings of `year` without a PropertyReference, the Ownerships with their shares, the
 * anschaffungsnahe checks, and the RentalContractReferences with their AuditRecords for `ATTRIBUTION_INPUT_CHANGED`.
 * No MRE call; nothing is written (the transaction is `READ ONLY`).
 */
export async function readTaxYear(
  db: Kysely<Database>,
  registry: RuleRegistry,
  propertyReferenceId: string,
  mreRealmId: string,
  year: number,
  ownerPartyId: string | null,
  today: BusinessDate,
): Promise<TaxYearRead | undefined> {
  if (!UUID.test(propertyReferenceId)) return undefined;
  return taxYearSnapshot(db, async (trx): Promise<TaxYearRead | undefined> => {
    const reference = await trx
      .selectFrom('property_reference')
      .select('id')
      .where('id', '=', propertyReferenceId)
      .where('mre_realm_id', '=', mreRealmId)
      .executeTakeFirst();
    if (reference === undefined) return undefined;
    const empty: TaxYearRead = {
      propertyReferenceId,
      ownerPartyFound: false,
      sources: [],
      unattributedDeposits: [],
      ownerships: [],
      checks: [],
      attribution: { references: [], candidates: [] },
      allocatedLoanInterest: [],
      loanAllocationSets: new Map(),
    };
    if (ownerPartyId !== null) {
      const party = UUID.test(ownerPartyId)
        ? await trx.selectFrom('party').select('id').where('id', '=', ownerPartyId).where('mre_realm_id', '=', mreRealmId).executeTakeFirst()
        : undefined;
      if (party === undefined) return empty;
    }
    const { entries, effects, deposits } = await yearItems(trx, registry, mreRealmId, propertyReferenceId, year, today);
    const ownerships = await trx
      .selectFrom('ownership')
      .select([
        'id',
        'owner_party_id',
        'share_numerator',
        'share_denominator',
        sql<string>`to_char(valid_from, 'YYYY-MM-DD')`.as('valid_from'),
        sql<string | null>`to_char(valid_until, 'YYYY-MM-DD')`.as('valid_until'),
      ])
      .where('mre_realm_id', '=', mreRealmId)
      .where('property_reference_id', '=', propertyReferenceId)
      .where('status', '=', 'VALID')
      .orderBy('id')
      .execute();
    return {
      propertyReferenceId,
      ownerPartyFound: ownerPartyId === null ? null : true,
      sources: entries,
      unattributedDeposits: deposits.filter((d) => d.propertyReferenceId === null),
      ownerships: ownerships.map((o) => ({
        id: o.id,
        partyId: o.owner_party_id,
        share: { numerator: o.share_numerator, denominator: o.share_denominator },
        validFrom: o.valid_from as BusinessDate,
        validUntil: o.valid_until as BusinessDate | null,
      })),
      checks: effects.checks,
      attribution: await attributionInputOf(trx, mreRealmId, propertyReferenceId, year, registry),
      ...(await allocatedLoanInterest(trx, registry, mreRealmId, propertyReferenceId, year, today)),
    };
  });
}

/**
 * The capitalised sources of a PropertyReference for Depreciation (api-design.md §59B; module-internal to
 * `infrastructure/postgres/`, not on Taxation's port), in the caller's transaction: every counting split of the
 * PropertyReference whose current classification is `CAPITALIZED` and every counting WEG source of its memberships,
 * over all years, each derived exactly as the list derives it (`meaningsOf`, `effectsOf`); and the sources named in
 * `also` (a separate asset's links) whatever their meaning, so a link whose item was reclassified is still shown.
 * Which of them Taxation places in `capitalized` is `capitalizedItemsOf`'s.
 */
export async function capitalizedSources(
  trx: Transaction<Database>,
  registry: RuleRegistry,
  mreRealmId: string,
  propertyReferenceId: string,
  today: BusinessDate,
  also: Parameters<CapitalizedSourcesReader>[4],
): ReturnType<CapitalizedSourcesReader> {
  const alsoSplits = also.filter((r) => r.sourceType === 'TRANSACTION_SPLIT').map((r) => r.sourceId);
  const rows = await factsQuery(trx, mreRealmId)
    .where('s.property_reference_id', '=', propertyReferenceId)
    .where((eb) => {
      // The counting splits with a current CAPITALIZED classification (the current-per-source index), and the linked ones.
      const capitalized = eb.and([
        eb('t.status', 'in', COUNTED),
        eb.or([eb('t.correction_role', 'is', null), eb('t.correction_role', '<>', 'REVERSAL')]),
        eb(
          's.id',
          'in',
          eb.selectFrom('tax_classification').select('transaction_split_id').where('superseded_at', 'is', null).where('treatment', '=', 'CAPITALIZED'),
        ),
      ]);
      return alsoSplits.length === 0 ? capitalized : eb.or([capitalized, eb('s.id', 'in', alsoSplits)]);
    })
    .orderBy('t.booking_date')
    .orderBy('t.id')
    .orderBy('s.position')
    .execute();
  const effects = await effectsOf(trx, registry, mreRealmId, propertyReferenceId, today);
  const splits = (await meaningsOf(trx, registry, mreRealmId, rows.map(toRead), today)).map((pair) => ({
    meaning: splitWithEffects(pair, effects),
    anschaffungsnaheAcquisitionId: pair.classification?.anschaffungsnaheAcquisitionId ?? null,
  }));
  const named = (f: WegSourceFacts) => also.some((r) => r.sourceType === f.sourceType && r.sourceId === f.sourceId && r.sourcePosition === f.sourcePosition);
  const weg = effects.weg.facts
    .filter((f) => f.notCounted === null || named(f))
    .map((f) => ({ facts: f, meaning: wegWithEffects(registry, f, effects, today) }))
    .filter(({ facts, meaning }) => (meaning.counts && meaning.treatment === 'CAPITALIZED') || named(facts))
    .map(({ facts, meaning }) => ({
      meaning,
      anschaffungsnaheAcquisitionId: effects.weg.current.get(wegSourceKey(facts))?.anschaffungsnaheAcquisitionId ?? null,
    }));
  return [...splits, ...weg];
}

/**
 * The interest of the allocated Loans (§58D "What the view reads"): the counting `LOAN_INTEREST` splits of the Loans
 * with a `VALID` allocation set naming the PropertyReference (the candidates, whatever the set's period and share:
 * which set applies is decided per split by `loanInterestOf`), selected as `yearItems` selects (the windows around
 * `year`, or overridden to it) and kept when §58A's derivation, the list's, puts them in `year`; each as a list item
 * with its own meaning (no treatment effects of the PropertyReference). And every set, `VALID` and `VOID`, of their
 * Loans with `validUntil`, in the same snapshot.
 */
async function allocatedLoanInterest(
  trx: Transaction<Database>,
  registry: RuleRegistry,
  mreRealmId: string,
  propertyReferenceId: string,
  year: number,
  today: BusinessDate,
): Promise<Pick<TaxYearRead, 'allocatedLoanInterest' | 'loanAllocationSets'>> {
  const { from, to } = yearWindow(registry, year);
  const rows = await countingSplits(factsQuery(trx, mreRealmId))
    .where('c.code', '=', 'LOAN_INTEREST')
    .where((eb) =>
      eb(
        's.loan_id',
        'in',
        eb
          .selectFrom('loan_allocation_set as las')
          .innerJoin('loan_allocation as la', 'la.set_id', 'las.id')
          .select('las.loan_id')
          .where('las.mre_realm_id', '=', mreRealmId)
          .where('las.status', '=', 'VALID')
          .where('la.property_reference_id', '=', propertyReferenceId),
      ),
    )
    .where((eb) => eb.or([eb.and([eb('t.booking_date', '>=', from), eb('t.booking_date', '<=', to)]), eb('s.id', 'in', overriddenTo(trx, year))]))
    .orderBy('t.booking_date')
    .orderBy('t.id')
    .orderBy('s.position')
    .execute();
  const meanings = await meaningsOf(trx, registry, mreRealmId, rows.map(toRead), today);
  const interest = rows.flatMap((row, i) => {
    const meaning = meanings[i]?.meaning;
    return meaning === undefined || meaning.taxYear !== year ? [] : [{ item: { ...meaning, yearAmount: meaning.amount }, loanId: row.loan_id as string }];
  });
  const sets = await setsOfLoans(trx, mreRealmId, [...new Set(interest.map((i) => i.loanId))]);
  const loanAllocationSets = new Map<string, readonly LoanAllocationSetView[]>([...sets].map(([loanId, own]) => [loanId, withValidUntil(own)]));
  return { allocatedLoanInterest: interest, loanAllocationSets };
}

/**
 * §55's items of `year` in the list's order (§58A, §58B), each with `listed`: false for an earlier § 82b source
 * whose §58B parts have none in `year` (the view's per-owner fold may still give it one, §58C); and the Realm's
 * deposit closings of `year`.
 */
export async function yearItems(
  trx: Transaction<Database>,
  registry: RuleRegistry,
  mreRealmId: string,
  propertyReferenceId: string,
  year: number,
  today: BusinessDate,
): Promise<{
  readonly entries: { readonly item: TaxListItem; readonly listed: boolean }[];
  readonly effects: Effects;
  readonly deposits: DepositTaxMeaning[];
}> {
  // §58A: every split that can count in `year`: booked in it or in the windows around it, or overridden to it.
  const { from, to } = yearWindow(registry, year);
  const rows = await countingSplits(factsQuery(trx, mreRealmId).where('s.property_reference_id', '=', propertyReferenceId))
    .where((eb) =>
      eb.or([
        eb.and([eb('t.booking_date', '>=', from), eb('t.booking_date', '<=', to)]),
        eb('s.id', 'in', overriddenTo(trx, year)),
        // §58B: an election of an earlier year may have a part in `year` (at most 4 years back, 5 years).
        eb(
          's.id',
          'in',
          eb.selectFrom('tax_classification').select('transaction_split_id').where('superseded_at', 'is', null).where('treatment', '=', 'DISTRIBUTED_82B'),
        ),
      ]),
    )
    .orderBy('t.booking_date')
    .orderBy('t.id')
    .orderBy('s.position')
    .execute();
  const effects = await effectsOf(trx, registry, mreRealmId, propertyReferenceId, today);
  const splits = (await meaningsOf(trx, registry, mreRealmId, rows.map(toRead), today)).map((pair) => splitWithEffects(pair, effects));
  const deposits = await closedDepositsOf(trx, registry, mreRealmId, year, today);
  // §58B: the withdrawals of CONFIRMED statements and the uses of assessments not VOID; a superseded statement's
  // withdrawals do not count and are not listed.
  const weg = effects.weg.facts.filter((f) => f.notCounted === null).map((f) => wegWithEffects(registry, f, effects, today));
  const entries: { item: TaxListItem; listed: boolean }[] = [];
  for (const m of [...splits, ...weg]) {
    const part = m.distribution === null ? undefined : partOf(m.distribution, year);
    if (m.taxYear === year) entries.push({ item: { ...m, yearAmount: part ?? m.amount }, listed: true });
    else if (m.taxYear < year && m.counts && part !== undefined) entries.push({ item: { ...m, yearAmount: part }, listed: true });
    // §58C: the per-owner fold keeps a NOT_OWNED part in its year where §58B's fold moved it.
    else if (m.taxYear < year && m.counts && m.distribution !== null)
      entries.push({ item: { ...m, yearAmount: Money.zero(m.amount.currency) }, listed: false });
  }
  for (const d of deposits) if (d.propertyReferenceId === propertyReferenceId) entries.push({ item: { ...d, yearAmount: d.amount }, listed: true });
  // By date (booking, closing, withdrawal or use date); on one date splits, deposits, withdrawals, uses; splits in
  // §55's order (Transaction, position), the WEG sources by sourceId and position (§58B).
  const sorted = entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => {
      const [da, db] = [dateOf(a.entry.item), dateOf(b.entry.item)];
      if (da !== db) return da < db ? -1 : 1;
      const [ra, rb] = [RANK[a.entry.item.sourceType], RANK[b.entry.item.sourceType]];
      if (ra !== rb) return ra - rb;
      if (a.entry.item.sourceType === 'WEG_RESERVE_WITHDRAWAL' || a.entry.item.sourceType === 'WEG_ASSESSMENT_USE') {
        const [pa, pb] = [a.entry.item as WegTaxMeaning, b.entry.item as WegTaxMeaning];
        if (pa.sourceId !== pb.sourceId) return pa.sourceId < pb.sourceId ? -1 : 1;
        return pa.sourcePosition - pb.sourcePosition;
      }
      return a.index - b.index;
    })
    .map((x) => x.entry);
  return { entries: sorted, effects, deposits };
}

/** The deposit closings of the Realm closed in `year` that count by the deposit (§58A), with their meanings. */
async function closedDepositsOf(
  trx: Transaction<Database>,
  registry: RuleRegistry,
  mreRealmId: string,
  year: number,
  today: BusinessDate,
): Promise<DepositTaxMeaning[]> {
  const closed = await trx
    .selectFrom('security_deposit')
    .select('id')
    .where('mre_realm_id', '=', mreRealmId)
    .where('status', '=', 'CLOSED')
    .where('closing_date', '>=', `${year}-01-01`)
    .where('closing_date', '<=', `${year}-12-31`)
    .orderBy('closing_date')
    .orderBy('id')
    .execute();
  const facts = (
    await depositFactsOf(
      trx,
      mreRealmId,
      closed.map((d) => d.id),
    )
  ).filter((f) => depositNotCounted(f, null) === null);
  const current = await currentOfDeposits(
    trx,
    facts.map((f) => f.securityDepositId),
  );
  return facts.map((f) => deriveDepositTaxMeaning(f, current.get(f.securityDepositId) ?? null, registry, today));
}

/** The rent splits whose year `rentDueDays` decides (§58A's table): base rent and advances. */
const ATTRIBUTED_RENT_CODES = ['RENT_BASE', 'RENT_OPERATING_COST_ADVANCE'];

/**
 * What `ATTRIBUTION_INPUT_CHANGED` reads (§58C): the counting rent splits of the PropertyReference booked in either
 * window at an edge of `year` with one `CONFIRMED` reconciliation term, their classifications' `taxYear`, the Realm's
 * RentalContractReferences of their Tenants and those references' `CREATED` and `AMENDED` AuditRecords (by
 * `audit_record_entity_idx`). The references are read in the Realm, so another Realm's AuditRecord is never read.
 */
async function attributionInputOf(
  trx: Transaction<Database>,
  mreRealmId: string,
  propertyReferenceId: string,
  year: number,
  registry: RuleRegistry,
): Promise<AttributionInput> {
  const days = widestWindowDays(registry);
  if (days === 0) return { references: [], candidates: [] };
  const windows = [year - 1, year].map((y) => ({ from: `${y}-12-${String(32 - days).padStart(2, '0')}`, to: `${y + 1}-01-${String(days).padStart(2, '0')}` }));
  const rows = await countingSplits(factsQuery(trx, mreRealmId).where('s.property_reference_id', '=', propertyReferenceId))
    .where('c.code', 'in', ATTRIBUTED_RENT_CODES)
    .where((eb) => eb.or(windows.map((w) => eb.and([eb('t.booking_date', '>=', w.from), eb('t.booking_date', '<=', w.to)]))))
    .orderBy('t.booking_date')
    .orderBy('t.id')
    .orderBy('s.position')
    .execute();
  if (rows.length === 0) return { references: [], candidates: [] };
  const reconciliations = await trx
    .selectFrom('rent_payment_reconciliation')
    .select(['transaction_id', 'mre_tenant_id', 'mre_rent_term'])
    .where('transaction_id', 'in', [...new Set(rows.map((r) => r.transaction_id))])
    .where('mre_realm_id', '=', mreRealmId)
    .where('status', '=', 'CONFIRMED')
    .execute();
  const overrides = await currentOf(
    trx,
    rows.map((r) => r.id),
  );
  const candidates: AttributionInput['candidates'][number][] = rows.flatMap((r) => {
    const terms = new Map(
      reconciliations.filter((c) => c.transaction_id === r.transaction_id).map((c) => [`${c.mre_tenant_id}/${c.mre_rent_term}`, c] as const),
    );
    // Without one term the rent has no economic period under any list (§58A): rentDueDays decides nothing.
    const [only] = terms.values();
    if (only === undefined || terms.size > 1) return [];
    return [
      {
        sourceId: r.id,
        bookingDate: r.booking_date as BusinessDate,
        financialCategoryCode: r.code,
        mreTenantId: only.mre_tenant_id,
        mreRentTerm: only.mre_rent_term,
        taxYearOverride: overrides.get(r.id)?.taxYear ?? null,
      },
    ];
  });
  const tenants = [...new Set(candidates.map((c) => c.mreTenantId))];
  if (tenants.length === 0) return { references: [], candidates: [] };
  const references = await trx
    .selectFrom('rental_contract_reference')
    .select(['id', 'mre_tenant_id', 'rent_due_days'])
    .where('mre_realm_id', '=', mreRealmId)
    .where('mre_tenant_id', 'in', tenants)
    .orderBy('id')
    .execute();
  const records =
    references.length === 0
      ? []
      : await trx
          .selectFrom('audit_record')
          .select(['id', 'entity_id', 'action', 'new_version', 'occurred_at', 'metadata'])
          .where('entity_type', '=', 'RentalContractReference')
          .where(
            'entity_id',
            'in',
            references.map((r) => r.id),
          )
          .where('action', 'in', ['CREATED', 'AMENDED'])
          .orderBy('new_version')
          .orderBy('id')
          .execute();
  return {
    candidates,
    references: references.map((r) => {
      const own = records.filter((a) => a.entity_id === r.id);
      const created = own.find((a) => a.action === 'CREATED');
      const createdDays = (created?.metadata as { rentDueDays?: RentDueDay[] } | null)?.rentDueDays;
      return {
        rentalContractReferenceId: r.id,
        mreTenantId: r.mre_tenant_id,
        rentDueDays: r.rent_due_days as RentDueDay[],
        created: createdDays ?? null,
        amendments: own
          .filter((a) => a.action === 'AMENDED')
          .map((a) => ({
            auditRecordId: a.id,
            newVersion: a.new_version ?? 0,
            amendedAt: a.occurred_at,
            changedEntries: (a.metadata as { changedEntries?: ChangedEntry[] } | null)?.changedEntries ?? [],
          }))
          // An amendment of notes or sourceReferences alone has no changedEntries (§58C).
          .filter((a) => a.changedEntries.length > 0),
      };
    }),
  };
}
