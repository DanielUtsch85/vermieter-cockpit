import { describe, expect, it } from 'vitest';
import { TAX_RULES } from '../../domains/tax-rules/index.js';
import { buildTaxYearView, type TaxYearView } from '../../domains/taxation/index.js';
import { sha256Fingerprinter as fingerprinter } from '../hashing/index.js';
import { createDatabase } from './database.js';
import { migrations } from './migrations/index.js';
import { actor, AT, databaseUrl, day, eur, OTHER_REALM, reasonOf, REALM, useTaxWegDatabase, withMigrationLock } from './tax-weg.test-support.js';

/**
 * §58K (VC-X-34, migration 0066; Entscheidung des Projektinhabers, 2026-11-04, K1–K4) through PostgreSQL: the check of
 * an Acquisition without `economicTransferDate` (legacy data, confirmed before VC-X-34) through the real read, the
 * capitalisation on it refused by the create check and, past the repository, by 0066's guard (counter-check: the dated
 * Acquisition accepted), a classification stored before 0066 keeping its link, `down` and `up`, the confirm refused,
 * the view's years, Realm isolation and "no row written by a read". Contract 2026-02-01; synthetic data only.
 */
describe.skipIf(databaseUrl === undefined)('the anschaffungsnahe check without economicTransferDate (§58K, migration 0066)', () => {
  const { ctx, split, booked, propertyReference, acquisition } = useTaxWegDatabase('anschaffungsnahe_transfer_date_test');
  const today = day('2026-10-30');
  const performance = { from: day('2026-05-04'), until: day('2026-06-30'), progress: [], progressEstimated: null };
  /** The repair of §58K's example: 40,000.00 net, MAINTENANCE / DEDUCTIBLE, booked 2026-07-10. */
  const repair = async (pr: string) => {
    const { splitIds } = await booked([split('40000.00', 'MAINTENANCE', pr)], '2026-07-10');
    const sourceId = splitIds[0] as string;
    const created = await ctx.classifications.createClassification(
      {
        mreRealmId: REALM,
        sourceType: 'TRANSACTION_SPLIT',
        sourceId,
        taxCategory: 'MAINTENANCE',
        treatment: 'DEDUCTIBLE',
        reviewState: 'USER_CONFIRMED',
        supersedes: null,
        notes: null,
        sourceReferences: ['Rechnung (synthetisch)'],
        netAmount: eur('40000.00'),
        performance,
      },
      actor,
    );
    if (created.kind !== 'CREATED') throw new Error(JSON.stringify(created));
    return { sourceId, classificationId: created.classification.id };
  };
  const capitalise = (sourceId: string, supersedes: string, acquisitionId: string) =>
    ctx.classifications.createClassification(
      {
        mreRealmId: REALM,
        sourceType: 'TRANSACTION_SPLIT',
        sourceId,
        taxCategory: 'MAINTENANCE',
        treatment: 'CAPITALIZED',
        reviewState: 'USER_CONFIRMED',
        supersedes,
        notes: null,
        sourceReferences: ['Rechnung (synthetisch)'],
        netAmount: eur('40000.00'),
        performance,
        anschaffungsnaheAcquisitionId: acquisitionId,
      },
      actor,
    );
  /** A raw insert past the repository (one transaction, committed): the id, or the refusal's reason. */
  const rawCapitalise = async (sourceId: string, acquisitionId: string): Promise<string> => {
    try {
      const { rows } = await ctx.pool.query(
        `INSERT INTO tax_classification (mre_realm_id, source_type, transaction_split_id, tax_category, treatment, review_state, rule_code, rule_version,
           created_by, anschaffungsnahe_acquisition_id, treatment_rule_code, treatment_rule_version, performed_from, performed_until)
         VALUES ($1, 'TRANSACTION_SPLIT', $2, 'MAINTENANCE', 'CAPITALIZED', 'USER_CONFIRMED', 'DE_CATEGORY_DEFAULTS', 1, 'x', $3, 'DE_ANSCHAFFUNGSNAHE', 1,
           '2026-05-04', '2026-06-30') RETURNING id`,
        [REALM, sourceId, acquisitionId],
      );
      return rows[0].id as string;
    } catch (error) {
      const e = error as { message?: string };
      return `${reasonOf(e)}${/TRANSFER_DATE_MISSING/.test(e.message ?? '') ? ' TRANSFER_DATE_MISSING' : ''}`;
    }
  };
  const step = async (name: 'up' | 'down') => {
    const migration = migrations['0066_anschaffungsnahe_transfer_date'] as { up: (db: never) => Promise<void>; down: (db: never) => Promise<void> };
    await withMigrationLock(() => migration[name](createDatabase(ctx.pool) as never));
  };
  const rowCounts = async () =>
    (
      await ctx.pool.query(
        `SELECT (SELECT count(*) FROM audit_record)::int AS audits, (SELECT count(*) FROM tax_classification)::int AS classifications,
                (SELECT count(*) FROM acquisition)::int AS acquisitions, (SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM transaction_split t) AS splits`,
      )
    ).rows[0];
  const viewOf = async (pr: string, year: number): Promise<TaxYearView> => {
    const read = await ctx.classifications.readTaxYear(pr, REALM, year, null, today);
    if (read === undefined) throw new Error('no PropertyReference');
    const outcome = buildTaxYearView(read, { year, ownerPartyId: null, today, registry: TAX_RULES, fingerprinter });
    if (outcome.kind !== 'VIEW') throw new Error(outcome.kind);
    return outcome.view;
  };

  it('the check through the real read: Q NOT_COMPUTABLE with TRANSFER_DATE_MISSING; Q′ computed; reading writes no row', async () => {
    const [p, p2] = [await propertyReference(), await propertyReference()];
    const q = await acquisition(p, { transfer: null, contract: '2026-02-01' });
    const q2 = await acquisition(p2, { contract: '2026-02-01', transfer: '2026-03-15' });
    await repair(p);
    await repair(p2);
    const before = await rowCounts();
    const check = await ctx.classifications.anschaffungsnaheCheck(q, REALM, today);
    expect(check).toMatchObject({
      transferDate: null,
      contractDate: '2026-02-01',
      window: null,
      searchRange: null,
      outerBound: null,
      rule: null,
      status: 'NOT_COMPUTABLE',
      notComputableReason: 'TRANSFER_DATE_MISSING',
      sources: [],
      unclassified: [],
      sum: eur('0.00'),
      final: false,
      flags: [
        { code: 'NOT_FINAL', details: { reasons: ['TRANSFER_DATE_MISSING'] } },
        { code: 'TRANSFER_DATE_MISSING', details: { contractDate: '2026-02-01' } },
      ],
    });
    expect(check?.basis?.basisAmount).toEqual(eur('180000.00'));
    const dated = await ctx.classifications.anschaffungsnaheCheck(q2, REALM, today);
    expect([dated?.status, dated?.transferDate, dated?.window, dated?.sum]).toEqual([
      'ABOVE_THRESHOLD',
      '2026-03-15',
      { from: '2026-03-15', until: '2029-03-15' },
      eur('40000.00'),
    ]);
    // History: reading writes no AuditRecord and no row; no cash mutated.
    expect(await rowCounts()).toEqual(before);
  });

  it('the capitalisation on Q refused TRANSFER_DATE_MISSING by the create check, nothing stored; on Q′ accepted', async () => {
    const [p, p2] = [await propertyReference(), await propertyReference()];
    const q = await acquisition(p, { transfer: null });
    const q2 = await acquisition(p2, { contract: '2026-02-01', transfer: '2026-03-15' });
    const r = await repair(p);
    const before = await rowCounts();
    expect(await capitalise(r.sourceId, r.classificationId, q)).toEqual({
      kind: 'ANSCHAFFUNGSNAHE_NOT_APPLICABLE',
      reason: 'TRANSFER_DATE_MISSING',
      acquisitionId: q,
    });
    expect(await rowCounts()).toEqual(before);
    const r2 = await repair(p2);
    const accepted = await capitalise(r2.sourceId, r2.classificationId, q2);
    expect(accepted.kind).toBe('CREATED');
    const audits = await ctx.pool.query(`SELECT action FROM audit_record WHERE entity_type = 'TaxClassification' AND entity_id = $1`, [
      accepted.kind === 'CREATED' ? accepted.classification.id : '',
    ]);
    expect(audits.rows.map((row) => row.action)).toEqual(['TAX_CLASSIFIED']);
  });

  it('the guard of 0066 past the repository: a raw insert naming Q refused; counter-check: the same naming Q′ accepted', async () => {
    const [p, p2] = [await propertyReference(), await propertyReference()];
    const q = await acquisition(p, { transfer: null });
    const q2 = await acquisition(p2, { contract: '2026-02-01', transfer: '2026-03-15' });
    const [s] = (await booked([split('40000.00', 'MAINTENANCE', p)], '2026-07-10')).splitIds;
    const [s2] = (await booked([split('40000.00', 'MAINTENANCE', p2)], '2026-07-10')).splitIds;
    expect(await rawCapitalise(s as string, q)).toBe('(ANSCHAFFUNGSNAHE_NOT_APPLICABLE) TRANSFER_DATE_MISSING');
    expect(await rawCapitalise(s2 as string, q2)).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('a classification stored before 0066 keeps its link; down restores 0062 (the insert accepted), up refuses again', { timeout: 60_000 }, async () => {
    const p = await propertyReference();
    const q = await acquisition(p, { transfer: null });
    const [s, t] = (await booked([split('40000.00', 'MAINTENANCE', p), split('500.00', 'MAINTENANCE', p)], '2026-07-10')).splitIds as [string, string];
    let stored: string;
    try {
      await step('down');
      // Before VC-X-34 the window started at the contract date: the capitalisation was accepted.
      stored = await rawCapitalise(s, q);
      expect(stored).toMatch(/^[0-9a-f-]{36}$/);
    } finally {
      await step('up');
    }
    expect(await rawCapitalise(t, q)).toBe('(ANSCHAFFUNGSNAHE_NOT_APPLICABLE) TRANSFER_DATE_MISSING');
    const kept = await ctx.pool.query(`SELECT anschaffungsnahe_acquisition_id, superseded_at FROM tax_classification WHERE id = $1`, [stored]);
    expect(kept.rows).toEqual([{ anschaffungsnahe_acquisition_id: q, superseded_at: null }]);
    // Its source is not summed by the check that is not computable; the year is held open.
    const check = await ctx.classifications.anschaffungsnaheCheck(q, REALM, today);
    expect([check?.status, check?.notComputableReason, check?.sources, check?.sum]).toEqual(['NOT_COMPUTABLE', 'TRANSFER_DATE_MISSING', [], eur('0.00')]);
    expect((await viewOf(p, 2026)).acquisitions.map((a) => [a.acquisitionId, a.status, a.final])).toEqual([[q, 'NOT_COMPUTABLE', false]]);
  });

  it('the view of the real read: Q from 2026 in every year asked, not in 2025; the money as for Q′', async () => {
    const [p, p2] = [await propertyReference(), await propertyReference()];
    const q = await acquisition(p, { transfer: null });
    const q2 = await acquisition(p2, { contract: '2026-02-01', transfer: '2026-03-15' });
    await repair(p);
    await repair(p2);
    expect((await viewOf(p, 2025)).acquisitions).toEqual([]);
    for (const year of [2026, 2027, 2028, 2029, 2035]) {
      const v = await viewOf(p, year);
      expect(v.acquisitions.map((a) => [a.acquisitionId, a.transferDate, a.window, a.status, a.final, a.notFinalReasons])).toEqual([
        [q, null, null, 'NOT_COMPUTABLE', false, ['TRANSFER_DATE_MISSING']],
      ]);
      expect(v.flags.find((f) => f.code === 'ANSCHAFFUNGSNAHE_CHECK_NOT_FINAL')?.details).toEqual({ acquisitionIds: [q] });
    }
    // Unchanged money: the repair DEDUCTIBLE on MAINTENANCE 40,000.00 in 2026 in both views, whatever the check says.
    const [v, v2] = [await viewOf(p, 2026), await viewOf(p2, 2026)];
    const money = (x: TaxYearView) => [
      x.einnahmen.total,
      x.werbungskosten.total,
      [...x.einnahmen.lines, ...x.werbungskosten.lines].map((l) => [l.line, l.total, l.items.map((i) => [i.amount, i.lineAmount])]),
      x.result,
      x.capitalized.total,
    ];
    expect(money(v)).toEqual(money(v2));
    expect(v.werbungskosten.lines.find((l) => l.taxCategory === 'MAINTENANCE')?.total).toEqual(eur('40000.00'));
    // Q′ only in the years its window overlaps.
    expect((await viewOf(p2, 2029)).acquisitions.map((a) => a.acquisitionId)).toEqual([q2]);
    expect((await viewOf(p2, 2030)).acquisitions).toEqual([]);
  });

  it('Realm isolation: another Realm undated Acquisition is in no check or view of this Realm', async () => {
    const [p, theirs] = [await propertyReference(), await propertyReference(OTHER_REALM)];
    const q = await acquisition(p, { transfer: null });
    const foreign = await acquisition(theirs, { transfer: null, realm: OTHER_REALM, confirm: false });
    expect(await ctx.classifications.anschaffungsnaheCheck(foreign, REALM, today)).toBeUndefined();
    expect(await ctx.classifications.anschaffungsnaheCheck(q, OTHER_REALM, today)).toBeUndefined();
    expect((await viewOf(p, 2027)).acquisitions.map((a) => a.acquisitionId)).toEqual([q]);
    expect(await ctx.classifications.readTaxYear(theirs, REALM, 2027, null, today)).toBeUndefined();
  });

  it('§58K K4: the confirm through the repository refuses an undated Acquisition, nothing written; the transfer on the contract date confirms', async () => {
    const p = await propertyReference();
    const draft = await acquisition(p, { transfer: null, contract: '2026-02-01', confirm: false });
    const before = await rowCounts();
    const row = (await ctx.pool.query(`SELECT to_jsonb(a) AS row FROM acquisition a WHERE id = $1`, [draft])).rows;
    expect(await ctx.acquisitions.confirm(draft, REALM, AT, actor)).toEqual({
      kind: 'CONFIRMATION_BLOCKED',
      violations: [{ code: 'TRANSFER_DATE_MISSING', contractDate: '2026-02-01' }],
    });
    expect(await rowCounts()).toEqual(before);
    expect((await ctx.pool.query(`SELECT to_jsonb(a) AS row FROM acquisition a WHERE id = $1`, [draft])).rows).toEqual(row);
    // Counter-check: economicTransferDate equal to the contract date confirms, with the CONFIRMED AuditRecord.
    const same = await acquisition(await propertyReference(), { contract: '2026-02-01', transfer: '2026-02-01', confirm: false });
    expect((await ctx.acquisitions.confirm(same, REALM, AT, actor)).kind).toBe('CONFIRMED');
    const audits = await ctx.pool.query(`SELECT action FROM audit_record WHERE entity_type = 'Acquisition' AND entity_id = $1 ORDER BY occurred_at`, [same]);
    expect(audits.rows.map((r) => r.action)).toContain('CONFIRMED');
  });
});
