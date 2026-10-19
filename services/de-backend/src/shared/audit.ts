/**
 * Who caused an audited change (data-model.md §57 AuditRecord). The record
 * itself is written by the persistence adapter in the same transaction as the
 * change it describes, so a change never exists without its audit trail.
 */
export interface AuditActor {
  readonly actorType: 'USER' | 'SYSTEM';
  /** For USER: the MRE account email the caller was verified as. */
  readonly actorId: string;
}
