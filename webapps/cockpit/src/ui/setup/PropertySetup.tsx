import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import type { DeClient } from '../../api/client';
import { linkPropertyReference, listMreProperties, type MreProperty } from '../../api/setup';
import { listPropertyReferences, type PropertyReferenceDto } from '../../api/transactions';
import { realmKey } from '../../query';
import { AREAS, areaPath } from '../../routing';
import { useSession } from '../../session/use-session';
import { Badge } from '../Badge';
import { IdText } from '../IdText';
import { Link, MreLink } from '../Link';
import { PageTitle } from '../PageTitle';
import { ErrorState, isRetryable, LoadingState, Notice, ReadProblem, secondaryButtonClass } from '../states';
import { transactionKeys } from '../transactions/TransactionsArea';
import { linkRefusalText } from './setup-labels';
import { SETUP_LABELS } from './setup-links';

const transactionsArea = AREAS.find((area) => area.id === 'buchungen');
const nameOf = (p: MreProperty) => (p.name === '' ? 'Objekt ohne Namen' : p.name);

/**
 * „Objekte verknüpfen“ (Issue #365; api-design.md §23.1; Entscheidung des Projektinhabers, 2026-11-16: „Objekte
 * verknüpfen aus der MRE-Liste des Bestands“): the Realm's properties in MRE, each already linked in DE or with
 * „Verknüpfen“. A link is one `POST /property-references/link`; a second click while one runs does nothing. The route's
 * natural key makes a repeat a success with the existing reference, so a link after a lost answer is simply sent again.
 * Nothing is shown as linked before the server's answer.
 */
