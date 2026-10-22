import { describe, expect, it } from 'vitest';
import { createFingerprint, fieldsNotAllowed, planAmend, planDeactivate, type NewParty, type Party, type PartyId } from './party.js';

/** VC-2-01 domain rules (api-design.md §19.1, phase-2-plan P2-D1). */
const person: Party = {
  id: 'p1' as PartyId,
  mreRealmId: 'r',
  partyType: 'PERSON',
  displayName: 'Anna Schmidt',
  firstName: 'Anna',
  lastName: 'Schmidt',
  legalName: null,
  registrationNumber: null,
  email: 'anna@example.com',
  phone: null,
  status: 'ACTIVE',
  deactivatedAt: null,
  deactivationReason: null,
  createdAt: new Date('2026-10-22T08:00:00Z'),
  version: 1,
};

describe('Party', () => {
  it('fields of the other type are not allowed; null or absent ones are', () => {
    expect(fieldsNotAllowed('PERSON', { legalName: 'X GmbH', registrationNumber: null, firstName: 'A' })).toEqual(['legalName']);
    expect(fieldsNotAllowed('ORGANIZATION', { firstName: 'A', lastName: 'B' })).toEqual(['firstName', 'lastName']);
    expect(fieldsNotAllowed('ORGANIZATION', { legalName: 'X GmbH' })).toEqual([]);
  });

  it('amend: only differing fields change; the same values are UNCHANGED; status and type never change', () => {
    expect(planAmend(person, { email: 'anna@example.com', firstName: 'Anna' })).toEqual({ kind: 'UNCHANGED' });
    const plan = planAmend(person, { email: null, phone: '0171', firstName: 'Anna' });
    expect(plan).toMatchObject({ kind: 'AMEND', changed: ['email', 'phone'], values: { email: null, phone: '0171', firstName: 'Anna' } });
    expect(planAmend(person, { registrationNumber: 'HRB 1' })).toEqual({ kind: 'NOT_ALLOWED_FOR_TYPE', partyType: 'PERSON', fields: ['registrationNumber'] });
    // An INACTIVE Party stays correctable (P2-D1: no new role, but data may be fixed).
    expect(planAmend({ ...person, status: 'INACTIVE' }, { lastName: 'Schmid' })).toMatchObject({ kind: 'AMEND', changed: ['lastName'] });
  });

  it('deactivate once; a repeat is UNCHANGED, keeping the first reason', () => {
    const at = new Date('2026-10-22T09:00:00Z');
    expect(planDeactivate(person, 'verstorben', at)).toEqual({
      kind: 'DEACTIVATE',
      next: { ...person, status: 'INACTIVE', deactivatedAt: at, deactivationReason: 'verstorben', version: 2 },
    });
    expect(planDeactivate({ ...person, status: 'INACTIVE', deactivationReason: 'verstorben' }, 'anders', at)).toEqual({ kind: 'UNCHANGED' });
  });

  it('the create fingerprint is the normalized payload, type included', () => {
    const party: NewParty = { ...person, mreRealmId: 'r' };
    expect(createFingerprint(party)).toBe(createFingerprint({ ...party }));
    expect(createFingerprint(party)).not.toBe(createFingerprint({ ...party, phone: '0171' }));
    expect(createFingerprint(party)).not.toBe(createFingerprint({ ...party, partyType: 'ORGANIZATION', firstName: null, lastName: null }));
  });
});
