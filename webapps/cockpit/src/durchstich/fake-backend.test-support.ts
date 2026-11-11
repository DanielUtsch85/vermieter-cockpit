import { fakeJwt, json, envelope } from '../api/fetch.test-support';
import type { FetchLike } from '../api/transport';
import type { MreAuthenticator } from '../session/mre-authenticator';
import { account, category, page, property, PROPERTY, REALM_A, REALM_B } from '../transactions/fixtures.test-support';
import { TENANT } from '../rent/fixtures.test-support';
import {
  ACCOUNT_IBAN,
  type Batch,
  conflict,
  CSV_NAME,
  decimalOf,
  EMAIL,
  type Fault,
  ifMatchVersion,
  invalid,
  isoDateOf,
  type Item,
  type MrePayment,
  newId,
  notFound,
  NOW,
  type Rec,
  type Sent,
  type Split,
  TERM_OCT,
  type Tx,
  unreachable,
} from './fake-model.test-support';
import { createRentFake, type MreTermState } from './fake-rent.test-support';
import type { Money, RealMappings } from './real-mappings.test-support';

export { ACCOUNT_IBAN, CSV_NAME, DURCHSTICH_CSV, EMAIL, TERM_OCT, type Rec, type Sent, type Tx } from './fake-model.test-support';

/**
 * A stateful, in-memory DE backend and MRE side for the Durchstich of ui-guide.md §10 (step 7). It keeps the backend's
 * domain objects and answers through the backend's own DTO mappings (real-mappings.test-support.ts); it checks every
 * request body with the route's schema, `If-Match` against the stored version and an `Idempotency-Key` against the
 * stored intent, as the routes do (api-design.md §15, §16.1). Every request is recorded with its headers. Faults are
 * injected per route: an answer of the test's choice, or a lost answer (the server did the work, the answer never
 * arrives). Only synthetic data: invented names, `DE00…` placeholders, `@example.invalid`.
 */

export interface Backend {
  readonly fetch: FetchLike;
  readonly mre: MreAuthenticator;
  /** Every request to DE and to MRE's Realm list, in order. */
  readonly sent: Sent[];
  readonly transactions: Map<string, Tx>;
  readonly reconciliations: Map<string, Rec>;
  readonly items: Map<string, Item>;
  /** MRE's payments of the October term; PATCHes to MRE are counted (`mreWrites`). */
  readonly mreTerm: { amountDue: Money; payments: MrePayment[] };
  readonly counters: { mreWrites: number; signIns: number };
  /** Realms for which DE refuses access (`403`), e.g. no DE role. */
  readonly forbidden: Set<string>;
  /** Whether MRE answers (term reads, write-back, removal); its authenticator stays reachable. */
  mreUp: boolean;
  /**
   * The suggest run's rule (fake-rent.test-support.ts): `ANY_AMOUNT`, the walk's simplification of step 7 (default), or
   * `EXACT`, §37.3's exact fit on the terms the fake knows (step 8: partial and collective payments are not suggested).
   */
  suggestRule: 'ANY_AMOUNT' | 'EXACT';
  /** A further MRE term with its lease values (§37.6); its amount due is rent + charges + adjustments. */
  addMreTerm(tenant: string, term: string, lease: { rent: string; charges: string; adjustments?: string }): void;
  /**
   * An inflow of Realm A as an import left it (`IMPORTED`, no splits), with synthetic text and counterparty; with
   * `confirmedRent`, as an earlier step left it: one `RENT_BASE` split over the whole amount, `CONFIRMED`.
   */
  seedInflow(description: string, amount: string, bookingDate: string, confirmedRent?: boolean): Tx;
  /** Whether DE can verify tokens with MRE (§47.1); when not, every DE call answers `503` with `Retry-After`. */
  guardUp: boolean;
  /** Whether the MRE authenticator answers a refresh (no answer: `createMreAuthenticator`'s network error). */
  authenticatorUp: boolean;
  /** The access tokens issued so far are no longer accepted (30 s lifetime); the refresh cookie still is. */
  expireAccessTokens(): void;
  /** DE refuses every token, a renewed one too (e.g. the MRE account was locked); the refresh cookie still works. */
  refuseAllTokens: boolean;
  fault(route: string, ...faults: Fault[]): void;
  /** The MRE session ends: the access token and the refresh cookie are no longer accepted. */
  expireSession(): void;
  /** Another tab started a write-back of this reconciliation: `PENDING` with a live lease. */
  startForeignWriteBack(recId: string): void;
  /** That write-back is done in MRE and recorded. */
  finishForeignWriteBack(recId: string): void;
  tx(description: string): Tx;
  /**
   * A rent payment of October as an earlier step left it (the steps before the one under test are not walked again):
   * imported, or split into Kaltmiete 700,00 and Nebenkosten 150,00 (`CLASSIFIED`), or confirmed.
   */
  seedRent(status: 'IMPORTED' | 'CLASSIFIED' | 'CONFIRMED', amount?: string): Tx;
  /** A reconciliation of that payment and the October term, `SUGGESTED` unless changed. */
  seedReconciliation(t: Tx, changes?: Partial<Rec>): Rec;
}

