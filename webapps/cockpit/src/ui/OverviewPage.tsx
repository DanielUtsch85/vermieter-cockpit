import { useState, type ReactNode } from 'react';
import type { HealthDto } from '../api/health';
import { onLinkClick } from '../navigation';
import { AREAS, areaPath } from '../routing';
import { useSession } from '../session/use-session';
import { describeError } from './error-text';
import { secondaryButtonClass } from './states';
import { NamedId, TechnicalDetails } from './technical';

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
 * authenticator with its last renewal and the Realm DE verified; the Realm's ids are technical details, collapsed at
 * the end; the pinned backend state is not shown, it is kept in the repository (gate/backend-pin.ts; Issue #352 des
 * Projektinhabers, 2026-11-12, point 2).
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
            <NamedId name={props.realmName} id={props.realmId} />
          </Row>
          <Row label="Fachdaten (DE)">{props.health === undefined ? 'Wird geprüft …' : 'Zugriff bestätigt für diesen Bestand'}</Row>
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
                {area.available !== undefined && <span className="text-muted">{`· ${area.available}`}</span>}
              </li>
            );
          })}
        </ul>
      </section>
      <section aria-label="Technische Angaben der Verbindung" className="rounded-card border border-border bg-surface px-6 py-2">
        <TechnicalDetails
          spacing=""
          entries={[
            ['Bestand (MRE-ID)', props.realmId],
            ['Zugriff bestätigt für', props.health === undefined ? 'Wird geprüft …' : props.health.mreRealmId],
          ]}
        />
      </section>
    </>
  );
}
