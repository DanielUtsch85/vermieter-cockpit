import { centsOf, divideHalfUp, moneyOfCents } from '../../shared/index.js';
import { ONE, ZERO, cmp, type Frac } from './exact.js';
import type { BuildingLinearParameters } from './rules/de-afa-building-linear.js';
import type { Flag } from './schedule-model.js';
import type { Part, Work } from './purchase-work.js';
import { declaredAfaOf } from './shorter-life.js';

/**
 * §59G Part 2 (VC-X-41; the owner's decisions of 2026-11-02, open questions 3, 10 and 11): whether an owner's part of a
 * late evidence's purchase spreads its carried-forward residual value from the switch month `S`, judged per owner once
 * the part's months are walked:
 *
 * - a part no longer held at `S` (its tenure ended before) never reaches the switch: the entry changes none of its figures;
 * - a part held only in part at `S` (a share reduced between the first year and `S`): its shown residual value includes
 *   the sold fraction's, which keeps it (P8-D8), so `R_i` is not the held part's residual: **still not supported**,
 *   `SHORTER_USEFUL_LIFE_RESIDUAL_NOT_SUPPORTED` with `cause: SHARE_REDUCED_BEFORE_SWITCH` (the conservative reading);
 * - otherwise the release: the entry's own conditions (`ADVISOR_CONFIRMED`, its evidence, its release note) and the
 *   owner's declared AfA through `YE − 1` (`DECLARED_AFA`), missing ones named by `SHORTER_USEFUL_LIFE_RELEASE_MISSING`;
 *   a declared AfA other than the computed one, to the cent, is `DECLARED_AFA_DIFFERS` (both amounts). Each stops that
 *   owner's years from `YE` only; the other owners and the years before `YE` stand.
 */

/** Whether the part is held in full at `S` (spread), not at all (unaffected), or in part (not supported). */
export function heldAtSwitch(fractionAt: (m: number) => Frac, switchMonth: number): 'FULL' | 'NONE' | 'PART' {
  const f = fractionAt(switchMonth);
  return cmp(f, ONE) === 0 ? 'FULL' : cmp(f, ZERO) === 0 ? 'NONE' : 'PART';
}

/** The owner's AfA through `year` as computed and shown (`round(b_i · C_i(year))`, half-up to the cent). */
export function shownCumulativeCents(p: Pick<Part, 'years' | 'basisCents'>, year: number): bigint {
  let value = ZERO;
  for (const [y, v] of [...p.years.entries()].sort(([x], [z]) => x - z)) if (y <= year) value = v.cumulative;
  return divideHalfUp((p.basisCents ?? 0n) * value.n, value.d);
}

/** The owner's reasons from `YE` on, or `null` when the part spreads (or is not affected). */
export function residualStopOf(w: Work, p: Part, parameters: BuildingLinearParameters | undefined): Part['residualStop'] {
  const c = w.shorterLife;
  if (w.residual === null || c.kind !== 'FROM_EVIDENCE_YEAR' || p.fractionAt === null) return null;
  const held = heldAtSwitch(p.fractionAt, w.residual.switchMonth);
  if (held === 'NONE') return null;
  const { entry, fromYear, firstYear } = c;
  const acquisitionId = w.acquisition.id;
  if (held === 'PART') {
    return {
      year: fromYear,
      reasons: [
        {
          code: 'SHORTER_USEFUL_LIFE_RESIDUAL_NOT_SUPPORTED',
          details: {
            acquisitionId,
            evidenceDate: entry.evidence.date,
            valuationDate: entry.evidence.valuationDate,
            firstYear,
            fromYear,
            cause: 'SHARE_REDUCED_BEFORE_SWITCH',
          },
        },
      ],
    };
  }
  const reasons: Flag[] = [];
  const declared = declaredAfaOf(entry, p.ownerPartyId, fromYear);
  const declaredRequired = (parameters?.shorterUsefulLife.lateEvidenceRelease.declaredAfa ?? 'PER_OWNER_THROUGH_YEAR_BEFORE') !== 'NOT_REQUIRED';
  const missing = [...c.releaseMissing, ...(declaredRequired && declared === undefined ? ['DECLARED_AFA'] : [])];
  if (missing.length > 0) reasons.push({ code: 'SHORTER_USEFUL_LIFE_RELEASE_MISSING', details: { acquisitionId, missing } });
  if (declared !== undefined) {
    const computed = shownCumulativeCents(p, fromYear - 1);
    // Equal to the cent, never within a tolerance: DE corrects neither amount and picks neither (open question 11).
    if (centsOf(declared.amount) !== computed) {
      reasons.push({
        code: 'DECLARED_AFA_DIFFERS',
        details: {
          acquisitionId,
          throughYear: fromYear - 1,
          declaredAfa: declared.amount.toJSON(),
          computedAfa: moneyOfCents(computed, declared.amount.currency).toJSON(),
        },
      });
    }
  }
  return reasons.length === 0 ? null : { year: fromYear, reasons };
}
