import type { TermCoverageDto } from '../../api/rent-reconciliations';
import { DateText, MoneyText } from '../format';
import { coverageText, mrePaymentTypeText, mreStatusText } from './rent-labels';
import { ReconciliationBadges, ReconciliationLink, TenantText, TermText, TransactionLink } from './RentParts';
import { IdText } from '../IdText';

/**
 * The coverage of one MRE rent term (api-design.md §37.2; ui-guide.md §6.6): DE's confirmed matches and MRE's own
 * payment records **next to each other, never summed together**. `coverage` and `openAmount` are the server's, with
 * their source said; MRE's `AVAILABLE`, `NOT_RETURNED` and `UNAVAILABLE` are three different texts, and without MRE's
 * amount due (`coverage = null`) nothing is said to be paid (§4.4: no invented 0,00 €).
 */
export function TermCoverageView({ realmId, coverage: c }: { readonly realmId: string; readonly coverage: TermCoverageDto }) {
  return (
    <>
      <section aria-labelledby="termin" className="rounded-card border border-border bg-surface p-6">
        <h2 id="termin" className="mb-2 text-section font-semibold">
          Mieter und Termin
        </h2>
        <p>
          <TenantText id={c.mreTenantId} /> · <TermText term={c.mreRentTerm} />
        </p>
      </section>
      <div className="grid gap-4 md:grid-cols-2">
        <section aria-labelledby="termin-de" className="rounded-card border border-border bg-surface p-6">
          <h2 id="termin-de" className="mb-2 text-section font-semibold">
            Aus bestätigten Buchungen (DE)
          </h2>
          <p>
            {'Summe der bestätigten Zuordnungen: '}
            <MoneyText money={c.matchedTotal} />
          </p>
          <p className="text-label text-muted">Nur bestätigte Zuordnungen zählen; Vorschläge, abgelehnte und aufgehobene sind gelistet, aber nicht summiert.</p>
          {c.reconciliations.length === 0 ? (
            <p className="mt-2 text-muted">Keine Zuordnung in DE für diesen Termin.</p>
          ) : (
            <ul aria-label="Zuordnungen in DE" className="mt-2 flex flex-col gap-2">
              {c.reconciliations.map((r) => (
                <li key={r.reconciliationId} className="flex flex-wrap items-center gap-2">
                  <MoneyText money={r.matchedAmount} /> <ReconciliationBadges r={r} /> <ReconciliationLink realmId={realmId} id={r.reconciliationId} /> ·{' '}
                  <TransactionLink realmId={realmId} id={r.transactionId} />
                </li>
              ))}
            </ul>
          )}
        </section>
        <section aria-labelledby="termin-mre" className="rounded-card border border-border bg-surface p-6">
          <h2 id="termin-mre" className="mb-2 text-section font-semibold">
            MRE-Zahlungsstand
          </h2>
          <p>{mreStatusText(c.mreStatus)}</p>
          {c.mre !== null && (
            <>
              <p className="mt-2">
                {'Sollbetrag laut MRE (ohne Vortrag): '}
                <MoneyText money={c.mre.amountDue} />
              </p>
              <p className="text-label text-muted">Zahlungen in MRE sind MRE-Abrechnung, kein Geldeingang in DE; sie zählen nicht zur Summe der Zuordnungen.</p>
              {c.mre.payments.length === 0 ? (
                <p className="mt-2 text-muted">MRE hat für diesen Termin keine Zahlung erfasst.</p>
              ) : (
                <ul aria-label="Zahlungen in MRE" className="mt-2 flex flex-col gap-1">
                  {c.mre.payments.map((p, i) => (
                    <li key={i}>
                      <DateText value={p.date} /> · <MoneyText money={p.amount} /> · {mrePaymentTypeText(p.type)}
                      {p.reference !== null && p.reference !== '' && (
                        <>
                          {' · Kennung '}
                          <IdText id={p.reference} />
                        </>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </section>
      </div>
      <section aria-labelledby="termin-deckung" className="rounded-card border border-border bg-surface p-6">
        <h2 id="termin-deckung" className="mb-2 text-section font-semibold">
          Deckung
        </h2>
        <p>{coverageText(c.coverage)}</p>
        {c.openAmount !== null && c.coverage !== null && (
          <p className="mt-2">
            {'Offener Betrag: '}
            <MoneyText money={c.openAmount} />
            <span className="text-muted"> (Sollbetrag laut MRE abzüglich der bestätigten Zuordnungen in DE; negativ heißt überzahlt)</span>
          </p>
        )}
      </section>
    </>
  );
}
