import { sql, type Kysely } from 'kysely';
import { TAX_RULES } from '../../domains/tax-rules/index.js';
import type {
  AnschaffungsnaheCheck,
  CreateClassificationOutcome,
  DepositTaxMeaning,
  NewTaxClassification,
  ReviewClassificationOutcome,
  ReviewStep,
  RuleRef,
  RuleRegistry,
  SourceType,
  TaxClassification,
  TaxClassificationRepository,
  TaxListItem,
  TaxMeaning,
  TaxMeaningFilter,
  TaxPage,
  TaxPageRequest,
  TaxYearRead,
  WegTaxMeaning,
} from '../../domains/taxation/index.js';
import type { AuditActor, BusinessDate } from '../../shared/index.js';
import type { CapitalizedSourcesReader } from './capitalized-items.js';
import type { Database } from './schema.js';
import * as store from './tax-classification-store.js';
import * as meanings from './tax-meaning-reads.js';
import { anschaffungsnaheCheck } from './tax-treatment-effects.js';
import { capitalizedSources, readTaxYear } from './tax-year-reads.js';

export { taxYearSnapshot } from './tax-year-reads.js';

/**
 * PostgreSQL implementation of the TaxClassification port (api-design.md §55–§58B). A create writes its source first
 * (the split's Transaction, the deposit, the statement or the assessment; a no-op), then locks the current
 * classification of the source (P7-D9); §57's steps lock the classification row only. Nothing here writes a split, a
 * Transaction, a deposit, a statement, an assessment or an Acquisition (ADR-006).
 *
 * One class for the one port, delegating along the domain's cuts: classifications (create, supersede, review, history)
 * in `tax-classification-store.ts`; the meanings and the per-property list in `tax-meaning-reads.ts`; §58B's effects
 * (the § 82b parts, the anschaffungsnahe check) in `tax-treatment-effects.ts`; the tax-year view and the capitalised
 * sources in `tax-year-reads.ts`. The split, deposit and timing facts are in `tax-source-facts.ts`, the classification
 * rows and their mapping in `tax-classification-rows.ts`.
 */
export class PostgresTaxClassificationRepository implements TaxClassificationRepository {
  constructor(
    private readonly db: Kysely<Database>,
    private readonly registry: RuleRegistry = TAX_RULES,
  ) {}

  createClassification(
    classification: NewTaxClassification,
    actor: AuditActor,
    idempotency?: { readonly key: string; readonly fingerprint: string },
  ): Promise<CreateClassificationOutcome> {
    return store.createClassification(this.db, this.registry, classification, actor, idempotency);
  }

  reviewClassification(
    id: string,
    mreRealmId: string,
    step: ReviewStep,
    actor: AuditActor,
    expectedVersions?: readonly number[],
  ): Promise<ReviewClassificationOutcome> {
    return store.reviewClassification(this.db, this.registry, id, mreRealmId, step, actor, expectedVersions);
  }

  findClassification(id: string, mreRealmId: string): Promise<TaxClassification | undefined> {
    return store.findClassification(this.db, id, mreRealmId);
  }

  listHistory(
    sourceType: SourceType,
    sourceId: string,
    mreRealmId: string,
    sourcePosition: number | null = null,
  ): Promise<readonly TaxClassification[] | undefined> {
    return store.listHistory(this.db, sourceType, sourceId, mreRealmId, sourcePosition);
  }

  findTaxMeaning(splitId: string, mreRealmId: string, today: BusinessDate): Promise<TaxMeaning | undefined> {
    return meanings.findTaxMeaning(this.db, this.registry, splitId, mreRealmId, today);
  }

  findDepositTaxMeaning(depositId: string, mreRealmId: string, today: BusinessDate): Promise<DepositTaxMeaning | undefined> {
    return meanings.findDepositTaxMeaning(this.db, this.registry, depositId, mreRealmId, today);
  }

  findWithdrawalTaxMeaning(statementId: string, position: number, mreRealmId: string, today: BusinessDate): Promise<WegTaxMeaning | undefined> {
    return meanings.wegMeaning(this.db, this.registry, 'weg_annual_statement', 'WEG_RESERVE_WITHDRAWAL', statementId, position, mreRealmId, today);
  }

  findUseTaxMeaning(assessmentId: string, position: number, mreRealmId: string, today: BusinessDate): Promise<WegTaxMeaning | undefined> {
    return meanings.wegMeaning(this.db, this.registry, 'weg_special_assessment', 'WEG_ASSESSMENT_USE', assessmentId, position, mreRealmId, today);
  }

  anschaffungsnaheCheck(acquisitionId: string, mreRealmId: string, today: BusinessDate): Promise<AnschaffungsnaheCheck | undefined> {
    return anschaffungsnaheCheck(this.db, this.registry, acquisitionId, mreRealmId, today);
  }

  listTaxMeanings(
    propertyReferenceId: string,
    mreRealmId: string,
    year: number,
    filter: TaxMeaningFilter,
    page: TaxPageRequest,
    today: BusinessDate,
  ): Promise<TaxPage<TaxListItem> | undefined> {
    return meanings.listTaxMeanings(this.db, this.registry, propertyReferenceId, mreRealmId, year, filter, page, today);
  }

  readTaxYear(
    propertyReferenceId: string,
    mreRealmId: string,
    year: number,
    ownerPartyId: string | null,
    today: BusinessDate,
  ): Promise<TaxYearRead | undefined> {
    return readTaxYear(this.db, this.registry, propertyReferenceId, mreRealmId, year, ownerPartyId, today, this.capitalizedSources);
  }

  /** The capitalised sources of a PropertyReference for Depreciation (§59B; not on Taxation's port): see `tax-year-reads.ts`. */
  readonly capitalizedSources: CapitalizedSourcesReader = (trx, mreRealmId, propertyReferenceId, today, also) =>
    capitalizedSources(trx, this.registry, mreRealmId, propertyReferenceId, today, also);

  async storedRuleReferences(): Promise<readonly RuleRef[]> {
    // Both references (§58B): the rule of the source's default and the second, `treatmentRule`.
    const rows = await sql<{ rule_code: string; rule_version: number }>`
      SELECT rule_code, rule_version FROM tax_classification
      UNION
      SELECT treatment_rule_code, treatment_rule_version FROM tax_classification WHERE treatment_rule_code IS NOT NULL
      ORDER BY rule_code, rule_version
    `.execute(this.db);
    return rows.rows.map((r) => ({ ruleCode: r.rule_code, version: r.rule_version }));
  }
}
