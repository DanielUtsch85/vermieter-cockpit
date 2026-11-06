import { sql, type Kysely, type Transaction } from 'kysely';
import {
  ownershipStart,
  planCancel,
  planConfirm,
  type Acquisition,
  type AcquisitionFilter,
  type AcquisitionPage,
  type AcquisitionRepository,
  type AcquisitionStatus,
  type AlignOwnershipsOutcome,
  type CancelAcquisitionOutcome,
  type ConfirmAcquisitionOutcome,
  type ConfirmationOwnership,
  type CreateAcquisitionOutcome,
  type NewAcquisition,
  type RecordTransferDateOutcome,
} from '../../domains/acquisition/index.js';
import type { Ownership } from '../../domains/ownership/index.js';
import { addDays, checkVersion, type AuditActor, type BusinessDate } from '../../shared/index.js';
import { alignOwnershipsToTransferIn } from './acquisition-align-ownerships.js';
import { COLUMNS, fromSnapshot, readOne, toSnapshot, withParties } from './acquisition-rows.js';
import { recordEconomicTransferDateIn } from './acquisition-transfer-date.js';
import { writeAudit } from './audit.js';
import { claimIdempotencyKey, recordIdempotentResult } from './idempotency.js';
import { toNumericAmount } from './money-column.js';
import type { Database } from './schema.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ENTITY_TYPE = 'Acquisition';
const CREATE_SCOPE = 'acquisition.create';

/** Thrown inside the transaction to roll back the key claim and every write together. */
class Rejected extends Error {
  constructor(readonly outcome: CreateAcquisitionOutcome) {
    super(outcome.kind);
  }
}

/** PostgreSQL implementation of the Acquisition port (api-design.md §27.1). */
export class PostgresAcquisitionRepository implements AcquisitionRepository {
  constructor(private readonly db: Kysely<Database>) {}

  async create(
    acquisition: NewAcquisition,
    actor: AuditActor,
    idempotency?: { readonly key: string; readonly fingerprint: string },
  ): Promise<CreateAcquisitionOutcome> {
    try {
      return await this.db
        .transaction()
        .setIsolationLevel('read committed')
        .execute(async (trx): Promise<CreateAcquisitionOutcome> => {
          const keyed =
            idempotency === undefined
              ? undefined
              : { ref: { mreRealmId: acquisition.mreRealmId, scope: CREATE_SCOPE, key: idempotency.key }, fingerprint: idempotency.fingerprint };
          if (keyed !== undefined) {
            const claim = await claimIdempotencyKey(trx, keyed.ref, keyed.fingerprint);
            if (claim.kind === 'CONFLICT') return { kind: 'IDEMPOTENCY_CONFLICT' };
            if (claim.kind === 'REPLAY') return { kind: 'REPLAYED', acquisition: fromSnapshot(claim.result) };
          }
          const propertyReference = await trx
            .selectFrom('property_reference')
            .select('id')
            .where('id', '=', acquisition.propertyReferenceId)
            .where('mre_realm_id', '=', acquisition.mreRealmId)
            .executeTakeFirst();
          if (propertyReference === undefined) throw new Rejected({ kind: 'PROPERTY_REFERENCE_NOT_FOUND' });
          // FOR SHARE in id order: a buyer cannot be deactivated before this commits (deactivate takes FOR UPDATE).
          const ids = [...new Set([...acquisition.buyerPartyIds, ...acquisition.sellerPartyIds])].sort();
          const parties = await trx
            .selectFrom('party')
            .select(['id', 'status'])
            .where('id', 'in', ids)
            .where('mre_realm_id', '=', acquisition.mreRealmId)
            .orderBy('id')
            .forShare()
            .execute();
          const status = new Map(parties.map((p) => [p.id, p.status]));
          for (const partyId of [...acquisition.buyerPartyIds, ...acquisition.sellerPartyIds]) {
            if (!status.has(partyId)) throw new Rejected({ kind: 'PARTY_NOT_FOUND', partyId });
          }
          for (const partyId of acquisition.buyerPartyIds) {
            if (status.get(partyId) !== 'ACTIVE') throw new Rejected({ kind: 'PARTY_INACTIVE', partyId });
          }

          const { id } = await trx
            .insertInto('acquisition')
            .values({
              mre_realm_id: acquisition.mreRealmId,
              property_reference_id: acquisition.propertyReferenceId,
              status: 'DRAFT' satisfies AcquisitionStatus,
              purchase_price: toNumericAmount(acquisition.purchasePrice),
              currency: acquisition.purchasePrice.currency,
              acquired_share_numerator: acquisition.acquiredShare.numerator,
              acquired_share_denominator: acquisition.acquiredShare.denominator,
              contract_date: acquisition.contractDate,
              economic_transfer_date: acquisition.economicTransferDate,
              land_registry_transfer_date: acquisition.landRegistryTransferDate,
              source_references: [...acquisition.sourceReferences],
              notes: acquisition.notes,
              created_by: actor.actorId,
            })
            .returning('id')
            .executeTakeFirstOrThrow();
          const roles = [
            ...acquisition.buyerPartyIds.map((partyId, i) => ({ party_id: partyId, role: 'BUYER', position: i + 1 })),
            ...acquisition.sellerPartyIds.map((partyId, i) => ({ party_id: partyId, role: 'SELLER', position: i + 1 })),
          ];
          await trx
            .insertInto('acquisition_party')
            .values(roles.map((r) => ({ ...r, acquisition_id: id, mre_realm_id: acquisition.mreRealmId })))
            .execute();
          const created = await readOne(trx, id);
          if (keyed !== undefined) await recordIdempotentResult(trx, keyed.ref, id, toSnapshot(created));
          await writeAudit(trx, { type: ENTITY_TYPE, id }, 'CREATED', actor, {
            newVersion: created.version,
            metadata: {
              propertyReferenceId: created.propertyReferenceId,
              purchasePrice: { amount: created.purchasePrice.amount, currency: created.purchasePrice.currency },
              acquiredShare: `${created.acquiredShare.numerator}/${created.acquiredShare.denominator}`,
              contractDate: created.contractDate,
              economicTransferDate: created.economicTransferDate,
              landRegistryTransferDate: created.landRegistryTransferDate,
              buyerPartyIds: created.buyerPartyIds,
              sellerPartyIds: created.sellerPartyIds,
            },
          });
          return { kind: 'CREATED', acquisition: created };
        });
    } catch (error) {
      if (error instanceof Rejected) return error.outcome;
      throw error;
    }
  }

