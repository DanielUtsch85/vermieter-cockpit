import type { BusinessDate } from '../../shared/index.js';
import type { DepreciationAssetId } from './asset.js';
import type { CapitalizedItem, ItemRef } from './capitalized-item.js';
import type { ScheduleAcquisition, ScheduleCost, ScheduleInput, ScheduleOwnership } from './schedule-model.js';
import { asset, capitalized, eur, kitchen, life, standard } from './schedule.test-support.js';

/**
 * Seeded random schedules for the round-trip property tests of VC-X-35 (api-design.md §60 "As implemented (VC-8-04)"
 * 13): purchases (price, costs, allocation, transfer date, completion year, a shorter useful life), owners (one to three,
 * any denominator), a sale of one owner's share to a new owner, capitalised items (splits and WEG uses, anschaffungsnahe
 * or not, refunds), an item linked to a separate asset (excluded from the building), and separate assets. The ids are
 * the caller's (`RandomIds`), so the database test can point them at rows that exist; everything else is generated.
 * Deterministic for a seed (mulberry32, as `financing/schedule.test.ts`). Synthetic. Test support only.
 */

export interface RandomIds {
  readonly assetId: string;
  readonly separateAssetId: string;
  readonly propertyReferenceId: string;
  /** At least five: owners are drawn from the first three, buyers from the last two. */
  readonly parties: readonly string[];
  /** At least two, each with its allocation: the purchase and the sale. */
  readonly acquisitions: readonly { readonly id: string; readonly allocationId: string }[];
  /** At least one: the items' classifications. */
  readonly classifications: readonly string[];
}

export interface RandomSchedule {
  readonly input: ScheduleInput;
  readonly throughYear: number;
  /** What was drawn, for a failure's message. */
  readonly label: string;
}

/** Today for the random schedules: every `throughYear` is before it. */
export const RANDOM_TODAY = '2099-12-31' as BusinessDate;

