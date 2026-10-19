/**
 * Application layer: workflows/use-cases orchestrating domains.
 */
export { AccessError, DE_ACCESS_ROLES, assertDeAccess } from './access.js';
export type { AccessErrorCode, PrincipalVerifier, RealmPrincipal } from './access.js';
export { MrePropertyNotFoundError, MreUnavailableError, linkPropertyReference } from './link-property-reference.js';
export type {
  LinkPropertyReference,
  LinkPropertyReferenceDeps,
  LinkPropertyReferenceInput,
  MrePropertyLookup,
  MrePropertySnapshot,
} from './link-property-reference.js';
export type { CachedAddress, LinkOutcome, PropertyReference } from '../domains/property-reference/index.js';
export { MRE_OBJECT_ID } from '../domains/property-reference/index.js';
export { PropertyReferenceNotFoundError, refreshPropertyReference } from './refresh-property-reference.js';
export type {
  RefreshPropertyReference,
  RefreshPropertyReferenceDeps,
  RefreshPropertyReferenceInput,
} from './refresh-property-reference.js';
export {
  FinancialAccountNotFoundError,
  IdempotencyKeyConflictError,
  closeFinancialAccount,
  createFinancialAccount,
} from './financial-accounts.js';
export type {
  CloseFinancialAccount,
  CloseFinancialAccountInput,
  CreateFinancialAccount,
  CreateFinancialAccountInput,
  CreateFinancialAccountResult,
} from './financial-accounts.js';
export { ACCOUNT_TYPES } from '../domains/ledger/index.js';
export type { AccountType, FinancialAccount } from '../domains/ledger/index.js';
