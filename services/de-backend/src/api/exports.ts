import express, { type Request, type Response, type Router } from 'express';
import { z } from 'zod';
import type { ExportProperty, ExportTransactions, PropertyExport, TransactionExportHead } from '../application/index.js';
import { principalOf } from './access-middleware.js';
import { costDto, paymentDto } from './acquisition-costs.js';
import { readId, toDto as acquisitionDto } from './acquisitions.js';
import { toDto as landBuildingAllocationDto } from './land-building-allocations.js';
import { toDto as allocationSetDto } from './loan-allocations.js';
import { toStatementDto } from './loan-debt.js';
import { toDto as termsDto } from './loan-terms.js';
import { toDto as loanDto } from './loans.js';
import { toDto as ownershipDto } from './ownerships.js';
import { toDto as partyDto } from './parties.js';
import { toDto as propertyReferenceDto } from './property-references.js';
import { toDto as depositDto } from './security-deposits.js';
import { CSV_DIALECTS, CSV_ROWS, csvHead, csvRecords, type CsvDialect, type CsvRows } from './transaction-csv.js';
import { checkDateRange, filterFields, listFilter } from './transaction-dto.js';
import { NO_QUERY, readQuery, refuseQuery } from './validation.js';
import { membershipDto, wegDto } from './wegs.js';

/**
 * Data export (api-design.md §58S, VC-X-04): the Kassenbuch as CSV, streamed in one snapshot, and one PropertyReference
 * as JSON. Both only read; `Cache-Control: no-store` (personal data), no `ETag`; every error is JSON, before the first
 * byte. An error after the first byte destroys the connection without the closing chunk, so no file looks complete.
 */
export interface ExportCommands {
  readonly transactions: ExportTransactions;
  readonly property: ExportProperty;
  /** Where an export broken off after its first byte is logged (default `console.error`); no personal data. */
  readonly logError?: (line: string) => void;
}

/**
 * §30.1's filters (the same schema), `rows` and `dialect`; anything else, `page` and `pageSize` included, is `400`, named
 * by `readQuery` (§58W; the JSON route takes no parameter, `NO_QUERY`).
 */
const csvQuery = filterFields
  .extend({ rows: z.enum(CSV_ROWS).default('transactions'), dialect: z.enum(CSV_DIALECTS).default('rfc4180') })
  .refine(checkDateRange.check, checkDateRange.issue);

/** `YYYY-MM-DD` of the UTC day of an instant (the file names). */
const utcDay = (at: Date) => at.toISOString().slice(0, 10);

/** The client went away during the stream: the read ends, the snapshot with it. */
class ClientGoneError extends Error {
  override readonly name = 'ClientGoneError';
}

/** Writes a chunk, waiting for `drain` when the socket's buffer is full; rejects once the client is gone. */
function write(res: Response, chunk: string): Promise<void> {
  if (res.destroyed) return Promise.reject(new ClientGoneError());
  if (res.write(chunk)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const settle = (error?: Error) => {
      res.off('drain', onDrain);
      res.off('close', onClose);
      if (error === undefined) resolve();
      else reject(error);
    };
    const onDrain = () => settle();
    const onClose = () => settle(new ClientGoneError());
    res.once('drain', onDrain);
    res.once('close', onClose);
  });
}

function csvHeaders(res: Response, head: TransactionExportHead, mreRealmId: string, rows: CsvRows, dialect: CsvDialect): void {
  res.status(200);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8; header=present');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Disposition', `attachment; filename="kassenbuch-${utcDay(head.generatedAt)}${dialect === 'excel-de' ? '-excel-de' : ''}.csv"`);
  res.setHeader('X-Export-Generated-At', head.generatedAt.toISOString());
  res.setHeader('X-Export-Format', `vermieter-cockpit.transactions-csv; version=1; rows=${rows}; dialect=${dialect}`);
  res.setHeader('X-Export-Realm', mreRealmId);
  res.setHeader('X-Export-Transaction-Count', String(head.transactionCount));
  if (head.rowCount !== undefined) res.setHeader('X-Export-Row-Count', String(head.rowCount));
}

