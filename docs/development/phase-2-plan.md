# Phase 2 Plan — Party, Ownership & Acquisition

**Status:** Proposal (accepted by review of the PR that adds it)
**Roadmap:** `docs/roadmap.md` Phase 2 · **Backlog:** `backlog.md` §3a (VC-2-xx)

Phase 2 is modelled conceptually (data-model §7–8, §12–15; ADR-009–012), but the API is mostly a list of routes
(api-design §19–21, §25–28), and the documents leave several points open or contradict each other. This plan
fixes those points **before** the items are specified, so each item's spec PR (like §35 for VC-1-11) only has to
write out the contract. Each decision names what it resolves and which documents its item's spec PR changes.
Nothing here is legal advice; German tax rules stay with `docs/germany/*` and remain `VERIFY`-gated for Phases 7–8.

---

# 1. Decisions

### P2-D1 Party: minimal shared identity (resolves MRE-OPEN-001, DM-OPEN-003)

- DE stores a Party as **minimal identity**: `partyType` (`PERSON` | `ORGANIZATION`), `displayName`, and the
  optional contact fields of data-model §7.3–7.4. MRE data is **not synchronised** into a Party; a Party is linked
  to MRE only by explicit external references (P2-D2).
- `status`: `ACTIVE` | `INACTIVE`. `deactivate` keeps every historical relationship (§7.7). An inactive Party
  gets **no new** Ownership, buyer role or reference; everything that ends or corrects an existing relationship
  stays allowed (closing its Ownership, e.g. on inheritance, P2-D5; voiding, P2-D4).
- Duplicate people are prevented by review, not by matching rules: DE never merges Parties automatically.
- Docs: data-model §7 (status values; the stale "subject to ADR-OPEN-003" in §7.6 goes, resolved by ADR-002A/009).

### P2-D2 One external-reference endpoint (resolves the §19 / §20 overlap)

- `POST /parties/{id}/external-references` is the only command; §20 (`mre-mappings`) becomes its MRE form, not a
  second endpoint. A reference is ended with `POST …/external-references/{refId}/end` (kept, with `endedAt`).
- Phase 2 supports `system = MRE`, `entityType = tenant` only. The Realm field is **`mreRealmId`** everywhere (as
  PropertyReference).
- The MRE Tenant must exist in the caller's Realm (checked against MRE like VC-1-01, `404` otherwise).
- **Active** means not ended (a status, not a period: data-model §8's `validFrom`/`validUntil` are dropped for
  Phase 2). `(system, mreRealmId, entityType, externalId)` is **unique among active references**, so it resolves to
  at most one Party (§8 invariant made strict); a second Party claiming it is `409`. A Party may hold many
  references (one person, several MRE Tenant records over time, mre-integration §11).
- Owners and landlords have no MRE mapping in Phase 2 (only tenants exist in MRE as people).
- Docs: data-model §8, mre-integration §11, api-design §19–20.

### P2-D3 Ownership share as an exact fraction (resolves data-model §6.2, api-design §87)

- A share is a **fraction** `numerator/denominator` (positive integers, `numerator ≤ denominator`,
  denominator ≤ 10 000), as written in the Grundbuch (`1/2`, `1/3`, `7/10`). JSON: `"share": "1/3"`.
- Input may be unreduced; it is **stored and returned reduced** (`"2/4"` → `"1/2"`), and idempotency fingerprints
  and equality compare the reduced form.
- Sums are exact: three owners of `1/3` are exactly complete; a decimal like `0.3333` never is. In SQL, sums and
  comparisons use `numeric` (cross-multiplication or `numerator::numeric / denominator` compared exactly), never
  `bigint` least common multiples, which overflow with several coprime denominators. Reports may show a rounded
  percentage; it is never stored.
- api-design §87 keeps decimal strings for **percentages** elsewhere (e.g. loan allocation, ADR-038); ownership
  shares are the stated exception.
- Docs: data-model §6.2 (share no longer a `Percentage`), §12, §78 (`50%` → `1/2`); api-design §26 example
  (`"0.50"` → `"1/2"`), §87.

### P2-D4 Ownership records, periods, voiding and completeness (resolves data-model §12.2/§12.4, BR-OWN-003/004, API §26)

- An Ownership is a period: `validFrom` and an optional `validUntil`, both **inclusive** business dates
  (data-model §78: the next period starts the day after). `share`, `ownerPartyId` and `validFrom` never change.
