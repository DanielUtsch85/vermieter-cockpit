import { describe, expect, it } from 'vitest';
import { OTHER_REALM, REALM, databaseUrl, messageOf, useClassificationDatabase, type Queryable } from './acquisition-cost-classification.test-support.js';

/**
 * Migration 0054 past the repository (api-design.md §59D "Concurrency and the database"), each CHECK, key and guard with a
 * counter-check that the valid variant is accepted: the parts summing at commit and none missing; one current
 * classification per cost; the chain (no supersede without a successor, no successor of a current row, one successor);
 * the data frozen and never deleted, superseded final; a part only from its classification's own transaction, never
 * changed or deleted; a `FINANCING_RELATED` cost with `FINANCING` parts only; no insert for a `VOID` cost or a
 * `CANCELLED` Acquisition; the value CHECKs; the composite keys. Synthetic data.
 */
describe.skipIf(databaseUrl === undefined)('migration 0054 past the repository (§59D)', () => {
  const ctx = useClassificationDatabase('cost_classification_schema_test');
  const transfer = (amount: string) => [['OWNERSHIP_TRANSFER', amount]] as const;
  /** One raw classification in a transaction of its own; the message it fails with, or `accepted`. */
  const classify = (acquisitionId: string, costId: string, parts: readonly (readonly [string, string])[], set: Record<string, unknown> = {}) =>
    messageOf(ctx.inTransaction((c) => ctx.rawClassify(c, acquisitionId, costId, parts, set)));
  const fixture = async (category = 'NOTARY', amount = '2000.00') => {
    const a = await ctx.acquisition();
    return { a, cost: await ctx.cost(a, category, amount) };
  };
  const supersede = (c: Queryable, a: string, cost: string, oldId: string, parts: readonly (readonly [string, string])[]) =>
    c
      .query(`UPDATE acquisition_cost_classification SET superseded_at = now() WHERE id = $1`, [oldId])
      .then(() => ctx.rawClassify(c, a, cost, parts, { supersedes_id: oldId }));

  it('the parts sum exactly to the cost’s amount at commit; a classification without parts is refused (PARTS_SUM_MISMATCH)', async () => {
    const { a, cost } = await fixture();
    expect(await classify(a, cost, transfer('1999.99'))).toMatch(/PARTS_SUM_MISMATCH/);
    expect(await classify(a, cost, [...transfer('1000.00'), ['FINANCING', '1000.01']])).toMatch(/PARTS_SUM_MISMATCH/);
    expect(await classify(a, cost, [])).toMatch(/PARTS_SUM_MISMATCH/);
    // At commit: inside the transaction the parts may follow the row (deferred), and a later one still counts.
    expect(await classify(a, cost, [...transfer('1500.00'), ['FINANCING', '500.00']])).toBe('accepted');
  });

  it('a FINANCING_RELATED cost takes FINANCING parts only (PURPOSE_NOT_ALLOWED, question 24)', async () => {
    const { a, cost } = await fixture('FINANCING_RELATED', '900.00');
    expect(
      await classify(a, cost, [
        ['FINANCING', '400.00'],
        ['OWNERSHIP_TRANSFER', '500.00'],
      ]),
    ).toMatch(/PURPOSE_NOT_ALLOWED/);
    expect(await classify(a, cost, [['NOT_ACQUISITION_COST', '900.00']])).toMatch(/PURPOSE_NOT_ALLOWED/);
    expect(
      await classify(a, cost, [
        ['FINANCING', '400.00'],
        ['FINANCING', '500.00'],
      ]),
    ).toBe('accepted');
    // Counter-check: another category takes any purpose.
    const other = await fixture('OTHER', '900.00');
    expect(await classify(other.a, other.cost, [['NOT_ACQUISITION_COST', '900.00']])).toBe('accepted');
  });

  it('at most one current classification per cost; inserted only current; created_txid never given', async () => {
    const { a, cost } = await fixture();
    expect(await classify(a, cost, transfer('2000.00'))).toBe('accepted');
    expect(await classify(a, cost, transfer('2000.00'))).toMatch(/acquisition_cost_classification_current/);
    const second = await fixture();
    expect(await classify(second.a, second.cost, transfer('2000.00'), { superseded_at: new Date().toISOString() })).toMatch(/only inserted current/);
    expect(await classify(second.a, second.cost, transfer('2000.00'), { created_txid: 1 })).toMatch(/created_txid is the inserting transaction/);
    // Counter-check: another cost of the same Acquisition has its own current one.
    expect(await classify(a, await ctx.cost(a, 'LAND_REGISTRY', '2000.00'), transfer('2000.00'))).toBe('accepted');
  });

  it('the chain: no supersede without a successor (at commit), none of a current row, one successor, never across costs', async () => {
    const { a, cost } = await fixture();
    const first = await ctx.inTransaction((c) => ctx.rawClassify(c, a, cost, transfer('2000.00')));
    expect(
      await messageOf(ctx.inTransaction((c) => c.query(`UPDATE acquisition_cost_classification SET superseded_at = now() WHERE id = $1`, [first]))),
    ).toMatch(/superseded without a successor/);
    // A successor naming a current row: the current index refuses it at once.
    expect(await classify(a, cost, transfer('2000.00'), { supersedes_id: first })).toMatch(/acquisition_cost_classification_current/);
    // A successor of another cost (the composite key binds the chain to the cost).
    const other = await ctx.cost(a, 'NOTARY', '2000.00');
    expect(
      await messageOf(
        ctx.inTransaction(async (c) => {
          await c.query(`UPDATE acquisition_cost_classification SET superseded_at = now() WHERE id = $1`, [first]);
          return ctx.rawClassify(c, a, other, transfer('2000.00'), { supersedes_id: first });
        }),
      ),
    ).toMatch(/acquisition_cost_classification_supersedes_fk/);
    // Counter-check: a supersede of the same cost in one transaction.
    const second = await ctx.inTransaction((c) => supersede(c, a, cost, first, transfer('2000.00')));
    // One successor at most.
    expect(
      await messageOf(
        ctx.inTransaction(async (c) => {
          await c.query(`UPDATE acquisition_cost_classification SET superseded_at = now() WHERE id = $1`, [second]);
          return ctx.rawClassify(c, a, cost, transfer('2000.00'), { supersedes_id: first });
        }),
      ),
    ).toMatch(/acquisition_cost_classification_supersedes_key|superseded is final/);
  });

  it('the deferred chain check behind the current index: a successor naming a row still current is refused (the index dropped for the probe only)', async () => {
    const { a, cost } = await fixture();
    const first = await ctx.inTransaction((c) => ctx.rawClassify(c, a, cost, transfer('2000.00')));
    // DDL is transactional: every probe rolls the dropped index back with its rows. The deferred trigger is run at once
    // by SET CONSTRAINTS ... IMMEDIATE, so the probe never needs to commit.
    const probe = (supersede: boolean) =>
      messageOf(
        ctx.inTransaction(async (c) => {
          await c.query(`DROP INDEX acquisition_cost_classification_current`);
          if (supersede) await c.query(`UPDATE acquisition_cost_classification SET superseded_at = now() WHERE id = $1`, [first]);
          await ctx.rawClassify(c, a, cost, transfer('2000.00'), { supersedes_id: first });
          await c.query(`SET CONSTRAINTS acquisition_cost_classification_chain IMMEDIATE`);
          throw new Error('rolled back on purpose');
        }),
      );
    expect(await probe(false)).toMatch(/supersedes .* which is still current/);
    // Counter-check: superseded first, the same steps pass the chain.
    expect(await probe(true)).toBe('rolled back on purpose');
    const index = await ctx.pool.query(
      `SELECT count(*)::int AS n FROM pg_indexes WHERE schemaname = current_schema() AND indexname = 'acquisition_cost_classification_current'`,
    );
    expect(index.rows[0].n).toBe(1);
  });

  it('data frozen and never deleted; superseded is final; only superseded_at changes, once', async () => {
    const { a, cost } = await fixture();
    const first = await ctx.inTransaction((c) => ctx.rawClassify(c, a, cost, transfer('2000.00'), { review_state: 'UNREVIEWED' }));
    for (const change of [`review_state = 'CONFIRMED'`, `description = 'anders'`, `notes = 'nachgetragen'`, `created_by = 'y'`, `source_references = '{x}'`]) {
      expect(await messageOf(ctx.pool.query(`UPDATE acquisition_cost_classification SET ${change} WHERE id = $1`, [first])), change).toMatch(/never changes/);
    }
    expect(await messageOf(ctx.pool.query(`DELETE FROM acquisition_cost_classification WHERE id = $1`, [first]))).toMatch(/never deleted/);
    // Counter-check: superseding (only superseded_at) is accepted; then it is final.
    await ctx.inTransaction((c) => supersede(c, a, cost, first, transfer('2000.00')));
    expect(await messageOf(ctx.pool.query(`UPDATE acquisition_cost_classification SET superseded_at = NULL WHERE id = $1`, [first]))).toMatch(
      /superseded is final/,
    );
    expect(await messageOf(ctx.pool.query(`UPDATE acquisition_cost_classification SET superseded_at = now() WHERE id = $1`, [first]))).toMatch(
      /superseded is final/,
    );
  });

  it('a part only from its classification’s own transaction (never added later), never changed or deleted', async () => {
    const { a, cost } = await fixture('NOTARY', '2000.00');
    const id = await ctx.inTransaction((c) => ctx.rawClassify(c, a, cost, [['OWNERSHIP_TRANSFER', '2000.00']]));
    const insertPart = (position: number, amount: string) =>
      messageOf(
        ctx.pool.query(
          `INSERT INTO acquisition_cost_classification_part (classification_id, position, purpose, amount, currency) VALUES ($1, $2, 'FINANCING', $3, 'EUR')`,
          [id, position, amount],
        ),
      );
    expect(await insertPart(2, '1.00')).toMatch(/inserted only by the transaction that created it/);
    expect(await messageOf(ctx.pool.query(`UPDATE acquisition_cost_classification_part SET amount = 1999.99 WHERE classification_id = $1`, [id]))).toMatch(
      /never changed or deleted/,
    );
    expect(await messageOf(ctx.pool.query(`DELETE FROM acquisition_cost_classification_part WHERE classification_id = $1`, [id]))).toMatch(
      /never changed or deleted/,
    );
    // A part's created_txid is never given either.
    const other = await fixture();
    expect(
      await messageOf(
        ctx.inTransaction(async (c) => {
          const fresh = await ctx.rawClassify(c, other.a, other.cost, []);
          await c.query(
            `INSERT INTO acquisition_cost_classification_part (classification_id, position, purpose, amount, currency, created_txid) VALUES ($1, 1, 'FINANCING', 2000, 'EUR', 1)`,
            [fresh],
          );
        }),
      ),
    ).toMatch(/inserted only by the transaction that created it/);
    // Counter-check: in its own transaction it is accepted (as rawClassify does above).
    expect((await ctx.pool.query(`SELECT count(*)::int AS n FROM acquisition_cost_classification_part WHERE classification_id = $1`, [id])).rows[0].n).toBe(1);
  });

  it('no classification for a VOID cost (COST_VOID) or a CANCELLED Acquisition (ACQUISITION_CANCELLED); a CONFIRMED one takes it', async () => {
    const { a, cost } = await fixture('OTHER', '10.00');
    await ctx.costs.voidCost(a, cost, REALM, 'falsch erfasst', new Date(), { actorType: 'USER', actorId: 'x' });
    expect(await classify(a, cost, transfer('10.00'))).toMatch(/COST_VOID/);
    const cancelled = await fixture();
    await ctx.acquisitions.cancel(cancelled.a, REALM, 'x', new Date(), { actorType: 'USER', actorId: 'x' });
    expect(await classify(cancelled.a, cancelled.cost, transfer('2000.00'))).toMatch(/ACQUISITION_CANCELLED/);
    const confirmed = await fixture();
    await ctx.confirm(confirmed.a);
    expect(await classify(confirmed.a, confirmed.cost, transfer('2000.00'))).toBe('accepted');
  });

  it('the value CHECKs: description, references, review state, notes, the advisor only with ADVISOR_CONFIRMED; a part’s position, purpose, amount, currency', async () => {
    const { a, cost } = await fixture();
    const advisor = await ctx.party('Beraterin');
    for (const [set, constraint] of [
      [{ description: '' }, /description_check/],
      [{ description: 'x'.repeat(501) }, /description_check/],
      [{ source_references: Array.from({ length: 11 }, () => 'x') }, /source_references_check/],
      [{ review_state: 'SUGGESTED' }, /review_state_check/],
      [{ notes: '' }, /notes_check/],
      [{ advisor_party_id: advisor, review_state: 'CONFIRMED' }, /acquisition_cost_classification_advisor_state/],
    ] as const) {
      expect(await classify(a, cost, transfer('2000.00'), set), JSON.stringify(set)).toMatch(constraint);
    }
    for (const [parts, constraint] of [
      [[['OWNERSHIP_TRANSFER', '0']], /amount_check/],
      [
        [
          ['OWNERSHIP_TRANSFER', '-1'],
          ['FINANCING', '2001'],
        ],
        /amount_check/,
      ],
      [
        [
          ['OWNERSHIP_TRANSFER', '1999.995'],
          ['FINANCING', '0.005'],
        ],
        /amount_check/,
      ],
      [[['OTHER', '2000.00']], /purpose_check/],
      [Array.from({ length: 6 }, () => ['FINANCING', '1.00']).concat([['FINANCING', '1994.00']]), /position_check/],
    ] as const) {
      expect(await classify(a, cost, parts as never), JSON.stringify(parts)).toMatch(constraint);
    }
    expect(
      await messageOf(
        ctx.inTransaction(async (c) => {
          const id = await ctx.rawClassify(c, a, cost, []);
          await c.query(
            `INSERT INTO acquisition_cost_classification_part (classification_id, position, purpose, amount, currency) VALUES ($1, 1, 'FINANCING', 2000, 'USD')`,
            [id],
          );
        }),
      ),
    ).toMatch(/currency_check/);
    expect(
      await messageOf(
        ctx.inTransaction(async (c) => {
          const id = await ctx.rawClassify(c, a, cost, transfer('1000.00'));
          await c.query(
            `INSERT INTO acquisition_cost_classification_part (classification_id, position, purpose, amount, currency) VALUES ($1, 1, 'FINANCING', 1000, 'EUR')`,
            [id],
          );
        }),
      ),
    ).toMatch(/acquisition_cost_classification_part_key/);
    // Counter-check: every value at its bound is accepted (five parts, 500 characters, ten references, the advisor confirmed).
    expect(
      await classify(
        a,
        cost,
        [
          ['OWNERSHIP_TRANSFER', '1996.00'],
          ['FINANCING', '1.00'],
          ['FINANCING', '1.00'],
          ['NOT_ACQUISITION_COST', '1.00'],
          ['FINANCING', '1.00'],
        ],
        {
          description: 'x'.repeat(500),
          source_references: Array.from({ length: 10 }, () => 'x'),
          review_state: 'ADVISOR_CONFIRMED',
          advisor_party_id: advisor,
          notes: 'n',
        },
      ),
    ).toBe('accepted');
  });

  it('the composite keys: a cost of another Acquisition, an Acquisition or an advisor of another Realm, are refused', async () => {
    const { a, cost } = await fixture();
    const other = await fixture();
    expect(await classify(a, other.cost, transfer('2000.00'))).toMatch(/acquisition_cost_classification_cost_fk/);
    expect(await classify(a, cost, transfer('2000.00'), { mre_realm_id: OTHER_REALM })).toMatch(/acquisition_cost_classification_acquisition_fk/);
    const foreignAdvisor = await ctx.party('Fremd', OTHER_REALM);
    expect(await classify(a, cost, transfer('2000.00'), { review_state: 'ADVISOR_CONFIRMED', advisor_party_id: foreignAdvisor })).toMatch(
      /acquisition_cost_classification_advisor_fk/,
    );
    // Counter-check: its own cost in its own Realm.
    expect(await classify(a, cost, transfer('2000.00'))).toBe('accepted');
  });
});
