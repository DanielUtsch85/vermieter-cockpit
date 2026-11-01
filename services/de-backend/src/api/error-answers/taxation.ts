import {
  AdvisorConfirmedError,
  ClassificationExistsError,
  ClassificationSupersededError,
  DepositNotCountedError,
  AnschaffungsnaheNotApplicableError,
  DistributionNotAllowedError,
  NetAmountExceedsGrossError,
  TaxFieldNotSupportedError,
  WegSourceNotCountedError,
  WegSourcePositionNotFoundError,
  WithdrawalTaxYearOutOfRangeError,
  NoApplicableTaxRuleError,
  NotAnOwnerInYearError,
  OwnerPartyNotFoundError,
  TaxYearTooLargeError,
  NotCurrentClassificationError,
  RefundYearOutOfRangeError,
  SourceNotCountedError,
  TaxClassificationNotFoundError,
  TaxRuleNotFoundError,
  TaxRuleNotRegisteredError,
  TaxSourceNotFoundError,
  TaxYearOutOfRangeError,
  TreatmentNotAllowedError,
  ConstructionPeriodInterestDeductibleError,
  ConstructionPeriodInterestMismatchError,
  ConstructionPeriodInterestNotAllowedError,
  ConstructionPeriodInterestNotFoundError,
  ConstructionPeriodInterestVoidError,
} from '../../application/index.js';
import { answer, on, validation } from './answer.js';

