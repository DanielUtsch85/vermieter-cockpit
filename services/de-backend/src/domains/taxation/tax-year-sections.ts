import { centsOf, moneyOfCents } from '../../shared/index.js';
import { itemAt, type Derived } from './tax-year-items.js';
import { EINNAHMEN_LINES, SUBTOTAL_LINES, WERBUNGSKOSTEN_LINES, type Placement } from './tax-year-placement.js';
import { BASIS_OF } from './tax-year-depreciation.js';
import type { AfaLine, TaxYearLine, TaxYearResult, TaxYearSection, TaxYearTotals } from './tax-year-response.js';
import type { TaxCategory } from './vocabulary.js';

/** The sums of the tax-year view (api-design.md §58C): its lines, sections and the result, at a level (the AfA by `withAfa`). */

const kindOf = (cents: bigint): TaxYearResult['kind'] => (cents > 0n ? 'SURPLUS' : cents < 0n ? 'LOSS' : 'ZERO');

/** Lines and totals from the derived items at a level (the property's, or one participant's). */
export function sectionsOf(derived: readonly Derived[], year: number, currency: string, participant: string | undefined) {
  const money = (cents: bigint) => moneyOfCents(cents, currency);
  const takesPart = (d: Derived) => participant === undefined || d.parts.has(participant);
  const cents = (d: Derived) => (participant === undefined ? (d.lineCents ?? 0n) : (d.parts.get(participant) ?? 0n));
  const line = (taxCategory: TaxCategory): TaxYearLine => {
    const on = derived.filter((d) => d.placement.place === 'LINE' && d.placement.line === taxCategory && takesPart(d));
    const sum = (ds: readonly Derived[]) => ds.reduce((s, d) => s + cents(d), 0n);
    const distributed = on.filter((d) => d.source.treatment === 'DISTRIBUTED_82B');
    return {
      line: taxCategory,
      taxCategory,
      total: money(sum(on)),
      itemCount: on.length,
      subtotals: SUBTOTAL_LINES.includes(taxCategory)
        ? { immediate: money(sum(on.filter((d) => d.source.treatment !== 'DISTRIBUTED_82B'))), distributed82b: money(sum(distributed)) }
        : null,
      items: on.map((d) => itemAt(d, year, currency, participant)),
    };
  };
  const section = (lines: readonly TaxCategory[]): TaxYearSection => {
    const built = lines.map(line);
    return { total: money(built.reduce((s, l) => s + centsOf(l.total), 0n)), lines: built };
  };
  const einnahmen = section(EINNAHMEN_LINES);
  const werbungskosten = section(WERBUNGSKOSTEN_LINES);
  const resultCents = centsOf(einnahmen.total) - centsOf(werbungskosten.total);
  const capitalizedItems = derived.filter((d) => d.placement.place === 'CAPITALIZED' && takesPart(d));
  const listed = (place: Placement['place']) =>
    derived.filter((d) => d.placement.place === place && takesPart(d)).map((d) => itemAt(d, year, currency, participant));
  return {
    einnahmen,
    werbungskosten,
    result: { amount: money(resultCents), kind: kindOf(resultCents), basis: 'BEFORE_DEPRECIATION' } as TaxYearResult,
    capitalized: {
      total: money(capitalizedItems.reduce((s, d) => s + cents(d), 0n)),
      items: capitalizedItems.map((d) => itemAt(d, year, currency, participant)),
    },
    notInView: { items: listed('NOT_IN_VIEW') },
    unclassified: { items: listed('UNCLASSIFIED') },
  };
}

export const withoutItems = (s: TaxYearSection): TaxYearTotals['werbungskosten'] => ({
  total: s.total,
  lines: s.lines.map(({ items: _items, ...line }) => line),
  ...(s.afaLines === undefined ? {} : { afaLines: s.afaLines.map(({ items: _items, ...line }) => line) }),
});

/**
 * The sections of a level with its AfA (§58C "VC-8-05"): the two AfA lines appended to the Werbungskosten, their total
 * in the Werbungskosten total, the result Einnahmen − Werbungskosten, its basis from the AfA's status.
 */
export function withAfa<S extends ReturnType<typeof sectionsOf>>(
  s: S,
  afa: { readonly lines: readonly AfaLine[]; readonly totalCents: bigint; readonly status: keyof typeof BASIS_OF },
  currency: string,
): S {
  const werbungskostenCents = centsOf(s.werbungskosten.total) + afa.totalCents;
  const resultCents = centsOf(s.einnahmen.total) - werbungskostenCents;
  return {
    ...s,
    werbungskosten: { total: moneyOfCents(werbungskostenCents, currency), lines: s.werbungskosten.lines, afaLines: afa.lines },
    result: { amount: moneyOfCents(resultCents, currency), kind: kindOf(resultCents), basis: BASIS_OF[afa.status] },
  };
}
