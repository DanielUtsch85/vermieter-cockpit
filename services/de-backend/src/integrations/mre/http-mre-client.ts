import { z } from 'zod';
import { ExactDecimal, Money, RoundingMode, checkBusinessDate } from '../../shared/index.js';
import {
  MreClientError,
  type MreAddress,
  type MreClient,
  type MreClientErrorCode,
  type MreProperty,
  type MreRealmMembership,
  type MreMonthRent,
  type MreRawTerm,
  type MreRentPayment,
  type MreRentTerm,
  type MreTermWrite,
  type MreTermWriteResult,
} from './mre-client.js';

/**
 * MreClient over the MRE landlord API (`/api/v2`, reached through the MRE
 * gateway), verified against the pinned baseline 479d0ad (ADR-036):
 *
 * - `GET /realms` runs MRE's `needAccessToken` → `checkOrganization` →
 *   `notRoles(['tenant'])` chain: 401 for a missing/invalid/expired token,
 *   403 for a tenant session token, otherwise the realms whose `members`
 *   contain the token's account email (secrets already stripped by MRE).
 * - `GET /properties` with `organizationid` returns only that Realm's
 *   properties (mre-integration.md §21.1); 404 when the Realm is not the
 *   caller's. `GET /properties/:id` is not used:
 *   it answers 500 instead of 404 for an unknown or foreign id.
 * - `GET /tenants` with `organizationid` returns every Tenant of that Realm; it
 *   has no filter (mre-integration.md §20.1). `GET /tenants/:id` is not used
 *   either: it also answers 500 for an unknown id.
 * - `GET /rents/tenant/:id/:term` returns one rent term of a Tenant of that Realm;
 *   404 for an unknown Tenant or term (api-design.md §37.1).
 *
 * Only the fields DE needs are read; the MRE DTO never leaves this file.
 */

/**
 * Structure errors (missing `_id`, `members` not an array) reject the whole
 * response. A single member with an unknown shape or role (legacy data, or a role
 * added by a later MRE release) is dropped on its own: a dropped member gets no
 * access, and the caller's other Realms stay usable.
 */
const memberDto = z.object({
  email: z.string().min(1),
  role: z.enum(['administrator', 'renter']),
});
const realmDto = z.object({
  _id: z.string().min(1),
  name: z.string(),
  members: z.array(z.unknown()),
});
const realmsDto = z.array(realmDto);

/**
 * Every property needs an `_id`, otherwise the whole response is rejected: a
 * silently dropped entry would turn an existing Property into "not found".
 * Display fields are optional cache values; a malformed one is left out.
 */
const propertiesDto = z.array(z.object({ _id: z.string().min(1) }).passthrough());
/**
 * Only the `_id` of a Tenant is read; the rest (personal data) is dropped here and never logged
 * (mre-integration.md §20.1). A Tenant without `_id` rejects the whole response, as for properties.
 */
const tenantsDto = z.array(z.object({ _id: z.string().min(1) }));
/** A rent term of `GET /rents/tenant/:id/:term`: only its key, its amount due and its payments are read. */
const rentTermDto = z.object({
  term: z.number().int(),
  totalWithoutBalanceAmount: z.number(),
  payments: z.array(
    z.object({
      date: z.unknown().optional(),
      amount: z.number(),
      type: z.unknown().optional(),
      reference: z.unknown().optional(),
    }),
  ),
});
/** `GET /rents/:year/:month`: of each rent only the Tenant's `_id`, its term and its amount due are read. */
const monthDto = z.object({
  rents: z.array(z.object({ _id: z.string().regex(/^[0-9a-f]{24}$/), term: z.number().int(), totalWithoutBalanceAmount: z.number() })),
});
/**
 * A rent term for the write-back's round trip (api-design.md §37.4): the Tenant's `_id`, `vatRatio` and the settlement
 * with each payment value kept as MRE sent it. MRE's `toRentData` always answers `promo`, `notepromo`, `extracharge`
 * and `noteextracharge`; `description` may be absent. The occupant and the rest are dropped.
 */
