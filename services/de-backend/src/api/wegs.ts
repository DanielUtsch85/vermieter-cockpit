import express, { type Response, type Router } from 'express';
import { z } from 'zod';
import { zod3 } from '../shared/index.js';
import {
  MEMBERSHIP_STATUSES,
  WEG_STATUSES,
  formatMea,
  parseMea,
  type AmendMembership,
  type AmendWeg,
  type CreateMembership,
  type CreateWeg,
  type EndMembership,
  type GetMembership,
  type GetWeg,
  type ListMemberships,
  type ListWegs,
  type MembershipChanges,
  type ReadUnitMemberships,
  type VoidMembership,
  type VoidWeg,
  type Weg,
  type WegChanges,
  type WegMembership,
} from '../application/index.js';
import { principalOf } from './access-middleware.js';
import { businessDate, definedOnly, optionalText, readId } from './acquisitions.js';
import {
  NO_QUERY,
  OPTIONAL_PAGING,
  PAGING,
  readBody,
  readIdempotencyKey,
  readIfMatch,
  readQuery,
  refuseQuery,
  RESOURCE_ID,
  sendValidationError,
} from './validation.js';

const uuid = zod3.transform(z.string().regex(RESOURCE_ID), (id) => id.toLowerCase());

/** `"n/d"` with up to three decimals per part, normalized here (api-design.md §49.2). */
const mea = zod3.transform(z.string(), (value, ctx) => {
  const result = parseMea(value);
  if ('mea' in result) return result.mea;
  ctx.addIssue({ code: 'custom', params: { code: result.error } });
  return z.NEVER;
});

const displayName = z.string().trim().min(1).max(200);
const month = zod3.integer(1, 12);
const sourceReferences = zod3.array(optionalText(500)).max(10);

/** Documents do not exist yet: refused, never stored unchecked (as §33.2). */
const notSupported = (fields: readonly string[]) => (body: Record<string, unknown>, ctx: z.RefinementCtx) => {
  for (const field of fields) if (body[field] !== undefined) ctx.addIssue({ code: 'custom', path: [field], params: { code: 'NOT_SUPPORTED' } });
};

const wegBody = z
  .object({
    displayName,
    administratorPartyId: uuid.nullish(),
    financialYearStartMonth: month.optional(),
    notes: optionalText(2000).nullish(),
    administratorContractDocumentId: z.unknown().optional(),
  })
  .strict()
  .superRefine(notSupported(['administratorContractDocumentId']));

const wegAmendBody = z
  .object({
    displayName: displayName.optional(),
    administratorPartyId: uuid.nullable().optional(),
    financialYearStartMonth: month.optional(),
    notes: optionalText(2000).nullish(),
  })
  .strict()
  .superRefine((body, ctx) => {
    if (Object.keys(body).length === 0) ctx.addIssue({ code: 'custom', params: { code: 'REQUIRED' } });
  });

const membershipBody = z
  .object({
    propertyReferenceId: uuid,
    miteigentumsanteil: mea,
    validFrom: businessDate,
    validUntil: businessDate.nullish(),
    sourceReferences: sourceReferences.optional(),
    notes: optionalText(2000).nullish(),
    sourceDocumentId: z.unknown().optional(),
  })
  .strict()
  .superRefine((body, ctx) => {
    notSupported(['sourceDocumentId'])(body, ctx);
    // Refinements run even after a field failed to parse: only compare what parsed.
    if (typeof body.validFrom === 'string' && body.validUntil != null && body.validUntil < body.validFrom) {
      ctx.addIssue({ code: 'custom', path: ['validUntil'], params: { code: 'BEFORE_VALID_FROM' } });
    }
  });

/** Fixed after creation (§49.2): named in an amend, it is `400 NOT_AMENDABLE`, not an unknown key. */
const FIXED = ['wegId', 'propertyReferenceId', 'miteigentumsanteil', 'validFrom', 'validUntil'] as const;

const membershipAmendBody = z
  .object({
    sourceReferences: sourceReferences.nullable().optional(),
    notes: optionalText(2000).nullish(),
    ...Object.fromEntries(FIXED.map((field) => [field, z.unknown().optional()])),
  })
  .strict()
  .superRefine((body, ctx) => {
    if (Object.keys(body).length === 0) ctx.addIssue({ code: 'custom', params: { code: 'REQUIRED' } });
    for (const field of FIXED) {
      if (field in body) ctx.addIssue({ code: 'custom', path: [field], params: { code: 'NOT_AMENDABLE' } });
    }
  });

