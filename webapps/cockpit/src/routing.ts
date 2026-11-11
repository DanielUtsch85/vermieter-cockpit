/**
 * The cockpit's URLs. The chosen Realm is part of the path (mre-integration.md §47.2 point 3: in the interface's URL,
 * not in `localStorage`), so a link is reproducible and a Realm change is a page load of another URL (ui-guide.md §11:
 * in version 1 a full reload clears the previous Realm's data). No token, IBAN or free text ever goes into a URL (§3.2).
 *
 *   /cockpit/                      Realm choice
 *   /cockpit/r/<realmId>/          Übersicht
 *   /cockpit/r/<realmId>/<area>    one of the version-1 areas (ui-guide.md §3.1)
 *   /cockpit/r/<realmId>/buchungen/<transactionId>   one Transaction (step 2; a stable DE id, ui-guide.md §3.2)
 *   /cockpit/r/<realmId>/import/<importBatchId>      one import's result and review items (step 5)
 *   /cockpit/r/<realmId>/mietabgleich/<reconciliationId>                   one rent reconciliation (step 6)
 *   /cockpit/r/<realmId>/mietabgleich/termin/<mreTenantId>/<mreRentTerm>   the coverage of one MRE rent term (step 6)
 *
 * The list's filters and page are the search part of the area's URL (transactions/list-params.ts).
 * „Alle Zeilen“ of an import's row table is `?zeilen=alle` of the import's URL (imports/row-view.ts).
 */
export const BASE_PATH = '/cockpit/';

export type AreaId = 'uebersicht' | 'buchungen' | 'import' | 'mietabgleich';

export interface Area {
  readonly id: AreaId;
  readonly label: string;
  /** The path segment after the Realm; empty for the overview. */
  readonly segment: string;
  /** Where the area, or the rest of it, is built (ui-guide.md §10, "Erster nutzbarer Durchstich"); undefined when done. */
  readonly slice?: string;
  /** What of the area can be used already; undefined while the area is a placeholder. */
  readonly available?: string;
}

/** Version 1: exactly the P0 areas and the overview as working navigation (ui-guide.md §3.1, decision of 30.10.2026). */
export const AREAS: readonly Area[] = [
  { id: 'uebersicht', label: 'Übersicht', segment: '', slice: 'Integrations-Gate' },
  {
    id: 'buchungen',
    label: 'Buchungen',
    segment: 'buchungen',
    slice: 'Durchstich Schritte 3 und 4',
    available: 'Liste mit Filtern und Detail',
  },
  { id: 'import', label: 'Import', segment: 'import', available: 'Datei und Konto wählen, Import ausführen, Ergebnis und Klärfälle' },
  {
    id: 'mietabgleich',
    label: 'Mietabgleich',
    segment: 'mietabgleich',
    available: 'Vorschläge ermitteln und prüfen, Zuordnung bestätigen, an MRE übertragen, aufheben und aus MRE entfernen, Abdeckung je Termin',
  },
];

/** MRE Realm ids are MongoDB ObjectIds; any other id is accepted as long as it is a plain path segment. */
const REALM_ID = /^[A-Za-z0-9_-]{1,64}$/;
/** A DE resource id (validation.ts `RESOURCE_ID`): a malformed one is not found, never sent. */
const RESOURCE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** An MRE Tenant id (api-design.md §20.1: 24 hex digits) and MRE's rent term key `YYYYMMDDHH` (§37.1: its form only). */
const MRE_TENANT_ID = /^[0-9a-f]{24}$/;
const MRE_RENT_TERM = /^[0-9]{10}$/;

/** One MRE rent term of a Tenant: the key of the coverage read (api-design.md §37.2). */
export interface RentTermKey {
  readonly mreTenantId: string;
  readonly mreRentTerm: string;
}

export type Route =
  | { readonly kind: 'realmChoice' }
  | {
      readonly kind: 'area';
      readonly realmId: string;
      readonly area: Area;
      readonly transactionId?: string;
      readonly importBatchId?: string;
      readonly reconciliationId?: string;
      readonly rentTerm?: RentTermKey;
    }
  | { readonly kind: 'notFound' };

