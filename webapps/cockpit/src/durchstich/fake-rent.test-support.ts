import { envelope, json } from '../api/fetch.test-support';
import { TENANT } from '../rent/fixtures.test-support';
import {
  conflict,
  EMAIL,
  ifMatchVersion,
  invalid,
  type MrePayment,
  newId,
  notFound,
  NOW,
  type Rec,
  RENT_CATEGORIES,
  TERM_OCT,
  type Tx,
} from './fake-model.test-support';
import type { Money, RealMappings } from './real-mappings.test-support';

/**
 * The rent reconciliation side of the Durchstich's fake backend (api-design.md §37), split from fake-backend.test-support.ts
 * to keep each file within its size limit. It answers through the backend's own DTO mappings and checks every body with
 * the route's own schema, as the rest of the fake does. Only synthetic Tenants, terms and amounts.
 *
 * MRE's side: the October term of the walk (`TENANT`, `TERM_OCT`) and any term a test adds (`addMreTerm`), each with its
 * lease values (rent and charges, §37.6), its amount due and MRE's payments. A term the fake does not know is "not
 * returned by MRE".
 *
 * The suggest run (§37.3) has two rules. `ANY_AMOUNT` is the walk's simplification kept from step 7: every counted rent
 * inflow of the window is suggested for the October term with its whole rent cash, whatever the amount. `EXACT` follows
 * §37.3 for the terms the fake knows: a pair fits when the inflow's free rent cash equals the term's open amount exactly
 * and its booking date lies from the 15th of the month before the term's month to the end of that month; a fit is
 * suggested only when neither its inflow nor its term has another fit or an open suggestion. The purpose-month, IBAN
 * history and in-order rules and the neighbouring months are not modelled; partial, collective and overpayments are left
 * alone, as the backend leaves them, for the manual match (§37.1).
 */

/** MRE's state of one term. */
export interface MreTermState {
  amountDue: Money;
  payments: MrePayment[];
  readonly rent: Money;
  readonly charges: Money;
  readonly adjustments: Money;
}

export interface RentContext {
  readonly real: RealMappings;
  readonly transactions: Map<string, Tx>;
  readonly reconciliations: Map<string, Rec>;
  /** The October term of the walk (`backend.mreTerm`), also in `mreTerms`. */
  readonly mreTerm: MreTermState;
  readonly mreTerms: Map<string, MreTermState>;
  readonly counters: { mreWrites: number };
  readonly state: () => { readonly mreUp: boolean; readonly suggestRule: 'ANY_AMOUNT' | 'EXACT' };
}