const endBody = z.object({ validUntil: businessDate }).strict();
const voidBody = z.object({ reason: z.string().trim().min(1).max(500) }).strict();

/** A comma-separated list of the given values, any of them. */
const commaList = <T extends readonly [string, ...string[]]>(values: T) =>
  zod3.transform(z.string(), (value) => value.split(',')).pipe(zod3.array(z.enum(values)).min(1));

const wegListQuery = z.object({
  status: commaList(WEG_STATUSES).optional(),
  administratorPartyId: uuid.optional(),
  propertyReferenceId: uuid.optional(),
  ...PAGING,
});

const membershipListQuery = z.object({ status: commaList(MEMBERSHIP_STATUSES).optional(), propertyReferenceId: uuid.optional(), ...PAGING });

const unitQuery = z
  .object({
    asOf: businessDate.optional(),
    ...OPTIONAL_PAGING,
  })
  // A day's membership is not paged (§49.2): paging parameters belong to the history only.
  .refine((query) => query.asOf === undefined || (query.page === undefined && query.pageSize === undefined), {
    path: ['page'],
    params: { code: 'NOT_SUPPORTED' },
  });

/** Trimmed references with empty ones dropped. */
const references = (values: readonly (string | null)[] | null | undefined) => (values ?? []).filter((reference): reference is string => reference !== null);

export interface WegCommands {
  readonly createWeg: CreateWeg;
  readonly getWeg: GetWeg;
  readonly listWegs: ListWegs;
  readonly amendWeg: AmendWeg;
  readonly voidWeg: VoidWeg;
  readonly createMembership: CreateMembership;
  readonly getMembership: GetMembership;
  readonly listMemberships: ListMemberships;
  readonly readUnitMemberships: ReadUnitMemberships;
  readonly amendMembership: AmendMembership;
  readonly endMembership: EndMembership;
  readonly voidMembership: VoidMembership;
}

