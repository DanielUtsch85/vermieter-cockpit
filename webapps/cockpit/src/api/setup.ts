import type { CreateFinancialAccountInputDto, LinkPropertyReferenceInputDto } from '@vermieter-cockpit/de-backend/client-contract';
import type { DeClient } from './client';
import { ApiError, CLIENT_CODES } from './errors';
import { checkRealm, type FinancialAccountDto, type PropertyReferenceDto } from './transactions';
import { authorizedFetch, readAnswer, type FetchLike, type TokenSource } from './transport';

export type { CreateFinancialAccountInputDto, LinkPropertyReferenceInputDto };

/**
 * The setup of a Realm (Issue #365; Entscheidung des Projektinhabers, 2026-11-16): an account for the import and the
 * objects of MRE linked for the split and the filter. Two DE commands (`USED_ROUTES`, gate/backend-pin.ts) and one MRE
 * read, the Realm's property list, which the cockpit reads as it reads the Realm list (mre-integration.md §21, §47.2).
 */

/**
 * `POST /financial-accounts` (api-design.md §29.1, §29.2) with the `Idempotency-Key` of the user's intent: the same body
 * after a lost answer is sent with the same key and never creates a second account; a replay answers the account of the
 * first request (§29.2). The answer belongs to the Realm asked for and is the account sent (type, name, IBAN); anything
 * else is refused, never shown.
 */
export async function createFinancialAccount(
  client: DeClient,
  body: CreateFinancialAccountInputDto,
  idempotencyKey: string,
  signal?: AbortSignal,
): Promise<FinancialAccountDto> {
  const { data } = await client.post<FinancialAccountDto>('/financial-accounts', { body, idempotencyKey, ...(signal === undefined ? {} : { signal }) });
  checkRealm(client.realmId, [data]);
  if (data.displayName !== body.displayName || data.accountType !== body.accountType || data.iban !== (body.iban ?? null)) {
    throw new ApiError(200, CLIENT_CODES.unexpected, 'The answer names another account than the one created.');
  }
  return data;
}

/**
 * `POST /property-references/link` (api-design.md §23.1): `{ mreRealmId, mrePropertyId }`, the Realm being the client's
 * (`organizationid`). No `Idempotency-Key`: the route takes none; the natural key makes a repeat a `200` with the
 * existing reference, never a second one. The answer belongs to the Realm and names the MRE property asked for.
 */
export async function linkPropertyReference(client: DeClient, mrePropertyId: string, signal?: AbortSignal): Promise<PropertyReferenceDto> {
  const body: LinkPropertyReferenceInputDto = { mreRealmId: client.realmId, mrePropertyId };
  const { data } = await client.post<PropertyReferenceDto>('/property-references/link', { body, ...(signal === undefined ? {} : { signal }) });
  checkRealm(client.realmId, [data]);
  if (data.mrePropertyId !== mrePropertyId) throw new ApiError(200, CLIENT_CODES.unexpected, 'The answer names another MRE property than the one linked.');
  return data;
}

/** One property of the Realm in MRE: its id and its name, nothing else is read. */
export interface MreProperty {
  readonly id: string;
  readonly name: string;
}

/** An MRE object id (mre-integration.md §21.1: 24 hex digits); any other entry of the list is left out. */
const MRE_OBJECT_ID = /^[0-9a-f]{24}$/;

/**
 * The Realm's properties in MRE, `GET /api/v2/properties` with `organizationid` (mre-integration.md §21, §21.1: the list
 * holds only the Realm's properties). DE has no read of unlinked MRE properties (its §21 discovery routes are not
 * implemented), so the cockpit reads MRE's own list with the session's token, as it reads `GET /api/v2/realms`. Only
 * `_id` and `name` are read; linking is DE's command, which checks the property in MRE again.
 */
export async function listMreProperties(
  tokens: TokenSource,
  realmId: string,
  fetchFn: FetchLike = defaultFetch,
  signal?: AbortSignal,
): Promise<readonly MreProperty[]> {
  const init: RequestInit = { method: 'GET', headers: { accept: 'application/json', organizationid: realmId } };
  if (signal !== undefined) init.signal = signal;
  const response = await authorizedFetch(tokens, fetchFn, '/api/v2/properties', init);
  const body = await readAnswer(response);
  if (!Array.isArray(body)) throw new ApiError(response.status, CLIENT_CODES.unexpected, 'The property list is not a list.');
  return body.flatMap((entry: unknown) => {
    if (typeof entry !== 'object' || entry === null) return [];
    const { _id: id, name } = entry as Record<string, unknown>;
    return typeof id === 'string' && MRE_OBJECT_ID.test(id) ? [{ id, name: typeof name === 'string' ? name.trim() : '' }] : [];
  });
}

const defaultFetch: FetchLike = (input, init) => globalThis.fetch(input, init);
