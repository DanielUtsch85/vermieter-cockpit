import express, { type Request, type Response, type Router } from 'express';
import { z } from 'zod';
import { zod3 } from '../shared/index.js';
import {
  CHANGE_KINDS,
  FINGERPRINT,
  OWNERSHIP_EXTENDED_FLAG,
  OWNERSHIP_START_FLAG,
  PART_CHANGE_KINDS,
  TAX_STATEMENT_STATUSES,
  type PartItem,
  type AcknowledgeAttributionChange,
  type ConfirmAllocationSet,
  type ListAcknowledgements,
  type ListConfirmations,
  type LoanAllocationTaxConfirmation,
  type TaxStatementStatus,
  type TaxYearAcknowledgement,
  type WithdrawAcknowledgement,
  type WithdrawConfirmation,
} from '../application/index.js';
import { principalOf } from './access-middleware.js';
import { type FieldError, NO_QUERY, readBody, readIdempotencyKey, readIfMatch, readQuery, RESOURCE_ID, sendValidationError } from './validation.js';

/**
 * The statements of the tax-year view (api-design.md §58E, VC-X-28): acknowledging an attribution change of a
 * PropertyReference and year, confirming a multi-entry `PURCHASE_PRICE` allocation set, withdrawing either, and their
 * lists. Request validation stays here (`400`, all field errors at once); the orders of checks are the use cases'.
 */

export interface TaxStatementCommands {
  readonly acknowledge: AcknowledgeAttributionChange;
  readonly listAcknowledgements: ListAcknowledgements;
  readonly withdrawAcknowledgement: WithdrawAcknowledgement;
  readonly confirm: ConfirmAllocationSet;
  readonly listConfirmations: ListConfirmations;
  readonly withdrawConfirmation: WithdrawConfirmation;
}

const reason = z.string().trim().min(1).max(500);
const uuid = z.string().regex(RESOURCE_ID);

// §58G: `kind` optional, one of both flags' kinds (Entscheidung des Projektinhabers, 2026-11-03, Frage 4).
// §58N: and OWNERSHIP_START_BEFORE_ECONOMIC_TRANSFER (Entscheidung des Projektinhabers, 2026-11-04, Frage 5).
// §58Q: and OWNERSHIP_EXTENDED_TO_ECONOMIC_TRANSFER (Entscheidung des Projektinhabers, 2026-11-05, Frage 7).
const kind = z.enum([...CHANGE_KINDS, ...PART_CHANGE_KINDS, OWNERSHIP_START_FLAG, OWNERSHIP_EXTENDED_FLAG]);
const acknowledgeBody = z.object({ auditRecordId: uuid, kind: kind.optional(), expectedFingerprint: z.string().regex(FINGERPRINT), reason }).strict();
const confirmBody = z.object({ reason, advisorPartyId: uuid.nullish() }).strict();
const withdrawBody = z.object({ reason }).strict();
const listQuery = z.object({
  status: zod3
    .transform(z.string(), (value, ctx) => {
      const statuses = value.split(',');
      if (statuses.some((s) => !(TAX_STATEMENT_STATUSES as readonly string[]).includes(s))) {
        ctx.addIssue({ code: 'custom', path: [], params: { code: 'INVALID_FORMAT' } });
        return z.NEVER;
      }
      return [...new Set(statuses)] as TaxStatementStatus[];
    })
    .optional(),
});

/** The path's ids and `year` (§58C: `INVALID_FORMAT` for anything but digits, `OUT_OF_RANGE` outside 2000–2100). */
function pathOf(req: Request, ids: readonly string[], withYear: boolean): { errors: FieldError[]; ids: Record<string, string>; year: number } {
  const errors: FieldError[] = [];
  const found: Record<string, string> = {};
  for (const name of ids) {
    const raw = req.params[name];
    if (raw === undefined || !RESOURCE_ID.test(raw)) errors.push({ field: name, code: 'INVALID_FORMAT' });
    else found[name] = raw.toLowerCase();
  }
  const rawYear = req.params['year'] ?? '';
  const year = Number(rawYear);
  if (withYear) {
    if (!/^\d{1,9}$/.test(rawYear)) errors.push({ field: 'year', code: 'INVALID_FORMAT' });
    else if (year < 2000 || year > 2100) errors.push({ field: 'year', code: 'OUT_OF_RANGE' });
  }
  return { errors, ids: found, year };
}

const ACK_PATH = '/property-references/:propertyReferenceId/tax-years/:year/acknowledgements';
const CONFIRM_PATH = '/loans/:loanId/allocations/:allocationSetId/tax-confirmations';

