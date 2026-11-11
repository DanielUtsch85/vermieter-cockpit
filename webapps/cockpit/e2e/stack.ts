/**
 * Synthetic data for the browser run (VC-X-70), written the way compose-smoke seeds (`.github/scripts/compose-auth-smoke.sh`):
 * straight to the loopback ports of docker-compose.yml, MRE's gateway (127.0.0.1:8080) and the DE backend
 * (127.0.0.1:8090). The browser itself only ever talks to Caddy. Accounts are `e2e-*-<run>@example.com`, every name and
 * amount is made up; nothing here is real personal data.
 */

const MRE = process.env['E2E_MRE_URL'] ?? 'http://127.0.0.1:8080/api/v2';
const DE = process.env['E2E_DE_URL'] ?? 'http://127.0.0.1:8090/api/v1';

/** The account and IBAN of the walk's bank account (the standard German example IBAN, no real account). */
export const ACCOUNT_IBAN = 'DE89370400440532013000';
export const ACCOUNT_NAME = 'E2E Girokonto';
export const PROPERTY_NAME = 'E2E Testwohnung';
/** The October 2026 term of the synthetic Tenant (MRE's key `YYYYMMDDHH`). */
export const TERM_OCT = '2026100100';

const HEADER =
  'Bezeichnung Auftragskonto;IBAN Auftragskonto;Buchungstag;Valutadatum;Name Zahlungsbeteiligter;IBAN Zahlungsbeteiligter;Verwendungszweck;Betrag;Waehrung;Saldo nach Buchung';
const row = (date: string, who: string, iban: string, purpose: string, amount: string, balance: string) =>
  `E2E Giro;${ACCOUNT_IBAN};${date};${date};${who};${iban};${purpose};${amount};EUR;${balance}`;
const utility = (balance: string) => row('05.10.2026', 'Muster Versorgung GmbH', 'DE02120300000000202051', 'Abschlag Testzaehler', '-120,50', balance);
const insurance = (balance: string) =>
  row('15.10.2026', 'Test Versicherung AG', 'DE12500105170648489890', 'Gutschrift Testversicherung Nachtrag', '400,00', balance);
const RENT = row('01.10.2026', 'Erika Beispiel', 'DE75512108001245126199', 'Miete Oktober Testwohnung', '850,00', '1.850,00');

/** Imported by the seed: two rows of an earlier statement. */
export const EARLIER_CSV = [HEADER, utility('879,50'), insurance('1.279,50')].join('\n');
/**
 * Imported in the browser (VR-Banking layout): the rent, then the two earlier rows in another order with the balances
 * of this file. The backend books the new row and makes each earlier row a review item (the same booking, but not the
 * same statement line), as the reordered file in compose-auth-smoke.sh; identical rows would be plain duplicates.
 */
export const WALK_CSV = [HEADER, RENT, insurance('2.250,00'), utility('2.129,50')].join('\n');
export const WALK_CSV_NAME = 'e2e-umsaetze-oktober.csv';

export interface Realm {
  readonly id: string;
  readonly name: string;
}

export interface Seed {
  readonly run: string;
  readonly password: string;
  /** Administrator of A and W, renter in B. */
  readonly admin: string;
  /** Renter in A only: MRE lets it sign in, DE refuses it (403). */
  readonly renter: string;
  readonly realmA: Realm;
  readonly realmB: Realm;
  /** The Realm of the walk (steps 1–8), with its MRE Property and Tenant and the DE account and Property link. */
  readonly realmW: Realm;
  readonly tenantId: string;
}

