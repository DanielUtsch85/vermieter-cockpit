import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { DeClient } from '../../api/client';
import { getImportBatch, importBankTransactions, listReviewItems, resolveReviewItem, type ImportBatchDto } from '../../api/imports';
import { listFinancialAccounts } from '../../api/transactions';
import { navigate, onLinkClick } from '../../navigation';
import { realmKey } from '../../query';
import { AREAS, areaPath, importBatchPath } from '../../routing';
import { LoadingState, ReadProblem, secondaryButtonClass } from '../states';
import { transactionKeys } from '../transactions/TransactionsArea';
import { ImportForm } from './ImportForm';
import { ImportResult } from './ImportResult';
import { ImportSteps } from './ImportSteps';
import { ReviewItems } from './ReviewItems';

/** Query keys of step 5; each starts with the Realm and the session's epoch (ui-guide.md §7.3). */
export const importKeys = {
  /** Everything of one batch: what a resolve invalidates (the result and the list, §6.5). */
  batchAll: (realmId: string, epoch: number, importBatchId: string) => realmKey(realmId, epoch, 'imports', importBatchId),
  batch: (realmId: string, epoch: number, importBatchId: string) => realmKey(realmId, epoch, 'imports', importBatchId, 'batch'),
  reviewItems: (realmId: string, epoch: number, importBatchId: string) => realmKey(realmId, epoch, 'imports', importBatchId, 'review-items'),
};

const importArea = AREAS.find((area) => area.id === 'import');

/**
 * The Import area of a Realm (ui-guide.md §3.1, §6.5; step 5 of §10): the upload at `…/import`, one import's result
 * and review items at `…/import/<importBatchId>`, so a known batch is read again after a reload or a lost answer.
 */
export function ImportArea(props: { readonly client: DeClient; readonly realmId: string; readonly epoch: number; readonly importBatchId: string | undefined }) {
  const queryClient = useQueryClient();
  const accounts = useQuery({
    queryKey: transactionKeys.accounts(props.realmId, props.epoch),
    queryFn: ({ signal }) => listFinancialAccounts(props.client, signal),
  });
  if (props.importBatchId !== undefined) {
    return <ImportBatchPage key={props.importBatchId} {...props} importBatchId={props.importBatchId} accounts={accounts.data?.items ?? []} />;
  }
  const onImported = (batch: ImportBatchDto) => {
    // The answer is shown at once; the page of the batch reads it again (GET /imports/{id}).
    queryClient.setQueryData(importKeys.batch(props.realmId, props.epoch, batch.importBatchId), batch);
    void queryClient.invalidateQueries({ queryKey: transactionKeys.all(props.realmId, props.epoch) });
    navigate(importBatchPath(props.realmId, batch.importBatchId));
  };
  return (
    <>
      {accounts.isPending ? (
        <LoadingState label="Konten werden geladen …" />
      ) : accounts.isError ? (
        <ReadProblem error={accounts.error} onRetry={() => void accounts.refetch()} />
      ) : (
        <ImportForm accounts={accounts.data} upload={(upload) => importBankTransactions(props.client, upload)} onImported={onImported} />
      )}
    </>
  );
}

function ImportBatchPage(props: {
  readonly client: DeClient;
  readonly realmId: string;
  readonly epoch: number;
  readonly importBatchId: string;
  readonly accounts: Parameters<typeof ImportResult>[0]['accounts'];
}) {
  const queryClient = useQueryClient();
  const batch = useQuery({
    queryKey: importKeys.batch(props.realmId, props.epoch, props.importBatchId),
    queryFn: ({ signal }) => getImportBatch(props.client, props.importBatchId, signal),
  });
  const shown = batch.status === 'success' ? batch.data : undefined;
  const items = useQuery({
    queryKey: importKeys.reviewItems(props.realmId, props.epoch, props.importBatchId),
    queryFn: ({ signal }) => listReviewItems(props.client, shown as ImportBatchDto, signal),
    enabled: shown !== undefined,
  });
  const newImport = importArea === undefined ? '' : areaPath(props.realmId, importArea);
  const reread = () => void queryClient.invalidateQueries({ queryKey: importKeys.batchAll(props.realmId, props.epoch, props.importBatchId) });
  const onResolved = () => {
    reread();
    void queryClient.invalidateQueries({ queryKey: transactionKeys.all(props.realmId, props.epoch) });
  };
  return (
    <>
      <ImportSteps current={3} />
      <div className="flex flex-wrap items-center gap-4">
        <a className="text-primary underline" href={newImport} onClick={(event) => onLinkClick(event, newImport)}>
          Neue Datei importieren
        </a>
        <button type="button" className={secondaryButtonClass} disabled={batch.isFetching || items.isFetching} onClick={reread}>
          Ergebnis neu laden
        </button>
      </div>
      {batch.isPending ? (
        <LoadingState label="Ergebnis des Imports wird geladen …" />
      ) : batch.isError ? (
        <ReadProblem error={batch.error} onRetry={() => void batch.refetch()} />
      ) : (
        <>
          <ImportResult realmId={props.realmId} batch={batch.data} accounts={props.accounts} />
          <ReviewItems
            realmId={props.realmId}
            batch={batch.data}
            items={items}
            stale={batch.isFetching || items.isFetching || items.status !== 'success'}
            resolve={(item, resolution) => resolveReviewItem(props.client, item, resolution)}
            onResolved={onResolved}
            onReread={reread}
          />
        </>
      )}
    </>
  );
}
