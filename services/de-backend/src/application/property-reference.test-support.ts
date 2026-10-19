import {
  planRefresh,
  type LinkOutcome,
  type NewPropertyReference,
  type PropertyReference,
  type PropertyReferenceId,
  type PropertyReferenceRepository,
} from '../domains/property-reference/index.js';
import type { AuditActor } from '../shared/index.js';
import type { MrePropertyLookup } from './link-property-reference.js';

/** In-memory PropertyReferenceRepository recording audited actions. Test support only. */
export function memoryRepository(): PropertyReferenceRepository & {
  rows: PropertyReference[];
  audits: { action: string; actor: AuditActor }[];
} {
  const rows: PropertyReference[] = [];
  const audits: { action: string; actor: AuditActor }[] = [];
  const find = (realm: string, property: string) =>
    rows.find((r) => r.mreRealmId === realm && r.mrePropertyId === property);
  return {
    rows,
    audits,
    findByMreIdentity: async (realm, property) => find(realm, property),
    findById: async (id, realm) => rows.find((r) => r.id === id && r.mreRealmId === realm),
    linkOnce: async (draft: NewPropertyReference, actor: AuditActor): Promise<LinkOutcome> => {
      const existing = find(draft.mreRealmId, draft.mrePropertyId);
      if (existing !== undefined) return { reference: existing, created: false };
      const reference: PropertyReference = {
        id: `ref-${rows.length + 1}` as PropertyReferenceId,
        mreRealmId: draft.mreRealmId,
        mrePropertyId: draft.mrePropertyId,
        externalReferenceState: 'ACTIVE',
        displayName: draft.displayName,
        cachedAddress: draft.cachedAddress,
        cachedSurface: draft.cachedSurface,
        lastRefreshedAt: draft.refreshedAt,
        lastObservedAt: draft.refreshedAt,
        createdAt: draft.refreshedAt,
        version: 1,
      };
      rows.push(reference);
      audits.push({ action: 'LINKED', actor });
      return { reference, created: true };
    },
    refresh: async (id, realm, observation, actor) => {
      const index = rows.findIndex((r) => r.id === id && r.mreRealmId === realm);
      const current = rows[index];
      if (current === undefined) return undefined;
      const { next, stale, change } = planRefresh(current, observation);
      if (stale) return current;
      rows[index] = next;
      if (change !== undefined) audits.push({ action: change.action, actor });
      return next;
    },
  };
}

/** A lookup answering `result` (or throwing it) and recording its calls. Test support only. */
export function lookupOf(
  result: Awaited<ReturnType<MrePropertyLookup>> | Error,
): MrePropertyLookup & { calls: string[][] } {
  const calls: string[][] = [];
  const lookup = async (auth: string, realm: string, property: string) => {
    calls.push([auth, realm, property]);
    if (result instanceof Error) throw result;
    return result;
  };
  return Object.assign(lookup, { calls });
}
