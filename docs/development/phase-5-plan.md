# Phase 5 Plan — Security Deposit

**Status:** Proposal (accepted by review of the PR that adds it)
**Roadmap:** `docs/roadmap.md` Phase 5 · **Backlog:** `backlog.md` §3d (VC-5-xx)

Phase 5 is modelled conceptually in several places:
- ADR-013 and ADR-039;
- data-model §26 and §71;
- domain-model §30A;
- mre-integration §31;
- DF-011, WF-007, UC-020…022, BR-DEP-001…008.

The API is a list of routes (api-design §47–48). Several points are open, or would not fit what Phases 1–4 built:
- **What anchors a deposit.** Data-model §26 requires a `rentalContractReferenceId`, but that entity does not exist. P4-D1 kept the MRE Tenant as the lease and did not introduce it.
- **How cash is linked.** §47 has `link-transaction` and `return` commands. P3-D4 made the split the link for loans: a split carries `loanId`, and §46's `reconcile-payment` was dropped. Mixed rent-and-deposit payments must be split anyway (BR-DEP-006).
- **The lifecycle.** §26 suggests eight statuses: `EXPECTED`, `PARTIALLY_RECEIVED`, `RECEIVED`, `HELD`, `PARTIALLY_RETURNED`, `RETURNED`, `OFFSET`, `CLOSED`. Most describe amounts, and §26's invariants want those derived ("`receivedAmount` should be derived", "`outstandingAmount` should be derived").
- **The holding account (ADR-039).** "A purpose flag" on the generic `FinancialAccount`. `accountType = SECURITY_DEPOSIT` already exists (data-model §16) and is the obvious candidate.
- **Interest (§ 551 Abs. 3 BGB).** ADR-039 asks for a minimal flag in the MVP. What is shown, and what a linked interest credit means, is open.
- **What happens at the end.** Full repayment, partial repayment with a retained part (unpaid rent, damage), and the `OFFSET` status.
- **MRE's `guaranty` and `guarantyPayback`** (mre-integration §31, BR-DEP-007), on the Tenant at the pinned baseline `479d0ad`:
  - `guaranty` is a number, defaulted to `0` (`frontdata.js` `toOccupantData`);
  - `guarantyPayback` has no default: it is missing until MRE's terminate-lease dialog sets it;
  - both are floats. DE reads them through the Realm's Tenant list `GET /api/v2/tenants` (P5-D1): at the baseline `GET /api/v2/tenants/:id` answers `500` for an unknown or malformed id;
  - whether DE only reads them, or also writes them back like Phase 4, is open.
- **Rent reconciliation.** A tenant's deposit inflow looks like rent cash. Nothing must suggest it as rent (BR-DEP-001, ADR-013's critical rule).

This plan fixes those points **before** the items are specified, as `phase-4-plan.md` did for Phase 4. Each item's spec PR then only has to write out the contract.

**Exit (roadmap Phase 5):** a deposit's expected vs actual cash is tracked without being mistaken for rental income.

---

# 0. Input from the real-data run (#93)

