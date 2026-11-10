import type { ReactNode } from 'react';
import { onLinkClick } from '../navigation';
import { AREAS, areaPath, leaveRealm, signOutAndReload, type Area } from '../routing';
import { useSession } from '../session/use-session';
import { secondaryButtonClass } from './states';

/**
 * The app shell (ui-guide.md §3.2): constant navigation on the left, on top the current Realm (Bestand), the page title
 * and the session status. Only the version-1 areas are in the navigation (§3.1); P1 areas appear when they are done.
 */
export function AppShell(props: {
  readonly realmId: string;
  readonly realmName: string | undefined;
  readonly area: Area;
  readonly email: string | undefined;
  readonly access: ReactNode;
  readonly children: ReactNode;
}) {
  const session = useSession();
  return (
    <div className="min-h-screen bg-background">
      <a href="#inhalt" className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:bg-surface focus:p-2">
        Zum Inhalt springen
      </a>
      <div className="mx-auto flex max-w-content flex-col md:flex-row">
        <nav aria-label="Hauptnavigation" className="shrink-0 border-b border-border bg-surface p-4 md:min-h-screen md:w-nav md:border-b-0 md:border-r">
          <p className="mb-4 text-section font-semibold">Vermieter Cockpit</p>
          <ul className="flex flex-row flex-wrap gap-1 md:flex-col">
            {AREAS.map((area) => {
              const href = areaPath(props.realmId, area);
              const current = area.id === props.area.id;
              return (
                <li key={area.id}>
                  <a
                    href={href}
                    aria-current={current ? 'page' : undefined}
                    onClick={(event) => onLinkClick(event, href)}
                    className={`flex min-h-touch items-center rounded-input px-3 ${current ? 'bg-info-bg font-semibold text-primary' : 'text-text hover:bg-background'}`}
                  >
                    {area.label}
                  </a>
                </li>
              );
            })}
          </ul>
        </nav>
        <div className="min-w-0 flex-1">
          <header className="flex flex-wrap items-center gap-4 border-b border-border bg-surface px-6 py-3">
            <div className="mr-auto">
              <p className="text-label text-muted">Bestand</p>
              <p className="font-semibold">{props.realmName ?? props.realmId}</p>
            </div>
            <div className="text-right">
              <p className="text-label text-muted">Sitzung</p>
              <p>{props.email === undefined ? 'Angemeldet' : `Angemeldet als ${props.email}`}</p>
            </div>
            <button type="button" className={secondaryButtonClass} onClick={leaveRealm}>
              Bestand wechseln
            </button>
            <button type="button" className={secondaryButtonClass} onClick={() => signOutAndReload(session)}>
              Abmelden
            </button>
          </header>
          <main id="inhalt" className="flex flex-col gap-6 px-6 py-6">
            <h1 className="text-title font-semibold">{props.area.label}</h1>
            {props.access}
            {props.children}
          </main>
        </div>
      </div>
    </div>
  );
}
