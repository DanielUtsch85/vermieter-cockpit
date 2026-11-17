import { beforeAll, describe, expect, it } from 'vitest';
import type { TransactionFilter } from '../../domains/ledger/index.js';
import { isCounted, rentAllocationOf, RENT_ALLOCATION_STATES, type RentAllocationState } from '../../domains/rent-reconciliation/index.js';
import { createDatabase } from './database.js';
import { PostgresPropertyReferenceRepository } from './property-reference-repository.js';
import { OTHER_REALM, REALM, actor, databaseUrl, eur, split, useRentReconciliationDatabase } from './rent-reconciliation.test-support.js';
import { PostgresTransactionQueries } from './transaction-query-repository.js';

/**
 * §30.1A (VC-X-81): the rent sums of the Transaction list, read for the page in its snapshot, and the filter
 * `rentAllocation` in `filtered`. Each test books in its own month, so a booking-date range keeps it to its rows.
 */

type Rows = Awaited<ReturnType<PostgresTransactionQueries['list']>>;
/** Each item's state by the rule of §30.1A, as the list use case applies it; `null` when nothing to allocate. */
const statesOf = (page: Rows) =>
  Object.fromEntries(
    page.items.map((t) => {
      const sums = page.rentSums.get(t.id);
      if (sums === undefined) throw new Error(`no sums for ${t.id}`);
      const allocation = rentAllocationOf({ counted: isCounted(t.status, t.correctionRole), direction: t.direction, ...sums });
      return [
        t.id,
        allocation === null ? null : `${allocation.state} ${allocation.rentAmount.amount}/${allocation.allocatedAmount.amount}/${allocation.freeAmount.amount}`,
      ];
    }),
  );
const month = (m: string) => ({ bookingDateFrom: `${m}-01`, bookingDateTo: `${m}-28` }) as unknown as TransactionFilter;
const all = { page: 1, pageSize: 200 };