- Two ways a period ends, kept apart (review on this plan, F1):
  - **close** — a real change (sale, inheritance, transfer; BR-OWN-005): sets `validUntil`. History stays as it was.
  - **void** — a recording error ("1/3 entered instead of 1/2"): `POST /ownerships/{id}/void { reason }` sets
    `status = VOID`. The record is kept for audit (AuditRecord with the reason) but counts in **no** sum, `asOf`
    read or overlap check, so reports never see it; the correct record is then created with the original dates.
    An Ownership referenced by a `CONFIRMED` Acquisition (P2-D8) cannot be voided (`409`).
  - So `status` is `VALID` | `VOID` (data-model §12.2's `status`, now defined); it does not mark drafts. BR-OWN-004's
    "confirmed" Ownership means a `VALID` one.
- Enforced on every write, for each day of the new or changed period, over `VALID` records:
  - the same Party never has two overlapping Ownerships of the same PropertyReference;
  - the shares of all Ownerships of the PropertyReference sum to **at most 1**
    (`422 OWNERSHIP_TOTAL_EXCEEDS_ONE`, api-design §90 renamed).
- **Serialisation (F5):** both checks run in a database trigger that first **writes the PropertyReference row**
  (a no-op update, as the split trigger touches its Transaction in 0010). Two writers of the same PropertyReference
  therefore serialise: under READ COMMITTED the second waits and its trigger then sees the first one's rows; under
  REPEATABLE READ it fails with a serialisation error instead of committing Σ > 1. A lock alone (`FOR UPDATE`)
  would not do under REPEATABLE READ, whose snapshot predates the lock. VC-2-03 gets a two-connection test for
  both isolation levels (two concurrent `1/2` on a PropertyReference already holding `1/2`: exactly one commits).
- **Completeness is derived, not stored:** on a date, the ownership of a PropertyReference is `COMPLETE` when the
  `VALID` shares sum to exactly 1, `INCOMPLETE` when below (domain-model §11: never silently 100 %), `NONE`
  without records. Reads return it; Acquisition confirmation (P2-D8) requires `COMPLETE`.
- "Ownership type" (domain-model §9) and `sourceDocumentId` (API §26) are dropped from Phase 2; evidence is
  `sourceReferences` (data-model §12.3). Documents come later.
- Docs: data-model §12, §78; api-design §25–26, §90; business-rules BR-OWN-003/004 wording.

### P2-D5 Ownership change is one atomic command (resolves API §25 `ownership-changes`)

- `POST /property-references/{id}/ownership-changes` `{ effectiveDate, reason, close: [ownershipId…],
  create: [{ ownerPartyId, share }…] }` closes the listed Ownerships on `effectiveDate − 1` and creates the new
  ones from `effectiveDate`, in one transaction. If the ownership was `COMPLETE` the day before, it must be
  `COMPLETE` on `effectiveDate` too (a sale or inheritance moves shares, it does not lose them).
- Each listed Ownership must be `VALID`, belong to **this** PropertyReference (Realm-scoped), start **before**
  `effectiveDate` and still be valid on `effectiveDate − 1`. Otherwise the whole command is `422 INVALID_OWNERSHIP`
  with `details.ownershipId` and `details.reason` = `NOT_FOUND` (unknown, other Realm or other PropertyReference),
  `VOID`, `STARTS_ON_OR_AFTER_EFFECTIVE_DATE` (closing would give `validUntil < validFrom`) or `ALREADY_ENDED`
  (`validUntil < effectiveDate − 1`; history is never moved). Nothing is written.
- An Ownership with a later planned end (`validUntil ≥ effectiveDate`) is shortened to `effectiveDate − 1`.
- Owners being closed may be **inactive** Parties (inheritance); new owners must be active (`422 PARTY_INACTIVE`).
- `POST /ownerships` (first owners) and `POST /ownerships/{id}/close { validUntil }` cover the simple cases with the
  same rules.
- "Queryable over time": `GET /property-references/{id}/ownerships?asOf=YYYY-MM-DD` returns the `VALID` Ownerships
  of that day plus `completeness`; without `asOf`, the full history (`VOID` included, marked) in `validFrom` order.
- Docs: api-design §25–26.

### P2-D6 Acquisition: workflow status vs. legal dates (resolves data-model §13.5 vs. WF-002 vs. API §28)

- `status`: `DRAFT` → `CONFIRMED`, and `DRAFT` → `CANCELLED`. A **confirmed Acquisition is final** in Phase 2: it
  cannot be cancelled or changed (corrections after confirmation are a later item). Its costs and payment links
  (P2-D7) and its land/building allocation (P2-D9) stay writable on a `CONFIRMED` Acquisition, since invoices, the tax assessment and their payments come
  after the transfer; only `CANCELLED` closes them (review on #48). Cancelling a draft keeps its
  costs and payment links (P2-D7) readable for audit, but they count **nowhere** any more, like unlinked ones
  (neither in a cost's paid state nor in a Transaction's Σ links), so the payment can be linked to a new
  Acquisition; Ownerships are never touched by an Acquisition.
- The legal milestones are **dates**, not states: `contractDate` (required, the notarial contract),
  `economicTransferDate` (Übergang von Besitz, Nutzen und Lasten; data-model §13.3's `possessionTransferDate` is
  **merged into it**), `landRegistryTransferDate`.
- The **transfer date** of an Acquisition is `economicTransferDate`, or `contractDate` while that is unset; P2-D8
  and P2-D10 use it. UC-003's "acquisition date" is `contractDate`. When depreciation starts is
  `germany/depreciation.md`'s rule (VERIFY), not this plan's.
- Docs: data-model §13 (§13.3 dates, §13.5 lifecycle replaced); api-design §27–28; workflows WF-002.

### P2-D7 Purchase price once; payments link Transactions, not splits (resolves data-model §14 / §74; review F2)

- `Acquisition.purchasePrice` is the agreed price (Money, > 0). AcquisitionCost has **no** `PURCHASE_PRICE`
  category; its categories are the transaction costs (`REAL_ESTATE_TRANSFER_TAX`, `NOTARY`, `LAND_REGISTRY`,
  `BROKER`, `FINANCING_RELATED`, `OTHER`), each with its own expected `amount`.
- **One link, from the acquisition side.** Cash stays in the ledger untouched (ADR-001, ADR-037): a payment is an
  `AcquisitionPayment { acquisitionId, acquisitionCostId | null, transactionId, amount }` — `null` cost = a payment
  of the purchase price. There is **no** `acquisitionId` on splits: the §33.2 `NOT_SUPPORTED` refusal stays and its
  reason changes, and data-model §14's `transactionSplitId` is replaced by these links. This needs no change to the
  ledger, works for Transactions confirmed long before (no correction just to tag them) and keeps one source of
  truth.
- A payment links a **current** Transaction (§35.3: `CONFIRMED`/`RECONCILED`, not a reversal) of the same Realm with
  `OUTFLOW` direction; `amount > 0`. The live payments (not unlinked, Acquisition not `CANCELLED`) linked to one
  Transaction sum to at most its amount (a database
  trigger that writes the Transaction's row first, as P2-D4). Split categories are not checked: the link is the
  interpretation (domain-model §13), the split the cash classification.
- **Installments:** a cost or the price may have several payments. A cost's paid state is **derived**: `EXPECTED`
  (no payments), `PARTIALLY_PAID` (sum below `amount`), `PAID` (sum equals `amount`); a sum above `amount` is refused.
- **Ledger corrections:** a linked Transaction can still be corrected or reversed; the ledger does not know about
  acquisitions. A payment whose Transaction is no longer current stops counting (the cost falls back to
  `PARTIALLY_PAID`/`EXPECTED`), and the read marks it `TRANSACTION_CORRECTED` with the Transaction's
  `replacementTransactionId`; the user re-links explicitly (`POST …/payments`, `POST …/payments/{id}/unlink`).
  Nothing is moved silently.
- The price is booked on the seeded category `ACQUISITION` (`CAPITAL_MOVEMENT`, migration 0008), which data-model §19
  does not list yet; VC-2-06 adds it there. Transaction costs use their own categories.
- Costs and payments are written on `DRAFT` and `CONFIRMED` Acquisitions alike (P2-D6); a voided cost or an unlinked
  payment changes VC-2-09's allocation, which is derived and never stored.
- Docs: data-model §14 (links, statuses), §18–19; api-design §27, §33.2 (refusal reason); domain-model §13.

### P2-D8 Acquisition confirmation; partial acquisitions (resolves API §28; review F3)

- An Acquisition acquires a **share** of the PropertyReference: `acquiredShare` (fraction, P2-D3; default `1/1`).
  "B buys A's half" is an Acquisition with `acquiredShare = 1/2`, buyer B.
- Confirmation requires:
  - purchase price; at least one buyer Party, all active (`buyerPartyIds`);
  - the `VALID` Ownerships that carry **this** `acquisitionId` start on the transfer date (P2-D6), are held only by
    buyers, every buyer holds one, and their shares sum to exactly `acquiredShare`;
  - the PropertyReference's ownership is `COMPLETE` on the transfer date (P2-D4) — all owners, including those not
    part of this Acquisition.
- Acquisition never creates Ownerships itself; WF-002 creates them (`POST /ownerships` or `ownership-changes` with
  `acquisitionId`). A land/building allocation is **not** required to confirm (depreciation needs it later).
- Docs: data-model §13 (`acquiredShare`), §12 (`acquisitionId`); api-design §28; WF-002.

### P2-D9 Land/building allocation as entered, versioned (resolves data-model §15 / §74 open points)

- Phase 2 records the allocation **as entered** by the user (contract figure, BMF Arbeitshilfe, appraisal or
  advisor): `totalAllocableAmount`, `landAmount`, `buildingAmount` with `land + building = total` **exactly**;
  percentages are derived, not stored (no rounding tolerance). It does **not** compute the allocable basis from
  costs: which costs enter it is a tax rule (`germany/taxation.md`, VERIFY, Phase 7).
- `method`: `PURCHASE_CONTRACT` | `BMF_TOOL` | `APPRAISAL` | `ADVISOR` | `OTHER`; `reviewState` per data-model §6.7.
- A new allocation **supersedes** the previous one (kept, with `supersededAt`); at most one is current.
- Allocations are written on `DRAFT` and `CONFIRMED` Acquisitions alike, like costs and payments (P2-D6, P2-D7): an
  appraisal or the advisor often comes after the transfer. Only `CANCELLED` closes them. A new allocation on a
  confirmed Acquisition changes VC-2-09's owner-level allocation, which is derived and never stored (review on #52).
- Docs: data-model §15, §74; api-design §27.

### P2-D10 Owner-level allocation read (resolves the "drives owner-level allocation" exit; review F3, F4)

- `GET /acquisitions/{id}/owner-allocation` splits the Acquisition among **its own buyers**, not among all owners of
  the PropertyReference: the basis are the `VALID` Ownerships carrying this `acquisitionId` (P2-D8), each owner's
  weight being its share divided by `acquiredShare` (so the weights sum to exactly 1). In a partial acquisition the
  buyer carries 100 % of price and costs.
- Per owner it returns the weight and its part of: the purchase price, the transaction costs (expected amounts, by
  category and in total), and — when a current allocation exists — `totalAllocableAmount`, `landAmount` and
  `buildingAmount`.
- **Deterministic cents (F4)**, applied to each amount separately (price, each cost category, land, building):
  every owner gets `floor(amount × weight)` in cents; the remaining cents (fewer than the number of owners) go one
  each to the owners with the largest fractional remainders, ties broken by `ownerPartyId` ascending. So the parts
  are never negative and always sum to the amount.
- **Totals are derived, never distributed (review F4b):** largest remainder is not monotone in the amount (the
  Alabama paradox), so distributing a total and one of its parts separately and subtracting can give a negative
  part. Hence only the components are distributed: `totalAllocable_i = land_i + building_i` and an owner's cost
  total is the sum of that owner's category parts. All parts stay ≥ 0, every per-owner identity holds by
  construction and every column sums to its amount; a derived total may differ by at most a cent per component from
  distributing the total directly, which is intended. VC-2-09 tests the counterexample of the review (weights
  `3/7, 3/7, 1/7`, land 0.10 €, building 0.01 €: land 4/4/2 ct, building 1/0/0 ct, total 5/4/2 ct).
- Docs: data-model §61 (rule), api-design §27 (read).

### P2-D11 Conventions carried over

- Creates take `Idempotency-Key` (§15), changes take `If-Match` (§16.1, version + `ETag`), every write writes an
  AuditRecord, every row is Realm-scoped by composite foreign keys, and database triggers guard the invariants of
  P2-D4 and P2-D7 the way 0009–0014 guard the ledger, with a concurrency test per trigger.

---

# 2. Items

See `backlog.md` §3a. Order: Party first (owners and buyers need it), then Ownership, then Acquisition.
