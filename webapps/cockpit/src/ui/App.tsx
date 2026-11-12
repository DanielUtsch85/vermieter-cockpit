import { useEffect } from 'react';
import { useLocationPath, useLocationSearch } from '../navigation';
import { BASE_PATH, parseRoute, realmSwitchEffect, realmSwitching, reloadPage, type RealmLock } from '../routing';
import { useSession, useSessionState } from '../session/use-session';
import { Link } from './Link';
import { LoginPage } from './LoginPage';
import { RealmChoice } from './RealmChoice';
import { RealmPage } from './RealmPage';
import { buttonClass, CenteredPage, LoadingState } from './states';

/**
 * The top of the cockpit: the session decides what is shown (mre-integration.md §47.2), then the URL. A URL of another
 * Realm than the one this document shows is never rendered from this memory: the page is loaded afresh (RealmLock).
 */
export function App({ realmLock, reload = reloadPage }: { readonly realmLock: RealmLock; readonly reload?: () => void }) {
  const session = useSession();
  const state = useSessionState();
  const path = useLocationPath();
  const search = useLocationSearch();
  const route = state.status === 'signedIn' ? parseRoute(path) : undefined;
  const switching = realmSwitching(route, realmLock);

  useEffect(realmSwitchEffect(switching, reload), [switching, reload]);

  switch (state.status) {
    case 'checking':
      return (
        <CenteredPage title="Vermieter Cockpit">
          <LoadingState label="Sitzung wird geprüft …" />
        </CenteredPage>
      );
    case 'unavailable':
      return (
        <CenteredPage title="Anmeldung nicht erreichbar">
          <p role="alert">Die Anmeldung von MicroRealEstate antwortet nicht. Bitte später erneut versuchen.</p>
          <button type="button" className={buttonClass} onClick={() => void session.start()}>
            Erneut versuchen
          </button>
        </CenteredPage>
      );
    case 'signedOut':
      return <LoginPage expired={state.expired} />;
    case 'signedIn': {
      if (route === undefined || route.kind === 'realmChoice') return <RealmChoice epoch={state.epoch} />;
      if (route.kind === 'notFound') {
        return (
          <CenteredPage title="Seite nicht gefunden">
            <Link href={BASE_PATH} reload>
              Zur Auswahl des Bestands
            </Link>
          </CenteredPage>
        );
      }
      if (switching) {
        return (
          <CenteredPage title="Bestand wird gewechselt">
            <LoadingState label="Die Seite wird für den anderen Bestand neu geladen …" />
          </CenteredPage>
        );
      }
      return (
        <RealmPage
          realmId={route.realmId}
          area={route.area}
          transactionId={route.transactionId}
          importBatchId={route.importBatchId}
          reconciliationId={route.reconciliationId}
          rentTerm={route.rentTerm}
          search={search}
          path={path}
          epoch={state.epoch}
          email={state.email}
          renewedAt={state.renewedAt}
        />
      );
    }
  }
}