const rawTermDto = z.object({
  _id: z.string().regex(/^[0-9a-f]{24}$/),
  term: z.number().int(),
  vatRatio: z.number().optional(),
  payments: z.array(
    z.object({ date: z.unknown(), amount: z.unknown(), type: z.unknown(), reference: z.unknown(), description: z.unknown() }),
  ),
  promo: z.number(),
  notepromo: z.string(),
  extracharge: z.number(),
  noteextracharge: z.string(),
  description: z.string().nullish(),
});
/** `get`'s answer for a `404` the caller reads as "not there". */
const ABSENT = Symbol('ABSENT');
const addressPart = z.string().optional().catch(undefined);
const addressDto = z.object({
  street1: addressPart,
  street2: addressPart,
  zipCode: addressPart,
  city: addressPart,
  state: addressPart,
  country: addressPart,
});

export interface HttpMreClientOptions {
  /** MRE landlord API base URL including `/api/v2`, e.g. `http://gateway:8080/api/v2`. */
  readonly apiBaseUrl: string;
  /** Per-request timeout. */
  readonly timeoutMs: number;
  readonly fetch?: typeof globalThis.fetch;
}

export class HttpMreClient implements MreClient {
  private readonly baseUrl: string;
  private readonly fetchFn: typeof globalThis.fetch;

  constructor(private readonly options: HttpMreClientOptions) {
    this.baseUrl = options.apiBaseUrl.replace(/\/+$/, '');
    this.fetchFn = options.fetch ?? globalThis.fetch;
  }

  async listRealms(accessToken: string): Promise<readonly MreRealmMembership[]> {
    const body = await this.get('/realms', accessToken);
    const parsed = realmsDto.safeParse(body);
    if (!parsed.success) {
      throw new MreClientError('UNAVAILABLE', `Unexpected MRE realms shape: ${parsed.error.message}`);
    }
    return parsed.data.map((realm) => ({
      mreRealmId: realm._id,
      name: realm.name,
      members: realm.members.flatMap((member) => {
        const parsedMember = memberDto.safeParse(member);
        return parsedMember.success ? [{ email: parsedMember.data.email, role: parsedMember.data.role }] : [];
      }),
    }));
  }

  async listProperties(accessToken: string, mreRealmId: string): Promise<readonly MreProperty[]> {
    // checkOrganization answers 404 when the Realm is not one of the caller's
    // (membership revoked after the access guard ran): no access, not an outage.
    const body = await this.get('/properties', accessToken, mreRealmId, 'FORBIDDEN');
    const parsed = propertiesDto.safeParse(body);
    if (!parsed.success) {
      throw new MreClientError('UNAVAILABLE', `Unexpected MRE properties shape: ${parsed.error.message}`);
    }
    return parsed.data.map((property) => ({
      mrePropertyId: property._id,
      name: typeof property['name'] === 'string' && property['name'] !== '' ? property['name'] : null,
      address: toAddress(property['address']),
      surface: toSurface(property['surface']),
    }));
  }

  async listTenantIds(accessToken: string, mreRealmId: string): Promise<readonly string[]> {
    const body = await this.get('/tenants', accessToken, mreRealmId, 'FORBIDDEN');
    const parsed = tenantsDto.safeParse(body);
    if (!parsed.success) {
      // The issue paths only, never the values: the body holds personal data.
      throw new MreClientError('UNAVAILABLE', `Unexpected MRE tenants shape at ${parsed.error.issues.map((i) => i.path.join('.')).join(', ')}`);
    }
    return parsed.data.map((tenant) => tenant._id);
  }

  async rentTermExists(accessToken: string, mreRealmId: string, mreTenantId: string, term: string): Promise<boolean> {
    return (await this.readRentTerm(accessToken, mreRealmId, mreTenantId, term)) !== undefined;
  }

  async readRentTerm(accessToken: string, mreRealmId: string, mreTenantId: string, term: string): Promise<MreRentTerm | undefined> {
    const body = await this.get(`/rents/tenant/${encodeURIComponent(mreTenantId)}/${encodeURIComponent(term)}`, accessToken, mreRealmId, 'ABSENT');
    if (body === ABSENT) return undefined;
    // Only the term key, the amount due and the payments are read; the rest (the Tenant's name and contact data,
    // a payment's description) is dropped here and never appears in an error message.
    const parsed = rentTermDto.safeParse(body);
    if (!parsed.success || String(parsed.data.term) !== term) {
      throw new MreClientError('UNAVAILABLE', 'Unexpected MRE rent term shape');
    }
    const amountDue = toCents(parsed.data.totalWithoutBalanceAmount);
    const payments = parsed.data.payments.map((p): MreRentPayment | undefined => {
      const amount = toCents(p.amount);
      return amount === undefined ? undefined : { date: toBusinessDate(p.date), amount, type: textOrNull(p.type), reference: textOrNull(p.reference) };
    });
    if (amountDue === undefined || payments.some((p) => p === undefined)) {
      throw new MreClientError('UNAVAILABLE', 'Unexpected MRE rent term amount');
    }
    return { amountDue, payments: payments as MreRentPayment[] };
  }

