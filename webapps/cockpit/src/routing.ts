/**
 * The cockpit's URLs. The chosen Realm is part of the path (mre-integration.md §47.2 point 3: in the interface's URL,
 * not in `localStorage`), so a link is reproducible and a Realm change is a page load of another URL (ui-guide.md §11:
 * in version 1 a full reload clears the previous Realm's data). No token, IBAN or free text ever goes into a URL (§3.2).
 *
 *   /cockpit/                      Realm choice
 *   /cockpit/r/<realmId>/          Übersicht
 *   /cockpit/r/<realmId>/<area>    one of the version-1 areas (ui-guide.md §3.1)
 */
export const BASE_PATH = '/cockpit/';

export type AreaId = 'uebersicht' | 'buchungen' | 'import' | 'mietabgleich';

export interface Area {
  readonly id: AreaId;
  readonly label: string;
  /** The path segment after the Realm; empty for the overview. */
  readonly segment: string;
  /** Where the area is built (ui-guide.md §10, "Erster nutzbarer Durchstich"). */
  readonly slice: string;
}

/** Version 1: exactly the P0 areas and the overview as working navigation (ui-guide.md §3.1, decision of 30.10.2026). */
export const AREAS: readonly Area[] = [
  { id: 'uebersicht', label: 'Übersicht', segment: '', slice: 'Integrations-Gate' },
  { id: 'buchungen', label: 'Buchungen', segment: 'buchungen', slice: 'Durchstich Schritte 2 bis 4' },
  { id: 'import', label: 'Import', segment: 'import', slice: 'Durchstich Schritt 5' },
  { id: 'mietabgleich', label: 'Mietabgleich', segment: 'mietabgleich', slice: 'Durchstich Schritt 6' },
];

/** MRE Realm ids are MongoDB ObjectIds; any other id is accepted as long as it is a plain path segment. */
const REALM_ID = /^[A-Za-z0-9_-]{1,64}$/;

export type Route = { readonly kind: 'realmChoice' } | { readonly kind: 'area'; readonly realmId: string; readonly area: Area } | { readonly kind: 'notFound' };

export function parseRoute(pathname: string): Route {
  if (pathname === BASE_PATH.slice(0, -1) || pathname === BASE_PATH) return { kind: 'realmChoice' };
  if (!pathname.startsWith(BASE_PATH)) return { kind: 'notFound' };
  const segments = pathname.slice(BASE_PATH.length).split('/');
  if (segments.at(-1) === '') segments.pop();
  const [r, realmId, segment = '', ...rest] = segments;
  if (r !== 'r' || realmId === undefined || !REALM_ID.test(realmId) || rest.length > 0) return { kind: 'notFound' };
  const area = AREAS.find((candidate) => candidate.segment === segment);
  return area === undefined ? { kind: 'notFound' } : { kind: 'area', realmId, area };
}

export function areaPath(realmId: string, area: Area): string {
  return `${BASE_PATH}r/${encodeURIComponent(realmId)}/${area.segment}`;
}

/** Leaves the Realm: a page load of the choice, so the previous Realm's data and requests are gone (ui-guide.md §11). */
export function leaveRealm(): void {
  window.location.assign(BASE_PATH);
}

/** Signs out in MRE and loads the start page, so nothing of the session stays in memory. */
export function signOutAndReload(session: { signOut(): Promise<void> }): void {
  void session.signOut().finally(leaveRealm);
}
