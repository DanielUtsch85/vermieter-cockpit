import type {
  ConfirmReconciliationInputDto,
  CreateReconciliationInputDto,
  PageDto,
  ReconciliationReasonInputDto,
  RentReconciliationDto,
  RentReconciliationReadDto,
  RentSplitProposalDto,
  SuggestInputDto,
  SuggestResultDto,
  TermCoverageDto,
  TransactionRentCoverageDto,
} from '@vermieter-cockpit/de-backend/client-contract';
import type { MoneyValue } from '../format/money';
import { addCents, decimalToCents } from '../transactions/split-amount';
import { apiPath, ifMatchForVersion, type DeClient } from './client';
import { ApiError, CLIENT_CODES } from './errors';
import { checkRealm } from './transactions';

export type {
  ConfirmReconciliationInputDto,
  CreateReconciliationInputDto,
  RentSplitProposalDto,
  ReconciliationReasonInputDto,
  RentReconciliationDto,
  RentReconciliationReadDto,
  SuggestInputDto,
  SuggestResultDto,
  TermCoverageDto,
  TransactionRentCoverageDto,
};

/**
 * Step 6 of the first slice (ui-guide.md §6.6, §10): rent suggestions, their confirmation or rejection, and, as separate
 * commands, the write-back to MRE, the release and the removal from MRE (api-design.md §37.1–§37.5), plus the two
 * coverage reads (§37.2). No command here takes an `Idempotency-Key`: suggest, confirm, reject, release, write-back and
 * removal are idempotent by design (a repeat is a `200` no-op or writes nothing new, §37.1–§37.5; ui-guide.md §7.3:
 * the header is not glued to every route). Confirm, reject and release check `If-Match`; write-back and removal take it
 * optionally, and the client sends the version it read with every command. No route outside `USED_ROUTES` is called.
 * Every answer is checked: the Realm, the reconciliation asked for, and the state the command promises; anything else
 * is refused, never shown (ui-guide.md §7.3).
 */

const same = (a: string | null | undefined, b: string) => typeof a === 'string' && a.toLowerCase() === b.toLowerCase();

function unexpected(message: string): ApiError {
  return new ApiError(200, CLIENT_CODES.unexpected, message);
}

function checkReconciliation<T extends RentReconciliationDto>(client: DeClient, r: T, reconciliationId: string): T {
  checkRealm(client.realmId, [r]);
  if (!same(r.reconciliationId, reconciliationId)) throw unexpected('The answer names another rent reconciliation.');
  return r;
}

const sameAmount = (a: MoneyValue, b: MoneyValue) =>
  a.currency === b.currency && decimalToCents(a.amount) !== undefined && decimalToCents(a.amount) === decimalToCents(b.amount);

/** The list's page size (api-design.md §37.1: 1–200, default 50). */
export const RECONCILIATION_PAGE_SIZE = 50;

/**
 * `POST /rent-reconciliations/suggest` with `{ from, to }` (`YYYY-MM`, at most twelve months; §37.3). Writes `SUGGESTED`
 * reconciliations only, never anything in MRE. The answer is the window sent, its items of this Realm, all `SUGGESTED`.
 */
export async function suggestReconciliations(client: DeClient, body: SuggestInputDto, signal?: AbortSignal): Promise<SuggestResultDto> {
  const { data } = await client.post<SuggestResultDto>('/rent-reconciliations/suggest', { body, ...(signal === undefined ? {} : { signal }) });
  if (data.from !== body.from || data.to !== body.to) throw unexpected('The answer names another window than the one sent.');
  checkRealm(client.realmId, data.items);
  if (data.items.some((item) => item.status !== 'SUGGESTED')) throw unexpected('A suggest run answered a reconciliation that is not SUGGESTED.');
  return data;
}

/** `GET /rent-reconciliations` (§37.1): one page, optionally of one status; only these parameters are sent (§58W). */
export async function listReconciliations(
  client: DeClient,
  query: { readonly status: string | undefined; readonly page: number },
  signal?: AbortSignal,
): Promise<PageDto<RentReconciliationDto>> {
  const { data } = await client.get<PageDto<RentReconciliationDto>>('/rent-reconciliations', {
    query: { status: query.status, page: query.page, pageSize: RECONCILIATION_PAGE_SIZE },
    ...(signal === undefined ? {} : { signal }),
  });
  checkRealm(client.realmId, data.items);
  if (query.status !== undefined && data.items.some((item) => item.status !== query.status)) throw unexpected('The answer lists another status than asked.');
  return data;
}

export interface ReconciliationRead {
  readonly reconciliation: RentReconciliationReadDto;
  /** The `ETag` read with it: the version every command sends as `If-Match`. */
  readonly etag: string;
}

