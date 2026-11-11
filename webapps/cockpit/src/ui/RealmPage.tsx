import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { createDeClient } from '../api/client';
import { ApiError } from '../api/errors';
import { fetchHealth, type HealthDto } from '../api/health';
import { realmKey } from '../query';
import { leaveRealm, type Area, type RentTermKey } from '../routing';
import { useSession } from '../session/use-session';
import { AppShell } from './AppShell';
import { AreaPlaceholder, OverviewPage } from './OverviewPage';
import { useRealms } from './RealmChoice';
import { ErrorState, LoadingState, secondaryButtonClass } from './states';
import { ImportArea } from './imports/ImportArea';
import { RentArea } from './rent/RentArea';
import { TransactionsArea } from './transactions/TransactionsArea';

/**
 * One Realm: its DE client (`organizationid` = the Realm of the URL) and the access check through `GET /api/v1/health`.
 * A `403` says the caller has no DE role in this Realm; the cockpit never switches to another Realm on its own
 * (mre-integration.md §47.2 point 4), it offers the choice.
 */
export function RealmPage(props: {
  readonly realmId: string;
  readonly area: Area;
  /** A Transaction of the Buchungen area (`…/buchungen/<transactionId>`). */
  readonly transactionId?: string | undefined;
  /** An import of the Import area (`…/import/<importBatchId>`). */
  readonly importBatchId?: string | undefined;
  /** A rent reconciliation of the Mietabgleich area (`…/mietabgleich/<reconciliationId>`). */
  readonly reconciliationId?: string | undefined;
  /** An MRE rent term of the Mietabgleich area (`…/mietabgleich/termin/<mreTenantId>/<mreRentTerm>`). */
  readonly rentTerm?: RentTermKey | undefined;
  /** The URL's search part: the list's filters and page. */
  readonly search?: string;
  /** The URL's path: the focus moves to the page title when it changes (AppShell). */
  readonly path?: string;
  readonly epoch: number;
  readonly email: string | undefined;
  readonly renewedAt: Date | undefined;
}) {
  const session = useSession();
  const client = useMemo(() => createDeClient({ tokens: session, realmId: props.realmId }), [session, props.realmId]);
  const health = useQuery({ queryKey: realmKey(props.realmId, props.epoch, 'health'), queryFn: ({ signal }) => fetchHealth(client, signal) });
  const realms = useRealms(props.epoch);
  const realmName = realms.data?.find((realm) => realm.id === props.realmId)?.name;

  const access = health.isPending ? (
    <LoadingState label="Zugriff auf den Bestand wird geprüft …" />
  ) : health.isError ? (
    <AccessProblem error={health.error} onRetry={() => void health.refetch()} />
  ) : null;

  return (
    <AppShell realmId={props.realmId} realmName={realmName} area={props.area} email={props.email} access={access} focusKey={props.path}>
      {health.isSuccess && <AreaContent {...props} client={client} realmName={realmName} health={health.data} />}
    </AppShell>
  );
}

function AreaContent(props: {
  readonly client: ReturnType<typeof createDeClient>;
  readonly realmId: string;
  readonly realmName: string | undefined;
  readonly area: Area;
  readonly transactionId?: string | undefined;
  readonly importBatchId?: string | undefined;
  readonly reconciliationId?: string | undefined;
  readonly rentTerm?: RentTermKey | undefined;
  readonly search?: string;
  readonly epoch: number;
  readonly health: HealthDto;
  readonly renewedAt: Date | undefined;
}) {
  switch (props.area.id) {
    case 'uebersicht':
      return <OverviewPage realmId={props.realmId} realmName={props.realmName} health={props.health} renewedAt={props.renewedAt} />;
    case 'buchungen':
      return (
        <TransactionsArea client={props.client} realmId={props.realmId} epoch={props.epoch} transactionId={props.transactionId} search={props.search ?? ''} />
      );
    case 'import':
      return <ImportArea client={props.client} realmId={props.realmId} epoch={props.epoch} importBatchId={props.importBatchId} />;
    case 'mietabgleich':
      return (
        <RentArea
          client={props.client}
          realmId={props.realmId}
          epoch={props.epoch}
          reconciliationId={props.reconciliationId}
          rentTerm={props.rentTerm}
          search={props.search ?? ''}
        />
      );
    default:
      return <AreaPlaceholder slice={props.area.slice ?? ''} />;
  }
}

/**
 * The failed access check. `403`: no DE role in this Realm; the user may choose another Realm, the cockpit does not
 * switch by itself (§47.2 point 4). Anything else (`503`, no answer): shown, checked again only on the user's request.
 */
export function AccessProblem({ error, onRetry }: { readonly error: unknown; readonly onRetry: () => void }) {
  return (
    <ErrorState error={error}>
      <div className="mt-3 flex gap-2">
        {error instanceof ApiError && error.status === 403 ? (
          <button type="button" className={secondaryButtonClass} onClick={leaveRealm}>
            Anderen Bestand wählen
          </button>
        ) : (
          <button type="button" className={secondaryButtonClass} onClick={onRetry}>
            Erneut prüfen
          </button>
        )}
      </div>
    </ErrorState>
  );
}
