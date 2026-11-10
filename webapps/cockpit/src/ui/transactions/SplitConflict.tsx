import { useEffect, useRef } from 'react';
import { ApiError } from '../../api/errors';
import type { TransactionDetailDto } from '../../api/transactions';
import { referenceOf } from '../../transactions/split-draft';
import { MoneyText } from '../format';
import { ErrorState, LoadingState, Notice, secondaryButtonClass } from '../states';
import { statusLabel } from './labels';
import { categoryName, propertyName, type References } from './references';

/**
 * A version conflict of the split editor (`412 VERSION_CONFLICT`, api-design.md §16.1; ui-guide.md §7.3, §11): the draft
 * is kept, nothing is sent again by itself, and the user decides after the current state is read:
 * - "Serverstand laden": the draft is replaced by the stored set, the new `ETag` is the base;
 * - "Entwurf behalten": the stored set is shown beside the draft, the new `ETag` is the base, and only a new click on
 *   "Aufteilung speichern" replaces it. `details.currentVersion` is never used to retry (§7.3).
 */
export type ConflictState =
  | { readonly stage: 'ask'; readonly error: unknown }
  | { readonly stage: 'reading'; readonly keep: boolean }
  | { readonly stage: 'failed'; readonly keep: boolean; readonly error: unknown }
  | { readonly stage: 'kept'; readonly server: TransactionDetailDto };

export function SplitConflict({
  state,
  references,
  onDecide,
}: {
  readonly state: ConflictState;
  readonly references: References;
  readonly onDecide: (keep: boolean) => void;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  const asking = state.stage === 'ask';
  useEffect(() => {
    if (asking) heading.current?.focus();
  }, [asking]);

  if (state.stage === 'reading') return <LoadingState label="Aktueller Stand der Buchung wird gelesen …" />;
  if (state.stage === 'failed') {
    return (
      <ErrorState error={state.error}>
        <p className="mt-2">Der aktuelle Stand konnte nicht gelesen werden. Ihr Entwurf ist erhalten.</p>
        <button type="button" className={`${secondaryButtonClass} mt-3`} onClick={() => onDecide(state.keep)}>
          Erneut lesen
        </button>
      </ErrorState>
    );
  }
  if (state.stage === 'kept') return <ServerState transaction={state.server} references={references} />;

  const current = state.error instanceof ApiError ? state.error.details?.['currentVersion'] : undefined;
  return (
    <div role="alert" aria-labelledby="split-konflikt" className="rounded-card border border-warning-text bg-warning-bg p-4 text-warning-text">
      <h4 id="split-konflikt" ref={heading} tabIndex={-1} className="font-semibold">
        Inzwischen geändert
      </h4>
      <p>
        {`Die Buchung wurde seit dem Laden geändert${typeof current === 'number' ? ` (auf dem Server jetzt Version ${current})` : ''}. `}
        Ihr Entwurf ist nicht gespeichert und bleibt erhalten; es wird nichts von selbst wiederholt.
      </p>
      <div className="mt-3 flex flex-wrap gap-4">
        <button type="button" className={secondaryButtonClass} onClick={() => onDecide(false)}>
          Serverstand laden (Entwurf verwerfen)
        </button>
        <button type="button" className={secondaryButtonClass} onClick={() => onDecide(true)}>
          Entwurf behalten und Serverstand ansehen
        </button>
      </div>
    </div>
  );
}

/** The stored set beside the kept draft (§7.3: "Unterschiede zeigen"). */
function ServerState({ transaction: t, references }: { readonly transaction: TransactionDetailDto; readonly references: References }) {
  return (
    <Notice tone="info">
      <p className="font-semibold">{`Aktueller Stand auf dem Server: Version ${t.version}, Status „${statusLabel(t.status).text}“`}</p>
      {t.splits.length === 0 ? (
        <p>Dort ist die Buchung nicht aufgeteilt.</p>
      ) : (
        <ul aria-label="Aufteilung auf dem Server" className="list-disc pl-6">
          {t.splits.map((split) => {
            const reference = referenceOf(split);
            const property =
              'propertyReferenceId' in reference ? (propertyName(references, reference.propertyReferenceId) ?? reference.propertyReferenceId) : undefined;
            return (
              <li key={split.splitId}>
                {categoryName(references, split.financialCategoryCode) ?? split.financialCategoryCode}: <MoneyText money={split.amount} />
                {property === undefined ? '' : `, Objekt ${property}`}
                {split.description === null ? '' : `, ${split.description}`}
              </li>
            );
          })}
        </ul>
      )}
      <p className="mt-2">Ihr Entwurf unten ist unverändert. „Aufteilung speichern“ ersetzt diesen Stand durch den Entwurf.</p>
    </Notice>
  );
}