export function createBackend(real: RealMappings): Backend {
  const { Money } = real;
  const eur = (amount: string) => Money.of(amount, 'EUR');
  const tokens = new Set<string>();
  let cookie = true;
  let tokenNumber = 0;
  const issue = () => {
    tokenNumber += 1;
    const token = fakeJwt({ account: { email: EMAIL }, exp: 4_000_000_000, n: tokenNumber });
    tokens.add(token);
    return token;
  };

  const transactions = new Map<string, Tx>();
  const batches = new Map<string, Batch>();
  const items = new Map<string, Item>();
  const reconciliations = new Map<string, Rec>();
  const corrections = new Map<string, { fingerprint: string; body: unknown }>();
  // `reverse` has its own key scope (`transaction.reverse`, api-design.md §35.9): a correction's key never answers it.
  const reversals = new Map<string, { fingerprint: string; body: unknown }>();
  const faults = new Map<string, Fault[]>();
  const sent: Sent[] = [];

  const tx = (overrides: Partial<Tx> & Pick<Tx, 'mreRealmId' | 'amount' | 'bookingDate' | 'description'>): Tx => {
    const created: Tx = {
      id: newId(),
      financialAccountId: account().financialAccountId,
      direction: 'INFLOW',
      valueDate: overrides.bookingDate,
      propertyReferenceId: null,
      provenance: 'BANK_CSV',
      status: 'IMPORTED',
      createdAt: NOW,
      version: 1,
      confirmedAt: null,
      confirmedBy: null,
      correctionOfTransactionId: null,
      correctionRole: null,
      reversalTransactionId: null,
      replacementTransactionId: null,
      counterpartyNameRaw: null,
      counterpartyIbanRaw: null,
      splits: [],
      importBatchId: null,
      identity: null,
      ...overrides,
    };
    transactions.set(created.id, created);
    return created;
  };
  // An earlier import's booking that the new file's third row collides with (same day and amount, other purpose).
  const earlierBatch = newId();
  tx({
    mreRealmId: REALM_A,
    amount: eur('400.00'),
    bookingDate: '2026-10-15',
    description: 'Gutschrift Testversicherung',
    counterpartyNameRaw: 'Test Versicherung AG',
    counterpartyIbanRaw: 'DE00 0000 0000 0000 0000 04',
    status: 'CONFIRMED',
    version: 2,
    confirmedAt: NOW,
    confirmedBy: EMAIL,
    importBatchId: earlierBatch,
    identity: 'earlier-file:1',
  });
  tx({ mreRealmId: REALM_B, amount: eur('99.00'), bookingDate: '2026-10-03', description: 'Buchung aus Bestand B' });

  const mreTerm: MreTermState = {
    amountDue: eur('850.00'),
    payments: [{ date: '03/10/2026', amount: eur('50.00'), type: 'cash', reference: null }] as MrePayment[],
    rent: eur('700.00'),
    charges: eur('150.00'),
    adjustments: eur('0.00'),
  };
  const mreTerms = new Map<string, MreTermState>([[`${TENANT}/${TERM_OCT}`, mreTerm]]);
  const counters = { mreWrites: 0, signIns: 0 };
  const forbidden = new Set<string>();

  const of = (realm: string, id: string) => {
    const found = transactions.get(id.toLowerCase());
    return found?.mreRealmId === realm ? found : undefined;
  };
  const detail = (t: Tx) => json(200, { ...real.transaction(t), splits: t.splits.map(real.split) }, { etag: `"${t.version}"` });

  /* ---------------------------------------------------------------- imports (api-design.md §32) */

  const importFile = async (realm: string, form: FormData | undefined): Promise<Response> => {
    const metadataText = form?.get('metadata');
    const file = form?.get('file');
    if (typeof metadataText !== 'string' || !(file instanceof File)) return invalid();
    const metadata = JSON.parse(metadataText) as { financialAccountId: string; adapterId: string; adapterVersion: string };
    if (!real.schemas.metadata.safeParse(metadata).success) return invalid('metadata');
    const text = await file.text();
    const [header = '', ...lines] = text.split('\n').filter((line) => line.trim() !== '');
    const columns = header.split(';');
    const col = (cells: readonly string[], name: string) => cells[columns.indexOf(name)] ?? '';
    const batch: Batch = {
      id: newId(),
      mreRealmId: realm,
      financialAccountId: metadata.financialAccountId,
      adapterId: metadata.adapterId,
      adapterVersion: metadata.adapterVersion,
      sourceFilename: file.name,
      contentHash: 'a'.repeat(64),
      status: 'COMPLETED',
      transactionCount: 0,
      duplicateCount: 0,
      needsReviewCount: 0,
      errorCount: 0,
      skippedCount: 0,
      importedAt: NOW,
      importedBy: EMAIL,
      rows: [],
      continuity: null,
    };
    lines.forEach((line, index) => {
      const cells = line.split(';');
      const position = index + 1;
      const identity = `${file.name}:${position}`;
      const signed = decimalOf(col(cells, 'Betrag'));
      const direction = signed.startsWith('-') ? 'OUTFLOW' : 'INFLOW';
      const amount = eur(signed.replace('-', ''));
      const row = {
        bookingDate: isoDateOf(col(cells, 'Buchungstag')),
        valueDate: isoDateOf(col(cells, 'Valutadatum')),
        counterpartyNameRaw: col(cells, 'Name Zahlungsbeteiligter'),
        counterpartyIbanRaw: col(cells, 'IBAN Zahlungsbeteiligter'),
        description: col(cells, 'Verwendungszweck'),
      };
      const same = [...transactions.values()].find((t) => t.mreRealmId === realm && t.identity === identity);
      if (same !== undefined) {
        batch.duplicateCount += 1;
        batch.rows.push({ outcome: 'duplicate', position, duplicateOf: 'TRANSACTION', transactionId: same.id });
        return;
      }
      const pending = [...items.values()].find((i) => i.mreRealmId === realm && i.sourceRowKey === identity);
      const colliding = [...transactions.values()].filter(
        (t) => t.mreRealmId === realm && t.bookingDate === row.bookingDate && t.amount.equals(amount) && t.direction === direction,
      );
      if (pending !== undefined || colliding.length > 0) {
        const item: Item = pending ?? {
          id: newId(),
          importBatchId: batch.id,
          mreRealmId: realm,
          financialAccountId: batch.financialAccountId,
          adapterId: batch.adapterId,
          adapterVersion: batch.adapterVersion,
          sourceStatementKey: `sha256:${batch.contentHash}`,
          sourceRowKey: identity,
          normalizedRow: {
            ...row,
            amount: amount.toJSON(),
            direction,
            externalTransactionId: null,
            balanceAfter: decimalOf(col(cells, 'Saldo nach Buchung')),
            position,
            statementKey: `sha256:${batch.contentHash}`,
            rowKey: `pos:${position}`,
          },
          ambiguityReason: 'AMBIGUOUS_CROSS_FILE_MATCH',
          conflictingTransactionIds: colliding.map((t) => t.id),
          priorReviewItemIds: [],
          status: 'PENDING',
          resolution: null,
          resolvedBy: null,
          resolvedAt: null,
          createdTransactionId: null,
          createdAt: NOW,
        };
        items.set(item.id, item);
        if (item.importBatchId === batch.id) batch.needsReviewCount += 1;
        batch.rows.push({
          outcome: 'needs_review',
          position,
          reviewItemId: item.id,
          importBatchId: item.importBatchId,
          reason: item.ambiguityReason,
          conflictingTransactionIds: item.conflictingTransactionIds,
        });
        return;
      }
      const created = tx({ mreRealmId: realm, ...row, amount, direction, importBatchId: batch.id, identity });
      batch.transactionCount += 1;
      batch.rows.push({ outcome: 'created', position, transactionId: created.id });
    });
    if (batch.needsReviewCount > 0) batch.status = 'NEEDS_REVIEW';
    batches.set(batch.id, batch);
    return json(201, real.batch(batch));
  };

  const conflictsOf = (item: Item) =>
    new Map(
      item.conflictingTransactionIds.flatMap((id) => {
        const t = transactions.get(id);
        return t === undefined ? [] : [[id, { ...t, externalTransactionId: null }] as const];
      }),
    );

  const resolve = (realm: string, batchId: string, itemId: string, body: unknown): Response => {
    const item = items.get(itemId);
    if (item === undefined || item.mreRealmId !== realm || item.importBatchId !== batchId) return notFound();
    if (!real.schemas.resolve.safeParse(body).success) return invalid();
    const { resolution } = body as { resolution: 'CREATE' | 'SKIP' };
    if (item.status === 'RESOLVED') {
      return item.resolution === resolution ? json(200, real.reviewItem(item, new Map())) : conflict('ALREADY_RESOLVED', { resolution: item.resolution });
    }
    const row = item.normalizedRow as { bookingDate: string; valueDate: string; amount: { amount: string }; direction: 'INFLOW' | 'OUTFLOW' } & Record<
      string,
      string
    >;
    if (resolution === 'CREATE') {
      const created = tx({
        mreRealmId: realm,
        amount: eur(row.amount.amount),
        direction: row.direction,
        bookingDate: row.bookingDate,
        valueDate: row.valueDate,
        description: row['description'] ?? null,
        counterpartyNameRaw: row['counterpartyNameRaw'] ?? null,
        counterpartyIbanRaw: row['counterpartyIbanRaw'] ?? null,
        importBatchId: item.importBatchId,
        identity: item.sourceRowKey,
      });
      item.createdTransactionId = created.id;
    }
    Object.assign(item, { status: 'RESOLVED', resolution, resolvedBy: EMAIL, resolvedAt: NOW });
    const batch = batches.get(item.importBatchId);
    if (batch !== undefined) {
      batch.needsReviewCount -= 1;
      if (batch.needsReviewCount === 0) batch.status = 'COMPLETED';
    }
    return json(200, real.reviewItem(item, new Map()));
  };

  /* ---------------------------------------------------------------- transactions (§30–§35) */

  const putSplits = (t: Tx, headers: Headers, body: unknown): Response => {
    const splits = (body as { splits?: unknown } | null)?.splits;
    if (!Array.isArray(splits) || splits.length === 0 || !splits.every((s) => real.schemas.split.safeParse(s).success)) return invalid('splits');
    const next: Split[] = (splits as { amount: { amount: string }; financialCategoryCode: string; propertyReferenceId?: string; description?: string }[]).map(
      (s, i) => ({
        id: newId(),
        position: i + 1,
        amount: eur(s.amount.amount),
        financialCategoryCode: s.financialCategoryCode,
        propertyReferenceId: s.propertyReferenceId ?? null,
        loanId: null,
        securityDepositId: null,
        wegAnnualStatementId: null,
        wegSpecialAssessmentId: null,
        description: s.description ?? null,
      }),
    );
    const sameSet = (a: readonly Split[]) =>
      a.length === next.length && a.every((s, i) => s.amount.equals(next[i]?.amount ?? eur('0')) && s.financialCategoryCode === next[i]?.financialCategoryCode);
    // The same set again is a 200 without a new version, whatever the version (§16.1 "Order").
    if (sameSet(t.splits)) return json(200, real.splits(t, t.splits), { etag: `"${t.version}"` });
    const version = ifMatchVersion(headers);
    if (version === undefined) return envelope(428, 'PRECONDITION_REQUIRED');
    if (version !== t.version) return envelope(412, 'VERSION_CONFLICT', { expectedVersions: [version], currentVersion: t.version });
    if (!['IMPORTED', 'UNREVIEWED', 'CLASSIFIED'].includes(t.status)) return conflict('NOT_SPLITTABLE', { status: t.status });
    if (
      !Money.sum(
        next.map((s) => s.amount),
        'EUR',
      ).equals(t.amount)
    )
      return envelope(422, 'SPLIT_SUM_MISMATCH');
    Object.assign(t, { splits: next, status: 'CLASSIFIED', version: t.version + 1 });
    return json(200, real.splits(t, t.splits), { etag: `"${t.version}"` });
  };

  const confirmTx = (t: Tx, headers: Headers): Response => {
    if (t.status === 'CONFIRMED') return json(200, real.transaction(t), { etag: `"${t.version}"` });
    const version = ifMatchVersion(headers);
    if (version !== t.version)
      return envelope(412, 'VERSION_CONFLICT', { expectedVersions: version === undefined ? [] : [version], currentVersion: t.version });
    if (t.status !== 'CLASSIFIED') return conflict('NOT_CONFIRMABLE', { status: t.status });
    Object.assign(t, { status: 'CONFIRMED', confirmedAt: NOW, confirmedBy: EMAIL, version: t.version + 1 });
    return json(200, real.transaction(t), { etag: `"${t.version}"` });
  };

  const correct = (t: Tx, headers: Headers, body: unknown): Response => {
    const key = headers.get('idempotency-key');
    if (key === null) return envelope(400, 'VALIDATION_ERROR', { fields: [{ field: 'Idempotency-Key', code: 'REQUIRED' }] });
    if (!real.schemas.correct.safeParse(body).success) return invalid();
    const fingerprint = `${t.id}:${JSON.stringify(body)}`;
    const stored = corrections.get(key);
    // §15: the same key and body answer the stored result again, without a second correction.
    if (stored !== undefined) {
      return stored.fingerprint === fingerprint ? json(201, stored.body, { 'idempotent-replayed': 'true' }) : envelope(422, 'IDEMPOTENCY_KEY_CONFLICT');
    }
    const version = ifMatchVersion(headers);
    if (version !== t.version)
      return envelope(412, 'VERSION_CONFLICT', { expectedVersions: version === undefined ? [] : [version], currentVersion: t.version });
    if (t.status === 'CORRECTED') {
      return conflict('ALREADY_CORRECTED', { reversalTransactionId: t.reversalTransactionId, replacementTransactionId: t.replacementTransactionId });
    }
    if (t.status !== 'CONFIRMED') return conflict('NOT_CORRECTABLE', { status: t.status });
    const reconciled = [...reconciliations.values()].filter((r) => r.transactionId === t.id && r.status === 'CONFIRMED').map((r) => r.id);
    if (reconciled.length > 0) return conflict('TRANSACTION_RENT_RECONCILED', { reconciliationIds: reconciled });
    const { replacement: changes } = body as { replacement: Partial<Pick<Tx, 'description'>> };
    const linked = { provenance: 'CORRECTION', status: 'CONFIRMED', version: 1, correctionOfTransactionId: t.id, confirmedAt: NOW, confirmedBy: EMAIL };
    const reversal = tx({
      ...t,
      ...linked,
      id: newId(),
      correctionRole: 'REVERSAL',
      direction: t.direction === 'INFLOW' ? 'OUTFLOW' : 'INFLOW',
      identity: null,
    });
    const replacement = tx({ ...t, ...linked, id: newId(), correctionRole: 'REPLACEMENT', ...changes, identity: null });
    Object.assign(t, { status: 'CORRECTED', version: t.version + 1, reversalTransactionId: reversal.id, replacementTransactionId: replacement.id });
    const answer = { original: real.transaction(t), reversal: real.transaction(reversal), replacement: real.transaction(replacement) };
    corrections.set(key, { fingerprint, body: answer });
    return json(201, answer);
  };

  /** `POST …/reverse` (§35.9): `correct` without a replacement; the same checks in the same order, `{ reason }` only. */
  const reverse = (t: Tx, headers: Headers, body: unknown): Response => {
    const key = headers.get('idempotency-key');
    if (key === null) return envelope(400, 'VALIDATION_ERROR', { fields: [{ field: 'Idempotency-Key', code: 'REQUIRED' }] });
    if (!real.schemas.reverse.safeParse(body).success) return invalid('reason');
    const fingerprint = `${t.id}:${(body as { reason: string }).reason.trim()}`;
    const stored = reversals.get(key);
    if (stored !== undefined) {
      return stored.fingerprint === fingerprint ? json(201, stored.body, { 'idempotent-replayed': 'true' }) : envelope(422, 'IDEMPOTENCY_KEY_CONFLICT');
    }
    const version = ifMatchVersion(headers);
    if (version !== t.version)
      return envelope(412, 'VERSION_CONFLICT', { expectedVersions: version === undefined ? [] : [version], currentVersion: t.version });
    if (t.status === 'CORRECTED') {
      return conflict('ALREADY_CORRECTED', { reversalTransactionId: t.reversalTransactionId, replacementTransactionId: t.replacementTransactionId });
    }
    if (t.status !== 'CONFIRMED' || t.correctionRole === 'REVERSAL') {
      return conflict('NOT_CORRECTABLE', { status: t.status, ...(t.correctionRole === 'REVERSAL' ? { correctionRole: 'REVERSAL' } : {}) });
    }
    const reconciled = [...reconciliations.values()].filter((r) => r.transactionId === t.id && r.status === 'CONFIRMED').map((r) => r.id);
    if (reconciled.length > 0) return conflict('TRANSACTION_RENT_RECONCILED', { reconciliationIds: reconciled });
    const linked = { provenance: 'CORRECTION', status: 'CONFIRMED', version: 1, correctionOfTransactionId: t.id, confirmedAt: NOW, confirmedBy: EMAIL };
    const direction = t.direction === 'INFLOW' ? 'OUTFLOW' : 'INFLOW';
    const reversal = tx({ ...t, ...linked, id: newId(), correctionRole: 'REVERSAL', direction, identity: null });
    Object.assign(t, { status: 'CORRECTED', version: t.version + 1, reversalTransactionId: reversal.id, replacementTransactionId: null });
    const answer = { original: real.transaction(t), reversal: real.transaction(reversal), replacement: null };
    reversals.set(key, { fingerprint, body: answer });
    return json(201, answer);
  };

  /* ---------------------------------------------------------------- rent reconciliation (§37): fake-rent.test-support.ts */

  const { rentCash, marker, suggest, newRec, recCommand, termCoverage, transactionRent, splitProposal, createMatch, termKey } = createRentFake({
    real,
    transactions,
    reconciliations,
    mreTerm,
    mreTerms,
    counters,
    state: () => backend,
  });

  /* ---------------------------------------------------------------- routing */

  const route = async (realm: string, method: string, path: string, search: URLSearchParams, headers: Headers, body: unknown, form: FormData | undefined) => {
    const parts = path.replace(/^\/api\/v1\//, '').split('/');
    const [head, id = '', sub, ...rest] = parts;
    const key = `${method} ${head ?? ''}${parts.length > 1 ? '/{id}' : ''}${sub === undefined ? '' : `/${sub}`}${rest.length > 0 ? '/…' : ''}`;
    switch (key) {
      case 'GET health':
        return json(200, { status: 'ok', mreRealmId: realm });
      case 'GET financial-accounts':
        return json(200, page(realm === REALM_A ? [account({ iban: ACCOUNT_IBAN })] : []));
      case 'GET property-references':
        return json(200, page(realm === REALM_A ? [property()] : [property({ mreRealmId: REALM_B, propertyReferenceId: newId(), displayName: 'Haus B' })]));
      case 'GET financial-categories':
        return json(200, { items: [category(), category({ code: 'RENT_OPERATING_COST_ADVANCE', name: 'Nebenkosten' })] });
      case 'GET transactions': {
        const statuses = search.get('status')?.split(',');
        const list = [...transactions.values()].filter((t) => t.mreRealmId === realm && (statuses === undefined || statuses.includes(t.status)));
        return json(200, page(list.map(real.transaction)));
      }
      case 'POST imports/{id}':
        return id === 'bank-transactions' ? importFile(realm, form) : notFound();
      case 'GET imports/{id}': {
        const batch = batches.get(id);
        return batch?.mreRealmId === realm ? json(200, real.batch(batch)) : notFound();
      }
      case 'GET imports/{id}/review-items': {
        const batch = batches.get(id);
        if (batch?.mreRealmId !== realm) return notFound();
        const own = [...items.values()].filter((i) => i.importBatchId === id);
        return json(200, { importBatchId: id, items: own.map((i) => real.reviewItem(i, conflictsOf(i))) });
      }
      case 'POST imports/{id}/review-items/…':
        return resolve(realm, id, rest[0] ?? '', body);
      case 'GET rent-reconciliations': {
        const status = search.get('status');
        const list = [...reconciliations.values()].filter((r) => r.mreRealmId === realm && (status === null || r.status === status));
        return json(200, page(list.map(real.reconciliation)));
      }
      case 'POST rent-reconciliations':
        return createMatch(realm, headers, body);
      case 'POST rent-reconciliations/{id}':
        return id === 'suggest' ? suggest(realm, body) : notFound();
      default:
        break;
    }
    if (method === 'GET' && head === 'rent-reconciliations' && id === 'split-proposal' && sub === undefined) return splitProposal(realm, search);
    if (method === 'GET' && head === 'rent-reconciliations' && id === 'terms') return termCoverage(realm, sub ?? '', rest[0] ?? '');
    if (head === 'transactions') {
      const t = of(realm, id);
      if (t === undefined) return notFound();
      if (method === 'GET' && sub === undefined) return detail(t);
      if (method === 'PUT' && sub === 'splits') return putSplits(t, headers, body);
      if (method === 'POST' && sub === 'confirm') return confirmTx(t, headers);
      if (method === 'POST' && sub === 'correct') return correct(t, headers, body);
      if (method === 'POST' && sub === 'reverse') return reverse(t, headers, body);
      if (method === 'GET' && sub === 'rent-reconciliations') return transactionRent(t);
    }
    if (head === 'rent-reconciliations') {
      const r = reconciliations.get(id);
      if (r?.mreRealmId !== realm) return notFound();
      if (method === 'GET' && sub === undefined) {
        // `checkMre` would call MRE; the cockpit never asks for it (§11), so the fake refuses it loudly.
        if (search.has('checkMre')) return envelope(400, 'VALIDATION_ERROR', { fields: [{ field: 'checkMre', code: 'NOT_EXPECTED' }] });
        return json(200, real.reconciliationRead({ reconciliation: r, mrePresence: null }), { etag: `"${r.version}"` });
      }
      if (method === 'POST' && sub !== undefined) return recCommand(r, sub, headers, body);
    }
    return notFound();
  };

  const fetch = async (input: string, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(input, 'https://cockpit.internal');
    const headers = new Headers(init.headers);
    const method = init.method ?? 'GET';
    const text = typeof init.body === 'string' ? init.body : undefined;
    const form = init.body instanceof FormData ? init.body : undefined;
    sent.push({ method, path: url.pathname, search: url.search, headers, body: text, form });
    const token = headers.get('authorization')?.replace(/^Bearer /, '') ?? '';
    if (!tokens.has(token) || backend.refuseAllTokens) return envelope(401, 'UNAUTHENTICATED');
    if (url.pathname === '/api/v2/realms') {
      return json(200, [
        { _id: REALM_A, name: 'Bestand Nord' },
        { _id: REALM_B, name: 'Bestand Süd' },
      ]);
    }
    if (!backend.guardUp) return envelope(503, 'EXTERNAL_SYSTEM_ERROR', undefined, { 'retry-after': '5' });
    const realm = headers.get('organizationid') ?? '';
    if (forbidden.has(realm)) return envelope(403, 'FORBIDDEN');
    const queue = faults.get(`${method} ${url.pathname}`);
    const fault = queue?.shift();
    if (fault !== undefined && 'answer' in fault) return fault.answer();
    const answer = await route(realm, method, url.pathname, url.searchParams, headers, text === undefined ? undefined : JSON.parse(text), form);
    if (fault !== undefined) throw new TypeError('Failed to fetch (the answer was lost)');
    return answer;
  };

  const mre: MreAuthenticator = {
    refresh: () => (backend.authenticatorUp ? Promise.resolve(cookie ? issue() : undefined) : unreachable()),
    signIn: () => {
      counters.signIns += 1;
      cookie = true;
      return Promise.resolve(issue());
    },
    signOut: () => {
      cookie = false;
      return Promise.resolve();
    },
  };

  const backend: Backend = {
    fetch,
    mre,
    sent,
    transactions,
    reconciliations,
    items,
    mreTerm,
    counters,
    forbidden,
    mreUp: true,
    suggestRule: 'ANY_AMOUNT',
    addMreTerm: (tenant, term, lease) => {
      const [rent, charges, adjustments] = [eur(lease.rent), eur(lease.charges), eur(lease.adjustments ?? '0.00')];
      mreTerms.set(termKey(tenant, term), { amountDue: rent.add(charges).add(adjustments), payments: [], rent, charges, adjustments });
    },
    seedInflow: (description, amount, bookingDate, confirmedRent = false) => {
      const t = tx({
        mreRealmId: REALM_A,
        amount: eur(amount),
        bookingDate,
        description,
        counterpartyNameRaw: 'Max Muster',
        counterpartyIbanRaw: 'DE00 0000 0000 0000 0000 05',
      });
      if (!confirmedRent) return t;
      const only = { id: newId(), position: 1, amount: eur(amount), financialCategoryCode: 'RENT_BASE', propertyReferenceId: null, description: null };
      t.splits = [{ ...only, loanId: null, securityDepositId: null, wegAnnualStatementId: null, wegSpecialAssessmentId: null }];
      Object.assign(t, { status: 'CONFIRMED', version: 3, confirmedAt: NOW, confirmedBy: EMAIL });
      return t;
    },
    guardUp: true,
    authenticatorUp: true,
    expireAccessTokens: () => tokens.clear(),
    refuseAllTokens: false,
    fault: (route, ...more) => faults.set(route, [...(faults.get(route) ?? []), ...more]),
    expireSession: () => {
      tokens.clear();
      cookie = false;
    },
    startForeignWriteBack: (recId) => {
      const r = reconciliations.get(recId);
      if (r === undefined) throw new Error(`no reconciliation ${recId}`);
      Object.assign(r, { mreWriteBackState: 'PENDING', mreWriteBackLeaseUntil: new Date(Date.now() + 120_000), version: r.version + 1 });
    },
    finishForeignWriteBack: (recId) => {
      const r = reconciliations.get(recId);
      if (r === undefined) throw new Error(`no reconciliation ${recId}`);
      counters.mreWrites += 1;
      const payment = { date: '01/10/2026', amount: r.matchedAmount, type: 'transfer', reference: marker(r) };
      mreTerm.payments.push(payment);
      Object.assign(r, { mreWriteBackState: 'WRITTEN', mreWriteBackLeaseUntil: null, mrePayment: payment, mreWrittenBackAt: NOW, version: r.version + 1 });
    },
    seedRent: (status, amount = '850.00') => {
      const t = tx({
        mreRealmId: REALM_A,
        amount: eur(amount),
        bookingDate: '2026-10-01',
        description: 'Miete Oktober Testwohnung',
        counterpartyNameRaw: 'Erika Beispiel',
        counterpartyIbanRaw: 'DE00 0000 0000 0000 0000 02',
        identity: `${CSV_NAME}:1`,
      });
      if (status === 'IMPORTED') return t;
      const parts: [string, string][] =
        amount === '850.00'
          ? [
              ['RENT_BASE', '700.00'],
              ['RENT_OPERATING_COST_ADVANCE', '150.00'],
            ]
          : [['RENT_BASE', amount]];
      t.splits = parts.map(([code, value], i) => ({
        id: newId(),
        position: i + 1,
        amount: eur(value),
        financialCategoryCode: code,
        propertyReferenceId: code === 'RENT_BASE' ? PROPERTY : null,
        loanId: null,
        securityDepositId: null,
        wegAnnualStatementId: null,
        wegSpecialAssessmentId: null,
        description: null,
      }));
      Object.assign(t, { status, version: status === 'CONFIRMED' ? 3 : 2, ...(status === 'CONFIRMED' ? { confirmedAt: NOW, confirmedBy: EMAIL } : {}) });
      return t;
    },
    seedReconciliation: (t, changes = {}) => newRec(t.mreRealmId, t, rentCash(t) ?? t.amount, changes),
    tx: (description) => {
      const found = [...transactions.values()].filter((t) => t.description === description && t.correctionRole === null);
      if (found.length !== 1 || found[0] === undefined) throw new Error(`${found.length} Transactions "${description}"`);
      return found[0];
    },
  };
  return backend;
}
