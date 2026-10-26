# Phase 3 Plan — Financing

**Status:** Proposal (accepted by review of the PR that adds it)
**Roadmap:** `docs/roadmap.md` Phase 3 · **Backlog:** `backlog.md` §3b (VC-3-xx)

Phase 3 is modelled conceptually (data-model §18, §21–25, §72; domain-model §27–29; ADR-014, ADR-015, ADR-016,
ADR-038; BR-FIN-001…009; WF-014, UC-006), but the API is a list of routes (api-design §41–46). Several points are
open or contradict each other:
- the Loan's status values;
- the schedule: stored or derived, how interest is rounded, what a refinancing does;
- the allocation: fraction or percent; a `PUT` or a history;
- how a payment reaches a Loan: a split's `loanId` (data-model §18, §72) or a reconciliation record (§25);
- how remaining debt is derived.

This plan fixes those points **before** the items are specified, as `phase-2-plan.md` did for Phase 2. Each item's
spec PR then only has to write out the contract. Each decision names what it resolves and which documents its item's
spec PR changes. Nothing here is tax or legal advice: how interest is treated for tax stays with `germany/taxation.md`
(VERIFY, Phase 7).

**Exit (roadmap Phase 3):** a shared loan allocates to properties without duplication; the interest/principal split
flows into the ledger via `TransactionSplit`; remaining debt is derived, never stored as truth.

---

# 1. Decisions

### P3-D1 Loan: one canonical contract (resolves data-model §21, BR-FIN-001/002)

- A Loan has:
  - `lenderPartyId`: a Party of the Realm, active at creation (P2-D1);
  - `borrowerPartyIds`: at least one; active Parties of the Realm. They are not checked against Ownership: a
    borrower need not be an owner, e.g. a GbR or a spouse;
  - `principalOriginal`: Money, > 0, EUR, the contract amount;
  - `startDate`: the contract date;
  - `disbursementDate`: optional; `startDate` while unset;
  - `maturityDate`, `contractNumber`, `sourceReferences`, `notes`: optional;
  - `acquisitionId`: optional, an Acquisition of the Realm that the Loan finances; informational, with no
    effect on the Acquisition.
- **Full disbursement is assumed:** `principalOriginal` is the amount owed from `disbursementDate`. In practice the
  money often goes from the lender straight to the notary or seller, so no ledger movement is required or linked.
  Staged disbursement (Teilauszahlung, construction loans) is a later item (ADR-024: common practice first).
- `status`:
  - `ACTIVE` → `CLOSED` (P3-D7);
  - `ACTIVE` → `VOID`, a recording error, only while no split references the Loan (as a cost with payments, §27.2).
  - Both are final.
- **Fixed after creation:** `principalOriginal`, `currency`, `startDate`, `disbursementDate`. A wrong one is voided
  and entered again.
- **Amendable on `ACTIVE`:** `lenderPartyId`, `borrowerPartyIds`, `maturityDate`, `contractNumber`,
  `sourceReferences`, `notes`.
- A Loan is never duplicated per property: properties come only through allocations (P3-D3).
- Docs: data-model §21 (status values, fixed fields), api-design §41–42.

### P3-D2 Terms as periods, appended, never overwritten (resolves data-model §22, api-design §43)