/** mulberry32: a small seeded generator, so the property test is deterministic without a new dependency. */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const pad = (n: number, width = 2) => String(n).padStart(width, '0');
const centsText = (cents: bigint) => `${cents < 0n ? '-' : ''}${(cents < 0n ? -cents : cents) / 100n}.${pad(Number((cents < 0n ? -cents : cents) % 100n))}`;
const dayBefore = (date: string) => new Date(Date.parse(`${date}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10) as BusinessDate;

/** One random schedule; `run` makes its generated ids (costs, ownerships, item sources) unique across runs. */
export function randomSchedule(random: () => number, ids: RandomIds, run: number): RandomSchedule {
  const between = (min: number, max: number) => min + Math.floor(random() * (max - min + 1));
  const chance = (p: number) => random() < p;
  const pick = <T>(list: readonly T[]) => list[between(0, list.length - 1)] as T;
  let counter = 0;
  const uuid = (prefix: string) => `${prefix}-0000-4000-8000-${pad(run, 6)}${pad(++counter, 6)}`;
  const date = (year: number) => `${year}-${pad(between(1, 12))}-${pad(between(1, 28))}` as BusinessDate;
  const amount = (min: number, max: number) => BigInt(between(min, max)) * 100n + BigInt(between(0, 99));
  const drawn: string[] = [];

  // The purchase: one to three owners of the whole, from a transfer date between 2006 and 2032.
  const [w, x] = ids.acquisitions as [{ id: string; allocationId: string }, { id: string; allocationId: string }];
  const transfer = date(between(2006, 2032));
  const firstYear = Number(transfer.slice(0, 4));
  const completion = pick([1900, 1924, 1950, 1995, 2005].filter((y) => y <= firstYear));
  const denominator = pick([1, 2, 3, 4, 5, 7, 10, 100, 1000, 9973]);
  const owners = Math.min(between(1, 3), denominator);
  const cuts = new Set<number>();
  while (cuts.size < owners - 1) cuts.add(between(1, denominator - 1));
  const bounds = [0, ...[...cuts].sort((p, q) => p - q), denominator];
  const holders = ids.parties.slice(0, owners).map((party, i) => ({ party, share: (bounds[i + 1] as number) - (bounds[i] as number) }));
  const costs: ScheduleCost[] = Array.from({ length: between(0, 3) }, () => ({
    id: uuid('0000c057'),
    category: pick(['REAL_ESTATE_TRANSFER_TAX', 'NOTARY', 'FINANCING_RELATED']),
    amount: eur(centsText(amount(100, 40_000))),
    paymentStatus: 'PAID',
  }));
  const price = amount(20_000, 3_000_000);
  const counted = costs.filter((c) => c.category !== 'FINANCING_RELATED').reduce((s, c) => s + BigInt(c.amount.amount.replace('.', '')), 0n);
  const total = price + counted;
  const building = (total * BigInt(between(300, 950))) / 1000n;
  const purchase = (id: string, allocationId: string, contract: BusinessDate, economic: BusinessDate, sellers: string[], share: [number, number]) =>
    ({
      id,
      status: 'CONFIRMED',
      purchasePrice: eur(centsText(price)),
      acquiredShare: { numerator: share[0], denominator: share[1] },
      contractDate: contract,
      economicTransferDate: economic,
      sellerPartyIds: sellers,
      costs,
      allocation: {
        id: allocationId,
        method: 'PURCHASE_CONTRACT',
        reviewState: 'CONFIRMED',
        totalAllocableAmount: eur(centsText(total)),
        buildingAmount: eur(centsText(building)),
      },
    }) satisfies ScheduleAcquisition;
  const acquisitions: ScheduleAcquisition[] = [purchase(w.id, w.allocationId, dayBefore(transfer), transfer, [], [1, 1])];
  const ownerships: ScheduleOwnership[] = holders.map((h) => ({
    id: uuid('0000abab'),
    partyId: h.party,
    share: { numerator: h.share, denominator },
    validFrom: transfer,
    validUntil: null,
    acquisitionId: w.id,
  }));
  drawn.push(`transfer ${transfer}, completed ${completion}, ${holders.map((h) => `${h.share}/${denominator}`).join(' ')}, ${costs.length} costs`);

  // A sale: one owner's share to a new owner, one to twelve years later.
  if (chance(0.4)) {
    const i = between(0, holders.length - 1);
    const seller = ownerships[i] as ScheduleOwnership;
    const sale = date(firstYear + between(1, 12));
    const buyer = pick(ids.parties.slice(3, 5));
    acquisitions.push(purchase(x.id, x.allocationId, dayBefore(sale), sale, [seller.partyId], [seller.share.numerator, denominator]));
    ownerships[i] = { ...seller, validUntil: dayBefore(sale) };
    ownerships.push({ id: uuid('0000abab'), partyId: buyer, share: seller.share, validFrom: sale, validUntil: null, acquisitionId: x.id });
    drawn.push(`sale ${sale} of ${seller.share.numerator}/${denominator}`);
  }

  // Who holds what on a date, for the items' parts (§58C).
  const sharesOn = (on: string): [string, string][] =>
    ownerships
      .filter((o) => o.validFrom <= on && (o.validUntil === null || o.validUntil >= on))
      .map((o) => [o.partyId, `${o.share.numerator}/${o.share.denominator}`]);
  const item = (on: BusinessDate, cents: bigint, overrides: Partial<CapitalizedItem> & { sourceType?: CapitalizedItem['sourceType'] } = {}) =>
    capitalized(uuid('0000eeee'), on, centsText(cents), sharesOn(on), {
      propertyReferenceId: ids.propertyReferenceId,
      classificationId: pick(ids.classifications),
      ...overrides,
    });
  const shorterLife = chance(0.15) ? [life({ acquisitionId: w.id, usefulLifeYears: between(5, 45) })] : [];

  if (chance(0.25)) {
    // A separate asset (§59B): one to three of its items, perhaps a refund, from its acquisition on (from 2023, the
    // first year of `DE_AFA_MOVABLE_LINEAR@1`: before it the asset is not computed, NO_APPLICABLE_RULE).
    const from = Math.max(firstYear, 2023);
    const acquiredOn = date(between(from, from + 12));
    const own = Array.from({ length: between(1, 3) }, (_, k) =>
      item(k === 0 ? acquiredOn : date(Number(acquiredOn.slice(0, 4)) + between(0, 3)), k > 0 && chance(0.3) ? -amount(1, 2_000) : amount(500, 80_000), {
        taxCategory: 'OTHER_EXPENSE',
      }),
    ).filter((c) => c.date >= transfer && c.parts.length > 0);
    const usefulLifeYears = between(3, 25);
    drawn.push(`separate asset from ${acquiredOn}, ${usefulLifeYears} years, ${own.length} items`);
    return {
      input: {
        asset: kitchen({
          id: ids.separateAssetId as DepreciationAssetId,
          propertyReferenceId: ids.propertyReferenceId,
          acquiredOn,
          usefulLifeYears,
          items: own.map((c): ItemRef => ({ sourceType: c.sourceType, sourceId: c.sourceId, sourcePosition: c.sourcePosition })),
        }),
        acquisitions,
        ownerships,
        capitalizedItems: own,
        today: RANDOM_TODAY,
        ownerPartyId: null,
      },
      throughYear: Math.min(2099, Number(acquiredOn.slice(0, 4)) + between(0, usefulLifeYears + 3)),
      label: drawn.join('; '),
    };
  }

  // The building: zero to four items (splits and WEG uses, anschaffungsnahe or not, refunds), perhaps one linked to a
  // separate asset (so excluded here).
  const items = Array.from({ length: between(0, 4) }, () => {
    const on = date(firstYear + between(0, 25));
    const cents = chance(0.25) ? -amount(1, 20_000) : amount(1, 200_000);
    const anschaffungsnahe = chance(0.3) ? w.id : null;
    return chance(0.3)
      ? item(on, cents, {
          sourceType: 'WEG_ASSESSMENT_USE',
          sourcePosition: between(1, 3),
          dateSource: 'USE',
          taxCategory: 'WEG_SPENDING',
          anschaffungsnaheAcquisitionId: anschaffungsnahe,
        })
      : item(on, cents, { anschaffungsnaheAcquisitionId: anschaffungsnahe });
  }).filter((c) => c.date >= transfer && c.parts.length > 0);
  const linked = items.length > 0 && chance(0.2) ? (items[0] as CapitalizedItem) : null;
  drawn.push(`${items.length} items (${items.filter((c) => c.lineAmount.amount.startsWith('-')).length} refunds)${linked === null ? '' : ', one linked'}`);
  return {
    input: {
      asset: asset({
        id: ids.assetId as DepreciationAssetId,
        propertyReferenceId: ids.propertyReferenceId,
        buildingCompletionYear: completion,
        shorterUsefulLives: shorterLife,
        // §59C: every drawn purchase has a confirmed STANDARD method entry, so the schedules compute as before.
        purchaseMethods: acquisitions.map((a) => standard({ acquisitionId: a.id })),
      }),
      acquisitions,
      ownerships,
      capitalizedItems: items,
      links:
        linked === null
          ? []
          : [{ sourceType: linked.sourceType, sourceId: linked.sourceId, sourcePosition: linked.sourcePosition, assetId: ids.separateAssetId }],
      today: RANDOM_TODAY,
      ownerPartyId: null,
    },
    throughYear: Math.min(2099, firstYear + between(0, 60)),
    label: drawn.join('; '),
  };
}
