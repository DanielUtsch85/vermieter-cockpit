import type { Kysely, Transaction } from 'kysely';
import {
  wegSourceKey,
  type AnschaffungsnaheCheck,
  type CheckSource,
  type RuleRegistry,
  type TaxClassification,
  type TaxMeaning,
  type WegSourceFacts,
  type WegTaxMeaning,
} from '../../domains/taxation/index.js';
import type { BusinessDate } from '../../shared/index.js';
import type { Database } from './schema.js';
import {
  acquisitionsOf,
  baseWegMeaning,
  checkRange,
  checksOf,
  ownershipsOf,
  wegCheckSource,
  wegContextOf,
  withEffects,
  type OwnershipSpan,
  type WegContext,
} from './tax-property-context.js';
import { UUID, currentOfWeg } from './tax-classification-rows.js';
import { factsQuery, meaningsOf, countingSplits, toRead } from './tax-source-facts.js';

/**
 * §58B's effects of a treatment around a PropertyReference: the § 82b parts and the anschaffungsnahe check (as
 * `domains/taxation/treatment-effects.ts`), and the check of one Acquisition.
 */

/** What the effects of §58B (the § 82b parts, the anschaffungsnahe check) read around a PropertyReference. */
export interface Effects {
  readonly weg: WegContext;
  readonly ownerships: readonly OwnershipSpan[];
  readonly checks: readonly AnschaffungsnaheCheck[];
}

const EMPTY_WEG: WegContext = { facts: [], current: new Map(), twice: new Map(), confirmedStatements: [] };

export async function anschaffungsnaheCheck(
  db: Kysely<Database>,
  registry: RuleRegistry,
  acquisitionId: string,
  mreRealmId: string,
  today: BusinessDate,
): Promise<AnschaffungsnaheCheck | undefined> {
  if (!UUID.test(acquisitionId)) return undefined;
  return db
    .transaction()
    .setIsolationLevel('repeatable read')
    .setAccessMode('read only')
    .execute(async (trx) => {
      const [input] = await acquisitionsOf(trx, mreRealmId, { acquisitionId });
      if (input === undefined) return undefined;
      const effects = await effectsOf(trx, registry, mreRealmId, input.acquisition.propertyReferenceId, today);
      return effects.checks.find((c) => c.acquisitionId === acquisitionId);
    });
}

/**
 * What the effects of §58B read around a PropertyReference: its WEG sources, Ownerships, and the anschaffungsnahe
 * checks of its Acquisitions with the counting splits and WEG sources of their windows (and the strip after them).
 */
export async function effectsOf(
  trx: Transaction<Database>,
  registry: RuleRegistry,
  mreRealmId: string,
  propertyReferenceId: string | null,
  today: BusinessDate,
): Promise<Effects> {
  if (propertyReferenceId === null) return { weg: EMPTY_WEG, ownerships: [], checks: [] };
  const weg = await wegContextOf(trx, mreRealmId, { propertyReferenceId }, today, currentOfWeg);
  const ownerships = await ownershipsOf(trx, mreRealmId, propertyReferenceId);
  const inputs = await acquisitionsOf(trx, mreRealmId, { propertyReferenceId });
  const range = checkRange(inputs, registry);
  const sources: { source: CheckSource; date: BusinessDate; rank: number; index: number }[] = [];
  if (range !== undefined) {
    const rows = await countingSplits(factsQuery(trx, mreRealmId).where('s.property_reference_id', '=', propertyReferenceId))
      .where('t.booking_date', '>=', range.from)
      .where('t.booking_date', '<=', range.to)
      .orderBy('t.booking_date')
      .orderBy('t.id')
      .orderBy('s.position')
      .execute();
    (await meaningsOf(trx, registry, mreRealmId, rows.map(toRead), today)).forEach(({ meaning, classification }, index) =>
      sources.push({ source: splitCheckSource(meaning, classification), date: meaning.bookingDate, rank: 0, index }),
    );
    weg.facts
      .filter((f) => f.notCounted === null && f.date >= range.from && f.date <= range.to)
      .forEach((f, index) => {
        const meaning = baseWegMeaning(weg, f, registry, today);
        if (!meaning.counts) return;
        sources.push({
          source: wegCheckSource(meaning, weg.current.get(wegSourceKey(f)) ?? null),
          date: f.date,
          rank: f.sourceType === 'WEG_RESERVE_WITHDRAWAL' ? 2 : 3,
          index,
        });
      });
  }
  // The order of the per-property list.
  sources.sort((a, b) => (a.date !== b.date ? (a.date < b.date ? -1 : 1) : a.rank !== b.rank ? a.rank - b.rank : a.index - b.index));
  return {
    weg,
    ownerships,
    checks: checksOf(
      inputs,
      sources.map((s) => s.source),
      weg.confirmedStatements,
      today,
      registry,
    ),
  };
}

export function splitWithEffects(pair: { readonly meaning: TaxMeaning; readonly classification: TaxClassification | null }, effects: Effects): TaxMeaning {
  const { meaning, classification } = pair;
  return withEffects(meaning, { sourcePosition: null, date: meaning.bookingDate, amount: meaning.amount }, classification, effects.ownerships, effects.checks);
}

export function wegWithEffects(registry: RuleRegistry, facts: WegSourceFacts, effects: Effects, today: BusinessDate): WegTaxMeaning {
  const meaning = baseWegMeaning(effects.weg, facts, registry, today);
  const classification = effects.weg.current.get(wegSourceKey(facts)) ?? null;
  return withEffects(
    meaning,
    { sourcePosition: facts.sourcePosition, date: facts.date, amount: facts.amount },
    classification,
    effects.ownerships,
    effects.checks,
  );
}

/** A split meaning as a source of the anschaffungsnahe check (§58B). */
function splitCheckSource(meaning: TaxMeaning, classification: TaxClassification | null): CheckSource {
  return {
    sourceType: 'TRANSACTION_SPLIT',
    sourceId: meaning.splitId,
    sourcePosition: null,
    date: meaning.bookingDate,
    taxYear: meaning.taxYear,
    taxCategory: meaning.taxCategory,
    treatment: meaning.treatment,
    reviewState: meaning.reviewState,
    origin: meaning.origin,
    classificationId: meaning.classificationId,
    grossAmount: meaning.amount,
    direction: meaning.direction,
    netAmount: meaning.netAmount,
    annuallyRecurring: classification?.annuallyRecurring ?? false,
    anschaffungsnaheAcquisitionId: classification?.anschaffungsnaheAcquisitionId ?? null,
    sourceFlags: [],
  };
}
