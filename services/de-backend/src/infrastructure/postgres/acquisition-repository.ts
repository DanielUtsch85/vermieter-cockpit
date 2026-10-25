import { sql, type Kysely, type Transaction } from 'kysely';
import {
  planCancel,
  type Acquisition,
  type AcquisitionFilter,
  type AcquisitionId,
  type AcquisitionPage,
  type AcquisitionRepository,
  type AcquisitionStatus,
  type CancelAcquisitionOutcome,
  type CreateAcquisitionOutcome,
  type NewAcquisition,
} from '../../domains/acquisition/index.js';
import { checkVersion, type AuditActor, type BusinessDate } from '../../shared/index.js';
import { writeAudit } from './audit.js';
import { claimIdempotencyKey, recordIdempotentResult } from './idempotency.js';
import { fromNumericAmount, toNumericAmount } from './money-column.js';
import type { Database } from './schema.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ENTITY_TYPE = 'Acquisition';
const CREATE_SCOPE = 'acquisition.create';

/** Every column, the dates as `YYYY-MM-DD` text and the price as text (exact). */
const COLUMNS = [
  'id',
  'mre_realm_id',
  'property_reference_id',
  'status',
  sql<string>`purchase_price::text`.as('purchase_price'),
  'currency',
  'acquired_share_numerator',
  'acquired_share_denominator',
  sql<string>`to_char(contract_date, 'YYYY-MM-DD')`.as('contract_date'),
  sql<string | null>`to_char(economic_transfer_date, 'YYYY-MM-DD')`.as('economic_transfer_date'),
  sql<string | null>`to_char(land_registry_transfer_date, 'YYYY-MM-DD')`.as('land_registry_transfer_date'),
  'source_references',
  'notes',
  'cancelled_at',
  'cancellation_reason',
  'confirmed_at',
  'created_at',
  'version',
] as const;

interface AcquisitionRow {
  id: string;
  mre_realm_id: string;
  property_reference_id: string;
  status: string;
  purchase_price: string;
  currency: string;
  acquired_share_numerator: number;
  acquired_share_denominator: number;
  contract_date: string;
  economic_transfer_date: string | null;
  land_registry_transfer_date: string | null;
  source_references: string[];
  notes: string | null;
  cancelled_at: Date | null;
  cancellation_reason: string | null;
  confirmed_at: Date | null;
  created_at: Date;
  version: number;
}

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
      return await this.db.transaction().setIsolationLevel('read committed').execute(async (trx): Promise<CreateAcquisitionOutcome> => {
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
    return this.db.transaction().setIsolationLevel('repeatable read').setAccessMode('read only').execute(async (trx) => {
      const row = await trx.selectFrom('acquisition').select(COLUMNS).where('id', '=', id).where('mre_realm_id', '=', mreRealmId).executeTakeFirst();
      return row === undefined ? undefined : (await withParties(trx, [row]))[0];
    });
  }

  async list(mreRealmId: string, filter: AcquisitionFilter, page: { readonly page: number; readonly pageSize: number }): Promise<AcquisitionPage> {
    // Count, page and parties in one snapshot, so `total` and `items` agree.
    return this.db.transaction().setIsolationLevel('repeatable read').setAccessMode('read only').execute(async (trx) => {
      const filtered = () => {
        let query = trx.selectFrom('acquisition').where('mre_realm_id', '=', mreRealmId);
        if (filter.status !== undefined) query = query.where('status', '=', filter.status);
        if (filter.propertyReferenceId !== undefined) query = query.where('property_reference_id', '=', filter.propertyReferenceId);
        const partyId = filter.partyId;
        if (partyId !== undefined) {
          query = query.where(({ exists, selectFrom }) =>
            exists(selectFrom('acquisition_party as p').select('p.party_id').whereRef('p.acquisition_id', '=', 'acquisition.id').where('p.party_id', '=', partyId)),
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
    return this.db.transaction().setIsolationLevel('read committed').execute(async (trx): Promise<CancelAcquisitionOutcome> => {
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
      const plan = planCancel(current, reason, at, valid.map((o) => o.id));
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
}

async function readOne(trx: Transaction<Database>, id: string): Promise<Acquisition> {
  const row = await trx.selectFrom('acquisition').select(COLUMNS).where('id', '=', id).executeTakeFirstOrThrow();
  return (await withParties(trx, [row]))[0] as Acquisition;
}

/** The rows as Acquisitions, with their buyers and sellers in the order given. */
async function withParties(trx: Transaction<Database>, rows: readonly AcquisitionRow[]): Promise<Acquisition[]> {
  if (rows.length === 0) return [];
  const parties = await trx
    .selectFrom('acquisition_party')
    .select(['acquisition_id', 'party_id', 'role'])
    .where(
      'acquisition_id',
      'in',
      rows.map((r) => r.id),
    )
    .orderBy('position')
    .execute();
  const of = (id: string, role: 'BUYER' | 'SELLER') => parties.filter((p) => p.acquisition_id === id && p.role === role).map((p) => p.party_id);
  return rows.map((row) => ({
    id: row.id as AcquisitionId,
    mreRealmId: row.mre_realm_id,
    propertyReferenceId: row.property_reference_id,
    status: row.status as AcquisitionStatus,
    purchasePrice: fromNumericAmount(row.purchase_price, row.currency),
    acquiredShare: { numerator: row.acquired_share_numerator, denominator: row.acquired_share_denominator },
    contractDate: row.contract_date as BusinessDate,
    economicTransferDate: row.economic_transfer_date as BusinessDate | null,
    landRegistryTransferDate: row.land_registry_transfer_date as BusinessDate | null,
    buyerPartyIds: of(row.id, 'BUYER'),
    sellerPartyIds: of(row.id, 'SELLER'),
    sourceReferences: row.source_references,
    notes: row.notes,
    cancelledAt: row.cancelled_at,
    cancellationReason: row.cancellation_reason,
    confirmedAt: row.confirmed_at,
    createdAt: row.created_at,
    version: row.version,
  }));
}

/** The created Acquisition as JSON for the idempotency store: Money as `{ amount, currency }`, timestamps ISO. */
interface AcquisitionSnapshot extends Omit<Acquisition, 'purchasePrice' | 'createdAt' | 'cancelledAt' | 'confirmedAt'> {
  readonly purchasePrice: { readonly amount: string; readonly currency: string };
  readonly createdAt: string;
  readonly cancelledAt: string | null;
  readonly confirmedAt: string | null;
}

function toSnapshot(a: Acquisition): AcquisitionSnapshot {
  return {
    ...a,
    purchasePrice: { amount: a.purchasePrice.amount, currency: a.purchasePrice.currency },
    createdAt: a.createdAt.toISOString(),
    cancelledAt: a.cancelledAt?.toISOString() ?? null,
    confirmedAt: a.confirmedAt?.toISOString() ?? null,
  };
}

/** Written by toSnapshot in the same codebase, so its shape is trusted. */
function fromSnapshot(result: unknown): Acquisition {
  const s = result as AcquisitionSnapshot;
  return {
    ...s,
    id: s.id as AcquisitionId,
    purchasePrice: fromNumericAmount(s.purchasePrice.amount, s.purchasePrice.currency),
    createdAt: new Date(s.createdAt),
    cancelledAt: s.cancelledAt === null ? null : new Date(s.cancelledAt),
    confirmedAt: s.confirmedAt === null ? null : new Date(s.confirmedAt),
  };
}
