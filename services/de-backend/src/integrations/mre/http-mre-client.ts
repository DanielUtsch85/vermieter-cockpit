import { z } from 'zod';
import { ExactDecimal } from '../../shared/index.js';
import {
  MreClientError,
  type MreAddress,
  type MreClient,
  type MreClientErrorCode,
  type MreProperty,
  type MreRealmMembership,
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

  private async get(
    path: string,
    accessToken: string,
    mreRealmId?: string,
    notFound: MreClientErrorCode = 'UNAVAILABLE',
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
