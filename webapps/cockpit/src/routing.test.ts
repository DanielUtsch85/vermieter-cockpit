import { describe, expect, it } from 'vitest';
import {
  AREAS,
  areaPath,
  createRealmLock,
  importBatchPath,
  parseRoute,
  realmSwitchEffect,
  realmSwitching,
  reconciliationPath,
  rentTermPath,
  transactionPath,
} from './routing';

const REALM = '64b7f0c2a1b2c3d4e5f60718';
const OTHER = '64b7f0c2a1b2c3d4e5f60719';
const TX = '2d0b4e3a-5f6c-4d7e-8f90-91a2b3c4d5e6';

describe('routes: the Realm in the URL (§47.2 point 3)', () => {
  it('the base path is the Realm choice', () => {
    expect(parseRoute('/cockpit')).toEqual({ kind: 'realmChoice' });
    expect(parseRoute('/cockpit/')).toEqual({ kind: 'realmChoice' });
  });

  it('every version-1 area round-trips through its path, with or without a trailing slash', () => {
    for (const area of AREAS) {
      const path = areaPath(REALM, area);
      expect(parseRoute(path)).toEqual({ kind: 'area', realmId: REALM, area });
      expect(parseRoute(path.endsWith('/') ? path.slice(0, -1) : `${path}/`)).toEqual({ kind: 'area', realmId: REALM, area });
    }
  });

  it('version 1 has exactly the overview and the three P0 areas (ui-guide.md §3.1)', () => {
    expect(AREAS.map((area) => area.label)).toEqual(['Übersicht', 'Buchungen', 'Import', 'Mietabgleich']);
  });

  it('anything else is not found, never another Realm', () => {
    for (const path of [
      '/',
      '/cockpit/r',
      '/cockpit/r/',
      `/cockpit/x/${REALM}/`,
      `/cockpit/r/${REALM}/finanzierung`,
      `/cockpit/r/${REALM}/buchungen/x`,
      `/cockpit/r/${REALM}/buchungen/${TX}/splits`,
      `/cockpit/r/${REALM}/import/${TX}/review-items`,
      `/cockpit/r/${REALM}/import/x`,
      `/cockpit/r/${REALM}/mietabgleich/x`,
      `/cockpit/r/${REALM}/mietabgleich/${TX}/confirm`,
      `/cockpit/r/${REALM}/mietabgleich/termin/64b7f0c2a1b2c3d4e5f6071`,
      `/cockpit/r/${REALM}/mietabgleich/termin/64B7F0C2A1B2C3D4E5F60720/2026030100`,
      `/cockpit/r/${REALM}/mietabgleich/termin/64b7f0c2a1b2c3d4e5f60720/202603010`,
      `/cockpit/r/${REALM}/mietabgleich/termin/64b7f0c2a1b2c3d4e5f60720/2026030100/x`,
      `/cockpit/r/${REALM}/buchungen/termin/64b7f0c2a1b2c3d4e5f60720/2026030100`,
      `/cockpit/r/${REALM}/${TX}`,
      `/cockpit/r/${REALM}//${TX}`,
      `/cockpit/r/${REALM}/buchungen/${TX}x`,
      '/cockpit/r/a%2Fb/',
      '/cockpit/r/../',
    ]) {
      expect(parseRoute(path)).toEqual({ kind: 'notFound' });
    }
  });
});

describe('step 2: a Transaction has its own URL (ui-guide.md §3.2: deep links with stable DE ids)', () => {
  it('the detail path round-trips; the id is read in lower case, as the backend stores it', () => {
    const transactions = AREAS[1];
    expect(parseRoute(transactionPath(REALM, TX))).toEqual({ kind: 'area', realmId: REALM, area: transactions, transactionId: TX });
    expect(parseRoute(`${transactionPath(REALM, TX.toUpperCase())}/`)).toEqual({ kind: 'area', realmId: REALM, area: transactions, transactionId: TX });
    expect(transactionPath(REALM, TX)).toBe(`/cockpit/r/${REALM}/buchungen/${TX}`);
  });

  it('the list keeps its search part in its path', () => {
    const transactions = AREAS[1];
    if (transactions === undefined) throw new Error('area missing');
    expect(areaPath(REALM, transactions, '?status=IMPORTED')).toBe(`/cockpit/r/${REALM}/buchungen?status=IMPORTED`);
  });
});

