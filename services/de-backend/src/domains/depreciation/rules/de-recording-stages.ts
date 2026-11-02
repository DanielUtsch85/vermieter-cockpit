import { RuleRegistry, type BusinessDate, type RuleVersion } from '../../../shared/index.js';

/**
 * The release stages of recording (VC-X-45, api-design.md §60A; owner's decisions of 2026-11-01 and 2026-11-02): which
 * facts of a component give its stage. Data, versioned like a rule, in a registry of its own (`RECORDING_STAGE_RULES`):
 * it is **not** in `TAX_RULES`, is never named by a component's year, never enters an input fingerprint or a recorded
 * version's rule versions, and is not one of the frozen calculation rules (A3). It decides only whether a year may be
 * recorded; it never changes an amount. A change of the mapping is a new version, never an edit in place.
 */

export const RECORDING_STAGES = [1, 2, 3] as const;
export type RecordingStage = (typeof RECORDING_STAGES)[number];

/** The criteria of §60A's table, in its order. */
export const STAGE_CRITERIA = [
  'PURCHASE',
  'CAPITALIZED_ITEM',
  'ANSCHAFFUNGSNAHE_CAPITALIZATION',
  'ANSCHAFFUNGSNAHE_CHECK_OPEN',
  'LOAN_INTEREST_COMPONENT',
  'MOVABLE_ASSET',
  'SHORTER_USEFUL_LIFE_ENTRY',
  'SEVERAL_PURCHASES_PARTIAL_SALE',
  'MOVABLE_ASSET_LATER_ADDITION',
] as const;
export type StageCriterion = (typeof STAGE_CRITERIA)[number];

export interface RecordingStagesParameters {
  /** Each criterion once with its stage; a criterion missing here counts as the highest stage. */
  readonly criteria: readonly { readonly code: StageCriterion; readonly stage: RecordingStage }[];
}

export const RECORDING_STAGES_RULE = 'DE_RECORDING_STAGES';

/** Version 1 (VC-X-45, §60A's table). */
export const DE_RECORDING_STAGES_V1: RuleVersion<RecordingStagesParameters> = {
  ruleCode: RECORDING_STAGES_RULE,
  version: 1,
  title: 'Freigabestufen der Erfassung von AfA-Planversionen',
  legalBasis: 'Produktentscheidung (keine Rechtsnorm)',
  effectiveFrom: '2000-01-01' as BusinessDate,
  effectiveTo: null,
  parameters: {
    criteria: [
      { code: 'PURCHASE', stage: 1 },
      { code: 'CAPITALIZED_ITEM', stage: 2 },
      { code: 'ANSCHAFFUNGSNAHE_CAPITALIZATION', stage: 2 },
      { code: 'ANSCHAFFUNGSNAHE_CHECK_OPEN', stage: 2 },
      { code: 'LOAN_INTEREST_COMPONENT', stage: 2 },
      { code: 'MOVABLE_ASSET', stage: 2 },
      { code: 'SHORTER_USEFUL_LIFE_ENTRY', stage: 3 },
      { code: 'SEVERAL_PURCHASES_PARTIAL_SALE', stage: 3 },
      { code: 'MOVABLE_ASSET_LATER_ADDITION', stage: 3 },
    ],
  },
  source:
    'Prüfbericht 2026-11-01, F (mündlich bestätigt durch den Steuerberater, laut Projektinhaber am 2026-11-01); owner decisions 2026-11-01 (design, A1, A3, A6) and 2026-11-02; api-design §60A',
};

/** The registry of the stage mapping: beside the calculation rules, not among them (never frozen, never fingerprinted). */
export const RECORDING_STAGE_RULES = new RuleRegistry([DE_RECORDING_STAGES_V1]);