/** The answers to the taxation module's errors (part of the central table, `../error-answers.ts`). */
export const TAXATION_ANSWERS = [
  // Taxation (api-design §55–§58, VC-7-01).
  on(AdvisorConfirmedError, () =>
    answer(409, 'CONFLICT', 'A user cannot lower an advisor confirmation; supersede the classification instead.', { reason: 'ADVISOR_CONFIRMED' }),
  ),
  on(ClassificationExistsError, (error) =>
    answer(409, 'CONFLICT', 'The source has a current classification; name it in supersedes.', {
      reason: 'CLASSIFICATION_EXISTS',
      currentClassificationId: error.currentClassificationId,
    }),
  ),
  on(ClassificationSupersededError, (error) =>
    answer(409, 'CONFLICT', 'Only the current classification moves.', { reason: 'CLASSIFICATION_SUPERSEDED', supersededBy: error.supersededBy }),
  ),
  on(NoApplicableTaxRuleError, (error) =>
    answer(409, 'CONFLICT', "No version of the tax rule applies on the source's date.", {
      reason: 'NO_APPLICABLE_RULE',
      ruleCode: error.ruleCode,
      date: error.date,
    }),
  ),
  on(NotCurrentClassificationError, (error) =>
    answer(409, 'CONFLICT', 'supersedes does not name the current classification.', {
      reason: 'NOT_CURRENT_CLASSIFICATION',
      currentClassificationId: error.currentClassificationId,
    }),
  ),
  on(SourceNotCountedError, (error) =>
    answer(409, 'CONFLICT', 'The split does not count for tax: its Transaction is not current (CONFIRMED or RECONCILED, not a reversal).', {
      reason: 'SOURCE_NOT_COUNTED',
      transactionStatus: error.transactionStatus,
      correctionRole: error.correctionRole,
    }),
  ),
  on(TaxClassificationNotFoundError, (error) => answer(404, 'NOT_FOUND', 'Tax classification not found.', { classificationId: error.classificationId })),
  on(TaxRuleNotFoundError, (error) => answer(404, 'NOT_FOUND', 'Tax rule not found.', { ruleCode: error.ruleCode })),
  on(TaxRuleNotRegisteredError, (error) =>
    answer(409, 'CONFLICT', 'The classification names a rule version that is not registered.', {
      reason: 'RULE_NOT_REGISTERED',
      ruleCode: error.ruleCode,
      version: error.version,
    }),
  ),
  on(TaxSourceNotFoundError, (error) => answer(404, 'NOT_FOUND', 'Source not found.', { sourceType: error.sourceType, sourceId: error.sourceId })),
  on(TreatmentNotAllowedError, (error) =>
    error.reason === 'CONSTRUCTION_PERIOD_INTEREST_REQUIRED'
      ? answer(422, 'TREATMENT_NOT_ALLOWED', 'Interest is capitalised only as Bauzeitzinsen with a construction-period record (api-design §59E).', {
          categoryType: error.categoryType,
          allowed: error.allowed,
          reason: error.reason,
        })
      : error.reason !== undefined
        ? answer(422, 'TREATMENT_NOT_ALLOWED', 'WEG_SPENDING is the line of reserve withdrawals and Sonderumlage uses only.', {
            sourceType: error.sourceType,
            reason: error.reason,
          })
        : error.categoryType === null && error.sourceType !== undefined && error.sourceType !== 'DEPOSIT_CLOSING'
          ? answer(422, 'TREATMENT_NOT_ALLOWED', 'A WEG withdrawal or use is WEG_SPENDING (Erhaltungsaufwand or Herstellungskosten), or not relevant.', {
              sourceType: error.sourceType,
              allowed: error.allowed,
              allowedTaxCategories: error.taxCategories ?? [],
            })
          : error.categoryType === null
            ? answer(422, 'TREATMENT_NOT_ALLOWED', 'A retained deposit is rent or damage compensation, or not relevant.', {
                sourceType: 'DEPOSIT_CLOSING',
                allowed: error.allowed,
                allowedTaxCategories: error.taxCategories ?? [],
              })
            : answer(422, 'TREATMENT_NOT_ALLOWED', 'The category of the split does not allow this treatment.', {
                categoryType: error.categoryType,
                allowed: error.allowed,
              }),
  ),
  // Tax year and income (api-design §58A, VC-7-02).
  on(DepositNotCountedError, (error) =>
    answer(409, 'CONFLICT', 'The security deposit does not count for tax: it is not CLOSED with a retained amount, or was closed again.', {
      reason: 'SOURCE_NOT_COUNTED',
      depositStatus: error.depositStatus,
      retainedAmount: error.retainedAmount.toJSON(),
      notCountedReason: error.reason,
    }),
  ),
  on(TaxYearOutOfRangeError, (error) =>
    answer(422, 'TAX_YEAR_OUT_OF_RANGE', 'taxYear must be the booking year or a neighbouring year.', {
      taxYear: error.taxYear,
      bookingYear: error.bookingYear,
    }),
  ),
  on(RefundYearOutOfRangeError, (error) =>
    answer(422, 'REFUND_YEAR_OUT_OF_RANGE', 'refundOfYear must not lie after the tax year.', { refundOfYear: error.refundOfYear, taxYear: error.taxYear }),
  ),
  // WEG spending, Erhaltungsaufwand and § 82b (api-design §58B, VC-7-03).
  on(WegSourceNotCountedError, (error) =>
    answer(409, 'CONFLICT', 'The WEG withdrawal or use does not count for tax.', {
      reason: 'SOURCE_NOT_COUNTED',
      sourceType: error.sourceType,
      notCountedReason: error.notCountedReason,
      ...(JSON.parse(JSON.stringify(error.details)) as Record<string, unknown>),
    }),
  ),
  on(WegSourcePositionNotFoundError, (error) =>
    answer(404, 'NOT_FOUND', 'Source not found.', { sourceType: error.sourceType, sourceId: error.sourceId, sourcePosition: error.sourcePosition }),
  ),
  on(TaxFieldNotSupportedError, (error) => validation([{ field: error.field, code: 'NOT_SUPPORTED' }])),
  on(DistributionNotAllowedError, (error) => answer(422, 'DISTRIBUTION_NOT_ALLOWED', 'No § 82b distribution for this source.', { reason: error.reason })),
  on(NetAmountExceedsGrossError, (error) =>
    answer(422, 'NET_AMOUNT_EXCEEDS_GROSS', "netAmount must not exceed the source's gross amount.", {
      netAmount: error.netAmount.toJSON(),
      grossAmount: error.grossAmount.toJSON(),
    }),
  ),
  on(AnschaffungsnaheNotApplicableError, (error) =>
    answer(422, 'ANSCHAFFUNGSNAHE_NOT_APPLICABLE', "The Acquisition's anschaffungsnahe check does not hold this source.", {
      reason: error.reason,
      acquisitionId: error.acquisitionId,
    }),
  ),
  on(WithdrawalTaxYearOutOfRangeError, (error) =>
    answer(422, 'TAX_YEAR_OUT_OF_RANGE', "taxYear must be a calendar year the statement's period touches.", {
      taxYear: error.taxYear,
      allowedYears: error.allowedYears,
    }),
  ),
  // Bauzeitzinsen (api-design §59E, VC-X-36).
  on(ConstructionPeriodInterestNotFoundError, (error) =>
    answer(404, 'NOT_FOUND', 'Construction-period record not found.', { constructionPeriodInterestId: error.constructionPeriodInterestId }),
  ),
  on(ConstructionPeriodInterestVoidError, (error) =>
    answer(409, 'CONFLICT', 'The construction-period record is void.', {
      reason: 'CONSTRUCTION_PERIOD_INTEREST_VOID',
      constructionPeriodInterestId: error.constructionPeriodInterestId,
    }),
  ),
  on(ConstructionPeriodInterestMismatchError, (error) =>
    answer(409, 'CONFLICT', 'The construction-period record does not cover the split (another Loan, or not its PropertyReference).', {
      reason: 'CONSTRUCTION_PERIOD_INTEREST_MISMATCH',
      ...error.details,
    }),
  ),
  on(ConstructionPeriodInterestDeductibleError, (error) =>
    answer(409, 'CONFLICT', 'The record states the interest as deductible (vorab entstandene Werbungskosten): it cannot be capitalised.', {
      reason: 'CONSTRUCTION_PERIOD_INTEREST_DEDUCTIBLE',
      constructionPeriodInterestId: error.constructionPeriodInterestId,
    }),
  ),
  on(ConstructionPeriodInterestNotAllowedError, () => validation([{ field: 'constructionPeriodInterestId', code: 'NOT_ALLOWED' }])),
  // The tax-year view (api-design §58C, VC-7-04).
  on(OwnerPartyNotFoundError, (error) => answer(404, 'NOT_FOUND', 'Party not found.', { ownerPartyId: error.ownerPartyId })),
  on(NotAnOwnerInYearError, (error) =>
    answer(422, 'NOT_AN_OWNER_IN_YEAR', 'The Party holds no Ownership in the year and takes part in no item of it.', {
      ownerPartyId: error.ownerPartyId,
      year: error.year,
    }),
  ),
  on(TaxYearTooLargeError, (error) =>
    answer(409, 'CONFLICT', 'The tax year has more items than the view carries; read it through the paged list.', {
      reason: 'TAX_YEAR_TOO_LARGE',
      itemCount: error.itemCount,
      limit: error.limit,
      pagedList: error.pagedList,
    }),
  ),
];