  async listRentTerms(accessToken: string, mreRealmId: string, year: number, month: number): Promise<readonly MreMonthRent[]> {
    // checkOrganization answers 404 when the Realm is not one of the caller's: no access, not an outage.
    const body = await this.get(`/rents/${year}/${String(month).padStart(2, '0')}`, accessToken, mreRealmId, 'FORBIDDEN');
    const parsed = monthDto.safeParse(body);
    // The issue paths only, never the values: the body holds the Tenants' personal data.
    if (!parsed.success) {
      throw new MreClientError('UNAVAILABLE', `Unexpected MRE month shape at ${parsed.error.issues.map((i) => i.path.join('.')).join(', ')}`);
    }
    const rents = parsed.data.rents.map((r) => ({ mreTenantId: r._id, term: String(r.term), amountDue: toCents(r.totalWithoutBalanceAmount) }));
    if (rents.some((r) => r.amountDue === undefined || !/^\d{10}$/.test(r.term))) throw new MreClientError('UNAVAILABLE', 'Unexpected MRE month amount');
    return rents as MreMonthRent[];
  }

  async readRentTermForWriteBack(accessToken: string, mreRealmId: string, mreTenantId: string, term: string): Promise<MreRawTerm | undefined> {
    const body = await this.get(`/rents/tenant/${encodeURIComponent(mreTenantId)}/${encodeURIComponent(term)}`, accessToken, mreRealmId, 'ABSENT');
    if (body === ABSENT) return undefined;
    const raw = toRawTerm(body, mreTenantId, term);
    if (raw === undefined) throw new MreClientError('UNAVAILABLE', 'Unexpected MRE rent term shape');
    return raw;
  }

  async writeRentTermPayments(accessToken: string, mreRealmId: string, mreTenantId: string, term: string, write: MreTermWrite): Promise<MreTermWriteResult> {
    let response: Response;
    try {
      response = await this.fetchFn(`${this.baseUrl}/rents/payment/${encodeURIComponent(mreTenantId)}/${encodeURIComponent(term)}`, {
        method: 'PATCH',
        headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json', 'content-type': 'application/json', organizationid: mreRealmId },
        // MRE's _updateByTerm looks the Tenant up by the body's _id and never reads the path's (review on #75).
        body: JSON.stringify({ _id: mreTenantId, ...write }),
        signal: AbortSignal.timeout(this.options.timeoutMs),
        redirect: 'error',
      });
    } catch (error) {
      return { kind: 'NO_ANSWER', message: `MRE request failed: ${String(error)}` };
    }
    if (response.status === 401) throw new MreClientError('UNAUTHENTICATED', 'MRE rejected the access token');
    if (response.status === 403) throw new MreClientError('FORBIDDEN', 'MRE refused the caller');
    // checkOrganization answers 404 when the Realm is not one of the caller's: no access, nothing written.
    if (response.status === 404) throw new MreClientError('FORBIDDEN', 'MRE does not grant access to this Realm');
    if (response.status !== 200) return { kind: 'REFUSED', status: response.status };
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return { kind: 'NO_ANSWER', message: 'MRE returned a non-JSON body' };
    }
    const saved = toRawTerm(body, mreTenantId, term);
    // An unreadable answer says nothing about what MRE saved: the caller reads the term again.
    return saved === undefined ? { kind: 'NO_ANSWER', message: 'Unexpected MRE rent term shape' } : { kind: 'ANSWERED', term: saved };
  }

  private async get(
    path: string,
    accessToken: string,
    mreRealmId?: string,
    notFound: MreClientErrorCode | 'ABSENT' = 'UNAVAILABLE',
  ): Promise<unknown> {
    const headers: Record<string, string> = { authorization: `Bearer ${accessToken}`, accept: 'application/json' };
    if (mreRealmId !== undefined) headers['organizationid'] = mreRealmId;
    let response: Response;
    try {
      response = await this.fetchFn(`${this.baseUrl}${path}`, {
        headers,
        signal: AbortSignal.timeout(this.options.timeoutMs),
        // Never follow a redirect with the caller's token; a redirect means a misconfigured gateway.
        redirect: 'error',
      });
    } catch (error) {
      throw new MreClientError('UNAVAILABLE', `MRE request failed: ${String(error)}`);
    }

    if (response.status === 401) throw new MreClientError('UNAUTHENTICATED', 'MRE rejected the access token');
    if (response.status === 403) throw new MreClientError('FORBIDDEN', 'MRE refused the caller');
    if (response.status === 404 && notFound === 'FORBIDDEN') {
      throw new MreClientError('FORBIDDEN', 'MRE does not grant access to this Realm');
    }
    if (response.status === 404 && notFound === 'ABSENT') return ABSENT;
    if (response.status !== 200) {
      throw new MreClientError('UNAVAILABLE', `Unexpected MRE status ${response.status}`);
    }

    try {
      return await response.json();
    } catch {
      throw new MreClientError('UNAVAILABLE', 'MRE returned a non-JSON body');
    }
  }
}

