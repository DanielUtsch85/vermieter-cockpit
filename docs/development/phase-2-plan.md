# Phase 2 Plan — Party, Ownership & Acquisition

**Status:** Proposal (accepted by review of the PR that adds it)
**Roadmap:** `docs/roadmap.md` Phase 2 · **Backlog:** `backlog.md` §3a (VC-2-xx)

Phase 2 is modelled conceptually (data-model §7–8, §12–15; ADR-009–012), but the API is mostly a list of routes
(api-design §19–21, §25–28), and the documents leave several points open or contradict each other. This plan
fixes those points **before** the items are specified, so each item's spec PR (like §35 for VC-1-11) only has to
write out the contract. Each decision below names what it resolves and where the documents change when the
item that needs it is specified. Nothing here is legal advice; German tax rules stay with `docs/germany/*` and
remain `VERIFY`-gated for Phases 7–8.

---

# 1. Decisions

### P2-D1 Party: minimal shared identity (resolves MRE-OPEN-001, DM-OPEN-003)

- DE stores a Party as **minimal identity**: `partyType` (`PERSON` | `ORGANIZATION`), `displayName`, and the
  optional contact fields of data-model §7.3–7.4. MRE data is **not synchronised** into a Party; a Party is linked
  to MRE only by explicit external references (P2-D2).
- `status`: `ACTIVE` | `INACTIVE`. `deactivate` keeps every historical relationship (§7.7); an inactive Party
  cannot get new Ownerships or become a new buyer.
- Duplicate people are prevented by review, not by matching rules: DE never merges Parties automatically.
- The stale "subject to ADR-OPEN-003" in data-model §7.6 is removed (resolved by ADR-002A/009).

### P2-D2 One external-reference endpoint (resolves the §19 / §20 overlap)

- `POST /parties/{id}/external-references` is the only command. §20 (`mre-mappings`) becomes its MRE form, not a
  second endpoint.
- Phase 2 supports `system = MRE`, `entityType = tenant` only. The Realm field is **`mreRealmId`** everywhere
  (as PropertyReference); data-model §8 and mre-integration §11 are renamed.
- The MRE Tenant must exist in the caller's Realm (checked against MRE like VC-1-01, `404` otherwise).
- `(system, mreRealmId, entityType, externalId)` is **unique among active references**: it resolves to at most
  one Party (§8 invariant made strict); a second Party claiming it is `409`. A Party may hold many references
  (one person, several MRE Tenant records over time, mre-integration §11).
- Owners and landlords have no MRE mapping in Phase 2 (only tenants exist in MRE as people).

### P2-D3 Ownership share as an exact fraction (resolves data-model §6.2, api-design §87)

- A share is a **fraction** `numerator/denominator` (positive integers, `numerator ≤ denominator`,
  denominator ≤ 10 000), as written in the Grundbuch (`1/2`, `1/3`, `7/10`). JSON: `"share": "1/3"`.
- Sums are exact (rational arithmetic), so three owners of `1/3` are exactly complete; a decimal like `0.3333`
  never is. Reports may show a rounded percentage; it is never stored.
- api-design §87 keeps decimal strings for **percentages** elsewhere (e.g. loan allocation, ADR-038); ownership
  shares are the stated exception.

### P2-D4 Ownership records, periods and completeness (resolves data-model §12.2/§12.4, BR-OWN-003/004, API §26)

- An Ownership is a period: `validFrom` and an optional `validUntil`, both **inclusive** business dates
  (data-model §78: the next period starts the day after). No `status` field; "current" is derived from the dates.
  History is never edited: a mistake is fixed by closing and re-creating with a reason (AuditRecord), not by
  updating `share` or `validFrom` in place.
- Enforced on every write, for each day of the new or changed period:
  - the same Party never has two overlapping Ownerships of the same PropertyReference;
  - the shares of all Ownerships of the PropertyReference sum to **at most 1**
    (`422 OWNERSHIP_TOTAL_EXCEEDS_ONE`, api-design §90 renamed).
- **Completeness is derived, not stored:** on a date, the ownership of a PropertyReference is `COMPLETE` when the
  shares sum to exactly 1, `INCOMPLETE` when below (domain-model §11: never silently 100 %), `NONE` without
  records. Reads return it; Acquisition confirmation (P2-D8) requires `COMPLETE`.
- "Ownership type" (domain-model §9) and `sourceDocumentId` (API §26) are dropped from Phase 2; evidence is
  `sourceReferences` (data-model §12.3). Documents come later.

### P2-D5 Ownership change is one atomic command (resolves API §25 `ownership-changes`)

