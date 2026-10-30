import type { AppCommands } from './app.js';

const unused = () => Promise.reject(new Error('not used in this test'));

/** Every command of AppCommands, per module, rejecting if called. Test support only. */
export const unusedCommands: AppCommands = {
  propertyReferences: { link: unused, refresh: unused, get: unused, list: unused },
  parties: { create: unused, get: unused, list: unused, amend: unused, deactivate: unused },
  externalReferences: { create: unused, end: unused, list: unused },
  ownerships: { create: unused, get: unused, close: unused, void: unused, read: unused, change: unused },
  acquisitions: { create: unused, get: unused, list: unused, listForPropertyReference: unused, cancel: unused, confirm: unused },
  ownerAllocation: { get: unused },
  landBuildingAllocations: { create: unused, list: unused },
  acquisitionCosts: { createCost: unused, voidCost: unused, listCosts: unused, linkPayment: unused, unlinkPayment: unused, listPayments: unused },
  loans: { create: unused, get: unused, list: unused, amend: unused, void: unused, close: unused },
  securityDeposits: { create: unused, get: unused, list: unused, amend: unused, void: unused, close: unused, reopen: unused },
  wegs: {
    createWeg: unused,
    getWeg: unused,
    listWegs: unused,
    amendWeg: unused,
    voidWeg: unused,
    createMembership: unused,
    getMembership: unused,
    listMemberships: unused,
    readUnitMemberships: unused,
    amendMembership: unused,
    endMembership: unused,
    voidMembership: unused,
  },
  wegEconomicPlans: { create: unused, get: unused, list: unused, void: unused, hausgeldProposal: unused },
  wegAnnualStatements: {
    create: unused,
    get: unused,
    list: unused,
    replace: unused,
    confirm: unused,
    void: unused,
    comparison: unused,
    settlementProposal: unused,
  },
  wegSpecialAssessments: { create: unused, get: unused, list: unused, amend: unused, replaceUses: unused, void: unused },
  taxation: {
    create: unused,
    get: unused,
    history: unused,
    review: unused,
    taxMeaning: unused,
    depositTaxMeaning: unused,
    withdrawalTaxMeaning: unused,
    useTaxMeaning: unused,
    anschaffungsnahe: unused,
    taxMeanings: unused,
    taxYear: unused,
    listRules: unused,
    getRule: unused,
  },
  rentalContractReferences: { create: unused, get: unused, list: unused, amend: unused },
  depreciationAssets: { create: unused, get: unused, listForPropertyReference: unused, amend: unused, confirm: unused, void: unused },
  rentReconciliations: {
    create: unused,
    get: unused,
    list: unused,
    release: unused,
    termCoverage: unused,
    transactionCoverage: unused,
    suggest: unused,
    confirm: unused,
    reject: unused,
    writeBack: unused,
    getWithPresence: unused,
    removeFromMre: unused,
    splitProposal: unused,
  },
  loanTerms: { create: unused, void: unused, list: unused, schedule: unused, proposal: unused },
  loanDebt: { remainingDebt: unused, payments: unused, createStatement: unused, voidStatement: unused, listStatements: unused },
  loanAllocations: { create: unused, void: unused, list: unused, on: unused, propertyLoans: unused },
  financialAccounts: { create: unused, close: unused, get: unused, list: unused },
  transactions: {
    createManual: unused,
    setSplits: unused,
    confirm: unused,
    correct: unused,
    reverse: unused,
    get: unused,
    list: unused,
    listForPropertyReference: unused,
    amend: unused,
    ignore: unused,
    restore: unused,
  },
  imports: { importStatement: unused, getBatch: unused, listReviewItems: unused, resolveReviewItem: unused },
  financialCategories: { list: unused, get: unused },
};

/** Commands a test supplies: per module, any subset of that module's commands. */
export type CommandOverrides = { readonly [M in keyof AppCommands]?: Partial<AppCommands[M]> };

/** `unusedCommands` with the given overrides merged in per module, later ones winning. Test support only. */
export function commandsWith(...overrides: readonly CommandOverrides[]): AppCommands {
  const merged: Record<string, object> = { ...unusedCommands };
  for (const override of overrides) {
    for (const [module, commands] of Object.entries(override)) merged[module] = { ...merged[module], ...(commands as object) };
  }
  return merged as unknown as AppCommands;
}
