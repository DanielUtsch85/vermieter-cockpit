import { describe, expect, it } from 'vitest';
import { RuleRegistry } from '../../shared/index.js';
import { advisorsOf, amendFieldsNotAllowed, assetFingerprint, planAssetAmend, writtenPurchaseMethods, type NewDepreciationAsset } from './asset.js';
import { METHOD_CAUSES, methodReasonOf, methodStatusOf, type MethodStatusParameters, type PurchaseMethod } from './purchase-method.js';
import { purchaseMethodStatuses } from './rate.js';
import { DE_AFA_BUILDING_LINEAR_V1, DE_AFA_BUILDING_LINEAR_V2 } from './rules/de-afa-building-linear.js';
import { DEPRECIATION_RULE_VERSIONS } from './rules/versions.js';
import { W, X, Y, asset, standard } from './schedule.test-support.js';

/**
 * VC-X-37 (api-design.md §59C "The model"): the derived `methodStatus` and its `causes` from the rule's parameter, the
 * gate's two reasons, and the amend of the entries on §59's pattern (the difference by `acquisitionId`, a changed fact
 * resets the review state, a changed evidence or note does not). Synthetic.
 */
const parameters: MethodStatusParameters = DE_AFA_BUILDING_LINEAR_V2.parameters.methodStatus;
const status = (overrides: Partial<PurchaseMethod>) => methodStatusOf(standard(overrides), parameters);

describe('methodStatus and its causes (§59C)', () => {
  it('the standard case: paid, LINEAR_7_4, no special depreciation, no subsidies, no conversion, no other case', () => {
    expect(status({})).toEqual({ methodStatus: 'STANDARD', causes: [] });
  });

  it('each fact alone is NOT_SUPPORTED with its one cause (each of the six facts of the standard)', () => {
    const cases: [Partial<PurchaseMethod>, string][] = [
      [{ consideration: 'PARTLY_PAID' }, 'PARTLY_PAID'],
      [{ consideration: 'UNPAID' }, 'UNPAID'],
      [{ method: 'DEGRESSIVE_7_5' }, 'METHOD_DEGRESSIVE_7_5'],
      [{ method: 'DEGRESSIVE_7_5A' }, 'METHOD_DEGRESSIVE_7_5A'],
      [{ method: 'OTHER' }, 'METHOD_OTHER'],
      [{ specialDepreciation: ['SPECIAL_7B'] }, 'SPECIAL_7B'],
      [{ specialDepreciation: ['INCREASED_7H'] }, 'INCREASED_7H'],
      [{ specialDepreciation: ['INCREASED_7I'] }, 'INCREASED_7I'],
      [{ specialDepreciation: ['OTHER'] }, 'SPECIAL_OTHER'],
      [{ subsidiesReceived: true }, 'SUBSIDIES_RECEIVED'],
      [{ newBuildingByConversion: true }, 'NEW_BUILDING_BY_CONVERSION'],
      [{ otherSpecialCase: true, otherSpecialCaseNote: 'Denkmal (synthetisch)' }, 'OTHER_SPECIAL_CASE'],
    ];
    for (const [facts, cause] of cases) expect(status(facts), cause).toEqual({ methodStatus: 'NOT_SUPPORTED', causes: [cause] });
    // Every cause of the table is reached by exactly one case.
    expect(cases.map(([, cause]) => cause).sort()).toEqual([...METHOD_CAUSES].sort());
  });

  it('all facts together: every cause once, in the table’s order, whatever order the special depreciations are named in', () => {
    const all = status({
      consideration: 'UNPAID',
      method: 'OTHER',
      specialDepreciation: ['OTHER', 'INCREASED_7I', 'SPECIAL_7B', 'INCREASED_7H'],
      subsidiesReceived: true,
      newBuildingByConversion: true,
      otherSpecialCase: true,
      otherSpecialCaseNote: 'x',
    });
    expect(all).toEqual({
      methodStatus: 'NOT_SUPPORTED',
      causes: [
        'UNPAID',
        'METHOD_OTHER',
        'SPECIAL_7B',
        'INCREASED_7H',
        'INCREASED_7I',
        'SPECIAL_OTHER',
        'SUBSIDIES_RECEIVED',
        'NEW_BUILDING_BY_CONVERSION',
        'OTHER_SPECIAL_CASE',
      ],
    });
  });

  it('the judgement is the rule’s: a test parameter with another standard changes the status (never a constant)', () => {
    const degressiveToo = { ...parameters, standard: { ...parameters.standard, methods: ['LINEAR_7_4', 'DEGRESSIVE_7_5'] } };
    expect(methodStatusOf(standard({ method: 'DEGRESSIVE_7_5' }), degressiveToo)).toEqual({ methodStatus: 'STANDARD', causes: [] });
    const subsidised = { ...parameters, standard: { ...parameters.standard, subsidiesReceived: true } };
    expect(methodStatusOf(standard(), subsidised).methodStatus).toBe('NOT_SUPPORTED');
    expect(methodStatusOf(standard({ subsidiesReceived: true }), subsidised).methodStatus).toBe('STANDARD');
  });
});

