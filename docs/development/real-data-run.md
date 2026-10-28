# Real-data run (#93)

A time-boxed experiment: real data of a real landlord through the API, to check the specification's assumptions against reality before Phase 5. The goal is findings, not code. Personal data stays out of this note: no IBANs, names or references from the files used.

**Status:** step 1 (bank import) done on 2026-10-28; step 2 (loan schedule vs. the bank's plan) and step 3 (rent reconciliation against MRE terms) are open.

## Step 1: bank export (BBBank, CSV)

**Input:** one real export of a BBBank checking account ("BetterSmart Konto"), 4 rows from August to October 2026: two SEPA direct debits of a WEG (Hausgeld and Erhaltungsrücklage, one each), one transfer from the owner's private account, one bank bonus. UTF-8 with BOM, CRLF, `;`, German decimal comma, `DD.MM.YYYY`; 18 columns, newest row first.

**How:** `POST /api/v1/imports/bank-transactions` with `generic-csv` v1, as `main.ts` wires it (PostgreSQL, the API; MRE faked for the login only). Mapping, all by column name:

| DE field | BBBank column |
|---|---|
| `bookingDate` | `Buchungstag` |
| `valueDate` | `Valutadatum` |
| `amount` | `Betrag` |
| `currency` | `Waehrung` |
| `counterpartyName` | `Name Zahlungsbeteiligter` |
| `counterpartyIban` | `IBAN Zahlungsbeteiligter` |
| `description` | `Verwendungszweck` |

Not mappable in v1: `Saldo nach Buchung`, `Buchungstext` (Lastschrift/Gutschrift), `Glaeubiger ID`, `Mandatsreferenz`, and the export's own account (`IBAN Auftragskonto`). The SEPA references `EREF`/`MREF`/`CRED` arrive only inside `Verwendungszweck`, and only on direct debits.

### Results

| Case | Result | As the spec says? |
|---|---|---|
| First import of the file | 4 created, 0 `needs_review`, 0 errors; dates, amounts, directions, umlauts and BOM correct | yes |
| **The same file again** | 0 created, **4 duplicates** | yes (§70.5 "identical file retry") |
| **An older export, then a newer one that overlaps it** (2 shared rows, simulated by cutting the real file) | the 2 shared rows are **`needs_review`**, not duplicates; the new rows are created | yes (§70.4 "ambiguous cross-file match"), **but see F1** |
| The same booking twice in one file | 2 Transactions | yes (§70.4 "two legitimately identical real payments") |
| The file uploaded into a FinancialAccount with **another IBAN** | 4 created, no warning | the spec does not ask for a check; **see F2** |

### Findings

**F1 — Overlapping exports need a human for every shared row (high).** The spec's overlap case dedupes through a stable external id or a statement id (§70.1, §70.5 "overlap of the same source-statement identity"). A BBBank CSV has neither: the file is its own statement identity (`contentHash`), and there is no transaction id column. So a monthly export that overlaps the previous one by a few days puts each shared row into review, as designed, and the user resolves each one by hand (`SKIP`). With real exports, overlap is the normal case, not the exception. Options, for a decision (not implemented):
- **A. Workflow only:** export strictly non-overlapping periods (document it in the import guide). Cheapest; fragile, because banks' period filters and late bookings make gaps or overlaps easy.
- **B. EREF as external id:** a v2 adapter option that takes the SEPA end-to-end reference out of the description. Covers direct debits and some transfers only; transfers without EREF (here: the owner's transfer, the bonus) stay on the fallback.
- **C. Balance-aware identity (adapter v2):** `(bookingDate, amount, direction, balance after booking)` as the row identity, since the bank's running balance is the same for one booking in every export and differs between two equal payments. Tried as an experiment by mapping `Saldo nach Buchung` as `externalTransactionId`: the overlapping rows were then duplicates. Risk: a balance can repeat with identical content (e.g. a booking, its reversal and the same booking again on one day); then a real payment would be dropped as a duplicate, which the constitution forbids. Needs a written risk analysis and a spec change (§70.2), not a mapping trick.
- **D. Continuity check with the balance** (independent of A–C): `balance after booking` of consecutive rows must chain (`previous + amount = next`); a gap or a double row between exports becomes visible instead of silently wrong.

**F2 — No check that the file belongs to the account (medium).** The export carries its own account IBAN in every row; DE does not read it, so the file of account X imports into account Y without a word. Proposal: an optional `accountIban` mapping in the adapter; a mismatch with the FinancialAccount's IBAN refuses the import (422) before anything is written.

**F3 — The column mapping is typed by hand (low).** Seven column names per upload, with umlaut-free spellings (`Waehrung`) that are easy to get wrong. Proposal: saved mapping presets per bank (a BBBank preset), chosen by name in the upload.

**F4 — The reads do not show the counterparty (low).** The import stores counterparty name and IBAN (they feed the content fingerprint and rent suggestions), but `GET /transactions` does not return them. Checking an import by hand ("who paid this?") needs the description text only. Proposal: return the raw counterparty name and IBAN in the Transaction reads.

**F5 — Domain: WEG Hausgeld arrives as two debits (information for the WEG phase).** One debit for the Erhaltungsrücklage (fits `WEG_RESERVE_CONTRIBUTION`) and one for the Hausgeld. How much of the Hausgeld is recoverable (`WEG_RECOVERABLE` vs `WEG_NON_RECOVERABLE`) is only known from the annual WEG settlement, not when it is paid. The split categories exist; the workflow "book against the Wirtschaftsplan now, correct with the Jahresabrechnung" is not specified yet (`VERIFY`, docs/germany/weg.md).

**What worked without friction:** UTF-8 with BOM and umlauts, CRLF, decimal comma, German dates, newest-first order, signed amounts → direction, the second import of the same file, and the empty `needs_review` list on a first import.

### Proposed backlog entries
- F1: a decision record (ADR) on cross-export identity for CSV without external ids (options A–D), then the adapter v2 it chooses.
- F2: account IBAN check on import.
- F3: mapping presets per bank.
- F4: counterparty in the Transaction reads.

## Step 2: loan schedule (open)

Needs a real loan contract with its amortization plan (Tilgungsplan): create Loan and LoanTerms, record the first twelve payments as splits, compare `GET /loans/{id}/schedule` with the bank's plan to the cent.

## Step 3: rent reconciliation (open)

Needs one flat's MRE tenant and three months of real rent payments: reconcile them against the MRE terms and record whether the suggestions match.
