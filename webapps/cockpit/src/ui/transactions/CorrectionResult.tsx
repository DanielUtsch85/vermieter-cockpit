import { useEffect, useRef, type ReactNode } from 'react';
import { ApiError } from '../../api/errors';
import type { CorrectionResultDto, ReversalResultDto, TransactionDto } from '../../api/transactions';
import { onLinkClick } from '../../navigation';
import { reconciliationPath, transactionPath } from '../../routing';
import { DateText, MoneyText } from '../format';
import { secondaryButtonClass } from '../states';
import { statusLabel } from './labels';
import { StatusBadge } from './TransactionList';

function Link({ realmId, id, children }: { readonly realmId: string; readonly id: string; readonly children: ReactNode }) {
  const href = transactionPath(realmId, id);
  return (
    <a className="text-primary underline" href={href} onClick={(event) => onLinkClick(event, href)}>
      {children}
    </a>
  );
}

function Member({ realmId, label, transaction: t }: { readonly realmId: string; readonly label: string; readonly transaction: TransactionDto }) {
  return (
    <li className="flex flex-wrap items-center gap-2" data-testid={`kette-${t.transactionId}`}>
      <Link realmId={realmId} id={t.transactionId}>
        {label}
      </Link>
      <StatusBadge code={t.status} />
      <MoneyText money={t.amount} direction={t.direction} />
      <span className="text-muted">
        <DateText value={t.bookingDate} />
      </span>
      <span className="text-label text-muted">{`Version ${t.version}`}</span>
    </li>
  );
}

/**
 * The answer of a correction (api-design.md §35.1, §35.3; ui-guide.md §8: original, reversal and replacement, not one
 * record): each member with a link to its own detail, its status, its amount with direction and its version, exactly as
 * the server answered them. The heading takes the focus (§11).
 */
export function CorrectionResult({
  realmId,
  result,
}: {
  readonly realmId: string;
  readonly result: CorrectionResultDto & { readonly replacement: TransactionDto };
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus(), []);
  return (
    <section aria-labelledby="korrektur-ergebnis" className="flex flex-col gap-3 rounded-card border border-success-text bg-success-bg p-6 text-success-text">
      <h3 id="korrektur-ergebnis" ref={heading} tabIndex={-1} className="text-section font-semibold">
        Korrektur ausgeführt
      </h3>
      <p>{`Das Original hat jetzt den Status „${statusLabel(result.original.status).text}“ und bleibt unverändert sichtbar. Storno und Ersatzbuchung sind bestätigt und mit ihm verknüpft.`}</p>
      <ol aria-label="Korrekturkette" className="flex flex-col gap-1">
        <Member realmId={realmId} label="Original" transaction={result.original} />
        <Member realmId={realmId} label="Storno" transaction={result.reversal} />
        <Member realmId={realmId} label="Ersatzbuchung" transaction={result.replacement} />
      </ol>
    </section>
  );
}

/**
 * The answer of „Stornieren“ (api-design.md §35.9): the chain original → reversal, without a replacement, as the server
 * answered it. Says that it is final: no replacement, also not later. The heading takes the focus (§11).
 */
export function ReversalResult({ realmId, result }: { readonly realmId: string; readonly result: ReversalResultDto }) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus(), []);
  return (
    <section aria-labelledby="storno-ergebnis" className="flex flex-col gap-3 rounded-card border border-success-text bg-success-bg p-6 text-success-text">
      <h3 id="storno-ergebnis" ref={heading} tabIndex={-1} className="text-section font-semibold">
        Storno ausgeführt
      </h3>
      <p>{`Das Original hat jetzt den Status „${statusLabel(result.original.status).text}“ und bleibt unverändert sichtbar. Das Storno ist bestätigt und mit ihm verknüpft; es gibt keine Ersatzbuchung, auch später nicht.`}</p>
      <ol aria-label="Stornokette" className="flex flex-col gap-1">
        <Member realmId={realmId} label="Original" transaction={result.original} />
        <Member realmId={realmId} label="Storno" transaction={result.reversal} />
      </ol>
    </section>
  );
}

/** Which command was refused: the texts name it (`correct` „Korrektur“, `reverse` „Storno“). */
export type RefusedCommand = 'correct' | 'reverse';

const REFUSAL_TEXTS: Readonly<
  Record<
    RefusedCommand,
    { readonly verb: string; readonly retryHint: string; readonly afterRelease: string; readonly second: string; readonly reversal: string }
  >
> = {
  correct: {
    verb: 'korrigiert',
    retryHint: 'erst ein neuer Klick auf „Korrektur ausführen“ sendet mit der neuen Version.',
    afterRelease: 'danach ist die Korrektur möglich, und die Ersatzbuchung kann neu abgeglichen werden.',
    second: 'eine zweite Korrektur gibt es nicht.',
    reversal: 'Ein Storno wird nie korrigiert; korrigiert wird die Ersatzbuchung seines Originals.',
  },
  reverse: {
    verb: 'storniert',
    retryHint: 'erst „Storno ausführen“ und „Jetzt stornieren“ senden mit der neuen Version.',
    afterRelease: 'danach ist das Storno möglich.',
    second: 'ein zweites Storno gibt es nicht.',
    reversal: 'Ein Storno wird nie storniert; es bleibt Teil der Kette seines Originals.',
  },
};

