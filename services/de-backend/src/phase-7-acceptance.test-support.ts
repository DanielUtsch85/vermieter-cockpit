/**
 * The response shapes and figure helpers of ACC7 (`phase-7-acceptance.e2e.test.ts`, invariant-suite §45): the tax-year
 * view and the anschaffungsnahe check as JSON, exact cents, the non-zero lines of a section. Test support only.
 */
export type Money = { amount: string; currency: string };
export type Flag = { code: string; details: unknown };
export type Item = {
  sourceType: string;
  sourceId: string;
  sourcePosition: number | null;
  date: string;
  taxYear: number;
  lineAmount: Money | null;
  taxCategory: string;
  treatment: string | null;
  rule: { ruleCode: string; version: number } | null;
  share: { ownershipId: string; share: string; amount: Money | null } | null;
  flags: Flag[];
  loanAllocation: { loanId: string; allocationSetId: string | null; share: string | null; propertyPart: Money | null } | null;
  reason?: string;
  candidates?: string[];
};
export type Line = { taxCategory: string; total: Money; itemCount: number; subtotals: { immediate: Money; distributed82b: Money } | null; items: Item[] };
export type Totals = {
  einnahmen: { total: Money; lines: Omit<Line, 'items'>[] };
  werbungskosten: { total: Money; lines: Omit<Line, 'items'>[] };
  result: { amount: Money; kind: string };
  capitalized: { total: Money };
};
export type View = {
  level: string;
  einnahmen: { total: Money; lines: Line[] };
  werbungskosten: { total: Money; lines: Line[] };
  depreciation: { status: string; amount: null };
  result: { amount: Money; kind: string; basis: string };
  capitalized: { total: Money; items: Item[] };
  notInView: { items: Item[] };
  unclassified: { items: Item[] };
  notAttributed: { items: Item[] };
  acquisitions: { acquisitionId: string; status: string; final: boolean }[];
  owners: (Totals & { ownerPartyId: string })[] | null;
  notOwned: Totals | null;
  flags: Flag[];
  review: { final: boolean; open: { code: string; count: number }[] };
  ruleVersions: { ruleCode: string; version: number }[];
};
export type Check = {
  status: string;
  threshold: Money;
  sum: Money;
  attributableAmount: Money;
  percentOfBasis: string;
  basis: { basisAmount: Money };
  affectedYears: number[];
  final: boolean;
  flags: Flag[];
  sources: { sourceType: string; sourceId: string; amountUsed: Money; suggestedTreatment: string | null }[];
  unclassified: { sourceType: string }[];
};

/** Cents of a Money JSON, exact. */
export const cents = (m: Money | null | undefined): bigint => {
  if (m === null || m === undefined) return 0n;
  const negative = m.amount.startsWith('-');
  const [w, f = ''] = m.amount.replace('-', '').split('.') as [string, string?];
  return (negative ? -1n : 1n) * (BigInt(w) * 100n + BigInt(f.padEnd(2, '0')));
};
export const codes = (flags: readonly Flag[]) => flags.map((f) => f.code);
/** The lines of a section with a total other than 0.00, as `{ taxCategory: amount }` (the lines are fixed, §58C). */
export const nonZero = (lines: readonly Omit<Line, 'items'>[]) =>
  Object.fromEntries(lines.filter((l) => cents(l.total) !== 0n).map((l) => [l.taxCategory, l.total.amount]));
export const figures = (t: Totals) => ({
  einnahmen: [t.einnahmen.total.amount, nonZero(t.einnahmen.lines)],
  werbungskosten: [t.werbungskosten.total.amount, nonZero(t.werbungskosten.lines)],
  result: [t.result.amount.amount, t.result.kind],
});
export const lineOf = (v: View, taxCategory: string) => [...v.einnahmen.lines, ...v.werbungskosten.lines].find((l) => l.taxCategory === taxCategory) as Line;
export const placed = (v: View) => [
  ...v.einnahmen.lines.flatMap((l) => l.items),
  ...v.werbungskosten.lines.flatMap((l) => l.items),
  ...v.capitalized.items,
  ...v.notInView.items,
  ...v.unclassified.items,
  ...v.notAttributed.items,
];
