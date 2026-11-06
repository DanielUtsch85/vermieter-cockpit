import type { Kysely, Transaction } from 'kysely';
import {
  ownershipStart,
  planAlignOwnerships,
  type AcquisitionRepository,
  type AlignOwnershipsOutcome,
  type AlignResult,
  type AlignStep,
} from '../../domains/acquisition/index.js';
import { formatShare, ownershipOn, type Ownership } from '../../domains/ownership/index.js';
import { addDays, type BusinessDate } from '../../shared/index.js';
import {
  COLUMNS,
  fromSnapshot as acquisitionFromSnapshot,
  readOne,
  toSnapshot as acquisitionToSnapshot,
  withParties,
  type AcquisitionSnapshot,
} from './acquisition-rows.js';
import { writeAudit } from './audit.js';
import { claimIdempotencyKey, recordIdempotentResult } from './idempotency.js';
import { fromSnapshot, ownershipsOf, toSnapshot, type OwnershipSnapshot } from './ownership-rows.js';
import type { Database } from './schema.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SCOPE = 'acquisition.align-ownerships-to-transfer';
export const EXTENDED_TO_ECONOMIC_TRANSFER = 'EXTENDED_TO_ECONOMIC_TRANSFER';
export const START_MOVED_TO_ECONOMIC_TRANSFER = 'START_MOVED_TO_ECONOMIC_TRANSFER';
export const OWNERSHIPS_ALIGNED_TO_ECONOMIC_TRANSFER = 'OWNERSHIPS_ALIGNED_TO_ECONOMIC_TRANSFER';

type Outcome = AlignOwnershipsOutcome<Ownership>;

/** Thrown inside the transaction to roll back the key claim and every write with it. */
class Rejected extends Error {
  constructor(readonly outcome: Outcome) {
    super(outcome.kind);
  }
}

/**
 * `POST /acquisitions/{id}/align-ownerships-to-transfer` (api-design.md §58Q "Concurrency and locks"): one READ COMMITTED
 * transaction in the order of every Ownership writer (§26.1, §27.1): the key, the PropertyReference (no-op write), the
 * buyers and sellers `FOR SHARE` in id order, the Acquisition `FOR UPDATE`, every Ownership of the PropertyReference held
 * by a buyer or seller `FOR UPDATE` in id order, re-read, the plan, the writes in rule 3's order (the Acquisition, the
 * buyers' starts, the sellers' ends, the predecessors' ends; 0072's guards admit exactly them), the AuditRecords, the
 * key's result. It serialises with `confirm`, `cancel`, §58N's command and every Ownership write of the PropertyReference.
 */
