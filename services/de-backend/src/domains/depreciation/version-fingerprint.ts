import { canonicalJson, centsText, type Fingerprinter } from './fingerprint.js';
import { firstYearOfComponent } from './version-inputs.js';
import type { VersionComponent, VersionEntry, VersionInputs, VersionPart } from './version-model.js';

/**
 * The fingerprints of api-design.md §60 "Changed since recorded": the inputs **truncated to the end of a year** (a change
 * after `Y` never changes the fingerprint of `Y`), what counts in them (review states, the asset's row version,
 * `notes`, `sourceReferences`, a cost's payment status and `computedOn` do not), and the entries' output fingerprint.
 */

const endOf = (year: number) => `${year}-12-31`;

/** The inputs as far as they reach year `year`: the components started by then, fractions and ends up to its end. */
export function truncateInputs(inputs: VersionInputs, year: number): VersionInputs {
  const part = (p: VersionPart): VersionPart => {
    const ended = p.lastDay !== null && p.lastDay <= endOf(year);
    return {
      ...p,
      lastDay: ended ? p.lastDay : null,
      lastDaySource: ended ? p.lastDaySource : null,
      fractions: p.fractions.filter((f) => Number(f.month.slice(0, 4)) <= year),
    };
  };
  const started = (c: VersionComponent) => {
    const first = firstYearOfComponent(c);
    return first === null || first <= year;
  };
  return {
    ...inputs,
    rules: inputs.rules.filter((r) => r.firstYear <= year).map((r) => ({ ...r, lastYear: Math.min(r.lastYear, year) })),
    components: inputs.components.filter(started).map((c) => ({ ...c, parts: c.parts.map(part) })),
  };
}

/** A component as it counts (§60 "What counts as a change"): its inputs without the review states. */
export function countedComponent(c: VersionComponent): Record<string, unknown> {
  return {
    componentId: c.componentId,
    kind: c.kind,
    computable: c.computable,
    basis: centsText(c.basis),
    start: c.start,
    rate: c.rate,
    acquisition:
      c.acquisition === null
        ? null
        : {
            acquisitionId: c.acquisition.acquisitionId,
            purchasePrice: centsText(c.acquisition.purchasePrice),
            countedCostIds: c.acquisition.countedCostIds,
            countedCostsTotal: centsText(c.acquisition.countedCostsTotal),
            excludedCostIds: c.acquisition.excludedCostIds,
            excludedCostsTotal: centsText(c.acquisition.excludedCostsTotal),
            // §59D: the classifications that decided, from the component's first year.
            costClassificationIds: c.acquisition.costClassificationIds,
            allocationId: c.acquisition.allocationId,
            totalAllocableAmount: centsText(c.acquisition.totalAllocableAmount),
            buildingAmount: centsText(c.acquisition.buildingAmount),
          },
    // §59C: the method entry gates the whole component, so its facts and review state count from its first year.
    method: c.method,
    item:
      c.item === null
        ? null
        : {
            sourceType: c.item.sourceType,
            sourceId: c.item.sourceId,
            sourcePosition: c.item.sourcePosition,
            classificationId: c.item.classificationId,
            taxCategory: c.item.taxCategory,
            itemDate: c.item.itemDate,
            itemDateSource: c.item.itemDateSource,
            itemTaxYear: c.item.itemTaxYear,
            anschaffungsnaheAcquisitionId: c.item.anschaffungsnaheAcquisitionId,
          },
    parts: c.parts.map((p) => ({ ...p, basis: centsText(p.basis) })),
  };
}

/** The asset's facts that feed a figure, the calculation version and the rule references. */
export function countedHead(inputs: VersionInputs) {
  const a = inputs.asset;
  return {
    asset: {
      assetType: a.assetType,
      depreciationMethod: a.depreciationMethod,
      buildingCompletionYear: a.buildingCompletionYear,
      usefulLifeYears: a.usefulLifeYears,
      acquiredOn: a.acquiredOn,
    },
    currency: inputs.currency,
  };
}

/** `inputFingerprint(Y)` of §60. */
export function inputFingerprint(inputs: VersionInputs, year: number, fingerprinter: Fingerprinter): string {
  const t = truncateInputs(inputs, year);
  return fingerprinter.sha256Hex(
    canonicalJson({ ...countedHead(t), calculationVersion: t.calculationVersion, rules: t.rules, components: t.components.map(countedComponent) }),
  );
}

const entryView = (e: VersionEntry) => ({
  year: e.year,
  componentId: e.componentId,
  partKey: e.partKey,
  months: e.months,
  fraction: e.fraction,
  amount: centsText(e.amount),
  cumulative: centsText(e.cumulative),
  residualValue: centsText(e.residualValue),
});

/** The output fingerprint of the given entries (a year's, or the version's), ordered by year, `componentId`, part key. */
export function outputFingerprint(entries: readonly VersionEntry[], fingerprinter: Fingerprinter): string {
  const sorted = [...entries].sort(
    (a, b) => a.year - b.year || (a.componentId < b.componentId ? -1 : a.componentId > b.componentId ? 1 : a.partKey < b.partKey ? -1 : 1),
  );
  return fingerprinter.sha256Hex(canonicalJson(sorted.map(entryView)));
}

/** Whether the rule references (and the calculation version) up to `year` are the same. */
export function sameRules(a: VersionInputs, b: VersionInputs, year: number): boolean {
  return canonicalJson(truncateInputs(a, year).rules) === canonicalJson(truncateInputs(b, year).rules);
}

/** Whether the inputs up to `year` are the same, the rule references and the calculation version left out. */
export function sameInputs(a: VersionInputs, b: VersionInputs, year: number): boolean {
  const view = (x: VersionInputs) => {
    const t = truncateInputs(x, year);
    return canonicalJson({ ...countedHead(t), components: t.components.map(countedComponent) });
  };
  return view(a) === view(b);
}