/**
 * An MRE float amount as Money (api-design.md §37.2): exactly its shortest round-trip decimal text, exponent notation
 * included (`grandTotal − balance` of a term with 0 due gives e.g. `2.831068712794149e-15`, review on #78), rounded
 * half-up to the cent. decimal.js' HALF_UP rounds a negative half away from zero (`-0.005` → `-0.01`), and a rounded
 * negative zero is `0.00`. Undefined for a non-finite amount or one outside Money's range.
 */
function toCents(value: number): Money | undefined {
  const text = decimalText(value);
  if (text === undefined) return undefined;
  try {
    return Money.rounded(ExactDecimal.of(text), 'EUR', RoundingMode.HALF_UP);
  } catch {
    return undefined;
  }
}

/** A term of the read or of the PATCH's answer, for the Tenant and term asked; undefined for any other shape. */
function toRawTerm(body: unknown, mreTenantId: string, term: string): MreRawTerm | undefined {
  const parsed = rawTermDto.safeParse(body);
  if (!parsed.success || parsed.data._id !== mreTenantId || String(parsed.data.term) !== term) return undefined;
  const d = parsed.data;
  return {
    mreTenantId: d._id,
    term: String(d.term),
    vatRatio: d.vatRatio ?? 0,
    payments: d.payments.map((p) => ({ date: p.date, amount: p.amount, type: p.type, reference: p.reference, description: p.description })),
    promo: d.promo,
    notepromo: d.notepromo,
    extracharge: d.extracharge,
    noteextracharge: d.noteextracharge,
    description: d.description ?? '',
  };
}

/** A finite JS number's shortest round-trip text as a canonical decimal string, exponent notation expanded. */
export function decimalText(value: number): string | undefined {
  if (!Number.isFinite(value)) return undefined;
  const text = String(value);
  const match = /^(-?)(\d+)(?:\.(\d+))?e([+-]\d+)$/.exec(text);
  if (match === null) return text;
  const [, sign = '', integer = '', fraction = '', exponent = '0'] = match;
  const digits = integer + fraction;
  const point = integer.length + Number(exponent);
  if (point <= 0) return `${sign}0.${'0'.repeat(-point)}${digits}`;
  if (point >= digits.length) return `${sign}${digits}${'0'.repeat(point - digits.length)}`;
  return `${sign}${digits.slice(0, point)}.${digits.slice(point)}`;
}

/** MRE's payment date `DD/MM/YYYY` as a business date, or null. */
function toBusinessDate(value: unknown): MreRentPayment['date'] {
  if (typeof value !== 'string') return null;
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value);
  if (match === null) return null;
  const result = checkBusinessDate(`${match[3]}-${match[2]}-${match[1]}`);
  return 'date' in result ? result.date : null;
}

const textOrNull = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);

/** The address parts MRE has, or null when there are none. */
function toAddress(value: unknown): MreAddress | null {
  const parsed = addressDto.safeParse(value);
  if (!parsed.success) return null;
  const parts = Object.fromEntries(Object.entries(parsed.data).filter(([, part]) => part !== undefined && part !== ''));
  return Object.keys(parts).length === 0 ? null : (parts as MreAddress);
}

/**
 * MRE `surface` is a JS number. Its shortest round-trip decimal text (64.5 →
 * "64.5") is taken exactly, never through float arithmetic. Negative,
 * non-finite or exponent-notation values are not a usable surface and are left out.
 */
function toSurface(value: unknown): ExactDecimal | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  try {
    return ExactDecimal.of(String(value));
  } catch {
    return null;
  }
}