describe('the gate’s reason (§59C "The gate in the schedule")', () => {
  const reason = (entry: PurchaseMethod | undefined, p: MethodStatusParameters | undefined = parameters) => methodReasonOf(W, entry, p, false);

  it('no entry: DEPRECIATION_METHOD_NOT_CONFIRMED with null details; an UNREVIEWED or NEEDS_REVIEW entry, standard or not, too', () => {
    expect(reason(undefined)).toEqual({
      code: 'DEPRECIATION_METHOD_NOT_CONFIRMED',
      details: { acquisitionId: W, reviewState: null, methodStatus: null, causes: null, newBuildingInCompletionYear: false },
    });
    for (const reviewState of ['UNREVIEWED', 'NEEDS_REVIEW'] as const) {
      expect(reason(standard({ reviewState }))).toEqual({
        code: 'DEPRECIATION_METHOD_NOT_CONFIRMED',
        details: { acquisitionId: W, reviewState, methodStatus: 'STANDARD', causes: [], newBuildingInCompletionYear: false },
      });
      expect(reason(standard({ reviewState, method: 'DEGRESSIVE_7_5A' }))?.details).toMatchObject({
        reviewState,
        methodStatus: 'NOT_SUPPORTED',
        causes: ['METHOD_DEGRESSIVE_7_5A'],
      });
    }
  });

  it('CONFIRMED and ADVISOR_CONFIRMED: none for STANDARD, DEPRECIATION_METHOD_NOT_SUPPORTED with the causes otherwise', () => {
    for (const reviewState of ['CONFIRMED', 'ADVISOR_CONFIRMED'] as const) {
      expect(reason(standard({ reviewState }))).toBeNull();
      expect(reason(standard({ reviewState, subsidiesReceived: true }))).toEqual({
        code: 'DEPRECIATION_METHOD_NOT_SUPPORTED',
        details: { acquisitionId: W, reviewState, causes: ['SUBSIDIES_RECEIVED'] },
      });
    }
  });

  it('the confirmed states are the rule’s; without the parameter nothing is judged and the purchase is not confirmed', () => {
    const advisorOnly = { ...parameters, confirmedReviewStates: ['ADVISOR_CONFIRMED'] };
    expect(reason(standard({ reviewState: 'CONFIRMED' }), advisorOnly)?.code).toBe('DEPRECIATION_METHOD_NOT_CONFIRMED');
    expect(reason(standard({ reviewState: 'ADVISOR_CONFIRMED' }), advisorOnly)).toBeNull();
    expect(methodReasonOf(W, standard(), undefined, false)?.code).toBe('DEPRECIATION_METHOD_NOT_CONFIRMED');
  });
});

describe('the asset’s answer: each entry’s status by the rule of its start year, else the latest (§59C "Responses")', () => {
  it('a start in 2020 reads @1, one in 2024 or without a start the latest (@2): a test registry whose @1 admits DEGRESSIVE_7_5', () => {
    const v1 = DE_AFA_BUILDING_LINEAR_V1.parameters;
    const registry = new RuleRegistry([
      {
        ...DE_AFA_BUILDING_LINEAR_V1,
        parameters: { ...v1, methodStatus: { ...v1.methodStatus, standard: { ...v1.methodStatus.standard, methods: ['DEGRESSIVE_7_5'] } } },
      },
      DE_AFA_BUILDING_LINEAR_V2,
    ]);
    const a = asset({ purchaseMethods: [standard({ acquisitionId: Y, method: 'DEGRESSIVE_7_5' }), standard({ acquisitionId: X, method: 'DEGRESSIVE_7_5' })] });
    expect(purchaseMethodStatuses(a, registry, { [X]: 2020, [Y]: 2024 }).map((s) => [s.acquisitionId, s.methodStatus])).toEqual([
      [X, 'STANDARD'],
      [Y, 'NOT_SUPPORTED'],
    ]);
    expect(purchaseMethodStatuses(a, registry).map((s) => s.methodStatus)).toEqual(['NOT_SUPPORTED', 'NOT_SUPPORTED']);
    expect(purchaseMethodStatuses(a, new RuleRegistry(DEPRECIATION_RULE_VERSIONS), { [X]: 2020 })[0]?.causes).toEqual(['METHOD_DEGRESSIVE_7_5']);
  });
});

