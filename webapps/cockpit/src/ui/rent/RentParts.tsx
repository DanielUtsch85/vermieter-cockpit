import type { ReactNode } from 'react';
import type { RentReconciliationDto } from '../../api/rent-reconciliations';
import { formatBusinessDate } from '../../format/dates';
import { onLinkClick } from '../../navigation';
import { reconciliationPath, rentTermPath, transactionPath } from '../../routing';
import { termDate } from '../../rent/reconciliation-rules';
import type { CodeLabel } from '../transactions/labels';
import { TONES } from '../transactions/TransactionList';
import { reconciliationStatusLabel, writeBackStateLabel } from './rent-labels';

/** Shared pieces of step 6: the two badges, the term, the Tenant and the links (ui-guide.md §6.6). */

export function Badge({ label }: { readonly label: CodeLabel }) {
  return <span className={`inline-block whitespace-nowrap rounded-input border px-2 text-label ${TONES[label.tone]}`}>{label.text}</span>;
}

/** Status **and** `mreWriteBackState`: two separate badges, never merged into one (§6.6). */
export function ReconciliationBadges({ r }: { readonly r: Pick<RentReconciliationDto, 'status' | 'mreWriteBackState'> }) {
  return (
    <span className="inline-flex flex-wrap gap-2">
      <span>
        <span className="sr-only">Status: </span>
        <Badge label={reconciliationStatusLabel(r.status)} />
      </span>
      <span>
        <span className="sr-only">Stand in MRE: </span>
        <Badge label={writeBackStateLabel(r.mreWriteBackState)} />
      </span>
    </span>
  );
}

export function Link({ href, children }: { readonly href: string; readonly children: ReactNode }) {
  return (
    <a className="text-primary underline" href={href} onClick={(event) => onLinkClick(event, href)}>
      {children}
    </a>
  );
}

export const Code = ({ value }: { readonly value: string }) => <code className="font-mono text-label">{value}</code>;

/** MRE's term key with the date it names; the key itself stays visible (ui-guide.md §5.2: a key, not a timestamp). */
export function TermText({ term }: { readonly term: string }) {
  const date = termDate(term);
  return (
    <>
      {date === undefined ? <span className="text-muted">Termin nicht lesbar</span> : `Termin ${formatBusinessDate(date) ?? date}`} <Code value={term} />
    </>
  );
}

/**
 * The MRE Tenant by its id only. DE never reads a Tenant's name or contact data (api-design.md §37.1, mre-integration
 * §20.1), and no name is guessed from the id (ui-guide.md §6.6); the name is looked up in MRE.
 */
export function TenantText({ id }: { readonly id: string }) {
  return (
    <>
      <span className="text-muted">Mieter in MRE</span> <Code value={id} />
    </>
  );
}

export function TransactionLink({ realmId, id, children }: { readonly realmId: string; readonly id: string; readonly children?: ReactNode }) {
  return <Link href={transactionPath(realmId, id)}>{children ?? 'Buchung öffnen'}</Link>;
}

export function ReconciliationLink({ realmId, id, children }: { readonly realmId: string; readonly id: string; readonly children?: ReactNode }) {
  return <Link href={reconciliationPath(realmId, id)}>{children ?? 'Zuordnung öffnen'}</Link>;
}

export function TermLink({
  realmId,
  r,
  children,
}: {
  readonly realmId: string;
  readonly r: Pick<RentReconciliationDto, 'mreTenantId' | 'mreRentTerm'>;
  readonly children?: ReactNode;
}) {
  return <Link href={rentTermPath(realmId, { mreTenantId: r.mreTenantId, mreRentTerm: r.mreRentTerm })}>{children ?? 'Abdeckung des Termins'}</Link>;
}