- `POST /property-references/{id}/ownership-changes` `{ effectiveDate, reason, close: [ownershipId…],
  create: [{ ownerPartyId, share }…] }` closes the listed Ownerships on `effectiveDate − 1` and creates the new
  ones from `effectiveDate`, in one transaction. If the ownership was `COMPLETE` the day before, it must be
  `COMPLETE` on `effectiveDate` too (a sale or inheritance moves shares, it does not lose them).
- `POST /ownerships` (first owners) and `POST /ownerships/{id}/close` stay for the simple cases.
- "Queryable over time": `GET /property-references/{id}/ownerships?asOf=YYYY-MM-DD` returns the Ownerships valid
  that day plus `completeness`; without `asOf`, the full history in `validFrom` order.

### P2-D6 Acquisition: workflow status vs. legal dates (resolves data-model §13.5 vs. WF-002 vs. API §28)

- `status`: `DRAFT` → `CONFIRMED`, and `DRAFT` | `CONFIRMED` → `CANCELLED`. A confirmed Acquisition is final
  except for cancellation; corrections after confirmation are a later item.
- The legal milestones are **dates**, not states: `contractDate` (required, the notarial contract),
  `economicTransferDate` (Übergang von Besitz, Nutzen und Lasten), `landRegistryTransferDate`. The "acquisition
  date" of UC-003 is `contractDate`; ownership and depreciation start at `economicTransferDate`
  (`germany/depreciation.md` decides the AfA start, VERIFY). data-model §13.5's states PLANNED…COMPLETED are
  replaced by these dates.

### P2-D7 Purchase price once; costs reference cash (resolves data-model §14 / §74 duplication)

- `Acquisition.purchasePrice` is the agreed price (Money, > 0). AcquisitionCost has **no** `PURCHASE_PRICE`
  category; its categories are the transaction costs (`REAL_ESTATE_TRANSFER_TAX`, `NOTARY`, `LAND_REGISTRY`,
  `BROKER`, `FINANCING_RELATED`, `OTHER`).
- Cash stays in the ledger (ADR-001): payments of the price or a cost are Transactions whose **splits** carry
  `acquisitionId` (the Phase-1 `NOT_SUPPORTED` refusal of api-design §33.2 is lifted in VC-2-06).
- The price is booked on the seeded category `ACQUISITION` (`CAPITAL_MOVEMENT`, migration 0008), which data-model §19
  does not list yet; VC-2-06 adds it there. Transaction costs use their own categories.
- An AcquisitionCost is `EXPECTED` (known, not yet paid: UC-004) or `PAID`. A paid cost links **one**
  TransactionSplit (`transactionSplitId`, unique) and its amount equals that split's amount; it never duplicates
  the cash value.

### P2-D8 Acquisition confirmation (resolves API §28, ownership link)

- Requires: purchase price; at least one buyer Party (`buyerPartyIds`, active); and the PropertyReference's
  ownership **`COMPLETE` on `economicTransferDate`** (or `contractDate` if unset), with Ownerships that carry this
  `acquisitionId` held exactly by the buyers. Acquisition never creates Ownerships itself; WF-002 creates them as
  a separate step.
- A land/building allocation is **not** required to confirm (depreciation needs it later, data-model §15).

### P2-D9 Land/building allocation as entered, versioned (resolves data-model §15 / §74 open points)

- Phase 2 records the allocation **as entered** by the user (contract figure, BMF Arbeitshilfe, appraisal or
  advisor): `totalAllocableAmount`, `landAmount`, `buildingAmount` with `land + building = total` **exactly**;
  percentages are derived, not stored (no rounding tolerance). It does **not** compute the allocable basis from
  costs: which costs enter it is a tax rule (`germany/taxation.md`, VERIFY, Phase 7).
- `method`: `PURCHASE_CONTRACT` | `BMF_TOOL` | `APPRAISAL` | `ADVISOR` | `OTHER`; `reviewState` per data-model §6.7.
- A new allocation **supersedes** the previous one (kept, with `supersededAt`); at most one is current.

### P2-D10 Owner-level allocation read (resolves the "drives owner-level allocation" exit)

- `GET /acquisitions/{id}/owner-allocation` returns, per owner, the share (P2-D3) applied on the
  allocation date and the owner's part of the purchase price, the transaction costs and — when a current
  allocation exists — land and building. Amounts use exact fractions and are rounded to cents only at the end,
  with the rounding remainder assigned to the largest share (deterministic, sums match the totals).

### P2-D11 Conventions carried over

- Creates take `Idempotency-Key` (§15), changes take `If-Match` (§16.1, version + `ETag`), every write writes an
  AuditRecord, every row is Realm-scoped by composite foreign keys, and database triggers guard the invariants
  of P2-D4 and P2-D7 the way 0009–0014 guard the ledger.

---

# 2. Items

See `backlog.md` §3a. Order: Party first (owners and buyers need it), then Ownership, then Acquisition.