describe.skipIf(databaseUrl === undefined)('the list s rent allocation (api-design.md §30.1A)', () => {
  const { ctx, transaction, match, created, rawInsert } = useRentReconciliationDatabase('transaction_rent_allocation_test');
  let queries: PostgresTransactionQueries;
  let properties: PostgresPropertyReferenceRepository;
  beforeAll(() => {
    const db = createDatabase(ctx.pool);
    queries = new PostgresTransactionQueries(db);
    properties = new PostgresPropertyReferenceRepository(db);
  });
  const on = (date: string) => ({ bookingDate: date });

  it('a mixed page: rent and non-rent, several matches on one Transaction, one over two terms; SUGGESTED, REJECTED, RELEASED never summed', async () => {
    const none = await transaction([split('850.00')], on('2030-01-02'));
    const partial = await transaction([split('700.00'), split('150.00', 'RENT_OPERATING_COST_ADVANCE'), split('20.00', 'BANK_FEES')], on('2030-01-03'));
    await created(match(partial, '400.00', '2030010100'));
    await created(match(partial, '200.00', '2030020100'));
    const full = await transaction([split('850.00')], on('2030-01-04'));
    await created(match(full, '425.00', '2030010100'));
    await created(match(full, '425.00', '2030020100', '6512f0c2a1b2c3d4e5f60a02'));
    const notRent = await transaction([split('850.00', 'INSURANCE')], on('2030-01-05'));
    const unconfirmed = await transaction([split('850.00')], { ...on('2030-01-06'), confirm: false });
    const outflow = await transaction([split('850.00')], { ...on('2030-01-07'), direction: 'OUTFLOW' });
    const others = await transaction([split('850.00')], on('2030-01-08'));
    await ctx.pool.query(rawInsert(others, '300.00', '2030010100', 'SUGGESTED'));
    const { rows } = await ctx.pool.query(`${rawInsert(others, '100.00', '2030020100', 'SUGGESTED')} RETURNING id`);
    expect((await ctx.repository.reject(rows[0].id as string, REALM, 'falsch', new Date(), actor)).kind).toBe('REJECTED');
    const released = await created(match(others, '200.00', '2030030100'));
    expect((await ctx.repository.release(released.id, REALM, 'Irrtum', new Date(), actor)).kind).toBe('RELEASED');

    const page = await queries.list(REALM, month('2030-01'), all);
    expect(page.items).toHaveLength(7);
    expect(statesOf(page)).toEqual({
      [none]: 'NONE 850.00/0.00/850.00',
      [partial]: 'PARTIAL 850.00/600.00/250.00',
      [full]: 'FULL 850.00/850.00/0.00',
      [notRent]: null,
      [unconfirmed]: null,
      [outflow]: null,
      [others]: 'NONE 850.00/0.00/850.00',
    });
    // The raw sums: no rent split is `null`, an OUTFLOW and an unconfirmed one still have theirs (the rule makes them null).
    expect(page.rentSums.get(notRent)).toEqual({ rentCash: null, matchedTotal: eur('0.00') });
    expect(page.rentSums.get(outflow)).toEqual({ rentCash: eur('850.00'), matchedTotal: eur('0.00') });
    expect(page.rentSums.get(unconfirmed)).toEqual({ rentCash: eur('850.00'), matchedTotal: eur('0.00') });
    expect([...page.rentSums.keys()].sort()).toEqual(page.items.map((t) => t.id).sort());
  });

  it('a release turns FULL into PARTIAL, then NONE', async () => {
    const t = await transaction([split('800.00')], on('2030-02-02'));
    const a = await created(match(t, '500.00', '2030010100'));
    const b = await created(match(t, '300.00', '2030020100'));
    const state = async () => statesOf(await queries.list(REALM, month('2030-02'), all))[t];
    expect(await state()).toBe('FULL 800.00/800.00/0.00');
    await ctx.repository.release(b.id, REALM, 'x', new Date(), actor);
    expect(await state()).toBe('PARTIAL 800.00/500.00/300.00');
    await ctx.repository.release(a.id, REALM, 'x', new Date(), actor);
    expect(await state()).toBe('NONE 800.00/0.00/800.00');
  });

  it('a correction: the CORRECTED original and its reversal are null, the replacement starts at NONE', async () => {
    const original = await transaction([split('800.00')], on('2030-03-02'));
    const corrected = await ctx.corrections.correct(original, REALM, { reason: 'Betrag', replacement: { description: 'neu' } }, actor);
    if (corrected.kind !== 'CORRECTED' || corrected.result.replacement === null) throw new Error(JSON.stringify(corrected));
    const states = statesOf(await queries.list(REALM, month('2030-03'), all));
    expect(states).toEqual({
      [original]: null,
      [corrected.result.reversal.id]: null,
      [corrected.result.replacement.id]: 'NONE 800.00/0.00/800.00',
    });
  });

  it('the PropertyReference s list shows the whole Transaction s rent share, also of a split of another PropertyReference', async () => {
    const link = async (mrePropertyId: string) =>
      (
        await properties.linkOnce(
          { mreRealmId: REALM, mrePropertyId, displayName: null, cachedAddress: null, cachedSurface: null, refreshedAt: new Date() },
          actor,
        )
      ).reference.id;
    const [mine, other] = [await link('64b0c0ffee00000000000e81'), await link('64b0c0ffee00000000000e82')];
    const t = await transaction(
      [
        { ...split('500.00'), propertyReferenceId: mine },
        { ...split('300.00'), propertyReferenceId: other },
      ],
      on('2030-04-02'),
    );
    await created(match(t, '600.00'));
    const page = await queries.list(REALM, { ...month('2030-04'), propertyReferenceId: mine }, all);
    expect(statesOf(page)).toEqual({ [t]: 'PARTIAL 800.00/600.00/200.00' });
    // The filter, too, reads the whole Transaction's rent share under propertyReferenceId and financialCategoryCode.
    expect((await queries.list(REALM, { ...month('2030-04'), propertyReferenceId: other, rentAllocation: ['PARTIAL'] }, all)).total).toBe(1);
    expect((await queries.list(REALM, { ...month('2030-04'), financialCategoryCode: 'RENT_BASE', rentAllocation: ['FULL'] }, all)).total).toBe(0);
  });

  describe('the filter', () => {
    const ids: Record<string, string> = {};
    beforeAll(async () => {
      ids['none'] = await transaction([split('850.00')], on('2030-05-02'));
      ids['partial'] = await transaction([split('850.00')], on('2030-05-03'));
      await created(match(ids['partial'], '0.01'));
      ids['almost'] = await transaction([split('850.00')], on('2030-05-04'));
      await created(match(ids['almost'], '849.99'));
      ids['full'] = await transaction([split('850.00')], on('2030-05-05'));
      await created(match(ids['full'], '850.00'));
      ids['notRent'] = await transaction([split('850.00', 'INSURANCE')], on('2030-05-06'));
      ids['unconfirmed'] = await transaction([split('850.00')], { ...on('2030-05-07'), confirm: false });
      ids['outflow'] = await transaction([split('850.00')], { ...on('2030-05-08'), direction: 'OUTFLOW' });
      const reversed = await transaction([split('850.00')], on('2030-05-09'));
      const outcome = await ctx.corrections.correct(reversed, REALM, { reason: 'Doppelt', replacement: null }, actor);
      if (outcome.kind !== 'CORRECTED') throw new Error(outcome.kind);
      ids['corrected'] = reversed;
      ids['reversal'] = outcome.result.reversal.id;
      // A reversal that is an INFLOW with a rent split (of a repaid rent): counted status, INFLOW, rent share, but a reversal.
      const repaid = await transaction([split('850.00')], { ...on('2030-05-10'), direction: 'OUTFLOW' });
      const back = await ctx.corrections.correct(repaid, REALM, { reason: 'Doppelt', replacement: null }, actor);
      if (back.kind !== 'CORRECTED') throw new Error(back.kind);
      ids['repaid'] = repaid;
      ids['inflowReversal'] = back.result.reversal.id;
    });
    const name = (id: string) => Object.entries(ids).find(([, v]) => v === id)?.[0];
    const listed = async (filter: TransactionFilter) => {
      const page = await queries.list(REALM, { ...month('2030-05'), ...filter }, all);
      expect(page.total).toBe(page.items.length);
      return page.items.map((t) => name(t.id)).sort();
    };

    it('each state, and „Mietanteil noch frei“ = NONE,PARTIAL; a Transaction whose field is null never matches', async () => {
      expect(await listed({ rentAllocation: ['NONE'] })).toEqual(['none']);
      expect(await listed({ rentAllocation: ['PARTIAL'] })).toEqual(['almost', 'partial']);
      expect(await listed({ rentAllocation: ['FULL'] })).toEqual(['full']);
      expect(await listed({ rentAllocation: ['NONE', 'PARTIAL'] })).toEqual(['almost', 'none', 'partial']);
      expect(await listed({ rentAllocation: ['NONE', 'PARTIAL', 'FULL'] })).toEqual(['almost', 'full', 'none', 'partial']);
      expect(await listed({ rentAllocation: [] })).toEqual([]);
    });

    it('agrees with the field for every row and every set of states', async () => {
      const page = await queries.list(REALM, month('2030-05'), all);
      const field = statesOf(page);
      const subsets = [[], ...RENT_ALLOCATION_STATES.map((s) => [s]), ['NONE', 'PARTIAL'], ['NONE', 'FULL'], ['PARTIAL', 'FULL'], [...RENT_ALLOCATION_STATES]];
      for (const subset of subsets as RentAllocationState[][]) {
        const filteredIds = (await queries.list(REALM, { ...month('2030-05'), rentAllocation: subset }, all)).items.map((t) => t.id).sort();
        const fromField = Object.entries(field)
          .filter(([, v]) => v !== null && subset.includes(v.split(' ')[0] as RentAllocationState))
          .map(([id]) => id)
          .sort();
        expect(filteredIds, subset.join(',')).toEqual(fromField);
      }
    });

    it('AND with status, current, financialAccountId, propertyReferenceId and the booking dates', async () => {
      expect(await listed({ rentAllocation: ['NONE'], statuses: ['CONFIRMED'] })).toEqual(['none']);
      expect(await listed({ rentAllocation: ['NONE'], statuses: ['UNREVIEWED', 'CLASSIFIED'] })).toEqual([]);
      expect(await listed({ rentAllocation: ['NONE', 'PARTIAL'], current: true })).toEqual(['almost', 'none', 'partial']);
      expect(await listed({ rentAllocation: ['FULL'], financialAccountId: ctx.account })).toEqual(['full']);
      expect(await listed({ rentAllocation: ['FULL'], financialAccountId: ctx.otherAccount })).toEqual([]);
      expect(await listed({ rentAllocation: ['NONE'], propertyReferenceId: '00000000-0000-4000-8000-000000000000' })).toEqual([]);
      expect(
        (
          await queries.list(
            REALM,
            { rentAllocation: ['NONE', 'PARTIAL'], bookingDateFrom: '2030-05-03', bookingDateTo: '2030-05-04' } as unknown as TransactionFilter,
            all,
          )
        ).items
          .map((t) => name(t.id))
          .sort(),
      ).toEqual(['almost', 'partial']);
    });

    it('total and items agree over two pages', async () => {
      const filter: TransactionFilter = { ...month('2030-05'), rentAllocation: ['NONE', 'PARTIAL', 'FULL'] };
      const [first, second] = [await queries.list(REALM, filter, { page: 1, pageSize: 3 }), await queries.list(REALM, filter, { page: 2, pageSize: 3 })];
      expect([first.total, second.total]).toEqual([4, 4]);
      expect([first.items.length, second.items.length]).toEqual([3, 1]);
      expect(new Set([...first.items, ...second.items].map((t) => name(t.id)))).toEqual(new Set(['none', 'partial', 'almost', 'full']));
      // Newest booking first, as without the filter.
      expect(first.items.map((t) => name(t.id))).toEqual(['full', 'almost', 'partial']);
    });

    it('another Realm: its request with this Realm s filter is an empty page', async () => {
      expect((await queries.list(OTHER_REALM, { ...month('2030-05'), rentAllocation: ['NONE', 'PARTIAL', 'FULL'] }, all)).total).toBe(0);
    });
  });

  it('the sums are read in the list s snapshot: a match committed after the count is not in this page, it is in the next read', async () => {
    const t = await transaction([split('800.00')], on('2030-08-02'));
    // A pool whose client, before it sends the page aggregate, lets another connection commit a match of the Transaction.
    let hook: (() => Promise<unknown>) | undefined = () => created(match(t, '300.00'));
    const pool = {
      connect: async () => {
        const client = await ctx.pool.connect();
        return new Proxy(client, {
          get(target, key, receiver) {
            if (key !== 'query') return Reflect.get(target, key, receiver) as unknown;
            return async (...args: Parameters<typeof target.query>) => {
              const next = hook;
              if (typeof args[0] === 'string' && args[0].includes('CROSS JOIN LATERAL') && next !== undefined) {
                hook = undefined;
                await next();
              }
              return (target.query as (...a: unknown[]) => unknown)(...args);
            };
          },
        });
      },
      end: async () => undefined,
    };
    const snapshotQueries = new PostgresTransactionQueries(createDatabase(pool as unknown as typeof ctx.pool));
    const filter = { ...month('2030-08'), rentAllocation: ['NONE'] } as TransactionFilter;
    const page = await snapshotQueries.list(REALM, filter, all);
    expect(hook).toBeUndefined();
    expect(page.total).toBe(1);
    expect(statesOf(page)).toEqual({ [t]: 'NONE 800.00/0.00/800.00' });
    // Counter-check: the match is committed, and the next read sees it.
    expect(statesOf(await queries.list(REALM, month('2030-08'), all))).toEqual({ [t]: 'PARTIAL 800.00/300.00/500.00' });
    expect((await queries.list(REALM, filter, all)).total).toBe(0);
  });

  it('a list read writes nothing: no AuditRecord, no version', async () => {
    const t = await transaction([split('800.00')], on('2030-06-02'));
    await created(match(t, '100.00'));
    const snapshot = async () =>
      (
        await ctx.pool.query(
          `SELECT (SELECT count(*) FROM audit_record) AS audits, (SELECT sum(version) FROM ledger_transaction) AS versions,
             (SELECT sum(version) FROM rent_payment_reconciliation) AS matches`,
        )
      ).rows[0];
    const before = await snapshot();
    await queries.list(REALM, { ...month('2030-06'), rentAllocation: ['PARTIAL'] }, all);
    await queries.list(REALM, month('2030-06'), all);
    expect(await snapshot()).toEqual(before);
  });
});

