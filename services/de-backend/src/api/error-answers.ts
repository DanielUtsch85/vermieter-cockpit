import {
  AboveSuggestionError,
  AccessError,
  AcquisitionCancelledError,
  AcquisitionConfirmedError,
  AcquisitionCostNotFoundError,
  AcquisitionHasValidOwnershipsError,
  AcquisitionNotDraftError,
  AcquisitionNotFoundError,
  AcquisitionNotOfPropertyError,
  AcquisitionPaymentNotFoundError,
  AdministratorInactiveError,
  AllocationNotLastError,
  AllocationRefusedError,
  AlreadyMatchedError,
  AnnualStatementNotFoundError,
  AssessmentHasSplitsError,
  AssessmentNotActiveError,
  AssessmentOutsideMembershipError,
  ClosingBeforeDebtError,
  ConcurrentUpdateError,
  ConfirmationBlockedError,
  type ConfirmationViolation,
  CorrectionNoChangeError,
  CostHasPaymentsError,
  CurrentAllocationChangedError,
  DepositCashAfterClosingDateError,
  DepositClosedError,
  DepositExistsError,
  DepositHasSplitsError,
  DepositNotActiveError,
  DepositNotClosedError,
  DepositStillHeldError,
  EconomicPlanNotFoundError,
  EffectiveFromOutsideYearError,
  ExpectedAmountRequiredError,
  ExternalReferenceInUseError,
  ExternalReferenceNotFoundError,
  FinancialAccountClosedError,
  FinancialAccountNotFoundError,
  HausgeldNotProposableError,
  HoldingAccountNotFoundError,
  IdempotencyKeyConflictError,
  ImportAccountMismatchError,
  ImportBatchNotFoundError,
  ImportFileError,
  ImportedFieldsFixedError,
  InactiveCategoryError,
  InvalidLoanSplitError,
  InvalidSecurityDepositSplitError,
  InvalidMembershipError,
  InvalidOwnershipError,
  InvalidSupersedesError,
  InvalidWegAssessmentSplitError,
  InvalidWegStatementSplitError,
  type LinkRefusal,
  LoanAllocationSetNotFoundError,
  LoanBalanceStatementNotFoundError,
  LoanClosedError,
  LoanClosedOnError,
  LoanFieldsInvalidError,
  LoanHasSplitsError,
  LoanNotActiveError,
  LoanNotAllocatedError,
  LoanNotFoundError,
  LoanRefinancesError,
  LoanTermsNotFoundError,
  MembershipHasPlansError,
  MembershipHasAssessmentsError,
  MembershipHasSplitsError,
  MembershipHasStatementsError,
  MembershipNotActiveError,
  MrePropertyNotFoundError,
  MreRentTermNotFoundError,
  MreTenantNotFoundError,
  MreUnavailableError,
  NoEconomicPlanError,
  NoRentCashError,
  NoWegMembershipError,
  NothingToSettleError,
  NoScheduleError,
  NotASecurityDepositAccountError,
  NotConfirmableError,
  NotRejectableError,
  NotReleasableError,
  NotRemovableError,
  NotWritableError,
  NothingRetainedError,
  OverlappingOwnershipError,
  OverlappingWegMembershipError,
  OwnerInactiveError,
  OwnershipBasisIncompleteError,
  OwnershipIncompleteError,
  OwnershipNotFoundError,
  OwnershipOfConfirmedAcquisitionError,
  OwnershipTotalExceedsOneError,
  PartyFieldNotAllowedError,
  PartyInactiveError,
  PartyNotFoundError,
  PlanExistsError,
  PlanOutsideMembershipError,
  PaymentNotProposableError,
  PaymentRefusedError,
  PeriodOutsideYearError,
  PredecessorOfConfirmedAcquisitionError,
  SettlementDirectionMismatchError,
  SettlementNotProposableError,
  SpecialAssessmentNotFoundError,
  PropertyReferenceNotFoundError,
  ProposalTransactionNotFoundError,
  ReconciliationNotFoundError,
  RefinancingLoanNotActiveError,
  RefinancingLoanNotFoundError,
  RemainingDebtNotZeroError,
  RemovalTooEarlyError,
  RentCashExceededError,
  RentNotProposableError,
  ReviewItemNotFoundError,
  ReviewResolutionConflictError,
  SecurityDepositNotFoundError,
  SplitSumMismatchError,
  SplitsAfterClosingError,
  SplitsMissingError,
  StatementAfterClosingError,
  StatementBeforeDebtError,
  StatementExistsError,
  StatementNotConfirmedError,
  StatementNotDraftError,
  StatementNotCurrentError,
  StatementOutsideMembershipError,
  SuggestionStaleError,
  TermsNotLastError,
  TermsRefusedError,
  TransactionAlreadyCorrectedError,
  TransactionFrozenError,
  TransactionNotAmendableError,
  TransactionNotConfirmableError,
  TransactionNotCorrectableError,
  TransactionNotCountedError,
  TransactionNotFoundError,
  TransactionNotIgnorableError,
  TransactionNotIgnoredError,
  TransactionNotInflowError,
  TransactionRentReconciledError,
  UnconfirmedDepositCashError,
  UnsupportedAdapterError,
  VersionConflictError,
  WegHasMembershipsError,
  WegHasYearsError,
  WegMembershipNotFoundError,
  WegNotActiveError,
  WegNotFoundError,
  WegAssessmentNotFoundError,
  WegStatementNotFoundError,
  WriteBackFailedError,
  WriteBackInProgressError,
  AdvisorConfirmedError,
  AssetAdvisorConfirmedError,
  BuildingAssetExistsError,
  CompletionYearMissingError,
  DepreciationAssetNotActiveError,
  DepreciationAssetNotFoundError,
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
  NotAnOwnerError,
  NotAnOwnerInYearError,
  OwnerPartyNotFoundError,
  TaxYearTooLargeError,
  NotCurrentClassificationError,
  RefundYearOutOfRangeError,
  RentalContractReferenceExistsError,
  RentalContractReferenceNotFoundError,
  RentalContractTenantNotFoundError,
  SourceNotCountedError,
  TaxClassificationNotFoundError,
  TaxRuleNotFoundError,
  TaxRuleNotRegisteredError,
  TaxSourceNotFoundError,
  TaxYearOutOfRangeError,
  TreatmentNotAllowedError,
  formatShare,
} from '../application/index.js';
import { eurCents, signedEurCents } from './cents.js';
import type { FieldError } from './validation.js';

