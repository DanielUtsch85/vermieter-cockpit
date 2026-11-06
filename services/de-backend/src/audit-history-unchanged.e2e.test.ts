import { describe, expect, it } from 'vitest';
import { AUDIT_MARKER } from './domains/audit/index.js';
import { pseudonymiseDueAuditRecords } from './infrastructure/postgres/audit-retention.js';
import { stageAudit } from './infrastructure/postgres/audit-stage.test-support.js';
import { PostgresPartyRepository, createDatabase } from './infrastructure/postgres/index.js';
import { PROPERTIES, REALM_A, databaseUrl, eur, useAcc8, type Json } from './phase-8-acceptance.test-support.js';

/**
 * VC-X-24 (api-design.md §58U "Unchanged guarantees"): on ACC8's wiring, a purchase whose 2026 carries an
 * `ATTRIBUTION_INPUT_CHANGED` flag (the Loan's terms voided after the year, acknowledged), and its buyers amended
 * (names, e-mail, phone) with the amendments backdated past retention. The job then pseudonymises the Party history;
 * the tax-year views (figures, flags, fingerprints, review), the acknowledgement, the property export and every row of
 * every table but `audit_record` answer the same before and after, byte for byte; in `audit_record` only the Party
 * `AMENDED` records changed (metadata and `pseudonymised_at`) and one `AUDIT_PSEUDONYMISED` record each was added.
 * Synthetic values only; every time asserted on is set explicitly.
 */
