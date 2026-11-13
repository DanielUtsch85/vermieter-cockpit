import type { ReactNode } from 'react';

/**
 * Technical details out of the visible text (Issue #352 des Projektinhabers, 2026-11-12, point 3): versions, entity tags,
 * ids and MRE ObjectIds of a card go into one collapsed block „Technische Angaben“ at the card's end. The values stay
 * readable for support, the page shows names, amounts and states.
 */
/** A version as „Technische Angaben“ show it: the number, with the entity tag when the answer carried one. */
export const versionText = (version: number, etag: string | undefined): string => `${version}${etag === undefined ? '' : ` (ETag ${etag})`}`;

export function TechnicalDetails({
  entries,
  spacing = 'mt-3',
}: {
  readonly entries: readonly (readonly [string, ReactNode])[];
  /** The space above the block: below a card's content by default, none when the block is a card of its own. */
  readonly spacing?: string;
}) {
  return (
    <details className={`${spacing} text-label text-muted`.trim()}>
      <summary className="min-h-touch cursor-pointer py-2">Technische Angaben</summary>
      <dl className="grid gap-x-4 gap-y-1 sm:grid-cols-[14rem_1fr]">
        {entries.map(([label, value]) => (
          <div key={label} className="contents">
            <dt>{label}</dt>
            <dd className="min-w-0 break-all font-mono">{value}</dd>
          </div>
        ))}
      </dl>
    </details>
  );
}
