import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { DeClient } from '../../api/client';
import { ApiError } from '../../api/errors';
import {
  confirmReconciliation,
  getReconciliation,
  getTermCoverage,
  listReconciliations,
  rejectReconciliation,
  releaseReconciliation,
  removeFromMre,
  suggestReconciliations,
  writeBackToMre,
} from '../../api/rent-reconciliations';
import { getTransaction } from '../../api/transactions';
import { AREAS, areaPath, type RentTermKey } from '../../routing';
import { rentKeys } from './rent-keys';
import { Link } from '../Link';
import { PageTitle } from '../PageTitle';
import { LoadingState, ReadProblem, secondaryButtonClass } from '../states';
import { transactionKeys } from '../transactions/TransactionsArea';
import { DecisionActions } from './DecisionActions';
import { MreActions } from './MreActions';
import { ReconciliationDetailView } from './ReconciliationDetail';
import { readRentListParams, ReconciliationListView, rentListSearch } from './ReconciliationList';
import { SuggestForm } from './SuggestForm';
import { TermCoverageView } from './TermCoverage';

const rentArea = AREAS.find((area) => area.id === 'mietabgleich');

interface AreaProps {
  readonly client: DeClient;
  readonly realmId: string;
  readonly epoch: number;
}

/**
 * The Mietabgleich area of a Realm (ui-guide.md §3.1, §6.6; step 6 of §10): suggestions and the list at
 * `…/mietabgleich`, one reconciliation with its separate actions at `…/mietabgleich/<id>`, and the coverage of one MRE
 * rent term at `…/mietabgleich/termin/<mreTenantId>/<mreRentTerm>`. Rendering, a refetch or moving between them never
 * sends a command: every command is a click (§11). The two sub-pages give the shell their title („Zuordnung“, „Abdeckung
 * eines Termins“; Issue #353 des Projektinhabers, 2026-11-12, point 5).
 */
export function RentArea(
  props: AreaProps & { readonly reconciliationId: string | undefined; readonly rentTerm: RentTermKey | undefined; readonly search: string },
) {
  const listHref = rentArea === undefined ? '' : areaPath(props.realmId, rentArea);
  if (props.reconciliationId !== undefined) {
    return <ReconciliationPage key={props.reconciliationId} {...props} reconciliationId={props.reconciliationId} listHref={listHref} />;
  }
  if (props.rentTerm !== undefined) {
    return <TermPage key={`${props.rentTerm.mreTenantId}/${props.rentTerm.mreRentTerm}`} {...props} rentTerm={props.rentTerm} listHref={listHref} />;
  }
  return <RentOverview {...props} listHref={listHref} />;
}

function RentOverview(props: AreaProps & { readonly search: string; readonly listHref: string }) {
  const queryClient = useQueryClient();
  const params = readRentListParams(props.search);
  const list = useQuery({
    queryKey: rentKeys.list(props.realmId, props.epoch, params),
    queryFn: ({ signal }) => listReconciliations(props.client, params, signal),
  });
  return (
    <>
      <SuggestForm
        realmId={props.realmId}
        suggest={(body) => suggestReconciliations(props.client, body)}
        onSuggested={() => void queryClient.invalidateQueries({ queryKey: rentKeys.all(props.realmId, props.epoch) })}
      />
      <ReconciliationListView
        realmId={props.realmId}
        params={params}
        list={list}
        href={(next) => `${props.listHref}${rentListSearch(next)}`}
        onRetry={() => void list.refetch()}
      />
    </>
  );
}

function ReconciliationPage(props: AreaProps & { readonly reconciliationId: string; readonly listHref: string }) {
  const queryClient = useQueryClient();
  const read = useQuery({
    queryKey: rentKeys.detail(props.realmId, props.epoch, props.reconciliationId),
    queryFn: ({ signal }) => getReconciliation(props.client, props.reconciliationId, signal),
  });
  // Shown once read: a later read that fails must not take the drafts away (the actions say themselves when stale).
  const first = read.data;
  const transactionId = first?.reconciliation.transactionId;
  const transaction = useQuery({
    queryKey: transactionKeys.detail(props.realmId, props.epoch, transactionId ?? ''),
    queryFn: ({ signal }) => getTransaction(props.client, transactionId ?? '', signal),
    enabled: transactionId !== undefined,
  });
  const stale = read.status !== 'success' || read.isFetching;
  const invalidate = () => void queryClient.invalidateQueries({ queryKey: rentKeys.all(props.realmId, props.epoch) });
  const reload = () => void read.refetch();
  const id = props.reconciliationId;
  return (
    <>
      <PageTitle title="Zuordnung" />
      {read.status === 'pending' ? (
        <LoadingState label="Zuordnung wird geladen …" />
      ) : read.status === 'error' ? (
        <ReadProblem error={read.error} onRetry={reload}>
          {read.error instanceof ApiError && read.error.status === 404 && <Link href={props.listHref}>Zur Übersicht des Mietabgleichs</Link>}
        </ReadProblem>
      ) : (
        <ReconciliationDetailView realmId={props.realmId} r={read.data.reconciliation} etag={read.data.etag} transaction={transaction} />
      )}
      {first !== undefined && (
        <>
          <DecisionActions
            reconciliation={first.reconciliation}
            etag={first.etag}
            stale={stale}
            confirm={(amount, ifMatch) => confirmReconciliation(props.client, id, amount, ifMatch)}
            reject={(reason, ifMatch) => rejectReconciliation(props.client, id, reason, ifMatch)}
            onChanged={invalidate}
            reload={reload}
          />
          <MreActions
            realmId={props.realmId}
            reconciliation={first.reconciliation}
            etag={first.etag}
            stale={stale}
            writeBack={(ifMatch) => writeBackToMre(props.client, id, ifMatch)}
            release={(reason, ifMatch) => releaseReconciliation(props.client, id, reason, ifMatch)}
            remove={(ifMatch) => removeFromMre(props.client, id, ifMatch)}
            onChanged={invalidate}
            reload={reload}
          />
        </>
      )}
    </>
  );
}

function TermPage(props: AreaProps & { readonly rentTerm: RentTermKey; readonly listHref: string }) {
  const { mreTenantId, mreRentTerm } = props.rentTerm;
  const coverage = useQuery({
    queryKey: rentKeys.term(props.realmId, props.epoch, props.rentTerm),
    queryFn: ({ signal }) => getTermCoverage(props.client, mreTenantId, mreRentTerm, signal),
  });
  let body: ReactNode;
  if (coverage.status === 'pending') body = <LoadingState label="Abdeckung wird geladen (DE und MRE) …" />;
  else if (coverage.status === 'error') {
    body = (
      <ReadProblem error={coverage.error} onRetry={() => void coverage.refetch()}>
        {coverage.error instanceof ApiError && coverage.error.status === 503 && (
          <p>
            Die Anmeldeprüfung bei MRE ist nicht erreichbar; deshalb sind auch die Zuordnungen von DE gerade nicht lesbar. Eine Aussage zur Deckung ist so nicht
            möglich.
          </p>
        )}
      </ReadProblem>
    );
  } else body = <TermCoverageView realmId={props.realmId} coverage={coverage.data} />;
  return (
    <>
      <PageTitle title="Abdeckung eines Termins" />
      <div>
        <button type="button" className={secondaryButtonClass} disabled={coverage.isFetching} onClick={() => void coverage.refetch()}>
          Abdeckung neu laden
        </button>
      </div>
      {body}
    </>
  );
}
