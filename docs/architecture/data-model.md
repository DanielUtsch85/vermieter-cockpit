# Data Model

**Project:** Vermieter Cockpit DE *(working title)*  
**Version:** 0.3  
**Status:** Living Document

**MRE Integration Revision:** Aligned with `mre-integration.md`, `api-design.md`, and `domain-model.md`. Version 0.3 removes remaining pre-MRE Unit/Lease terminology and standardizes DE-side Property references.  
**Document Type:** Logical Data Model Specification

---

# 1. Purpose

This document defines the logical data model of Vermieter Cockpit DE.

It translates the approved Product Specification, Architecture Overview, Domain Model, Architecture Decisions and Glossary into implementation-oriented data structures without binding the project to a specific database technology.

The document defines:

- logical records
- canonical identifiers
- entity attributes
- required and optional fields
- lifecycle states
- relationships
- cardinalities
- temporal behavior
- invariants
- validation rules
- derived fields
- provenance requirements
- stability classifications

This document intentionally does **not** define:

- MongoDB collections
- PostgreSQL tables
- concrete indexes
- BSON representation
- SQL DDL
- TypeScript interfaces
- API payloads
- REST endpoint structures
- UI forms

Those are implementation concerns derived from this model.

---

# 2. Governing Principles

The data model is governed by the following accepted project principles.

## 2.1 Single Source of Truth

Every authoritative business fact has exactly one canonical owner.

References are preferred over duplication.

---

## 2.2 Cash-Based Financial Ledger

The Financial Ledger contains actual cash movements only.

Non-cash concepts such as AfA, unrealized appreciation and forecast interest are modeled outside the Ledger.

---

## 2.3 Transaction Splits

Economically distinct components of a cash movement are represented using Transaction Splits.

---

## 2.4 Legal Ownership as Canonical Allocation

The legal Ownership Share is the canonical owner allocation in the MVP.

All default owner allocations derive from it.

---

## 2.5 Temporal Correctness

Historical facts that change over time should use validity periods instead of destructive replacement.

---

## 2.6 Actual, Plan, Forecast and Scenario Separation

Observed reality and hypothetical values must never be stored as the same semantic type.

---

## 2.7 MRE as Operational Core

MRE remains authoritative for operational rental management.

The inspected MRE model does **not** expose the previously assumed generic `Property → Unit → Lease → Tenant` hierarchy. Instead:

- MRE `Property` is the rentable operational object.
- the concrete rental relationship is centered on MRE `Tenant`
- MRE `Lease` is primarily a reusable lease definition / term model
- rent obligations and operational payment records are embedded in the Tenant rental state

The DE Investment Layer references these MRE-owned concepts rather than duplicating them and uses explicit reconciliation where MRE operational payment state meets the canonical DE cash Ledger.

---

## 2.8 Derived Values Remain Derived

Calculated values may be cached or snapshotted, but never become independently editable source data.

---

# 3. Stability Classification

Each logical entity receives a stability classification.

| Classification | Meaning |
|---|---|
| **Stable** | Core domain concept. Structural changes require strong justification and usually an ADR. |
| **Evolving** | Concept is accepted but field-level design may still evolve during implementation. |
| **Experimental** | Early-stage concept likely to change substantially before production maturity. |

AI coding agents must treat `Stable` structures conservatively.

---

# 4. Identifier Principles

Every first-class Entity must have an internal immutable identifier.

## 4.1 Internal Identifier

Canonical form:

`id`

Requirements:

- globally unique within the platform or entity namespace
- immutable
- not semantically overloaded
- not derived from IBAN, address, MRE ID or other external data

The concrete representation is an implementation decision.

---

## 4.2 External References

External identifiers are stored separately.

Examples:

- MRE Realm identifier plus MRE entity identifier
- bank transaction identifier
- lender contract identifier
- imported statement identifier

External references must not replace the internal identifier.

---

# 5. Common Metadata

Unless explicitly excluded, authoritative entities should support common metadata.

Conceptually:

- `id`
- `createdAt`
- `createdBy`
- `updatedAt`
- `updatedBy`
- `source`
- `version`
- `status`

Not all fields need identical implementation semantics across domains.

---

# 6. Common Value Objects

The following logical Value Objects are used throughout the model.

---

## 6.1 Money

**Stability:** Stable

### Purpose

Represent a monetary amount together with currency.

### Fields

- `amount`
- `currency`

### Rules

- `currency` is mandatory.
- Monetary values must never rely on a globally implicit currency.
- Precision must be preserved according to the currency and calculation context.
- Floating-point binary arithmetic must not be used where it can introduce financial rounding errors.

---

## 6.2 Percentage

**Stability:** Stable

### Purpose

Represent rates such as:

- Ownership Share — **no longer**: since P2-D3 an Ownership share is an exact fraction (§12.2), not a Percentage
- loan interest
- depreciation rate
- scenario growth
- Loan Allocation

### Fields

- `value`

### Rules

Interface semantics must clearly define whether `5%` is represented internally as `5` or `0.05`.

The choice must be globally consistent.

---

## 6.3 DateRange

**Stability:** Stable

### Fields

- `validFrom`
- `validUntil`

### Rules

- `validFrom` is required where temporal validity matters.
- `validUntil` may be open.
- Overlapping ranges may be prohibited depending on the entity invariant.

---

## 6.4 Address

**Stability:** Evolving

### Conceptual Fields

- `street`
- `houseNumber`
- `postalCode`
- `city`
- `stateOrRegion`
- `countryCode`
- `additionalLine`

The implementation should remain internationally extensible.

---

## 6.5 IBANReference

**Stability:** Stable

### Fields

- `iban`
- `accountHolderName`
- `bankName` optional

### Rules

IBAN is an external identifier, not an internal FinancialAccount ID.

---

## 6.6 SourceReference

**Stability:** Stable

### Purpose

Describe evidence or provenance for a domain fact.

### Fields

- `sourceType`
- `sourceId`
- `description`
- `documentId` optional
- `externalReference` optional

---

## 6.7 ReviewState

**Stability:** Evolving

Recommended conceptual states:

- `UNREVIEWED`
- `SUGGESTED`
- `CONFIRMED`
- `NEEDS_REVIEW`
- `ADVISOR_CONFIRMED`

Not every domain must support every state.

---

# 7. Party

**Domain:** Shared Identity  
**Stability:** Stable  
**Aggregate Role:** Aggregate Root

## 7.1 Purpose

Represent a canonical natural person or organization interacting with the platform.

A Party may hold multiple roles without creating duplicate identities.

Examples:

- Owner
- Borrower
- Tenant
- Landlord
- Lender
- Contractor
- Tax Advisor
- WEG Administrator

---

## 7.2 Required Fields

- `id`
- `partyType`
- `displayName`
- `status`

### `partyType`

Allowed conceptual values:

- `PERSON`
- `ORGANIZATION`

Fixed once the Party exists.

### `status`

- `ACTIVE`
- `INACTIVE` — deactivated with a reason; keeps every relationship and stays correctable (`amend`), but takes no new role (P2-D1).

The Realm is part of the Party's identity scope (`mreRealmId`); a Party is never shared across Realms.

---

## 7.3 Optional Person Fields

- `firstName`
- `lastName`
- `dateOfBirth` (not accepted by the API until a use case needs it; data minimization)
- `email`
- `phone`

---

## 7.4 Optional Organization Fields

- `legalName`
- `organizationType` (values not defined yet; not accepted by the API until they are)
- `registrationNumber`
- `email`
- `phone`

---

## 7.5 Relationships

A Party may have:

- zero or more Ownership relationships
- zero or more Borrower roles
- zero or more Lender roles
- zero or more Tenant mappings
- zero or more Contractor relationships
- zero or more FinancialAccount relationships

---

## 7.6 External Identity Mapping

Party may contain external mappings.

Example:

- `system = MRE`
- `entityType = tenant`
- `externalId = ...`

The mapping strategy is decided (ADR-002A, ADR-009; P2-D2): explicit `PartyExternalReference` records (§8), never synchronised data.

---

## 7.7 Invariants

- One real person or organization should not intentionally exist as multiple active Parties. This is kept by review; DE never matches or merges Parties automatically (P2-D1).
- External system identifiers must be mapped, not used as canonical identity.
- Deactivating a Party must not destroy historical relationships.

---

# 8. PartyExternalReference

**Domain:** Shared Identity  
**Stability:** Evolving (Phase 2: `system = MRE`, `entityType = tenant` only; api-design §20.1, P2-D2)

## Required Fields

- `id`
- `partyId`
- `system`
- `entityType`
- `externalId`
- `status`: `ACTIVE` | `ENDED`

## Optional Fields