/** `GET /rent-reconciliations/{id}` (§37.1) without `checkMre`: DE alone, never MRE. */
export async function getReconciliation(client: DeClient, reconciliationId: string, signal?: AbortSignal): Promise<ReconciliationRead> {
  const { data, etag } = await client.get<RentReconciliationReadDto>(
    apiPath`/rent-reconciliations/${reconciliationId}`,
    signal === undefined ? {} : { signal },
  );
  checkReconciliation(client, data, reconciliationId);
  return { reconciliation: data, etag: etag ?? ifMatchForVersion(data.version) };
}

export interface ReconciliationChanged {
  readonly reconciliation: RentReconciliationDto;
  readonly etag: string;
}

async function command(
  client: DeClient,
  path: string,
  reconciliationId: string,
  ifMatch: string,
  body: unknown,
  promised: (r: RentReconciliationDto) => boolean,
): Promise<ReconciliationChanged> {
  const { data, etag } = await client.post<RentReconciliationDto>(path, { ifMatch, ...(body === undefined ? {} : { body }) });
  checkReconciliation(client, data, reconciliationId);
  if (!promised(data)) throw unexpected('The answer is not the state the command promises.');
  return { reconciliation: data, etag: etag ?? ifMatchForVersion(data.version) };
}

/**
 * „Zuordnung bestätigen“: `POST …/{id}/confirm` with `{ matchedAmount }` (§37.3), the amount the user checked: the
 * suggested one or less, never more (`422 ABOVE_SUGGESTION` otherwise). Never writes to MRE (BR-MRE-005). The answer is
 * this reconciliation, `CONFIRMED`, with exactly the amount sent.
 */
export function confirmReconciliation(client: DeClient, reconciliationId: string, matchedAmount: MoneyValue, ifMatch: string): Promise<ReconciliationChanged> {
  const body: ConfirmReconciliationInputDto = { matchedAmount: { amount: matchedAmount.amount, currency: matchedAmount.currency } };
  return command(
    client,
    apiPath`/rent-reconciliations/${reconciliationId}/confirm`,
    reconciliationId,
    ifMatch,
    body,
    (r) => r.status === 'CONFIRMED' && sameAmount(r.matchedAmount, matchedAmount),
  );
}

/** Reject a suggestion: `POST …/{id}/reject` with `{ reason }` (§37.3); the pair is never suggested again. */
export function rejectReconciliation(client: DeClient, reconciliationId: string, reason: string, ifMatch: string): Promise<ReconciliationChanged> {
  const body: ReconciliationReasonInputDto = { reason };
  return command(client, apiPath`/rent-reconciliations/${reconciliationId}/reject`, reconciliationId, ifMatch, body, (r) => r.status === 'REJECTED');
}

/**
 * „Zuordnung aufheben“: `POST …/{id}/release` with `{ reason }` (§37.1, P4-D7). DE only: it never calls MRE, and it is
 * no removal from MRE; a payment that was written back becomes `REMOVAL_REQUIRED` (§37.4).
 */
export function releaseReconciliation(client: DeClient, reconciliationId: string, reason: string, ifMatch: string): Promise<ReconciliationChanged> {
  const body: ReconciliationReasonInputDto = { reason };
  return command(client, apiPath`/rent-reconciliations/${reconciliationId}/release`, reconciliationId, ifMatch, body, (r) => r.status === 'RELEASED');
}

/**
 * „An MRE übertragen“: `POST …/{id}/write-back-to-mre` without a body (§37.4). Only ever called from the user's click on
 * that button. The answer is this reconciliation, still `CONFIRMED`, `WRITTEN`.
 */
export function writeBackToMre(client: DeClient, reconciliationId: string, ifMatch: string): Promise<ReconciliationChanged> {
  return command(
    client,
    apiPath`/rent-reconciliations/${reconciliationId}/write-back-to-mre`,
    reconciliationId,
    ifMatch,
    undefined,
    (r) => r.status === 'CONFIRMED' && r.mreWriteBackState === 'WRITTEN',
  );
}

/**
 * „Aus MRE entfernen“: `POST …/{id}/remove-from-mre` without a body (§37.5), after the release and only on the user's
 * click. The answer is this reconciliation, `RELEASED`, `REMOVED`.
 */
export function removeFromMre(client: DeClient, reconciliationId: string, ifMatch: string): Promise<ReconciliationChanged> {
  return command(
    client,
    apiPath`/rent-reconciliations/${reconciliationId}/remove-from-mre`,
    reconciliationId,
    ifMatch,
    undefined,
    (r) => r.status === 'RELEASED' && r.mreWriteBackState === 'REMOVED',
  );
}

/**
 * `GET /rent-reconciliations/terms/{mreTenantId}/{mreRentTerm}` (§37.2): DE's matches and MRE's side of one term, next
 * to each other. The answer is this term; each of its reconciliations is of this Realm, Tenant and term.
 */