const lastDay = (ym: string) => {
  const [year = 0, month = 0] = ym.split('-').map(Number);
  return month === 2 ? (year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28) : [4, 6, 9, 11].includes(month) ? 30 : 31;
};
const monthBefore = (ym: string) => {
  const [year = 0, month = 0] = ym.split('-').map(Number);
  return month === 1 ? `${year - 1}-12` : `${year}-${String(month - 1).padStart(2, '0')}`;
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createRentFake(ctx: RentContext) {
  const { real, transactions, reconciliations, mreTerm, mreTerms, counters, state } = ctx;
  const { Money } = real;
  const eur = (amount: string) => Money.of(amount, 'EUR');
  const creates = new Map<string, { fingerprint: string; body: unknown }>();

  const rentCash = (t: Tx) => {
    const rent = t.splits.filter((s) => RENT_CATEGORIES.has(s.financialCategoryCode)).map((s) => s.amount);
    return rent.length === 0 ? null : Money.sum(rent, 'EUR');
  };
  const confirmedTotal = (recs: readonly Rec[]) =>
    Money.sum(
      recs.filter((r) => r.status === 'CONFIRMED').map((r) => r.matchedAmount),
      'EUR',
    );
  const sendRec = (r: Rec) => json(200, real.reconciliation(r), { etag: `"${r.version}"` });
  const marker = (r: Rec) => `DE-RPR-${r.id}`;
  const termKey = (tenant: string, term: string) => `${tenant}/${term}`;
  /** MRE's term of a reconciliation; the October term of the walk for any term the fake does not know (as before). */
  const termOf = (r: Pick<Rec, 'mreTenantId' | 'mreRentTerm'>) => mreTerms.get(termKey(r.mreTenantId, r.mreRentTerm)) ?? mreTerm;

  const suggest = (realm: string, body: unknown): Response => {
    if (!real.schemas.suggest.safeParse(body).success) return invalid('to');
    if (!state().mreUp) return envelope(503, 'EXTERNAL_SYSTEM_ERROR', undefined, { 'retry-after': '10' });
    const { from, to } = body as { from: string; to: string };
    const [year = 0, month = 0] = from.split('-').map(Number);
    const before = month === 1 ? `${year - 1}-12` : `${year}-${String(month - 1).padStart(2, '0')}`;
    const inWindow = (t: Tx) => t.mreRealmId === realm && t.direction === 'INFLOW' && t.bookingDate >= `${before}-15` && t.bookingDate <= `${to}-31`;
    const created: Rec[] = [];
    const skipped = { unconfirmed: 0, noRentCash: 0 };
    for (const t of transactions.values()) {
      if (!inWindow(t) || t.correctionRole !== null) continue;
      if (['IMPORTED', 'UNREVIEWED', 'CLASSIFIED'].includes(t.status)) skipped.unconfirmed += 1;
      if (t.status !== 'CONFIRMED') continue;
      const cash = rentCash(t);
      if (cash === null) {
        skipped.noRentCash += 1;
        continue;
      }
      if (state().suggestRule === 'EXACT') continue;
      if ([...reconciliations.values()].some((r) => r.transactionId === t.id && r.mreRentTerm === TERM_OCT)) continue;
      const r = newRec(realm, t, cash);
      created.push(r);
    }
    if (state().suggestRule === 'EXACT') created.push(...exactFits(realm, from, to));
    return json(200, real.suggest({ from, to, items: created, skipped }));
  };

  const newRec = (realm: string, t: Tx, cash: Money, changes: Partial<Rec> = {}): Rec => {
    const r: Rec = {
      id: newId(),
      mreRealmId: realm,
      status: 'SUGGESTED',
      transactionId: t.id,
      mreTenantId: TENANT,
      mreRentTerm: TERM_OCT,
      matchedAmount: cash,
      suggestedAmount: cash,
      confidence: 'HIGH',
      suggestionReason: 'EXACT_AMOUNT',
      confirmedAt: null,
      confirmedBy: null,
      releasedAt: null,
      releasedBy: null,
      releaseReason: null,
      rejectedAt: null,
      rejectedBy: null,
      rejectReason: null,
      notes: null,
      mreWriteBackState: 'NOT_WRITTEN',
      mreWriteBackLeaseUntil: null,
      mreWrittenBackAt: null,
      mreWrittenBackBy: null,
      mrePayment: null,
      mreWriteBackError: null,
      mreWriteBackFailedAt: null,
      mreLastLeaseUntil: null,
      mreRemovedAt: null,
      mreRemovedBy: null,
      createdAt: NOW,
      version: 1,
      ...changes,
    };
    reconciliations.set(r.id, r);
    return r;
  };

  const versionRefused = (r: Rec, headers: Headers, required: boolean): Response | undefined => {
    const version = ifMatchVersion(headers);
    if (version === undefined) return required ? envelope(428, 'PRECONDITION_REQUIRED') : undefined;
    return version === r.version ? undefined : envelope(412, 'VERSION_CONFLICT', { expectedVersions: [version], currentVersion: r.version });
  };

  const recCommand = (r: Rec, name: string, headers: Headers, body: unknown): Response => {
    const step = (changes: Partial<Rec>) => {
      Object.assign(r, changes, { version: r.version + 1 });
      return sendRec(r);
    };
    switch (name) {
      case 'confirm': {
        if (!real.schemas.confirm.safeParse(body ?? {}).success) return invalid('matchedAmount.amount');
        const amount = eur((body as { matchedAmount: { amount: string } }).matchedAmount.amount);
        if (r.status === 'CONFIRMED' && r.matchedAmount.equals(amount)) return sendRec(r);
        const refused = versionRefused(r, headers, true);
        if (refused !== undefined) return refused;
        if (r.status !== 'SUGGESTED') return conflict('NOT_CONFIRMABLE', { status: r.status });
        if (amount.compare(r.suggestedAmount) > 0) return envelope(422, 'VALIDATION_ERROR', { reason: 'ABOVE_SUGGESTION' });
        return step({ status: 'CONFIRMED', matchedAmount: amount, confirmedAt: NOW, confirmedBy: EMAIL });
      }
      case 'release': {
        if (!real.schemas.reason.safeParse(body).success) return invalid('reason');
        if (r.status === 'RELEASED') return sendRec(r);
        const refused = versionRefused(r, headers, true);
        if (refused !== undefined) return refused;
        if (r.status !== 'CONFIRMED') return conflict('NOT_RELEASABLE', { status: r.status });
        if (r.mreWriteBackState === 'PENDING') return conflict('WRITE_BACK_IN_PROGRESS', { reconciliationId: r.id });
        const state = r.mreWriteBackState === 'NOT_WRITTEN' ? 'NOT_WRITTEN' : 'REMOVAL_REQUIRED';
        const reason = (body as { reason: string }).reason;
        return step({ status: 'RELEASED', mreWriteBackState: state, releasedAt: NOW, releasedBy: EMAIL, releaseReason: reason });
      }
      case 'write-back-to-mre': {
        if (body !== undefined) return invalid();
        if (r.status !== 'CONFIRMED') return conflict('NOT_WRITABLE', { status: r.status });
        if (r.mreWriteBackState === 'WRITTEN') return sendRec(r);
        if (r.mreWriteBackState === 'PENDING') return conflict('WRITE_BACK_IN_PROGRESS', { reconciliationId: r.id });
        const refused = versionRefused(r, headers, false);
        if (refused !== undefined) return refused;
        if (!state().mreUp) {
          Object.assign(r, { mreWriteBackState: 'FAILED', mreWriteBackError: 'MRE_UNAVAILABLE', mreWriteBackFailedAt: NOW, version: r.version + 1 });
          return envelope(503, 'EXTERNAL_SYSTEM_ERROR', undefined, { 'retry-after': '1' });
        }
        counters.mreWrites += 1;
        const payment = { date: '01/10/2026', amount: r.matchedAmount, type: 'transfer', reference: marker(r) };
        termOf(r).payments.push(payment);
        return step({ mreWriteBackState: 'WRITTEN', mreWrittenBackAt: NOW, mreWrittenBackBy: EMAIL, mrePayment: payment, mreLastLeaseUntil: NOW });
      }
      case 'remove-from-mre': {
        if (body !== undefined) return invalid();
        if (r.mreWriteBackState === 'REMOVED') return sendRec(r);
        if (r.status !== 'RELEASED' || !['REMOVAL_REQUIRED', 'REMOVAL_FAILED'].includes(r.mreWriteBackState)) {
          return conflict('NOT_REMOVABLE', { status: r.status, mreWriteBackState: r.mreWriteBackState });
        }
        const refused = versionRefused(r, headers, false);
        if (refused !== undefined) return refused;
        if (!state().mreUp) {
          Object.assign(r, { mreWriteBackState: 'REMOVAL_FAILED', mreWriteBackError: 'MRE_UNAVAILABLE', version: r.version + 1 });
          return envelope(503, 'EXTERNAL_SYSTEM_ERROR');
        }
        counters.mreWrites += 1;
        const term = termOf(r);
        term.payments = term.payments.filter((p) => p.reference !== marker(r));
        return step({ mreWriteBackState: 'REMOVED', mreRemovedAt: NOW, mreRemovedBy: EMAIL });
      }
      default:
        return notFound();
    }
  };

  const termCoverage = (realm: string, tenant: string, term: string): Response => {
    const recs = [...reconciliations.values()].filter((r) => r.mreRealmId === realm && r.mreTenantId === tenant && r.mreRentTerm === term);
    const matchedTotal = confirmedTotal(recs);
    const known = mreTerms.get(termKey(tenant, term));
    if (!state().mreUp || known === undefined) {
      return json(
        200,
        real.term({
          mreTenantId: tenant,
          mreRentTerm: term,
          reconciliations: recs,
          matchedTotal,
          mreStatus: state().mreUp ? 'NOT_RETURNED' : 'UNAVAILABLE',
          mre: null,
          coverage: null,
          openAmount: null,
        }),
      );
    }
    const openAmount = known.amountDue.subtract(matchedTotal);
    const order = matchedTotal.compare(known.amountDue);
    const coverage = order > 0 ? 'OVERPAID' : order === 0 ? 'MATCHED' : matchedTotal.isZero() ? 'UNMATCHED' : 'PARTIALLY_MATCHED';
    return json(
      200,
      real.term({
        mreTenantId: tenant,
        mreRentTerm: term,
        reconciliations: recs,
        matchedTotal,
        mreStatus: 'AVAILABLE',
        mre: { amountDue: known.amountDue, payments: known.payments },
        coverage,
        openAmount,
      }),
    );
  };

  const transactionRent = (t: Tx): Response => {
    const recs = [...reconciliations.values()].filter((r) => r.transactionId === t.id);
    const counted = t.status === 'CONFIRMED' && t.correctionRole !== 'REVERSAL';
    const cash = rentCash(t);
    const matchedTotal = confirmedTotal(recs);
    const available = counted && cash !== null ? cash.subtract(matchedTotal) : null;
    return json(
      200,
      real.transactionRent({
        transactionId: t.id,
        status: t.status,
        direction: t.direction,
        correctionRole: t.correctionRole,
        counted,
        rentCash: cash,
        matchedTotal,
        available,
        reconciliations: recs,
      }),
    );
  };
  /** The free rent cash of a counted inflow (§37.1), or undefined when it does not count. */
  const available = (t: Tx): Money | undefined => {
    if (t.status !== 'CONFIRMED' || t.correctionRole === 'REVERSAL' || t.direction !== 'INFLOW') return undefined;
    const cash = rentCash(t);
    if (cash === null) return undefined;
    return cash.subtract(confirmedTotal([...reconciliations.values()].filter((r) => r.transactionId === t.id)));
  };

  /** §37.3 for the known terms, as described above. */
  const exactFits = (realm: string, from: string, to: string): Rec[] => {
    const terms = [...mreTerms.entries()]
      .map(([id, mre]) => {
        const [tenant = '', term = ''] = id.split('/');
        const ym = `${term.slice(0, 4)}-${term.slice(4, 6)}`;
        const matched = confirmedTotal(
          [...reconciliations.values()].filter((r) => r.mreRealmId === realm && r.mreTenantId === tenant && r.mreRentTerm === term),
        );
        return { tenant, term, ym, open: mre.amountDue.subtract(matched) };
      })
      .filter((t) => t.ym >= from && t.ym <= to && t.open.compare(Money.zero('EUR')) > 0);
    const openSuggestion = (txId: string | undefined, tenant: string | undefined, term: string | undefined) =>
      [...reconciliations.values()].some(
        (r) =>
          r.status === 'SUGGESTED' &&
          (txId === undefined || r.transactionId === txId) &&
          (tenant === undefined || (r.mreTenantId === tenant && r.mreRentTerm === term)),
      );
    const fits: { t: Tx; tenant: string; term: string; amount: Money }[] = [];
    for (const t of transactions.values()) {
      if (t.mreRealmId !== realm) continue;
      const free = available(t);
      if (free === undefined || free.isZero()) continue;
      for (const term of terms) {
        const inRange = t.bookingDate >= `${monthBefore(term.ym)}-15` && t.bookingDate <= `${term.ym}-${lastDay(term.ym)}`;
        const handled = [...reconciliations.values()].some((r) => r.transactionId === t.id && r.mreTenantId === term.tenant && r.mreRentTerm === term.term);
        if (inRange && !handled && free.equals(term.open)) fits.push({ t, tenant: term.tenant, term: term.term, amount: free });
      }
    }
    return fits
      .filter(
        (fit) =>
          fits.filter((other) => other.t.id === fit.t.id).length === 1 &&
          fits.filter((other) => other.tenant === fit.tenant && other.term === fit.term).length === 1 &&
          !openSuggestion(fit.t.id, undefined, undefined) &&
          !openSuggestion(undefined, fit.tenant, fit.term),
      )
      .sort((a, b) => (a.t.id < b.t.id ? -1 : 1))
      .map((fit) => newRec(realm, fit.t, fit.amount, { mreTenantId: fit.tenant, mreRentTerm: fit.term, confidence: 'MEDIUM' }));
  };

  const min = (a: Money, b: Money) => (a.compare(b) <= 0 ? a : b);

  /** `GET /rent-reconciliations/split-proposal` (§37.6): the refusals in their order, then the proposal of the lease values. */
  const splitProposal = (realm: string, search: URLSearchParams): Response => {
    const names = [...search.keys()];
    const transactionId = search.get('transactionId') ?? '';
    const tenant = search.get('mreTenantId') ?? '';
    const term = search.get('mreRentTerm') ?? '';
    if (names.some((n) => !['transactionId', 'mreTenantId', 'mreRentTerm'].includes(n))) return invalid(names[0] ?? '');
    if (!UUID.test(transactionId)) return invalid('transactionId');
    if (!/^[0-9a-f]{24}$/.test(tenant)) return invalid('mreTenantId');
    if (!/^\d{10}$/.test(term)) return invalid('mreRentTerm');
    const t = transactions.get(transactionId.toLowerCase());
    if (t?.mreRealmId !== realm) return envelope(404, 'NOT_FOUND', { transactionId });
    if (t.direction !== 'INFLOW' || !['IMPORTED', 'UNREVIEWED', 'CLASSIFIED'].includes(t.status)) {
      return conflict('NOT_PROPOSABLE', { direction: t.direction, status: t.status });
    }
    if (!state().mreUp) return envelope(503, 'EXTERNAL_SYSTEM_ERROR', undefined, { 'retry-after': '10' });
    const known = mreTerms.get(termKey(tenant, term));
    if (known === undefined) return envelope(422, 'MRE_RENT_TERM_NOT_FOUND', { mreTenantId: tenant, mreRentTerm: term });
    const base = min(known.rent, t.amount);
    const advance = min(known.charges, t.amount.subtract(base));
    const flags: { code: string; details?: Record<string, Money> }[] = [];
    if (!t.amount.equals(known.amountDue)) flags.push({ code: 'AMOUNT_DIFFERS_FROM_TERM', details: { difference: t.amount.subtract(known.amountDue) } });
    if (!known.adjustments.isZero()) flags.push({ code: 'TERM_HAS_ADJUSTMENTS', details: { adjustments: known.adjustments } });
    if (t.splits.length > 0) flags.push({ code: 'ALREADY_SPLIT' });
    return json(
      200,
      real.splitProposal({
        transactionId: t.id,
        mreTenantId: tenant,
        mreRentTerm: term,
        amount: t.amount,
        term: { rent: known.rent, charges: known.charges, adjustments: known.adjustments, due: known.amountDue },
        splits: [
          { financialCategoryCode: 'RENT_BASE', amount: base },
          { financialCategoryCode: 'RENT_OPERATING_COST_ADVANCE', amount: advance },
        ].filter((s) => !s.amount.isZero()),
        unallocated: t.amount.subtract(base).subtract(advance),
        flags,
      }),
    );
  };

  /** `POST /rent-reconciliations` (§37.1): the manual match, with the checks in their order and the intent's key (§15). */
  const createMatch = (realm: string, headers: Headers, body: unknown): Response => {
    if (!real.schemas.create.safeParse(body).success) return invalid();
    const input = body as { transactionId: string; mreTenantId: string; mreRentTerm: string; matchedAmount: { amount: string }; notes?: string | null };
    const key = headers.get('idempotency-key');
    const fingerprint = JSON.stringify(input);
    const stored = key === null ? undefined : creates.get(key);
    if (stored !== undefined) {
      return stored.fingerprint === fingerprint ? json(201, stored.body, { 'idempotent-replayed': 'true' }) : envelope(409, 'IDEMPOTENCY_KEY_CONFLICT');
    }
    const t = transactions.get(input.transactionId.toLowerCase());
    if (t?.mreRealmId !== realm) return envelope(404, 'NOT_FOUND', { transactionId: input.transactionId });
    if (t.status !== 'CONFIRMED' || t.correctionRole === 'REVERSAL')
      return conflict('TRANSACTION_NOT_COUNTED', { status: t.status, correctionRole: t.correctionRole });
    if (t.direction !== 'INFLOW') return envelope(422, 'TRANSACTION_NOT_INFLOW');
    const cash = rentCash(t);
    if (cash === null) return envelope(422, 'NO_RENT_CASH');
    const same = [...reconciliations.values()].find(
      (r) => r.transactionId === t.id && r.status === 'CONFIRMED' && r.mreTenantId === input.mreTenantId && r.mreRentTerm === input.mreRentTerm,
    );
    if (same !== undefined) return conflict('ALREADY_MATCHED', { reconciliationId: same.id });
    const amount = Money.of(input.matchedAmount.amount, 'EUR');
    const free = available(t) ?? cash;
    if (amount.compare(free) > 0) return conflict('RENT_CASH_EXCEEDED', { rentCash: cash.toJSON(), available: free.toJSON() });
    if (!state().mreUp) return envelope(503, 'EXTERNAL_SYSTEM_ERROR', undefined, { 'retry-after': '10' });
    if (!mreTerms.has(termKey(input.mreTenantId, input.mreRentTerm))) {
      return envelope(422, 'MRE_RENT_TERM_NOT_FOUND', { mreTenantId: input.mreTenantId, mreRentTerm: input.mreRentTerm });
    }
    const r = newRec(realm, t, amount, {
      status: 'CONFIRMED',
      mreTenantId: input.mreTenantId,
      mreRentTerm: input.mreRentTerm,
      confidence: null,
      suggestionReason: null,
      confirmedAt: NOW,
      confirmedBy: EMAIL,
      notes: input.notes ?? null,
    });
    const answer = real.reconciliation(r);
    if (key !== null) creates.set(key, { fingerprint, body: answer });
    return json(201, answer, { etag: `"${r.version}"` });
  };

  return { rentCash, marker, suggest, newRec, recCommand, termCoverage, transactionRent, splitProposal, createMatch, termKey };
}