export async function alignOwnershipsToTransferIn(
  db: Kysely<Database>,
  input: Parameters<AcquisitionRepository['alignOwnershipsToTransfer']>[0],
): Promise<Outcome> {
  const { id, mreRealmId, align, at, actor, expectedVersions, idempotency } = input;
  if (!UUID.test(id)) return { kind: 'NOT_FOUND' };
  try {
    return await db
      .transaction()
      .setIsolationLevel('read committed')
      .execute(async (trx): Promise<Outcome> => {
        const ref = { mreRealmId, scope: SCOPE, key: idempotency?.key ?? '' };
        if (idempotency !== undefined) {
          const claim = await claimIdempotencyKey(trx, ref, idempotency.fingerprint);
          if (claim.kind === 'CONFLICT') return { kind: 'IDEMPOTENCY_CONFLICT' };
          if (claim.kind === 'REPLAY') return { kind: 'ALIGNED', result: fromResultSnapshot(claim.result), replayed: true };
        }
        await trx
          .updateTable('property_reference')
          .set((eb) => ({ version: eb.ref('version') }))
          .where('id', '=', (eb) => eb.selectFrom('acquisition').select('property_reference_id').where('id', '=', id).where('mre_realm_id', '=', mreRealmId))
          .execute();
        // The order only: nothing is checked on the Parties (a buyer inactive since stays a buyer, P2-D1).
        await trx
          .selectFrom('party')
          .select('id')
          .where('id', 'in', (eb) =>
            eb.selectFrom('acquisition_party').select('party_id').where('acquisition_id', '=', id).where('mre_realm_id', '=', mreRealmId),
          )
          .orderBy('id')
          .forShare()
          .execute();
        const row = await trx
          .selectFrom('acquisition')
          .select(COLUMNS)
          .where('id', '=', id)
          .where('mre_realm_id', '=', mreRealmId)
          .forUpdate()
          .executeTakeFirst();
        if (row === undefined) throw new Rejected({ kind: 'NOT_FOUND' });
        const [current] = await withParties(trx, [row]);
        if (current === undefined) throw new Rejected({ kind: 'NOT_FOUND' });
        const parties = [...current.buyerPartyIds, ...current.sellerPartyIds];
        if (parties.length > 0) {
          await trx
            .selectFrom('ownership')
            .select('id')
            .where('property_reference_id', '=', current.propertyReferenceId)
            .where('mre_realm_id', '=', mreRealmId)
            .where('owner_party_id', 'in', parties)
            .orderBy('id')
            .forUpdate()
            .execute();
        }
        // Re-read after the locks: every VALID row of the PropertyReference in this Realm (the invariants read them all).
        const all = (await ownershipsOf(trx, current.propertyReferenceId)).filter((o) => o.mreRealmId === mreRealmId && o.status === 'VALID');
        const plan = planAlignOwnerships(current, all, align, at, expectedVersions);
        if (plan.kind !== 'ALIGN') throw new Rejected(plan);

        // Rule 3: (iv) the Acquisition, (ii) the buyers' starts later, then (i) and (iii) the ends later, each in id order.
        await trx
          .updateTable('acquisition')
          .set({ ownership_aligned_at: at, ownership_alignment_source_references: [...align.sourceReferences], version: plan.next.version, updated_at: at })
          .where('id', '=', id)
          .execute();
        const byId = new Map(all.map((o) => [o.id as string, o]));
        const write = async (step: AlignStep, column: 'valid_from' | 'valid_until', action: string) => {
          const before = byId.get(step.ownershipId) as Ownership;
          await trx
            .updateTable('ownership')
            .set({ [column]: step.to, version: before.version + 1, updated_at: at })
            .where('id', '=', step.ownershipId)
            .execute();
          await writeAudit(trx, { type: 'Ownership', id: step.ownershipId }, action, actor, {
            previousVersion: before.version,
            newVersion: before.version + 1,
            metadata: {
              acquisitionId: id,
              [column === 'valid_from' ? 'validFrom' : 'validUntil']: { from: step.from, to: step.to },
              sourceReferences: align.sourceReferences,
              notes: align.notes,
            },
          });
        };
        for (const step of plan.moved) await write(step, 'valid_from', START_MOVED_TO_ECONOMIC_TRANSFER);
        for (const step of [...plan.sellers, ...plan.predecessors]) await write(step, 'valid_until', EXTENDED_TO_ECONOMIC_TRANSFER);
        const aligned = await readOne(trx, id);
        const extendedIds = [...plan.sellers, ...plan.predecessors].map((s) => s.ownershipId).sort();
        const movedIds = plan.moved.map((s) => s.ownershipId);
        await writeAudit(trx, { type: 'Acquisition', id }, OWNERSHIPS_ALIGNED_TO_ECONOMIC_TRANSFER, actor, {
          previousVersion: current.version,
          newVersion: aligned.version,
          metadata: {
            contractDate: current.contractDate,
            economicTransferDate: current.economicTransferDate,
            ownershipStart: { from: ownershipStart(current), to: ownershipStart(aligned) },
            status: current.status,
            extendedOwnershipIds: extendedIds,
            movedOwnershipIds: movedIds,
            sourceReferences: align.sourceReferences,
            notes: align.notes,
          },
        });
        const result = await resultOf(trx, aligned, extendedIds, movedIds);
        if (idempotency !== undefined) await recordIdempotentResult(trx, ref, id, toResultSnapshot(result));
        return { kind: 'ALIGNED', result, replayed: false };
      });
  } catch (error) {
    if (error instanceof Rejected) return error.outcome;
    throw error;
  }
}

/** The rows as they are after the act, in id order, and the ownership on `t − 1` (equal to that of `c − 1` before). */
async function resultOf(
  trx: Transaction<Database>,
  acquisition: AlignResult<Ownership>['acquisition'],
  extendedIds: readonly string[],
  movedIds: readonly string[],
): Promise<AlignResult<Ownership>> {
  const rows = (await ownershipsOf(trx, acquisition.propertyReferenceId)).filter((o) => o.mreRealmId === acquisition.mreRealmId);
  const byId = new Map(rows.map((o) => [o.id as string, o]));
  const day = ownershipOn(rows, addDays(acquisition.economicTransferDate as BusinessDate, -1));
  return {
    acquisition,
    extended: extendedIds.map((x) => byId.get(x) as Ownership),
    moved: [...movedIds].sort().map((x) => byId.get(x) as Ownership),
    completeness: day.completeness,
    shareSum: day.shareSum,
  };
}

/** The act's result as JSON for the idempotency store. */
interface ResultSnapshot {
  readonly acquisition: AcquisitionSnapshot;
  readonly extended: readonly OwnershipSnapshot[];
  readonly moved: readonly OwnershipSnapshot[];
  readonly completeness: AlignResult<Ownership>['completeness'];
  readonly shareSum: string;
}

function toResultSnapshot(result: AlignResult<Ownership>): ResultSnapshot {
  return {
    acquisition: acquisitionToSnapshot(result.acquisition),
    extended: result.extended.map(toSnapshot),
    moved: result.moved.map(toSnapshot),
    completeness: result.completeness,
    shareSum: formatShare(result.shareSum),
  };
}

/** Written by toResultSnapshot in the same codebase, so its shape is trusted. */
function fromResultSnapshot(value: unknown): AlignResult<Ownership> {
  const s = value as ResultSnapshot;
  const [numerator, denominator] = s.shareSum.split('/').map(BigInt) as [bigint, bigint];
  return {
    acquisition: acquisitionFromSnapshot(s.acquisition),
    extended: s.extended.map(fromSnapshot),
    moved: s.moved.map(fromSnapshot),
    completeness: s.completeness,
    shareSum: { numerator, denominator },
  };
}
