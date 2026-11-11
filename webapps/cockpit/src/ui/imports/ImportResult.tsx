import type { ReactNode } from 'react';
import type { ImportBatchDto, ImportRowDto } from '../../api/imports';
import type { FinancialAccountDto } from '../../api/transactions';
import { formatDecimal, formatMoney } from '../../format/money';
import { onLinkClick } from '../../navigation';
import { importBatchPath, transactionPath } from '../../routing';
import { TimestampText } from '../format';
import { ambiguityText, batchStatusText, orderText, previousExportText, resolutionText, rowErrorText } from './import-labels';

function Link({ href, children }: { readonly href: string; readonly children: ReactNode }) {
  return (
    <a className="text-primary underline" href={href} onClick={(event) => onLinkClick(event, href)}>
      {children}
    </a>
  );
}

const short = (id: string) => id.slice(0, 8);

/** A balance as the API sends it (a signed decimal string), in German, with the account's currency when known. */
function Balance({ amount, currency }: { readonly amount: string; readonly currency: string | undefined }) {
  const text = currency === undefined ? formatDecimal(amount) : formatMoney({ amount, currency });
  if (text === undefined) return <span className="text-danger-text">{`Saldo nicht lesbar (${amount})`}</span>;
  return <span className="whitespace-nowrap tabular-nums">{text}</span>;
}

/**
 * Step 3 of the import (ui-guide.md §6.5): the batch as the server answered it, never recomputed: its id, file,
 * account, adapter, status and counters, the continuity report and every row's outcome in file order (api-design.md
 * §32.1a). A row that refers to a review item of an earlier batch links that batch, where the item is decided.
 */