/** WEG API (api-design.md §49.1–§49.2, backlog VC-6-01). */
export function wegRoutes(commands: WegCommands): Router {
  const router = express.Router();

  router.post('/wegs', express.json({ limit: '16kb' }), (req, res, next) => {
    const query = readQuery(NO_QUERY, req);
    const idempotency = readIdempotencyKey(req, res);
    if (idempotency === undefined) return;
    if (refuseQuery(res, query)) return;
    const parsed = readBody(wegBody, req);
    if (!parsed.ok) {
      sendValidationError(res, parsed.errors);
      return;
    }
    const body = parsed.data;
    commands
      .createWeg({
        principal: principalOf(res),
        displayName: body.displayName,
        administratorPartyId: body.administratorPartyId ?? null,
        // The calendar year unless the WEG's Wirtschaftsjahr differs (data-model §27).
        financialYearStartMonth: body.financialYearStartMonth ?? 1,
        notes: body.notes ?? null,
        ...(idempotency.key === undefined ? {} : { idempotencyKey: idempotency.key }),
      })
      .then(({ weg, replayed }) => {
        if (replayed) res.setHeader('Idempotent-Replayed', 'true');
        sendWeg(res.status(201), weg);
      })
      .catch(next);
  });

  router.get('/wegs', (req, res, next) => {
    const parsed = readQuery(wegListQuery, req);
    if (refuseQuery(res, parsed)) return;
    const { page, pageSize, status, ...rest } = parsed.data;
    commands
      .listWegs({ principal: principalOf(res), filter: definedOnly({ statuses: status, ...rest }), page: { page, pageSize } })
      .then((result) => res.json({ ...result, items: result.items.map(wegDto) }))
      .catch(next);
  });

  router.get('/wegs/:wegId', (req, res, next) => {
    const query = readQuery(NO_QUERY, req);
    const wegId = readId(req.params['wegId'], 'wegId', res);
    if (wegId === undefined) return;
    if (refuseQuery(res, query)) return;
    commands
      .getWeg({ principal: principalOf(res), wegId })
      .then((weg) => sendWeg(res, weg))
      .catch(next);
  });

  router.post('/wegs/:wegId/amend', express.json({ limit: '16kb' }), (req, res, next) => {
    const query = readQuery(NO_QUERY, req);
    const wegId = readId(req.params['wegId'], 'wegId', res);
    if (wegId === undefined) return;
    const ifMatch = readIfMatch(req, res);
    if (ifMatch === undefined) return;
    if (refuseQuery(res, query)) return;
    const parsed = readBody(wegAmendBody, req);
    if (!parsed.ok) {
      sendValidationError(res, parsed.errors);
      return;
    }
    const body = parsed.data;
    const changes: WegChanges = definedOnly({
      displayName: body.displayName,
      administratorPartyId: body.administratorPartyId,
      financialYearStartMonth: body.financialYearStartMonth,
      notes: body.notes,
    });
    commands
      .amendWeg({ principal: principalOf(res), wegId, changes, ...(ifMatch.versions === undefined ? {} : { expectedVersions: ifMatch.versions }) })
      .then(({ weg }) => sendWeg(res, weg))
      .catch(next);
  });

  router.post('/wegs/:wegId/void', express.json({ limit: '16kb' }), (req, res, next) => {
    const query = readQuery(NO_QUERY, req);
    const wegId = readId(req.params['wegId'], 'wegId', res);
    if (wegId === undefined) return;
    const ifMatch = readIfMatch(req, res);
    if (ifMatch === undefined) return;
    if (refuseQuery(res, query)) return;
    const parsed = readBody(voidBody, req);
    if (!parsed.ok) {
      sendValidationError(res, parsed.errors);
      return;
    }
    commands
      .voidWeg({
        principal: principalOf(res),
        wegId,
        reason: parsed.data.reason,
        ...(ifMatch.versions === undefined ? {} : { expectedVersions: ifMatch.versions }),
      })
      .then(({ weg }) => sendWeg(res, weg))
      .catch(next);
  });

  router.post('/wegs/:wegId/memberships', express.json({ limit: '16kb' }), (req, res, next) => {
    const query = readQuery(NO_QUERY, req);
    const wegId = readId(req.params['wegId'], 'wegId', res);
    if (wegId === undefined) return;
    const idempotency = readIdempotencyKey(req, res);
    if (idempotency === undefined) return;
    if (refuseQuery(res, query)) return;
    const parsed = readBody(membershipBody, req);
    if (!parsed.ok) {
      sendValidationError(res, parsed.errors);
      return;
    }
    const body = parsed.data;
    commands
      .createMembership({
        principal: principalOf(res),
        wegId,
        propertyReferenceId: body.propertyReferenceId,
        mea: body.miteigentumsanteil,
        validFrom: body.validFrom,
        validUntil: body.validUntil ?? null,
        sourceReferences: references(body.sourceReferences),
        notes: body.notes ?? null,
        ...(idempotency.key === undefined ? {} : { idempotencyKey: idempotency.key }),
      })
      .then(({ membership, replayed }) => {
        if (replayed) res.setHeader('Idempotent-Replayed', 'true');
        sendMembership(res.status(201), membership);
      })
      .catch(next);
  });

  router.get('/wegs/:wegId/memberships', (req, res, next) => {
    const parsed = readQuery(membershipListQuery, req);
    const wegId = readId(req.params['wegId'], 'wegId', res);
    if (wegId === undefined) return;
    if (refuseQuery(res, parsed)) return;
    const { page, pageSize, status, ...rest } = parsed.data;
    commands
      .listMemberships({ principal: principalOf(res), wegId, filter: definedOnly({ statuses: status, ...rest }), page: { page, pageSize } })
      .then((result) => res.json({ ...result, items: result.items.map(membershipDto) }))
      .catch(next);
  });

  router.get('/weg-memberships/:membershipId', (req, res, next) => {
    const query = readQuery(NO_QUERY, req);
    const membershipId = readId(req.params['membershipId'], 'membershipId', res);
    if (membershipId === undefined) return;
    if (refuseQuery(res, query)) return;
    commands
      .getMembership({ principal: principalOf(res), membershipId })
      .then((membership) => sendMembership(res, membership))
      .catch(next);
  });

  router.post('/weg-memberships/:membershipId/amend', express.json({ limit: '16kb' }), (req, res, next) => {
    const query = readQuery(NO_QUERY, req);
    const membershipId = readId(req.params['membershipId'], 'membershipId', res);
    if (membershipId === undefined) return;
    const ifMatch = readIfMatch(req, res);
    if (ifMatch === undefined) return;
    if (refuseQuery(res, query)) return;
    const parsed = readBody(membershipAmendBody, req);
    if (!parsed.ok) {
      sendValidationError(res, parsed.errors);
      return;
    }
    const body = parsed.data;
    const changes: MembershipChanges = definedOnly({
      // `null` clears the list (§49.2).
      sourceReferences: body.sourceReferences === undefined ? undefined : references(body.sourceReferences),
      notes: body.notes,
    });
    commands
      .amendMembership({
        principal: principalOf(res),
        membershipId,
        changes,
        ...(ifMatch.versions === undefined ? {} : { expectedVersions: ifMatch.versions }),
      })
      .then(({ membership }) => sendMembership(res, membership))
      .catch(next);
  });

  router.post('/weg-memberships/:membershipId/end', express.json({ limit: '16kb' }), (req, res, next) => {
    const query = readQuery(NO_QUERY, req);
    const membershipId = readId(req.params['membershipId'], 'membershipId', res);
    if (membershipId === undefined) return;
    const ifMatch = readIfMatch(req, res);
    if (ifMatch === undefined) return;
    if (refuseQuery(res, query)) return;
    const parsed = readBody(endBody, req);
    if (!parsed.ok) {
      sendValidationError(res, parsed.errors);
      return;
    }
    commands
      .endMembership({
        principal: principalOf(res),
        membershipId,
        validUntil: parsed.data.validUntil,
        ...(ifMatch.versions === undefined ? {} : { expectedVersions: ifMatch.versions }),
      })
      .then(({ membership }) => sendMembership(res, membership))
      .catch(next);
  });

  router.post('/weg-memberships/:membershipId/void', express.json({ limit: '16kb' }), (req, res, next) => {
    const query = readQuery(NO_QUERY, req);
    const membershipId = readId(req.params['membershipId'], 'membershipId', res);
    if (membershipId === undefined) return;
    const ifMatch = readIfMatch(req, res);
    if (ifMatch === undefined) return;
    if (refuseQuery(res, query)) return;
    const parsed = readBody(voidBody, req);
    if (!parsed.ok) {
      sendValidationError(res, parsed.errors);
      return;
    }
    commands
      .voidMembership({
        principal: principalOf(res),
        membershipId,
        reason: parsed.data.reason,
        ...(ifMatch.versions === undefined ? {} : { expectedVersions: ifMatch.versions }),
      })
      .then(({ membership }) => sendMembership(res, membership))
      .catch(next);
  });

  router.get('/property-references/:propertyReferenceId/weg-memberships', (req, res, next) => {
    const parsed = readQuery(unitQuery, req);
    const propertyReferenceId = readId(req.params['propertyReferenceId'], 'propertyReferenceId', res);
    if (propertyReferenceId === undefined) return;
    if (refuseQuery(res, parsed)) return;
    const { asOf, page, pageSize } = parsed.data;
    commands
      .readUnitMemberships(
        asOf === undefined
          ? { principal: principalOf(res), propertyReferenceId, page: { page: page ?? 1, pageSize: pageSize ?? 50 } }
          : { principal: principalOf(res), propertyReferenceId, asOf },
      )
      .then((result) => {
        if ('membership' in result) {
          res.json({ propertyReferenceId, asOf, membership: result.membership === null ? null : membershipDto(result.membership) });
        } else {
          const { items, ...rest } = result.history;
          res.json({ items: items.map(membershipDto), ...rest });
        }
      })
      .catch(next);
  });

  return router;
}

