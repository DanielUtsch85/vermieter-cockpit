/**
 * Audit domain: the retention and pseudonymisation of personal values in AuditRecords (VC-X-24, api-design.md §58U).
 * See docs/development/coding-guidelines.md §3.
 */
export {
  AUDIT_MARKER,
  AUDIT_MARKER_PATTERN,
  AUDIT_PERSONAL_FIELDS,
  AUDIT_PSEUDONYMISABLE_ACTION,
  AUDIT_PSEUDONYMISABLE_ENTITY_TYPES,
  AUDIT_PSEUDONYMISED_ACTION,
  AUDIT_RETENTION_YEARS,
  auditDueFrom,
  auditRetentionCutoff,
  auditRetentionEndsOn,
  berlinStartOfYear,
  berlinYear,
  isAuditRecordDue,
  pseudonymiseAuditMetadata,
} from './personal-fields.js';
export type { PseudonymisedMetadata } from './personal-fields.js';