/**
 * The central error table (#89, api-design.md §12–13): each error class a use case throws, mapped to its HTTP answer.
 * The error handler answers from it; routes pass errors on with `next(error)`. A route keeps its own answer only where
 * it depends on the request (field errors named after the request's body, a message naming what was not done).
 */
export interface ErrorAnswer {
  readonly status: number;
  readonly code: string;
  readonly message: string;
  readonly details?: Record<string, unknown>;
  readonly headers?: Readonly<Record<string, string>>;
}

const answer = (status: number, code: string, message: string, details?: Record<string, unknown>): ErrorAnswer =>
  details === undefined ? { status, code, message } : { status, code, message, details };

const validation = (fields: readonly FieldError[]): ErrorAnswer => answer(400, 'VALIDATION_ERROR', 'Validation failed.', { fields });

const ACCESS: Record<AccessError['code'], ErrorAnswer> = {
  UNAUTHENTICATED: { status: 401, code: 'UNAUTHORIZED', message: 'A valid MRE access token is required.', headers: { 'WWW-Authenticate': 'Bearer' } },
  FORBIDDEN: { status: 403, code: 'FORBIDDEN', message: 'No access to this Realm.' },
  AUTH_UNAVAILABLE: { status: 503, code: 'EXTERNAL_SYSTEM_ERROR', message: 'Authentication service unavailable.' },
};

/** An access refusal (VC-0-08); 401 carries `WWW-Authenticate: Bearer`. */
export const access = (code: AccessError['code']): ErrorAnswer => ACCESS[code];

/** A confirmation violation as the API shows it (§27.3). */
export function violationDto(v: ConfirmationViolation) {
  switch (v.code) {
    case 'BUYER_SHARE_NOT_INCREASED':
      return { code: v.code, partyId: v.partyId, shareBefore: formatShare(v.shareBefore), share: formatShare(v.share) };
    case 'SHARE_SUM_MISMATCH':
      return {
        code: v.code,
        expected: formatShare(v.expected),
        actual: formatShare(v.actual),
        byBuyer: v.byBuyer.map((b) => ({
          partyId: b.partyId,
          shareBefore: formatShare(b.shareBefore),
          share: formatShare(b.share),
          acquired: formatShare(b.acquired),
        })),
      };
    case 'OWNERSHIP_INCOMPLETE':
      return { code: v.code, date: v.date, shareSum: formatShare(v.shareSum) };
    default:
      return v;
  }
}

/** A refused payment link (§26.4). */
function refusalAnswer(refusal: LinkRefusal): ErrorAnswer {
  switch (refusal.kind) {
    case 'ACQUISITION_CANCELLED':
      return answer(409, 'CONFLICT', 'A cancelled Acquisition takes no cost or payment writes.', { reason: refusal.kind });
    case 'COST_VOID':
      return answer(409, 'CONFLICT', 'The cost is void.', { reason: refusal.kind });
    case 'TRANSACTION_NOT_CURRENT':
      return answer(422, refusal.kind, 'Only a current Transaction (CONFIRMED or RECONCILED, not a reversal) can be linked.', {
        status: refusal.status,
        correctionRole: refusal.correctionRole,
      });
    case 'NOT_OUTFLOW':
      return answer(422, refusal.kind, 'Only an OUTFLOW Transaction pays an acquisition.');
    case 'CURRENCY_MISMATCH':
      return answer(422, refusal.kind, "The Transaction is not in the Acquisition's currency.");
    case 'PAYMENT_EXCEEDS_TRANSACTION':
      return answer(409, 'INVARIANT_VIOLATION', 'The payments would exceed the Transaction amount.', {
        reason: refusal.kind,
        transactionAmount: refusal.transactionAmount.toJSON(),
        linkedAmount: refusal.linkedAmount.toJSON(),
        available: refusal.available.toJSON(),
      });
    case 'PAYMENT_EXCEEDS_COST':
    case 'PAYMENT_EXCEEDS_PRICE':
      return answer(409, 'INVARIANT_VIOLATION', 'The payments would exceed the expected amount.', {
        reason: refusal.kind,
        expected: refusal.expected.toJSON(),
        paid: refusal.paid.toJSON(),
        remaining: refusal.remaining.toJSON(),
      });
  }
}

/** A write-back or removal MRE did not take (§37.4–§37.5); the reconciliation's state rides along. */
function writeBackFailureAnswer(error: WriteBackFailedError): ErrorAnswer {
  const details = { reason: error.code, mreWriteBackState: error.reconciliation.mreWriteBackState };
  switch (error.code) {
    case 'MRE_RENT_TERM_NOT_FOUND':
      // MRE also answers 404 when its own database read fails (review on #76), so the message stays neutral.
      return answer(422, 'MRE_RENT_TERM_NOT_FOUND', 'MRE did not return this rent term.', {
        ...details,
        mreTenantId: error.reconciliation.mreTenantId,
        mreRentTerm: error.reconciliation.mreRentTerm,
      });
    case 'MRE_UNAVAILABLE':
    case 'MRE_WRITE_REFUSED':
      return answer(503, 'EXTERNAL_SYSTEM_ERROR', 'MRE did not take the payment; the write-back can be retried.', details);
    case 'MRE_TERM_NOT_ROUND_TRIPPABLE':
      return answer(409, 'CONFLICT', 'Under a VAT ratio MRE would change the discount or extra charge; record this payment in MRE by hand.', details);
    default:
      return answer(409, 'CONFLICT', 'The term changed in MRE; nothing of it was repaired.', details);
  }
}

type ErrorClass<E> = new (...args: never[]) => E;
const on = <E>(type: ErrorClass<E>, toAnswer: (error: E) => ErrorAnswer) => ({ type, toAnswer: toAnswer as (error: unknown) => ErrorAnswer });

