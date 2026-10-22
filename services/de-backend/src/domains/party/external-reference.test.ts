import { describe, expect, it } from 'vitest';
import { planClaim, planEnd, type ExternalReferenceId, type PartyExternalReference } from './external-reference.js';
import type { Party, PartyId } from './party.js';

/** VC-2-02 domain rules (api-design.md §20.1, phase-2-plan P2-D2). */
const party = { id: 'p1' as PartyId, status: 'ACTIVE' } as Party;
const reference: PartyExternalReference = {
  id: 'r1' as ExternalReferenceId,
  partyId: party.id,
  system: 'MRE',
  mreRealmId: 'realm',
  entityType: 'tenant',
  externalId: '6512f0c2a1b2c3d4e5f60a01',
  status: 'ACTIVE',
  endedAt: null,
  createdAt: new Date('2026-10-22T08:00:00Z'),
  version: 1,
};

describe('PartyExternalReference', () => {
  it('claim, in the order of §20.1: a repeat succeeds before any refusal; IN_USE before PARTY_INACTIVE', () => {
    const inactive = { ...party, status: 'INACTIVE' } as Party;
    expect(planClaim(party, undefined)).toEqual({ kind: 'CLAIM' });
    expect(planClaim(party, reference)).toEqual({ kind: 'EXISTING', reference });
    // An inactive Party keeps its references: the repeat is still a success.
    expect(planClaim(inactive, reference)).toEqual({ kind: 'EXISTING', reference });
    const other = { ...reference, partyId: 'p2' as PartyId };
    expect(planClaim(party, other)).toEqual({ kind: 'IN_USE', partyId: 'p2' });
    expect(planClaim(inactive, other)).toEqual({ kind: 'IN_USE', partyId: 'p2' });
    expect(planClaim(inactive, undefined)).toEqual({ kind: 'PARTY_INACTIVE' });
  });

  it('end once; a repeat is UNCHANGED, keeping the first endedAt', () => {
    const at = new Date('2026-10-22T09:00:00Z');
    expect(planEnd(reference, at)).toEqual({ kind: 'END', next: { ...reference, status: 'ENDED', endedAt: at, version: 2 } });
    expect(planEnd({ ...reference, status: 'ENDED', endedAt: at }, new Date())).toEqual({ kind: 'UNCHANGED' });
  });
});