export function parseRoute(pathname: string): Route {
  if (pathname === BASE_PATH.slice(0, -1) || pathname === BASE_PATH) return { kind: 'realmChoice' };
  if (!pathname.startsWith(BASE_PATH)) return { kind: 'notFound' };
  const segments = pathname.slice(BASE_PATH.length).split('/');
  if (segments.at(-1) === '') segments.pop();
  const [r, realmId, segment = '', ...rest] = segments;
  if (r !== 'r' || realmId === undefined || !REALM_ID.test(realmId)) return { kind: 'notFound' };
  const area = AREAS.find((candidate) => candidate.segment === segment);
  if (area === undefined) return { kind: 'notFound' };
  if (rest.length === 0) return { kind: 'area', realmId, area };
  if (area.id === 'mietabgleich' && rest[0] === 'termin') {
    const [, mreTenantId, mreRentTerm, ...extra] = rest;
    if (extra.length > 0 || mreTenantId === undefined || mreRentTerm === undefined) return { kind: 'notFound' };
    if (!MRE_TENANT_ID.test(mreTenantId) || !MRE_RENT_TERM.test(mreRentTerm)) return { kind: 'notFound' };
    return { kind: 'area', realmId, area, rentTerm: { mreTenantId, mreRentTerm } };
  }
  const [id, ...more] = rest;
  if (more.length > 0 || id === undefined || !RESOURCE_ID.test(id)) return { kind: 'notFound' };
  if (area.id === 'buchungen') return { kind: 'area', realmId, area, transactionId: id.toLowerCase() };
  if (area.id === 'import') return { kind: 'area', realmId, area, importBatchId: id.toLowerCase() };
  if (area.id === 'mietabgleich') return { kind: 'area', realmId, area, reconciliationId: id.toLowerCase() };
  return { kind: 'notFound' };
}

export function areaPath(realmId: string, area: Area, search = ''): string {
  return `${BASE_PATH}r/${encodeURIComponent(realmId)}/${area.segment}${search}`;
}

export function transactionPath(realmId: string, transactionId: string): string {
  return `${BASE_PATH}r/${encodeURIComponent(realmId)}/buchungen/${encodeURIComponent(transactionId)}`;
}

/** One import of the Realm: its result and the review items it owns (step 5). */
export function importBatchPath(realmId: string, importBatchId: string): string {
  return `${BASE_PATH}r/${encodeURIComponent(realmId)}/import/${encodeURIComponent(importBatchId)}`;
}

/** One rent reconciliation of the Realm: its states and its actions (step 6). */
export function reconciliationPath(realmId: string, reconciliationId: string): string {
  return `${BASE_PATH}r/${encodeURIComponent(realmId)}/mietabgleich/${encodeURIComponent(reconciliationId)}`;
}

/** The coverage of one MRE rent term (step 6, api-design.md §37.2). */
export function rentTermPath(realmId: string, term: RentTermKey): string {
  return `${BASE_PATH}r/${encodeURIComponent(realmId)}/mietabgleich/termin/${encodeURIComponent(term.mreTenantId)}/${encodeURIComponent(term.mreRentTerm)}`;
}

/**
 * The Realm a document shows. A Realm change is a page load (ui-guide.md §11, version 1: a full reload clears the
 * previous Realm's data, its selections and its running requests); the links of the cockpit do that. The lock holds the
 * rule for every other way into another Realm within the same document as well (back and forward through the
 * history, a link added later): the first Realm a document shows is its Realm, and any other one asks for a reload.
 */
export type RealmLock = (realmId: string) => 'show' | 'reload';

export function createRealmLock(): RealmLock {
  let documentRealm: string | undefined;
  return (realmId) => {
    documentRealm ??= realmId;
    return realmId === documentRealm ? 'show' : 'reload';
  };
}

/** Whether a route shows another Realm than the document's (the lock is asked once per render of a Realm route). */
export function realmSwitching(route: Route | undefined, lock: RealmLock): boolean {
  return route?.kind === 'area' && lock(route.realmId) === 'reload';
}

/**
 * The effect of the lock: a switching route reloads the page, any other does nothing. A function of its own, so the
 * reload is tested without a browser (review of #322, hint 1); `App` runs it as its effect.
 */
export function realmSwitchEffect(switching: boolean, reload: () => void): () => void {
  return () => {
    if (switching) reload();
  };
}

/** Loads the current URL afresh: the new Realm starts with an empty memory. */
export function reloadPage(): void {
  window.location.reload();
}

/** Leaves the Realm: a page load of the choice, so the previous Realm's data and requests are gone (ui-guide.md §11). */
export function leaveRealm(): void {
  window.location.assign(BASE_PATH);
}

/** Signs out in MRE and loads the start page, so nothing of the session stays in memory. */
export function signOutAndReload(session: { signOut(): Promise<void> }): void {
  void session.signOut().finally(leaveRealm);
}
