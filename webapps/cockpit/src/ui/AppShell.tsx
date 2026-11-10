import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { onLinkClick } from '../navigation';
import { AREAS, areaPath, leaveRealm, signOutAndReload, type Area } from '../routing';
import { useSession } from '../session/use-session';
import { pageTitle, secondaryButtonClass, useDocumentTitle } from './states';

const NAV_ID = 'hauptnavigation';

/**
 * The app shell (ui-guide.md §3.2): constant navigation on the left, on top the current Realm (Bestand), the page title
 * and the session status. Only the version-1 areas are in the navigation (§3.1); P1 areas appear when they are done.
 * On small screens the navigation is a drawer behind the "Menü" button (§4.2); it closes with Escape, which returns the
 * focus to the button, and with the choice of an area. After a navigation inside the Realm the focus moves to the new
 * page's title (also from the list to a Transaction and back), so keyboard and screen reader users start on the new page (§4.3, §11).
 */
export function AppShell(props: {
  readonly realmId: string;
  readonly realmName: string | undefined;
  readonly area: Area;
  readonly email: string | undefined;
  readonly access: ReactNode;
  /** Changes with the page shown (the URL's path); defaults to the area. A change moves the focus to the title. */
  readonly focusKey?: string | undefined;
  readonly children: ReactNode;
}) {
  const session = useSession();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const focusKey = props.focusKey ?? props.area.id;
  const shownPage = useRef(focusKey);
  const realmLabel = props.realmName ?? props.realmId;

  useDocumentTitle(pageTitle(props.area.label, realmLabel));

  useEffect(() => {
    if (shownPage.current === focusKey) return;
    shownPage.current = focusKey;
    heading.current?.focus();
  }, [focusKey]);

  const closeOnEscape = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Escape' || !menuOpen) return;
    setMenuOpen(false);
    menuButton.current?.focus();
  };

  return (
    <div className="min-h-screen bg-background">
      <a href="#inhalt" className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:bg-surface focus:p-2">
        Zum Inhalt springen
      </a>
      <div className="mx-auto flex max-w-content flex-col md:flex-row">
        <div className="flex items-center justify-between border-b border-border bg-surface p-4 md:hidden">
          <p className="text-section font-semibold">Vermieter Cockpit</p>
          <button
            ref={menuButton}
            type="button"
            className={secondaryButtonClass}
            aria-expanded={menuOpen}
            aria-controls={NAV_ID}
            onClick={() => setMenuOpen((open) => !open)}
          >
            Menü
          </button>
        </div>
        <nav
          id={NAV_ID}
          aria-label="Hauptnavigation"
          onKeyDown={closeOnEscape}
          className={`${menuOpen ? 'block' : 'hidden'} shrink-0 border-b border-border bg-surface p-4 md:block md:min-h-screen md:w-nav md:border-b-0 md:border-r`}
        >
          <p className="mb-4 hidden text-section font-semibold md:block">Vermieter Cockpit</p>
          <ul className="flex flex-col gap-1">
            {AREAS.map((area) => {
              const href = areaPath(props.realmId, area);
              const current = area.id === props.area.id;
              return (
                <li key={area.id}>
                  <a
                    href={href}
                    aria-current={current ? 'page' : undefined}
                    onClick={(event) => {
                      setMenuOpen(false);
                      onLinkClick(event, href);
                    }}
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
              <p className="font-semibold">{realmLabel}</p>
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
            <h1 ref={heading} tabIndex={-1} className="text-title font-semibold">
              {props.area.label}
            </h1>
            {props.access}
            {props.children}
          </main>
        </div>
      </div>
    </div>
  );
}