async function call(base: string, method: string, path: string, init: { token?: string; realm?: string; json?: unknown; form?: FormData } = {}) {
  const headers: Record<string, string> = {};
  if (init.token !== undefined) headers['authorization'] = `Bearer ${init.token}`;
  if (init.realm !== undefined) headers['organizationid'] = init.realm;
  if (init.json !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(`${base}${path}`, {
    method,
    headers,
    body: init.form ?? (init.json === undefined ? null : JSON.stringify(init.json)),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`seed: ${method} ${path} answered ${response.status}: ${text.slice(0, 300)}`);
  // Sign-up answers `201 Created` as plain text; everything read here is JSON.
  return response.headers.get('content-type')?.includes('application/json') === true ? (JSON.parse(text) as Record<string, unknown>) : undefined;
}

const idOf = (body: Record<string, unknown> | undefined, key: string): string => {
  const value = body?.[key];
  if (typeof value !== 'string' || value === '') throw new Error(`seed: no ${key} in the answer`);
  return value;
};

/** Accounts, Realms and the walk's data; sign-up must be open (MRE_SIGNUP=true, as in the cockpit gate). */
export async function seedStack(): Promise<Seed> {
  const run = `${Date.now()}`;
  const password = `E2e-${run}-password`;
  const email = (who: string) => `e2e-${who}-${run}@example.com`;
  const [admin, renter, other] = [email('admin'), email('renter'), email('other')];
  for (const [address, last] of [
    [admin, 'Admin'],
    [renter, 'Renter'],
    [other, 'Other'],
  ] as const) {
    await call(MRE, 'POST', '/authenticator/landlord/signup', { json: { firstname: 'E2E', lastname: last, email: address, password } });
  }
  // MRE's access tokens live 30 s: sign in again right before each use.
  const token = async (address: string) =>
    idOf(await call(MRE, 'POST', '/authenticator/landlord/signin', { json: { email: address, password } }), 'accessToken');
  const member = (name: string, address: string, role: 'administrator' | 'renter') => ({ name, email: address, role, registered: true });
  const realm = async (owner: string, name: string, members: unknown[]): Promise<Realm> => {
    const body = await call(MRE, 'POST', '/realms', { token: await token(owner), json: { name, currency: 'EUR', locale: 'de-DE', members } });
    return { id: idOf(body, '_id'), name };
  };
  const realmA = await realm(admin, `E2E Bestand A ${run}`, [member('Admin', admin, 'administrator'), member('Renter', renter, 'renter')]);
  const realmB = await realm(other, `E2E Bestand B ${run}`, [member('Other', other, 'administrator'), member('Admin als Mieter', admin, 'renter')]);
  const realmW = await realm(admin, `E2E Durchstich ${run}`, [member('Admin', admin, 'administrator')]);

  const inW = async (base: string, method: string, path: string, init: { json?: unknown; form?: FormData } = {}) =>
    call(base, method, path, { ...init, token: await token(admin), realm: realmW.id });
  const property = idOf(await inW(MRE, 'POST', '/properties', { json: { type: 'apartment', name: PROPERTY_NAME, surface: 60, price: 700 } }), '_id');
  // A lease from October 2026: MRE generates its monthly terms, each due 700,00 rent plus 150,00 charges.
  const tenant = await inW(MRE, 'POST', '/tenants', {
    json: {
      name: 'E2E Mieterin',
      beginDate: '01/10/2026',
      endDate: '30/09/2027',
      properties: [{ propertyId: property, rent: 700, expenses: [{ title: 'Nebenkosten', amount: 150, beginDate: '01/10/2026', endDate: '30/09/2027' }] }],
    },
  });
  await inW(DE, 'POST', '/property-references/link', { json: { mreRealmId: realmW.id, mrePropertyId: property } });
  const account = idOf(
    await inW(DE, 'POST', '/financial-accounts', { json: { accountType: 'BANK', displayName: ACCOUNT_NAME, currency: 'EUR', iban: ACCOUNT_IBAN } }),
    'financialAccountId',
  );
  const form = new FormData();
  form.set('metadata', JSON.stringify({ financialAccountId: account, adapterId: 'generic-csv', adapterVersion: '2', preset: 'vr-banking' }));
  form.set('file', new Blob([EARLIER_CSV], { type: 'text/csv' }), 'e2e-umsaetze-frueher.csv');
  await inW(DE, 'POST', '/imports/bank-transactions', { form });

  return { run, password, admin, renter, realmA, realmB, realmW, tenantId: idOf(tenant, '_id') };
}

/** The seed of this run, handed from the global setup to the workers through the environment. */
export function seed(): Seed {
  const raw = process.env['E2E_SEED'];
  if (raw === undefined) throw new Error('E2E_SEED is not set: the global setup (global-setup.ts) did not run');
  return JSON.parse(raw) as Seed;
}

/** The payments of one MRE rent term as MRE stores them (read back after the write-back, never shown in the cockpit). */
export async function mrePayments(s: Seed, term: string): Promise<{ amount: unknown; reference: unknown }[]> {
  const token = idOf(await call(MRE, 'POST', '/authenticator/landlord/signin', { json: { email: s.admin, password: s.password } }), 'accessToken');
  const body = await call(MRE, 'GET', `/rents/tenant/${s.tenantId}/${term}`, { token, realm: s.realmW.id });
  const payments = body?.['payments'];
  return Array.isArray(payments) ? payments.map((p: { amount?: unknown; reference?: unknown }) => ({ amount: p.amount, reference: p.reference })) : [];
}
