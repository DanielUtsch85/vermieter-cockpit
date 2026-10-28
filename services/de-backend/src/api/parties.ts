import express, { type Response, type Router } from 'express';
import { z } from 'zod';
import {
  IdempotencyKeyConflictError,
  MRE_EXTERNAL_ID,
  PARTY_STATUSES,
  PARTY_TYPES,
  PartyFieldNotAllowedError,
  PartyNotFoundError,
  VersionConflictError,
  type AmendParty,
  type CreateParty,
  type DeactivateParty,
  type GetParty,
  type ListParties,
  type Party,
} from '../application/index.js';
import { principalOf } from './access-middleware.js';
import { sendError } from './errors.js';
import { RESOURCE_ID, fieldErrors, readIdempotencyKey, readIfMatch, sendValidationError } from './validation.js';

/** Trimmed, at most `max`; empty (or null) becomes null (api-design.md §19.1). */
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .transform((value) => (value === '' ? null : value));
/** One `@` with text on both sides; no further validation (§19.1). */
const email = z
  .string()
  .trim()
  .max(254)
  .nullable()
  .transform((value) => (value === '' ? null : value))
  .refine((value) => value === null || /^[^@\s]+@[^@\s]+$/.test(value));
const displayName = z.string().trim().min(1).max(200);

const dataFields = {
  firstName: optionalText(200),
  lastName: optionalText(200),
  legalName: optionalText(200),
  registrationNumber: optionalText(100),
  email,
  phone: optionalText(50),
};

/** Field names verbatim from data-model.md §7.2–7.4; `organizationType` and `dateOfBirth` are not accepted yet. */
const createBody = z
  .object({
    partyType: z.enum(PARTY_TYPES),
    displayName,
    ...Object.fromEntries(Object.entries(dataFields).map(([key, schema]) => [key, schema.optional()])),
  })
  .strict() as z.ZodType<{ partyType: (typeof PARTY_TYPES)[number]; displayName: string } & Partial<Record<keyof typeof dataFields, string | null>>>;

const amendBody = z
  .object({ displayName: displayName.optional(), ...Object.fromEntries(Object.entries(dataFields).map(([key, schema]) => [key, schema.optional()])) })
  .strict()
  .refine((body) => Object.keys(body).length > 0, { params: { code: 'REQUIRED' } }) as z.ZodType<
  { displayName?: string } & Partial<Record<keyof typeof dataFields, string | null>>
>;

const deactivateBody = z.object({ reason: z.string().trim().min(1).max(500) }).strict();

const listQuery = z
  .object({
    partyType: z.enum(PARTY_TYPES).optional(),
    status: z.enum(PARTY_STATUSES).optional(),
    name: z.string().min(1).max(100).optional(),
    externalSystem: z.literal('MRE').optional(),
    externalId: z.string().regex(MRE_EXTERNAL_ID).optional(),
    page: z.coerce.number().int().min(1).max(1_000_000).default(1),
    pageSize: z.coerce.number().int().min(1).max(200).default(50),
  })
  .strict()
  // The two come together (api-design.md §20.1): one alone would silently match nothing or everything.
  .refine((query) => (query.externalSystem === undefined) === (query.externalId === undefined), {
    path: ['externalId'],
    params: { code: 'REQUIRED' },
  });

export interface PartyCommands {
  readonly create: CreateParty;
  readonly get: GetParty;
  readonly list: ListParties;
  readonly amend: AmendParty;
  readonly deactivate: DeactivateParty;
}

