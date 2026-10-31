import {
  AdministratorInactiveError,
  AnnualStatementNotFoundError,
  AssessmentHasSplitsError,
  AssessmentOutsideMembershipError,
  EconomicPlanNotFoundError,
  EffectiveFromOutsideYearError,
  HausgeldNotProposableError,
  InvalidMembershipError,
  InvalidSupersedesError,
  MembershipHasPlansError,
  MembershipHasAssessmentsError,
  MembershipHasSplitsError,
  MembershipHasStatementsError,
  MembershipNotActiveError,
  NoEconomicPlanError,
  NothingToSettleError,
  OverlappingWegMembershipError,
  PlanExistsError,
  PlanOutsideMembershipError,
  PeriodOutsideYearError,
  SettlementDirectionMismatchError,
  SettlementNotProposableError,
  SpecialAssessmentNotFoundError,
  StatementExistsError,
  StatementNotConfirmedError,
  StatementNotDraftError,
  StatementOutsideMembershipError,
  WegHasMembershipsError,
  WegHasYearsError,
  WegMembershipNotFoundError,
  WegNotActiveError,
  WegNotFoundError,
} from '../../application/index.js';
import { answer, on, validation } from './answer.js';

/** The answers to the WEG module's errors (part of the central table, `../error-answers.ts`). */
export const WEG_ANSWERS = [
  on(AdministratorInactiveError, (error) =>
    answer(409, 'CONFLICT', 'An inactive Party does not become the administrator of a WEG.', { reason: 'PARTY_INACTIVE', partyId: error.partyId }),
  ),
  on(AnnualStatementNotFoundError, (error) => answer(404, 'NOT_FOUND', 'Annual statement not found.', { statementId: error.statementId })),
  on(AssessmentHasSplitsError, (error) =>
    answer(409, 'CONFLICT', 'Splits name the Sonderumlage.', {
      reason: 'ASSESSMENT_HAS_SPLITS',
      assessmentId: error.assessmentId,
      transactionIds: error.transactionIds,
    }),
  ),
  on(AssessmentOutsideMembershipError, (error) =>
    answer(422, 'ASSESSMENT_OUTSIDE_MEMBERSHIP', 'The resolution date lies outside the membership.', {
      validFrom: error.validFrom,
      validUntil: error.validUntil,
    }),
  ),
  on(EconomicPlanNotFoundError, (error) => answer(404, 'NOT_FOUND', 'Economic plan not found.', { economicPlanId: error.economicPlanId })),
  on(EffectiveFromOutsideYearError, () => validation([{ field: 'effectiveFrom', code: 'OUT_OF_RANGE' }])),
  on(HausgeldNotProposableError, (error) =>
    answer(409, 'CONFLICT', 'Only an unconfirmed OUTFLOW gets a Hausgeld proposal.', {
      reason: 'NOT_PROPOSABLE',
      direction: error.direction,
      status: error.status,
    }),
  ),
  on(InvalidMembershipError, (error) =>
    answer(422, 'INVALID_MEMBERSHIP', 'The WEG membership cannot end on that day.', { membershipId: error.membershipId, reason: error.reason }),
  ),
  on(InvalidSupersedesError, (error) =>
    answer(422, 'INVALID_SUPERSEDES', 'Only a CONFIRMED statement of the same membership and year is superseded.', {
      supersedes: error.supersedes,
      reason: error.reason,
    }),
  ),
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
  on(NoEconomicPlanError, (error) =>
    answer(422, 'NO_ECONOMIC_PLAN', 'The membership has no plan in force on the booking date.', {
      membershipId: error.membershipId,
      bookingDate: error.bookingDate,
    }),
  ),
  on(NothingToSettleError, (error) =>
    answer(409, 'CONFLICT', 'The statement has nothing to settle.', { reason: 'NOTHING_TO_SETTLE', statementId: error.statementId }),
  ),
  on(OverlappingWegMembershipError, (error) =>
    answer(409, 'CONFLICT', 'The unit already belongs to a WEG on an overlapping day.', {
      reason: 'OVERLAPPING_WEG_MEMBERSHIP',
      membershipId: error.membershipId,
      wegId: error.wegId,
    }),
  ),
  on(PlanExistsError, (error) =>
    answer(409, 'CONFLICT', 'A plan of the membership starts on the same day.', { reason: 'PLAN_EXISTS', economicPlanId: error.economicPlanId }),
  ),
  on(PlanOutsideMembershipError, (error) =>
    answer(422, 'PLAN_OUTSIDE_MEMBERSHIP', 'The plan starts outside the membership.', { validFrom: error.validFrom, validUntil: error.validUntil }),
  ),
  on(PeriodOutsideYearError, (error) => validation([{ field: error.field, code: 'OUT_OF_RANGE' }])),
  on(SettlementDirectionMismatchError, (error) =>
    answer(422, 'SETTLEMENT_DIRECTION_MISMATCH', 'A back-payment is an OUTFLOW, a refund an INFLOW.', { expected: error.expected }),
  ),
  on(SettlementNotProposableError, (error) =>
    answer(409, 'CONFLICT', 'Only an unconfirmed Transaction gets a settlement proposal.', { reason: 'NOT_PROPOSABLE', status: error.status }),
  ),
  on(SpecialAssessmentNotFoundError, (error) => answer(404, 'NOT_FOUND', 'Special assessment not found.', { assessmentId: error.assessmentId })),
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
];
