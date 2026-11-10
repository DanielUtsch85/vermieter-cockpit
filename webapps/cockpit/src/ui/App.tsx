import { useLocationPath } from '../navigation';
import { BASE_PATH, parseRoute } from '../routing';
import { useSession, useSessionState } from '../session/use-session';
import { LoginPage } from './LoginPage';
import { RealmChoice } from './RealmChoice';
import { RealmPage } from './RealmPage';
import { buttonClass, CenteredPage, LoadingState } from './states';

export function App() {
  const session = useSession();
  const state = useSessionState();
  const path = useLocationPath();

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
      const route = parseRoute(path);
      if (route.kind === 'realmChoice') return <RealmChoice epoch={state.epoch} />;
      if (route.kind === 'notFound') {
        return (
          <CenteredPage title="Seite nicht gefunden">
            <a className="text-primary underline" href={BASE_PATH}>
              Zur Auswahl des Bestands
            </a>
          </CenteredPage>
        );
      }
      return <RealmPage realmId={route.realmId} area={route.area} epoch={state.epoch} email={state.email} renewedAt={state.renewedAt} />;
    }
  }
}
