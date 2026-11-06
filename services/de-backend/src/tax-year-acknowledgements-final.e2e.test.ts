import { describe, expect, it } from 'vitest';
import { PROPERTIES, databaseUrl, eur, useAcc8, type Json } from './phase-8-acceptance.test-support.js';
import { stageAudit } from './infrastructure/postgres/audit-stage.test-support.js';

/**
 * VC-X-28 (api-design.md §58E "The effect on `final`"; decided by the owner on 2026-11-01, question 8: the step "a year
 * leaves and reaches `final` again" belongs to VC-X-28's own e2e test, not to ACC8). On ACC8's wiring (the record command
 * with the switch on, test-only, as §60 prescribes for tests): a purchase whose 2026 is final with its recorded AfA and
 * the interest of a Loan attributed to 2026 by the 10-day rule. The Loan's terms voided in 2027 move the interest to
 * 2027: 2026 is no longer final; acknowledged, it is final again; withdrawn, not; acknowledged again, final. Every
 * statement moves no figure. Synthetic values only; every time asserted on is set explicitly.
 */
describe.skipIf(databaseUrl === undefined)('a year leaves and reaches final again (VC-X-28)', () => {
  const api = useAcc8('tax_year_ack_final_e2e');
  const { at, post, view, record, classify, booked, call, json } = api;

  it(
    '2026 final; the terms voided after its end hold it open; acknowledged final again, withdrawn open, acknowledged final',
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
      const building = await api.building(pr, [w]);
      // A Loan of the purchase, interest due on the last day of each month, allocated 1/1 to the unit.
      const lender = (await post('/parties', { partyType: 'ORGANIZATION', displayName: 'Bank Beispiel (synthetisch)' })).partyId;
      const loanId = (await post('/loans', { lenderPartyId: lender, borrowerPartyIds: [a, b], principalOriginal: eur('100000.00'), startDate: '2026-07-01' }))
        .loanId;
      const { termsId } = await post(`/loans/${loanId}/terms`, {
        validFrom: '2026-07-01',
        interestRate: '3.000',
        repaymentModel: 'INTEREST_ONLY',
        firstPaymentDate: '2026-07-31',
      });
      const recordOf = async (entityId: string, action: string) =>
        (await api.ctx.pool.query(`SELECT id FROM audit_record WHERE entity_id = $1 AND action = $2`, [entityId, action])).rows[0].id as string;
      await stageAudit(api.ctx.pool, `UPDATE audit_record SET occurred_at = '2026-07-01T10:00:00Z' WHERE id = $1`, [await recordOf(termsId, 'CREATED')]);
      await post(`/loans/${loanId}/allocations`, { validFrom: '2026-07-01', basis: 'MANUAL', allocations: [{ propertyReferenceId: pr, share: '1/1' }] });
      const account = await api.account();
      // Paid on 2027-01-04, due 2026-12-31: December's interest, in 2026 by the 10-day rule; classified by the user.
      const [interest] = await booked(account, 'OUTFLOW', '2027-01-04', [{ amount: eur('250.00'), financialCategoryCode: 'LOAN_INTEREST', loanId }]);
      await classify({ sourceId: interest, taxCategory: 'LOAN_INTEREST', treatment: 'DEDUCTIBLE' });
      // After the anschaffungsnahe window: 2026's AfA recorded; the year is final.
      at('2029-10-15');
      await record(building, 2026);
      const final = await view(pr, 2026);
      const interestLine = (v: Json) => v.werbungskosten.lines.find((l: Json) => l.taxCategory === 'LOAN_INTEREST');
      expect([interestLine(final)?.items.map((i: Json) => i.sourceId), final.review.open, final.review.final]).toEqual([[interest], [], true]);

      // The terms voided on 2027-03-01, after 2026's end: the interest leaves 2026 (no schedule, the booking year).
      await post(`/loans/${loanId}/terms/${termsId}/void`, { reason: 'Vertrag falsch erfasst (synthetisch)' }, 200);
      const voided = await recordOf(termsId, 'VOIDED');
      await stageAudit(api.ctx.pool, `UPDATE audit_record SET occurred_at = '2027-03-01T10:00:00Z' WHERE id = $1`, [voided]);
      const left = await view(pr, 2026);
      const entry = left.flags.find((f: Json) => f.code === 'ATTRIBUTION_INPUT_CHANGED').details[0];
      expect([interestLine(left)?.items, entry.kind, entry.items, left.review.open, left.review.final]).toEqual([
        [],
        'LOAN_TERMS_VOIDED',
        [{ sourceId: interest, yearBefore: 2026, yearAfter: 2027 }],
        [{ code: 'ATTRIBUTION_INPUT_CHANGED', count: 1 }],
        false,
      ]);
      const figures = (v: Json) => [v.einnahmen, v.werbungskosten, v.depreciation, v.result, v.owners];

      // Acknowledged: final again; the figures are the ones before the acknowledgement.
      const path = `/property-references/${pr}/tax-years/2026/acknowledgements`;
      const body = { auditRecordId: voided, expectedFingerprint: entry.changeFingerprint, reason: 'Erklärung 2026 noch nicht abgegeben (synthetisch)' };
      const ack = await post(path, body);
      const again = await view(pr, 2026);
      expect([again.review.open, again.review.final]).toEqual([[], true]);
      expect(again.review.info).toContainEqual({ code: 'ATTRIBUTION_INPUT_CHANGED', count: 1 });
      expect(figures(again)).toEqual(figures(left));
      for (const owner of [a, b]) expect((await view(pr, 2026, owner)).review.final).toBe(true);
      // Withdrawn: open; acknowledged again: final.
      await post(`${path}/${ack.acknowledgementId}/withdraw`, { reason: 'Erklärung doch abgegeben (synthetisch)' }, 200);
      expect((await view(pr, 2026)).review.final).toBe(false);
      await post(path, body);
      const reached = await view(pr, 2026);
      expect([reached.review.final, figures(reached)]).toEqual([true, figures(left)]);
      // 2027 shows no change of its own (the void was recorded during 2027) and is not final for other reasons.
      expect((await view(pr, 2027)).flags.map((f: Json) => f.code)).not.toContain('ATTRIBUTION_INPUT_CHANGED');
      const refused = await json(await call('POST', `/property-references/${pr}/tax-years/2027/acknowledgements`, body), 409);
      expect(refused.error.details.reason).toBe('CHANGE_NOT_FLAGGED');
    },
  );
});