describe.skipIf(databaseUrl === undefined)('the history reads are unchanged by the pseudonymisation (VC-X-24)', () => {
  const api = useAcc8('audit_history_unchanged_e2e');
  const { at, post, get, view, booked, classify } = api;

  it(
    'views, flags, fingerprints, acknowledgement and export are the same before and after; only Party AMENDED records change',
    { timeout: 120_000 },
    async () => {
      at('2026-07-01');
      const pr = await api.link(PROPERTIES[0] as string);
      const [a, b] = [await api.party('Käuferin A'), await api.party('Käufer B')].sort() as [string, string];
      const { acquisitionId: w } = await api.purchase({
        pr,
        buyers: [a, b],
        share: '1/1',
        price: '300000.00',
        contract: '2026-05-20',
        transfer: '2026-07-01',
        costs: [['NOTARY', '2000.00']],
        allocation: { total: '302000.00', land: '60400.00', building: '241600.00' },
      });
      await api.own(pr, a, '3/5', '2026-07-01', w);
      await api.own(pr, b, '2/5', '2026-07-01', w);
      await api.confirm(w);
      await api.building(pr, [w]);
      const lender = (await post('/parties', { partyType: 'ORGANIZATION', displayName: 'Bank Beispiel (synthetisch)' })).partyId;
      const loanId = (await post('/loans', { lenderPartyId: lender, borrowerPartyIds: [a, b], principalOriginal: eur('100000.00'), startDate: '2026-07-01' }))
        .loanId;
      const { termsId } = await post(`/loans/${loanId}/terms`, {
        validFrom: '2026-07-01',
        interestRate: '3.000',
        repaymentModel: 'INTEREST_ONLY',
        firstPaymentDate: '2026-07-31',
      });
      await post(`/loans/${loanId}/allocations`, { validFrom: '2026-07-01', basis: 'MANUAL', allocations: [{ propertyReferenceId: pr, share: '1/1' }] });
      const account = await api.account();
      const [interest] = await booked(account, 'OUTFLOW', '2027-01-04', [{ amount: eur('250.00'), financialCategoryCode: 'LOAN_INTEREST', loanId }]);
      await classify({ sourceId: interest, taxCategory: 'LOAN_INTEREST', treatment: 'DEDUCTIBLE' });
      const pool = api.ctx.pool;
      const recordOf = async (entityId: string, action: string) =>
        (await pool.query(`SELECT id FROM audit_record WHERE entity_id = $1 AND action = $2`, [entityId, action])).rows[0].id as string;
      await stageAudit(pool, `UPDATE audit_record SET occurred_at = '2026-07-01T10:00:00Z' WHERE id = $1`, [await recordOf(termsId, 'CREATED')]);
      at('2027-03-01');
      await post(`/loans/${loanId}/terms/${termsId}/void`, { reason: 'Vertrag falsch erfasst (synthetisch)' }, 200);
      const voided = await recordOf(termsId, 'VOIDED');
      await stageAudit(pool, `UPDATE audit_record SET occurred_at = '2027-03-01T10:00:00Z' WHERE id = $1`, [voided]);
      const flagged = await view(pr, 2026);
      const entry = flagged.flags.find((f: Json) => f.code === 'ATTRIBUTION_INPUT_CHANGED').details[0];
      await post(`/property-references/${pr}/tax-years/2026/acknowledgements`, {
        auditRecordId: voided,
        expectedFingerprint: entry.changeFingerprint,
        reason: 'Erklärung 2026 noch nicht abgegeben (synthetisch)',
      });

      // The buyers amended through the repository (ACC8 wires no Party amend route), backdated to 2026.
      const parties = new PostgresPartyRepository(createDatabase(pool));
      const actor = { actorType: 'USER', actorId: 'anna@example.com' } as const;
      for (const [id, changes] of [
        [a, { displayName: 'Käuferin A geändert', email: 'kaeuferin.a@example.org', phone: '+49 30 0000010' }],
        [b, { firstName: 'Bernd', lastName: 'Beispiel', email: 'kaeufer.b@example.org' }],
        [a, { email: 'kaeuferin.a.neu@example.org' }],
      ] as const) {
        expect((await parties.amend(id, REALM_A, changes, actor)).kind).toBe('AMENDED');
      }
      const amended = (await pool.query(`SELECT id FROM audit_record WHERE entity_type = 'Party' AND action = 'AMENDED' ORDER BY id`)).rows.map(
        (r) => r.id as string,
      );
      expect(amended).toHaveLength(3);
      await stageAudit(pool, `UPDATE audit_record SET occurred_at = '2026-08-01T10:00:00Z' WHERE id = ANY($1::uuid[])`, [amended]);

      /** Everything a reader sees, and every row of every table but audit_record; audit_record without the Party history. */
      const snapshot = async () => {
        const tables = (
          await pool.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_type = 'BASE TABLE' ORDER BY 1`)
        ).rows.map((r) => r.table_name as string);
        const rows: Record<string, unknown> = {};
        for (const table of tables.filter((t) => t !== 'audit_record' && t !== 'kysely_migration' && t !== 'kysely_migration_lock')) {
          rows[table] = (
            await pool.query(`SELECT md5(coalesce(string_agg(to_jsonb(t)::text, '|' ORDER BY to_jsonb(t)::text), '')) AS sum FROM "${table}" t`)
          ).rows[0].sum;
        }
        const audit = (
          await pool.query(
            `SELECT to_jsonb(a) - 'metadata' - 'pseudonymised_at' AS row, CASE WHEN entity_type = 'Party' AND action = 'AMENDED' THEN NULL ELSE metadata END AS metadata
           FROM audit_record a WHERE action <> 'AUDIT_PSEUDONYMISED' ORDER BY id`,
          )
        ).rows;
        const exported = await get(`/property-references/${pr}/export.json`);
        delete exported.generatedAt;
        return {
          views: [await view(pr, 2026), await view(pr, 2027), await view(pr, 2026, a), await view(pr, 2026, b)],
          exported,
          rows,
          audit,
        };
      };
      const before = await snapshot();
      // The acknowledged change is information, no longer open.
      expect(before.views[0].review.info).toContainEqual({ code: 'ATTRIBUTION_INPUT_CHANGED', count: 1 });
      expect(before.views[0].flags.find((f: Json) => f.code === 'ATTRIBUTION_INPUT_CHANGED').details[0].changeFingerprint).toBe(entry.changeFingerprint);

      expect(await pseudonymiseDueAuditRecords(createDatabase(pool), new Date('2040-01-01T00:00:00+01:00'))).toBe(3);
      const after = await snapshot();
      expect(after).toEqual(before);
      const history = (
        await pool.query(`SELECT metadata, pseudonymised_at IS NOT NULL AS done FROM audit_record WHERE id = ANY($1::uuid[]) ORDER BY id`, [amended])
      ).rows;
      for (const h of history) {
        expect(h.done).toBe(true);
        expect(JSON.stringify(h.metadata)).not.toMatch(/example\.org|\+49|Käuferin|Bernd|Beispiel/);
        for (const change of Object.values(h.metadata.changes as Record<string, { from: unknown; to: unknown }>)) {
          expect([AUDIT_MARKER, null]).toContain(change.from);
          expect([AUDIT_MARKER, null]).toContain(change.to);
        }
      }
      const added = (await pool.query(`SELECT count(*)::int AS n FROM audit_record WHERE action = 'AUDIT_PSEUDONYMISED'`)).rows[0].n;
      expect(added).toBe(3);
    },
  );
});