  async findById(id: string, mreRealmId: string): Promise<Acquisition | undefined> {
    if (!UUID.test(id)) return undefined;
    // The row and its parties in one snapshot.
    return this.db
      .transaction()
      .setIsolationLevel('repeatable read')
      .setAccessMode('read only')
      .execute(async (trx) => {
        const row = await trx.selectFrom('acquisition').select(COLUMNS).where('id', '=', id).where('mre_realm_id', '=', mreRealmId).executeTakeFirst();
        return row === undefined ? undefined : (await withParties(trx, [row]))[0];
      });
  }

  async list(mreRealmId: string, filter: AcquisitionFilter, page: { readonly page: number; readonly pageSize: number }): Promise<AcquisitionPage> {
    // Count, page and parties in one snapshot, so `total` and `items` agree.
    return this.db
      .transaction()
      .setIsolationLevel('repeatable read')
      .setAccessMode('read only')
      .execute(async (trx) => {
        const filtered = () => {
          let query = trx.selectFrom('acquisition').where('mre_realm_id', '=', mreRealmId);
          if (filter.status !== undefined) query = query.where('status', '=', filter.status);
          if (filter.propertyReferenceId !== undefined) query = query.where('property_reference_id', '=', filter.propertyReferenceId);
          const partyId = filter.partyId;
          if (partyId !== undefined) {
            query = query.where(({ exists, selectFrom }) =>
              exists(
                selectFrom('acquisition_party as p').select('p.party_id').whereRef('p.acquisition_id', '=', 'acquisition.id').where('p.party_id', '=', partyId),
              ),
            );
          }
          return query;
        };
        const { n } = await filtered()
          .select((eb) => eb.fn.countAll<string>().as('n'))
          .executeTakeFirstOrThrow();
        const rows = await filtered()
          .select(COLUMNS)
          .orderBy('contract_date', 'desc')
          .orderBy('created_at', 'desc')
          .orderBy('id')
          .limit(page.pageSize)
          .offset((page.page - 1) * page.pageSize)
          .execute();
        return { items: await withParties(trx, rows), page: page.page, pageSize: page.pageSize, total: Number(n) };
      });
  }

