import { useState, type ReactNode } from 'react';
import type { HealthDto } from '../api/health';
import { BACKEND_PIN } from '../gate/backend-pin';
import { onLinkClick } from '../navigation';
import { AREAS, areaPath } from '../routing';
import { useSession } from '../session/use-session';
import { describeError } from './error-text';
import { secondaryButtonClass } from './states';

const berlinDate = new Intl.DateTimeFormat('de-DE', { dateStyle: 'full', timeZone: 'Europe/Berlin' });
const berlinTime = new Intl.DateTimeFormat('de-DE', { timeStyle: 'medium', timeZone: 'Europe/Berlin' });

function Row({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="grid gap-1 py-2 sm:grid-cols-[14rem_1fr]">
      <dt className="text-muted">{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

/**
 * The overview as working navigation (ui-guide.md §6.2): date, Realm, connection context and links to the version-1
 * areas, no invented figures. It also shows the integration gate (§10) from the shell: the session through the MRE
 * authenticator with its last renewal, the Realm DE verified, and the pinned backend state.
 */
export function OverviewPage(props: {
  readonly realmId: string;
  readonly realmName: string | undefined;
  readonly health: HealthDto | undefined;
  readonly renewedAt: Date | undefined;
}) {
  const session = useSession();
  const [renewal, setRenewal] = useState<{ busy: boolean; failure?: string }>({ busy: false });

  const renew = () => {
    setRenewal({ busy: true });
    session.renew().then(
      () => setRenewal({ busy: false }),
      (error: unknown) => setRenewal({ busy: false, failure: describeError(error).text }),
    );
  };

  return (
    <>
      <section aria-labelledby="verbindung" className="rounded-card border border-border bg-surface p-6">
        <h2 id="verbindung" className="mb-2 text-section font-semibold">
          Verbindung
        </h2>
        <dl className="divide-y divide-border">
          <Row label="Heute">{berlinDate.format(new Date())}</Row>
          <Row label="Bestand">
            {props.realmName ?? 'Name nicht verfügbar'} <span className="text-label text-muted">({props.realmId})</span>
          </Row>
          <Row label="Fachdaten (DE)">{props.health === undefined ? 'Wird geprüft …' : `Zugriff bestätigt für Bestand ${props.health.mreRealmId}`}</Row>
          <Row label="Sitzung erneuert">
            <span className="tabular-nums">
              {props.renewedAt === undefined ? 'Seit der Anmeldung noch nicht' : `zuletzt um ${berlinTime.format(props.renewedAt)}`}
            </span>{' '}
            <button type="button" className={`${secondaryButtonClass} ml-2`} disabled={renewal.busy} onClick={renew}>
              Jetzt erneuern
            </button>
            {renewal.failure !== undefined && (
              <p role="alert" className="mt-2 text-danger-text">
                {renewal.failure}
              </p>
            )}
          </Row>
          <Row label="Backend-Stand">
            <a className="text-primary underline" href={`https://github.com/DanielUtsch85/vermieter-cockpit/commit/${BACKEND_PIN.commit}`}>
              {BACKEND_PIN.commit.slice(0, 7)}
            </a>{' '}
            <span className="text-muted">({BACKEND_PIN.routes} Routen im Inventar)</span>
          </Row>
        </dl>
      </section>
      <section aria-labelledby="bereiche" className="rounded-card border border-border bg-surface p-6">
        <h2 id="bereiche" className="mb-2 text-section font-semibold">
          Arbeitsbereiche
        </h2>
        <ul className="flex flex-col gap-2">
          {AREAS.filter((area) => area.id !== 'uebersicht').map((area) => {
            const href = areaPath(props.realmId, area);
            return (
              <li key={area.id}>
                <a className="text-primary underline" href={href} onClick={(event) => onLinkClick(event, href)}>
                  {area.label}
                </a>{' '}
                <span className="text-muted">
                  {area.available === undefined ? `· entsteht im ${area.slice}` : `· ${area.available}; der Rest entsteht im ${area.slice}`}
                </span>
              </li>
            );
          })}
        </ul>
      </section>
    </>
  );
}

/** A version-1 area before its slice is built: says so, offers no control without a data path (ui-guide.md §3.2). */
export function AreaPlaceholder({ slice }: { readonly slice: string }) {
  return (
    <p className="rounded-card border border-border bg-surface p-6 text-muted">
      Dieser Bereich ist noch nicht verfügbar. Er entsteht im {slice} (Leitfaden für die erste Benutzeroberfläche, Abschnitt 10).
    </p>
  );
}
