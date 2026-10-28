# Phase 4 Plan — Rent Reconciliation Write-Back

**Status:** Proposal (accepted by review of the PR that adds it)
**Roadmap:** `docs/roadmap.md` Phase 4 · **Backlog:** `backlog.md` §3c (VC-4-xx)

Phase 4 is modelled conceptually: ADR-004A, data-model §18A, mre-integration §14–19, §41–42 and §50, BR-MRE-005/006,
BR-RENT-001…010, DF-006. The API is a list of routes (api-design §37–40). Several points are open or would not work
against MRE as it is:
- **The statuses.** Data-model §18A suggests `UNMATCHED`, `MATCHED`, `PARTIALLY_MATCHED`, `CONFLICT` and `IGNORED`.
  Some of these describe a rent term, not a record.
- **What cash is matched:** a Transaction or a split.
- **Corrections.** What happens to a match when its Transaction is corrected.
- **Suggestions:** stored or derived, and on what evidence.
- **Payment identity (MRE-OPEN-003, API-OPEN-003).** MRE payments have no stable id.
- **Automatic or explicit write-back (MRE-OPEN-002, BR-OPEN-005).**
- **How MRE takes a payment.** The pinned baseline `479d0ad` (ADR-036) changes a payment through
  `PATCH /api/v2/rents/payment/:id/:term` (`rentmanager.js` `_updateByTerm`), and it behaves as follows:
  - The PATCH **replaces the term's whole settlement**: its payments, the settlement discount (`promo`), the extra
    charge (`extracharge`) and the description. A field left out is deleted.
  - It **writes the whole Tenant document back** (`findOneAndUpdate` with the occupant), with no version or ETag. A
    concurrent change to the same Tenant, from MRE's UI or from DE, can therefore be lost.
  - Under a VAT ratio, `promo` and `extracharge` are read with VAT and stored without it, both as floats, so a
    read-and-send-back is not exact.
  - MRE's own payment form (`PaymentTabs.js`) does the same round trip:
    - it keeps `amount`, `date` (`DD/MM/YYYY`), `type` and `reference`, and drops `description`;
    - it drops `reference` for `cash`;
    - it trims the notes' trailing newlines.

This plan fixes those points **before** the items are specified, as `phase-3-plan.md` did for Phase 3. Each item's
spec PR then only has to write out the contract.

**Exit (roadmap Phase 4):** a bank transaction can be matched to an MRE rent obligation, confirmed by a human, and
written back to MRE exactly once; MRE settlement and DE cash remain distinct records.

---

# 1. Decisions

### P4-D1 The rent obligation is MRE's term, referenced by id (resolves data-model §18A, mre-integration §13–14, BR-RENT-009)

- **MRE stays the source of the obligation** (mre-integration §14, REUSE). DE stores no rent schedule and no amount
  due. It references a term by `mreTenantId` and `mreRentTerm`:
  - `mreRentTerm` is MRE's term key `YYYYMMDDHH` as a 10-digit string, e.g. `2027010100`;
  - the MRE Tenant is the lease in MRE (mre-integration §12).
- **`RentalContractReference` is not introduced in Phase 4.** A reconciliation keeps the `mreTenantId` it was
  matched to, so a later Tenant change never reassigns it (BR-RENT-009). Transactions keep refusing
  `rentalContractReferenceId`.
- **Checked against MRE, never cached:**
  - the term is read with the caller's token through `GET /rents/tenant/:id/:term` (mre-integration §19, §47);
  - an unknown Tenant or term is `422 MRE_RENT_TERM_NOT_FOUND`;
  - MRE unavailable is `503`, and nothing is written (BR-MRE-004: the ledger itself stays available).
- **Only ids are kept.** The Tenant's name and contact data are not stored and are not logged
  (mre-integration §20.1).
- Docs: data-model §18A, mre-integration §17, §19.

### P4-D2 One record, few statuses; coverage is derived (resolves data-model §18A's statuses, BR-RENT-004/006/007)

