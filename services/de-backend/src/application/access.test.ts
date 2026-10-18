import { describe, expect, it } from 'vitest';
import { AccessError, assertDeAccess } from './access.js';

const principal = (mreRole: string) => ({ email: 'a@example.com', mreRealmId: 'r', mreRole });

describe('DE access policy', () => {
  it('administrator has full DE access', () => {
    expect(() => assertDeAccess(principal('administrator'))).not.toThrow();
  });

  it.each(['renter', 'tenant', 'owner', ''])('role %j has no DE access', (role) => {
    expect(() => assertDeAccess(principal(role))).toThrow(AccessError);
    expect(() => assertDeAccess(principal(role))).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }));
  });
});