export function ImportResult(props: { readonly realmId: string; readonly batch: ImportBatchDto; readonly accounts: readonly FinancialAccountDto[] }) {
  const b = props.batch;
  const account = props.accounts.find((candidate) => candidate.financialAccountId === b.financialAccountId);
  const counters: readonly (readonly [string, number])[] = [
    ['Neu angelegte Buchungen', b.transactionCount],
    ['Duplikate', b.duplicateCount],
    ['Offene Klärfälle dieses Imports', b.needsReviewCount],
    ['Zeilen mit Fehler', b.errorCount],
    ['Übersprungen (kein Geldfluss)', b.skippedCount],
  ];
  return (
    <>
      <section aria-labelledby="import-ergebnis" className="rounded-card border border-border bg-surface p-6">
        <h2 id="import-ergebnis" className="mb-2 text-section font-semibold">
          Ergebnis des Imports
        </h2>
        <dl className="grid gap-x-4 gap-y-1 sm:grid-cols-[14rem_1fr]">
          <dt className="text-muted">Import</dt>
          <dd>
            <code className="font-mono">{b.importBatchId}</code>
          </dd>
          <dt className="text-muted">Status</dt>
          <dd>{batchStatusText(b.status)}</dd>
          <dt className="text-muted">Datei</dt>
          <dd>{b.sourceFilename ?? 'Nicht verfügbar'}</dd>
          <dt className="text-muted">Konto</dt>
          <dd>{account === undefined ? <code className="font-mono">{b.financialAccountId}</code> : account.displayName}</dd>
          <dt className="text-muted">Adapter</dt>
          <dd>{`${b.adapterId}, Version ${b.adapterVersion}`}</dd>
          <dt className="text-muted">Importiert</dt>
          <dd>
            <TimestampText value={b.importedAt} /> {`von ${b.importedBy}`}
          </dd>
        </dl>
        <h3 className="mt-4 font-semibold">Zähler</h3>
        <dl aria-label="Zähler" className="grid gap-x-4 gap-y-1 sm:grid-cols-[18rem_1fr]">
          {counters.map(([label, value]) => (
            <div key={label} className="contents">
              <dt className="text-muted">{label}</dt>
              <dd className="tabular-nums">{value}</dd>
            </div>
          ))}
        </dl>
      </section>
      <Continuity continuity={b.continuity} currency={account?.currency} />
      <section aria-labelledby="import-zeilen" className="rounded-card border border-border bg-surface p-6">
        <h2 id="import-zeilen" className="mb-2 text-section font-semibold">
          Zeilen der Datei
        </h2>
        {b.rows.length === 0 ? (
          <p className="text-muted">Die Datei enthielt keine Datenzeile.</p>
        ) : (
          <table className="w-full text-left">
            <thead>
              <tr>
                <th scope="col" className="pr-4">
                  Zeile
                </th>
                <th scope="col" className="pr-4">
                  Ergebnis
                </th>
                <th scope="col">Einzelheiten</th>
              </tr>
            </thead>
            <tbody>
              {b.rows.map((row) => (
                <tr key={row.position} className="border-t border-border align-top">
                  <td className="pr-4 tabular-nums">{row.position}</td>
                  <RowOutcome realmId={props.realmId} batchId={b.importBatchId} row={row} />
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}

function RowOutcome({ realmId, batchId, row }: { readonly realmId: string; readonly batchId: string; readonly row: ImportRowDto }) {
  const earlier = (owner: string) =>
    owner.toLowerCase() === batchId.toLowerCase() ? null : (
      <>
        {' '}
        <Link href={importBatchPath(realmId, owner)}>{`Klärfall im früheren Import ${short(owner)} öffnen`}</Link>
      </>
    );
  switch (row.outcome) {
    case 'created':
      return (
        <>
          <td className="pr-4">Neu angelegt</td>
          <td>
            <Link href={transactionPath(realmId, row.transactionId)}>Buchung öffnen</Link>
          </td>
        </>
      );
    case 'duplicate':
      return row.duplicateOf === 'TRANSACTION' ? (
        <>
          <td className="pr-4">Duplikat</td>
          <td>
            Schon importiert: <Link href={transactionPath(realmId, row.transactionId)}>vorhandene Buchung öffnen</Link>
          </td>
        </>
      ) : row.duplicateOf === 'RESOLVED_REVIEW_ITEM' ? (
        <>
          <td className="pr-4">Duplikat</td>
          <td>
            {`Schon als Klärfall entschieden: ${resolutionText(row.resolution)}.`}
            {row.createdTransactionId !== undefined && (
              <>
                {' '}
                <Link href={transactionPath(realmId, row.createdTransactionId)}>Buchung öffnen</Link>
              </>
            )}
            {earlier(row.importBatchId)}
          </td>
        </>
      ) : (
        <UnknownOutcome code={`duplicate/${String((row as { duplicateOf: unknown }).duplicateOf)}`} />
      );
    case 'needs_review':
      return (
        <>
          <td className="pr-4">Klärfall</td>
          <td>
            {ambiguityText(row.reason)}
            {row.importBatchId.toLowerCase() === batchId.toLowerCase() ? ' (unten entscheiden)' : ' (offen in einem früheren Import)'}
            {earlier(row.importBatchId)}
          </td>
        </>
      );
    case 'error':
      return (
        <>
          <td className="pr-4">Fehler</td>
          <td>
            <ul className="list-disc pl-6">
              {row.errors.map((entry, i) => {
                const { name, text } = rowErrorText(entry);
                return (
                  <li key={i}>
                    <code className="font-mono">{name}</code>: {text}
                  </li>
                );
              })}
            </ul>
          </td>
        </>
      );
    case 'skipped':
      return (
        <>
          <td className="pr-4">Übersprungen</td>
          <td>{row.reason === 'ZERO_AMOUNT' ? 'Betrag 0: kein Geldfluss, keine Buchung' : `Grund ${String((row as { reason: unknown }).reason)}`}</td>
        </>
      );
    default:
      return <UnknownOutcome code={String((row as { outcome: unknown }).outcome)} />;
  }
}

function UnknownOutcome({ code }: { readonly code: string }) {
  return (
    <>
      <td className="pr-4">{`Unbekanntes Ergebnis (${code})`}</td>
      <td className="text-muted">Nicht verfügbar</td>
    </>
  );
}

/** The continuity report (api-design.md §32.1a, data-model.md §70.6): reported as the server sent it, never a refusal. */
function Continuity({ continuity, currency }: { readonly continuity: ImportBatchDto['continuity']; readonly currency: string | undefined }) {
  return (
    <section aria-labelledby="import-saldo" className="rounded-card border border-border bg-surface p-6">
      <h2 id="import-saldo" className="mb-2 text-section font-semibold">
        Lückenlosigkeit (Saldo)
      </h2>
      {continuity === null ? (
        <p className="text-muted">Die Datei hat keine Saldo-Spalte mit Werten; die Lückenlosigkeit wurde nicht geprüft.</p>
      ) : (
        <>
          <p>{`Reihenfolge der Datei: ${orderText(continuity.order)}.`}</p>
          <p>{previousExportText(continuity.previousExport)}</p>
          {continuity.breaks.length === 0 ? (
            <p>Innerhalb der Datei folgt jeder Saldo aus dem vorigen.</p>
          ) : (
            <>
              <p>Hier folgt der Saldo nicht aus dem vorigen (z. B. ein gefilterter Export):</p>
              <ul aria-label="Saldosprünge" className="list-disc pl-6">
                {continuity.breaks.map((entry) => (
                  <li key={entry.position}>
                    {`Zeile ${entry.position}: erwartet `}
                    <Balance amount={entry.expectedBalanceAfter} currency={currency} />
                    {', in der Datei '}
                    <Balance amount={entry.balanceAfter} currency={currency} />
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </section>
  );
}