export function taxStatementRoutes(commands: TaxStatementCommands): Router {
  const router = express.Router();

  router.post(ACK_PATH, express.json({ limit: '16kb' }), (req, res, next) => {
    const query = readQuery(NO_QUERY, req);
    const path = pathOf(req, ['propertyReferenceId'], true);
    const idempotency = readIdempotencyKey(req, res);
    if (idempotency === undefined) return;
    // §58W rule 5, §58X rule 4: the path's errors (and a refused query's), before the body is read.
    if (path.errors.length > 0 || !query.ok) return sendValidationError(res, path.errors);
    const parsed = readBody(acknowledgeBody, req);
    if (!parsed.ok) return sendValidationError(res, parsed.errors);
    const propertyReferenceId = path.ids['propertyReferenceId'] as string;
    commands
      .acknowledge({
        principal: principalOf(res),
        propertyReferenceId,
        year: path.year,
        auditRecordId: parsed.data.auditRecordId.toLowerCase(),
        ...(parsed.data.kind === undefined ? {} : { kind: parsed.data.kind }),
        expectedFingerprint: parsed.data.expectedFingerprint,
        reason: parsed.data.reason,
        ...(idempotency.key === undefined ? {} : { idempotencyKey: idempotency.key }),
      })
      .then(({ acknowledgement, created, replayed }) => {
        if (replayed) res.setHeader('Idempotent-Replayed', 'true');
        res.setHeader(
          'Location',
          `/api/v1/property-references/${propertyReferenceId}/tax-years/${path.year}/acknowledgements/${acknowledgement.acknowledgementId}`,
        );
        sendStatement(res.status(created ? 201 : 200), acknowledgement.version, acknowledgementDto(acknowledgement));
      })
      .catch(next);
  });

  router.get(ACK_PATH, (req, res, next) => {
    const query = readQuery(listQuery, req);
    const path = pathOf(req, ['propertyReferenceId'], true);
    if (path.errors.length > 0 || !query.ok) return sendValidationError(res, path.errors);
    commands
      .listAcknowledgements({
        principal: principalOf(res),
        propertyReferenceId: path.ids['propertyReferenceId'] as string,
        year: path.year,
        statuses: query.data.status ?? null,
      })
      .then((items) => res.json({ items: items.map(acknowledgementDto) }))
      .catch(next);
  });

  router.post(`${ACK_PATH}/:acknowledgementId/withdraw`, express.json({ limit: '16kb' }), (req, res, next) => {
    const query = readQuery(NO_QUERY, req);
    const path = pathOf(req, ['propertyReferenceId', 'acknowledgementId'], true);
    const ifMatch = readIfMatch(req, res);
    if (ifMatch === undefined) return;
    // §58W rule 5, §58X rule 4: the path's errors (and a refused query's), before the body is read.
    if (path.errors.length > 0 || !query.ok) return sendValidationError(res, path.errors);
    const parsed = readBody(withdrawBody, req);
    if (!parsed.ok) return sendValidationError(res, parsed.errors);
    commands
      .withdrawAcknowledgement({
        principal: principalOf(res),
        propertyReferenceId: path.ids['propertyReferenceId'] as string,
        year: path.year,
        acknowledgementId: path.ids['acknowledgementId'] as string,
        reason: parsed.data.reason,
        ...(ifMatch.versions === undefined ? {} : { expectedVersions: ifMatch.versions }),
      })
      .then((acknowledgement) => sendStatement(res, acknowledgement.version, acknowledgementDto(acknowledgement)))
      .catch(next);
  });

  router.post(CONFIRM_PATH, express.json({ limit: '16kb' }), (req, res, next) => {
    const query = readQuery(NO_QUERY, req);
    const path = pathOf(req, ['loanId', 'allocationSetId'], false);
    const idempotency = readIdempotencyKey(req, res);
    if (idempotency === undefined) return;
    // §58W rule 5, §58X rule 4: the path's errors (and a refused query's), before the body is read.
    if (path.errors.length > 0 || !query.ok) return sendValidationError(res, path.errors);
    const parsed = readBody(confirmBody, req);
    if (!parsed.ok) return sendValidationError(res, parsed.errors);
    commands
      .confirm({
        principal: principalOf(res),
        loanId: path.ids['loanId'] as string,
        allocationSetId: path.ids['allocationSetId'] as string,
        reason: parsed.data.reason,
        advisorPartyId: parsed.data.advisorPartyId?.toLowerCase() ?? null,
        ...(idempotency.key === undefined ? {} : { idempotencyKey: idempotency.key }),
      })
      .then(({ confirmation, created, replayed }) => {
        if (replayed) res.setHeader('Idempotent-Replayed', 'true');
        res.setHeader(
          'Location',
          `/api/v1/loans/${confirmation.loanId}/allocations/${confirmation.allocationSetId}/tax-confirmations/${confirmation.confirmationId}`,
        );
        sendStatement(res.status(created ? 201 : 200), confirmation.version, confirmationDto(confirmation));
      })
      .catch(next);
  });

  router.get(CONFIRM_PATH, (req, res, next) => {
    const query = readQuery(NO_QUERY, req);
    const path = pathOf(req, ['loanId', 'allocationSetId'], false);
    if (path.errors.length > 0 || !query.ok) return sendValidationError(res, path.errors);
    commands
      .listConfirmations({ principal: principalOf(res), loanId: path.ids['loanId'] as string, allocationSetId: path.ids['allocationSetId'] as string })
      .then((items) => res.json({ items: items.map(confirmationDto) }))
      .catch(next);
  });

  router.post(`${CONFIRM_PATH}/:confirmationId/withdraw`, express.json({ limit: '16kb' }), (req, res, next) => {
    const query = readQuery(NO_QUERY, req);
    const path = pathOf(req, ['loanId', 'allocationSetId', 'confirmationId'], false);
    const ifMatch = readIfMatch(req, res);
    if (ifMatch === undefined) return;
    // §58W rule 5, §58X rule 4: the path's errors (and a refused query's), before the body is read.
    if (path.errors.length > 0 || !query.ok) return sendValidationError(res, path.errors);
    const parsed = readBody(withdrawBody, req);
    if (!parsed.ok) return sendValidationError(res, parsed.errors);
    commands
      .withdrawConfirmation({
        principal: principalOf(res),
        loanId: path.ids['loanId'] as string,
        allocationSetId: path.ids['allocationSetId'] as string,
        confirmationId: path.ids['confirmationId'] as string,
        reason: parsed.data.reason,
        ...(ifMatch.versions === undefined ? {} : { expectedVersions: ifMatch.versions }),
      })
      .then((confirmation) => sendStatement(res, confirmation.version, confirmationDto(confirmation)))
      .catch(next);
  });

  return router;
}