- **A `RentPaymentReconciliation`** links one Transaction to one MRE term with a `matchedAmount`:
  - `matchedAmount`: Money, > 0, EUR;
  - `confidence` and `suggestionReason`: only on a suggestion;
  - `confirmedAt` and `confirmedBy`;
  - `notes`;
  - the write-back fields of P4-D6.
- **Status:**
  - `SUGGESTED` (P4-D4) → `CONFIRMED` or `REJECTED`;
  - a manual create is `CONFIRMED` at once (P4-D5);
  - `CONFIRMED` → `RELEASED` (P4-D7);
  - `REJECTED` and `RELEASED` are final.
- **Fixed after creation:** Realm, Transaction, `mreTenantId`, `mreRentTerm`, `matchedAmount`. A wrong match is
  released and matched again.
- **Data-model's other statuses describe a term or a Transaction, so they are derived reads (P4-D5), never stored:**
  - `UNMATCHED`, `PARTIALLY_MATCHED` and `MATCHED` are a term's coverage by DE cash;
  - the derived reads add `OVERPAID` (BR-RENT-007);
  - `CONFLICT` is not a state: matching more than the available cash is refused (P4-D3, BR-RENT-005);
  - `IGNORED` is not needed: a Transaction that is not rent has no rent split, so it is never a candidate.
- **`transactionSplitId` is dropped.** The cash matched is the Transaction's rent cash (P4-D3). A Transaction with
  rent for several terms is matched once per term, each with its `matchedAmount` (BR-RENT-008).
- **`mrePaymentFingerprint` becomes the DE marker** written into MRE (P4-D6).
- Docs: data-model §18A (fields, statuses, dropped fields), glossary.

### P4-D3 What cash can be matched (resolves BR-RENT-005, BR-RENT-008)

