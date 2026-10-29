/**
 * WEG domain (phase-6-plan.md, api-design.md §49): the Wohnungseigentümergemeinschaft and a unit's membership in it.
 * See docs/development/coding-guidelines.md §3.
 */
export { formatMea, meaFromColumns, parseMea } from './mea.js';
export type { Mea, MeaError } from './mea.js';
export {
  MEMBERSHIP_STATUSES,
  WEG_AMENDABLE_FIELDS,
  WEG_STATUSES,
  membershipFingerprint,
  membershipOn,
  overlappingMembership,
  planMembershipAmend,
  planMembershipEnd,
  planMembershipVoid,
  planWegAmend,
  planWegVoid,
  wegFingerprint,
} from './weg.js';
export type {
  AdministratorRefusal,
  AmendMembershipOutcome,
  AmendWegOutcome,
  CreateMembershipOutcome,
  CreateWegOutcome,
  EndMembershipOutcome,
  InvalidMembershipReason,
  MembershipAmendable,
  MembershipAmendPlan,
  MembershipChanges,
  MembershipEndPlan,
  MembershipFilter,
  MembershipStatus,
  MembershipVoidPlan,
  NewMembership,
  NewWeg,
  Page,
  PageRequest,
  VoidMembershipOutcome,
  VoidWegOutcome,
  Weg,
  WegAmendable,
  WegAmendableField,
  WegAmendPlan,
  WegChanges,
  WegFilter,
  WegId,
  WegMembership,
  WegMembershipId,
  WegRepository,
  WegStatus,
  WegVoidPlan,
} from './weg.js';