/** Party API (api-design.md §19.1, backlog VC-2-01). */
export function partyRoutes(commands: PartyCommands): Router {
  const router = express.Router();

  router.post('/parties', express.json({ limit: '16kb' }), (req, res, next) => {
    const idempotency = readIdempotencyKey(req, res);
    if (idempotency === undefined) return;
    const parsed = createBody.safeParse(req.body);
    if (!parsed.success) {
      sendValidationError(res, fieldErrors(parsed.error));
      return;
    }
    const body = parsed.data;
    commands
      .create({
        principal: principalOf(res),
        partyType: body.partyType,
        displayName: body.displayName,
        firstName: body.firstName ?? null,
        lastName: body.lastName ?? null,
        legalName: body.legalName ?? null,
        registrationNumber: body.registrationNumber ?? null,
        email: body.email ?? null,
        phone: body.phone ?? null,
        ...(idempotency.key === undefined ? {} : { idempotencyKey: idempotency.key }),
      })
      .then(({ party, replayed }) => {
        if (replayed) res.setHeader('Idempotent-Replayed', 'true');
        sendParty(res.status(201), party);
      })
      .catch((error: unknown) => {
        if (!sendPartyError(res, error, '')) next(error);
      });
  });

  router.get('/parties', (req, res, next) => {
    const parsed = listQuery.safeParse(req.query);
    if (!parsed.success) {
      sendValidationError(res, fieldErrors(parsed.error));
      return;
    }
    const { page, pageSize, ...filter } = parsed.data;
    commands
      .list({
        principal: principalOf(res),
        filter: {
          ...(filter.partyType === undefined ? {} : { partyType: filter.partyType }),
          ...(filter.status === undefined ? {} : { status: filter.status }),
          ...(filter.name === undefined ? {} : { name: filter.name }),
          ...(filter.externalSystem === undefined || filter.externalId === undefined
            ? {}
            : { externalReference: { system: filter.externalSystem, externalId: filter.externalId } }),
        },
        page: { page, pageSize },
      })
      .then((result) => {
        res.json({ items: result.items.map(toDto), page: result.page, pageSize: result.pageSize, total: result.total });
      })
      .catch(next);
  });

  router.get('/parties/:partyId', (req, res, next) => {
    const partyId = readPartyId(req.params['partyId'], res);
    if (partyId === undefined) return;
    commands
      .get({ principal: principalOf(res), partyId })
      .then((party) => sendParty(res, party))
      .catch((error: unknown) => {
        if (!sendPartyError(res, error, partyId)) next(error);
      });
  });

  router.post('/parties/:partyId/amend', express.json({ limit: '16kb' }), (req, res, next) => {
    const partyId = readPartyId(req.params['partyId'], res);
    if (partyId === undefined) return;
    const ifMatch = readIfMatch(req, res);
    if (ifMatch === undefined) return;
    const parsed = amendBody.safeParse(req.body);
    if (!parsed.success) {
      sendValidationError(res, fieldErrors(parsed.error));
      return;
    }
    commands
      .amend({
        principal: principalOf(res),
        partyId,
        changes: parsed.data,
        ...(ifMatch.versions === undefined ? {} : { expectedVersions: ifMatch.versions }),
      })
      .then(({ party }) => sendParty(res, party))
      .catch((error: unknown) => {
        if (!sendPartyError(res, error, partyId)) next(error);
      });
  });

  router.post('/parties/:partyId/deactivate', express.json({ limit: '16kb' }), (req, res, next) => {
    const partyId = readPartyId(req.params['partyId'], res);
    if (partyId === undefined) return;
    const ifMatch = readIfMatch(req, res);
    if (ifMatch === undefined) return;
    const parsed = deactivateBody.safeParse(req.body);
    if (!parsed.success) {
      sendValidationError(res, fieldErrors(parsed.error));
      return;
    }
    commands
      .deactivate({
        principal: principalOf(res),
        partyId,
        reason: parsed.data.reason,
        ...(ifMatch.versions === undefined ? {} : { expectedVersions: ifMatch.versions }),
      })
      .then(({ party }) => sendParty(res, party))
      .catch((error: unknown) => {
        if (!sendPartyError(res, error, partyId)) next(error);
      });
  });

  return router;
}

function readPartyId(value: string | undefined, res: Response): string | undefined {
  if (value !== undefined && RESOURCE_ID.test(value)) return value.toLowerCase();
  sendValidationError(res, [{ field: 'partyId', code: 'INVALID_FORMAT' }]);
  return undefined;
}

/** A single Party with its version as `ETag` for the next `If-Match` (api-design.md §16.1). */
function sendParty(res: Response, party: Party): void {
  res.setHeader('ETag', `"${party.version}"`);
  res.json(toDto(party));
}

/** The refusals of §19.1; false for anything else (→ the error handler). */
function sendPartyError(res: Response, error: unknown, partyId: string): boolean {
  if (error instanceof PartyNotFoundError) {
    sendError(res, 404, 'NOT_FOUND', 'Party not found.', { partyId });
  } else if (error instanceof PartyFieldNotAllowedError) {
    sendValidationError(
      res,
      error.fields.map((field) => ({ field, code: 'NOT_ALLOWED_FOR_TYPE' })),
    );
  } else if (error instanceof VersionConflictError) {
    sendError(res, 412, 'VERSION_CONFLICT', 'The Party changed since the version given in If-Match.', {
      expectedVersions: error.expectedVersions,
      currentVersion: error.currentVersion,
    });
  } else if (error instanceof IdempotencyKeyConflictError) {
    sendError(res, 409, 'CONFLICT', 'Idempotency-Key was already used with a different payload.');
  } else {
    return false;
  }
  return true;
}

function toDto(party: Party) {
  const typeFields =
    party.partyType === 'PERSON'
      ? { firstName: party.firstName, lastName: party.lastName }
      : { legalName: party.legalName, registrationNumber: party.registrationNumber };
  return {
    partyId: party.id,
    mreRealmId: party.mreRealmId,
    partyType: party.partyType,
    displayName: party.displayName,
    ...typeFields,
    email: party.email,
    phone: party.phone,
    status: party.status,
    deactivatedAt: party.deactivatedAt?.toISOString() ?? null,
    deactivationReason: party.deactivationReason,
    createdAt: party.createdAt.toISOString(),
    version: party.version,
  };
}
