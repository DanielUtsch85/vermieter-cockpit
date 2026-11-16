import { createContext, useContext, type ReactNode } from 'react';
import { setupPath, type SetupPage } from '../../routing';
import { Link } from '../Link';

/**
 * The Realm a page shows, for the links to its setup pages from deep inside a form (the split editor's object, the
 * list's object filter). `RealmPage` provides it; outside a Realm (a test of one form) the hint names what is missing
 * without a link.
 */
export const SetupRealmContext = createContext<string | undefined>(undefined);

export const SETUP_LABELS: Readonly<Record<SetupPage, string>> = { konto: 'Konto anlegen', objekte: 'Objekte verknüpfen' };

/** A link to a setup page of the current Realm (Issue #365). */
export function SetupLink({ to, children }: { readonly to: SetupPage; readonly children?: ReactNode }) {
  const realmId = useContext(SetupRealmContext);
  if (realmId === undefined) return <>{children ?? SETUP_LABELS[to]}</>;
  return <Link href={setupPath(realmId, to)}>{children ?? SETUP_LABELS[to]}</Link>;
}

/**
 * An empty choice says what is missing and where it comes from, with a link there (Entscheidung des Projektinhabers,
 * 2026-11-16: „leere Auswahllisten sagen, wo das Fehlende entsteht, mit Link dorthin“).
 */
export function NoLinkedProperties({ id }: { readonly id?: string }) {
  return (
    <p id={id} className="text-label text-muted">
      {'In diesem Bestand ist noch kein Objekt aus MicroRealEstate verknüpft; die Auswahl ist leer. Objekte entstehen in MicroRealEstate und werden unter '}
      <SetupLink to="objekte" />
      {' für das Cockpit verknüpft.'}
    </p>
  );
}