`real-data-run.md` changes or confirms these points:
- **Imports are the normal path for cash (step 1).** A deposit receipt arrives as an imported Transaction like any other: the tenant's transfer, or one of three instalments (§ 551 Abs. 2 BGB). So the deposit links cash after import and split, never through its own import or a hand-typed amount. This is P5-D3.
- **The counterparty is visible (F4, #109/#111).** The Transaction reads show the payer's name and IBAN, also on corrections. That is enough to pick the right deposit by hand. A deposit **suggestion** from the tenant's IBAN history (as P4-D4 does for rent) is left out of Phase 5: three instalments per lease make it rare, and rent suggestions already use the same history.
- **The direction matters (F7).** Rent the landlord pays for their own home is a private outflow and out of scope. The same holds for a deposit the landlord paid as a tenant. Phase 5 covers deposits a landlord **holds**: receipts are inflows, repayments are outflows.
- **Overlapping exports (F1, ADR-043)** are deduplicated before any split exists, so a deposit can never count one bank booking twice through two imports.
- **Rent side (step 3, F10):** real rent inflows matched 6 of 6. But a tenant who pays before the month gets no suggestion at all (F10, #125). P5-D6 relies on the rent side, so #125 is fixed in Phase 4's code before VC-5-05 (ACC5) is closed. ACC5 then runs its rent steps with an early payment too.

---

# 1. Decisions

### P5-D1 A deposit belongs to one MRE Tenant, referenced by id (resolves data-model §26's `rentalContractReferenceId`, ADR-013's scope)

- **As P4-D1: the MRE Tenant is the lease.** A `SecurityDeposit` keeps `mreTenantId`, checked against MRE with the caller's token through the Realm's Tenant list `GET /tenants` (VC-5-01's spec: at the baseline `GET /tenants/:id` answers `500` for an unknown id, api-design §47.1):
  - an unknown Tenant is the existing `MreTenantNotFoundError`, answered `404 NOT_FOUND` with `details.externalId` (`error-answers.ts`, #100: one answer per error class). This is the same answer as for a Party's external reference, where the Tenant id is in the body too. Phase 4's `422 MRE_RENT_TERM_NOT_FOUND` is a different class, for a term, and is not reused;
  - MRE unavailable is `503`, and nothing is written.
- **`RentalContractReference` is still not introduced.** Data-model §26 and §71 change `rentalContractReferenceId` to `mreTenantId`. The 1 : 0..1 of data-model's relationship table holds per Tenant.
- **At most one deposit per Tenant that is not `VOID`** (a partial unique index). A new lease in MRE is a new Tenant, so it gets its own deposit.
- **Only ids and amounts are kept.** The Tenant's name and contact data are not stored and not logged (mre-integration §20.1). The data-model fields `tenantPartyIds`, `payerPartyId`, `sourceIban`, `destinationIban` and `documentIds` are dropped:
  - the payer and IBANs are on the linked Transactions (F4);
  - Party mappings to MRE Tenants are not built yet;
  - documents are out of scope.
- **The record:**
  - `mreTenantId`;
  - `expectedAmount` (Money, > 0, EUR; data-model's `requiredAmount`);
  - `holdingFinancialAccountId` (optional, P5-D4);
  - `interestBearing` (boolean, P5-D5);
  - `notes`, `status` (P5-D2), `version`.
  - `propertyReferenceId` is not stored. A deposit reaches its property through the Tenant, and Phase 9 attributes it when it needs to.
- **Default from MRE (BR-DEP-007).** A create without `expectedAmount` takes MRE's `guaranty`, rounded half-up to the cent, when it is > 0. MRE's default `0` counts as "not set", so it is `422 EXPECTED_AMOUNT_REQUIRED`. The value is copied once and never followed; P5-D7 compares it later.
- Docs: data-model §26 and §71, api-design §47–48, mre-integration §31.

### P5-D2 Three statuses; the lifecycle is derived (resolves data-model §26's lifecycle, BR-DEP-002/004)

- **Stored status:** `ACTIVE` ⇄ `CLOSED` (close, reopen), and `ACTIVE` → `VOID`. Nothing else is stored.
  - `VOID` is for a deposit recorded by mistake. It is refused while a split references it, as for a Loan (`loan_void_unreferenced`, §41.5).
  - `CLOSED` is P5-D8.
- **Derived from counted cash (P5-D3), on every read:**
  - `received` = Σ receipt splits;
  - `interestCredited` = Σ interest splits (P5-D5);
  - `returned` = Σ repayment splits;
  - `outstanding` = max(`expectedAmount` − `received`, 0);
  - `held` = `received` + `interestCredited` − `returned`.
- **`state`** (derived, not stored), in this order:
  - `CLOSED` when the status says so;
  - `RETURNED` when `returned` > 0 and `held` ≤ 0 (a negative `held` flags `RETURNED_EXCEEDS_HELD`, api-design §47.3);
  - `PARTIALLY_RETURNED` when `returned` > 0;
  - `RECEIVED` when `outstanding` = 0;
  - `PARTIALLY_RECEIVED` when `received` > 0;
  - else `EXPECTED`.
  - §26's `HELD` is `RECEIVED`, and `OFFSET` is a closing with a retained part (P5-D8).
- **Never refused, only shown:**
  - more received than expected (`flags: RECEIVED_EXCEEDS_EXPECTED`, e.g. a mistyped expectation);
  - more returned than held (`RETURNED_EXCEEDS_HELD`).
  - Cash is real; a deposit record does not reject it (BR-DEP-003/005).
- **`expectedAmount` can be amended** (`PATCH`, `If-Match`) while `ACTIVE`, e.g. a rent increase that raises an agreed deposit. Each change writes an AuditRecord.
- Docs: data-model §26 (statuses and invariants), BR-DEP-002/004.

### P5-D3 The split is the link (resolves api-design §47's `link-transaction` and `return`, BR-DEP-003/005/006)

- **As P3-D4:** `securityDepositId` on a split, lifting its `NOT_SUPPORTED` (§33.2's list). There is no `link-transaction` or `return` command. §47 is changed accordingly.
- **Rules for a split with `securityDepositId`:**
  - **The deposit:** of the caller's Realm, else `404`. It must not be `VOID` (`409 DEPOSIT_NOT_ACTIVE`). A `CLOSED` one takes no new links, whatever the booking date (`409 DEPOSIT_CLOSED`, P5-D8). Corrections of cash already linked are exempt (P5-D8).
  - **The category and direction:**
    - `SECURITY_DEPOSIT` on an `INFLOW` is a receipt;
    - `SECURITY_DEPOSIT` on an `OUTFLOW` is a repayment;
    - `SECURITY_DEPOSIT_INTEREST` is only allowed on an `INFLOW` (P5-D5).
    - Else `422 INVALID_SECURITY_DEPOSIT_SPLIT`. A reversal is exempt, as in §41.5: it mirrors its original and never counts.
  - **Not with `loanId` or `propertyReferenceId`:** `400 NOT_ALLOWED_WITH_SECURITY_DEPOSIT`. The deposit is not a property's income or cost (BR-DEP-001), so it is never attributed to one.
  - **Optional, as for loans:** a `SECURITY_DEPOSIT` split **without** `securityDepositId` stays allowed. It counts for no deposit, and it is still not rent (P5-D6).
- **What counts:** splits with the deposit's id on **current** Transactions (`CONFIRMED` or `RECONCILED`, not a reversal), by booking date. This is §41.5's rule; a correction replaces them through the replacement's splits.
- **Mixed transfers (BR-DEP-006):** the first month's rent plus the deposit in one transfer becomes two splits: `RENT_BASE` (and the advance) for the rent, and `SECURITY_DEPOSIT` with `securityDepositId`. Rent reconciliation sees only the rent splits (P4-D3).
- **Corrections, as §41.5:**
  - a reversal mirrors `security_deposit_id` (0014's comparison gains it);
  - a replacement's splits follow the rules above.
- **Database-enforced:**
  - a composite FK `(security_deposit_id, mre_realm_id)`;
  - a split trigger that writes the deposit row (P3-D8's no-op) and checks status, category and direction;
  - a void guard that refuses `VOID` while referenced.
- Docs: api-design §33.2, §35.3 and §47; data-model §26 relationships; BR-DEP-006.

### P5-D4 The holding account is a `SECURITY_DEPOSIT` FinancialAccount (resolves ADR-039's "purpose flag", BR-DEP-008)

- **ADR-039's purpose flag is the existing `accountType = SECURITY_DEPOSIT`.** No new column is added. A `holdingFinancialAccountId`:
  - names an account of the Realm with that type, else `422 NOT_A_SECURITY_DEPOSIT_ACCOUNT`;
  - is optional, because many landlords open the account only after the first instalment;
  - can be set or changed by `PATCH`.
- **One account may hold several deposits.** A landlord's Mietkautionskonto often pools them, so there is no uniqueness.
- **Cash outside the holding account is shown, not refused:**
  - a receipt split on a Transaction of another account flags `RECEIVED_OUTSIDE_HOLDING_ACCOUNT` with the Transaction id, e.g. the tenant paid to the Girokonto;
  - the transfer to the holding account is a `TRANSFER` pair and is **not** linked, so it is never counted twice;
  - the flag stays as evidence that the cash was moved by hand. Proving the transfer is out of scope.
  - § 551 Abs. 3 BGB's separation is a legal duty DE reminds of; it cannot enforce it.
- Docs: data-model §16 (the type's meaning), BR-DEP-008, ADR-039 (one clarifying sentence).

### P5-D5 Interest: a flag and linked credits, no interest accounting (resolves ADR-039's minimal interest flag)

- **`interestBearing`** (boolean, default `true`, as § 551 Abs. 3 BGB requires for a residential deposit) is informational, as `fixedRateUntil` is for loans.
- **Interest credited on the holding account** may be linked: a split with category `SECURITY_DEPOSIT_INTEREST` (new, seeded, `category_type = SECURITY_DEPOSIT`) and the deposit's id.
  - It adds to `held`, because the interest belongs to the tenant and is repaid with the deposit.
  - It is not added to `received` (P5-D2).
  - A pooled account's credit is split across its deposits by the user. DE does not prorate it.
- **Not in Phase 5:** computing expected interest, and its tax meaning (the tenant's capital income; the bank's withholding). That is Phase 7 and `germany/taxation.md`, `VERIFY`. A note is added to `verification-checklist.md`.
- Docs: data-model §26, the category seed, verification-checklist (new line).

### P5-D6 A deposit is never rent (resolves ADR-013's critical rule, BR-DEP-001)

- **The categories carry it.** `SECURITY_DEPOSIT` and `SECURITY_DEPOSIT_INTEREST` have `category_type = SECURITY_DEPOSIT`, never `INCOME` (0008). Phase 7's tax view will read the type, so a deposit can never become Einnahmen.
- **Rent reconciliation already excludes them.** Rent cash is only the rent categories (P4-D3), and suggestions are built on rent cash (P4-D4). VC-5-05 keeps that as an invariant:
  - a deposit split is never rent cash;
  - a deposit-only Transaction is `422 NO_RENT_CASH` on a manual match;
  - it never appears in a suggestion;
  - a counter-check that adds `SECURITY_DEPOSIT` to the rent categories must turn ACC5 red.
- **Retained parts are not rent either:** a part kept at the end (P5-D8) stays deposit cash in DE. Whether and when it becomes income (for unpaid rent or damage) is a Phase 7 question, `VERIFY`.
- Docs: invariant-suite (Phase 5 section), BR-DEP-001.

### P5-D7 MRE's `guaranty` is compared, never written (resolves api-design §47's `reconcile-with-mre`, BR-DEP-007)

- **Read only.** DE never writes `guaranty` or `guarantyPayback`:
  - they are the landlord's own operational record in MRE (mre-integration §31: RECONCILE, not WRITE-BACK);
  - MRE's tenant PATCH writes the whole Tenant document, with the risks P4's preamble lists.
- **`GET /security-deposits/{id}?checkMre=true`** (as Phase 4's `checkMre`) reads the Tenant and adds `mre: { guaranty, guarantyPayback }` (half-up to the cent). It may add two flags:
  - `EXPECTED_DIFFERS_FROM_MRE` when `guaranty` ≠ `expectedAmount`;
  - `RETURNED_DIFFERS_FROM_MRE` when the deposit is `CLOSED` and `guarantyPayback` ≠ `returned`.
  - MRE unavailable gives `mre: null` and the flag `MRE_UNAVAILABLE`, never an error: the DE side stays readable (BR-MRE-004).
- §47's `POST …/reconcile-with-mre` is dropped. A difference is fixed in MRE's UI, or by amending `expectedAmount` (P5-D2).
- **Missing or zero values** (`479d0ad`):
  - `guaranty` `0` is MRE's default and reads as `null` ("not set"), so it raises no `EXPECTED_DIFFERS_FROM_MRE`;
  - a missing `guarantyPayback` reads as `null`, never `0`, and raises no `RETURNED_DIFFERS_FROM_MRE`. The flag needs a value present on both sides.
- **The MRE client gains one call:** the Tenant read, parsed to `_id`, `guaranty` and `guarantyPayback` only (each a number or `null`). It is pinned by the contract suite, with both fields present, `guaranty` `0`, and `guarantyPayback` missing. The fake MRE gains the two fields and can omit `guarantyPayback`.
- Docs: api-design §47, mre-integration §31, §47.

### P5-D8 Closing: returned, retained, or both (resolves data-model §26's `OFFSET` and `CLOSED`, UC-022)

- **`POST /security-deposits/{id}/close`** with `closingDate` and `reason`, while `ACTIVE`. The rules hold **at the moment of closing**, on `held` as of `closingDate` (cash booked on or before it). A linked split on cash booked after `closingDate` refuses the closing (`409 CASH_AFTER_CLOSING_DATE`), so `held` at closing is all the deposit's cash:
  - `RETURNED`: `held` is 0, else `409 DEPOSIT_STILL_HELD` with `details.held`;
  - `RETAINED`: `held` is > 0, a part or all kept against claims, else `409 NOTHING_RETAINED`; `notes` is required;
  - `OTHER`: `notes` is required, `held` may be anything.
  - Open (unconfirmed) cash naming the deposit refuses the closing too (`409 UNCONFIRMED_CASH`, api-design §47.4): its confirmation would move `held` behind the closing.
  - `retainedAmount` = `held` on the closing date, derived, never typed. It is 0 for `RETURNED`.
- **After closing, no new links** (review on #123): a `CLOSED` deposit takes no new split, whatever the Transaction's booking date (`409 DEPOSIT_CLOSED`, P5-D3). This makes the closing a cut, not a date filter. Cash found later (a late statement) is linked after a reopen (below).
- **Corrections stay possible**, so that a wrong amount is never locked in:
  - a reversal mirrors its original's link, as everywhere (P5-D3);
  - a replacement may keep the link when its original had a split with the same deposit, with any amount;
  - `retainedAmount` follows them, since it is derived on read.
- **A correction can still move `held`.** It is shown, not refused, as Phase 3 shows deviations: the read flags `HELD_CHANGED_AFTER_CLOSING` with `details.heldAtClosing` and `details.held` whenever the current `held` differs from the value stored at closing. `heldAtClosing` is stored with the closing for exactly this comparison. A `RETURNED` deposit with the flag means "returned, but the books now say otherwise"; the user corrects the cash, or reopens and closes with another reason.
- **Reopen:** `POST /security-deposits/{id}/reopen` (`If-Match`) moves `CLOSED` → `ACTIVE`. It clears `closingDate`, `reason` and `heldAtClosing` and writes an AuditRecord that keeps them. Cash found after the closing is linked in between, then the deposit is closed again with the closing's checks. A wrong closing is never voided: a closed deposit usually has links.
- **Amend:** `notes` of a closed deposit may be amended (`PATCH`, `If-Match`). `closingDate` and `reason` change only through reopen and close, so their checks always run.
- Docs: data-model §26, api-design §47, UC-022.

### P5-D9 Conventions carried over (as P4-D8)

- Creates take `Idempotency-Key` (§15), changes take `If-Match` (§16.1), and every write writes an AuditRecord. Every row is Realm-scoped by composite foreign keys, also to the holding account.
- **Lock order: Transaction → SecurityDeposit**, as Transaction → Loan in §41.5:
  - split writes lock the Transaction first, then the referenced deposits in id order;
  - deposit writers (amend, close, void) lock only the deposit row and read splits;
  - each guard gets a concurrency test under RC and RR.
- **MRE calls never run inside a database transaction.** The create checks the Tenant first, then writes. Reads use one `REPEATABLE READ READ ONLY` snapshot.
- **Money:** exact `numeric`, EUR only. MRE's floats are rounded half-up to the cent once, at the client boundary.

---

# 2. Items

See `backlog.md` §3d. The order follows the dependencies:
1. **VC-5-01:** the record (create with the MRE Tenant check and the `guaranty` default, read, list, amend, void), the holding account rule, migration.
2. **VC-5-02:** `securityDepositId` on splits, the categories, the ledger rules and corrections, migration.
3. **VC-5-03:** the derived amounts, `state` and flags in the reads, and the list's filters (`state`, `mreTenantId`, `holdingFinancialAccountId`).
4. **VC-5-04:** closing and reopening (P5-D8, with `heldAtClosing` and `HELD_CHANGED_AFTER_CLOSING`) and the MRE comparison (`checkMre`, P5-D7).
5. **VC-5-05:** the Phase-5 invariant suite and ACC5:
   - expected vs received in three instalments;
   - a mixed first transfer split into rent and deposit, where only the rent is matched;
   - interest credited;
   - a partial repayment with a retained part and a closing;
   - a correction of a receipt;
   - the rent separation of P5-D6 with its counter-check;
   - its rent steps with an early payment as well (after #125).

**Out of scope for Phase 5:**
- non-cash deposits (Bürgschaft, a pledged savings book);
- the legal maximum of three monthly net rents (§ 551 Abs. 1 BGB), which needs the rent from MRE and a `VERIFY`;
- expected interest;
- a deposit suggestion from IBAN history;
- writing to MRE;
- the deposit report (`reports.md` §2.7), which is Phase 9's.