  async cancel(
    id: string,
    mreRealmId: string,
    reason: string,
    at: Date,
    actor: AuditActor,
    expectedVersions?: readonly number[],
  ): Promise<CancelAcquisitionOutcome> {
    if (!UUID.test(id)) return { kind: 'NOT_FOUND' };
    return this.db
      .transaction()
      .setIsolationLevel('read committed')
      .execute(async (trx): Promise<CancelAcquisitionOutcome> => {
        // Lock order of every Ownership writer: PropertyReference (no-op write), then the Acquisition, then Ownerships.
        await trx
          .updateTable('property_reference')
          .set((eb) => ({ version: eb.ref('version') }))
          .where('id', '=', (eb) => eb.selectFrom('acquisition').select('property_reference_id').where('id', '=', id).where('mre_realm_id', '=', mreRealmId))
          .execute();
        const row = await trx
          .selectFrom('acquisition')
          .select(COLUMNS)
          .where('id', '=', id)
          .where('mre_realm_id', '=', mreRealmId)
          .forUpdate()
          .executeTakeFirst();
        if (row === undefined) return { kind: 'NOT_FOUND' };
        const [current] = await withParties(trx, [row]);
        if (current === undefined) return { kind: 'NOT_FOUND' };
        const valid = await trx.selectFrom('ownership').select('id').where('acquisition_id', '=', id).where('status', '=', 'VALID').execute();
        const plan = planCancel(
          current,
          reason,
          at,
          valid.map((o) => o.id),
        );
        if (plan.kind === 'UNCHANGED') return { kind: 'CANCELLED', acquisition: current, changed: false };
        if (plan.kind !== 'CANCEL') return plan;
        const conflict = checkVersion(current.version, expectedVersions);
        if (conflict !== undefined) return conflict;
        await trx
          .updateTable('acquisition')
          .set({ status: plan.next.status, cancelled_at: at, cancellation_reason: reason, version: plan.next.version, updated_at: at })
          .where('id', '=', id)
          .execute();
        const cancelled = await readOne(trx, id);
        await writeAudit(trx, { type: ENTITY_TYPE, id }, 'CANCELLED', actor, {
          previousVersion: current.version,
          newVersion: cancelled.version,
          metadata: { reason },
        });
        return { kind: 'CANCELLED', acquisition: cancelled, changed: true };
      });
  }

