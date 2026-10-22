import type { AppDependencies } from './app.js';

const unused = () => Promise.reject(new Error('not used in this test'));

/** Every command of AppDependencies, rejecting if called. Spread and override what a test uses. Test support only. */
export const unusedCommands: Omit<AppDependencies, 'isReady' | 'verifyPrincipal'> = {
  linkPropertyReference: unused,
  refreshPropertyReference: unused,
  createParty: unused,
  getParty: unused,
  listParties: unused,
  amendParty: unused,
  deactivateParty: unused,
  createFinancialAccount: unused,
  closeFinancialAccount: unused,
  createManualTransaction: unused,
  confirmTransaction: unused,
  correctTransaction: unused,
  reverseTransaction: unused,
  getTransaction: unused,
  listTransactions: unused,
  listPropertyReferenceTransactions: unused,
  amendTransaction: unused,
  ignoreTransaction: unused,
  restoreTransaction: unused,
  setTransactionSplits: unused,
  listFinancialCategories: unused,
  getFinancialCategory: unused,
  importBankStatement: unused,
  getImportBatch: unused,
  listReviewItems: unused,
  resolveReviewItem: unused,
};
