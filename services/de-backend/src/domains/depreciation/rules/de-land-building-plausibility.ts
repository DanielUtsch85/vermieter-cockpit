import { LAND_BUILDING_PLAUSIBILITY, type LandBuildingPlausibilityParameters } from '../../acquisition/index.js';
import type { BusinessDate, RuleVersion } from '../../../shared/index.js';

/**
 * `DE_LAND_BUILDING_PLAUSIBILITY` (api-design.md §58T rule 5, VC-X-44; Entscheidung des Projektinhabers, 2026-11-06,
 * question 9): the threshold of the plausibility warning on a land/building allocation, its directions, the methods
 * whose allocation without a comparison carries the informative hint, and the review states that close the warning
 * without a reason (question 5). It decides **no figure**: it is not named by a component's year, not listed in §59A's
 * `ruleVersions` and not in a recorded version's inputs; the flag names it in `details.rule`. Pinned on its own in
 * `frozen-rules.test.ts`.
 *
 * The threshold of 10 percentage points is the **provisional default** of question 2, explicitly **not a legal
 * threshold** (the tax review names none; `landShareDeviationVerified: false`). The tax advisor is asked for a number
 * (`docs/germany/beratungsfragen.md` §2). An answer that arrives before the first enablement of stage 1 is worked into
 * this version in place, as §60 open question 11 allows for the AfA rules (the pin updated explicitly); after it, the
 * answer is `@2`.
 */
export const DE_LAND_BUILDING_PLAUSIBILITY_V1: RuleVersion<LandBuildingPlausibilityParameters> = {
  ruleCode: LAND_BUILDING_PLAUSIBILITY,
  version: 1,
  title: 'Plausibilisierung der Aufteilung Grund und Boden / Gebäude',
  legalBasis: 'keine Schwelle im Gesetz; Plausibilisierung nach Prüfbericht 2026-11-01, Frage 17 (BFH IX R 12/14, VERIFY)',
  effectiveFrom: '2006-01-01' as BusinessDate,
  effectiveTo: null,
  parameters: {
    landShareDeviation: '0.10',
    landShareDeviationVerified: false,
    directions: ['LAND_SHARE_LOWER', 'LAND_SHARE_HIGHER'],
    notCheckedMethods: ['PURCHASE_CONTRACT', 'OTHER'],
    closingReviewStates: ['ADVISOR_CONFIRMED'],
  },
  source:
    'api-design §58T; Prüfbericht 2026-11-01, Frage 17 (mündlich bestätigt durch den Steuerberater, laut Projektinhaber am 2026-11-01); Entscheidung des Projektinhabers, 2026-11-06 (Fragen 1 bis 10; Schwelle vorläufig, beratungsfragen.md §2)',
};