export function PropertySetup(props: { readonly client: DeClient; readonly realmId: string; readonly epoch: number }) {
  const session = useSession();
  const queryClient = useQueryClient();
  const mre = useQuery({
    queryKey: realmKey(props.realmId, props.epoch, 'mre-properties'),
    queryFn: ({ signal }) => listMreProperties(session, props.realmId, undefined, signal),
  });
  const linked = useQuery({
    queryKey: transactionKeys.properties(props.realmId, props.epoch),
    queryFn: ({ signal }) => listPropertyReferences(props.client, signal),
  });
  const [answers, setAnswers] = useState<readonly PropertyReferenceDto[]>([]);
  const [sending, setSending] = useState<string | undefined>(undefined);
  const [outcome, setOutcome] = useState<
    { readonly kind: 'linked'; readonly name: string } | { readonly kind: 'refused'; readonly name: string; readonly error: unknown } | undefined
  >(undefined);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  const message = useRef<HTMLDivElement>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (outcome !== undefined) message.current?.focus();
  }, [outcome]);

  const link = (property: MreProperty) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setSending(property.id);
    setOutcome(undefined);
    linkPropertyReference(props.client, property.id)
      .then(
        (reference) => {
          if (!mounted.current) return;
          setAnswers((current) => [...current, reference]);
          setOutcome({ kind: 'linked', name: nameOf(property) });
          void queryClient.invalidateQueries({ queryKey: transactionKeys.properties(props.realmId, props.epoch) });
        },
        (error: unknown) => {
          if (mounted.current) setOutcome({ kind: 'refused', name: nameOf(property), error });
        },
      )
      .finally(() => {
        inFlight.current = false;
        if (mounted.current) setSending(undefined);
      });
  };

  const references = [...(linked.data?.items ?? []), ...answers];
  const linkOf = (property: MreProperty) => references.find((reference) => reference.mrePropertyId === property.id);
  const listed = new Set((mre.data ?? []).map((property) => property.id));
  const unlisted = (linked.data?.items ?? []).filter((reference) => !listed.has(reference.mrePropertyId));

  return (
    <>
      <PageTitle title={SETUP_LABELS.objekte} />
      <p className="text-muted">
        Objekte entstehen in MicroRealEstate. Verknüpft stehen sie im Cockpit in der Aufteilung einer Buchung und im Objektfilter der Buchungsliste zur Wahl;
        Name und Adresse bleiben in MicroRealEstate. <MreLink />
      </p>
      {outcome !== undefined && (
        <div ref={message} tabIndex={-1}>
          {outcome.kind === 'linked' ? (
            <div role="status">
              <Notice tone="success">
                <p>{`„${outcome.name}“ ist verknüpft.`}</p>
                {transactionsArea !== undefined && (
                  <p>
                    <Link href={areaPath(props.realmId, transactionsArea)}>Zu den Buchungen</Link>
                  </p>
                )}
              </Notice>
            </div>
          ) : (
            <ErrorState error={outcome.error}>
              <p className="mt-2">{linkRefusalText(outcome.error) ?? `„${outcome.name}“ wurde nicht verknüpft.`}</p>
              {isRetryable(outcome.error) && <p className="mt-2">Ob verknüpft wurde, ist unklar. Erneut „Verknüpfen“ legt keine zweite Verknüpfung an.</p>}
            </ErrorState>
          )}
        </div>
      )}
      <section aria-labelledby="mre-objekte" className="rounded-card border border-border bg-surface p-6">
        <h2 id="mre-objekte" className="mb-2 text-section font-semibold">
          Objekte in MicroRealEstate
        </h2>
        {mre.isPending || linked.isPending ? (
          <LoadingState label="Objekte werden geladen …" />
        ) : mre.isError ? (
          <ReadProblem error={mre.error} onRetry={() => void mre.refetch()}>
            <p>Die Objektliste von MicroRealEstate konnte nicht gelesen werden.</p>
          </ReadProblem>
        ) : linked.isError ? (
          <ReadProblem error={linked.error} onRetry={() => void linked.refetch()} />
        ) : mre.data.length === 0 ? (
          <p className="text-muted">
            In MicroRealEstate gibt es in diesem Bestand noch kein Objekt. Ein Objekt wird in MicroRealEstate angelegt; danach erscheint es hier zum Verknüpfen.{' '}
            <MreLink />
          </p>
        ) : (
          <ul aria-label="Objekte in MicroRealEstate" className="flex flex-col divide-y divide-border">
            {mre.data.map((property) => {
              const reference = linkOf(property);
              return (
                <li key={property.id} className="flex flex-wrap items-center justify-between gap-3 py-2">
                  <span className="flex min-w-0 flex-col">
                    <span className="font-semibold">{nameOf(property)}</span>
                    <span className="text-label text-muted">
                      {'MRE-ID '}
                      <IdText id={property.id} />
                    </span>
                  </span>
                  {reference !== undefined ? (
                    <Badge label={{ text: 'Verknüpft', tone: 'success', known: true }} />
                  ) : (
                    <button
                      type="button"
                      className={secondaryButtonClass}
                      aria-label={`${nameOf(property)} verknüpfen`}
                      disabled={sending !== undefined}
                      onClick={() => link(property)}
                    >
                      {sending === property.id ? 'Wird verknüpft …' : 'Verknüpfen'}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {linked.isSuccess && linked.data.total > linked.data.items.length && (
          <p className="text-label text-muted">{`Geprüft wurden die ersten ${linked.data.items.length} von ${linked.data.total} verknüpften Objekten.`}</p>
        )}
      </section>
      {mre.isSuccess && unlisted.length > 0 && (
        <section aria-labelledby="nicht-gelistet" className="rounded-card border border-border bg-surface p-6">
          <h2 id="nicht-gelistet" className="mb-2 text-section font-semibold">
            Verknüpft, aber in MicroRealEstate nicht gelistet
          </h2>
          <ul className="flex flex-col gap-1">
            {unlisted.map((reference) => (
              <li key={reference.propertyReferenceId}>
                <IdText name={reference.displayName ?? undefined} id={reference.mrePropertyId} missing="Objekt ohne Namen" />
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}
