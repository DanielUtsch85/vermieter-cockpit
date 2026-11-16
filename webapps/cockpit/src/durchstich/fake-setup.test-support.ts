import { envelope, json } from '../api/fetch.test-support';
import type { FinancialAccountDto, PropertyReferenceDto } from '../api/transactions';
import { account, page, property, REALM_A, REALM_B } from '../transactions/fixtures.test-support';
import { ACCOUNT_IBAN, newId, NOW } from './fake-model.test-support';
import type { RealMappings, Schema } from './real-mappings.test-support';

/**
 * The setup side of the Durchstich's fake backend (Issue #365), split from fake-backend.test-support.ts to keep each file
 * within its size limit: the Realms' accounts and PropertyReferences as state, `POST /financial-accounts` with its
 * `Idempotency-Key` (api-design.md §29.1, §29.2), `POST /property-references/link` with its natural key (§23.1), and MRE's
 * property list of each Realm (`GET /api/v2/properties`, mre-integration.md §21.1). Bodies are checked with the routes'
 * own schemas and answered through the backend's own DTO mappings. Only synthetic names and MRE ids.
 */

/** The MRE properties of Realm A: the one linked from the start (`PROPERTY`) and one not linked yet. */
export const MRE_LINKED = property().mrePropertyId;
export const MRE_UNLINKED = '64b7f0c2a1b2c3d4e5f60721';
export const MRE_UNLINKED_NAME = 'Testhaus Wohnung 2';
const MRE_B = '64b7f0c2a1b2c3d4e5f60730';

export interface SetupFake {
  readonly accounts: FinancialAccountDto[];
  readonly references: PropertyReferenceDto[];
  /** MRE's properties per Realm, as `GET /api/v2/properties` lists them (only `_id` and `name` matter). */
  readonly mreProperties: Map<string, { _id: string; name: string }[]>;
  listAccounts(realm: string): Response;
  listReferences(realm: string): Response;
  createAccount(realm: string, headers: Headers, body: unknown): Response;
  link(realm: string, body: unknown, mreUp: boolean): Response;
  mreList(realm: string | null, mreUp: boolean): Response;
  /** Realm A as a fresh Realm: no account and no linked object in DE; its two properties stay in MRE. */
  fresh(): void;
}

/** The field of the first schema issue, as `details.fields[]` names it; `(body)` for the body as a whole. */
function refused(schema: Schema, body: unknown): Response | undefined {
  const parsed = schema.safeParse(body);
  if (parsed.success) return undefined;
  const field = parsed.error?.issues[0]?.path[0];
  return envelope(400, 'VALIDATION_ERROR', { fields: [{ field: typeof field === 'string' ? field : '(body)', code: 'INVALID_FORMAT' }] });
}

export function createSetupFake(real: RealMappings): SetupFake {
  const accounts: FinancialAccountDto[] = [account({ iban: ACCOUNT_IBAN })];
  const references: PropertyReferenceDto[] = [
    property(),
    property({ mreRealmId: REALM_B, propertyReferenceId: newId(), displayName: 'Haus B', mrePropertyId: MRE_B }),
  ];
  const mreProperties = new Map([
    [
      REALM_A,
      [
        { _id: MRE_LINKED, name: 'Testhaus Wohnung 1' },
        { _id: MRE_UNLINKED, name: MRE_UNLINKED_NAME },
      ],
    ],
    [REALM_B, [{ _id: MRE_B, name: 'Haus B' }]],
  ]);
  const keys = new Map<string, { fingerprint: string; answer: FinancialAccountDto }>();

  return {
    accounts,
    references,
    mreProperties,
    listAccounts: (realm) => json(200, page(accounts.filter((a) => a.mreRealmId === realm))),
    listReferences: (realm) => json(200, page(references.filter((r) => r.mreRealmId === realm))),
    createAccount: (realm, headers, body) => {
      const refusal = refused(real.schemas.createAccount, body);
      if (refusal !== undefined) return refusal;
      const data = real.schemas.createAccount.safeParse(body).data as { accountType: string; displayName: string; currency: string; iban?: string };
      const key = headers.get('idempotency-key');
      // §29.2: the key is scoped to the Realm; the same normalised body answers the account recorded at creation.
      const fingerprint = JSON.stringify({ realm, ...data });
      const stored = key === null ? undefined : keys.get(`${realm}:${key}`);
      if (stored !== undefined) {
        return stored.fingerprint === fingerprint ? json(201, stored.answer, { 'idempotent-replayed': 'true' }) : envelope(409, 'CONFLICT');
      }
      const created = real.account({
        id: newId(),
        mreRealmId: realm,
        accountType: data.accountType,
        displayName: data.displayName,
        currency: data.currency,
        iban: data.iban ?? null,
        status: 'OPEN',
        createdAt: NOW,
        closedAt: null,
        version: 1,
      });
      accounts.push(created);
      if (key !== null) keys.set(`${realm}:${key}`, { fingerprint, answer: created });
      return json(201, created);
    },
    link: (realm, body, mreUp) => {
      const refusal = refused(real.schemas.link, body);
      if (refusal !== undefined) return refusal;
      const { mreRealmId, mrePropertyId } = body as { mreRealmId: string; mrePropertyId: string };
      if (mreRealmId !== realm) return envelope(403, 'FORBIDDEN');
      const existing = references.find((r) => r.mreRealmId === realm && r.mrePropertyId === mrePropertyId);
      if (existing !== undefined) return json(200, existing);
      if (!mreUp) return envelope(503, 'EXTERNAL_SYSTEM_ERROR');
      const listed = mreProperties.get(realm)?.find((p) => p._id === mrePropertyId);
      if (listed === undefined) return envelope(404, 'NOT_FOUND');
      const created = real.propertyReference({
        id: newId(),
        mreRealmId: realm,
        mrePropertyId,
        externalReferenceState: 'ACTIVE',
        displayName: listed.name === '' ? null : listed.name,
        cachedAddress: null,
        cachedSurface: null,
        lastRefreshedAt: NOW,
        lastObservedAt: NOW,
        createdAt: NOW,
        version: 1,
      });
      references.push(created);
      return json(201, created);
    },
    // MRE answers a missing `organizationid` with 404 (mre-integration.md §21.1); an unreachable MRE with its gateway's 502.
    mreList: (realm, mreUp) => {
      if (!mreUp) return new Response('Bad Gateway', { status: 502 });
      if (realm === null) return json(404, {});
      return json(
        200,
        (mreProperties.get(realm) ?? []).map((p) => ({ ...p, type: 'apartment', price: 700 })),
      );
    },
    fresh: () => {
      for (const list of [accounts, references] as const) {
        for (let i = list.length - 1; i >= 0; i -= 1) if (list[i]?.mreRealmId === REALM_A) list.splice(i, 1);
      }
    },
  };
}