export async function getTermCoverage(client: DeClient, mreTenantId: string, mreRentTerm: string, signal?: AbortSignal): Promise<TermCoverageDto> {
  const { data } = await client.get<TermCoverageDto>(
    apiPath`/rent-reconciliations/terms/${mreTenantId}/${mreRentTerm}`,
    signal === undefined ? {} : { signal },
  );
  if (data.mreTenantId !== mreTenantId || data.mreRentTerm !== mreRentTerm) throw unexpected('The answer names another rent term.');
  checkRealm(client.realmId, data.reconciliations);
  if (data.reconciliations.some((r) => r.mreTenantId !== mreTenantId || r.mreRentTerm !== mreRentTerm)) throw unexpected('A match of another term was listed.');
  return data;
}

/** `GET /transactions/{transactionId}/rent-reconciliations` (§37.2): never calls MRE. */
export async function getTransactionRentCoverage(client: DeClient, transactionId: string, signal?: AbortSignal): Promise<TransactionRentCoverageDto> {
  const { data } = await client.get<TransactionRentCoverageDto>(
    apiPath`/transactions/${transactionId}/rent-reconciliations`,
    signal === undefined ? {} : { signal },
  );
  if (!same(data.transactionId, transactionId)) throw unexpected('The answer names another Transaction.');
  checkRealm(client.realmId, data.reconciliations);
  if (data.reconciliations.some((r) => !same(r.transactionId, transactionId))) throw unexpected('A match of another Transaction was listed.');
  return data;
}

/** The Tenant and term a proposal or a manual match names, by their MRE keys (ui-guide.md §5.1: never from a name). */
export interface RentTermRef {
  readonly mreTenantId: string;
  readonly mreRentTerm: string;
}

/** Whole cents of a money value in the given currency, or undefined. */
const centsOf = (money: MoneyValue, currency: string) => (money.currency === currency ? decimalToCents(money.amount) : undefined);

/**
 * `GET /rent-reconciliations/split-proposal?transactionId&mreTenantId&mreRentTerm` (api-design.md §37.6; ui-guide.md §6.6
 * step 2): a read, never a write; the client applies it only through the split editor and `PUT …/splits`. The answer is
 * checked: it names this Transaction, Tenant and term, every amount is in the Transaction's currency, and its splits
 * plus `unallocated` are exactly its `amount` (on whole cents as digit strings); anything else is refused, never shown.
 */
export async function getSplitProposal(client: DeClient, transactionId: string, term: RentTermRef, signal?: AbortSignal): Promise<RentSplitProposalDto> {
  const { data } = await client.get<RentSplitProposalDto>('/rent-reconciliations/split-proposal', {
    query: { transactionId, mreTenantId: term.mreTenantId, mreRentTerm: term.mreRentTerm },
    ...(signal === undefined ? {} : { signal }),
  });
  if (!same(data.transactionId, transactionId) || data.mreTenantId !== term.mreTenantId || data.mreRentTerm !== term.mreRentTerm) {
    throw unexpected('The answer names another Transaction or rent term.');
  }
  const currency = data.amount.currency;
  const parts = [...data.splits.map((s) => s.amount), data.unallocated].map((m) => centsOf(m, currency));
  const total = centsOf(data.amount, currency);
  if (total === undefined || parts.some((c) => c === undefined)) throw unexpected('The proposal has an amount that is not readable.');
  if (parts.reduce<string>((sum, c) => addCents(sum, c ?? '0'), '0') !== total) throw unexpected('The proposal does not add up to the amount.');
  return data;
}

/**
 * „Manuell zuordnen“: `POST /rent-reconciliations` (api-design.md §37.1), the manual match of a counted inflow's rent
 * cash to one MRE term; created `CONFIRMED` by the user's decision, never written to MRE (BR-MRE-005). The
 * `Idempotency-Key` belongs to the intent (scope `rent-reconciliation.create`, §15): a lost answer sends the same key and
 * body again and gets the recorded answer, never a second match. The answer is checked: this Realm, `CONFIRMED`,
 * `NOT_WRITTEN`, and exactly the Transaction, Tenant, term and amount sent.
 */
export async function createReconciliation(
  client: DeClient,
  body: CreateReconciliationInputDto,
  idempotencyKey: string,
  signal?: AbortSignal,
): Promise<ReconciliationChanged> {
  const { data, etag } = await client.post<RentReconciliationDto>('/rent-reconciliations', {
    body,
    idempotencyKey,
    ...(signal === undefined ? {} : { signal }),
  });
  checkRealm(client.realmId, [data]);
  const sent = body.matchedAmount as MoneyValue;
  if (
    !same(data.transactionId, String(body.transactionId)) ||
    data.mreTenantId !== body.mreTenantId ||
    data.mreRentTerm !== body.mreRentTerm ||
    data.status !== 'CONFIRMED' ||
    data.mreWriteBackState !== 'NOT_WRITTEN' ||
    !sameAmount(data.matchedAmount, sent)
  ) {
    throw unexpected('The answer is not the match that was sent.');
  }
  return { reconciliation: data, etag: etag ?? ifMatchForVersion(data.version) };
}