describe('step 5: an import has its own URL (a known batch is read again after a reload, ui-guide.md §6.5)', () => {
  it('the batch path round-trips in the Import area; the id is read in lower case', () => {
    const imports = AREAS[2];
    expect(imports?.id).toBe('import');
    expect(parseRoute(importBatchPath(REALM, TX))).toEqual({ kind: 'area', realmId: REALM, area: imports, importBatchId: TX });
    expect(parseRoute(`${importBatchPath(REALM, TX.toUpperCase())}/`)).toEqual({ kind: 'area', realmId: REALM, area: imports, importBatchId: TX });
    expect(importBatchPath(REALM, TX)).toBe(`/cockpit/r/${REALM}/import/${TX}`);
  });

  it('counter-check: a Transaction id under Buchungen is no import, and an import id is no Transaction', () => {
    expect(parseRoute(transactionPath(REALM, TX))).not.toHaveProperty('importBatchId');
    expect(parseRoute(importBatchPath(REALM, TX))).not.toHaveProperty('transactionId');
  });
});

describe('step 6: a rent reconciliation and an MRE rent term have their own URL (ui-guide.md §3.2, §6.6)', () => {
  const TENANT = '64b7f0c2a1b2c3d4e5f60720';
  it('the reconciliation path round-trips in the Mietabgleich area; the id is read in lower case', () => {
    const rent = AREAS[3];
    expect(rent?.id).toBe('mietabgleich');
    expect(parseRoute(reconciliationPath(REALM, TX))).toEqual({ kind: 'area', realmId: REALM, area: rent, reconciliationId: TX });
    expect(parseRoute(`${reconciliationPath(REALM, TX.toUpperCase())}/`)).toEqual({ kind: 'area', realmId: REALM, area: rent, reconciliationId: TX });
    expect(reconciliationPath(REALM, TX)).toBe(`/cockpit/r/${REALM}/mietabgleich/${TX}`);
  });

  it('the term path holds the MRE Tenant id and the term key, exactly as MRE names them', () => {
    const rent = AREAS[3];
    const term = { mreTenantId: TENANT, mreRentTerm: '2026030100' };
    expect(rentTermPath(REALM, term)).toBe(`/cockpit/r/${REALM}/mietabgleich/termin/${TENANT}/2026030100`);
    expect(parseRoute(rentTermPath(REALM, term))).toEqual({ kind: 'area', realmId: REALM, area: rent, rentTerm: term });
  });

  it('counter-check: a reconciliation id is no Transaction or import, and a term is no reconciliation', () => {
    expect(parseRoute(reconciliationPath(REALM, TX))).not.toHaveProperty('transactionId');
    expect(parseRoute(reconciliationPath(REALM, TX))).not.toHaveProperty('importBatchId');
    expect(parseRoute(rentTermPath(REALM, { mreTenantId: TENANT, mreRentTerm: '2026030100' }))).not.toHaveProperty('reconciliationId');
    expect(parseRoute(`/cockpit/r/${REALM}/import/termin/${TENANT}/2026030100`)).toEqual({ kind: 'notFound' });
  });
});

describe('the Realm lock reloads the page (review of #322, hint 1)', () => {
  it('a route of another Realm than the document is switching; its effect reloads exactly once', () => {
    const lock = createRealmLock();
    const route = (realmId: string) => parseRoute(`/cockpit/r/${realmId}/`);
    expect(realmSwitching(route(REALM), lock)).toBe(false);
    expect(realmSwitching(route(OTHER), lock)).toBe(true);
    let reloads = 0;
    realmSwitchEffect(realmSwitching(route(OTHER), lock), () => (reloads += 1))();
    expect(reloads).toBe(1);
  });

  it('counter-check: the document Realm, the choice and a page not found never reload', () => {
    const lock = createRealmLock();
    let reloads = 0;
    for (const path of [`/cockpit/r/${REALM}/`, '/cockpit/', `/cockpit/r/${OTHER}/finanzierung`, `/cockpit/r/${REALM}/buchungen/${TX}`]) {
      realmSwitchEffect(realmSwitching(parseRoute(path), lock), () => (reloads += 1))();
    }
    realmSwitchEffect(realmSwitching(undefined, lock), () => (reloads += 1))();
    expect(reloads).toBe(0);
  });
});
