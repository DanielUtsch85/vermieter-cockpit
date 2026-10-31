import type pg from 'pg';
import { beforeAll, describe, expect, it } from 'vitest';
import { deriveRate } from '../../domains/depreciation/index.js';
import type { SplitInput } from '../../domains/ledger/index.js';
import { TAX_RULES } from '../../domains/tax-rules/index.js';
import { RuleRegistry, type RuleRef } from '../../shared/index.js';
import type { PostgresAcquisitionRepository } from './acquisition-repository.js';
import { createDatabase } from './database.js';
import type { PostgresDepreciationAssetRepository } from './depreciation-asset-repository.js';
import {
  OTHER_REALM,
  REALM,
  actor,
  codeOf,
  databaseUrl,
  day,
  eur,
  evidence,
  messageOf,
  registry,
  useDepreciationAssetDatabase,
  waitUntil,
  type Queryable,
} from './depreciation-asset.test-support.js';
import { PostgresFinancialAccountRepository } from './financial-account-repository.js';
import { PostgresTaxClassificationRepository } from './tax-classification-repository.js';
import { checkStoredRuleReferences } from './tax-rule-check.js';
import { PostgresTransactionRepository } from './transaction-repository.js';
import { PostgresTransactionSplitRepository } from './transaction-split-repository.js';

/**
 * VC-8-01 persistence (api-design.md §59, migration 0049): the commands in their order of checks with their
 * AuditRecords, the amend as a difference against the guard `depreciation_asset_useful_life_open` (the row of an
 * unchanged entry keeps its `xmin`), the concurrency of §59 under READ COMMITTED and REPEATABLE READ, the reads, the
 * start check with Depreciation's source and "no cash mutated". The schema past the repository and `up`/`down` are in
 * `depreciation-asset-schema.test.ts`, the setup in `depreciation-asset.test-support.ts`. Figures, names and texts are
 * synthetic.
 */
let counter = 0;