describe('the amend of the entries (§59C, on §59’s pattern)', () => {
  const current = asset({
    purchaseMethods: [standard({ acquisitionId: W }), standard({ acquisitionId: X, reviewState: 'ADVISOR_CONFIRMED', advisorPartyId: Y })],
  });
  const named = (e: PurchaseMethod) => {
    const { reviewState: _r, advisorPartyId: _a, ...rest } = e;
    return rest;
  };

  it('the same list is a no-op; a changed fact resets to UNREVIEWED (the advisor cleared), the AuditRecord’s from and to', () => {
    expect(planAssetAmend(current, { purchaseMethods: current.purchaseMethods.map(named) }).changed).toBe(false);
    const plan = planAssetAmend(current, {
      purchaseMethods: [named(standard({ acquisitionId: W, method: 'DEGRESSIVE_7_5' })), named(current.purchaseMethods[1] as PurchaseMethod)],
    });
    expect(plan.changedPurchaseMethods).toEqual([
      {
        acquisitionId: W,
        change: 'CHANGED',
        from: current.purchaseMethods[0],
        to: { ...standard({ acquisitionId: W, method: 'DEGRESSIVE_7_5' }), reviewState: 'UNREVIEWED', advisorPartyId: null },
      },
    ]);
    // The advisor's confirmation of X is untouched: its facts did not change.
    expect(plan.next.purchaseMethods[1]).toEqual(current.purchaseMethods[1]);
    const factOfX = planAssetAmend(current, {
      purchaseMethods: [named(current.purchaseMethods[0] as PurchaseMethod), named(standard({ acquisitionId: X, newBuildingByConversion: true }))],
    });
    expect(factOfX.next.purchaseMethods[1]).toMatchObject({ reviewState: 'UNREVIEWED', advisorPartyId: null });
  });

  it('a changed evidence, notes or note keeps the review state; the special depreciations compared as a set', () => {
    const quiet = planAssetAmend(current, {
      purchaseMethods: [
        {
          ...named(standard({ acquisitionId: W })),
          evidence: { source: 'Anlage V 2024 (synthetisch)', date: standard().evidence.date, documentReference: 'S. 2' },
          notes: 'x',
        },
        named(current.purchaseMethods[1] as PurchaseMethod),
      ],
    });
    expect([quiet.changed, quiet.next.purchaseMethods.map((e) => e.reviewState)]).toEqual([true, ['CONFIRMED', 'ADVISOR_CONFIRMED']]);
    const special = asset({ purchaseMethods: [standard({ specialDepreciation: ['SPECIAL_7B', 'INCREASED_7H'], reviewState: 'CONFIRMED' })] });
    const reordered = planAssetAmend(special, { purchaseMethods: [named(standard({ specialDepreciation: ['INCREASED_7H', 'SPECIAL_7B'] }))] });
    expect(reordered.changed).toBe(false);
  });

  it('a state named confirms (amend’s job); added and removed entries; only new or changed entries are checked again', () => {
    const confirmed = planAssetAmend(asset({ purchaseMethods: [standard({ reviewState: 'UNREVIEWED' })] }), {
      purchaseMethods: [{ ...named(standard()), reviewState: 'CONFIRMED' }],
    });
    expect(confirmed.next.purchaseMethods[0]?.reviewState).toBe('CONFIRMED');
    const plan = planAssetAmend(current, { purchaseMethods: [named(current.purchaseMethods[1] as PurchaseMethod), named(standard({ acquisitionId: Y }))] });
    expect(plan.changedPurchaseMethods.map((c) => [c.acquisitionId, c.change])).toEqual([
      [W, 'REMOVED'],
      [Y, 'ADDED'],
    ]);
    expect(writtenPurchaseMethods(plan).map((e) => [e.acquisitionId, e.reviewState])).toEqual([[Y, 'UNREVIEWED']]);
    expect(planAssetAmend(current, { purchaseMethods: [] }).next.purchaseMethods).toEqual([]);
  });

  it('a separate asset names no entry (NOT_ALLOWED); the fingerprint and the advisors include the entries', () => {
    expect(amendFieldsNotAllowed('SEPARATE_ASSET', { purchaseMethods: [] })).toEqual(['purchaseMethods']);
    expect(amendFieldsNotAllowed('BUILDING', { purchaseMethods: [] })).toEqual([]);
    const created = (purchaseMethods: PurchaseMethod[]): NewDepreciationAsset => ({ ...asset(), purchaseMethods });
    expect(assetFingerprint(created([standard({ acquisitionId: W }), standard({ acquisitionId: X })]))).toBe(
      assetFingerprint(created([standard({ acquisitionId: X }), standard({ acquisitionId: W })])),
    );
    expect(assetFingerprint(created([standard()]))).not.toBe(assetFingerprint(created([standard({ subsidiesReceived: true })])));
    expect(assetFingerprint(created([standard()]))).not.toBe(assetFingerprint(created([standard({ notes: 'x' })])));
    expect(
      advisorsOf({ advisorPartyId: null, shorterUsefulLives: [], purchaseMethods: [standard({ reviewState: 'ADVISOR_CONFIRMED', advisorPartyId: Y })] }),
    ).toEqual([Y]);
  });
});
