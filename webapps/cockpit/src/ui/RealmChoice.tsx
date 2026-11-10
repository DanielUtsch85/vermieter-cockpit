import { useQuery } from '@tanstack/react-query';
import { sessionKey } from '../query';
import { AREAS, areaPath, signOutAndReload } from '../routing';
import { listRealms } from '../session/mre-authenticator';
import { useSession } from '../session/use-session';
import { CenteredPage, ErrorState, LoadingState, Notice, secondaryButtonClass } from './states';

/** The Realm query, shared by the choice and the shell's header. */
export function useRealms(epoch: number) {
  const session = useSession();
  return useQuery({ queryKey: sessionKey(epoch, 'realms'), queryFn: () => listRealms(session) });
}

/**
 * The choice of a Realm (Bestand) from `GET /api/v2/realms` (mre-integration.md §47.2 point 3). Choosing one is a change
 * of the authorisation context, not a filter (ui-guide.md §3.2): each choice is a link that loads the Realm's URL, so no
 * data of another Realm stays in memory. Whether the user has DE access there is checked by DE after the choice.
 */
export function RealmChoice({ epoch }: { readonly epoch: number }) {
  const realms = useRealms(epoch);
  const session = useSession();
  const overview = AREAS[0];

  return (
    <CenteredPage title="Bestand wählen">
      {realms.isPending && <LoadingState label="Bestände werden geladen …" />}
      {realms.isError && <ErrorState error={realms.error} />}
      {realms.isSuccess && realms.data.length === 0 && (
        <Notice tone="info">
          <p>Zu Ihrem Konto gibt es keinen Bestand. Legen Sie einen Bestand in MicroRealEstate an.</p>
        </Notice>
      )}
      {realms.isSuccess && realms.data.length > 0 && overview !== undefined && (
        <ul className="flex flex-col gap-2" aria-label="Bestände">
          {realms.data.map((realm) => (
            <li key={realm.id}>
              <a
                href={areaPath(realm.id, overview)}
                className="flex min-h-touch items-center justify-between rounded-card border border-border bg-surface px-4 text-text hover:border-primary"
              >
                <span className="font-semibold">{realm.name === '' ? 'Ohne Namen' : realm.name}</span>
                <span className="text-label text-muted">{realm.id}</span>
              </a>
            </li>
          ))}
        </ul>
      )}
      <button type="button" className={secondaryButtonClass} onClick={() => signOutAndReload(session)}>
        Abmelden
      </button>
    </CenteredPage>
  );
}