/** Format version 1 of the property file (§58S "Schema"): each element is its single read's DTO. */
export function propertyExportDto(doc: PropertyExport) {
  return {
    exportFormat: 'vermieter-cockpit.property-export',
    exportFormatVersion: 1,
    generatedAt: doc.generatedAt.toISOString(),
    mreRealmId: doc.mreRealmId,
    propertyReference: propertyReferenceDto(doc.propertyReference),
    ownerships: doc.ownerships.map(ownershipDto),
    acquisitions: doc.acquisitions.map((a) => ({
      ...acquisitionDto(a.acquisition),
      costs: a.costs.map(costDto),
      payments: a.payments.map(paymentDto),
      landBuildingAllocations: a.landBuildingAllocations.map((x) => landBuildingAllocationDto(x)),
    })),
    loans: doc.loans.map((l) => ({
      loan: loanDto(l.loan),
      terms: l.terms.map(termsDto),
      allocationSets: l.allocationSets.map(allocationSetDto),
      balanceStatements: l.balanceStatements.map(toStatementDto),
    })),
    wegMemberships: doc.wegMemberships.map((m) => ({ membership: membershipDto(m.membership), weg: wegDto(m.weg) })),
    securityDeposits: doc.securityDeposits.map(depositDto),
    securityDepositsNotAttributed: doc.securityDepositsNotAttributed.map((d) => ({
      securityDepositId: d.securityDepositId,
      reason: d.reason,
      candidates: [...d.candidates],
    })),
    parties: doc.parties.map(partyDto),
  };
}

export function exportRoutes(commands: ExportCommands): Router {
  const router = express.Router();
  const logError = commands.logError ?? ((line: string) => console.error(line));

  router.get('/exports/transactions.csv', (req: Request, res: Response, next) => {
    const query = readQuery(csvQuery, req);
    if (refuseQuery(res, query)) return;
    const { rows, dialect, ...filters } = query.data;
    const principal = principalOf(res);
    commands
      .transactions({
        principal,
        filter: listFilter(filters),
        withSplits: rows === 'splits',
        sink: {
          begin: (head) => {
            csvHeaders(res, head, principal.mreRealmId, rows, dialect);
            return write(res, csvHead(dialect, rows));
          },
          batch: (items) => write(res, items.map((item) => csvRecords(item, dialect, rows)).join('')),
        },
      })
      .then(() => res.end())
      .catch((error: unknown) => {
        if (!res.headersSent) {
          next(error);
          return;
        }
        // After the first byte the status cannot change: no closing chunk, so the client sees a broken transfer.
        if (!(error instanceof ClientGoneError))
          logError(`export aborted after the first byte: GET /api/v1/exports/transactions.csv (${String((error as Error).name)})`);
        res.destroy();
      });
  });

  router.get('/property-references/:propertyReferenceId/export.json', (req: Request, res: Response, next) => {
    const query = readQuery(NO_QUERY, req);
    const propertyReferenceId = readId(req.params['propertyReferenceId'], 'propertyReferenceId', res);
    if (propertyReferenceId === undefined) return;
    if (refuseQuery(res, query)) return;
    commands
      .property({ principal: principalOf(res), propertyReferenceId })
      .then((doc) => {
        res.status(200);
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Content-Disposition', `attachment; filename="objekt-${doc.propertyReference.id}-${utcDay(doc.generatedAt)}.json"`);
        res.setHeader('X-Export-Generated-At', doc.generatedAt.toISOString());
        res.setHeader('X-Export-Format', 'vermieter-cockpit.property-export; version=1');
        // `end`, not `json`: Express's `send` would add an `ETag` (§58S: none).
        res.end(JSON.stringify(propertyExportDto(doc)));
      })
      .catch(next);
  });

  return router;
}
