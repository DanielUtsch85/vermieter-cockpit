import { Money } from '../../shared/index.js';
import { REALM, actor, day, type useAlignSchema } from './align-ownerships.test-support.js';
import { insertConfirmedAsBeforeVcX34 } from './legacy-acquisition.test-support.js';

/**
 * Test support of §58R (VC-X-57, migration 0073) through PostgreSQL, on §58Q's schema helpers: the example's N (S held
 * P since 2015 by W, legacy; the `DRAFT` N sells it to A, contract 2025-03-01, created without the date) in its states:
 * dated before any row, the rows written on the transfer (N) or from the contract date before the date (N2). Synthetic
 * values only.
 */
export const CONFIRM = `UPDATE acquisition SET status = 'CONFIRMED', confirmed_at = now(), version = version + 1 WHERE id = $1`;

export function ownershipStartFixtures(t: ReturnType<typeof useAlignSchema>) {
  const { ctx, propertyReference, party, own, recordDate } = t;
  /** A DRAFT through the repository (1/1 at 200,000.00 unless said otherwise). */
  const draft = async (
    pr: string,
    o: { buyers: string[]; sellers?: string[]; contract?: string; transfer?: string | null; share?: [number, number]; realm?: string },
  ) => {
    const created = await ctx.acquisitions.create(
      {
        mreRealmId: o.realm ?? REALM,
        propertyReferenceId: pr,
        purchasePrice: Money.of('200000.00', 'EUR'),
        acquiredShare: { numerator: o.share?.[0] ?? 1, denominator: o.share?.[1] ?? 1 },
        contractDate: day(o.contract ?? '2025-03-01'),
        economicTransferDate: o.transfer == null ? null : day(o.transfer),
        landRegistryTransferDate: null,
        buyerPartyIds: o.buyers,
        sellerPartyIds: o.sellers ?? [],
        sourceReferences: [],
        notes: null,
      },
      actor,
    );
    if (created.kind !== 'CREATED') throw new Error(created.kind);
    return created.acquisition.id;
  };
  /**
   * W (S from 2015-06-01, legacy) and the DRAFT N (A buys from S, contract 2025-03-01). `rows`: `none` (S's row open),
   * `transfer` (S's row to 2025-04-30, A from 2025-05-01 carrying N), `contract` (S's row to 2025-02-28, A from
   * 2025-03-01), `sellerEarly` (S's row to 2025-02-28, A from 2025-05-01). `dated`: the date 2025-05-01 recorded by §58N
   * after the rows (default true).
   */
  const scenario = async (o: { rows?: 'none' | 'transfer' | 'contract' | 'sellerEarly'; dated?: boolean; realm?: string } = {}) => {
    const realm = o.realm ?? REALM;
    const pr = await propertyReference(realm);
    const [s, a] = [await party('Verkäufer S (synthetisch)', realm), await party('Käuferin A (synthetisch)', realm)];
    const w = await insertConfirmedAsBeforeVcX34(ctx.pool, {
      mreRealmId: realm,
      propertyReferenceId: pr,
      contractDate: '2015-06-01',
      buyers: [{ partyId: s, share: [1, 1] }],
    });
    const oS = w.ownershipIds[0] as string;
    const n = await draft(pr, { buyers: [a], sellers: [s], realm });
    const rows = o.rows ?? 'none';
    let oA: string | null = null;
    if (rows !== 'none') {
      const end = rows === 'transfer' ? '2025-04-30' : '2025-02-28';
      await ctx.pool.query(`UPDATE ownership SET valid_until = $2 WHERE id = $1`, [oS, end]);
      oA = await own(pr, { owner: a, from: rows === 'contract' ? '2025-03-01' : '2025-05-01', acquisitionId: n }, realm);
    }
    if (o.dated !== false) await recordDate(n, '2025-05-01', realm);
    return { pr, s, a, w: w.acquisitionId, oS, n, oA };
  };
  return { draft, scenario };
}