  async confirm(id: string, mreRealmId: string, at: Date, actor: AuditActor, expectedVersions?: readonly number[]): Promise<ConfirmAcquisitionOutcome> {
    if (!UUID.test(id)) return { kind: 'NOT_FOUND' };
    return this.db
      .transaction()
      .setIsolationLevel('read committed')
      .execute(async (trx): Promise<ConfirmAcquisitionOutcome> => {
        // Lock order of every path (§28.1): PropertyReference (no-op write), buyers FOR SHARE in id order, the Acquisition.
        await trx
          .updateTable('property_reference')
          .set((eb) => ({ version: eb.ref('version') }))
          .where('id', '=', (eb) => eb.selectFrom('acquisition').select('property_reference_id').where('id', '=', id).where('mre_realm_id', '=', mreRealmId))
          .execute();
        const buyers = await trx
          .selectFrom('party')
          .select(['id', 'status'])
          .where('id', 'in', (eb) => eb.selectFrom('acquisition_party').select('party_id').where('acquisition_id', '=', id).where('role', '=', 'BUYER'))
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
        if (row === undefined) return { kind: 'NOT_FOUND' };
        const [current] = await withParties(trx, [row]);
        if (current === undefined) return { kind: 'NOT_FOUND' };
        const d = ownershipStart(current);
        const ownerships = (query: (q: ReturnType<typeof ownershipQuery>) => ReturnType<typeof ownershipQuery>) => query(ownershipQuery(trx)).execute();
        const own = await ownerships((q) => q.where('acquisition_id', '=', id));
        const covering = (day: BusinessDate) =>
          ownerships((q) =>
            q
              .where('property_reference_id', '=', current.propertyReferenceId)
              .where('valid_from', '<=', day)
              .where((eb) => eb.or([eb('valid_until', 'is', null), eb('valid_until', '>=', day)])),
          );
        const onTransferDate = await covering(d);
        // §28.1A: the share each buyer held the day before, read after the same locks as the transfer date's.
        const beforeTransferDate = await covering(addDays(d, -1));
        // §58R requirement 7: the sellers' rows of the PropertyReference in the Realm on c − 1 and t − 1, after the same locks.
        const sellerDays = current.economicTransferDate === null ? [] : [addDays(current.contractDate, -1), addDays(current.economicTransferDate, -1)];
        const sellerRows =
          current.sellerPartyIds.length === 0 || sellerDays.length === 0
            ? []
            : await ownerships((q) =>
                q
                  .where('property_reference_id', '=', current.propertyReferenceId)
                  .where('mre_realm_id', '=', mreRealmId)
                  .where('owner_party_id', 'in', current.sellerPartyIds)
                  .where((eb) =>
                    eb.or(sellerDays.map((day) => eb.and([eb('valid_from', '<=', day), eb.or([eb('valid_until', 'is', null), eb('valid_until', '>=', day)])]))),
                  ),
              );
        const plan = planConfirm(
          current,
          {
            buyerStatuses: new Map(buyers.map((b) => [b.id, b.status])),
            own: own.map(toConfirmationOwnership),
            onTransferDate: onTransferDate.map(toConfirmationOwnership),
            beforeTransferDate: beforeTransferDate.map(toConfirmationOwnership),
            sellerRows: sellerRows.map(toConfirmationOwnership),
          },
          at,
        );
        if (plan.kind === 'UNCHANGED') return { kind: 'CONFIRMED', acquisition: current, changed: false, ownershipIds: [] };
        if (plan.kind === 'ACQUISITION_CANCELLED') return plan;
        const conflict = checkVersion(current.version, expectedVersions);
        if (conflict !== undefined) return conflict;
        if (plan.kind === 'CONFIRMATION_BLOCKED') return plan;
        await trx
          .updateTable('acquisition')
          .set({ status: plan.next.status, confirmed_at: at, version: plan.next.version, updated_at: at })
          .where('id', '=', id)
          .execute();
        const confirmed = await readOne(trx, id);
        const ownershipIds = own.map((o) => o.id).sort();
        await writeAudit(trx, { type: ENTITY_TYPE, id }, 'CONFIRMED', actor, {
          previousVersion: current.version,
          newVersion: confirmed.version,
          metadata: { transferDate: d, ownershipIds },
        });
        return { kind: 'CONFIRMED', acquisition: confirmed, changed: true, ownershipIds };
      });
  }

  recordEconomicTransferDate(input: Parameters<AcquisitionRepository['recordEconomicTransferDate']>[0]): Promise<RecordTransferDateOutcome> {
    return recordEconomicTransferDateIn(this.db, input);
  }

  alignOwnershipsToTransfer(input: Parameters<AcquisitionRepository['alignOwnershipsToTransfer']>[0]): Promise<AlignOwnershipsOutcome<Ownership>> {
    return alignOwnershipsToTransferIn(this.db, input);
  }
}

/** `VALID` Ownerships with the columns the confirmation reads; the dates as `YYYY-MM-DD` text. */
export function ownershipQuery(trx: Transaction<Database>) {
  return trx
    .selectFrom('ownership')
    .select([
      'id',
      'owner_party_id',
      'share_numerator',
      'share_denominator',
      sql<string>`to_char(valid_from, 'YYYY-MM-DD')`.as('valid_from'),
      sql<string | null>`to_char(valid_until, 'YYYY-MM-DD')`.as('valid_until'),
    ])
    .where('status', '=', 'VALID');
}

export function toConfirmationOwnership(row: {
  id: string;
  owner_party_id: string;
  share_numerator: number;
  share_denominator: number;
  valid_from: string;
  valid_until: string | null;
}): ConfirmationOwnership {
  return {
    id: row.id,
    ownerPartyId: row.owner_party_id,
    share: { numerator: row.share_numerator, denominator: row.share_denominator },
    validFrom: row.valid_from as BusinessDate,
    validUntil: row.valid_until as BusinessDate | null,
  };
}

/** One Acquisition of the Realm with its parties, inside the caller's transaction (for reads that need one snapshot). */
export async function readAcquisitionIn(trx: Transaction<Database>, id: string, mreRealmId: string): Promise<Acquisition | undefined> {
  if (!UUID.test(id)) return undefined;
  const row = await trx.selectFrom('acquisition').select(COLUMNS).where('id', '=', id).where('mre_realm_id', '=', mreRealmId).executeTakeFirst();
  return row === undefined ? undefined : (await withParties(trx, [row]))[0];
}