describe.skipIf(databaseUrl === undefined)('PostgresDepreciationAssetRepository (§59)', () => {
  const { ctx, propertyReference, party, acquisition, cancel, life, building, created, audit, xminOf, insertAsset, insertLife, blockedBy, holding } =
    useDepreciationAssetDatabase('depreciation_test');
  let pool: pg.Pool;
  let acquisitions: PostgresAcquisitionRepository;
  let assets: PostgresDepreciationAssetRepository;
  beforeAll(() => {
    ({ pool, acquisitions, assets } = ctx);
  });

  describe('create (§59)', () => {
    it('creates ACTIVE with version 1, the entries in acquisitionId order; AuditRecord CREATED with every stored field and each entry', async () => {
      const pr = await propertyReference();
      const [a1, a2] = [await acquisition(pr), await acquisition(pr)].sort();
      const advisor = await party();
      const asset = await created(
        building(pr, {
          reviewState: 'ADVISOR_CONFIRMED',
          advisorPartyId: advisor,
          notes: 'Baujahr laut Anlage',
          shorterUsefulLives: [life(a2 as string, { reviewState: 'ADVISOR_CONFIRMED', advisorPartyId: advisor }), life(a1 as string)],
        }),
      );
      expect(asset).toMatchObject({
        mreRealmId: REALM,
        propertyReferenceId: pr,
        assetType: 'BUILDING',
        status: 'ACTIVE',
        buildingCompletionYear: 1995,
        depreciationMethod: 'LINEAR_7_4',
        reviewState: 'ADVISOR_CONFIRMED',
        advisorPartyId: advisor,
        voidedAt: null,
        voidReason: null,
        version: 1,
      });
      expect(asset.shorterUsefulLives).toEqual([life(a1 as string), life(a2 as string, { reviewState: 'ADVISOR_CONFIRMED', advisorPartyId: advisor })]);
      const [record] = await audit(asset.id);
      expect(record).toMatchObject({ action: 'CREATED', actor_id: 'anna@example.com', previous_version: null, new_version: 1 });
      expect(record?.metadata).toEqual({
        propertyReferenceId: pr,
        assetType: 'BUILDING',
        buildingCompletionYear: 1995,
        sourceReferences: ['Teilungserklärung, Baujahr laut Anlage 1'],
        depreciationMethod: 'LINEAR_7_4',
        reviewState: 'ADVISOR_CONFIRMED',
        advisorPartyId: advisor,
        shorterUsefulLives: JSON.parse(JSON.stringify(asset.shorterUsefulLives)),
        notes: 'Baujahr laut Anlage',
      });
    });

    it('order of checks: PropertyReference (404), advisor (404), the entries’ Acquisitions (404, 422, 409), BUILDING_ASSET_EXISTS; nothing written', async () => {
      const pr = await propertyReference();
      const otherPr = await propertyReference();
      const foreignPr = await propertyReference(OTHER_REALM);
      const draft = await acquisition(pr);
      const elsewhere = await acquisition(otherPr);
      const cancelled = await acquisition(pr);
      await cancel(cancelled);
      const foreignParty = await party('Fremd', OTHER_REALM);
      const unknown = '0000aaaa-0000-4000-8000-0000000000ff';
      const auditBefore = (await pool.query(`SELECT count(*)::int AS n FROM audit_record WHERE entity_type = 'DepreciationAsset'`)).rows[0].n;

      expect(await assets.create(building(foreignPr, { reviewState: 'ADVISOR_CONFIRMED', advisorPartyId: foreignParty }), actor)).toEqual({
        kind: 'PROPERTY_REFERENCE_NOT_FOUND',
      });
      expect(await assets.create(building(unknown), actor)).toEqual({ kind: 'PROPERTY_REFERENCE_NOT_FOUND' });
      expect(
        await assets.create(building(pr, { shorterUsefulLives: [life(unknown, { reviewState: 'ADVISOR_CONFIRMED', advisorPartyId: foreignParty })] }), actor),
      ).toEqual({ kind: 'PARTY_NOT_FOUND', partyId: foreignParty });
      expect(await assets.create(building(pr, { shorterUsefulLives: [life(cancelled), life(elsewhere), life(unknown)] }), actor)).toEqual({
        kind: 'ACQUISITION_NOT_FOUND',
        acquisitionId: unknown,
      });
      expect(await assets.create(building(pr, { shorterUsefulLives: [life(cancelled), life(elsewhere)] }), actor)).toEqual({
        kind: 'ACQUISITION_NOT_OF_PROPERTY',
        acquisitionId: elsewhere,
        propertyReferenceId: otherPr,
      });
      expect(await assets.create(building(pr, { shorterUsefulLives: [life(draft), life(cancelled)] }), actor)).toEqual({
        kind: 'ACQUISITION_CANCELLED',
        acquisitionId: cancelled,
      });
      // An Acquisition of another Realm reads as unknown.
      const foreignAcquisition = await acquisition(foreignPr, OTHER_REALM);
      expect(await assets.create(building(pr, { shorterUsefulLives: [life(foreignAcquisition)] }), actor)).toEqual({
        kind: 'ACQUISITION_NOT_FOUND',
        acquisitionId: foreignAcquisition,
      });
      expect((await pool.query(`SELECT count(*)::int AS n FROM depreciation_asset WHERE property_reference_id = $1`, [pr])).rows[0].n).toBe(0);
      const first = await created(building(pr, { shorterUsefulLives: [life(draft)] }));
      expect(await assets.create(building(pr), actor)).toEqual({ kind: 'BUILDING_ASSET_EXISTS', assetId: first.id });
      // The PropertyReference's externalReferenceState does not matter (data-model §9).
      const lost = await propertyReference();
      await pool.query(`UPDATE property_reference SET external_reference_state = 'DELETED_UPSTREAM' WHERE id = $1`, [lost]);
      expect((await assets.create(building(lost), actor)).kind).toBe('CREATED');
      const auditAfter = (await pool.query(`SELECT count(*)::int AS n FROM audit_record WHERE entity_type = 'DepreciationAsset'`)).rows[0].n;
      expect(auditAfter - auditBefore).toBe(2);
    });

    it('Idempotency-Key: a replay answers the recorded asset; another payload is IDEMPOTENCY_CONFLICT; without a key a retry is BUILDING_ASSET_EXISTS', async () => {
      const pr = await propertyReference();
      const key = { key: `k-${++counter}`, fingerprint: 'f-1' };
      const first = await assets.create(building(pr), actor, key);
      if (first.kind !== 'CREATED') throw new Error(first.kind);
      // The asset changes after; the replay still answers the result as first recorded.
      expect((await assets.amend(first.asset.id, REALM, { notes: 'später' }, actor)).kind).toBe('AMENDED');
      expect(await assets.create(building(pr), actor, key)).toEqual({ kind: 'REPLAYED', asset: first.asset });
      expect(await assets.create(building(pr, { buildingCompletionYear: 1996 }), actor, { ...key, fingerprint: 'f-2' })).toEqual({
        kind: 'IDEMPOTENCY_CONFLICT',
      });
      expect(await assets.create(building(pr), actor)).toEqual({ kind: 'BUILDING_ASSET_EXISTS', assetId: first.asset.id });
      // A refused create under a key leaves the key unclaimed: the rollback takes it.
      const refusedKey = { key: `k-${++counter}`, fingerprint: 'f-3' };
      expect((await assets.create(building(pr), actor, refusedKey)).kind).toBe('BUILDING_ASSET_EXISTS');
      expect((await pool.query(`SELECT count(*)::int AS n FROM idempotency_key WHERE key = $1`, [refusedKey.key])).rows[0].n).toBe(0);
    });
  });

  describe('amend (§59)', () => {
    it('the year resets the asset to UNREVIEWED and clears the advisor (AuditRecord with the reset); NEEDS_REVIEW kept when named', async () => {
      const pr = await propertyReference();
      const advisor = await party();
      const asset = await created(building(pr, { reviewState: 'ADVISOR_CONFIRMED', advisorPartyId: advisor }));
      const outcome = await assets.amend(asset.id, REALM, { buildingCompletionYear: 1994, sourceReferences: ['Grundbuchauszug, Baujahr 1994'] }, actor, [1]);
      expect(outcome).toMatchObject({
        kind: 'AMENDED',
        changed: true,
        asset: { buildingCompletionYear: 1994, reviewState: 'UNREVIEWED', advisorPartyId: null, version: 2 },
      });
      const [, amended] = await audit(asset.id);
      expect(amended).toMatchObject({ action: 'AMENDED', previous_version: 1, new_version: 2 });
      expect(amended?.metadata).toEqual({
        changes: {
          buildingCompletionYear: { from: 1995, to: 1994 },
          sourceReferences: { from: ['Teilungserklärung, Baujahr laut Anlage 1'], to: ['Grundbuchauszug, Baujahr 1994'] },
          reviewState: { from: 'ADVISOR_CONFIRMED', to: 'UNREVIEWED' },
          advisorPartyId: { from: advisor, to: null },
        },
        reviewStateReset: { from: 'ADVISOR_CONFIRMED', to: 'UNREVIEWED' },
      });
      expect((await assets.confirm(asset.id, REALM, { reviewState: 'CONFIRMED', advisorPartyId: null, note: null }, actor)).kind).toBe('CONFIRMED');
      expect(await assets.amend(asset.id, REALM, { buildingCompletionYear: 1993, reviewState: 'NEEDS_REVIEW' }, actor)).toMatchObject({
        asset: { reviewState: 'NEEDS_REVIEW', buildingCompletionYear: 1993 },
      });
    });

    it('entries added, changed (its state reset) and removed, written as a difference, with changedEntries', async () => {
      const pr = await propertyReference();
      const [a1, a2, a3] = (await Promise.all([acquisition(pr), acquisition(pr), acquisition(pr)])).sort();
      const asset = await created(building(pr, { shorterUsefulLives: [life(a1, { reviewState: 'CONFIRMED' }), life(a2, { reviewState: 'CONFIRMED' })] }));
      const keptRow = await xminOf(asset.id, a2);
      const outcome = await assets.amend(
        asset.id,
        REALM,
        {
          shorterUsefulLives: [
            { acquisitionId: a2, usefulLifeYears: 30, evidence },
            { acquisitionId: a3, usefulLifeYears: 25, evidence, reviewState: 'NEEDS_REVIEW' },
          ],
        },
        actor,
      );
      if (outcome.kind !== 'AMENDED') throw new Error(outcome.kind);
      expect(outcome.asset.shorterUsefulLives).toEqual([
        life(a2, { reviewState: 'CONFIRMED' }),
        life(a3, { usefulLifeYears: 25, reviewState: 'NEEDS_REVIEW' }),
      ]);
      expect(await xminOf(asset.id, a2)).toBe(keptRow);
      const changed = await assets.amend(
        asset.id,
        REALM,
        {
          shorterUsefulLives: [
            { acquisitionId: a2, usefulLifeYears: 28, evidence },
            { acquisitionId: a3, usefulLifeYears: 25, evidence, reviewState: 'NEEDS_REVIEW' },
          ],
        },
        actor,
      );
      expect(changed).toMatchObject({
        asset: { shorterUsefulLives: [{ acquisitionId: a2, usefulLifeYears: 28, reviewState: 'UNREVIEWED' }, { acquisitionId: a3 }], version: 3 },
      });
      const records = await audit(asset.id);
      expect(records.map((r) => r.action)).toEqual(['CREATED', 'AMENDED', 'AMENDED']);
      expect(records[1]?.metadata).toEqual({
        changes: {},
        changedEntries: [
          { acquisitionId: a1, change: 'REMOVED', from: JSON.parse(JSON.stringify(life(a1, { reviewState: 'CONFIRMED' }))), to: null },
          { acquisitionId: a3, change: 'ADDED', from: null, to: JSON.parse(JSON.stringify(life(a3, { usefulLifeYears: 25, reviewState: 'NEEDS_REVIEW' }))) },
        ],
      });
      expect((records[2]?.metadata['changedEntries'] as { change: string; to: { reviewState: string } }[]).map((c) => [c.change, c.to.reviewState])).toEqual([
        ['CHANGED', 'UNREVIEWED'],
      ]);
    });

    it('an unchanged entry of a later-cancelled DRAFT does not block an amend: its row untouched (xmin); a later amend removes it', async () => {
      const pr = await propertyReference();
      const [a1, a2] = (await Promise.all([acquisition(pr), acquisition(pr)])).sort();
      const asset = await created(building(pr, { shorterUsefulLives: [life(a1), life(a2)] }));
      await cancel(a1);
      const before = await xminOf(asset.id, a1);
      const amended = await assets.amend(
        asset.id,
        REALM,
        {
          notes: 'Gutachten nachgereicht',
          shorterUsefulLives: [
            { acquisitionId: a1, usefulLifeYears: 30, evidence },
            { acquisitionId: a2, usefulLifeYears: 27, evidence },
          ],
        },
        actor,
      );
      expect(amended).toMatchObject({ kind: 'AMENDED', changed: true });
      expect(await xminOf(asset.id, a1)).toBe(before);
      // The read flags it instead.
      const read = await assets.find(asset.id, REALM);
      expect(read?.cancelledAcquisitionIds).toEqual([a1]);
      expect(deriveRate(read as NonNullable<typeof read>, 2026, registry).shorterUsefulLives[0]?.reasons).toContain('ACQUISITION_CANCELLED');
      // A changed entry of the cancelled Acquisition is checked again, and refused.
      expect(
        await assets.amend(
          asset.id,
          REALM,
          {
            shorterUsefulLives: [
              { acquisitionId: a1, usefulLifeYears: 29, evidence },
              { acquisitionId: a2, usefulLifeYears: 27, evidence },
            ],
          },
          actor,
        ),
      ).toEqual({
        kind: 'ACQUISITION_CANCELLED',
        acquisitionId: a1,
      });
      // Counter-check: a delete-and-reinsert of the whole list, as a naive repository would write it, fails on the guard.
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`DELETE FROM depreciation_asset_useful_life WHERE asset_id = $1`, [asset.id]);
        expect(await messageOf(insertLife({ asset_id: asset.id, property_reference_id: pr, acquisition_id: a1 }, client))).toContain('ACQUISITION_CANCELLED');
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }
      expect(await assets.amend(asset.id, REALM, { shorterUsefulLives: [{ acquisitionId: a2, usefulLifeYears: 27, evidence }] }, actor)).toMatchObject({
        kind: 'AMENDED',
        asset: { shorterUsefulLives: [{ acquisitionId: a2 }] },
      });
    });

    it('the same values are a no-op whatever If-Match says, with no AuditRecord; a stale If-Match is VERSION_CONFLICT', async () => {
      const pr = await propertyReference();
      const asset = await created(building(pr));
      expect(await assets.amend(asset.id, REALM, { buildingCompletionYear: 1995, notes: null }, actor, [99])).toEqual({
        kind: 'AMENDED',
        asset,
        changed: false,
      });
      expect(await audit(asset.id)).toHaveLength(1);
      expect(await assets.amend(asset.id, REALM, { notes: 'neu' }, actor, [99])).toEqual({
        kind: 'VERSION_CONFLICT',
        expectedVersions: [99],
        currentVersion: 1,
      });
      expect(await assets.amend(asset.id, REALM, { notes: 'neu' }, actor, [1])).toMatchObject({ kind: 'AMENDED', asset: { notes: 'neu', version: 2 } });
    });

    it('unknown, foreign or VOID → NOT_FOUND / ASSET_NOT_ACTIVE; an advisor of another Realm on a new entry → PARTY_NOT_FOUND', async () => {
      const pr = await propertyReference();
      const a1 = await acquisition(pr);
      const asset = await created(building(pr));
      expect(await assets.amend(asset.id, OTHER_REALM, { notes: 'x' }, actor)).toEqual({ kind: 'NOT_FOUND' });
      expect(await assets.amend('not-a-uuid', REALM, { notes: 'x' }, actor)).toEqual({ kind: 'NOT_FOUND' });
      const foreign = await party('Fremd', OTHER_REALM);
      expect(
        await assets.amend(
          asset.id,
          REALM,
          { shorterUsefulLives: [{ acquisitionId: a1, usefulLifeYears: 30, evidence, reviewState: 'ADVISOR_CONFIRMED', advisorPartyId: foreign }] },
          actor,
        ),
      ).toEqual({ kind: 'PARTY_NOT_FOUND', partyId: foreign });
      expect((await assets.void(asset.id, REALM, 'falsche Einheit', new Date('2026-10-30T11:00:00Z'), actor)).kind).toBe('VOIDED');
      expect(await assets.amend(asset.id, REALM, { notes: 'x' }, actor)).toEqual({ kind: 'ASSET_NOT_ACTIVE', status: 'VOID' });
    });
  });

  describe('confirm (§59)', () => {
    it('COMPLETION_YEAR_MISSING; ADVISOR_CONFIRMED; the advisor of another Realm; the no-op; AuditRecord CONFIRMED with from, to, advisor and note', async () => {
      const pr = await propertyReference();
      const noYear = await created(building(pr, { buildingCompletionYear: null }));
      expect(await assets.confirm(noYear.id, REALM, { reviewState: 'CONFIRMED', advisorPartyId: null, note: null }, actor)).toEqual({
        kind: 'COMPLETION_YEAR_MISSING',
      });
      await assets.void(noYear.id, REALM, 'ohne Baujahr angelegt', new Date('2026-10-30T11:00:00Z'), actor);
      const asset = await created(building(pr));
      const advisor = await party();
      const foreign = await party('Fremd', OTHER_REALM);
      expect(await assets.confirm(asset.id, REALM, { reviewState: 'ADVISOR_CONFIRMED', advisorPartyId: foreign, note: null }, actor)).toEqual({
        kind: 'PARTY_NOT_FOUND',
        partyId: foreign,
      });
      const confirmed = await assets.confirm(
        asset.id,
        REALM,
        { reviewState: 'ADVISOR_CONFIRMED', advisorPartyId: advisor, note: 'Baujahr mit Teilungserklärung abgeglichen' },
        actor,
        [1],
      );
      expect(confirmed).toMatchObject({ kind: 'CONFIRMED', changed: true, asset: { reviewState: 'ADVISOR_CONFIRMED', advisorPartyId: advisor, version: 2 } });
      expect((await audit(asset.id))[1]).toMatchObject({
        action: 'CONFIRMED',
        previous_version: 1,
        new_version: 2,
        metadata: { from: 'UNREVIEWED', to: 'ADVISOR_CONFIRMED', advisorPartyId: advisor, note: 'Baujahr mit Teilungserklärung abgeglichen' },
      });
      expect(await assets.confirm(asset.id, REALM, { reviewState: 'CONFIRMED', advisorPartyId: null, note: null }, actor)).toEqual({
        kind: 'ADVISOR_CONFIRMED',
      });
      expect(
        await assets.confirm(asset.id, REALM, { reviewState: 'ADVISOR_CONFIRMED', advisorPartyId: advisor, note: 'noch einmal' }, actor, [1]),
      ).toMatchObject({
        kind: 'CONFIRMED',
        changed: false,
      });
      expect(await audit(asset.id)).toHaveLength(2);
      expect(await assets.confirm(asset.id, REALM, { reviewState: 'ADVISOR_CONFIRMED', advisorPartyId: null, note: null }, actor, [1])).toEqual({
        kind: 'VERSION_CONFLICT',
        expectedVersions: [1],
        currentVersion: 2,
      });
      expect(await assets.confirm(asset.id, OTHER_REALM, { reviewState: 'CONFIRMED', advisorPartyId: null, note: null }, actor)).toEqual({ kind: 'NOT_FOUND' });
    });
  });

  describe('void (§59)', () => {
    it('VOID with time and reason; the no-op keeps the first reason whatever If-Match says; a new building after a void', async () => {
      const pr = await propertyReference();
      const asset = await created(building(pr));
      const at = new Date('2026-10-30T12:00:00Z');
      expect(await assets.void(asset.id, REALM, 'falsche Einheit', at, actor, [7])).toEqual({
        kind: 'VERSION_CONFLICT',
        expectedVersions: [7],
        currentVersion: 1,
      });
      expect(await assets.void(asset.id, REALM, 'falsche Einheit', at, actor, [1])).toMatchObject({
        kind: 'VOIDED',
        changed: true,
        asset: { status: 'VOID', voidedAt: at, voidReason: 'falsche Einheit', version: 2 },
      });
      expect(await assets.void(asset.id, REALM, 'anderer Grund', new Date('2026-10-31T12:00:00Z'), actor, [99])).toMatchObject({
        kind: 'VOIDED',
        changed: false,
        asset: { voidedAt: at, voidReason: 'falsche Einheit', version: 2 },
      });
      expect((await audit(asset.id)).map((r) => [r.action, r.metadata])).toEqual([
        ['CREATED', expect.anything()],
        ['VOIDED', { reason: 'falsche Einheit' }],
      ]);
      expect((await assets.create(building(pr), actor)).kind).toBe('CREATED');
      expect(await assets.void(asset.id, OTHER_REALM, 'x', at, actor)).toEqual({ kind: 'NOT_FOUND' });
    });
  });

  describe('reads (§59)', () => {
    it('find and the per-property list: Realm-scoped, VOID included unless filtered, ordered by type, creation, id', async () => {
      const pr = await propertyReference();
      const voided = await created(building(pr));
      await assets.void(voided.id, REALM, 'doppelt', new Date('2026-10-30T12:00:00Z'), actor);
      const active = await created(building(pr));
      expect((await assets.find(active.id, REALM))?.asset).toEqual(active);
      expect(await assets.find(active.id, OTHER_REALM)).toBeUndefined();
      expect((await assets.listForPropertyReference(pr, REALM, null))?.map((r) => r.asset.id)).toEqual([voided.id, active.id]);
      expect((await assets.listForPropertyReference(pr, REALM, ['ACTIVE']))?.map((r) => r.asset.id)).toEqual([active.id]);
      expect((await assets.listForPropertyReference(pr, REALM, ['VOID']))?.map((r) => r.asset.id)).toEqual([voided.id]);
      expect(await assets.listForPropertyReference(pr, OTHER_REALM, null)).toBeUndefined();
      // A foreign asset on a PropertyReference of this Realm is impossible (composite key); the list reads this Realm only.
      const foreignPr = await propertyReference(OTHER_REALM);
      await assets.create(building(foreignPr, { mreRealmId: OTHER_REALM }), actor);
      expect(await assets.listForPropertyReference(foreignPr, REALM, null)).toBeUndefined();
    });

    it('a read runs READ ONLY: a write inside its snapshot is refused', async () => {
      const { depreciationSnapshot } = await import('./depreciation-asset-repository.js');
      const db = createDatabase(pool);
      expect(
        await codeOf(
          depreciationSnapshot(db, (trx) =>
            trx.updateTable('depreciation_asset').set({ notes: 'x' }).where('id', '=', '00000000-0000-4000-8000-000000000000').execute(),
          ),
        ),
      ).toBe('25006');
    });
  });

  describe('concurrency (§59, P8-D14)', () => {
    it('two creates for one PropertyReference, RC: the second waits on the PropertyReference row, then sees the first one’s asset', async () => {
      const pr = await propertyReference();
      await holding(async (holder) => {
        const first = (await insertAsset({ property_reference_id: pr }, holder)).rows[0].id as string;
        const blocked = await blockedBy(holder);
        const second = assets.create(building(pr), actor);
        await waitUntil(async () => (await blocked()).some((q) => q.startsWith('update "property_reference"')));
        await holder.query('COMMIT');
        expect(await second).toEqual({ kind: 'BUILDING_ASSET_EXISTS', assetId: first });
      });
    });

    it('… RR: the second fails to serialise (40001); counter-check: without the PropertyReference write, two RC creates race to the index (23505)', async () => {
      const pr = await propertyReference();
      await holding(async (holder) => {
        await insertAsset({ property_reference_id: pr }, holder);
        const rr = await pool.connect();
        try {
          await rr.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
          await rr.query(`SELECT count(*) FROM depreciation_asset WHERE property_reference_id = $1`, [pr]);
          const touched = codeOf(rr.query(`UPDATE property_reference SET version = version WHERE id = $1`, [pr]));
          await waitUntil(async () => (await (await blockedBy(holder))()).length > 0);
          await holder.query('COMMIT');
          expect(await touched).toBe('40001');
        } finally {
          await rr.query('ROLLBACK');
          rr.release();
        }
      });
      const race = await propertyReference();
      await holding(async (holder) => {
        await insertAsset({ property_reference_id: race }, holder);
        const other = await pool.connect();
        try {
          await other.query('BEGIN');
          // Its check, without the PropertyReference write first, does not see the uncommitted asset …
          expect((await other.query(`SELECT id FROM depreciation_asset WHERE property_reference_id = $1 AND status = 'ACTIVE'`, [race])).rows).toEqual([]);
          const inserted = codeOf(insertAsset({ property_reference_id: race }, other));
          await waitUntil(async () => (await (await blockedBy(holder))()).length > 0);
          await holder.query('COMMIT');
          // … so only the partial unique index stops it; the repository answers this 23505 as BUILDING_ASSET_EXISTS too.
          expect(await inserted).toBe('23505');
        } finally {
          await other.query('ROLLBACK');
          other.release();
        }
      });
    });

    it('an entry against a cancel of its DRAFT Acquisition, cancel first: the create waits, then sees ACQUISITION_CANCELLED (RC); RR fails to serialise', async () => {
      const pr = await propertyReference();
      const draft = await acquisition(pr);
      const cancelInFlight = async (holder: Queryable) => {
        await holder.query(`UPDATE property_reference SET version = version WHERE id = $1`, [pr]);
        await holder.query(
          `UPDATE acquisition SET status = 'CANCELLED', cancelled_at = now(), cancellation_reason = 'Rücktritt', version = version + 1, updated_at = now() WHERE id = $1`,
          [draft],
        );
      };
      const second = await acquisition(pr);
      await holding(async (holder) => {
        await cancelInFlight(holder);
        const blocked = await blockedBy(holder);
        const create = assets.create(building(pr, { shorterUsefulLives: [life(draft)] }), actor);
        await waitUntil(async () => (await blocked()).some((q) => q.startsWith('update "property_reference"')));
        await holder.query('COMMIT');
        expect(await create).toEqual({ kind: 'ACQUISITION_CANCELLED', acquisitionId: draft });
      });
      // RR: a snapshot taken before the cancel commits cannot write after it.
      await holding(async (holder) => {
        await holder.query(`UPDATE property_reference SET version = version WHERE id = $1`, [pr]);
        await holder.query(
          `UPDATE acquisition SET status = 'CANCELLED', cancelled_at = now(), cancellation_reason = 'Rücktritt', version = version + 1, updated_at = now() WHERE id = $1`,
          [second],
        );
        const rr = await pool.connect();
        try {
          await rr.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
          expect((await rr.query(`SELECT status FROM acquisition WHERE id = $1`, [second])).rows[0].status).toBe('DRAFT');
          const touched = codeOf(rr.query(`UPDATE property_reference SET version = version WHERE id = $1`, [pr]));
          await waitUntil(async () => (await (await blockedBy(holder))()).length > 0);
          await holder.query('COMMIT');
          expect(await touched).toBe('40001');
        } finally {
          await rr.query('ROLLBACK');
          rr.release();
        }
      });
    });

    it('… entry first: the cancel waits, then cancels; the read flags the entry. Counter-check: a raw insert after a cancel in flight is refused by the guard', async () => {
      const pr = await propertyReference();
      const draft = await acquisition(pr);
      let assetId = '';
      await holding(async (holder) => {
        await holder.query(`UPDATE property_reference SET version = version WHERE id = $1`, [pr]);
        await holder.query(`SELECT 1 FROM acquisition WHERE id = $1 FOR SHARE`, [draft]);
        assetId = (await insertAsset({ property_reference_id: pr }, holder)).rows[0].id as string;
        await insertLife({ asset_id: assetId, property_reference_id: pr, acquisition_id: draft }, holder);
        const blocked = await blockedBy(holder);
        const cancelling = acquisitions.cancel(draft, REALM, 'Rücktritt', new Date('2026-10-30T10:00:00Z'), actor);
        await waitUntil(async () => (await blocked()).length > 0);
        await holder.query('COMMIT');
        expect((await cancelling).kind).toBe('CANCELLED');
      });
      const read = await assets.find(assetId, REALM);
      expect(read?.cancelledAcquisitionIds).toEqual([draft]);
      // Past the repository: the guard writes the PropertyReference first, waits for the cancel, and then sees it.
      const later = await acquisition(pr);
      await holding(async (holder) => {
        await holder.query(`UPDATE property_reference SET version = version WHERE id = $1`, [pr]);
        await holder.query(
          `UPDATE acquisition SET status = 'CANCELLED', cancelled_at = now(), cancellation_reason = 'Rücktritt', version = version + 1, updated_at = now() WHERE id = $1`,
          [later],
        );
        const inserted = messageOf(insertLife({ asset_id: assetId, property_reference_id: pr, acquisition_id: later }));
        await waitUntil(async () => (await (await blockedBy(holder))()).length > 0);
        await holder.query('COMMIT');
        expect(await inserted).toContain('ACQUISITION_CANCELLED');
      });
    });

    it('amend against void, both orders (RC): each waits for the other; RR fails to serialise; counter-check: the VOID row refuses a late write', async () => {
      const pr = await propertyReference();
      const asset = await created(building(pr));
      // Void first: the amend waits on the PropertyReference, then sees VOID.
      await holding(async (holder) => {
        await holder.query(`UPDATE property_reference SET version = version WHERE id = $1`, [pr]);
        await holder.query(`UPDATE depreciation_asset SET status = 'VOID', voided_at = now(), void_reason = 'x', version = version + 1 WHERE id = $1`, [
          asset.id,
        ]);
        const blocked = await blockedBy(holder);
        const amend = assets.amend(asset.id, REALM, { notes: 'zu spät' }, actor);
        await waitUntil(async () => (await blocked()).length > 0);
        await holder.query('COMMIT');
        expect(await amend).toEqual({ kind: 'ASSET_NOT_ACTIVE', status: 'VOID' });
      });
      expect(await codeOf(pool.query(`UPDATE depreciation_asset SET notes = 'zu spät', version = version + 1 WHERE id = $1`, [asset.id]))).toBe('23000');
      // Amend first: the void waits, then voids the amended row.
      const other = await created(building(await propertyReference()));
      await holding(async (holder) => {
        await holder.query(`UPDATE property_reference SET version = version WHERE id = $1`, [other.propertyReferenceId]);
        await holder.query(`UPDATE depreciation_asset SET notes = 'vorher', version = version + 1 WHERE id = $1`, [other.id]);
        const blocked = await blockedBy(holder);
        const voiding = assets.void(other.id, REALM, 'falsche Einheit', new Date('2026-10-30T12:00:00Z'), actor, [1]);
        await waitUntil(async () => (await blocked()).length > 0);
        await holder.query('COMMIT');
        // A stale If-Match is checked under the lock after a fresh read.
        expect(await voiding).toEqual({ kind: 'VERSION_CONFLICT', expectedVersions: [1], currentVersion: 2 });
      });
      // RR: a snapshot from before the void cannot write the asset after it.
      const third = await created(building(await propertyReference()));
      await holding(async (holder) => {
        await holder.query(`UPDATE property_reference SET version = version WHERE id = $1`, [third.propertyReferenceId]);
        await holder.query(`UPDATE depreciation_asset SET status = 'VOID', voided_at = now(), void_reason = 'x', version = version + 1 WHERE id = $1`, [
          third.id,
        ]);
        const rr = await pool.connect();
        try {
          await rr.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
          expect((await rr.query(`SELECT status FROM depreciation_asset WHERE id = $1`, [third.id])).rows[0].status).toBe('ACTIVE');
          const touched = codeOf(rr.query(`UPDATE property_reference SET version = version WHERE id = $1`, [third.propertyReferenceId]));
          await waitUntil(async () => (await (await blockedBy(holder))()).length > 0);
          await holder.query('COMMIT');
          expect(await touched).toBe('40001');
        } finally {
          await rr.query('ROLLBACK');
          rr.release();
        }
      });
    });
  });

  describe('the start check (§58, §59)', () => {
    const source = (refs: RuleRef[]) => ({ storedRuleReferences: () => Promise.resolve(refs) });

    // #177's counter-check named @2; VC-8-02 registers @2 (§59A "The rule versions"), so it moves to @3.
    it('a Depreciation source naming DE_AFA_BUILDING_LINEAR@3 stops the start and names it; @1 and @2 start; the real source returns [] with assets', async () => {
      const db = createDatabase(pool);
      await created(building(await propertyReference()));
      await expect(checkStoredRuleReferences(db, TAX_RULES, source([{ ruleCode: 'DE_AFA_BUILDING_LINEAR', version: 3 }]))).rejects.toThrow(
        'Stored tax rule references are not registered: DE_AFA_BUILDING_LINEAR@3',
      );
      expect(
        await checkStoredRuleReferences(
          db,
          TAX_RULES,
          source([
            { ruleCode: 'DE_AFA_BUILDING_LINEAR', version: 1 },
            { ruleCode: 'DE_AFA_BUILDING_LINEAR', version: 2 },
          ]),
        ),
      ).toEqual([
        { ruleCode: 'DE_AFA_BUILDING_LINEAR', version: 1 },
        { ruleCode: 'DE_AFA_BUILDING_LINEAR', version: 2 },
      ]);
      expect(await assets.storedRuleReferences()).toEqual([]);
      expect((await pool.query(`SELECT count(*)::int AS n FROM depreciation_asset`)).rows[0].n).toBeGreaterThan(0);
      // The default is the real source.
      expect(await checkStoredRuleReferences(db)).toEqual([]);
    });

    it("Taxation's own references are still checked: the union, not a replacement", async () => {
      const db = createDatabase(pool);
      const account = await new PostgresFinancialAccountRepository(db).create(
        { mreRealmId: REALM, accountType: 'BANK', displayName: 'Giro', currency: 'EUR', iban: null },
        actor,
      );
      if (account.kind !== 'CREATED') throw new Error(account.kind);
      const transactions = new PostgresTransactionRepository(db);
      const tx = await transactions.createManual(
        {
          mreRealmId: REALM,
          financialAccountId: account.account.id,
          amount: eur('120.00'),
          direction: 'OUTFLOW',
          bookingDate: day('2026-03-02'),
          valueDate: null,
          description: 'Handwerker',
          propertyReferenceId: null,
        },
        actor,
      );
      if (tx.kind !== 'CREATED') throw new Error(tx.kind);
      const split: SplitInput = {
        amount: eur('120.00'),
        financialCategoryCode: 'MAINTENANCE',
        propertyReferenceId: await propertyReference(),
        loanId: null,
        securityDepositId: null,
        description: null,
      };
      expect((await new PostgresTransactionSplitRepository(db).replaceSplits(tx.transaction.id, REALM, [split], actor)).kind).toBe('REPLACED');
      expect((await transactions.confirm(tx.transaction.id, REALM, actor)).kind).toBe('CONFIRMED');
      const splitId = (await pool.query(`SELECT id FROM transaction_split WHERE transaction_id = $1`, [tx.transaction.id])).rows[0].id as string;
      await pool.query(
        `INSERT INTO tax_classification (mre_realm_id, source_type, transaction_split_id, tax_category, treatment, review_state, rule_code, rule_version, created_by)
         VALUES ($1, 'TRANSACTION_SPLIT', $2, 'MAINTENANCE', 'DEDUCTIBLE', 'NEEDS_REVIEW', 'DE_CATEGORY_DEFAULTS', 9, 'x')`,
        [REALM, splitId],
      );
      const afa = { ruleCode: 'DE_AFA_BUILDING_LINEAR', version: 1 };
      await expect(checkStoredRuleReferences(db, TAX_RULES, source([afa]))).rejects.toThrow(
        'Stored tax rule references are not registered: DE_CATEGORY_DEFAULTS@9',
      );
      expect(await new PostgresTaxClassificationRepository(db).storedRuleReferences()).toContainEqual({ ruleCode: 'DE_CATEGORY_DEFAULTS', version: 9 });
      // With a registry that knows @9, both sources resolve, each reference once.
      const nine = TAX_RULES.find({ ruleCode: 'DE_CATEGORY_DEFAULTS', version: 1 });
      const withNine = new RuleRegistry([
        ...TAX_RULES.codes()
          .flatMap((c) => TAX_RULES.versions(c))
          .filter((v) => v.ruleCode !== 'DE_CATEGORY_DEFAULTS'),
        { ...(nine as NonNullable<typeof nine>), version: 9 },
      ]);
      expect(await checkStoredRuleReferences(db, withNine, source([afa, afa]))).toEqual([{ ruleCode: 'DE_CATEGORY_DEFAULTS', version: 9 }, afa]);
    });
  });

  it('no cash mutated: every row and version of the cash and tax tables, and the other AuditRecords, equal before and after every command', async () => {
    const tables = [
      'ledger_transaction',
      'transaction_split',
      'acquisition',
      'acquisition_cost',
      'land_building_allocation',
      'ownership',
      'property_reference',
      'tax_classification',
    ];
    const snapshot = async () => {
      const rows: Record<string, unknown> = {};
      for (const table of tables)
        rows[table] = (await pool.query(`SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows.map((r) => r.row);
      rows['audit_record'] = (await pool.query(`SELECT count(*)::int AS n FROM audit_record WHERE entity_type <> 'DepreciationAsset'`)).rows[0].n;
      return rows;
    };
    const pr = await propertyReference();
    const [a1, a2] = (await Promise.all([acquisition(pr), acquisition(pr)])).sort();
    const advisor = await party();
    const before = await snapshot();
    const asset = await created(building(pr, { shorterUsefulLives: [life(a1)] }));
    await assets.create(building(pr), actor);
    await assets.amend(asset.id, REALM, { buildingCompletionYear: 1990, shorterUsefulLives: [{ acquisitionId: a2, usefulLifeYears: 20, evidence }] }, actor);
    await assets.confirm(asset.id, REALM, { reviewState: 'ADVISOR_CONFIRMED', advisorPartyId: advisor, note: 'geprüft' }, actor);
    await assets.find(asset.id, REALM);
    await assets.listForPropertyReference(pr, REALM, null);
    await assets.void(asset.id, REALM, 'falsche Einheit', new Date('2026-10-30T12:00:00Z'), actor);
    expect(await snapshot()).toEqual(before);
  });
});
