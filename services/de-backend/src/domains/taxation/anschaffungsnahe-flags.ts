import type { AnschaffungsnaheCheck, CheckEntry, CheckEntryFlag } from './anschaffungsnahe.js';
import type { SourceType } from './vocabulary.js';

/**
 * The meaning flags a source takes from the checks that read it (§58B, §59F): from `sources` its VAT, Herstellungskosten
 * and no-longer-above flags; from `undetermined` and `outsideSearchRange` `PERFORMANCE_DATE_MISSING`, so the source
 * shows which date the check wants. The suggestion only for a source performed wholly in the window.
 */
export function checkFlagsOf(
  checks: readonly AnschaffungsnaheCheck[],
  source: { readonly sourceType: SourceType; readonly sourceId: string; readonly sourcePosition: number | null },
): {
  readonly flags: readonly CheckEntryFlag[];
  readonly suggestion: {
    readonly treatment: 'CAPITALIZED';
    readonly reason: 'ANSCHAFFUNGSNAHE_HERSTELLUNGSKOSTEN';
    readonly acquisitionIds: readonly string[];
    readonly final: boolean;
  } | null;
} {
  const flags: CheckEntryFlag[] = [];
  const above: AnschaffungsnaheCheck[] = [];
  const same = (e: CheckEntry) => e.sourceType === source.sourceType && e.sourceId === source.sourceId && e.sourcePosition === source.sourcePosition;
  for (const check of checks) {
    if (check.notComputableReason === 'NO_APPLICABLE_RULE') continue;
    if ([...check.undetermined, ...check.outsideSearchRange].some(same)) {
      flags.push({ code: 'PERFORMANCE_DATE_MISSING', details: { acquisitionId: check.acquisitionId } });
    }
    if (check.status === 'NOT_COMPUTABLE') continue;
    const found = [...check.sources, ...check.undetermined].find(same);
    if (found === undefined) continue;
    for (const flag of found.flags) {
      if (['VAT_NOT_SEPARATED', 'ANSCHAFFUNGSNAHE_HERSTELLUNGSKOSTEN', 'ANSCHAFFUNGSNAHE_NO_LONGER_ABOVE'].includes(flag.code)) flags.push(flag);
    }
    if (check.status === 'ABOVE_THRESHOLD' && found.suggestedTreatment === 'CAPITALIZED') above.push(check);
  }
  return {
    flags,
    suggestion:
      above.length === 0
        ? null
        : {
            treatment: 'CAPITALIZED',
            reason: 'ANSCHAFFUNGSNAHE_HERSTELLUNGSKOSTEN',
            acquisitionIds: above.map((c) => c.acquisitionId).sort(),
            final: above.every((c) => c.final),
          },
  };
}