- `mreRealmId` (required for MRE references; the Party's Realm)
- `endedAt` (set exactly when `status = ENDED`)

`metadata` and the period fields `validFrom` / `validUntil` are dropped for Phase 2: "active" is a status, not a period (P2-D2). They return with a use case that needs them.

## Invariant

For MRE, `system + mreRealmId + entityType + externalId` resolves to **at most one** Party among active references (database-enforced). Ended references are kept and do not count. A Party may hold several references. Other external systems may define an equivalent stable scope.

---

# 8A. Property Reference Naming Rule

Within DE-owned entities, references to the MRE-owned rentable Property must use:

`propertyReferenceId`

or, for collections:

`propertyReferenceIds`

The raw MRE identifier is only stored inside `PropertyReference` as `mrePropertyId`.

DE entities must not use a generic `propertyId` field because that obscures whether the identifier refers to the DE reference or directly to MRE.

`UnitReference`, `unitId` and `unitIds` are not part of the MVP data model.

---

# 9. PropertyReference

**Domain:** Integration / Property Management  
**Stability:** Stable

## Purpose

Reference an MRE-owned rentable `Property` from DE Investment Layer domains without duplicating the full MRE Property.

For the initial condominium use case, the MRE Property represents the apartment itself.

## Required Fields

- `propertyReferenceId`
- `mreRealmId`
- `mrePropertyId`
- `externalReferenceState`

## Optional Fields

- `displayName`
- `cachedAddress`
- `cachedSurface`
- `externalReferences`
- `lastRefreshedAt`
- `lastObservedAt`

Cached values are non-authoritative.

`cachedSurface` is stored as an exact decimal (PostgreSQL `NUMERIC` without fixed scale), never a binary float. A refresh that no longer finds the Property in MRE sets `MISSING` and keeps the cached values (api-design §23.2).

`lastRefreshedAt` is when the cached values were last read from MRE; `lastObservedAt` is the start of the latest applied MRE lookup, whether it found the Property or not. A refresh whose lookup started no later than `lastObservedAt` is stale and discarded, so an older MRE state never overwrites a newer one.

`MRE Property.price` is rental pricing metadata and must never be interpreted as acquisition price or Market Valuation.

### Suggested `externalReferenceState`

- `ACTIVE`
- `MISSING`
- `DELETED_UPSTREAM`
- `UNRESOLVED`

Historical DE data remains valid even if the upstream MRE Property later becomes unavailable.

---

# 10. UnitReference — Deferred

**Domain:** Integration / Property Management  
**Stability:** Deferred  
**MVP:** No

The inspected MRE core does not expose a separate canonical Unit entity.

Therefore `UnitReference` is **not** a required MVP entity and must not be introduced merely to preserve the earlier abstract `Property → Unit` hierarchy.

If future multi-unit building use cases require a hierarchy above MRE Property, this should be modeled deliberately through a future `Asset` / `Building` concept and a dedicated ADR.

---

# 11. RentalContractReference

**Domain:** Integration / Property Management  
**Stability:** Stable

## Terminology Rule

MRE `Lease` is not the concrete rental-contract entity. It is a reusable Lease Definition.

DE-owned entities that need to reference the concrete MRE rental relationship use `rentalContractReferenceId`.

A generic `leaseId` must not be introduced into DE-owned MVP entities.


## Purpose

Reference the concrete rental relationship owned by MRE without pretending that MRE `Lease` alone represents the tenant contract.

The concrete relationship is primarily represented by the MRE Tenant together with its referenced MRE Lease definition.

## Required Fields

- `rentalContractReferenceId`
- `mreRealmId`
- `mreTenantId`

## Optional Fields

- `mreLeaseDefinitionId`
- `contractReference`
- `propertyReferenceIds`
- `tenantPartyIds`
- `validFrom`
- `validUntil`
- `externalReferenceState`
- `lastRefreshedAt`

## Rules

- MRE remains authoritative for operational rental-contract state.
- `mreTenantId` identifies the concrete rental relationship context.
- `mreLeaseDefinitionId` identifies the reusable MRE Lease definition where present.
- DE domains must not infer that one MRE Tenant record is permanently identical to one canonical Party.
- MRE rent terms and operational payment records are referenced or reconciled, not duplicated as canonical cash data.

---

# 12. Ownership

**Domain:** Ownership  
**Stability:** Stable  
**Aggregate Role:** Entity

## 12.1 Purpose

Represent legal ownership of the real-world Property identified in DE through a PropertyReference by a Party over a defined period.

---

## 12.2 Required Fields

- `id`
- `propertyReferenceId`
- `ownerPartyId`
- `share`: an exact fraction `n/d` (`1 ≤ n ≤ d ≤ 10000`), stored reduced (phase-2-plan P2-D3), not a `Percentage`
- `validFrom`: inclusive business date
- `status`: `VALID` | `VOID` (a recording error; counts nowhere, kept for audit; P2-D4)

---

## 12.3 Optional Fields

- `validUntil`: inclusive business date; only ever set or moved earlier (close), never extended
- `acquisitionId`: the Acquisition the Ownership results from; set at creation by WF-002 (`POST /ownerships` or `ownership-changes`), fixed afterwards; the Acquisition's confirmation checks exactly the Ownerships carrying it (P2-D8)
- `sourceReferences`: free-text evidence such as the Grundbuch entry (up to 10); documents come later
- `notes`
- `voidedAt`, `voidReason`: set exactly when `status = VOID`

"Ownership type" (domain-model §9) and `sourceDocumentId` are not part of Phase 2 (P2-D4).

---

## 12.4 Invariants

For a fully modeled Property and a given date:

- `VALID` Ownership shares sum to **at most 1** on every day (database-enforced); exactly 1 is `COMPLETE`, below is `INCOMPLETE`, none is `NONE` (derived, never stored; P2-D4)
- a Party must not have overlapping `VALID` Ownership records for the same Property
- historical records must not be overwritten when ownership changes: a close only sets or shortens `validUntil`; a recording error is voided, not edited

---

## 12.5 Derived Use

Ownership Share is the default allocation key for:

- rental income
- property expenses
- depreciation
- owner-level tax reporting
- owner-level investment reporting

No separate default economic or tax share exists in the MVP.

---

# 13. Acquisition

**Domain:** Acquisition  
**Stability:** Stable  
**Aggregate Role:** Aggregate Root

## 13.1 Purpose

Represent the economic acquisition lifecycle of the real-world Property identified in DE through a PropertyReference.

---

## 13.2 Required Fields

- `id`
- `propertyReferenceId`
- `contractDate`
- `purchasePrice`
- `status`

---

## 13.3 Optional Fields

- `economicTransferDate` (Übergang von Besitz, Nutzen und Lasten; the former `possessionTransferDate` is merged into it, P2-D6)
- `landRegistryTransferDate`
- `acquiredShare`: the share of the PropertyReference acquired, an exact fraction (default `1/1`; P2-D8)
- `sellerPartyIds`
- `buyerPartyIds` (at least one; required to create in VC-2-05)
- `notarialDocumentId` (not accepted until documents exist)
- `notes`
- `sourceReferences`

The **transfer date** is `economicTransferDate`, or `contractDate` while that is unset (P2-D6).

---

## 13.4 Relationships

An Acquisition may have:

- one PropertyReference (the Property identity stays in MRE)
- one or more Buyers
- zero or more Sellers (a seller need not be recorded as a Party)
- multiple Acquisition Costs
- multiple Loans
- one LandBuildingAllocation
- one or more Ownership records
- multiple Documents

---

## 13.5 Lifecycle (P2-D6)

- `DRAFT` → `CONFIRMED` (final in Phase 2; requirements of P2-D8, api-design §28.1; its Ownerships can then be closed but no longer voided)
- `DRAFT` → `CANCELLED` (final)

The legal milestones (contract, economic transfer, land registry) are the dates of §13.3, not states.

---

## 13.6 Invariants

- Purchase Price must be positive for a normal purchase acquisition.
- Acquisition does not replace the Property identity.
- Actual payments associated with Acquisition remain Ledger Transactions.
- Historical Acquisition data must remain auditable.

---

# 14. AcquisitionCost and AcquisitionPayment (P2-D7)

**Domain:** Acquisition / Taxation  
**Stability:** Stable

## Purpose

An AcquisitionCost is an expected transaction cost of an Acquisition; an AcquisitionPayment links part of a ledger
Transaction to a cost or to the purchase price. Contract: api-design §27.2.

---

## AcquisitionCost

- Required: `id`, `acquisitionId`, `category`, `amount` (expected, > 0), `status` (`ACTIVE` | `VOID`).
- Optional: `incurredDate`, `counterpartyPartyId`, `sourceReferences`, `notes`; `documentId` and
  `taxClassificationId` once those entities exist.
- Derived, never stored: `paidAmount` and `paymentStatus` (`EXPECTED` | `PARTIALLY_PAID` | `PAID`) from the counting
  payments.
- Categories: `REAL_ESTATE_TRANSFER_TAX`, `NOTARY`, `LAND_REGISTRY`, `BROKER`, `FINANCING_RELATED`, `OTHER`.
  There is **no** `PURCHASE_PRICE`: the price is `Acquisition.purchasePrice`, entered once. Categories must remain
  extensible.
- The former `transactionSplitId` is replaced by AcquisitionPayment.

---

## AcquisitionPayment

- Required: `id`, `acquisitionId`, `transactionId`, `amount` (> 0); `acquisitionCostId` (`null` = a payment of the
  price).
- Optional: `unlinkedAt`, `unlinkReason` (set together, once).
- The Transaction is a current one (`CONFIRMED`/`RECONCILED`, not a reversal) with direction `OUTFLOW`, of the same
  Realm and currency, when the payment is created.

---

## Invariants

- Cash is never duplicated: a cost's paid state is derived from links to Transactions, which stay in the ledger
  untouched.
- Per Transaction, the live payments (not unlinked, Acquisition not `CANCELLED`) sum to at most its amount.
- Per cost and for the price, the counting payments (live, Transaction current) sum to at most its amount.
- A payment whose Transaction is corrected stops counting and is re-linked explicitly; nothing moves silently.
- All of this is database-enforced (api-design §27.2).

---

# 15. LandBuildingAllocation

**Domain:** Depreciation / Taxation  
**Stability:** Stable

## Purpose

Represent allocation of relevant Acquisition cost between land and building.

---

## Required Fields

- `id`
- `acquisitionId`
- `totalAllocableAmount`
- `landAmount`
- `buildingAmount`
- `method`
- `effectiveDate`
- `reviewState`

---

## Optional Fields

- `landPercentage`
- `buildingPercentage`
- `sourceReferences`
- `documentIds`
- `advisorPartyId`
- `notes`

---

## Invariants

- `landAmount + buildingAmount = totalAllocableAmount`
- percentages, if persisted, must reconcile with amounts within defined rounding tolerance
- source and method must remain traceable
- only confirmed allocation should feed canonical depreciation calculations

**Phase 2 (P2-D9, api-design §27.3):** recorded as entered, never computed. `landAmount + buildingAmount = totalAllocableAmount` exactly; the percentages are derived (`landShare`, `buildingShare`), not stored. `effectiveDate` defaults to the Acquisition's transfer date. A correction is a new allocation that supersedes the current one (`supersedesId` on the new one; the old one keeps its data and gets `supersededAt`, its successor is derived); at most one is current per Acquisition. `documentIds` wait for documents; `advisorPartyId` is a Party of the Realm.

---

# 16. FinancialAccount

**Naming Note:** This entity was renamed from `Account` to `FinancialAccount` after the MRE deep dive. MRE `Account` is an authenticated application user and must never be reused for bank/cash-account semantics.

**Domain:** Financial Ledger  
**Stability:** Stable  
**Aggregate Role:** Entity

## Purpose

Represent a financial account from or to which cash movements occur.

---

## Required Fields

- `id`
- `accountType`
- `displayName`
- `currency`
- `status`

---

## Suggested FinancialAccount Types

- `BANK`
- `SECURITY_DEPOSIT`
- `LOAN_SETTLEMENT`
- `CASH`
- `OTHER`

The MVP may support a narrower subset.

---

## Optional Fields

- `iban`
- `accountHolderPartyId`
- `institutionPartyId`
- `externalReferences`
- `openedAt`
- `closedAt`

---

## Invariants

- IBAN must not be used as internal identity.
- Historical Transactions must remain valid even if an FinancialAccount is closed.

---

# 17. Transaction

**Domain:** Financial Ledger  
**Stability:** Stable  
**Aggregate Role:** Aggregate Root

## 17.1 Purpose

Represent one canonical actual cash movement.

---

## 17.2 Required Fields

- `id`
- `financialAccountId`
- `amount`
- `bookingDate`
- `currency`
- `direction`
- `provenance`
- `status`

---

## 17.3 Optional Fields

- `valueDate`
- `counterpartyPartyId`
- `counterpartyNameRaw`
- `counterpartyIbanRaw`
- `description`
- `propertyReferenceId`
- `rentalContractReferenceId`
- `externalTransactionId`
- `documentIds`
- `importBatchId`
- `correctionOfTransactionId` (with `correctionRole`, see §17.8)
- `sourceReferences`

---

## 17.4 Amount and Direction (binding, MVP)

The canonical ledger sign model is fixed for the MVP. There is no signed-Money alternative.

- `amount` is always a **non-negative** Money value.
- `direction` is **mandatory** and is one of:
  - `INFLOW`
  - `OUTFLOW`
- The cash sign is expressed **solely** by `direction`; canonical Money values are never stored signed.
- A reversal Transaction (correction per ADR-037) uses the **same non-negative `amount`** and the **opposite `direction`**.
- `currency` must be a supported currency. For Phase 1, at least **EUR with two decimal places** is supported. Amounts not representable in the currency's scale, or amounts in an unsupported currency, are **rejected — never silently rounded**.

---

## 17.5 Suggested Lifecycle

- `IMPORTED`
- `UNREVIEWED`
- `CLASSIFIED`
- `CONFIRMED`
- `RECONCILED`
- `CORRECTED`
- `IGNORED`

---

## 17.6 Provenance

Suggested values:

- `MANUAL`
- `BANK_CSV`
- `BANK_API`
- `MIGRATION`
- `CORRECTION`

---

Generated schedules, forecasts and non-cash projections must never create Ledger Transactions. System-created cash records are only valid when they represent an actual observed cash movement and retain explicit external/import provenance.

---

## 17.7 Invariants

- A Transaction represents cash movement only.
- `amount` is non-negative; the cash sign is expressed solely by `direction` (§17.4).
- Transaction currency and FinancialAccount currency must be compatible or explicit FX handling must exist. Amounts must be representable in the currency's scale, else the Transaction is rejected.
- Confirmed Transactions must have complete split coverage.

**Implementation (VC-1-08):** `confirmedAt` / `confirmedBy` record the confirmation; the immutability of confirmed Transactions and their splits (ADR-037) is enforced by database triggers, see API §34.2.
- Duplicate imported Transactions must be detected or flagged.
- Material correction must preserve traceability; a reversal uses the same amount with opposite `direction`.

---

## 17.8 Correction chain (ADR-037, VC-1-11)

Contract: API §35.

- `correctionOfTransactionId` and `correctionRole` (`REVERSAL` | `REPLACEMENT`) are both set or both empty. They are set exactly on Transactions with `provenance = CORRECTION`. The link points to a Transaction of the same Realm.
- An original has at most one reversal and one replacement. It is `CORRECTED` exactly when its reversal exists, and only from `CONFIRMED`/`RECONCILED`. The replacement is present for a correction and absent for a reversal without replacement (API §35.9). In that case it is never added later. A correction link never targets a reversal.
- A reversal has the original's account, currency, amount, booking and value date, the opposite `direction`, and mirrored splits: the same multiset of category, PropertyReference and amount (checked by the database, migration 0014). A reversal is never corrected itself.
- Reversal and replacement carry no import identity; the original keeps its own, so re-imports still deduplicate against it (§70).
- **Net effect:** per account, period (booking date), split category and split PropertyReference, the signed sum over `CONFIRMED`, `RECONCILED` and `CORRECTED` Transactions equals the signed sum over the current ones (`CONFIRMED`/`RECONCILED`, not a reversal).

---

# 18. TransactionSplit

**Domain:** Financial Ledger  
**Stability:** Stable  
**Aggregate Role:** Child Entity of Transaction

## Purpose

Represent one economically distinct component of a Transaction.

---

## Required Fields

- `id`
- `transactionId`
- `amount`
- `financialCategoryId`

---

## Optional Fields

- `propertyReferenceId`
- `rentalContractReferenceId`
- `loanId`
- `wegId`
- `maintenanceProjectId`
- `securityDepositId`
- `description`
- `taxClassificationId`
- `sourceReferences`

There is **no** `acquisitionId` on a split: an Acquisition's payments link Transactions from the acquisition side
(§14, api-design §27.2, P2-D7), and API §33.2 refuses the key for good.

---

## Invariants

For every confirmed Transaction:

`sum(TransactionSplit.amount) == Transaction.amount`

- `TransactionSplit.amount` is **non-negative**.
- Splits inherit the parent Transaction's cash `direction`; a split has **no** independent counter-direction.
- The equality is checked **exactly** on the canonical, currency-validated Money amounts. There is **no rounding tolerance** for canonical ledger values.
- Any later calculation that could introduce rounding (e.g. allocation, interest split) must round at an explicit business boundary under a documented rule; those later rules are defined in their own domains, not here.

A split belongs to exactly one Transaction.

**Implementation (VC-1-07):** table `transaction_split`, ordered by `position`. In Phase 1 the only optional reference stored is `propertyReferenceId` (plus `description`); the other references are refused until their entities exist. The category is referenced by `financialCategoryId` and addressed by its `code` in the API (§19, API §33.2).

**`loanId` (P3-D4, VC-3-05, API §41.5):** only on a `LOAN_INTEREST` or `LOAN_PRINCIPAL` split of an `OUTFLOW`
Transaction (a reversal mirrors its original's, whatever its direction), of a Loan of the same Realm that is not
`VOID`, and never together with `propertyReferenceId`: a Loan reaches its properties through its allocation (§23).
The split is the link between cash and Loan; a reversal mirrors `loanId` (0014). Database-enforced (migration 0027).

---

# 18A. RentPaymentReconciliation

**Domain:** Integration / Financial Ledger  
**Stability:** Stable  
**Aggregate Role:** Entity

## Purpose

Explicitly link canonical DE cash movements to MRE operational rent-payment state without merging the two models.

MRE payment records answer whether an operational rent obligation is considered settled. DE `Transaction` and `TransactionSplit` remain the canonical source of actual cash truth.

## Fields (phase-4-plan P4-D2, api-design §37.1)

- `id`, `mreRealmId`, `status`
- `transactionId`: the DE Transaction whose rent cash is matched (P4-D3)
- `mreTenantId`, `mreRentTerm`: MRE's term key `YYYYMMDDHH` (P4-D1)
- `matchedAmount`: Money, > 0, EUR
- `confidence`, `suggestionReason`: only on a suggestion (VC-4-03)
- `confirmedAt`, `confirmedBy`; `releasedAt`, `releasedBy`, `releaseReason`
- `notes`
- `mreWriteBackState` and its fields (VC-4-04, P4-D6)

`transactionSplitId` is dropped: the matched cash is the Transaction's rent cash, the sum of its `RENT_*` splits (P4-D3). `mrePaymentFingerprint` is replaced by the DE marker written into MRE's payment `reference` (P4-D6).

## Status Values

- `SUGGESTED` → `CONFIRMED` | `REJECTED` (VC-4-03)
- `CONFIRMED` → `RELEASED` (VC-4-01); a manual match is created `CONFIRMED`
- `REJECTED` and `RELEASED` are final

`UNMATCHED`, `PARTIALLY_MATCHED` and `MATCHED` (and `OVERPAID`) are a term's coverage by DE cash and are derived (VC-4-02), never stored. `CONFLICT` is not a state: matching beyond the available cash is refused. `IGNORED` is not needed: a Transaction without rent splits is never a candidate.

## Invariants

- A reconciliation does not create or replace a Transaction.
- The `matchedAmount`s of a Transaction's `CONFIRMED` reconciliations never exceed its rent cash (BR-RENT-005); at most one `CONFIRMED` reconciliation per Transaction and term. Database-enforced (migration 0030, api-design §37.1).
- A Transaction with a `CONFIRMED` reconciliation is not corrected or reversed until the reconciliation is released (P4-D7).
- MRE write-back is a separate, auditable operation.
- Matching suggestions may be automated; canonical confirmation must remain reviewable.
- MRE payment fingerprints are integration aids, not internal canonical identifiers.

---

# 19. FinancialCategory

**Domain:** Financial Ledger  
**Stability:** Stable

## Purpose

Represent economic classification independent from tax treatment.

---

## Required Fields

- `id`
- `code`
- `name`
- `categoryType`
- `active`

---

## Suggested Category Types

- `INCOME`
- `OPERATING_EXPENSE`
- `FINANCING`
- `CAPITAL_MOVEMENT`
- `SECURITY_DEPOSIT`
- `TRANSFER`
- `OTHER`

---

## Example Categories

- `RENT_BASE`
- `RENT_OPERATING_COST_ADVANCE`
- `LOAN_INTEREST`
- `LOAN_PRINCIPAL`
- `WEG_RECOVERABLE`
- `WEG_NON_RECOVERABLE`
- `WEG_RESERVE_CONTRIBUTION`
- `MAINTENANCE`
- `ADMINISTRATION`
- `ACQUISITION` (`CAPITAL_MOVEMENT`, seeded by migration 0008): the purchase price's cash; transaction costs use
  their own categories (P2-D7)

---

## Invariants

- Financial Category must not encode tax treatment as its primary semantic meaning.
- Category codes should be stable once used historically.

**Implementation (VC-1-07):** a global catalog in Phase 1 (no Realm), seeded by migration; see API §36.

---

# 20. ImportBatch

**Domain:** Financial Ledger  
**Stability:** Evolving

## Purpose

Group Transactions imported together from an external source.

---

## Required Fields

- `id`
- `sourceType`
- `importedAt`
- `status`

---

## Optional Fields

- `financialAccountId`
- `sourceFilename`
- `contentHash`
- `importedBy`
- `transactionCount`
- `duplicateCount`
- `needsReviewCount`
- `errorCount`
- `metadata`

## Per-Row Outcomes and Review

Each imported row resolves to exactly one outcome: `created`, `duplicate`, `needs_review`, or `error`.

Implementation (VC-1-05/06): `sourceType` is the adapter (`adapterId` + `adapterVersion`); `status` is `COMPLETED` or `NEEDS_REVIEW`; a fifth outcome `skipped` (with `skippedCount`) reports rows that move no cash (`ZERO_AMOUNT`, e.g. balance lines) — neither booked nor an error. The per-row outcomes are stored with the batch (`rows`), so `GET /imports/{id}` answers exactly what the import answered.

- `needs_review` rows are ambiguous matches (§70.4: ambiguous cross-file content matches or adapter-version conflicts). They create **no** Transaction and are recorded as **`ImportReviewItem`** child records (§20A), each with its own `id` (API name `reviewItemId`), the normalized row, the ambiguity reason, and `conflictingTransactionIds`.
- `duplicate` rows are structured by cause: a plain Transaction-identity match (`TRANSACTION`) or a re-presented identity whose review item is already resolved (`RESOLVED_REVIEW_ITEM`, §20A Ownership and Retry). The result structure is defined in API §32.1.
- A human resolves each `ImportReviewItem` (API §32.2) to `CREATE` (materialize one `IMPORTED` Transaction) or `SKIP` (discard). No Transaction exists for a `needs_review` row until its item is resolved with `CREATE`.
- `needsReviewCount` equals the number of the batch's **own** `PENDING` child items (§20A Ownership and Retry); while it is `> 0` the batch is not fully closed and its `status` reflects the open ambiguities (e.g. `NEEDS_REVIEW`).

---

# 20A. ImportReviewItem

**Domain:** Financial Ledger  
**Stability:** Evolving  
**Aggregate Role:** Child of ImportBatch

## Purpose

Represent one ambiguous cross-file import row (§70.4) that awaits a human decision. It is the canonical, addressable object behind the `needs_review` outcome and the `resolve` command; no Transaction exists for it until it is resolved with `CREATE`.

## Required Fields

- `id`  (API name: `reviewItemId`)
- `importBatchId`  (the **owning** batch; see Ownership and Retry below)
- `realm`  (Realm scope; inherited from the batch)
- `adapterId`, `adapterVersion`  (preserved identity components per §70.2)
- `normalizedRow`  (the normalized source row per §70.2–70.3: `bookingDate`, optional `valueDate`, non-negative `amount` + `direction`, `currency`, counterparty, `description`, and the source-statement + source-row identity)
- `ambiguityReason`
- `conflictingTransactionIds`  (the existing Transaction(s) it may duplicate)
- `status`  (`PENDING` | `RESOLVED`)

## Optional Fields

- `resolution`  (`CREATE` | `SKIP`; set only when `status = RESOLVED`)
- `resolvedByAccountId`  (the MRE-authenticated actor who resolved it)
- `resolvedAt`
- `createdTransactionId`  (set only when `resolution = CREATE`; the single `IMPORTED` Transaction produced)

## Invariants

- A review item belongs to exactly one `ImportBatch` (its owning batch) and inherits its Realm.
- **Uniqueness:** at most one `PENDING` review item may exist per **full §70.2 fallback source-row identity** — `(realm, financialAccountId, adapterId, adapterVersion, sourceStatementId | contentHash, sourceRowId | sourceRowPosition)`. This is the same key as §70.2, with no divergent sub-tuple. A different `adapterId` or `adapterVersion` is a **different identity** (§70.2 versioning) and is never silently mapped onto an existing item; its import outcome is the **adapter-version conflict** defined in §70.4 — `needs_review` with a **new** item owned by the current batch and **no** automatic Transaction.
- While `status = PENDING`, no Transaction exists for the item.
- `resolution = CREATE` produces exactly one `IMPORTED` Transaction (`createdTransactionId` set); `resolution = SKIP` produces none.
- A `RESOLVED` item is terminal: it is not re-resolved to a different `resolution` (see API §32.2 idempotency).
- `ImportBatch.needsReviewCount` equals the number of that batch's **own** `PENDING` child items.

## Ownership and Retry (binding)

- **Ownership is first-seen and immutable:** an `ImportReviewItem` is owned by the batch whose import first produced the ambiguous row. Later imports never move, re-parent, or duplicate the item.
- **Re-presented while `PENDING`:** if a later import presents the same source-row identity while the item is `PENDING`, **no second item** is created. The later batch's per-row outcome is `needs_review` **referencing the existing item** — its `reviewItemId` **and its owning `importBatchId`**. The later batch's `needsReviewCount` is **not** incremented (each batch counts only its own `PENDING` children), and the later batch may close independently of the pending decision.
- **Re-presented after `RESOLVED`:** the recorded decision stands — **no new decision and no additional Transaction**. The row's outcome is `duplicate` in its structured **`RESOLVED_REVIEW_ITEM`** form (API §32.1): it references the `reviewItemId`, the owning `importBatchId`, and the stored `resolution`. After `CREATE` it additionally references the **same** `createdTransactionId` (the created Transaction carries the row's source identity, §70.1); after `SKIP` no Transaction exists and `createdTransactionId` is **absent by definition**. No new item is created; the later batch's `duplicateCount` is incremented.
- **Implementation (VC-1-06a):** a Transaction created by `CREATE` records its item (`import_review_item_id`, unique). It may share its source-row identity with an earlier Transaction (a human decided they are two payments), so the schema's fallback identity index exempts such Transactions; re-imports find the resolved item first (§70.4). See API §32.3a.
- **LIST and RESOLVE addressing:** an item is listed only under its owning batch (API §32.3) and resolved only via its owning batch's path — `ImportReviewItem.importBatchId` must equal the `{importBatchId}` path segment (API §32.2). Resolving decrements the **owning** batch's `needsReviewCount`.

---

# 21. Loan

**Domain:** Financing  
**Stability:** Stable  
**Aggregate Role:** Aggregate Root

## 21.1 Purpose

Represent one canonical financing contract.

---

## 21.2 Required Fields

- `id`
- `lenderPartyId`
- `principalOriginal`
- `currency`
- `startDate`
- `status`

---

## 21.3 Optional Fields

- `contractNumber`
- `acquisitionId`
- `borrowerPartyIds`
- `disbursementDate`
- `maturityDate`
- `repaymentType`
- `paymentFrequency`
- `currentTermsId`
- `documentIds`
- `sourceReferences`
- `notes`

---

## 21.3a Status and fixed fields (P3-D1, api-design §41.1)

- `status`: `ACTIVE` → `VOID` (a recording error, only while no split references the Loan) and `ACTIVE` → `CLOSED`
  (`REPAID`, `REFINANCED`, `OTHER`; VC-3-07, API §41.7); both final.
- Closing fields: `closingDate`, `closingReason`, `refinancedByLoanId` (a Loan of the Realm, `ACTIVE` when named),
  `closingNote`; set only in the step to `CLOSED`. After `closingDate` the remaining debt is 0 and no split may name
  the Loan on a later booking date (a reversal exempt). A Loan that a `CLOSED` one names as `refinancedByLoanId` is
  never voided (review on #71).
- Fixed after creation: `principalOriginal`, `currency`, `startDate`, `disbursementDate`, `acquisitionId`. Amendable
  while `ACTIVE`: lender, borrowers, `maturityDate`, `contractNumber`, `sourceReferences`, `notes`.
- `repaymentType`, `paymentFrequency` and `currentTermsId` belong to LoanTerms (§22, P3-D2), not to the Loan.
- Full disbursement is assumed: `principalOriginal` is owed from `disbursementDate` (or `startDate` while unset).

---

## 21.3b Derived values (P3-D6, API §41.6)

- **Remaining debt** on a day is derived, never stored (ADR-016, BR-FIN-006): the actual one is `principalOriginal`
  minus the counted `LOAN_PRINCIPAL` splits up to that day (§18, API §41.5); the planned one is the schedule's
  balance (§24). Per property both are split by the allocation set of that day (§23), by largest remainder.
- **`LoanBalanceStatement`** `{ statementDate, balance, source, notes, status }`: a lender's reported balance, kept as
  evidence and compared with the derived value at each read; appended, voidable, never edited.

---

## 21.4 Relationships

A Loan may relate to:

- one or more Properties
- one Acquisition
- one or more Borrowers
- one Lender
- multiple Loan Terms periods
- multiple Loan Allocations
- multiple actual Transactions
- multiple Loan Metric Snapshots

---

## Invariants

- A shared Loan remains one Loan.
- Property-level reporting must use Loan Allocation rather than duplicate Loans.
- Actual payment history remains in the Financial Ledger.

---

# 22. LoanTerms

**Domain:** Financing  
**Stability:** Stable

## Purpose

Represent a temporally valid set of Loan conditions.

---

## Required Fields

- `id`
- `loanId`
- `validFrom`
- `interestRate`
- `repaymentModel`

---

## Optional Fields

- `validUntil`
- `scheduledPayment`
- `initialRepaymentRate`
- `fixedRateUntil`
- `specialRepaymentLimit`
- `paymentFrequency`
- `notes`

---

## Invariants

- active LoanTerms periods must not overlap for the same Loan unless explicitly supported
- historical terms must not be overwritten when refinancing occurs

## Periods (P3-D2, api-design §41.2)

- A period has `validFrom`; `validUntil` is derived (the next `VALID` period's `validFrom` minus one day), not
  stored. Periods are appended after the last one and never edited; only the last one can be voided.
- `repaymentModel`: `ANNUITY` (with `scheduledPayment`, as on the contract) or `INTEREST_ONLY` (no
  `scheduledPayment`; the payment is the interest). `paymentFrequency` is `MONTHLY` in Phase 3 and not stored.
- `interestRate` and `initialRepaymentRate` are exact decimals (percent p.a., at most three decimals).
- `principalAtStart` (optional, not on the first period, never above `principalOriginal`) restarts the plan's balance.

---

# 23. LoanAllocation

**Domain:** Financing / Investment  
**Stability:** Evolving

## Purpose

Allocate one Loan across one or more PropertyReferences for financing and analysis.

---

## Required Fields

- `id`
- `loanId`
- `propertyReferenceId`
- `allocationShare`
- `validFrom`

---

## Optional Fields

- `validUntil`
- `allocationBasis`
- `allocatedPrincipalReference`
- `notes`

---

## Invariants

For a fully allocated Loan and a given date:

`sum(active allocationShare) = 100%`

The allocation does not create new Loans.

## Sets (P3-D3, api-design §41.3; implemented: migration 0026)

- Allocations are written as **sets** valid from a date; a set's `validUntil` is derived from the next `VALID` set.
  Sets are appended, never edited; only the last one can be voided. Before the first set a Loan is unallocated.
- `allocationShare` is an exact reduced fraction (`"n/d"`), not a percent; a set sums to exactly `1/1`, enforced at
  commit. `allocationBasis`: `MANUAL`, or `PURCHASE_PRICE` with the Acquisition per property whose price derives the
  fraction exactly (ADR-038's default). `allocatedPrincipalReference` is dropped: allocated amounts are derived.

---

# 24. LoanScheduleEntry

**Domain:** Financing  
**Stability:** Evolving

## Purpose

Represent expected financing behavior for a scheduled period.

---

## Required Fields

- `id`
- `loanId`
- `periodStart`
- `periodEnd`
- `scheduledPayment`
- `scheduledInterest`
- `scheduledPrincipal`
- `expectedRemainingDebt`

---

## Optional Fields

- `loanTermsId`
- `scheduleVersion`
- `generatedAt`

---

## Rules

LoanScheduleEntry is Plan/Forecast data, not Actual cash movement.

## Derived, never stored (P3-D5, api-design §41.4; implemented)

- No table: entries are derived on read from the Loan and its `VALID` terms periods. The same terms always give the
  same entries, so `id`, `scheduleVersion` and `generatedAt` are dropped.
- An entry is one monthly payment: `number`, `paymentDate` (in place of `periodStart`/`periodEnd`), `loanTermsId`
  (API `termsId`), `balanceBefore`, `scheduledInterest` (`interest`), `scheduledPrincipal` (`principal`),
  `scheduledPayment` (`payment`) and `expectedRemainingDebt` (`balanceAfter`, the balance after it), exact in cents. The plan ends paid off, at `maturityDate` with a balance due, or after 600
  payments.

---

# 25. LoanPaymentReconciliation

**Domain:** Financing  
**Stability:** Evolving

**Dropped (P3-D4, API §41.5):** the split's `loanId` is the link between a payment and its Loan, and deviations
from the schedule are derived on read (VC-3-06). Nothing below is stored.

## Purpose

Connect actual Ledger cash movements to expected Loan schedule behavior.

---

## Required Fields

- `id`
- `loanId`
- `transactionId`
- `reconciliationDate`
- `status`

---

## Optional Fields

- `interestSplitId`
- `principalSplitId`
- `scheduleEntryId`
- `difference`
- `notes`

---

# 26. SecurityDeposit

**Domain:** Rental Finance  
**Stability:** Stable  
**Aggregate Role:** Aggregate Root

## Purpose

Represent the rental security deposit lifecycle independently from Rental Income.

---


MRE `Tenant.guaranty` and `guarantyPayback` remain operational rental-management values. They may seed or reconcile expected deposit state, but actual receipt and repayment are represented through `SecurityDeposit` plus canonical Ledger Transactions.

## Required Fields

- `id`
- `rentalContractReferenceId`
- `requiredAmount`
- `currency`
- `status`

---

## Optional Fields

- `tenantPartyIds`
- `holdingFinancialAccountId`
- `receivedAmount`
- `receivedDate`
- `payerPartyId`
- `sourceIban`
- `destinationIban`
- `returnedAmount`
- `returnedDate`
- `outstandingAmount`
- `documentIds`
- `notes`

---

## Suggested Lifecycle

- `EXPECTED`
- `PARTIALLY_RECEIVED`
- `RECEIVED`
- `HELD`
- `PARTIALLY_RETURNED`
- `RETURNED`
- `OFFSET`
- `CLOSED`

---

## Relationships

SecurityDeposit may reference multiple actual Ledger Transactions.

---

## Invariants

- Security Deposit cash must not be categorized as Rental Income.
- `receivedAmount` should be derived from linked confirmed Transactions where feasible.
- `outstandingAmount` should be derived, not independently maintained.
- Return payments remain actual Transactions.

---

# 27. WEG

**Domain:** WEG  
**Stability:** Stable  
**Aggregate Role:** Aggregate Root

## Purpose

Represent a German Wohnungseigentümergemeinschaft.

---

## Required Fields

- `id`
- `displayName`
- `status`

---

## Optional Fields

- `address`
- `administratorPartyId`
- `administratorContractDocumentId`
- `financialYearStartMonth`
- `externalReferences`
- `notes`

---

# 28. WEGMembership

**Domain:** WEG  
**Stability:** Stable

## Required Fields

- `id`
- `wegId`
- `propertyReferenceId`
- `miteigentumsanteil`
- `validFrom`

---

## Optional Fields

- `validUntil`
- `allocationUnit`
- `sourceDocumentId`
- `notes`

---

## Invariants

Miteigentumsanteil is distinct from Ownership Share.

---

# 29. WEGEconomicPlan

**Domain:** WEG  
**Stability:** Stable  
**Aggregate Role:** Entity

## Purpose

Represent a Wirtschaftsplan for a WEG period.

---

## Required Fields

- `id`
- `wegId`
- `financialPeriodStart`
- `financialPeriodEnd`
- `status`

---

## Optional Fields

- `documentId`
- `approvedDate`
- `totalPlannedAmount`
- `propertyPlannedAmount`
- `sourceReferences`
- `notes`

---

## Lifecycle

- `DRAFT`
- `PROPOSED`
- `APPROVED`
- `SUPERSEDED`

---

# 30. WEGAnnualStatement

**Domain:** WEG  
**Stability:** Stable  
**Aggregate Role:** Entity

## Purpose

Represent a Jahresabrechnung for an actual WEG financial period.

---

## Required Fields

- `id`
- `wegId`
- `financialPeriodStart`
- `financialPeriodEnd`
- `status`

---

## Optional Fields

- `documentId`
- `approvedDate`
- `totalActualAmount`
- `propertyActualAmount`
- `settlementAmount`
- `sourceReferences`
- `notes`

---

## Lifecycle

- `IMPORTED`
- `UNREVIEWED`
- `CONFIRMED`
- `SUPERSEDED`

---

# 31. WEGCostLine

**Domain:** WEG  
**Stability:** Stable

## Purpose

Represent one economically distinguishable line in a WEG plan or annual statement.

---

## Required Fields

- `id`
- `wegId`
- `sourceType`
- `sourceStatementId`
- `description`
- `amount`

---

## Optional Fields

- `allocationKey`
- `propertyAllocatedAmount`
- `financialCategoryId`
- `recoverabilityClassificationId`
- `taxClassificationId`
- `reserveImpact`
- `maintenanceProjectId`
- `sourceReferences`

---

## Source Types

- `ECONOMIC_PLAN`
- `ANNUAL_STATEMENT`
- `SPECIAL_ASSESSMENT`

---

# 32. WEGSpecialAssessment

**Domain:** WEG  
**Stability:** Stable

## Required Fields

- `id`
- `wegId`
- `description`
- `totalAmount`
- `propertyAllocatedAmount`
- `dueDate`
- `status`

---

## Optional Fields

- `maintenanceProjectId`
- `resolutionDocumentId`
- `sourceReferences`
- `notes`

Actual payment remains a Ledger Transaction.

---

# 33. MaintenanceProject

**Domain:** Property Economics  
**Stability:** Stable  
**Aggregate Role:** Aggregate Root

## Purpose

Group economically related maintenance, repair or modernization activity.

---

## Required Fields

- `id`
- `propertyReferenceId`
- `name`
- `projectType`
- `status`

---

## Optional Fields

- `wegId`
- `plannedStartDate`
- `actualStartDate`
- `completedDate`
- `plannedBudget`
- `description`
- `documentIds`
- `sourceReferences`
- `notes`

---

## Suggested Project Types

- `REPAIR`
- `MAINTENANCE`
- `MODERNIZATION`
- `CAPITAL_IMPROVEMENT`
- `ACQUISITION_RENOVATION`
- `WEG_MEASURE`
- `OTHER`

---

## Relationships

May reference:

- multiple Transaction Splits
- multiple Documents
- WEGCostLines
- one or more Tax Classifications

---

## Invariants

Maintenance Project provides grouping and meaning.

It does not replace actual financial Transactions.

---

# 34. Document

**Domain:** Shared Documents  
**Stability:** Stable  
**Aggregate Role:** Aggregate Root

## Purpose

Represent metadata and identity for a domain-relevant file.

---

## Required Fields

- `id`
- `documentType`
- `storageReference`
- `originalFilename`
- `uploadedAt`
- `status`

---

## Optional Fields

- `documentDate`
- `contentHash`
- `mimeType`
- `fileSize`
- `version`
- `source`
- `sourceReferences`
- `notes`

---

## Invariants

- A physical file should not be duplicated merely because it relates to several domains.
- Content hash should be used where practical to detect duplicates.
- Replacing a legally relevant document should preserve version history where required.

---

# 35. DocumentLink

**Domain:** Shared Documents  
**Stability:** Stable

## Purpose

Connect one Document to one domain Entity.

---

## Required Fields

- `id`
- `documentId`
- `targetType`
- `targetId`

---

## Optional Fields

- `relationshipType`
- `validFrom`
- `validUntil`

---

# 36. TaxClassification

**Domain:** Taxation  
**Stability:** Stable  
**Aggregate Role:** Entity

## Purpose

Represent the tax interpretation of an existing economic item.

---

## Required Fields

- `id`
- `jurisdiction`
- `taxYear`
- `sourceEntityType`
- `sourceEntityId`
- `taxCategory`
- `reviewState`

---

## Optional Fields

- `deductibility`
- `capitalizationTreatment`
- `depreciationRelevance`
- `ruleVersionId`
- `ownerAllocationBasis`
- `advisorPartyId`
- `sourceReferences`
- `notes`

---

## Suggested Source Entity Types

- `TRANSACTION_SPLIT`
- `ACQUISITION_COST`
- `MAINTENANCE_PROJECT`
- `WEG_COST_LINE`
- `DEPRECIATION_ASSET`

---

## Invariants

- TaxClassification never creates a cash movement.
- It must reference an existing source entity.
- Confirmed tax classification should identify applicable rule provenance where material.
- Historical classification changes must remain traceable.

---

# 37. TaxRuleVersion

**Domain:** Taxation  
**Stability:** Evolving  
**Aggregate Role:** Entity

## Required Fields

- `id`
- `jurisdiction`
- `ruleCode`
- `version`
- `validFrom`
- `status`

---

## Optional Fields

- `validUntil`
- `title`
- `description`
- `sourceReference`
- `implementationReference`
- `testFixtureReference`

---

## Lifecycle

- `DRAFT`
- `ACTIVE`
- `RETIRED`
- `SUPERSEDED`

---

## Invariants

Rule versions used in historical calculations must remain addressable.

---

# 38. DepreciationAsset

**Domain:** Depreciation  
**Stability:** Stable  
**Aggregate Role:** Aggregate Root

## Purpose

Represent one canonical depreciation basis.

---

## Required Fields

- `id`
- `propertyReferenceId`
- `assetType`
- `basisAmount`
- `currency`
- `startDate`
- `depreciationMethod`
- `status`

---

## Optional Fields

- `acquisitionId`
- `maintenanceProjectId`
- `landBuildingAllocationId`
- `taxRuleVersionId`
- `depreciationRate`
- `usefulLife`
- `ownershipBasis`
- `sourceReferences`
- `notes`

---

## Suggested Asset Types

- `BUILDING_ACQUISITION_BASIS`
- `CAPITALIZED_IMPROVEMENT`
- `SEPARATE_COMPONENT`
- `OTHER`

---

## Invariants

- Land must not be included in a depreciable building basis.
- Basis must have traceable provenance.
- Confirmed Assets should not silently change basis without versioned correction.

---

# 39. DepreciationScheduleVersion

**Domain:** Depreciation  
**Stability:** Stable

## Purpose

Represent one reproducible version of a depreciation schedule.

---

## Required Fields

- `id`
- `depreciationAssetId`
- `version`
- `generatedAt`
- `calculationMethodVersion`
- `status`

---

## Optional Fields

- `taxRuleVersionId`
- `reason`
- `supersedesVersionId`

---

## Invariant

A schedule version must remain reproducible from referenced inputs.

---

# 40. DepreciationScheduleEntry

**Domain:** Depreciation  
**Stability:** Stable

## Required Fields

- `id`
- `scheduleVersionId`
- `taxYear`
- `amount`

---

## Optional Fields

- `periodStart`
- `periodEnd`
- `ownerPartyId`
- `ownershipShareApplied`
- `notes`

---

# 41. OperatingCostRecoverabilityClassification

**Domain:** Rental Cost Allocation / DE  
**Stability:** Evolving

## Purpose

Represent whether and how a cost may be allocated to a Tenant.

---

## Required Fields

- `id`
- `sourceEntityType`
- `sourceEntityId`
- `classification`
- `reviewState`

---

## Suggested Classifications

- `RECOVERABLE`
- `NON_RECOVERABLE`
- `PARTIALLY_RECOVERABLE`
- `NEEDS_REVIEW`

---

## Optional Fields

- `ruleVersionId`
- `recoverableShare`
- `allocationKey`
- `notes`

Tax treatment remains separate.

---

# 42. UtilitySettlement

**Domain:** Rental Cost Allocation  
**Stability:** Evolving  
**Aggregate Role:** Aggregate Root

## Purpose

Represent a periodic operating-cost settlement between landlord and Tenant.

---

## Required Fields

- `id`
- `rentalContractReferenceId`
- `periodStart`
- `periodEnd`
- `status`

---

## Optional Fields

- `advancePayments`
- `allocatedActualCosts`
- `resultAmount`
- `documentId`
- `generatedAt`
- `confirmedAt`

---

## Suggested Result Semantics

- positive amount due from Tenant
- negative amount payable/refundable to Tenant

One convention must be documented.

---

# 43. UtilitySettlementLine

**Domain:** Rental Cost Allocation  
**Stability:** Evolving

## Required Fields

- `id`
- `utilitySettlementId`
- `description`
- `sourceEntityType`
- `sourceEntityId`
- `allocatedAmount`

---

## Optional Fields

- `allocationKey`
- `totalCost`
- `tenantShare`
- `notes`

---

# 44. MarketValuation

**Domain:** Investment  
**Stability:** Stable  
**Aggregate Role:** Entity

## Purpose

Represent a dated value estimate for the real-world Property identified through a PropertyReference.

---

## Required Fields

- `id`
- `propertyReferenceId`
- `valuationDate`
- `value`
- `valuationMethod`
- `sourceType`
- `reviewState`

---

## Optional Fields

- `sourcePartyId`
- `documentId`
- `confidence`
- `notes`
- `sourceReferences`

---

## Suggested Methods

- `PURCHASE_PRICE_REFERENCE`
- `COMPARABLE_VALUE`
- `INCOME_APPROACH`
- `EXTERNAL_APPRAISAL`
- `BANK_VALUATION`
- `OWNER_ESTIMATE`
- `OTHER`

---

## Invariants

- MarketValuation is an estimate.
- Historical valuations should not be overwritten by later estimates.
- Investment metrics depending on valuation should preserve the selected valuation reference.

---

# 45. InvestmentScenario

**Domain:** Investment  
**Stability:** Evolving  
**Aggregate Role:** Aggregate Root

## Purpose

Represent isolated hypothetical assumptions for future analysis.

---

## Required Fields

- `id`
- `name`
- `scopeType`
- `status`
- `createdAt`

---

## Optional Fields

- `propertyReferenceIds`
- `portfolioId`
- `baseDate`
- `description`
- `scenarioType`
- `createdBy`

---

## Suggested Scenario Types

- `BASE`
- `BEAR`
- `BULL`
- `CUSTOM`

---

## Invariants

- Scenario assumptions never overwrite Actual data.
- Every calculated Scenario result must identify the Scenario.
- Deleting a Scenario must not delete Actual domain data.

---

# 46. ScenarioAssumption

**Domain:** Investment  
**Stability:** Evolving

## Required Fields

- `id`
- `scenarioId`
- `assumptionType`
- `value`
- `validFrom`

---

## Optional Fields

- `validUntil`
- `propertyReferenceId`
- `loanId`
- `sourceReference`
- `notes`

---

## Example Assumption Types

- `RENT_GROWTH`
- `VACANCY_RATE`
- `OPERATING_COST_INFLATION`
- `PROPERTY_VALUE_GROWTH`
- `REFINANCING_RATE`
- `SALE_DATE`
- `SALE_COST_RATE`

---

# 47. InvestmentMetricDefinition

**Domain:** Investment  
**Stability:** Stable

## Purpose

Define the canonical meaning and formula version of an Investment Metric.

---

## Required Fields

- `id`
- `metricCode`
- `name`
- `formulaVersion`
- `status`

---

## Optional Fields

- `description`
- `formulaDocumentation`
- `requiredInputs`
- `effectiveFrom`
- `effectiveUntil`

---

## Example Metrics

- `NOI`
- `CASHFLOW_AFTER_FINANCING`
- `EQUITY`
- `LTV`
- `DSCR`
- `CCR`
- `IRR`
- `NET_RENTAL_YIELD`

---

## Invariant

Metric formula changes require new formula version semantics.

---

# 48. InvestmentMetricSnapshot

**Domain:** Investment  
**Stability:** Stable  
**Aggregate Role:** Entity

## Purpose

Persist a reproducible calculated result for historical analysis.

---

## Required Fields

- `id`
- `metricDefinitionId`
- `metricCode`
- `formulaVersion`
- `calculatedAt`
- `scopeType`
- `value`

---

## Optional Fields

- `propertyReferenceId`
- `portfolioId`
- `scenarioId`
- `periodStart`
- `periodEnd`
- `marketValuationId`
- `sourceDataVersion`
- `calculationRunId`
- `inputsSummary`
- `notes`

---

## Invariants

- Snapshot cannot be manually edited into a source fact.
- Formula version must be preserved.
- Scenario-derived snapshots must reference their Scenario.
- Actual snapshots and Scenario snapshots must remain distinguishable.

---

# 49. CalculationRun

**Domain:** Investment / Reporting  
**Stability:** Evolving

## Purpose

Group one set of reproducible derived calculations.

---

## Required Fields

- `id`
- `calculatedAt`
- `calculationType`
- `status`

---

## Optional Fields

- `scopeType`
- `propertyReferenceIds`
- `portfolioId`
- `scenarioId`
- `sourceDataVersion`
- `softwareVersion`
- `initiatedBy`

---

# 50. Portfolio

**Domain:** Investment  
**Stability:** Evolving  
**Aggregate Role:** Aggregate Root

## Required Fields

- `id`
- `name`
- `status`

---

## Optional Fields

- `description`
- `baseCurrency`
- `ownerPartyIds`

---

# 51. PortfolioMembership

**Domain:** Investment  
**Stability:** Evolving

## Required Fields

- `id`
- `portfolioId`
- `propertyReferenceId`
- `validFrom`

---

## Optional Fields

- `validUntil`

---

# 52. Plan

**Domain:** Planning  
**Stability:** Evolving  
**Aggregate Role:** Aggregate Root

## Purpose

Represent intentionally entered future expectations.

---

## Required Fields

- `id`
- `name`
- `scopeType`
- `periodStart`
- `periodEnd`
- `status`

---

## Optional Fields

- `propertyReferenceId`
- `portfolioId`
- `description`
- `createdBy`

---

# 53. PlanLine

**Domain:** Planning  
**Stability:** Evolving

## Required Fields

- `id`
- `planId`
- `lineType`
- `period`
- `amount`

---

## Optional Fields

- `propertyReferenceId`
- `loanId`
- `financialCategoryId`
- `notes`

---

# 54. Forecast

**Domain:** Planning / Investment  
**Stability:** Experimental

## Purpose

Represent automatically generated future estimates.

Forecast implementation is deferred beyond the core MVP.

---

# 55. AutomationRule

**Domain:** Automation  
**Stability:** Evolving  
**Aggregate Role:** Entity

## Required Fields

- `id`
- `name`
- `ruleType`
- `status`
- `priority`

---

## Optional Fields

- `conditions`
- `actions`
- `scope`
- `validFrom`
- `validUntil`
- `createdBy`

---

## Rules

Automation must call canonical domain actions.

It must not directly violate entity invariants.

---

# 56. AISuggestion

**Domain:** AI Assistance  
**Stability:** Experimental  
**Aggregate Role:** Entity

## Purpose

Represent a non-authoritative AI recommendation.

---

## Required Fields

- `id`
- `suggestionType`
- `targetEntityType`
- `targetEntityId`
- `createdAt`
- `status`

---

## Optional Fields

- `suggestedValue`
- `confidence`
- `modelReference`
- `reasoningSummary`
- `reviewedBy`
- `reviewedAt`

---

## Suggested Lifecycle

- `PROPOSED`
- `ACCEPTED`
- `REJECTED`
- `EXPIRED`

---

## Invariant

Acceptance must trigger a canonical domain command.

It must not mutate canonical state merely by changing suggestion status.

---

# 57. AuditRecord

**Domain:** Cross-Cutting  
**Stability:** Stable

## Purpose

Represent traceability for significant authoritative changes.

---

## Required Fields

- `id`
- `entityType`
- `entityId`
- `action`
- `occurredAt`
- `actorType`

---

## Optional Fields

- `actorId`
- `previousVersion`
- `newVersion`
- `reason`
- `metadata`

---

## Suggested Audited Events

- Transaction confirmation
- Transaction correction
- Ownership change
- Tax Classification confirmation
- Depreciation basis change
- Loan terms change
- Market Valuation confirmation

---

# 58. Domain Event

**Domain:** Cross-Cutting  
**Stability:** Evolving

## Purpose

Represent an explicit business event that may be used for integration.

Examples:

- `TransactionConfirmed`
- `OwnershipChanged`
- `LoanTermsChanged`
- `WEGAnnualStatementConfirmed`

The exact event infrastructure remains open.

---

# 59. Entity Relationship Summary

```text
Party
 ├── Ownership ───────────── PropertyReference
 ├── Loan Borrower Role
 ├── Loan Lender Role
 ├── Tenant Mapping
 └── FinancialAccount Holder

PropertyReference
 ├── Acquisition
 ├── Ownership
 ├── LoanAllocation
 ├── WEGMembership
 ├── MaintenanceProject
 ├── MarketValuation
 ├── Transaction
 ├── InvestmentScenario
 └── PortfolioMembership

Acquisition
 ├── AcquisitionCost
 ├── LandBuildingAllocation
 ├── Loan
 ├── Ownership
 └── DocumentLink

Transaction
 └── TransactionSplit
      ├── FinancialCategory
      ├── Loan
      ├── WEG
      ├── MaintenanceProject
      ├── SecurityDeposit
      ├── RentPaymentReconciliation
      └── TaxClassification

Loan
 ├── LoanTerms
 ├── LoanAllocation
 ├── LoanScheduleEntry
 └── LoanPaymentReconciliation

WEG
 ├── WEGMembership
 ├── WEGEconomicPlan
 ├── WEGAnnualStatement
 ├── WEGCostLine
 └── WEGSpecialAssessment

MaintenanceProject
 ├── TransactionSplit
 ├── DocumentLink
 └── TaxClassification

LandBuildingAllocation
 └── DepreciationAsset
      └── DepreciationScheduleVersion
           └── DepreciationScheduleEntry

InvestmentScenario
 └── ScenarioAssumption

InvestmentMetricDefinition
 └── InvestmentMetricSnapshot
```

---

# 60. Cardinality Summary

| Relationship | Cardinality |
|---|---|
| Party → Ownership | 1 : many |
| PropertyReference → Ownership | 1 : many over time |
| PropertyReference → Acquisition | 1 : many theoretically |
| Acquisition → AcquisitionCost | 1 : many |
| PropertyReference → Loan | many : many through LoanAllocation |
| Loan → LoanTerms | 1 : many over time |
| Transaction → TransactionSplit | 1 : many |
| PropertyReference → WEGMembership | 1 : many over history |
| WEG → WEGMembership | 1 : many |
| WEG → WEGAnnualStatement | 1 : many |
| WEGAnnualStatement → WEGCostLine | 1 : many |
| PropertyReference → MaintenanceProject | 1 : many |
| Acquisition → LandBuildingAllocation | normally 1 : 1 active |
| DepreciationAsset → ScheduleVersion | 1 : many |
| ScheduleVersion → ScheduleEntry | 1 : many |
| RentalContractReference → SecurityDeposit | normally 1 : 0..1 initially |
| PropertyReference → MarketValuation | 1 : many |
| Scenario → ScenarioAssumption | 1 : many |
| MetricDefinition → MetricSnapshot | 1 : many |

---

# 61. Ownership Allocation Rule

For MVP calculations:

```text
Owner Allocation
=
Canonical Ownership Share valid for the relevant date
```

Example:

```text
Property A

Owner 1: 80%
Owner 2: 20%
```

Then, unless a future accepted override mechanism exists:

- rental income owner view → 80 / 20
- deductible expense owner view → 80 / 20
- depreciation owner view → 80 / 20
- equity owner view → 80 / 20
- property-level investment result → 80 / 20

For an Acquisition (P2-D10, api-design §27.4) the share is taken relative to the acquired share, over the buyers' own
Ownerships of that Acquisition, and money is split into cents by largest remainder per amount, with totals derived
from the parts.

---

# 62. Cash Ledger Boundary

The following belong in the Ledger:

- actual rent payment
- Hausgeld payment
- loan installment
- security deposit payment
- contractor payment
- purchase price transfer
- tax-relevant actual payment

The following do not belong in the Ledger:

- AfA
- unpaid expected rent
- scheduled future loan payment
- unrealized property value growth
- expected future sale proceeds
- scenario rent
- forecast operating cost

---

# 63. Actual vs Expected Data

## Actual

- Transaction
- confirmed WEGAnnualStatement
- Ownership effective for historical period
- confirmed Acquisition
- actual MarketValuation as an estimate recorded at date

## Expected / Planned

- Rent Obligation in MRE
- LoanScheduleEntry
- WEGEconomicPlan
- PlanLine

## Hypothetical

- ScenarioAssumption
- Scenario-derived MetricSnapshot

---

# 64. Correction Model

The logical model favors traceability.

For financially significant records:

### Preferred

```text
Original confirmed record
+
Correction metadata or correction entity
```

### Discouraged

```text
Silent replacement of historical value
```

The append-only policy is resolved by ADR-037 (confirmed Transactions are immutable; corrections use a reversal + replacement record). Concrete storage-level enforcement remains an implementation detail.

---

# 65. Versioning Model

Versioning is required where historical reproducibility matters.

Strong candidates include:

- TaxRuleVersion
- LoanTerms
- DepreciationScheduleVersion
- InvestmentMetricDefinition
- InvestmentMetricSnapshot
- Document
- Ownership validity periods

---

# 66. Deletion Policy

Logical deletion or deactivation is preferred over physical deletion for records with:

- financial relevance
- legal relevance
- tax relevance
- historical reporting significance

Physical deletion may remain acceptable for:

- unconfirmed imports
- temporary AI suggestions
- failed draft objects

Exact retention policy will be documented separately.

---

# 67. Validation Levels

The implementation should distinguish between at least three validation categories.

## Structural Validation

Examples:

- required field missing
- invalid currency code
- invalid date format

## Domain Validation

Examples:

- Ownership Shares exceed 100%
- Transaction Splits do not reconcile
- overlapping LoanTerms

## Review Validation

Examples:

- Tax Classification requires advisor review
- LandBuildingAllocation is incomplete
- AI Suggestion has not been confirmed

---

# 68. Provenance Requirements

High-value domain facts should preserve provenance.

At minimum provenance is particularly important for:

- imported Transactions
- Acquisition Costs
- LandBuildingAllocation
- Tax Classifications
- Market Valuations
- WEG statements
- Depreciation basis
- AI-assisted classification

---

# 69. Source Data Confidence

Where data may be uncertain, the system should use explicit state rather than pretending certainty.

Examples:

- `UNREVIEWED`
- `NEEDS_REVIEW`
- `CONFIRMED`

This is preferable to nullable fields with unclear semantic meaning.

---

# 70. Import Idempotency

Bank and document imports must be repeatable without duplicating canonical records. The idempotency identity below is **binding for the first CSV bank-statement adapter**; other adapters follow the same priority order with their own documented normalization.

## 70.1 Duplicate identity (priority order)

For each normalized bank row, the canonical import identity is resolved in this order:

1. **Stable external transaction identifier** — if the source provides one (e.g. a bank-assigned end-to-end/transaction reference), it is the identity, scoped to `(realm, financialAccountId, externalTransactionId)` — **but only with consistent content**: an id match is a duplicate only when the content fingerprint (§70.2) matches too. An import of user-mapped CSV columns cannot rely on an id being unique (reused or placeholder references such as SEPA `NOTPROVIDED`), so the same id with other content is ambiguous (§70.4), never a duplicate. The external id stays the preferred identity: it makes reordered and re-exported files deduplicate exactly, independent of the adapter.
2. **Adapter-/source-bound row fingerprint** — otherwise a deterministic hash over a fixed, versioned set of normalized fields, scoped to `(realm, financialAccountId, adapterId, adapterVersion, fingerprint)`.

## 70.2 Fallback row identity (v1, first CSV adapter)

When no stable external transaction id is present, a row's identity is bound to its **source position**, not to its content alone. The fallback identity key is:

`(realm, financialAccountId, adapterId, adapterVersion, sourceStatementId | contentHash, sourceRowId | sourceRowPosition)`

where:

- **source statement identity** = a stable statement/source id if the source provides one, otherwise the file `contentHash`;
- **stable source-row identity within that statement** = a source-provided row id if available, otherwise the row's ordinal **position** within that specific source file/statement.

Separately, a **content fingerprint** — normalized `bookingDate`, optional `valueDate`, non-negative `amount` + `direction`, counterparty (`counterpartyIbanRaw`, else `counterpartyNameRaw`), `description` — is recorded for **collision detection and cross-file ambiguity only**. It is **not** an identity by itself: two rows may share a content fingerprint and still be two legitimately distinct payments.

The fallback identity key and the content-fingerprint field set are **versioned** via `adapterVersion`; changing either is a new version, not a silent redefinition.

## 70.3 Normalization

Before computing the content fingerprint: trim and collapse whitespace, uppercase IBANs, strip presentation formatting from IBAN and amount, use the canonical non-negative Money representation plus `direction`, and apply a documented, stable date format. Reference fields (`externalTransactionId`, `sourceRowId`) that only carry a placeholder for "no reference" — SEPA `NOTPROVIDED`, MT940 `NONREF`, `NONE`, `N/A`, dashes; case-insensitive, ignoring spaces and underscores — are normalized to **null**: taken as an id, a placeholder would make different payments look like one. Normalization rules are part of the adapter version.

## 70.4 Scope, retries, ambiguity

- Identity is always scoped to `realm` and `financialAccountId`; the same row imported into a different account is never a duplicate.
- **Deterministic dedupe:** a row is a duplicate only when its identity key (stable external id, or the source-statement + source-row identity above) matches an already-imported row. A matching identity increments the `ImportBatch` duplicate count and creates no new Transaction.
- **Two legitimately identical real payments** within one source are distinct source rows (different `sourceRowId` / `sourceRowPosition`) → **two** Transactions. Content fingerprints alone never collapse them.
- **External id with other content → `needs_review`** (`EXTERNAL_ID_CONTENT_CONFLICT`): a row whose external id matches an imported Transaction whose content fingerprint differs — also within one file — is not provably the same payment; a duplicate here would silently drop a payment. A `CREATE` resolution of such an item creates the Transaction **without** the external id (the id already belongs to the other Transaction); it keeps its source-row identity, so a re-import references the resolved item.
- **External id after an import without it → `needs_review`** (`AMBIGUOUS_CROSS_FILE_MATCH`): a row with an external id that matches no Transaction, but whose content fingerprint matches an imported Transaction **without** an external id (any statement, e.g. the same file imported before without mapping the id column), is ambiguous, not new. The reverse direction (first with the id, then without) is the cross-file match below — both directions behave alike.
- **Ambiguous cross-file match → `needs_review`:** if two rows from different sources (different statement identity, no stable external id) share a content fingerprint, sameness cannot be proven. The row's import outcome is **`needs_review`** with a reason: **no** canonical Transaction is created, and the row is recorded as an **`ImportReviewItem`** (§20A) with its own `reviewItemId`, the normalized row, the ambiguity reason, and `conflictingTransactionIds`. The system neither silently merges nor silently duplicates (`AGENTS.md` §23).
- **Resolution:** a human resolves each pending review item to `CREATE` (materialize exactly one `IMPORTED` Transaction for that row) or `SKIP` (discard the row, create nothing). Until a review item is resolved with `CREATE`, **no** canonical Transaction exists for it, and it never becomes a silent duplicate.
- **Re-presented ambiguous identity:** if a later import presents the same source-row identity again, the binding ownership/retry rules of §20A apply — while `PENDING`, the existing item is referenced (no second item, no counter increment on the later batch); after `RESOLVED`, the recorded decision stands and the row is a `duplicate` in its structured `RESOLVED_REVIEW_ITEM` form (API §32.1) — no new decision, no additional Transaction.
- **Adapter-version conflict:** in the fallback branch, a changed `adapterId`/`adapterVersion` deliberately produces a **different identity** (§70.2), so identity dedupe does not match. If the adapter-agnostic remainder of the fallback key — `(realm, financialAccountId, sourceStatementId | contentHash, sourceRowId | sourceRowPosition)` — matches a row identity or `ImportReviewItem` recorded under a different `adapterId`/`adapterVersion`, the row is **never auto-created** and never silently mapped onto the existing item. Its outcome is **`needs_review`** as an explicit adapter-version conflict: a **new** `ImportReviewItem` owned by the current batch, whose `ambiguityReason` references the prior item, decision, or Transaction (provenance preserved), with **no** Transaction and the current batch's `needsReviewCount` incremented. A human resolves `CREATE` or `SKIP` as usual; a retry under the same new version follows the normal §20A pending rules. Rows carrying a **stable external transaction id** are unaffected — the external-id branch (§70.1) is adapter-independent and dedupes normally (with consistent content).

## 70.5 Required test cases

- **identical file retry** (same `contentHash`) → zero new Transactions;
- **overlap of the same source-statement identity** (shared rows, same statement id) → only genuinely new rows created, shared rows deduped;
- **row reordering** in a re-export without a stable external id → treated as an ambiguous review case (not silently merged, not silently duplicated); deduped only if a stable external id or source row id is present;
- **partial overlap** of two sources sharing some rows under the same statement identity → shared rows deduped, new rows created;
- **two legitimately identical real payments** in one source → **two** Transactions (distinct source rows);
- **stable external id vs. fallback** → the external-id branch is chosen whenever a stable external id is present;
- **ambiguous cross-file match** (same content fingerprint, different statement identity, no stable external id) → row outcome `needs_review`, **no** Transaction created, the **creating (owning)** batch's `needsReviewCount` incremented;
- **resolve `CREATE`** on a pending review item → exactly **one** `IMPORTED` Transaction created;
- **resolve `SKIP`** on a pending review item → **no** Transaction created;
- **re-import containing a still-`PENDING` ambiguous row** → **no** second `ImportReviewItem`; the row is reported `needs_review` with the **existing** `reviewItemId` and its **owning** `importBatchId`; the later batch's `needsReviewCount` is not incremented; the item is listed and resolved only under the owning batch's path, and resolving decrements the owning batch's counter;
- **re-import after `CREATE`** (same identity, item `RESOLVED` with `CREATE`) → outcome `duplicate` in `RESOLVED_REVIEW_ITEM` form with `reviewItemId`, owning `importBatchId`, `resolution = CREATE` and the **same** `createdTransactionId`; **no** new decision, **no** additional Transaction; the later batch's `duplicateCount` is incremented;
- **re-import after `SKIP`** (same identity, item `RESOLVED` with `SKIP`) → outcome `duplicate` in `RESOLVED_REVIEW_ITEM` form with `reviewItemId`, owning `importBatchId`, `resolution = SKIP` and **absent** `createdTransactionId`; **no** Transaction is ever created for the row; the later batch's `duplicateCount` is incremented;
- **same physical row under a different `adapterVersion`** (fallback branch, no stable external id) → **adapter-version conflict** (§70.4): outcome `needs_review` with a **new** `ImportReviewItem` owned by the current batch whose reason references the prior item/decision/Transaction, **no** Transaction, current batch's `needsReviewCount` incremented; never silently mapped onto the existing item, never auto-created;
- **same row under a new `adapterVersion` with a stable external id** → the external-id branch (§70.1) is adapter-independent and applies unchanged → normal `duplicate`;
- **same external id, same content** → `duplicate`; **same external id, other content** (also within one file, e.g. a placeholder id) → `needs_review` (`EXTERNAL_ID_CONTENT_CONFLICT`), no Transaction;
- **first imported without, then with an external id** → `needs_review` (`AMBIGUOUS_CROSS_FILE_MATCH`), no second Transaction;
- an ambiguous row is **never** auto-merged into the existing Transaction nor auto-duplicated.

---

# 71. Security Deposit Cash Example

```text
RentalContractReference
  |
  └── SecurityDeposit
        requiredAmount = 3,000 EUR
        holdingFinancialAccountId = FinancialAccount-K
        |
        ├── Transaction A  amount = 1,500 EUR  direction = INFLOW
        └── Transaction B  amount = 1,500 EUR  direction = INFLOW
```

Derived:

```text
receivedAmount = 3,000 EUR
outstandingAmount = 0 EUR
```

No Rental Income is generated.

---

# 72. Loan Payment Example

```text
Transaction
amount = 1,200 EUR
direction = OUTFLOW
account = Main Bank FinancialAccount

Splits (non-negative; inherit the Transaction direction):

600 EUR → LOAN_INTEREST → Loan A
600 EUR → LOAN_PRINCIPAL → Loan A
```

Financing uses the principal component to calculate Remaining Debt.

Taxation may interpret the interest split.

Investment uses both as separate financing effects.

---

# 73. Hausgeld Example

```text
Transaction
amount = 400 EUR
direction = OUTFLOW

Splits (non-negative; inherit the Transaction direction):

240 EUR → WEG_RECOVERABLE
80 EUR  → WEG_NON_RECOVERABLE
80 EUR  → WEG_RESERVE_CONTRIBUTION
```

Taxation and Tenant Recoverability may add separate interpretations to the relevant splits or WEG source lines.

---

# 74. Acquisition Example

```text
Acquisition
purchasePrice = 300,000 EUR            (entered once, on the Acquisition; P2-D7)

Acquisition Costs (expected; no PURCHASE_PRICE, P2-D7)
- REAL_ESTATE_TRANSFER_TAX 15,000
- NOTARY                    4,000
- LAND_REGISTRY             1,500
- BROKER                   10,000

Payments link ledger Transactions to the price or a cost (AcquisitionPayment, §14)

LandBuildingAllocation (as entered, P2-D9; not computed from price and costs)
totalAllocableAmount = 330,500          (as entered by the advisor; which costs enter it is a tax rule, Phase 7)
land     =  66,100
building = 264,400                     (land + building = total exactly)
method = BMF_TOOL, reviewState = ADVISOR_CONFIRMED

DepreciationAsset
basis = building allocation
```

Actual payments remain linked Ledger Transactions.

---

# 75. Multi-Property Loan Example

```text
Loan A
Original Principal: 400,000 EUR

LoanAllocation
Property A = 60%
Property B = 40%
```

Property-level analytics may derive:

```text
Allocated Remaining Debt A = Remaining Debt × 60%
Allocated Remaining Debt B = Remaining Debt × 40%
```

The Loan itself remains one Entity.

---

# 76. Investment Snapshot Example

```text
InvestmentMetricSnapshot

metricCode       = LTV
formulaVersion   = 1
propertyReferenceId = PropertyReference A
calculatedAt     = 2028-12-31
marketValuation  = Valuation 17
value            = 0.68
```

The snapshot stores historical analytical context but does not become the Property's canonical debt or value.

---

# 77. Tax Classification Example

```text
TransactionSplit
amount = 650 EUR
category = LOAN_INTEREST
(parent Transaction direction = OUTFLOW)

TaxClassification
jurisdiction = DE
taxYear = 2028
source = TransactionSplit
taxCategory = ...
reviewState = CONFIRMED
ruleVersion = DE-...
```

Financial fact and tax interpretation remain separate.

---

# 78. Temporal Ownership Example

```text
Ownership 1
Owner A
Property X
1/2
2026-08-01 → 2035-03-31

Ownership 2
Owner B
Property X
1/2
2026-08-01 → 2035-03-31

Ownership 3
Owner A
Property X
1/1
2035-04-01 → open
```

A 2030 report uses 50/50.

A 2036 report uses 100/0.

No historical record is rewritten.

---

# 78A. Terminology Lock

The following field and entity names are normative for MVP implementation:

- `PropertyReference` / `propertyReferenceId` for DE-side references to an MRE Property
- `RentalContractReference` / `rentalContractReferenceId` for DE-side references to the concrete MRE rental relationship
- `FinancialAccount` for bank/cash accounts
- `MRE Account` for authenticated MRE users
- `RentPaymentReconciliation` for MRE rent-state ↔ DE cash matching

The following names are explicitly not part of the MVP DE model:

- `UnitReference`
- `unitId`
- `unitIds`
- generic DE `leaseId`
- generic DE `propertyId`
- `Account` when financial-account semantics are intended

---

# 79. Required MVP Entities

The minimum production-capable data model should implement:

- Party
- PartyExternalReference
- PropertyReference
- RentalContractReference
- Ownership
- Acquisition
- AcquisitionCost
- LandBuildingAllocation
- FinancialAccount
- Transaction
- TransactionSplit
- RentPaymentReconciliation
- FinancialCategory
- ImportBatch
- Loan
- LoanTerms
- LoanAllocation
- LoanScheduleEntry
- SecurityDeposit
- WEG
- WEGMembership
- WEGEconomicPlan
- WEGAnnualStatement
- WEGCostLine
- WEGSpecialAssessment
- MaintenanceProject
- Document
- DocumentLink
- TaxClassification
- TaxRuleVersion
- DepreciationAsset
- DepreciationScheduleVersion
- DepreciationScheduleEntry
- MarketValuation
- InvestmentMetricDefinition
- InvestmentMetricSnapshot
- AuditRecord

---

# 80. Post-MVP Entities

May be implemented after foundational domains stabilize:

- UtilitySettlement
- UtilitySettlementLine
- OperatingCostRecoverabilityClassification
- InvestmentScenario
- ScenarioAssumption
- Portfolio
- PortfolioMembership
- Plan
- PlanLine
- Forecast
- CalculationRun
- AutomationRule
- AISuggestion
- DomainEvent

---

# 81. Data Ownership Matrix

| Entity | Owner Domain | Canonical? |
|---|---|---|
| Party | Shared Identity | Yes |
| Property | MRE | Yes |
| Unit | — | Yes |
| Lease Definition | MRE | Yes |
| Ownership | Ownership | Yes |
| Acquisition | Acquisition | Yes |
| Transaction | Financial Ledger | Yes |
| TransactionSplit | Financial Ledger | Yes |
| FinancialCategory | Financial Ledger | Yes |
| Loan | Financing | Yes |
| LoanTerms | Financing | Yes |
| WEG | WEG | Yes |
| WEGAnnualStatement | WEG | Yes |
| TaxClassification | Taxation | Yes as interpretation |
| DepreciationAsset | Depreciation | Yes |
| MarketValuation | Investment | Yes as estimate |
| InvestmentMetricSnapshot | Investment | Derived snapshot |
| ScenarioAssumption | Investment | Yes as hypothetical input |
| AI Suggestion | AI | No |

---

# 82. Canonical vs Derived Matrix

## Canonical Actual

- Transaction
- TransactionSplit
- Ownership
- Acquisition
- Loan contract facts
- confirmed WEG statements
- confirmed documents

## Canonical Interpretive

- TaxClassification
- FinancialCategory
- LandBuildingAllocation
- MarketValuation
- LoanAllocation

## Canonical Hypothetical

- ScenarioAssumption
- PlanLine

## Derived

- Remaining Debt
- NOI
- Cashflow
- Equity
- LTV
- DSCR
- CCR
- IRR
- outstanding Security Deposit
- annual depreciation amount

---

# 83. Fields That Must Not Become Independently Editable

The following should normally be derived:

- Remaining Debt
- Security Deposit outstanding amount
- total split amount
- Ownership allocated result
- NOI
- Cashflow
- Equity
- LTV
- DSCR
- CCR
- IRR
- yearly AfA result
- Portfolio total value

If a UI displays them, editing must modify source assumptions or facts rather than the derived result.

---

# 84. Naming Conventions

Logical field names should use English.

German legal concepts may remain German where precision is improved.

Examples:

Preferred:

- `ownershipShare`
- `economicTransferDate`
- `taxYear`
- `marketValuation`

Permitted German-specific domain terms:

- `miteigentumsanteil`
- `Wirtschaftsplan`
- `Jahresabrechnung`
- `Sonderumlage`
- `AfA`

Implementation naming should ultimately choose one consistent code convention.

---

# 85. Nullability Principle

Optional fields must be optional for a reason.

Avoid ambiguous nulls.

For important workflow uncertainty, prefer explicit state.

Example:

Bad:

```text
taxCategory = null
```

without knowing why.

Better:

```text
reviewState = NEEDS_REVIEW
taxCategory = null
```

---

# 86. Status Field Principle

Status values should represent meaningful lifecycle stages rather than generic active/inactive switches.

Every status enum should have documented transition rules.

---

# 87. Soft References vs Strong References

Strong domain relationships should use explicit canonical IDs.

Text labels must not be used as relational identity.

Example:

Preferred:

```text
loanId = "..."
```

Not:

```text
loanName = "ING Loan"
```

as the only relationship.

---

# 88. Referential Integrity

Even if the chosen database does not enforce foreign keys, the application domain must enforce logical referential integrity.

A confirmed TaxClassification may not reference a nonexistent source Entity.

A TransactionSplit may not reference a nonexistent Transaction.

A LoanAllocation may not reference a nonexistent Loan or Property.

---

# 89. Currency Model

The MVP is expected primarily to use EUR.

Nevertheless, the data model must not assume EUR implicitly.

Every Money value carries currency.

Cross-currency investment analysis is deferred.

---

# 90. Time Zone Model

Cash transaction dates are primarily local financial dates rather than timestamps.

System events such as `createdAt` should use timezone-safe timestamps.

The implementation must distinguish:

- business date
- value date
- event timestamp

---

# 91. Data Model Migration Rule

Any change affecting the semantic meaning of a Stable entity requires:

1. explicit migration plan
2. compatibility analysis
3. test coverage
4. ADR if domain semantics change

Field renames alone may not require ADR if meaning remains identical.

---

# 92. Stable Entity Change Rule

Before changing a Stable entity, contributors must ask:

- Is the requirement real or speculative?
- Can it be represented through another existing concept?
- Does this introduce duplicate truth?
- Does this violate an accepted ADR?
- Can the change be backward compatible?

---

# 93. Anti-Pattern: Tax Fields on Transaction

Avoid structures such as:

```text
Transaction
taxDeductible = true
taxCategory = ...
afaRelevant = ...
```

as the primary tax model.

Tax interpretation belongs to TaxClassification.

---

# 94. Anti-Pattern: Loan Balance as Editable Field

Avoid:

```text
Loan.currentBalance = manually editable
```

Preferred:

```text
Remaining Debt = derived from financing facts
```

External balances may exist as reconciliation evidence.

---

# 95. Anti-Pattern: Duplicate MRE Property

Avoid maintaining a second full Property entity containing copied MRE data.

Use PropertyReference plus domain-specific extension data.

---

# 96. Anti-Pattern: Market Value on Property Core

Avoid:

```text
Property.currentMarketValue
```

as the sole value history.

Use dated MarketValuation records.

---

# 97. Anti-Pattern: Scenario Mutating Actual

Never implement:

```text
Scenario.apply()
→ overwrites canonical rent or value
```

Scenario results remain isolated.

---

# 98. Anti-Pattern: Kaution as Rent

Security Deposit inflows must not map to ordinary rental-income categories.

---

# 99. Data Model Open Decisions

Several items below have since been resolved by accepted ADRs (noted per item). The remainder are implementation-level details.

## DM-OPEN-001

Concrete canonical identifier type.

Options may include UUID, ULID, ObjectId or another stable form. (Implementation-level; still open.)

---

## DM-OPEN-002

Storage technology.

**Resolved by ADR-031:** the DE layer uses PostgreSQL; MRE retains its MongoDB.

---

## DM-OPEN-003

Whether Party identity is physically stored in a new shared data store or partly synchronized with MRE.

The domain decision for a shared Party entity is already accepted (ADR-009). Physical storage/sync is an implementation detail.

---

## DM-OPEN-004

Strict append-only enforcement for confirmed Transactions.

**Resolved by ADR-037:** confirmed Transactions are immutable (append-only); corrections use a reversal + replacement record.

---

## DM-OPEN-005

Exact Loan Allocation methodology for shared financing.

**Resolved by ADR-038:** one explicit percentage per PropertyReference (sum 100%), defaulted from financed amount, user-overridable, uniform across principal/interest/debt.

---

## DM-OPEN-006

Document binary storage backend.

**Resolved by ADR-035:** pluggable `DocumentStorage`, local filesystem default; canonical metadata in PostgreSQL.

---

## DM-OPEN-007

TaxRule implementation format.

**Resolved by ADR-041:** versioned, unit-tested code modules (not a generic rule engine).

---

## DM-OPEN-008

Metric Snapshot trigger policy.

**Resolved by ADR-040:** on-demand + tax-year end; periodic/on-change deferred.

---

## DM-OPEN-009

Exact utility-settlement model and German operating-cost rule implementation.

Rule *format* is resolved by ADR-041; the operating-cost domain is drafted in `docs/germany/rent-and-operating-costs.md` (pending legal verification). The exact settlement data model remains an implementation detail.

---

# 100. MVP Data Integrity Checklist

Before an MVP release, the system must be able to prove:

- no confirmed Transaction has unexplained split remainder
- no duplicate canonical MRE Property exists
- no Security Deposit is classified as ordinary Rental Income
- every confirmed Acquisition allocation reconciles
- every confirmed depreciation schedule is reproducible
- every investment snapshot identifies formula version
- Ownership history can be reconstructed
- shared Loans are not duplicated per Property
- TaxClassification references canonical source data
- Scenario data cannot overwrite Actual data

---

# 101. Implementation Guidance for AI Coding Agents

When implementing this model, AI agents must:

- preserve domain ownership
- avoid inventing new duplicate entities
- not embed tax rules inside Ledger records
- not copy MRE entities into new canonical entities
- not turn derived metrics into editable fields
- surface conflicts with accepted ADRs
- use explicit references instead of name matching
- write migration-safe code
- preserve historical validity
- treat Stable entities as architectural contracts

If an implementation appears simpler by violating this model, the implementation is wrong unless the model is explicitly amended first.

---

# 102. Final Data Model Principle

The data model should preserve the chain:

```text
Real-world activity
        ↓
Canonical domain facts
        ↓
Financial interpretation
        ↓
Tax interpretation
        ↓
Investment calculation
        ↓
Reports and decisions
```

Each level adds meaning.

No level should duplicate or overwrite the truth of the level below.

---

# Closing Statement

The logical data model of Vermieter Cockpit DE is designed to capture the economic lifecycle of long-term real estate ownership while keeping operational management, financial reality, taxation and investment analysis clearly separated.

Its most important characteristics are:

- MRE remains the operational property-management core.
- Party provides shared identity.
- Ownership is legal and temporal.
- Acquisition is a first-class Aggregate Root.
- The Ledger records actual cash only.
- Transaction Splits express economic meaning.
- Loans may span multiple Properties.
- Security Deposits remain distinct from income.
- WEG is modeled as a dedicated German domain.
- Taxation interprets rather than duplicates.
- Depreciation is reproducible and versioned.
- Market values are dated estimates.
- Investment metrics are derived but may be snapshotted.
- Actual, Plan and Scenario remain isolated.
- Historical facts remain reconstructable.

The objective is not to model every theoretical edge case.

The objective is to provide the simplest model that correctly represents common real-world private residential real estate investment while remaining extensible when actual needs require it.

> Reference rather than duplicate.  
> Split rather than blur.  
> Derive rather than manually maintain.  
> Preserve history rather than overwrite it.  
> Extend only when reality requires it.