describe.skipIf(databaseUrl === undefined)('the list s rent allocation: another Realm s rows on a colliding id never count (§30.1A)', () => {
  const { ctx, transaction, match, created } = useRentReconciliationDatabase('transaction_rent_allocation_realm_test');

  it('Realm B s splits and CONFIRMED reconciliations naming Realm A s Transaction are in neither sum nor the filter', async () => {
    const queries = new PostgresTransactionQueries(createDatabase(ctx.pool));
    const t = await transaction([split('800.00')], { bookingDate: '2030-07-02' });
    await created(match(t, '300.00'));
    // Only possible with the composite foreign keys (0008, 0030) and the guards out of the way: this schema is the test's own.
    await ctx.pool.query(`ALTER TABLE transaction_split DROP CONSTRAINT transaction_split_transaction_fk`);
    await ctx.pool.query(`ALTER TABLE transaction_split DISABLE TRIGGER USER`);
    await ctx.pool.query(`ALTER TABLE rent_payment_reconciliation DROP CONSTRAINT rent_payment_reconciliation_transaction_fk`);
    await ctx.pool.query(`ALTER TABLE rent_payment_reconciliation DISABLE TRIGGER USER`);
    await ctx.pool.query(
      `INSERT INTO transaction_split (transaction_id, mre_realm_id, position, amount, currency, financial_category_id, created_by)
       SELECT $1, $2, 9, 1000, 'EUR', c.id, 'x' FROM financial_category c WHERE c.code = 'RENT_BASE'`,
      [t, OTHER_REALM],
    );
    await ctx.pool.query(
      `INSERT INTO rent_payment_reconciliation (mre_realm_id, status, transaction_id, mre_tenant_id, mre_rent_term, matched_amount, currency, confirmed_at, confirmed_by, created_by)
       VALUES ($1, 'CONFIRMED', $2, '6512f0c2a1b2c3d4e5f60a09', '2030070100', 500, 'EUR', now(), 'x', 'x')`,
      [OTHER_REALM, t],
    );
    const filter = { bookingDateFrom: '2030-07-01', bookingDateTo: '2030-07-28' } as unknown as TransactionFilter;
    const page = await queries.list(REALM, filter, { page: 1, pageSize: 50 });
    expect(page.rentSums.get(t)).toEqual({ rentCash: eur('800.00'), matchedTotal: eur('300.00') });
    expect((await queries.list(REALM, { ...filter, rentAllocation: ['PARTIAL'] }, { page: 1, pageSize: 50 })).total).toBe(1);
    expect((await queries.list(REALM, { ...filter, rentAllocation: ['FULL'] }, { page: 1, pageSize: 50 })).total).toBe(0);
    expect((await queries.list(OTHER_REALM, { ...filter, rentAllocation: ['NONE', 'PARTIAL', 'FULL'] }, { page: 1, pageSize: 50 })).total).toBe(0);
  });
});
