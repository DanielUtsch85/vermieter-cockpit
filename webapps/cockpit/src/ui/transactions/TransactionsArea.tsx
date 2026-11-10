import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { DeClient } from '../../api/client';
import {
  getTransaction,
  listFinancialAccounts,
  listFinancialCategories,
  listPropertyReferences,
  listTransactions,
  putSplits,
  type TransactionRead,
} from '../../api/transactions';
import { navigate } from '../../navigation';
import { realmKey } from '../../query';
import { AREAS, areaPath } from '../../routing';
import { readListParams, toApiQuery, toSearch, type ListParams } from '../../transactions/list-params';
import { splitsEditable } from '../../transactions/split-draft';
import type { References } from './references';
import { TransactionDetailView } from './TransactionDetail';
import { TransactionListView } from './TransactionList';
import { SplitEditor } from './SplitEditor';

/**
 * The query keys of step 2. Each starts with the Realm and the session's epoch (ui-guide.md §7.3), so an answer of
 * another Realm or an earlier session is never found under the key of this one.
 */
export const transactionKeys = {
  list: (realmId: string, epoch: number, query: Readonly<Record<string, string>>) => realmKey(realmId, epoch, 'transactions', 'list', query),
  detail: (realmId: string, epoch: number, transactionId: string) => realmKey(realmId, epoch, 'transactions', 'detail', transactionId),
  /** Every list and detail of the Realm: what a split change invalidates (§7.3: "Buchung und Listen"). */
  all: (realmId: string, epoch: number) => realmKey(realmId, epoch, 'transactions'),
  accounts: (realmId: string, epoch: number) => realmKey(realmId, epoch, 'financial-accounts', 'picker'),
  properties: (realmId: string, epoch: number) => realmKey(realmId, epoch, 'property-references', 'picker'),
  categories: (realmId: string, epoch: number) => realmKey(realmId, epoch, 'financial-categories'),
};

function useReferences(client: DeClient, realmId: string, epoch: number): References {
  const accounts = useQuery({ queryKey: transactionKeys.accounts(realmId, epoch), queryFn: ({ signal }) => listFinancialAccounts(client, signal) });
  const properties = useQuery({ queryKey: transactionKeys.properties(realmId, epoch), queryFn: ({ signal }) => listPropertyReferences(client, signal) });
  const categories = useQuery({ queryKey: transactionKeys.categories(realmId, epoch), queryFn: ({ signal }) => listFinancialCategories(client, signal) });
  return { accounts, properties, categories };
}

const transactionsArea = AREAS.find((area) => area.id === 'buchungen');

/** The Buchungen area of a Realm: the list at `…/buchungen?…`, one Transaction at `…/buchungen/<transactionId>`. */
export function TransactionsArea(props: {
  readonly client: DeClient;
  readonly realmId: string;
  readonly epoch: number;
  readonly transactionId: string | undefined;
  readonly search: string;
}) {
  const references = useReferences(props.client, props.realmId, props.epoch);
  const listHref = transactionsArea === undefined ? '' : areaPath(props.realmId, transactionsArea);
  return props.transactionId === undefined ? (
    <TransactionListPage {...props} references={references} listHref={listHref} />
  ) : (
    <TransactionDetailPage {...props} transactionId={props.transactionId} references={references} listHref={listHref} />
  );
}

function TransactionListPage(props: {
  readonly client: DeClient;
  readonly realmId: string;
  readonly epoch: number;
  readonly search: string;
  readonly references: References;
  readonly listHref: string;
}) {
  const params = readListParams(props.search);
  const query = toApiQuery(params);
  const list = useQuery({
    queryKey: transactionKeys.list(props.realmId, props.epoch, query),
    queryFn: ({ signal }) => listTransactions(props.client, query, signal),
  });
  const onFilter = (next: ListParams) => navigate(`${props.listHref}${toSearch(next)}`);
  return (
    <TransactionListView
      realmId={props.realmId}
      params={params}
      list={list}
      references={props.references}
      onFilter={onFilter}
      onRetry={() => void list.refetch()}
    />
  );
}

function TransactionDetailPage(props: {
  readonly client: DeClient;
  readonly realmId: string;
  readonly epoch: number;
  readonly transactionId: string;
  readonly references: References;
  readonly listHref: string;
}) {
  const queryClient = useQueryClient();
  const read = useQuery({
    queryKey: transactionKeys.detail(props.realmId, props.epoch, props.transactionId),
    queryFn: ({ signal }) => getTransaction(props.client, props.transactionId, signal),
  });
  // The editor stays once shown: a later read (after a save or a 412) that is refused, or names a status without
  // splits, must not take the unsaved draft away (ui-guide.md §11); the editor says itself when it cannot save.
  const [editorShown, setEditorShown] = useState(false);
  const first = read.data;
  if (!editorShown && first !== undefined && read.status === 'success' && splitsEditable(first.transaction.status)) setEditorShown(true);
  const reload = async (): Promise<TransactionRead> => {
    const result = await read.refetch();
    if (result.status === 'error' || result.data === undefined) throw result.error ?? new Error('No Transaction read.');
    return result.data;
  };
  return (
    <>
      <TransactionDetailView realmId={props.realmId} read={read} references={props.references} listHref={props.listHref} onRetry={() => void read.refetch()} />
      {editorShown && first !== undefined && (
        <SplitEditor
          key={props.transactionId}
          transaction={first.transaction}
          etag={first.etag}
          references={props.references}
          save={(body, ifMatch) => putSplits(props.client, props.transactionId, body, ifMatch)}
          reload={reload}
          onSaved={() => void queryClient.invalidateQueries({ queryKey: transactionKeys.all(props.realmId, props.epoch) })}
        />
      )}
    </>
  );
}