/** A statement with its version as `ETag` for the next `If-Match` (api-design.md §16.1). */
function sendStatement(res: Response, version: number, body: unknown): void {
  res.setHeader('ETag', `"${version}"`);
  res.json(body);
}

const iso = (d: Date | null) => (d === null ? null : d.toISOString());

const partItemDto = (i: PartItem) => ({
  sourceType: i.sourceType,
  sourceId: i.sourceId,
  taxYear: i.taxYear,
  stateBefore: i.stateBefore,
  partBefore: i.partBefore?.toJSON() ?? null,
  stateAfter: i.stateAfter,
  partAfter: i.partAfter?.toJSON() ?? null,
});

/** §58E's response of one acknowledgement. */
export function acknowledgementDto(a: TaxYearAcknowledgement) {
  return {
    acknowledgementId: a.acknowledgementId,
    propertyReferenceId: a.propertyReferenceId,
    year: a.year,
    status: a.status,
    change: {
      auditRecordId: a.change.auditRecordId,
      kind: a.change.kind,
      entityType: a.change.entityType,
      entityId: a.change.entityId,
      recordedAt: a.change.recordedAt.toISOString(),
      fingerprint: a.change.fingerprint,
      // §58G: the part shape for a part kind, the year shape otherwise; `kind` tells which.
      items: a.change.items.map((i) => ('stateBefore' in i ? partItemDto(i) : { sourceId: i.sourceId, yearBefore: i.yearBefore, yearAfter: i.yearAfter })),
    },
    reason: a.reason,
    acknowledgedAt: a.acknowledgedAt.toISOString(),
    acknowledgedBy: a.acknowledgedBy,
    withdrawnAt: iso(a.withdrawnAt),
    withdrawnBy: a.withdrawnBy,
    withdrawReason: a.withdrawReason,
    version: a.version,
  };
}

/** §58E's response of one confirmation; `set` read from the set. */
export function confirmationDto(c: LoanAllocationTaxConfirmation) {
  return {
    confirmationId: c.confirmationId,
    loanId: c.loanId,
    allocationSetId: c.allocationSetId,
    status: c.status,
    set: {
      validFrom: c.set.validFrom,
      basis: c.set.basis,
      allocations: c.set.allocations.map((a) => ({ propertyReferenceId: a.propertyReferenceId, share: a.share, acquisitionId: a.acquisitionId })),
    },
    reason: c.reason,
    advisorPartyId: c.advisorPartyId,
    confirmedAt: c.confirmedAt.toISOString(),
    confirmedBy: c.confirmedBy,
    withdrawnAt: iso(c.withdrawnAt),
    withdrawnBy: c.withdrawnBy,
    withdrawReason: c.withdrawReason,
    version: c.version,
  };
}
