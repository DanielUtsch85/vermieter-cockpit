import type pg from 'pg';
import { beforeAll, describe, expect, it } from 'vitest';
import type { PostgresRentReconciliationRepository } from './rent-reconciliation-repository.js';
import {
  databaseUrl,
  REALM,
  OTHER_REALM,
  TENANT,
  actor,
  eur,
  waitForLocks,
  reasonOf,
  useRentReconciliationDatabase,
} from './rent-reconciliation.test-support.js';

/**
 * VC-4-04/05 persistence (api-design.md §37.4–§37.5): the claims and records of the write-back and the removal, and
 * the lease mechanics, in `rent-write-back-store.ts`.
 */
describe.skipIf(databaseUrl === undefined)('RentPaymentReconciliation MRE write-back and removal (§37.4–§37.5)', () => {
  const { ctx, transaction, match, created, rawInsert } = useRentReconciliationDatabase('rent_write_back_test');
  let pool: pg.Pool;
  let repository: PostgresRentReconciliationRepository;
  beforeAll(() => {
    ({ pool, repository } = ctx);
  });

  describe('write-back to MRE (§37.4)', () => {
    let next = 0;
    /** A Tenant of its own per case: a PENDING row of one case never blocks another's claim. */
    const tenant = () => `6512f0c2a1b2c3d4e5f6${(0xc100 + next++).toString(16)}`;
    const written = { date: '03/01/2027', amount: eur('800.00'), type: 'transfer', reference: 'DE-RPR-x' };
    const confirmedFor = async (tenantId: string, term = '2027010100') => created(match(await transaction(), '800.00', term, tenantId));
    const claimed = async (id: string, leaseMs = 60_000) => {
      const outcome = await repository.claimWriteBack(id, REALM, leaseMs, actor);
      if (outcome.kind !== 'CLAIMED') throw new Error(JSON.stringify(outcome));
      return outcome;
    };
    const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

    it('claim → PENDING with a lease and the booking date; record WRITTEN under the attempt; a repeat is UNCHANGED; AuditRecords', async () => {
      const r = await confirmedFor(tenant());
      const before = Date.now();
      const claim = await claimed(r.id);
      expect(claim).toMatchObject({
        bookingDate: '2027-01-03',
        reconciliation: { mreWriteBackState: 'PENDING', mreWriteBackAttemptId: claim.attemptId, version: 2 },
      });
      const lease = claim.reconciliation.mreWriteBackLeaseUntil?.getTime() ?? 0;
      expect(lease).toBeGreaterThanOrEqual(before + 59_000);
      expect(await repository.claimWriteBack(r.id, REALM, 60_000, actor)).toEqual({ kind: 'WRITE_BACK_IN_PROGRESS', reconciliationId: r.id });
      expect(
        await repository.recordWriteBack(r.id, REALM, '00000000-0000-4000-8000-000000000000', { kind: 'FAILED', error: 'MRE_UNAVAILABLE' }, actor),
      ).toEqual({ kind: 'LEASE_LOST' });
      const recorded = await repository.recordWriteBack(r.id, REALM, claim.attemptId, { kind: 'WRITTEN', payment: written, patched: true }, actor);
      expect(recorded).toMatchObject({
        kind: 'RECORDED',
        reconciliation: {
          mreWriteBackState: 'WRITTEN',
          mreWrittenBackBy: actor.actorId,
          mrePayment: written,
          mreWriteBackAttemptId: null,
          mreWriteBackLeaseUntil: null,
          version: 3,
        },
      });
      expect(await repository.claimWriteBack(r.id, REALM, 60_000, actor)).toMatchObject({ kind: 'UNCHANGED', reconciliation: { version: 3 } });
      expect((await repository.findById(r.id, REALM))?.mrePayment?.amount).toEqual(eur('800.00'));
      const audit = await pool.query(`SELECT action, metadata FROM audit_record WHERE entity_id = $1 ORDER BY occurred_at, action`, [r.id]);
      expect(audit.rows.map((a) => a.action)).toEqual(['CONFIRMED', 'WRITE_BACK_STARTED', 'WRITE_BACK_WRITTEN']);
      expect(audit.rows[2].metadata).toMatchObject({
        attemptId: claim.attemptId,
        patched: true,
        payment: { reference: 'DE-RPR-x', amount: { amount: '800.00', currency: 'EUR' } },
      });
    });

    it('refusals: unknown or foreign, not CONFIRMED, If-Match; FAILED and NOT_WRITTEN outcomes; a FAILED one is claimed again', async () => {
      const r = await confirmedFor(tenant());
      expect(await repository.claimWriteBack(r.id, OTHER_REALM, 60_000, actor)).toEqual({ kind: 'NOT_FOUND' });
      expect(await repository.claimWriteBack('x', REALM, 60_000, actor)).toEqual({ kind: 'NOT_FOUND' });
      expect(await repository.claimWriteBack(r.id, REALM, 60_000, actor, [7])).toEqual({ kind: 'VERSION_CONFLICT', expectedVersions: [7], currentVersion: 1 });
      const first = await claimed(r.id);
      expect(await repository.recordWriteBack(r.id, REALM, first.attemptId, { kind: 'FAILED', error: 'MRE_UNAVAILABLE' }, actor)).toMatchObject({
        reconciliation: { mreWriteBackState: 'FAILED', mreWriteBackError: 'MRE_UNAVAILABLE' },
      });
      const second = await claimed(r.id);
      expect(second.reconciliation).toMatchObject({ mreWriteBackState: 'PENDING', mreWriteBackError: null, mreWriteBackFailedAt: null });
      expect(await repository.recordWriteBack(r.id, REALM, second.attemptId, { kind: 'NOT_WRITTEN' }, actor)).toMatchObject({
        reconciliation: { mreWriteBackState: 'NOT_WRITTEN', version: 5 },
      });
      await repository.release(r.id, REALM, 'x', new Date(), actor);
      expect(await repository.claimWriteBack(r.id, REALM, 60_000, actor)).toEqual({ kind: 'NOT_WRITABLE', status: 'RELEASED' });
    });

    it('takeover after an expired lease: by the same reconciliation (the old attempt records nothing), and by another one of the Tenant (the expired row FAILED, LEASE_EXPIRED)', async () => {
      const t1 = tenant();
      const r = await confirmedFor(t1);
      const old = await claimed(r.id, 1);
      await pause(20);
      const retry = await claimed(r.id);
      expect(retry.attemptId).not.toBe(old.attemptId);
      expect(await repository.recordWriteBack(r.id, REALM, old.attemptId, { kind: 'WRITTEN', payment: written, patched: true }, actor)).toEqual({
        kind: 'LEASE_LOST',
      });
      // A live lease of another reconciliation of the same Tenant refuses; once expired it is failed and taken over.
      const other = await confirmedFor(t1, '2027020100');
      expect(await repository.claimWriteBack(other.id, REALM, 60_000, actor)).toEqual({ kind: 'WRITE_BACK_IN_PROGRESS', reconciliationId: r.id });
      await repository.recordWriteBack(r.id, REALM, retry.attemptId, { kind: 'FAILED', error: 'MRE_UNAVAILABLE' }, actor);
      const expiring = await claimed(r.id, 1);
      await pause(20);
      const taken = await claimed(other.id);
      expect(taken.reconciliation.mreWriteBackState).toBe('PENDING');
      expect(await repository.findById(r.id, REALM)).toMatchObject({
        mreWriteBackState: 'FAILED',
        mreWriteBackError: 'LEASE_EXPIRED',
        mreWriteBackAttemptId: null,
      });
      expect(await repository.recordWriteBack(r.id, REALM, expiring.attemptId, { kind: 'WRITTEN', payment: written, patched: true }, actor)).toEqual({
        kind: 'LEASE_LOST',
      });
      const audit = await pool.query(`SELECT metadata FROM audit_record WHERE entity_id = $1 AND action = 'WRITE_BACK_ABANDONED'`, [r.id]);
      expect(audit.rows).toEqual([{ metadata: expect.objectContaining({ attemptId: expiring.attemptId, takenOverBy: other.id }) }]);
      // Other Tenants and Realms are not affected by the Tenant's lease.
      expect((await repository.claimWriteBack((await confirmedFor(tenant())).id, REALM, 60_000, actor)).kind).toBe('CLAIMED');
    });

    it('release (P4-D7): NOT_WRITTEN stays; WRITTEN keeps its payment as REMOVAL_REQUIRED; FAILED and an expired PENDING become REMOVAL_REQUIRED; a live lease refuses', async () => {
      const release = (id: string) => repository.release(id, REALM, 'falscher Monat', new Date(), actor);
      const plain = await confirmedFor(tenant());
      expect(await release(plain.id)).toMatchObject({ reconciliation: { mreWriteBackState: 'NOT_WRITTEN' } });
      const w = await confirmedFor(tenant());
      await repository.recordWriteBack(w.id, REALM, (await claimed(w.id)).attemptId, { kind: 'WRITTEN', payment: written, patched: true }, actor);
      expect(await release(w.id)).toMatchObject({ reconciliation: { status: 'RELEASED', mreWriteBackState: 'REMOVAL_REQUIRED', mrePayment: written } });
      const f = await confirmedFor(tenant());
      await repository.recordWriteBack(f.id, REALM, (await claimed(f.id)).attemptId, { kind: 'FAILED', error: 'MRE_UNAVAILABLE' }, actor);
      expect(await release(f.id)).toMatchObject({ reconciliation: { mreWriteBackState: 'REMOVAL_REQUIRED', mreWriteBackError: null, mrePayment: null } });
      const live = await confirmedFor(tenant());
      await claimed(live.id);
      expect(await release(live.id)).toEqual({ kind: 'WRITE_BACK_IN_PROGRESS', reconciliationId: live.id });
      const expired = await confirmedFor(tenant());
      await claimed(expired.id, 1);
      await pause(20);
      expect(await release(expired.id)).toMatchObject({
        reconciliation: { mreWriteBackState: 'REMOVAL_REQUIRED', mreWriteBackAttemptId: null, mreWriteBackLeaseUntil: null },
      });
      const audit = await pool.query(`SELECT metadata FROM audit_record WHERE entity_id = $1 AND action = 'RELEASED'`, [w.id]);
      expect(audit.rows[0].metadata.mreWriteBackState).toEqual({ from: 'WRITTEN', to: 'REMOVAL_REQUIRED' });
    });

    const pendingStep = (id: string) =>
      `UPDATE rent_payment_reconciliation SET mre_write_back_state = 'PENDING', mre_write_back_attempt_id = gen_random_uuid(),
         mre_write_back_lease_until = now() + interval '1 hour', mre_last_lease_until = greatest(mre_last_lease_until, now() + interval '1 hour'),
         version = version + 1 WHERE id = '${id}'`;
    const releaseStep = (id: string) =>
      `UPDATE rent_payment_reconciliation SET status = 'RELEASED', released_at = now(), released_by = 'x', release_reason = 'x', version = version + 1 WHERE id = '${id}'`;
    async function heldThen<T>(first: string, second: () => Promise<T>): Promise<T> {
      const holder = await pool.connect();
      try {
        await holder.query('BEGIN ISOLATION LEVEL READ COMMITTED');
        await holder.query(first);
        const waiting = second();
        await waitForLocks(pool);
        await holder.query('COMMIT');
        return await waiting;
      } finally {
        holder.release();
      }
    }
    async function repeatableRead(first: string, second: string): Promise<string | undefined> {
      const [one, two] = [await pool.connect(), await pool.connect()];
      try {
        await one.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
        await one.query('SELECT 1');
        await two.query('BEGIN ISOLATION LEVEL READ COMMITTED');
        await two.query(first);
        const later = one.query(second).then(
          () => 'written',
          (error: { code?: string; message?: string }) => error.code ?? error.message,
        );
        await waitForLocks(pool);
        await two.query('COMMIT');
        return await later;
      } finally {
        await one.query('ROLLBACK');
        one.release();
        two.release();
      }
    }

    it('concurrency (RC): two write-backs of one reconciliation; two of one Tenant (the index); a claim waiting on a release', async () => {
      const r = await confirmedFor(tenant());
      expect(await heldThen(pendingStep(r.id), () => repository.claimWriteBack(r.id, REALM, 60_000, actor))).toEqual({
        kind: 'WRITE_BACK_IN_PROGRESS',
        reconciliationId: r.id,
      });
      const t2 = tenant();
      const a = await confirmedFor(t2);
      const b = await confirmedFor(t2, '2027020100');
      expect(await heldThen(pendingStep(a.id), () => repository.claimWriteBack(b.id, REALM, 60_000, actor))).toEqual({
        kind: 'WRITE_BACK_IN_PROGRESS',
        reconciliationId: a.id,
      });
      expect((await repository.findById(b.id, REALM))?.mreWriteBackState).toBe('NOT_WRITTEN');
      const c = await confirmedFor(tenant());
      expect(await heldThen(releaseStep(c.id), () => repository.claimWriteBack(c.id, REALM, 60_000, actor))).toEqual({
        kind: 'NOT_WRITABLE',
        status: 'RELEASED',
      });
    });

    it('concurrency (RR past the repository): a second claim, and a claim after a release, fail to serialise', async () => {
      const r = await confirmedFor(tenant());
      expect(await repeatableRead(pendingStep(r.id), pendingStep(r.id))).toBe('40001');
      const c = await confirmedFor(tenant());
      expect(await repeatableRead(releaseStep(c.id), pendingStep(c.id))).toBe('40001');
    });

    it('schema (0032): the field sets, the states per status, the steps, the release rule, the Tenant index', async () => {
      const attempt = (query: string) => pool.query(query).then(() => 'accepted', reasonOf);
      const t = tenant();
      const r = await confirmedFor(t);
      const set = (assignment: string, id = r.id) => attempt(`UPDATE rent_payment_reconciliation SET ${assignment} WHERE id = '${id}'`);
      expect(await set(`mre_write_back_state = 'PENDING', version = version + 1`)).toBe('rent_payment_reconciliation_write_back_fields');
      expect(await set(`mre_write_back_state = 'REMOVAL_REQUIRED', version = version + 1`)).toBe('is not a step');
      // The CHECK behind the trigger, in a rolled-back transaction without the frozen trigger.
      const unguarded = async (query: string) => {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          await client.query('ALTER TABLE rent_payment_reconciliation DISABLE TRIGGER rent_payment_reconciliation_frozen');
          return await client.query(query).then(() => 'accepted', reasonOf);
        } finally {
          await client.query('ROLLBACK');
          client.release();
        }
      };
      expect(
        await unguarded(`UPDATE rent_payment_reconciliation SET mre_write_back_state = 'REMOVAL_REQUIRED', mre_last_lease_until = now() WHERE id = '${r.id}'`),
      ).toBe('rent_payment_reconciliation_write_back_state');
      expect(
        await unguarded(`UPDATE rent_payment_reconciliation SET status = 'RELEASED', released_at = now(), released_by = 'x', release_reason = 'x', mre_write_back_state = 'FAILED',
          mre_write_back_error = 'MRE_UNAVAILABLE', mre_write_back_failed_at = now(), mre_last_lease_until = now() WHERE id = '${r.id}'`),
      ).toBe('rent_payment_reconciliation_write_back_state');
      expect(await unguarded(`UPDATE rent_payment_reconciliation SET mre_written_back_at = now() WHERE id = '${r.id}'`)).toBe(
        'rent_payment_reconciliation_write_back_fields',
      );
      // WRITTEN with a time and actor but without the payment snapshot.
      expect(
        await unguarded(
          `UPDATE rent_payment_reconciliation SET mre_write_back_state = 'WRITTEN', mre_written_back_at = now(), mre_written_back_by = 'x' WHERE id = '${r.id}'`,
        ),
      ).toBe('rent_payment_reconciliation_write_back_fields');
      expect(
        await unguarded(
          `UPDATE rent_payment_reconciliation SET mre_write_back_state = 'FAILED', mre_write_back_error = 'GUESS', mre_write_back_failed_at = now() WHERE id = '${r.id}'`,
        ),
      ).toBe('rent_payment_reconciliation_mre_write_back_error_check');
      expect(
        await set(`mre_write_back_state = 'WRITTEN', mre_written_back_at = now(), mre_written_back_by = 'x', mre_payment = '{}', version = version + 1`),
      ).toBe('is not a step');
      expect(
        await set(`mre_write_back_state = 'FAILED', mre_write_back_error = 'MRE_UNAVAILABLE', mre_write_back_failed_at = now(), version = version + 1`),
      ).toBe('is not a step');
      expect(
        await set(
          pendingStep(r.id)
            .replace(/^UPDATE rent_payment_reconciliation SET /, '')
            .replace(/ WHERE id = .*$/s, '')
            .replace('version = version + 1', 'version = version'),
        ),
      ).toBe('is not a step');
      expect(
        await set(
          `${pendingStep(r.id)
            .replace(/^UPDATE rent_payment_reconciliation SET /, '')
            .replace(/ WHERE id = .*$/s, '')}, confirmed_by = 'y'`,
        ),
      ).toBe('is not a step');
      expect(await attempt(pendingStep(r.id))).toBe('accepted');
      // A live lease: no second PENDING step on the row, no release, no second PENDING of the Tenant.
      expect(await attempt(pendingStep(r.id))).toBe('is not a step');
      expect(await attempt(releaseStep(r.id))).toBe('(WRITE_BACK_IN_PROGRESS)');
      const other = await confirmedFor(t, '2027020100');
      expect(await attempt(pendingStep(other.id))).toBe('rent_payment_reconciliation_write_back_tenant_key');
      expect(
        await set(
          `mre_write_back_state = 'WRITTEN', mre_write_back_attempt_id = NULL, mre_write_back_lease_until = NULL, mre_written_back_at = now(), mre_written_back_by = 'x', mre_payment = '{}', version = version + 1`,
        ),
      ).toBe('accepted');
      expect(await attempt(pendingStep(r.id))).toBe('is not a step');
      // The release must carry the state to REMOVAL_REQUIRED, and keep the snapshot.
      expect(await attempt(releaseStep(r.id))).toBe('released with write-back');
      expect(
        await attempt(
          releaseStep(r.id).replace(
            'version = version + 1',
            `mre_write_back_state = 'REMOVAL_REQUIRED', mre_payment = NULL, mre_written_back_at = NULL, mre_written_back_by = NULL, version = version + 1`,
          ),
        ),
      ).toBe('released with write-back');
      expect(await attempt(releaseStep(r.id).replace('version = version + 1', `mre_write_back_state = 'REMOVAL_REQUIRED', version = version + 1`))).toBe(
        'accepted',
      );
      // Other status steps keep NOT_WRITTEN; a row is born NOT_WRITTEN.
      const s = (
        await pool.query(`${rawInsert(await transaction(), '800.00', '2027030100', 'SUGGESTED').replace(`'${TENANT}'`, `'${tenant()}'`)} RETURNING id`)
      ).rows[0].id as string;
      expect(
        await attempt(
          `UPDATE rent_payment_reconciliation SET status = 'CONFIRMED', confirmed_at = now(), confirmed_by = 'x', mre_write_back_state = 'REMOVAL_REQUIRED', version = version + 1 WHERE id = '${s}'`,
        ),
      ).toBe('with write-back REMOVAL_REQUIRED');
    });
  });

  describe('removal from MRE (§37.5)', () => {
    let next = 0;
    const tenant = () => `6512f0c2a1b2c3d4e5f6${(0xd100 + next++).toString(16)}`;
    const written = { date: '03/01/2027', amount: eur('800.00'), type: 'transfer', reference: 'DE-RPR-x' };
    const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const confirmedFor = async (tenantId: string, term = '2027010100') => created(match(await transaction(), '800.00', term, tenantId));
    /** Written back under a lease of `leaseMs` (its end is the last lease), then released: REMOVAL_REQUIRED. */
    const releasedWritten = async (tenantId: string, leaseMs = 1, term = '2027010100') => {
      const r = await confirmedFor(tenantId, term);
      const claim = await repository.claimWriteBack(r.id, REALM, leaseMs, actor);
      if (claim.kind !== 'CLAIMED') throw new Error(claim.kind);
      await repository.recordWriteBack(r.id, REALM, claim.attemptId, { kind: 'WRITTEN', payment: written, patched: true }, actor);
      const released = await repository.release(r.id, REALM, 'falscher Monat', new Date(), actor);
      if (released.kind !== 'RELEASED') throw new Error(released.kind);
      return released.reconciliation;
    };
    const removing = async (id: string, leaseMs = 60_000) => {
      const outcome = await repository.claimRemoval(id, REALM, leaseMs, 0, actor);
      if (outcome.kind !== 'CLAIMED') throw new Error(JSON.stringify(outcome));
      return outcome;
    };

    it('claim → REMOVING; record REMOVED with its actor and time, the payment snapshot and the last lease kept; a repeat is UNCHANGED; AuditRecords', async () => {
      const r = await releasedWritten(tenant());
      const lastLease = r.mreLastLeaseUntil;
      expect(lastLease).not.toBeNull();
      const claim = await removing(r.id);
      expect(claim).toMatchObject({ bookingDate: '2027-01-03', reconciliation: { mreWriteBackState: 'REMOVING', mreWriteBackAttemptId: claim.attemptId } });
      expect(claim.reconciliation.mreLastLeaseUntil).toEqual(claim.reconciliation.mreWriteBackLeaseUntil);
      expect(await repository.recordRemoval(r.id, REALM, '00000000-0000-4000-8000-000000000000', { kind: 'REMOVED', patched: true }, actor)).toEqual({
        kind: 'LEASE_LOST',
      });
      const done = await repository.recordRemoval(r.id, REALM, claim.attemptId, { kind: 'REMOVED', patched: true }, actor);
      expect(done).toMatchObject({
        kind: 'RECORDED',
        reconciliation: {
          status: 'RELEASED',
          mreWriteBackState: 'REMOVED',
          mreRemovedBy: actor.actorId,
          mrePayment: written,
          mreWriteBackAttemptId: null,
          mreWriteBackLeaseUntil: null,
        },
      });
      if (done.kind !== 'RECORDED') throw new Error(done.kind);
      expect(done.reconciliation.mreLastLeaseUntil).toEqual(claim.reconciliation.mreLastLeaseUntil);
      expect(await repository.claimRemoval(r.id, REALM, 60_000, 0, actor)).toMatchObject({ kind: 'UNCHANGED' });
      const audit = await pool.query(
        `SELECT action, metadata FROM audit_record WHERE entity_id = $1 AND action IN ('REMOVAL_STARTED', 'REMOVED') ORDER BY occurred_at`,
        [r.id],
      );
      expect(audit.rows.map((a) => a.action)).toEqual(['REMOVAL_STARTED', 'REMOVED']);
      expect(audit.rows[1].metadata).toMatchObject({ attemptId: claim.attemptId, patched: true });
    });

    it('refusals: unknown or foreign, CONFIRMED, NOT_WRITTEN, too early, If-Match; REMOVAL_FAILED claimed again; NOT_REMOVED back to REMOVAL_REQUIRED', async () => {
      const r = await releasedWritten(tenant());
      expect(await repository.claimRemoval(r.id, OTHER_REALM, 60_000, 0, actor)).toEqual({ kind: 'NOT_FOUND' });
      expect(await repository.claimRemoval((await confirmedFor(tenant())).id, REALM, 60_000, 0, actor)).toEqual({
        kind: 'NOT_REMOVABLE',
        status: 'CONFIRMED',
        mreWriteBackState: 'NOT_WRITTEN',
      });
      const plain = await confirmedFor(tenant());
      await repository.release(plain.id, REALM, 'x', new Date(), actor);
      expect(await repository.claimRemoval(plain.id, REALM, 60_000, 0, actor)).toEqual({
        kind: 'NOT_REMOVABLE',
        status: 'RELEASED',
        mreWriteBackState: 'NOT_WRITTEN',
      });
      expect(await repository.claimRemoval(r.id, REALM, 60_000, 0, actor, [1])).toMatchObject({ kind: 'VERSION_CONFLICT' });
      // The margin past the last lease (review on #82).
      const tooEarly = await repository.claimRemoval(r.id, REALM, 60_000, 3_600_000, actor);
      expect(tooEarly).toEqual({ kind: 'REMOVAL_TOO_EARLY', notBefore: new Date((r.mreLastLeaseUntil?.getTime() ?? 0) + 3_600_000) });
      const first = await removing(r.id);
      expect(await repository.recordRemoval(r.id, REALM, first.attemptId, { kind: 'FAILED', error: 'MRE_UNAVAILABLE' }, actor)).toMatchObject({
        reconciliation: { mreWriteBackState: 'REMOVAL_FAILED', mreWriteBackError: 'MRE_UNAVAILABLE' },
      });
      // The second claim waits for the first removal's lease: its last lease end is now an hour ahead.
      expect((await repository.claimRemoval(r.id, REALM, 60_000, 0, actor)).kind).toBe('REMOVAL_TOO_EARLY');
      const r2 = await releasedWritten(tenant());
      const shortClaim = await removing(r2.id, 1);
      await repository.recordRemoval(r2.id, REALM, shortClaim.attemptId, { kind: 'FAILED', error: 'MRE_UNAVAILABLE' }, actor);
      await pause(10);
      const again = await removing(r2.id, 1);
      expect(again.reconciliation).toMatchObject({ mreWriteBackState: 'REMOVING', mreWriteBackError: null });
      expect(await repository.recordRemoval(r2.id, REALM, again.attemptId, { kind: 'NOT_REMOVED' }, actor)).toMatchObject({
        reconciliation: { mreWriteBackState: 'REMOVAL_REQUIRED' },
      });
    });

    it('takeovers: its own expired REMOVING; another removal of the Tenant fails it (REMOVAL_FAILED); a write-back of the Tenant fails it too (review on #84); a live one blocks both', async () => {
      const t = tenant();
      const r = await releasedWritten(t);
      const old = await removing(r.id, 1);
      await pause(20);
      const retry = await removing(r.id, 1);
      expect(retry.attemptId).not.toBe(old.attemptId);
      expect(await repository.recordRemoval(r.id, REALM, old.attemptId, { kind: 'REMOVED', patched: true }, actor)).toEqual({ kind: 'LEASE_LOST' });
      await pause(20);
      // A write-back of another reconciliation of the Tenant: the expired removal is failed in its claim.
      const other = await confirmedFor(t, '2027020100');
      const wb = await repository.claimWriteBack(other.id, REALM, 60_000, actor);
      expect(wb.kind).toBe('CLAIMED');
      expect(await repository.findById(r.id, REALM)).toMatchObject({
        mreWriteBackState: 'REMOVAL_FAILED',
        mreWriteBackError: 'LEASE_EXPIRED',
        mreWriteBackAttemptId: null,
      });
      const audit = await pool.query(`SELECT metadata FROM audit_record WHERE entity_id = $1 AND action = 'WRITE_BACK_ABANDONED'`, [r.id]);
      expect(audit.rows).toEqual([{ metadata: expect.objectContaining({ attemptId: retry.attemptId, takenOverBy: other.id, from: 'REMOVING' }) }]);
      // That write-back's live lease blocks a removal of the Tenant, and the reverse.
      expect(await repository.claimRemoval(r.id, REALM, 60_000, 0, actor)).toEqual({ kind: 'WRITE_BACK_IN_PROGRESS', reconciliationId: other.id });
      const t2 = tenant();
      const live = await releasedWritten(t2);
      await removing(live.id);
      const blocked = await confirmedFor(t2, '2027030100');
      expect(await repository.claimWriteBack(blocked.id, REALM, 60_000, actor)).toEqual({ kind: 'WRITE_BACK_IN_PROGRESS', reconciliationId: live.id });
      // Another removal of the Tenant fails an expired REMOVING.
      const t3 = tenant();
      const a = await releasedWritten(t3);
      const b = await releasedWritten(t3, 1, '2027020100');
      await removing(a.id, 1);
      await pause(20);
      expect((await removing(b.id)).reconciliation.mreWriteBackState).toBe('REMOVING');
      expect(await repository.findById(a.id, REALM)).toMatchObject({ mreWriteBackState: 'REMOVAL_FAILED', mreWriteBackError: 'LEASE_EXPIRED' });
    });

    it('release on the database clock (review on #83): an application clock running ahead does not turn a live lease into a 500', async () => {
      const r = await confirmedFor(tenant());
      await repository.claimWriteBack(r.id, REALM, 60_000, actor);
      const ahead = new Date(Date.now() + 3_600_000);
      expect(await repository.release(r.id, REALM, 'x', ahead, actor)).toEqual({ kind: 'WRITE_BACK_IN_PROGRESS', reconciliationId: r.id });
    });

    it('release on the database clock (review on #85): a lease expired in database time releases although the application clock runs behind', async () => {
      const r = await confirmedFor(tenant());
      await repository.claimWriteBack(r.id, REALM, 50, actor);
      await new Promise((resolve) => setTimeout(resolve, 80));
      const behind = new Date(Date.now() - 3_600_000);
      const outcome = await repository.release(r.id, REALM, 'x', behind, actor);
      expect(outcome).toMatchObject({ kind: 'RELEASED', changed: true, reconciliation: { status: 'RELEASED', mreWriteBackState: 'REMOVAL_REQUIRED' } });
    });

    it('schema (0033): the removal steps, the last lease end, the removed fields, the states per status, the Tenant index over REMOVING', async () => {
      const attempt = (query: string) => pool.query(query).then(() => 'accepted', reasonOf);
      const t = tenant();
      const r = await releasedWritten(t, 60_000);
      const set = (assignment: string, id = r.id) => attempt(`UPDATE rent_payment_reconciliation SET ${assignment} WHERE id = '${id}'`);
      const removingStep = `mre_write_back_state = 'REMOVING', mre_write_back_attempt_id = gen_random_uuid(), mre_write_back_lease_until = now() + interval '1 hour',
        mre_last_lease_until = greatest(mre_last_lease_until, now() + interval '1 hour'), version = version + 1`;
      // Before the last lease end the database refuses the claim.
      expect(await set(removingStep)).toBe('is not a step');
      expect(await set(`mre_last_lease_until = now() - interval '1 second', version = version + 1`)).toBe('mre_last_lease_until changed outside a claim');
      const p = await releasedWritten(t, 1, '2027020100');
      const q = await releasedWritten(t, 1, '2027030100');
      expect(
        await set(
          removingStep.replace("mre_last_lease_until = greatest(mre_last_lease_until, now() + interval '1 hour')", 'mre_last_lease_until = now()'),
          p.id,
        ),
      ).toBe('a claim sets mre_last_lease_until to the latest lease');
      expect(await set(`${removingStep}, mre_payment = NULL, mre_written_back_at = NULL, mre_written_back_by = NULL`, p.id)).toBe('is not a step');
      expect(await set(removingStep, p.id)).toBe('accepted');
      // A second REMOVING of the Tenant: the index.
      expect(await set(removingStep, q.id)).toBe('rent_payment_reconciliation_write_back_tenant_key');
      expect(
        await set(`mre_write_back_state = 'REMOVED', mre_write_back_attempt_id = NULL, mre_write_back_lease_until = NULL, version = version + 1`, p.id),
      ).toBe('rent_payment_reconciliation_write_back_fields');
      expect(
        await set(
          `mre_write_back_state = 'REMOVED', mre_removed_by = 'x', mre_write_back_attempt_id = NULL, mre_write_back_lease_until = NULL, version = version + 1`,
          p.id,
        ),
      ).toBe('rent_payment_reconciliation_write_back_fields');
      expect(
        await set(`mre_write_back_state = 'WRITTEN', mre_write_back_attempt_id = NULL, mre_write_back_lease_until = NULL, version = version + 1`, p.id),
      ).toBe('is not a step');
      expect(
        await set(
          `mre_write_back_state = 'REMOVED', mre_removed_at = now(), mre_removed_by = 'x', mre_write_back_attempt_id = NULL, mre_write_back_lease_until = NULL, version = version + 1`,
          p.id,
        ),
      ).toBe('accepted');
      expect(await set(removingStep, p.id)).toBe('is not a step');
      // REMOVING on a CONFIRMED row: not a step.
      const c = await confirmedFor(tenant());
      expect(await set(removingStep, c.id)).toBe('is not a step');
      // Past the trigger: a REMOVAL_REQUIRED without its last lease end, and REMOVING on a CONFIRMED row (review on #84).
      const unguarded = async (query: string) => {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          await client.query('ALTER TABLE rent_payment_reconciliation DISABLE TRIGGER rent_payment_reconciliation_frozen');
          return await client.query(query).then(() => 'accepted', reasonOf);
        } finally {
          await client.query('ROLLBACK');
          client.release();
        }
      };
      expect(await unguarded(`UPDATE rent_payment_reconciliation SET mre_last_lease_until = NULL WHERE id = '${r.id}'`)).toBe(
        'rent_payment_reconciliation_write_back_fields',
      );
      expect(
        await unguarded(`UPDATE rent_payment_reconciliation SET mre_write_back_state = 'REMOVING', mre_write_back_attempt_id = gen_random_uuid(), mre_write_back_lease_until = now(),
          mre_last_lease_until = now() WHERE id = '${c.id}'`),
      ).toBe('rent_payment_reconciliation_write_back_state');
    });

    it('concurrency: a removal waiting on a write-back of the same Tenant (RC, the index); two removals of one reconciliation (RR past the repository: 40001)', async () => {
      const t = tenant();
      const wb = await confirmedFor(t);
      const r = await releasedWritten(t, 1, '2027020100');
      const holder = await pool.connect();
      try {
        await holder.query('BEGIN');
        await holder.query(
          `UPDATE rent_payment_reconciliation SET mre_write_back_state = 'PENDING', mre_write_back_attempt_id = gen_random_uuid(), mre_write_back_lease_until = now() + interval '1 hour',
             mre_last_lease_until = greatest(mre_last_lease_until, now() + interval '1 hour'), version = version + 1 WHERE id = '${wb.id}'`,
        );
        const removal = repository.claimRemoval(r.id, REALM, 60_000, 0, actor);
        await waitForLocks(pool);
        await holder.query('COMMIT');
        expect(await removal).toEqual({ kind: 'WRITE_BACK_IN_PROGRESS', reconciliationId: wb.id });
      } finally {
        holder.release();
      }
      const s2 = await releasedWritten(tenant());
      const step = `UPDATE rent_payment_reconciliation SET mre_write_back_state = 'REMOVING', mre_write_back_attempt_id = gen_random_uuid(),
        mre_write_back_lease_until = now() + interval '1 hour', mre_last_lease_until = greatest(mre_last_lease_until, now() + interval '1 hour'), version = version + 1 WHERE id = '${s2.id}'`;
      const [one, two] = [await pool.connect(), await pool.connect()];
      try {
        await one.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
        await one.query('SELECT 1');
        await two.query('BEGIN ISOLATION LEVEL READ COMMITTED');
        await two.query(step);
        const later = one.query(step).then(
          () => 'written',
          (e: { code?: string }) => e.code,
        );
        await waitForLocks(pool);
        await two.query('COMMIT');
        expect(await later).toBe('40001');
      } finally {
        await one.query('ROLLBACK');
        one.release();
        two.release();
      }
    });
  });
});
