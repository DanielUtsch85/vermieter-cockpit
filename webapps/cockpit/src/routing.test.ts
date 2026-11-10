import { describe, expect, it } from 'vitest';
import { AREAS, areaPath, parseRoute } from './routing';

const REALM = '64b7f0c2a1b2c3d4e5f60718';

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
      '/cockpit/r/a%2Fb/',
      '/cockpit/r/../',
    ]) {
      expect(parseRoute(path)).toEqual({ kind: 'notFound' });
    }
  });
});
