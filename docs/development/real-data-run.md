# Real-data run (#93)

A time-boxed experiment: real data of a real landlord through the API, to check the specification's assumptions against reality before Phase 5. The goal is findings, not code. Personal data stays out of this note: no IBANs, names or references from the files used.

**Status:** step 1 (bank import) done on 2026-10-28; step 2 (loan schedule) part 1 done on 2026-10-29, the comparison with the bank's plan open; step 3 (rent reconciliation against MRE terms) done on 2026-10-29.

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

**F1 — Overlapping exports need a human for every shared row (high).** The spec's overlap case dedupes through a stable external id or a statement id (§70.1, §70.5 "overlap of the same source-statement identity"). A BBBank CSV has neither: the file is its own statement identity (`contentHash`), and there is no transaction id column. So a monthly export that overlaps the previous one by a few days puts each shared row into review, as designed, and the user resolves each one by hand (`SKIP`). With real exports, overlap is the normal case, not the exception. **Decided:** D with C, ADR-043 (`data-model.md` §70.6, backlog VC-1-12). Options weighed:
- **A. Workflow only:** export strictly non-overlapping periods (document it in the import guide). Cheapest; fragile, because banks' period filters and late bookings make gaps or overlaps easy.
- **B. EREF as external id:** a v2 adapter option that takes the SEPA end-to-end reference out of the description. Covers direct debits and some transfers only; transfers without EREF (here: the owner's transfer, the bonus) stay on the fallback.
- **C. Balance-aware identity (adapter v2):** `(bookingDate, amount, direction, balance after booking)` as the row identity, since the bank's running balance is the same for one booking in every export and differs between two equal payments. Tried as an experiment by mapping `Saldo nach Buchung` as `externalTransactionId`: the overlapping rows were then duplicates. Risk: a balance can repeat with identical content (e.g. a booking, its reversal and the same booking again on one day); then a real payment would be dropped as a duplicate, which the constitution forbids. Needs a written risk analysis and a spec change (§70.2), not a mapping trick.
- **D. Continuity check with the balance** (independent of A–C): `balance after booking` of consecutive rows must chain (`previous + amount = next`); a gap or a double row between exports becomes visible instead of silently wrong.

**F2 — No check that the file belongs to the account (medium).** The export carries its own account IBAN in every row; DE does not read it, so the file of account X imports into account Y without a word. Proposal: an optional `accountIban` mapping in the adapter; a mismatch with the FinancialAccount's IBAN refuses the import (422) before anything is written.

**F3 — The column mapping is typed by hand (low).** Seven column names per upload, with umlaut-free spellings (`Waehrung`) that are easy to get wrong. Proposal: saved mapping presets per bank (a BBBank preset), chosen by name in the upload.

**F4 — The reads do not show the counterparty (low).** The import stores counterparty name and IBAN (they feed the content fingerprint and rent suggestions), but `GET /transactions` does not return them. Checking an import by hand ("who paid this?") needs the description text only. Proposal: return the raw counterparty name and IBAN in the Transaction reads.

**F5 — Domain: WEG Hausgeld arrives as two debits (information for the WEG phase).** One debit for the Erhaltungsrücklage (fits `WEG_RESERVE_CONTRIBUTION`) and one for the Hausgeld. How much of the Hausgeld is recoverable (`WEG_RECOVERABLE` vs `WEG_NON_RECOVERABLE`) is only known from the annual WEG settlement, not when it is paid. The split categories exist; the workflow "book against the Wirtschaftsplan now, correct with the Jahresabrechnung" is not specified yet (`VERIFY`, docs/germany/weg.md).

**What worked without friction:** UTF-8 with BOM and umlauts, CRLF, decimal comma, German dates, newest-first order, signed amounts → direction, the second import of the same file, and the empty `needs_review` list on a first import.

### Follow-ups
- F1: ADR-043 (D with C); implementation VC-1-12 (#106).
- F2: account IBAN check on import (#107, VC-1-13).
- F3: mapping presets per bank (#108, VC-1-14: preset `vr-banking`).
- F4: counterparty in the Transaction reads (#109).

### Second export (Volksbank, CSV)

**Input:** one real export of a Volksbank checking account, 14 rows from August to October 2026, all outflows: three monthly rent payments by standing order (the account holder paying rent) and other private payments. Same layout as the BBBank export (both banks use the same banking platform) plus one column, `Kategorie` (the bank's own spending category).

**Results:**
- The step-1 mapping works unchanged: 14 rows parsed, no errors; dates, amounts, directions, umlauts correct; value date before or after the booking date (two rows) kept as given; multiple spaces in the description collapsed.
- **F6 — Exports can be filtered (decided).** The balance chain breaks at 10 of 13 steps: the export holds selected rows, not every booking. Under the first draft of ADR-043 such a file would have lost the balance identity entirely. Decided: a break is only reported; ADR-043 and `data-model.md` §70.6 amended before merge.
- **F7 — These rent payments are outflows (information).** The rent reconciliation (Phase 4) matches **incoming** rent against MRE rent terms and refuses an outflow (`TRANSACTION_NOT_INFLOW`). Rent the landlord pays for their own home is a private outflow and out of scope; step 3 needs rent **received** from a tenant.
- F3 gets a second data point: one preset can serve both banks.

## Step 2: loan schedule (part 1 done)

**Input:** the account details of one real annuity loan (BBBank, a "Schnelltilger" product, paid out, no repayment yet): principal, nominal rate fixed for ten years, monthly payment, a yearly special-repayment allowance, and the date of the first payment. No bank amortization plan and no payments yet. Amounts stay out of this note.

**How:** `POST /loans`, `POST /loans/{id}/terms` (`ANNUITY`, `interestRate`, `scheduledPayment`, `firstPaymentDate`, `fixedRateUntil`, `initialRepaymentRate`, `specialRepaymentLimit`), `GET /loans/{id}/schedule`, through the API as `main.ts` wires it. All fields of the bank's page have a place in the terms; nothing was refused.

**Results:**
- The first twelve rows of the plan match an independent calculation (Python, `Decimal`, 30/360, half-up to the cent) exactly, and so does the whole plan (payments, total interest, last payment).
- Plausibility: the first payment splits into interest and principal such that the principal share is exactly the contract's initial repayment rate (7.5 % p.a.). The payment on the bank page is consistent with principal and rate.

**Findings:**
- **F8 — The plan runs past the end of the fixed-rate period (medium).** `fixedRateUntil` is informational only (§41.2), so the plan simply continues at the same rate until paid off, months after the fixed period ends. What a landlord plans with is the balance at the end of the fixed period (Restschuld nach Zinsbindung): it is in the plan as the `balanceAfter` of the last payment before `fixedRateUntil`, but nowhere stated. **Done** (#119, VC-3-09): `summary.fixedRateEnd = { date, balance }` in the schedule, and the same figure in the remaining-debt read; for the real loan it matches the independent calculation to the cent.
- **F9 — The first interest period is always a full month (verify).** The plan charges interest for a whole month on the first payment, whatever the payout date. Banks often charge pro-rata interest for a payout within the month (Teilzinsen), either inside the first payment or as a separate debit. Open until the bank's plan or the first debits are there (#121).
- The special-repayment allowance is stored but not used, as specified: special repayments are actual cash (`LOAN_PRINCIPAL` splits), and the remaining-debt read shows their effect against the plan (§41.6).

### Follow-ups
- F8: balance at the end of the fixed-rate period (#119, VC-3-09: `summary.fixedRateEnd`).
- F9: verify the first interest period against the bank (#121).

**Still open (part 2):** the comparison with the bank's own plan to the cent, once the bank's amortization plan or the first debits (from the checking account already exported in step 1) are available; then F9 is settled.

## Step 3: rent reconciliation (done)

**Input:** one export of the BBBank checking account from step 1, filtered to rent received: 6 inflows from May to October 2026, one standing order from one tenant for one flat, each the same amount of base rent plus operating-cost advance. The booking day is the 1st, or the next business day (2 of 6: a weekend, a public holiday). The purpose text names the month and the two parts of the amount. The running balance chains without a break.

**How:**
- PostgreSQL and the API as `main.ts` wires them. MRE is the fake of the test suite, since no Docker daemon was available. It holds one Tenant with the six monthly terms, each due the same amount as the transfer (`totalWithoutBalanceAmount`).
- Import: `generic-csv` v2 with preset `vr-banking` into an account with the file's IBAN, imported twice.
- Then for each Transaction: `PUT …/splits` (`RENT_BASE` + `RENT_OPERATING_COST_ADVANCE`, as the purpose text states), and `confirm`.
- Then `POST /rent-reconciliations/suggest` for May–October, `confirm` of each suggestion, and the coverage read per term.
- A second run used the same file with every booking moved to the 28th of the month before. This simulates a tenant who pays early; the change was made in memory only.

**Results:**
- Import: 6 created, 0 `needs_review`, 0 errors. The account IBAN check passed, and the continuity report says `NEWEST_FIRST`, no breaks, `NO_EARLIER_BALANCE`. The second import gave 6 duplicates (F1/ADR-043 holds for a clean chain too).
- Suggestions: **6 of 6 correct** (`MEDIUM`, `EXACT_AMOUNT`). The two bookings shifted to the 3rd and 4th still fall into the window (from the 15th of the month before). After confirming, every term is `MATCHED` with an open amount of 0, and a second suggest run writes nothing (idempotent).
- Suggest finds nothing before the split (no rent cash) and nothing before `confirm` (not counted cash), as P4-D3 says. Neither run says why.

**Findings:**
- **F10 — A tenant who pays before the month gets no suggestion at all (high).**
  - With every booking on the 28th of the month before, suggest finds **0 of 6**, on every run.
  - Each transfer falls into the windows of two terms (its own and the month before). Each term has two candidates of the same amount, so no pair is unique (P4-D4).
  - The IBAN history cannot decide, because both terms belong to the same Tenant.
  - Matching one by hand does not unlock the rest: the next term still has two candidates.
  - Paying a few days early by standing order is common ("bis zum 3. Werktag" invites it).
  - The purpose text names the month (`Miete 10.2026`) and goes unused.
  - Proposals:
    - assign in order: per Tenant and IBAN, the oldest open term to the oldest unmatched candidate, when the amounts fit one to one;
    - or read a month (`MM.YYYY`, `MM/YYYY`, a month name) from the purpose text as a tie-breaker.
- **F11 — Splitting and confirming by hand before any suggestion (medium).**
  - Every rent payment needs two writes (`PUT …/splits`, `confirm`) before suggest sees it. A run without them silently returns nothing.
  - The split always repeats MRE's own breakdown of the term (rent, charges).
  - Proposals:
    - a split proposal for a rent payment from the MRE term, as `payment-proposal` does for loans (§41.5);
    - and a hint in the suggest response: the count of inflows skipped as unsplit or unconfirmed.

### Follow-ups
- F10 and F11: to be decided (issues on request).