/** A single record with its version as `ETag` for the next `If-Match` (api-design.md §16.1). */
function sendWeg(res: Response, weg: Weg): void {
  res.setHeader('ETag', `"${weg.version}"`);
  res.json(wegDto(weg));
}

function sendMembership(res: Response, membership: WegMembership): void {
  res.setHeader('ETag', `"${membership.version}"`);
  res.json(membershipDto(membership));
}

export function wegDto(weg: Weg) {
  return {
    wegId: weg.id,
    mreRealmId: weg.mreRealmId,
    status: weg.status,
    displayName: weg.displayName,
    administratorPartyId: weg.administratorPartyId,
    financialYearStartMonth: weg.financialYearStartMonth,
    notes: weg.notes,
    voidedAt: weg.voidedAt?.toISOString() ?? null,
    voidReason: weg.voidReason,
    createdAt: weg.createdAt.toISOString(),
    version: weg.version,
  };
}

export function membershipDto(membership: WegMembership) {
  return {
    membershipId: membership.id,
    mreRealmId: membership.mreRealmId,
    wegId: membership.wegId,
    propertyReferenceId: membership.propertyReferenceId,
    miteigentumsanteil: formatMea(membership.mea),
    validFrom: membership.validFrom,
    validUntil: membership.validUntil,
    status: membership.status,
    voidedAt: membership.voidedAt?.toISOString() ?? null,
    voidReason: membership.voidReason,
    sourceReferences: membership.sourceReferences,
    notes: membership.notes,
    createdAt: membership.createdAt.toISOString(),
    version: membership.version,
  };
}