const TABLE = [
  on(AboveSuggestionError, (error) =>
    answer(422, 'ABOVE_SUGGESTION', 'A confirmation may lower the suggested amount, never raise it.', { suggested: error.suggested.toJSON() }),
  ),
  on(AccessError, (error) => access(error.code)),
  on(AcquisitionCancelledError, (error) =>
    answer(409, 'CONFLICT', 'A cancelled Acquisition is final.', {
      reason: 'ACQUISITION_CANCELLED',
      acquisitionId: error.acquisitionId,
    }),
  ),
  on(AcquisitionConfirmedError, (error) =>
    answer(409, 'CONFLICT', 'A confirmed Acquisition is final.', { reason: 'ACQUISITION_CONFIRMED', acquisitionId: error.acquisitionId }),
  ),
  on(AcquisitionCostNotFoundError, (error) => answer(404, 'NOT_FOUND', 'AcquisitionCost not found.', { acquisitionCostId: error.acquisitionCostId })),
  on(AcquisitionHasValidOwnershipsError, (error) =>
    answer(409, 'CONFLICT', 'VALID Ownerships carry this Acquisition; void them first.', {
      reason: 'ACQUISITION_HAS_VALID_OWNERSHIPS',
      ownershipIds: error.ownershipIds,
    }),
  ),
  on(AcquisitionNotDraftError, (error) =>
    answer(422, 'ACQUISITION_NOT_DRAFT', 'Only a DRAFT Acquisition takes new Ownerships.', {
      acquisitionId: error.acquisitionId,
      status: error.status,
    }),
  ),
  on(AcquisitionNotFoundError, (error) => answer(404, 'NOT_FOUND', 'Acquisition not found.', { acquisitionId: error.acquisitionId })),
  on(AcquisitionPaymentNotFoundError, (error) => answer(404, 'NOT_FOUND', 'AcquisitionPayment not found.', { paymentId: error.paymentId })),
  on(AdministratorInactiveError, (error) =>
    answer(409, 'CONFLICT', 'An inactive Party does not become the administrator of a WEG.', { reason: 'PARTY_INACTIVE', partyId: error.partyId }),
  ),
  on(AllocationNotLastError, (error) =>
    answer(409, 'CONFLICT', 'Only the last set is voided.', { reason: 'ALLOCATION_NOT_LAST', laterAllocationSetId: error.laterAllocationSetId }),
  ),
  on(AllocationRefusedError, (error) => {
    const r = error.refusal;
    const details =
      r.kind === 'ALLOCATION_BEFORE_DEBT'
        ? { debtFrom: r.debtFrom }
        : r.kind === 'ALLOCATION_NOT_APPENDED'
          ? { lastValidFrom: r.lastValidFrom }
          : { acquisitionId: r.acquisitionId };
    return answer(422, r.kind, 'The set cannot be appended.', details);
  }),
  on(AnnualStatementNotFoundError, (error) => answer(404, 'NOT_FOUND', 'Annual statement not found.', { statementId: error.statementId })),
  on(AssessmentHasSplitsError, (error) =>
    answer(409, 'CONFLICT', 'Splits name the Sonderumlage.', {
      reason: 'ASSESSMENT_HAS_SPLITS',
      assessmentId: error.assessmentId,
      transactionIds: error.transactionIds,
    }),
  ),
  on(AssessmentNotActiveError, (error) =>
    answer(409, 'CONFLICT', `The Sonderumlage is ${error.status}.`, {
      reason: 'ASSESSMENT_NOT_ACTIVE',
      wegSpecialAssessmentId: error.wegSpecialAssessmentId,
      status: error.status,
    }),
  ),
  on(AssessmentOutsideMembershipError, (error) =>
    answer(422, 'ASSESSMENT_OUTSIDE_MEMBERSHIP', 'The resolution date lies outside the membership.', {
      validFrom: error.validFrom,
      validUntil: error.validUntil,
    }),
  ),
  on(AlreadyMatchedError, (error) =>
    answer(409, 'CONFLICT', 'This Transaction already matches this rent term.', {
      reason: 'ALREADY_MATCHED',
      reconciliationId: error.reconciliationId,
    }),
  ),
  on(ClosingBeforeDebtError, (error) => answer(422, 'CLOSING_BEFORE_DEBT', 'The closing date is before the debt starts.', { debtFrom: error.debtFrom })),
  on(ConcurrentUpdateError, () => ({
    ...answer(503, 'CONCURRENT_UPDATE', 'The external reference kept changing concurrently; nothing was written. Retry.'),
    headers: { 'Retry-After': '1' },
  })),
  on(ConfirmationBlockedError, (error) =>
    answer(422, 'CONFIRMATION_BLOCKED', 'The Acquisition does not meet the requirements of confirmation.', {
      violations: error.violations.map(violationDto),
    }),
  ),
  on(CorrectionNoChangeError, () => answer(409, 'CONFLICT', 'The replacement equals the original; nothing to correct.', { reason: 'NO_CHANGE' })),
  on(CostHasPaymentsError, (error) =>
    answer(409, 'CONFLICT', 'Payments are linked to this cost; unlink them first.', {
      reason: 'COST_HAS_PAYMENTS',
      paymentIds: error.paymentIds,
    }),
  ),
  on(CurrentAllocationChangedError, (error) =>
    answer(409, 'CONFLICT', 'supersedes does not name the current allocation.', {
      reason: 'CURRENT_ALLOCATION_CHANGED',
      currentAllocationId: error.currentAllocationId,
    }),
  ),
  on(DepositCashAfterClosingDateError, (error) =>
    answer(409, 'CONFLICT', 'Cash of the security deposit lies after the closing date.', {
      reason: 'CASH_AFTER_CLOSING_DATE',
      transactionIds: error.transactionIds,
    }),
  ),
  on(DepositClosedError, (error) =>
    answer(409, 'CONFLICT', 'The security deposit is closed.', { reason: 'DEPOSIT_CLOSED', securityDepositId: error.securityDepositId }),
  ),
  on(DepositExistsError, (error) =>
    answer(409, 'CONFLICT', 'The Tenant already has a security deposit.', { reason: 'DEPOSIT_EXISTS', securityDepositId: error.securityDepositId }),
  ),
  on(DepositHasSplitsError, (error) =>
    answer(409, 'CONFLICT', 'Splits reference the security deposit.', { reason: 'DEPOSIT_HAS_SPLITS', transactionIds: error.transactionIds }),
  ),
  on(DepositNotActiveError, (error) =>
    answer(409, 'CONFLICT', `The security deposit is ${error.status}.`, {
      reason: 'DEPOSIT_NOT_ACTIVE',
      securityDepositId: error.securityDepositId,
      status: error.status,
    }),
  ),
  on(DepositNotClosedError, (error) =>
    answer(409, 'CONFLICT', `The security deposit is ${error.status}, not CLOSED.`, {
      reason: 'DEPOSIT_NOT_CLOSED',
      securityDepositId: error.securityDepositId,
      status: error.status,
    }),
  ),
  on(DepositStillHeldError, (error) =>
    answer(409, 'CONFLICT', 'The security deposit still holds cash; RETURNED needs held = 0.', { reason: 'DEPOSIT_STILL_HELD', held: error.held.toJSON() }),
  ),
  on(EconomicPlanNotFoundError, (error) => answer(404, 'NOT_FOUND', 'Economic plan not found.', { economicPlanId: error.economicPlanId })),
  on(EffectiveFromOutsideYearError, () => validation([{ field: 'effectiveFrom', code: 'OUT_OF_RANGE' }])),
  on(ExpectedAmountRequiredError, () =>
    answer(422, 'EXPECTED_AMOUNT_REQUIRED', 'No expectedAmount was given, and MRE has no guaranty for the Tenant; nothing was written.'),
  ),
  on(ExternalReferenceInUseError, (error) =>
    answer(409, 'CONFLICT', 'Another Party holds this external reference.', { reason: 'REFERENCE_IN_USE', partyId: error.partyId }),
  ),
  on(ExternalReferenceNotFoundError, (error) => answer(404, 'NOT_FOUND', 'External reference not found.', { externalReferenceId: error.externalReferenceId })),
  on(FinancialAccountClosedError, (error) =>
    answer(409, 'CONFLICT', 'The FinancialAccount is closed.', {
      reason: 'ACCOUNT_CLOSED',
      financialAccountId: error.financialAccountId,
    }),
  ),
  on(FinancialAccountNotFoundError, (error) =>
    answer(404, 'NOT_FOUND', 'FinancialAccount not found.', {
      financialAccountId: error.financialAccountId,
    }),
  ),
  on(HausgeldNotProposableError, (error) =>
    answer(409, 'CONFLICT', 'Only an unconfirmed OUTFLOW gets a Hausgeld proposal.', {
      reason: 'NOT_PROPOSABLE',
      direction: error.direction,
      status: error.status,
    }),
  ),
  on(HoldingAccountNotFoundError, (error) => answer(404, 'NOT_FOUND', 'FinancialAccount not found.', { financialAccountId: error.financialAccountId })),
  on(IdempotencyKeyConflictError, () => answer(409, 'CONFLICT', 'Idempotency-Key was already used with a different payload.')),
  on(ImportBatchNotFoundError, (error) =>
    answer(404, 'NOT_FOUND', 'ImportBatch not found.', {
      importBatchId: error.importBatchId,
    }),
  ),
  on(ImportedFieldsFixedError, (error) =>
    answer(409, 'CONFLICT', 'An imported Transaction keeps the values of its bank row.', {
      reason: 'IMPORTED_FIELDS_FIXED',
      fields: error.fields,
    }),
  ),
  on(ImportAccountMismatchError, (error) =>
    answer(422, 'ACCOUNT_IBAN_MISMATCH', "The file's own account does not match the FinancialAccount; nothing was imported.", {
      reason: error.reason,
      accountIban: error.accountIban,
      fileIbans: error.fileIbans,
    }),
  ),
  on(ImportFileError, (error) =>
    answer(400, 'IMPORT_ERROR', error.error.message, {
      reason: error.error.code,
    }),
  ),
  on(InactiveCategoryError, (error) =>
    answer(422, 'REVIEW_REQUIRED', 'A split uses an inactive financial category.', {
      reason: 'INACTIVE_CATEGORY',
      financialCategoryCodes: error.codes,
    }),
  ),
  on(InvalidLoanSplitError, (error) =>
    answer(422, 'INVALID_LOAN_SPLIT', 'A split with a Loan is LOAN_INTEREST or LOAN_PRINCIPAL of an OUTFLOW.', {
      position: error.position,
      reason: error.reason,
    }),
  ),
  on(InvalidSecurityDepositSplitError, (error) =>
    answer(422, 'INVALID_SECURITY_DEPOSIT_SPLIT', 'A split with a security deposit is SECURITY_DEPOSIT, or SECURITY_DEPOSIT_INTEREST of an INFLOW.', {
      position: error.position,
      reason: error.reason,
    }),
  ),
  on(InvalidMembershipError, (error) =>
    answer(422, 'INVALID_MEMBERSHIP', 'The WEG membership cannot end on that day.', { membershipId: error.membershipId, reason: error.reason }),
  ),
  on(InvalidOwnershipError, (error) =>
    answer(422, 'INVALID_OWNERSHIP', 'The Ownership cannot be closed so.', { ownershipId: error.ownershipId, reason: error.reason }),
  ),
  on(InvalidSupersedesError, (error) =>
    answer(422, 'INVALID_SUPERSEDES', 'Only a CONFIRMED statement of the same membership and year is superseded.', {
      supersedes: error.supersedes,
      reason: error.reason,
    }),
  ),
  on(InvalidWegAssessmentSplitError, (error) =>
    answer(422, 'INVALID_WEG_ASSESSMENT_SPLIT', 'A split naming a Sonderumlage is WEG_SPECIAL_ASSESSMENT of its unit.', {
      position: error.position,
      reason: error.reason,
    }),
  ),
  on(InvalidWegStatementSplitError, (error) =>
    answer(422, 'INVALID_WEG_STATEMENT_SPLIT', "A split naming a statement is a WEG split of the statement's unit.", {
      position: error.position,
      reason: error.reason,
    }),
  ),
  on(LoanAllocationSetNotFoundError, (error) => answer(404, 'NOT_FOUND', 'Allocation set not found.', { allocationSetId: error.allocationSetId })),
  on(LoanBalanceStatementNotFoundError, (error) => answer(404, 'NOT_FOUND', 'Balance statement not found.', { statementId: error.statementId })),
  on(LoanClosedError, (error) => answer(409, 'CONFLICT', 'A closed Loan is final.', { reason: 'LOAN_CLOSED', loanId: error.loanId })),
  on(LoanClosedOnError, (error) =>
    answer(409, 'CONFLICT', `The Loan was closed on ${error.closingDate}.`, { reason: 'LOAN_CLOSED', closingDate: error.closingDate }),
  ),
  on(LoanFieldsInvalidError, (error) => validation(error.errors)),
  on(LoanHasSplitsError, (error) => answer(409, 'CONFLICT', 'Splits reference the Loan.', { reason: 'LOAN_HAS_SPLITS', transactionIds: error.transactionIds })),
  on(LoanNotActiveError, (error) => answer(409, 'CONFLICT', `The Loan is ${error.status}.`, { reason: 'LOAN_NOT_ACTIVE', status: error.status })),
  on(LoanNotAllocatedError, (error) => answer(409, 'CONFLICT', 'No allocation set covers the day.', { reason: 'LOAN_NOT_ALLOCATED', ...error.details })),
  on(LoanNotFoundError, (error) => answer(404, 'NOT_FOUND', 'Loan not found.', { loanId: error.loanId })),
  on(LoanRefinancesError, (error) =>
    answer(409, 'CONFLICT', 'A closed Loan names this one as its refinancing.', { reason: 'LOAN_REFINANCES', loanIds: error.loanIds }),
  ),
  on(LoanTermsNotFoundError, (error) => answer(404, 'NOT_FOUND', 'Loan terms not found.', { termsId: error.termsId })),
  on(MembershipHasAssessmentsError, (error) =>
    answer(409, 'CONFLICT', 'Sonderumlagen of the WEG membership lie outside what would remain of it.', {
      reason: 'MEMBERSHIP_HAS_ASSESSMENTS',
      membershipId: error.membershipId,
      assessmentIds: error.assessmentIds,
    }),
  ),
  on(MembershipHasPlansError, (error) =>
    answer(409, 'CONFLICT', 'Plans of the WEG membership lie outside what would remain of it.', {
      reason: 'MEMBERSHIP_HAS_PLANS',
      membershipId: error.membershipId,
      economicPlanIds: error.economicPlanIds,
    }),
  ),
  on(MembershipHasSplitsError, (error) =>
    answer(409, 'CONFLICT', 'WEG splits of the unit lie outside what would remain of the membership.', {
      reason: 'MEMBERSHIP_HAS_SPLITS',
      membershipId: error.membershipId,
      transactionIds: error.transactionIds,
    }),
  ),
  on(MembershipHasStatementsError, (error) =>
    answer(409, 'CONFLICT', 'Annual statements of the WEG membership lie outside what would remain of it.', {
      reason: 'MEMBERSHIP_HAS_STATEMENTS',
      membershipId: error.membershipId,
      statementIds: error.statementIds,
    }),
  ),
  on(MembershipNotActiveError, (error) =>
    answer(409, 'CONFLICT', 'The WEG membership is VOID.', { reason: 'MEMBERSHIP_NOT_ACTIVE', membershipId: error.membershipId }),
  ),
  on(MrePropertyNotFoundError, (error) =>
    answer(404, 'NOT_FOUND', 'MRE Property not found in this Realm.', {
      mreRealmId: error.mreRealmId,
      mrePropertyId: error.mrePropertyId,
    }),
  ),
  on(MreRentTermNotFoundError, (error) =>
    answer(422, 'MRE_RENT_TERM_NOT_FOUND', 'MRE did not return this rent term.', { mreTenantId: error.mreTenantId, mreRentTerm: error.mreRentTerm }),
  ),
  on(MreTenantNotFoundError, (error) => answer(404, 'NOT_FOUND', 'MRE Tenant not found in this Realm.', { externalId: error.externalId })),
  on(MreUnavailableError, () => answer(503, 'EXTERNAL_SYSTEM_ERROR', 'MRE is unavailable; nothing was written.')),
  on(NoEconomicPlanError, (error) =>
    answer(422, 'NO_ECONOMIC_PLAN', 'The membership has no plan in force on the booking date.', {
      membershipId: error.membershipId,
      bookingDate: error.bookingDate,
    }),
  ),
  on(NoRentCashError, () => answer(422, 'NO_RENT_CASH', 'The Transaction has no split in a rent category.')),
  on(NoWegMembershipError, (error) =>
    answer(422, 'NO_WEG_MEMBERSHIP', error.reason === 'NO_UNIT' ? 'A WEG split names its unit.' : 'The unit has no WEG membership on the booking date.', {
      ...(error.position === null ? {} : { position: error.position }),
      reason: error.reason,
      ...(error.propertyReferenceId === null ? {} : { propertyReferenceId: error.propertyReferenceId, bookingDate: error.bookingDate }),
    }),
  ),
  on(NothingToSettleError, (error) =>
    answer(409, 'CONFLICT', 'The statement has nothing to settle.', { reason: 'NOTHING_TO_SETTLE', statementId: error.statementId }),
  ),
  on(NoScheduleError, (error) => answer(409, 'CONFLICT', 'The Loan has no planned payment.', { reason: 'NO_SCHEDULE', endReason: error.endReason })),
  on(NotASecurityDepositAccountError, (error) =>
    answer(422, 'NOT_A_SECURITY_DEPOSIT_ACCOUNT', 'The holding account is not a SECURITY_DEPOSIT account.', {
      financialAccountId: error.financialAccountId,
      accountType: error.accountType,
    }),
  ),
  on(NotConfirmableError, (error) =>
    answer(409, 'CONFLICT', `A ${error.status} reconciliation cannot be confirmed.`, { reason: 'NOT_CONFIRMABLE', status: error.status }),
  ),
  on(NotRejectableError, (error) =>
    answer(409, 'CONFLICT', `A ${error.status} reconciliation cannot be rejected.`, { reason: 'NOT_REJECTABLE', status: error.status }),
  ),
  on(NotReleasableError, (error) =>
    answer(409, 'CONFLICT', `A ${error.status} reconciliation cannot be released.`, { reason: 'NOT_RELEASABLE', status: error.status }),
  ),
  on(NotRemovableError, (error) =>
    answer(409, 'CONFLICT', `A ${error.status} reconciliation in ${error.mreWriteBackState} has nothing to remove from MRE.`, {
      reason: 'NOT_REMOVABLE',
      status: error.status,
      mreWriteBackState: error.mreWriteBackState,
    }),
  ),
  on(NotWritableError, (error) =>
    answer(409, 'CONFLICT', `A ${error.status} reconciliation cannot be written back to MRE.`, { reason: 'NOT_WRITABLE', status: error.status }),
  ),
  on(NothingRetainedError, (error) =>
    answer(409, 'CONFLICT', 'Nothing is retained; RETAINED needs held > 0.', { reason: 'NOTHING_RETAINED', held: error.held.toJSON() }),
  ),
  on(OverlappingOwnershipError, (error) =>
    answer(422, 'OVERLAPPING_OWNERSHIP', 'The owner already holds an overlapping Ownership of this PropertyReference.', {
      ownershipId: error.ownershipId,
    }),
  ),
  on(OverlappingWegMembershipError, (error) =>
    answer(409, 'CONFLICT', 'The unit already belongs to a WEG on an overlapping day.', {
      reason: 'OVERLAPPING_WEG_MEMBERSHIP',
      membershipId: error.membershipId,
      wegId: error.wegId,
    }),
  ),
  on(OwnerInactiveError, (error) => answer(422, 'PARTY_INACTIVE', 'A Party named here must be active.', { partyId: error.partyId })),
  on(OwnershipBasisIncompleteError, (error) =>
    answer(409, 'CONFLICT', "The Acquisition's Ownerships do not form a complete basis.", {
      reason: 'OWNERSHIP_BASIS_INCOMPLETE',
      violations: error.violations.map(violationDto),
    }),
  ),
  on(OwnershipIncompleteError, (error) =>
    answer(422, 'OWNERSHIP_INCOMPLETE', 'The ownership was complete and would no longer be.', {
      date: error.date,
      shareSum: formatShare(error.shareSum),
    }),
  ),
  on(OwnershipNotFoundError, (error) => answer(404, 'NOT_FOUND', 'Ownership not found.', { ownershipId: error.ownershipId })),
  on(OwnershipOfConfirmedAcquisitionError, (error) =>
    answer(409, 'CONFLICT', 'The Ownership carries a confirmed Acquisition; close it instead of voiding it.', {
      reason: 'ACQUISITION_CONFIRMED',
      acquisitionId: error.acquisitionId,
    }),
  ),
  on(OwnershipTotalExceedsOneError, (error) =>
    answer(422, 'OWNERSHIP_TOTAL_EXCEEDS_ONE', 'The shares would sum above 1.', { date: error.date, shareSum: formatShare(error.shareSum) }),
  ),
  on(PartyFieldNotAllowedError, (error) => validation(error.fields.map((field) => ({ field, code: 'NOT_ALLOWED_FOR_TYPE' })))),
  on(PartyInactiveError, (error) =>
    answer(409, 'CONFLICT', 'An inactive Party gets no new external reference.', { reason: 'PARTY_INACTIVE', partyId: error.partyId }),
  ),
  on(PartyNotFoundError, (error) => answer(404, 'NOT_FOUND', 'Party not found.', { partyId: error.partyId })),
  on(PlanExistsError, (error) =>
    answer(409, 'CONFLICT', 'A plan of the membership starts on the same day.', { reason: 'PLAN_EXISTS', economicPlanId: error.economicPlanId }),
  ),
  on(PlanOutsideMembershipError, (error) =>
    answer(422, 'PLAN_OUTSIDE_MEMBERSHIP', 'The plan starts outside the membership.', { validFrom: error.validFrom, validUntil: error.validUntil }),
  ),
  on(PaymentNotProposableError, (error) =>
    answer(409, 'CONFLICT', 'Only an unconfirmed OUTFLOW gets a payment proposal.', {
      reason: 'NOT_PROPOSABLE',
      direction: error.direction,
      status: error.status,
    }),
  ),
  on(PaymentRefusedError, (error) => refusalAnswer(error.refusal)),
  on(PeriodOutsideYearError, (error) => validation([{ field: error.field, code: 'OUT_OF_RANGE' }])),
  on(PredecessorOfConfirmedAcquisitionError, (error) =>
    answer(409, 'CONFLICT', "The owner's next Ownership carries a confirmed Acquisition; its acquired share cannot change.", {
      reason: 'ACQUISITION_CONFIRMED',
      acquisitionId: error.acquisitionId,
      ownershipId: error.successorOwnershipId,
    }),
  ),
  on(SettlementDirectionMismatchError, (error) =>
    answer(422, 'SETTLEMENT_DIRECTION_MISMATCH', 'A back-payment is an OUTFLOW, a refund an INFLOW.', { expected: error.expected }),
  ),
  on(SettlementNotProposableError, (error) =>
    answer(409, 'CONFLICT', 'Only an unconfirmed Transaction gets a settlement proposal.', { reason: 'NOT_PROPOSABLE', status: error.status }),
  ),
  on(SpecialAssessmentNotFoundError, (error) => answer(404, 'NOT_FOUND', 'Special assessment not found.', { assessmentId: error.assessmentId })),
  on(PropertyReferenceNotFoundError, (error) => answer(404, 'NOT_FOUND', 'PropertyReference not found.', { propertyReferenceId: error.propertyReferenceId })),
  on(ProposalTransactionNotFoundError, (error) => answer(404, 'NOT_FOUND', 'Transaction not found.', { transactionId: error.transactionId })),
  on(ReconciliationNotFoundError, (error) => answer(404, 'NOT_FOUND', 'Rent reconciliation not found.', { reconciliationId: error.reconciliationId })),
  on(RefinancingLoanNotActiveError, (error) => answer(422, 'REFINANCING_LOAN_NOT_ACTIVE', 'The refinancing Loan must be ACTIVE.', { status: error.status })),
  on(RefinancingLoanNotFoundError, (error) => answer(404, 'NOT_FOUND', 'Refinancing Loan not found.', { refinancedByLoanId: error.refinancedByLoanId })),
  on(RemainingDebtNotZeroError, (error) =>
    answer(409, 'CONFLICT', 'The remaining debt on the closing date is not 0.', {
      reason: 'REMAINING_DEBT_NOT_ZERO',
      actual: signedEurCents(error.actual),
    }),
  ),
  on(RemovalTooEarlyError, (error) =>
    answer(409, 'CONFLICT', 'A late write-back to MRE could still land; the removal may start later.', {
      reason: 'REMOVAL_TOO_EARLY',
      notBefore: error.notBefore.toISOString(),
    }),
  ),
  on(RentCashExceededError, (error) =>
    answer(409, 'CONFLICT', 'The matched amount exceeds the available rent cash.', {
      reason: 'RENT_CASH_EXCEEDED',
      rentCash: error.rentCash.toJSON(),
      available: error.available.toJSON(),
    }),
  ),
  on(RentNotProposableError, (error) =>
    answer(409, 'CONFLICT', 'Only an unconfirmed INFLOW gets a rent split proposal.', {
      reason: 'NOT_PROPOSABLE',
      direction: error.direction,
      status: error.status,
    }),
  ),
  on(ReviewItemNotFoundError, (error) => answer(404, 'NOT_FOUND', 'ImportReviewItem not found in this ImportBatch.', { reviewItemId: error.reviewItemId })),
  on(ReviewResolutionConflictError, (error) =>
    answer(409, 'CONFLICT', 'The review item is already resolved differently.', {
      reason: 'ALREADY_RESOLVED',
      resolution: error.item.resolution,
    }),
  ),
  on(SecurityDepositNotFoundError, (error) => answer(404, 'NOT_FOUND', 'Security deposit not found.', { securityDepositId: error.securityDepositId })),
  on(SplitsAfterClosingError, (error) =>
    answer(409, 'CONFLICT', 'Splits name the Loan after the closing date.', { reason: 'SPLITS_AFTER_CLOSING', transactionIds: error.transactionIds }),
  ),
  on(SplitsMissingError, () =>
    answer(409, 'INVARIANT_VIOLATION', 'Transaction has no splits; split it before confirming.', {
      reason: 'SPLITS_MISSING',
    }),
  ),
  on(SplitSumMismatchError, (error) =>
    answer(409, 'INVARIANT_VIOLATION', 'Splits do not add up to the Transaction amount.', {
      reason: 'SPLIT_SUM_MISMATCH',
      expected: error.expected.toJSON(),
      actual: error.actual.toJSON(),
      difference: error.expected.subtract(error.actual).toJSON(),
    }),
  ),
  on(StatementAfterClosingError, (error) =>
    answer(422, 'STATEMENT_AFTER_CLOSING', 'The statement is after the Loan was closed.', { closingDate: error.closingDate }),
  ),
  on(StatementBeforeDebtError, (error) => answer(422, 'STATEMENT_BEFORE_DEBT', 'The statement is before the debt starts.', { debtFrom: error.debtFrom })),
  on(StatementExistsError, (error) =>
    answer(409, 'CONFLICT', 'Another statement of the membership and year is confirmed; supersede it instead.', {
      reason: 'STATEMENT_EXISTS',
      statementId: error.statementId,
    }),
  ),
  on(StatementNotConfirmedError, (error) =>
    answer(409, 'CONFLICT', `The annual statement is ${error.status}; the comparison reads a confirmed one.`, {
      reason: 'STATEMENT_NOT_CONFIRMED',
      statementId: error.statementId,
      status: error.status,
    }),
  ),
  on(StatementNotCurrentError, (error) =>
    answer(409, 'CONFLICT', `The annual statement is ${error.status}; a settlement names the statement in force.`, {
      reason: 'STATEMENT_NOT_CURRENT',
      wegAnnualStatementId: error.wegAnnualStatementId,
      status: error.status,
      ...(error.supersededBy === null ? {} : { supersededBy: error.supersededBy }),
    }),
  ),
  on(StatementNotDraftError, (error) =>
    answer(409, 'CONFLICT', `The annual statement is ${error.status}.`, {
      reason: 'STATEMENT_NOT_DRAFT',
      statementId: error.statementId,
      status: error.status,
    }),
  ),
  on(StatementOutsideMembershipError, (error) =>
    answer(422, 'STATEMENT_OUTSIDE_MEMBERSHIP', "The statement's period lies outside the membership.", {
      validFrom: error.validFrom,
      validUntil: error.validUntil,
    }),
  ),
  on(SuggestionStaleError, (error) =>
    answer(409, 'CONFLICT', 'The term was matched in between; the amount is above its open amount now.', {
      reason: 'SUGGESTION_STALE',
      openAmount: error.openAmount.toJSON(),
    }),
  ),
  on(TermsNotLastError, (error) => answer(409, 'CONFLICT', 'Only the last period is voided.', { reason: 'TERMS_NOT_LAST', laterTermsId: error.laterTermsId })),
  on(TermsRefusedError, (error) => {
    const r = error.refusal;
    const details =
      r.kind === 'TERMS_BEFORE_DEBT'
        ? { debtFrom: r.debtFrom }
        : r.kind === 'TERMS_NOT_APPENDED'
          ? { lastValidFrom: r.lastValidFrom }
          : r.kind === 'PREVIOUS_TERMS_WITHOUT_PAYMENT'
            ? { termsId: r.termsId, firstPaymentDate: r.firstPaymentDate }
            : r.kind === 'PRINCIPAL_AT_START_EXCEEDS_ORIGINAL'
              ? { principalOriginal: r.principalOriginal.toJSON() }
              : r.kind === 'PAYMENT_DOES_NOT_COVER_INTEREST'
                ? { firstInterest: eurCents(r.firstInterest), balance: eurCents(r.balance) }
                : undefined;
    return answer(422, r.kind, 'The period cannot be appended.', details);
  }),
  on(TransactionAlreadyCorrectedError, (error) =>
    answer(409, 'CONFLICT', 'Transaction is already corrected or reversed.', {
      reason: 'ALREADY_CORRECTED',
      reversalTransactionId: error.reversalTransactionId,
      replacementTransactionId: error.replacementTransactionId,
    }),
  ),
  on(TransactionFrozenError, (error) =>
    answer(409, 'CONFLICT', `Transaction is ${error.status}; its splits cannot change.`, {
      reason: 'TRANSACTION_FROZEN',
      status: error.status,
    }),
  ),
  on(TransactionNotAmendableError, (error) =>
    answer(409, 'CONFLICT', `Transaction is ${error.status} and cannot be amended.`, {
      reason: 'NOT_AMENDABLE',
      status: error.status,
    }),
  ),
  on(TransactionNotConfirmableError, (error) =>
    answer(409, 'CONFLICT', `Transaction is ${error.status} and cannot be confirmed.`, {
      reason: 'NOT_CONFIRMABLE',
      status: error.status,
    }),
  ),
  on(TransactionNotCorrectableError, (error) => {
    const message =
      error.correctionRole === 'REVERSAL'
        ? 'A reversal cannot be corrected or reversed; correct or reverse its original’s replacement.'
        : `Transaction is ${error.status} and cannot be corrected or reversed.`;
    return answer(409, 'CONFLICT', message, {
      reason: 'NOT_CORRECTABLE',
      status: error.status,
      ...(error.correctionRole === undefined ? {} : { correctionRole: error.correctionRole }),
    });
  }),
  on(TransactionNotCountedError, (error) =>
    answer(409, 'CONFLICT', 'Only a confirmed, current Transaction is cash that can be matched.', {
      reason: 'TRANSACTION_NOT_COUNTED',
      status: error.status,
      correctionRole: error.correctionRole,
    }),
  ),
  on(TransactionNotFoundError, (error) => answer(404, 'NOT_FOUND', 'Transaction not found.', { transactionId: error.transactionId })),
  on(TransactionNotIgnorableError, (error) =>
    answer(409, 'CONFLICT', `Transaction is ${error.status} and cannot be ignored; correct it instead.`, {
      reason: 'NOT_IGNORABLE',
      status: error.status,
    }),
  ),
  on(TransactionNotIgnoredError, (error) =>
    answer(409, 'CONFLICT', `Transaction is ${error.status}, not IGNORED.`, { reason: 'NOT_IGNORED', status: error.status }),
  ),
  on(TransactionNotInflowError, () => answer(422, 'TRANSACTION_NOT_INFLOW', 'Rent is matched only to an INFLOW.')),
  on(TransactionRentReconciledError, (error) =>
    answer(409, 'CONFLICT', 'Confirmed rent reconciliations match this Transaction; release them first.', {
      reason: 'TRANSACTION_RENT_RECONCILED',
      reconciliationIds: error.reconciliationIds,
    }),
  ),
  on(UnconfirmedDepositCashError, (error) =>
    answer(409, 'CONFLICT', 'Unconfirmed Transactions name the security deposit; confirm or unlink them first.', {
      reason: 'UNCONFIRMED_CASH',
      transactionIds: error.transactionIds,
    }),
  ),
  on(UnsupportedAdapterError, () => validation([{ field: 'adapterId', code: 'NOT_SUPPORTED' }])),
  on(VersionConflictError, (error) =>
    answer(412, 'VERSION_CONFLICT', 'The resource changed since the version given in If-Match.', {
      expectedVersions: error.expectedVersions,
      currentVersion: error.currentVersion,
    }),
  ),
  on(WegHasMembershipsError, (error) =>
    answer(409, 'CONFLICT', 'Active memberships hang off the WEG; void them first.', { reason: 'WEG_HAS_MEMBERSHIPS', membershipIds: error.membershipIds }),
  ),
  on(WegHasYearsError, (error) =>
    answer(409, 'CONFLICT', 'Plans and statements are filed by financial year; its start month is fixed.', { reason: 'WEG_HAS_YEARS', wegId: error.wegId }),
  ),
  on(WegMembershipNotFoundError, (error) => answer(404, 'NOT_FOUND', 'WEG membership not found.', { membershipId: error.membershipId })),
  on(WegNotActiveError, (error) =>
    answer(409, 'CONFLICT', `The WEG is ${error.status}.`, { reason: 'WEG_NOT_ACTIVE', wegId: error.wegId, status: error.status }),
  ),
  on(WegNotFoundError, (error) => answer(404, 'NOT_FOUND', 'WEG not found.', { wegId: error.wegId })),
  on(WegAssessmentNotFoundError, (error) =>
    answer(404, 'NOT_FOUND', 'WEG special assessment not found.', { wegSpecialAssessmentId: error.wegSpecialAssessmentId }),
  ),
  on(WegStatementNotFoundError, (error) => answer(404, 'NOT_FOUND', 'WEG annual statement not found.', { wegAnnualStatementId: error.wegAnnualStatementId })),
  on(WriteBackFailedError, (error) => writeBackFailureAnswer(error)),
  on(WriteBackInProgressError, (error) =>
    answer(409, 'CONFLICT', 'A write-back to MRE is running for this MRE Tenant.', {
      reason: 'WRITE_BACK_IN_PROGRESS',
      reconciliationId: error.reconciliationId,
    }),
  ),
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
    error.reason !== undefined
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
  on(RentalContractReferenceNotFoundError, (error) =>
    answer(404, 'NOT_FOUND', 'Rental contract reference not found.', { rentalContractReferenceId: error.rentalContractReferenceId }),
  ),
  on(RentalContractReferenceExistsError, (error) =>
    answer(409, 'CONFLICT', 'The MRE Tenant has a rental contract reference already.', {
      reason: 'RENTAL_CONTRACT_REFERENCE_EXISTS',
      rentalContractReferenceId: error.rentalContractReferenceId,
    }),
  ),
  on(RentalContractTenantNotFoundError, (error) =>
    answer(422, 'MRE_TENANT_NOT_FOUND', 'MRE has no such Tenant in this Realm.', { mreTenantId: error.mreTenantId }),
  ),
  // The DepreciationAsset (api-design §59, VC-8-01).
  on(DepreciationAssetNotFoundError, (error) => answer(404, 'NOT_FOUND', 'Depreciation asset not found.', { assetId: error.assetId })),
  on(BuildingAssetExistsError, (error) =>
    answer(409, 'CONFLICT', 'The PropertyReference already has an active building asset.', { reason: 'BUILDING_ASSET_EXISTS', assetId: error.assetId }),
  ),
  on(DepreciationAssetNotActiveError, (error) =>
    answer(409, 'CONFLICT', `The depreciation asset is ${error.status}.`, { reason: 'ASSET_NOT_ACTIVE', assetId: error.assetId, status: error.status }),
  ),
  on(CompletionYearMissingError, (error) =>
    answer(409, 'CONFLICT', "The building's completion year is not recorded; nothing to confirm.", {
      reason: 'COMPLETION_YEAR_MISSING',
      assetId: error.assetId,
    }),
  ),
  on(AssetAdvisorConfirmedError, (error) =>
    answer(409, 'CONFLICT', 'A user cannot lower an advisor confirmation; amend the review state to NEEDS_REVIEW first.', {
      reason: 'ADVISOR_CONFIRMED',
      assetId: error.assetId,
    }),
  ),
  // The schedule of the purchase (api-design §59A, VC-8-02).
  on(NotAnOwnerError, (error) =>
    answer(422, 'NOT_AN_OWNER', "The Party holds no share of the asset's PropertyReference and bought none.", {
      ownerPartyId: error.ownerPartyId,
      propertyReferenceId: error.propertyReferenceId,
    }),
  ),
  on(AcquisitionNotOfPropertyError, (error) =>
    answer(422, 'ACQUISITION_NOT_OF_PROPERTY', 'The Acquisition belongs to another PropertyReference.', {
      acquisitionId: error.acquisitionId,
      propertyReferenceId: error.propertyReferenceId,
    }),
  ),
];

/** The answer for an error a use case threw, or undefined (→ 500). */
export function answerFor(error: unknown): ErrorAnswer | undefined {
  return TABLE.find((entry) => error instanceof entry.type)?.toAnswer(error);
}
