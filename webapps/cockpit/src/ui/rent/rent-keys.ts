import { realmKey } from '../../query';
import type { RentTermKey } from '../../routing';
import type { RentListParams } from './ReconciliationList';

/** Query keys of step 6; each starts with the Realm and the session's epoch (ui-guide.md §7.3). */
export const rentKeys = {
  /** Everything of the rent reconciliations of the Realm: what every step-6 command invalidates (§7.3: "zugehörige Mietabdeckung"). */
  all: (realmId: string, epoch: number) => realmKey(realmId, epoch, 'rent-reconciliations'),
  list: (realmId: string, epoch: number, params: RentListParams) => realmKey(realmId, epoch, 'rent-reconciliations', 'list', params),
  detail: (realmId: string, epoch: number, id: string) => realmKey(realmId, epoch, 'rent-reconciliations', 'detail', id),
  term: (realmId: string, epoch: number, term: RentTermKey) => realmKey(realmId, epoch, 'rent-reconciliations', 'term', term.mreTenantId, term.mreRentTerm),
  transaction: (realmId: string, epoch: number, transactionId: string) => realmKey(realmId, epoch, 'rent-reconciliations', 'transaction', transactionId),
  /** Step 8: the split proposal of one term for one Transaction in the version read (§37.6; a read of MRE, never a write). */
  proposal: (realmId: string, epoch: number, transactionId: string, version: number, term: RentTermKey) =>
    realmKey(realmId, epoch, 'rent-reconciliations', 'split-proposal', transactionId, version, term.mreTenantId, term.mreRentTerm),
};