- **LoanTerms** is a period of conditions:
  - `validFrom`; its end is derived (the next period's `validFrom` minus one day; open for the last);
  - `interestRate`: nominal, percent p.a., an exact decimal string with at most 3 decimals, e.g. `"3.450"`;
  - `repaymentModel`;
  - `scheduledPayment`;
  - `firstPaymentDate`;
  - `principalAtStart`: optional;
  - `fixedRateUntil`, `initialRepaymentRate`, `specialRepaymentLimit`, `notes`: optional, informational.
- `repaymentModel`: `ANNUITY` (Annuitätendarlehen: a constant payment) or `INTEREST_ONLY` (endfällig: interest
  only, principal at maturity). Linear repayment (Tilgungsdarlehen) is a later item.
- **The rate is entered as on the contract**, not computed from `initialRepaymentRate`. Banks round the rate in
  their own ways, so DE does not guess a rule.
- **An annuity must repay (review on #58):** for `ANNUITY`, `scheduledPayment` must exceed the first period's
  interest on the balance at the start of the period. Otherwise principal would be ≤ 0, the balance would never fall,
  and the plan would run to the 50-year cap. Such terms are refused with
  `422 PAYMENT_DOES_NOT_COVER_INTEREST` and `details.firstInterest`.
- Periods do not overlap and are **appended**, never overwritten. A follow-up rate (Anschlussfinanzierung) with
  the same lender is a new period. The first period starts on or after `disbursementDate`.
- **Append-only:**
  - a period may only be added after the last one;
  - a wrong period is voided (it counts nowhere) only while it is the last one;
  - periods are never edited.
- **Payment frequency:** monthly only in Phase 3. Data-model §21's `paymentFrequency` is fixed to `MONTHLY`;
  quarterly is a later item.
- Docs: data-model §22, api-design §43.

### P3-D3 Allocation: one exact fraction per property, as dated sets (resolves data-model §23, api-design §44, ADR-038)

- **One basis (ADR-038):** each PropertyReference receives one **exact fraction**, a reduced `n/d` string as
  Ownership shares (P2-D3; data-model's percent is its presentation). It applies uniformly to principal, interest
  and remaining debt. `1/3` stays exact; no percent rounding.
- **Allocations are written as a whole set** that sums to exactly `1/1`. The set is valid from a date: a new set
  from `d` ends the previous one at `d − 1`. History and `asOf` reads work as for Ownership.
- A Loan is therefore never partially allocated on a day after its first set (BR-FIN-008). Before its first set
  it is **unallocated**: property-level reads answer `409 LOAN_NOT_ALLOCATED` rather than invent a basis
  (BR-FIN-007, BR-FIN-009).
- Each property appears at most once per set; each is a PropertyReference of the Realm. api-design §44's
  `PUT` becomes `POST /loans/{id}/allocations` (a new set, kept), as allocations are never overwritten.
- **Default (ADR-038, "defaulted from the financed purchase amount"):**
  - A set may be given as `basis = PURCHASE_PRICE` with one `acquisitionId` per property, instead of fractions.
  - DE then derives each fraction exactly as `price_i / Σ price`, reduced, from those Acquisitions' purchase
    prices (each `CONFIRMED` or `DRAFT`, of that property).
  - The set stores the fractions and `basis = PURCHASE_PRICE`. A manual set has `basis = MANUAL`; that is the
    override.
  - A single-property Loan is a set with `1/1`.
- Allocated amounts (principal, interest, remaining debt per property) are **derived** by VC-2-09's largest
  remainder, with ties by `propertyReferenceId`. They are never stored.
- Docs: data-model §23 (fraction, sets), api-design §44, WF-014, UC-006.

### P3-D4 Payments: the split carries `loanId` (resolves data-model §18/§25, api-design §46, BR-FIN-004/005)

- **An actual payment is ledger cash only (ADR-015, BR-FIN-003).** Its interest and principal are separate
  `TransactionSplit`s with the seeded categories `LOAN_INTEREST` and `LOAN_PRINCIPAL` (migration 0008, data-model
  §72), each carrying the Loan's `loanId`. This is the "split flows into the ledger" of the exit.
- **The split carries `loanId`, rather than a link from the Loan side as P2-D7 did for Acquisitions,** because:
  - Loan payments are recurring and are classified when imported, before confirmation, exactly where splits are
    written (`PUT /transactions/{id}/splits`);
  - an Acquisition payment is a rare, later link to an old Transaction.
  - A confirmed Transaction's splits stay frozen. Adding a forgotten `loanId` is a correction (ADR-037, §35), the
    same as any other classification fix.
  - Data-model §25's `LoanPaymentReconciliation` is dropped: the split's `loanId` is the link; schedule deviations
    are derived (P3-D5).
- **Rules for a split with `loanId`** (lifting §33.2's `NOT_SUPPORTED`):
  - the Loan is of the Realm and not `VOID`;
  - the category is `LOAN_INTEREST` or `LOAN_PRINCIPAL`, else `422 INVALID_LOAN_SPLIT`;
  - the Transaction is `OUTFLOW`, unless it is a **reversal** (`correctionRole = REVERSAL`, review on #58). A
    reversal has the opposite direction and mirrors the original's splits (§35.3, 0014), and it never counts
    (it is not current). Originals and replacements are `OUTFLOW`;
  - there is no `propertyReferenceId`: a Loan's property attribution comes only from its allocation (BR-FIN-002,
    BR-FIN-007), so it cannot be attributed twice. A `LOAN_*` split **without** `loanId` stays allowed and counts
    for no Loan.
  - **Consequence for property reports:** per-property figures (§35.3's net effect per PropertyReference, Phase 7
    tax, Phase 9 reports) must attribute splits with `loanId` through the Loan's allocation valid on their booking
    date (P3-D3). Otherwise a property's interest would be missing. VC-3-06's derived reads do exactly that and are
    the source those phases use.
- **Corrections of a payment (review on #58):**
  - a reversal **mirrors `loanId`** together with category, PropertyReference and amount. 0014's comparison
    (the multiset of mirrored splits) gains `loan_id`, so a reversal cannot drop or change it, and each Loan's
    history stays complete;
  - a replacement carries its own splits, with or without `loanId`, under the rules above. This is how a
    forgotten `loanId` is added, or a wrong Loan or a wrong interest/principal split is fixed;
  - **closing date (P3-D7):** a reversal takes the original's booking date (§35.3), so it is allowed whenever the
    original was, also after the Loan was closed. A replacement whose booking date is after `closingDate` is
    refused like any new split;
  - VC-3-05 tests both: `correct` and `reverse` of a payment with `loanId`, and the counts before and after.
- **What counts:** splits of current Transactions (§35.3: `CONFIRMED` or `RECONCILED`, and not a reversal), by
  booking date. A correction replaces them through the replacement's splits. Unconfirmed Transactions do not count.
- **Proposal, not booking:** `GET /loans/{id}/payment-proposal?transactionId=` proposes the two splits for an
  unconfirmed `OUTFLOW` Transaction:
  - the schedule's interest for the period of its booking date (P3-D5);
  - principal = amount − interest; for `INTEREST_ONLY`, interest only, any rest flagged.
  - The client applies them through the existing splits command. DE never writes splits on its own (ADR-015: the
    plan never becomes cash).
- Docs: data-model §18 (`loanId` rules), §25 (dropped), §72; api-design §33.2, §46; BR-FIN-004.

### P3-D5 Schedule: derived on read, never stored (resolves data-model §24, api-design §45, ADR-015)

- `GET /loans/{id}/schedule[?from=&to=]` derives the plan from the terms. Nothing is stored, so there is no
  `scheduleVersion` and api-design §41's `recalculate-schedule` command is dropped. The same terms always give the
  same schedule.
- **Per monthly period** from `firstPaymentDate`, on the planned balance:
  - interest = `round_half_up(balance × rate / 12)` to the cent, a 30/360 convention. A lender's own schedule
    may differ by cents; the plan is a plan, and the ledger is the truth;
  - principal = payment − interest for `ANNUITY`, never more than the balance (the last period is smaller). For
    `INTEREST_ONLY` it is 0, with the balance due on `maturityDate`.
- **Across terms periods:** the planned balance carries over, unless the new period states `principalAtStart`
  (the follow-up contract's figure, e.g. after special repayments). The schedule ends when the balance reaches
  0, at `maturityDate`, or after 50 years, whichever comes first.
- **Exact:** cents as bigint and the rate as an exact decimal; no floating point (as VC-2-09).
- Docs: data-model §24 (derived), api-design §45.

### P3-D6 Remaining debt: derived from the contract and the ledger (resolves BR-FIN-006, ADR-016)

- **Actual remaining debt on day `d`** = `principalOriginal` − Σ `LOAN_PRINCIPAL` splits with this `loanId` that
  count (P3-D4), with booking date ≤ `d`; it is 0 after a `CLOSED` date (P3-D7). It is never stored, and it is
  never taken from a bank balance (BR-FIN-006).
- **Planned remaining debt** comes from the schedule (P3-D5). The read shows both and their difference: special
  repayments, missed or late payments, cents of rounding.
- **Per property:** each amount is split by the set valid on `d` (P3-D3, largest remainder). Before the first set
  the answer is `409 LOAN_NOT_ALLOCATED`.
- **Lender statements as evidence (ADR-016):** a `LoanBalanceStatement` `{ statementDate, balance, source }` (e.g.
  the annual account statement) may be recorded. The read compares it with the actual remaining debt on that date.
  It never replaces the derived value. Statements are appended, voidable, never edited.
- Interest paid per year per property is likewise a derived read. Its tax meaning is Phase 7's (`germany/taxation.md`,
  VERIFY).
- Docs: data-model §21 (derived values), api-design §41 (reads), BR-FIN-006.

### P3-D7 Closing and refinancing (resolves api-design §41 `refinance`, UC-006's "refinancing changes the relationship")

- **`close`** takes `closingDate` and a `reason`:
  - `REPAID`: only when the actual remaining debt on `closingDate` is 0. Otherwise `409 REMAINING_DEBT_NOT_ZERO`
    with the amount.
  - `REFINANCED`: the debt was taken over by another Loan, typically lender to lender, outside the landlord's
    accounts. It names that Loan (`refinancedByLoanId`, a Loan of the Realm); the amount settled is the derived
    remaining debt on `closingDate`.
  - `OTHER`: with a note.
  - After `closingDate` the remaining debt is 0 and no split may reference the Loan with a later booking date.
- **Refinancing with another lender (Umschuldung)** is a new Loan plus closing the old one as `REFINANCED`. With the
  same lender (Anschlussfinanzierung) it is a new terms period (P3-D2). api-design §41's `refinance` command is
  dropped: the two steps already express it, and each has its own audit.
- Docs: data-model §21, api-design §41.

### P3-D8 Conventions carried over (as P2-D11)

- Creates take `Idempotency-Key` (§15), changes take `If-Match` (§16.1, version and `ETag`), and every write writes
  an AuditRecord. Every row is Realm-scoped by composite foreign keys.
- Database triggers guard the invariants:
  - P3-D2: non-overlap and append-only;
  - P3-D3: a set sums to `1/1`, and sets are appended;
  - P3-D4: the split rules;
  - P3-D7: no split after `closingDate`.
- Each trigger is written the way 0009–0014 guard the ledger, with a concurrency test under RC and RR.
- **Lock order: Transaction → Loan (review on #58).** P3-D4 writes `loanId` through the ledger's own path
  (`PUT /transactions/{id}/splits`, confirm, `correct`, `reverse`). That path locks the Transaction first (§34.2,
  §35.5), so the split guard takes the Loan **after** it. With several Loans in one Transaction it takes them in
  id order.
  - **The guard writes the Loan row** with the no-op `UPDATE … SET version = version`, as 0022 does for the
    Acquisition (lesson of #50), rather than reading it `FOR SHARE`. Under REPEATABLE READ a share lock would not
    abort a stale `close` or `void`; the write gives `40001`. The Loan's frozen-fields trigger allows that no-op.
  - **Loan writers never lock a Transaction** (void, close, terms, allocations, statements). They lock the Loan row
    and only read splits and Transactions, so no cycle can arise.
  - A `void` or `close` and a split write therefore serialise on the Loan row. Whichever waits sees the other's
    result (READ COMMITTED) or fails to serialise (REPEATABLE READ).
  - This is the reverse of §27.2's Acquisition → Transaction, because there the link is written from the
    Acquisition side.
- Reads use one `REPEATABLE READ READ ONLY` snapshot.

---

# 2. Items

See `backlog.md` §3b. The order follows the dependencies:
1. the Loan;
2. its terms and allocations;
3. the schedule, which the payment proposal needs;
4. payments;
5. remaining debt;
6. closing, which needs remaining debt;
7. ACC3.
