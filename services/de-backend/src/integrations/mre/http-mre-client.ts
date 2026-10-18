import { z } from 'zod';
import { MreClientError, type MreClient, type MreRealmMembership } from './mre-client.js';

/**
 * MreClient over the MRE landlord API (`/api/v2`, reached through the MRE
 * gateway), verified against the pinned baseline 479d0ad (ADR-036):
 *
 * - `GET /realms` runs MRE's `needAccessToken` → `checkOrganization` →
 *   `notRoles(['tenant'])` chain: 401 for a missing/invalid/expired token,
 *   403 for a tenant session token, otherwise the realms whose `members`
 *   contain the token's account email (secrets already stripped by MRE).
 *
 * Only the fields DE needs are read; the MRE DTO never leaves this file.
 */

const realmDto = z.object({
  _id: z.string().min(1),
  name: z.string(),
  members: z.array(
    z.object({
      email: z.string().min(1),
      role: z.enum(['administrator', 'renter']),
    }),
  ),
});
const realmsDto = z.array(realmDto);

export interface HttpMreClientOptions {
  /** MRE landlord API base URL including `/api/v2`, e.g. `http://gateway:8080/api/v2`. */
  readonly apiBaseUrl: string;
  /** Per-request timeout. */
  readonly timeoutMs: number;
  readonly fetch?: typeof globalThis.fetch;
}

export class HttpMreClient implements MreClient {
  private readonly realmsUrl: string;
  private readonly fetchFn: typeof globalThis.fetch;

  constructor(private readonly options: HttpMreClientOptions) {
    this.realmsUrl = `${options.apiBaseUrl.replace(/\/+$/, '')}/realms`;
    this.fetchFn = options.fetch ?? globalThis.fetch;
  }

  async listRealms(accessToken: string): Promise<readonly MreRealmMembership[]> {
    let response: Response;
    try {
      response = await this.fetchFn(this.realmsUrl, {
        headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
        signal: AbortSignal.timeout(this.options.timeoutMs),
      });
    } catch (error) {
      throw new MreClientError('UNAVAILABLE', `MRE request failed: ${String(error)}`);
    }

    if (response.status === 401) throw new MreClientError('UNAUTHENTICATED', 'MRE rejected the access token');
    if (response.status === 403) throw new MreClientError('FORBIDDEN', 'MRE refused the caller');
    if (response.status !== 200) {
      throw new MreClientError('UNAVAILABLE', `Unexpected MRE status ${response.status}`);
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new MreClientError('UNAVAILABLE', 'MRE returned a non-JSON body');
    }
    const parsed = realmsDto.safeParse(body);
    if (!parsed.success) {
      throw new MreClientError('UNAVAILABLE', `Unexpected MRE realms shape: ${parsed.error.message}`);
    }
    return parsed.data.map((realm) => ({
      mreRealmId: realm._id,
      name: realm.name,
      members: realm.members.map(({ email, role }) => ({ email, role })),
    }));
  }
}
