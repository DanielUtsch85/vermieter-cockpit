import { useQuery } from '@tanstack/react-query';
import { ApiError } from '../api/errors';
import { sessionKey } from '../query';
import { AREAS, areaPath, signOutAndReload } from '../routing';
import { listRealms, type MreRealm } from '../session/mre-authenticator';
import { useSession } from '../session/use-session';
import { CenteredPage, ErrorState, LoadingState, Notice, secondaryButtonClass } from './states';

/** The Realm query, shared by the choice and the shell's header. */
export function useRealms(epoch: number) {
  const session = useSession();
  return useQuery({ queryKey: sessionKey(epoch, 'realms'), queryFn: ({ signal }) => listRealms(session, undefined, signal) });
}

/**
 * The choice of a Realm (Bestand) from `GET /api/v2/realms` (mre-integration.md §47.2 point 3). Choosing one is a change
 * of the authorisation context, not a filter (ui-guide.md §3.2): each choice is a link that loads the Realm's URL, so no
 * data of another Realm stays in memory. Whether the user has DE access there is checked by DE after the choice.
 */
export function RealmChoice({ epoch }: { readonly epoch: number }) {
  const realms = useRealms(epoch);
  const session = useSession();
  return (
    <CenteredPage title="Bestand wählen">
      <RealmList realms={realms} />
      <button type="button" className={secondaryButtonClass} onClick={() => signOutAndReload(session)}>
        Abmelden
      </button>
    </CenteredPage>
  );
}

/** A read as a page shows it: loading, refused or answered (a TanStack Query result is one). */
export type Loadable<T> =
  { readonly status: 'pending' } | { readonly status: 'error'; readonly error: unknown } | { readonly status: 'success'; readonly data: T };

/**
 * The Realm list in its states (ui-guide.md §7.4, §11: every list has loading, empty and error). Empty means the
 * account is member of no Realm; a refusal (`403` of a tenant token, `503`) is an error, never an empty list.
 */
export function RealmList({ realms }: { readonly realms: Loadable<readonly MreRealm[]> }) {
  const overview = AREAS[0];
  if (realms.status === 'pending') return <LoadingState label="Bestände werden geladen …" />;
  if (realms.status === 'error') {
    // MRE refuses the Realm list with 403 (e.g. to a tenant's token): a refusal of the account, not of one Realm.
    if (realms.error instanceof ApiError && realms.error.status === 403) {
      return (
        <div role="alert" className="rounded-card border border-danger-text bg-danger-bg p-4 text-danger-text">
          <p className="font-semibold">Kein Zugriff</p>
          <p>MicroRealEstate verweigert diesem Konto die Liste der Bestände. Das Cockpit ist nur für Vermieterkonten.</p>
        </div>
      );
    }
    return <ErrorState error={realms.error} />;
  }
  if (realms.data.length === 0 || overview === undefined) {
    return (
      <Notice tone="info">
        <p>Zu Ihrem Konto gibt es keinen Bestand. Legen Sie einen Bestand in MicroRealEstate an.</p>
      </Notice>
    );
  }
  return (
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
  );
}