const ids = (value: unknown): readonly string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []);

/**
 * The reasons of a refused correction (api-design.md §35.4, §37.1 P4-D7) in German; an unknown one with its code
 * (ui-guide.md §7.4). `ALREADY_CORRECTED` links the existing correction, so a lost first answer is found again (§35.5).
 * `TRANSACTION_RENT_RECONCILED` explains the release first (ui-guide.md §8) and links each named reconciliation to its
 * page in the Mietabgleich area, where „Zuordnung aufheben“ is offered (step 6, as proposed in the review on #336). A `412` offers to read the current state; the draft stays, nothing is sent by itself.
 * „Stornieren“ (§35.9) is refused with the same reasons and shows the same texts with its own verb (`command="reverse"`).
 */
export function CorrectionRefusal({
  realmId,
  error,
  onReload,
  command = 'correct',
}: {
  readonly realmId: string;
  readonly error: unknown;
  readonly onReload: () => void;
  readonly command?: RefusedCommand;
}) {
  if (!(error instanceof ApiError)) return null;
  const texts = REFUSAL_TEXTS[command];
  if (error.status === 412) {
    return (
      <>
        <p className="mt-2">
          {`Die Buchung wurde seit dem Laden geändert. Ihr Entwurf bleibt erhalten; es wird nichts von selbst wiederholt. Nach dem Laden steht der aktuelle Stand oben im Detail, und ${texts.retryHint}`}
        </p>
        <button type="button" className={`${secondaryButtonClass} mt-3`} onClick={onReload}>
          Aktuellen Stand laden
        </button>
      </>
    );
  }
  const details = error.details ?? {};
  const reason = details['reason'];
  if (typeof reason !== 'string') return null;
  switch (reason) {
    case 'TRANSACTION_RENT_RECONCILED': {
      const reconciliations = ids(details['reconciliationIds']);
      return (
        <div className="mt-2 flex flex-col gap-1">
          <p>{`Diese Buchung ist durch einen bestätigten Mietabgleich mit einer Mietforderung verknüpft. Solange er besteht, kann sie nicht ${texts.verb} werden: der Abgleich würde sonst auf Geld zeigen, das nicht mehr zählt.`}</p>
          <p>{`Zuerst muss die Zuordnung im Mietabgleich aufgehoben werden („Zuordnung aufheben“); ${texts.afterRelease} Aufheben ändert nur DE; eine schon an MRE übertragene Zahlung wird danach gesondert aus MRE entfernt.`}</p>
          {reconciliations.length > 0 && (
            <ul aria-label="Betroffene Mietzuordnungen" className="flex flex-col gap-1">
              {reconciliations.map((id) => {
                const href = reconciliationPath(realmId, id);
                return (
                  <li key={id}>
                    <a className="text-primary underline" href={href} title={id} onClick={(event) => onLinkClick(event, href)}>
                      Mietzuordnung öffnen und aufheben
                    </a>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      );
    }
    case 'ALREADY_CORRECTED': {
      const reversal = details['reversalTransactionId'];
      const replacement = details['replacementTransactionId'];
      return (
        <div className="mt-2 flex flex-col gap-1">
          <p>{`Die Buchung ist bereits korrigiert oder storniert; ${texts.second}`}</p>
          <ul className="flex flex-col gap-1">
            {typeof reversal === 'string' && (
              <li>
                <Link realmId={realmId} id={reversal}>
                  Vorhandenes Storno
                </Link>
              </li>
            )}
            {typeof replacement === 'string' && (
              <li>
                <Link realmId={realmId} id={replacement}>
                  Vorhandene Ersatzbuchung
                </Link>
              </li>
            )}
          </ul>
        </div>
      );
    }
    case 'NOT_CORRECTABLE':
      return (
        <p className="mt-2">
          {details['correctionRole'] === 'REVERSAL'
            ? texts.reversal
            : `Die Buchung hat den Status „${statusLabel(String(details['status'])).text}“ und kann nicht ${texts.verb} werden.`}
        </p>
      );
    case 'NO_CHANGE':
      return <p className="mt-2">Die Ersatzbuchung gleicht dem Original in jedem Feld; es gibt nichts zu korrigieren.</p>;
    case 'ACCOUNT_CLOSED':
      return <p className="mt-2">Das Konto ist geschlossen.</p>;
    case 'SPLIT_SUM_MISMATCH':
      return <p className="mt-2">Die Teilbeträge der Ersatzbuchung decken ihren Betrag nicht genau.</p>;
    case 'INACTIVE_CATEGORY':
      return (
        <p className="mt-2">{`Eine übernommene Kategorie ist nicht mehr aktiv (${ids(details['financialCategoryCodes']).join(', ')}). Bitte die Aufteilung der Ersatzbuchung ändern.`}</p>
      );
    case 'LOAN_NOT_ACTIVE':
      return <p className="mt-2">Das Darlehen eines Teilbetrags ist nicht mehr aktiv.</p>;
    case 'LOAN_CLOSED':
      return <p className="mt-2">Das Darlehen eines Teilbetrags ist zum Buchungsdatum bereits abgeschlossen.</p>;
    default:
      return <p className="mt-2">{`Grund ${reason}.`}</p>;
  }
}