- **Only counted cash** (P3-D4's rule, §35.3): a Transaction that is `INFLOW`, `CONFIRMED` or `RECONCILED`, and not
  a reversal. An unconfirmed Transaction is not cash yet, and a suggestion never names one.
- **Rent cash** of a Transaction is the sum of its splits in the rent income categories:
  - `RENT_BASE`;
  - `RENT_OPERATING_COST_ADVANCE`;
  - `RENT_OPERATING_COST_SETTLEMENT`.
- A combined transfer is therefore split first, as for any other meaning (mre-integration §50). A Transaction
  without rent splits is `422 NO_RENT_CASH`.
- **Available** = rent cash − Σ `matchedAmount` of its `CONFIRMED` reconciliations. A confirm with
  `matchedAmount` > available is `409 RENT_CASH_EXCEEDED`, with `details.available`. Cash is never consumed twice
  (BR-RENT-005).
- **One `CONFIRMED` reconciliation per Transaction and term.** A second payment for the same term from the same
  Transaction would be the same match twice. Several Transactions per term are allowed, as is one Transaction over
  several terms (mre-integration §50).
- **The Transaction is never changed (ADR-004A).** Its status `RECONCILED` stays reserved and is not set by rent
  reconciliation. That status only moves forward, so a release (P4-D7) could not undo it.
- **Database-enforced:**
  - a guard checks counted, `INFLOW`, rent cash and the sum;
  - a partial unique index enforces one `CONFIRMED` reconciliation per Transaction and term.
- Docs: data-model §18A (invariants), BR-RENT-005.

### P4-D4 Suggestions: stored, deterministic, never authoritative (resolves api-design §37–38, BR-RENT-004)

- `POST /rent-reconciliations/suggest { from, to }` (whole months, at most 12) writes `SUGGESTED` records. The user
  then confirms or rejects each one. `GET /rent-reconciliations?status=SUGGESTED` lists them; `…/suggestions` of
  api-design §37 is that filter.
- **Stored rather than derived**, so that:
  - a rejection is remembered;
  - a confirmation names the suggestion it accepted;
  - both are audited.
- **The rule, deterministic and explained in `suggestionReason`:**
  - **Terms:** from MRE's `GET /rents/:year/:month` for each month of the window, with the caller's token.
  - **Open amount of a term:** MRE's amount due for the term without carried balance (`totalWithoutBalanceAmount`),
    minus the DE `matchedAmount`s already confirmed for it. MRE's own payments are not subtracted: MRE settlement
    is not cash (BR-RENT-001).
  - **Candidates:** Transactions with available rent cash (P4-D3) and a booking date from the 15th of the month
    before the term to the end of the term's month.
  - **A pair is suggested only when the available rent cash equals the open amount exactly, and the pair is
    unique:** no other candidate Transaction fits that term, and no other term fits that Transaction. When a pair
    is not unique, an earlier `CONFIRMED` reconciliation of the same MRE Tenant from the same
    `counterparty_iban_raw` decides it ("historical match pattern", api-design §38). Otherwise nothing is
    suggested and the user matches by hand.
- **Confidence:**
  - `HIGH` when the IBAN history agrees;
  - `MEDIUM` for an exact unique amount alone.
- **Never suggested by the rule:**
  - partial payments, combined payments, overpayments;
  - a pair that already has a reconciliation in any status. A rejected pair is never suggested again, and a run
    over the same window writes nothing new: suggesting is idempotent.
- **MRE unavailable is `503`, and nothing is written.**
- **A suggestion goes stale when its Transaction or term changes.** Confirm validates it again (P4-D5); a suggestion
  that no longer fits is `409 SUGGESTION_STALE`.
- Docs: api-design §37–38, BR-RENT-004.

### P4-D5 Confirm, manual match and coverage reads (resolves api-design §39, BR-RENT-006/007)

- **`POST /rent-reconciliations/{id}/confirm`** confirms a suggestion. It may lower `matchedAmount`. **`POST
  /rent-reconciliations`** matches by hand: `transactionId`, `mreTenantId`, `mreRentTerm`, `matchedAmount`.
- **Both run api-design §39's checks in this order:**
  1. the Transaction (P4-D3);
  2. the MRE term, read live (P4-D1);
  3. the amount against the available cash;
  4. no duplicate (P4-D3);
  5. the record written, with actor and time.
- **Neither calls the write-back (P4-D6).** A confirmation never implies an MRE change (BR-MRE-005, BR-RENT-002).
- **`POST /rent-reconciliations/{id}/reject`** ends a suggestion.
- **Derived reads, never stored:**
  - **Per term, `GET /rent-reconciliations/terms/{mreTenantId}/{mreRentTerm}`**, shows both sides next to each
    other and never merges them (the exit's "distinct records"):
    - MRE's amount due and MRE's own payment records, read live;
    - DE's confirmed matches and their sum;
    - the coverage `UNMATCHED`, `PARTIALLY_MATCHED`, `MATCHED` or `OVERPAID`, from DE cash against MRE's amount due.
  - **Per Transaction, `GET /transactions/{id}/rent-reconciliations`**, shows rent cash, matched and available.
    The unmatched rest stays visible until its meaning is decided (BR-RENT-007).
- Docs: api-design §39, data-model §18A, BR-RENT-006/007.

### P4-D6 Write-back: explicit, exactly once, read before write (resolves api-design §40, MRE-OPEN-002/003, BR-MRE-005/006, BR-RENT-010, BR-OPEN-005)

- **Explicit.** `POST /rent-reconciliations/{id}/write-back-to-mre` is a separate command on a `CONFIRMED`
  reconciliation. Confirmation never triggers it in Phase 4. BR-OPEN-005 is decided as "explicit"; an automatic
  write-back stays a later product decision.
- **One MRE payment per reconciliation:**
  - `amount`: the `matchedAmount` in euros. It is converted exactly from cents through its decimal text, never by
    float arithmetic;
  - `date`: the Transaction's booking date as `DD/MM/YYYY`;
  - `type`: `transfer`;
  - `reference`: the **DE marker** `DE-RPR-<reconciliationId>`.
- **The marker is DE's payment identity** (MRE-OPEN-003, API-OPEN-003): MRE payments have no stable id
  (mre-integration §41). MRE's own form keeps `reference` for a `transfer`, so the marker survives a later save in
  MRE. A stable upstream payment id stays the preferred fix (mre-integration §42).
- **The protocol.** No database transaction is open during an MRE call.
  1. **Claim** (one database transaction):
     - lock the reconciliation; it must be `CONFIRMED` with state `NOT_WRITTEN` or `FAILED`;
     - set `mreWriteBackState = PENDING` with a lease expiry, and write an AuditRecord;
     - commit.
  2. **Read** the term (`GET /rents/tenant/:id/:term`). If a payment with the marker is already there, a crashed
     earlier attempt wrote it: go to step 4 without a PATCH.
  3. **Write** with `PATCH /rents/payment/:id/:term`. **MRE takes the Tenant from the body's `_id`, not from the
     path:** `updateByTerm` never reads `req.params.id`, and `_updateByTerm` looks the Tenant up with
     `findOne({ _id: body._id, realmId })`. Without `_id` that lookup finds nothing and MRE answers `500` (review on
     #75; MRE's form sends `_id: rent._id`). The body therefore carries `_id: mreTenantId`, and the path's `:id` is
     set to the same value, though MRE ignores it. The body is the term as read, plus DE's payment:
     - every existing payment with `date`, `amount`, `type`, `reference` and `description` as read;
     - `promo` with `notepromo`, and `extracharge` with `noteextracharge`, each note trimmed of trailing newlines as
       MRE's form does;
     - `description`.
  4. **Verify.** The term in the PATCH response, or the term read in step 2, must contain the marker and every
     payment read in step 2.
  5. **Record** (one database transaction):
     - success: `WRITTEN` with `mreWriteBackAt` and a snapshot of the payment as MRE stores it;
     - failure: `FAILED` with an error code and time;
     - an AuditRecord either way.
- **Exactly once:**
  - a write-back of a `WRITTEN` reconciliation is a 200 no-op without an MRE call;
  - a retry after a failure or a crash reads before it writes (step 2), so it never adds a second payment
    (BR-MRE-006).
- **One write-back per MRE Tenant at a time.** MRE's PATCH rewrites the whole Tenant document, so two DE
  write-backs to different terms of the same Tenant would race.
  - A partial unique index allows only one `PENDING` (or `REMOVING`, P4-D7) per Realm and `mreTenantId`.
  - A second write-back is `409 WRITE_BACK_IN_PROGRESS`.
  - A lease older than twice the MRE timeout is taken over; step 2 makes that safe.
    - **By the same reconciliation:** its retry claims again.
    - **By another reconciliation of the same Tenant:** the partial unique index would block its claim. So the claim
      sets the expired row to `FAILED` (for a removal, `REMOVAL_FAILED`) with an AuditRecord, in the same statement
      that takes the new lease (review on #75). VC-4-04 tests this.
  - A PATCH that still reaches MRE after DE's timeout cannot add a second payment: the PATCH replaces the whole
    settlement, and each DE body holds the marker at most once. It could, however, restore a marker after a
    `remove-from-mre`. Waiting twice the timeout before a lease is taken over covers that.
- **Refused before any PATCH:**
  - **`409 MRE_TERM_NOT_ROUND_TRIPPABLE`** when the term has a VAT ratio and a non-zero `promo` or `extracharge`.
    Sending those back would change them by float rounding. The user records that payment in MRE by hand, and the
    reconciliation stays `NOT_WRITTEN`.
  - **`422 MRE_RENT_TERM_NOT_FOUND`** when the term no longer exists. The state becomes `FAILED`.
- **Failure keeps the match (BR-RENT-010).** The reconciliation stays `CONFIRMED`. `FAILED` is visible in every read
  and can be retried.
- **Residual risk, documented and accepted:** MRE has no version or ETag. If someone edits the same Tenant in MRE
  between DE's read and DE's PATCH:
  - their edit or DE's payment can be lost;
  - step 4 detects a lost DE payment (`FAILED`, `MRE_TERM_CHANGED`);
  - a lost MRE-side edit cannot be detected;
  - the window is one request. An upstream version field would close it (mre-integration §42–44).
- **Presence check.** `GET /rent-reconciliations/{id}?checkMre=true` reports `mrePresence`: `PRESENT` or `MISSING`,
  for a marker deleted in MRE by hand. It is a read only and never changes the state.
- **The caller's own MRE token** is used, as for every MRE call (mre-integration §47.1). The write-back is the
  human's action, under the human's MRE rights.
- Docs: api-design §40, mre-integration §17–19, §41, MRE-OPEN-002/003, API-OPEN-003, BR-MRE-005/006, BR-OPEN-005.

### P4-D7 Release and removal from MRE (resolves a correction's effect, BR-MRE-004)

- **`POST /rent-reconciliations/{id}/release`**: `CONFIRMED` → `RELEASED`. Its cash becomes available again.
  - It is **DE-only** and never calls MRE, so an MRE outage cannot block DE (BR-MRE-004).
  - A `WRITTEN` reconciliation's state becomes `REMOVAL_REQUIRED`, which is visible and open.
  - While `PENDING`, release is `409 WRITE_BACK_IN_PROGRESS`.
- **`POST /rent-reconciliations/{id}/remove-from-mre`** is P4-D6's protocol in reverse. It runs from
  `REMOVAL_REQUIRED` or `REMOVAL_FAILED`:
  - `REMOVING` with the same per-Tenant lease;
  - read; if the marker is gone, done without a PATCH;
  - a PATCH with every payment except the marker's, and the term's other fields and `_id: mreTenantId` as in P4-D6;
  - verify;
  - `REMOVED` or `REMOVAL_FAILED`.
  - It never removes a payment without DE's marker.
- **A correction or reversal of a Transaction with a `CONFIRMED` reconciliation is `409 TRANSACTION_RENT_RECONCILED`**,
  with the reconciliation ids. The user releases first, so the match never silently points at cash that no longer
  counts (ADR-004A: neither side rewrites the other silently). Release needs no MRE, so the ledger's correction
  (ADR-037) stays possible during an MRE outage. This is database-enforced in the correction path.
- Docs: api-design §35 (the new refusal), §40, data-model §18A.

### P4-D8 Conventions carried over (as P3-D8)

- Creates take `Idempotency-Key` (§15), changes take `If-Match` (§16.1), and every write writes an AuditRecord,
  including each write-back attempt's start and outcome. Every row is Realm-scoped by composite foreign keys, also
  to the Transaction.
- **Lock order: Transaction → reconciliation.**
  - Confirm, manual create and release take the Transaction row first, with the no-op
    `UPDATE … SET version = version` of P3-D8. Under REPEATABLE READ a stale confirm then fails with `40001`
    against a concurrent correction or a concurrent confirm on the same cash.
  - The correction path already holds the Transaction when its guard reads the reconciliations.
  - The write-back's claim and record lock only the reconciliation row and never a Transaction.
  - Each guard gets a concurrency test under RC and RR.
- **MRE calls never run inside a database transaction.** Reads use one `REPEATABLE READ READ ONLY` snapshot for the
  DE side.
- **The MRE client gains three calls**, each parsed to the fields DE needs and pinned by the contract suite against
  the baseline (`mre.contract.test.ts`):
  - the term read;
  - the month read;
  - the PATCH, with the Tenant in the body's `_id`.
- **The fake MRE gains Tenants with rent terms and the PATCH semantics above:**
  - it replaces the whole settlement;
  - it takes the Tenant from the body's `_id` and ignores the path's `:id`;
  - a missing `_id`, or one of another Realm, answers `500`, as at the baseline. A fake that used the path's `:id`
    would hide a missing `_id`.

---

# 2. Items

See `backlog.md` §3c. The order follows the dependencies:
1. the record with manual match, release and the ledger rules, which the rest needs;
2. the coverage reads;
3. suggestions;
4. write-back;
5. removal after release;
6. ACC4.
