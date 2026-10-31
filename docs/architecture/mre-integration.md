# MicroRealEstate Integration

**Project:** Vermieter Cockpit DE *(working title)*  
**Version:** 0.1  
**Status:** Living Document  
**Document Type:** Integration Architecture Specification  
**MRE Repository:** `microrealestate/microrealestate`  
**MRE Reference Branch:** `master`  
**MRE Reference Commit:** `479d0ad703436071b64dfdf4e48321c121d8efb5`  
**Inspection Date:** 2026-08-13

---

# 1. Purpose

This document defines how Vermieter Cockpit DE integrates with MicroRealEstate (MRE).

Its primary purpose is to ensure that the project builds on the **actual MRE data model and API behavior**, rather than on assumptions about what a generic property-management system might look like.

This document defines which MRE entities are authoritative, which project entities reference MRE, where reconciliation is required, where new DE Investment Layer entities are required, and which similar-looking MRE concepts must explicitly not be reused.

---

# 2. Governing Principle

> Reuse MRE where the meaning matches.  
> Reference MRE where MRE owns the entity.  
> Reconcile where MRE and the DE layer represent different views of the same event.  
> Extend only where necessary.  
> Never reuse an MRE concept for a different domain meaning.

---

# 3. Integration Strategies

## REUSE

The MRE entity or capability already represents the required concept sufficiently well.

## REFERENCE

MRE remains canonical. The DE layer stores a stable reference plus domain-specific extension data.

## RECONCILE

MRE and the DE layer each represent a different aspect of the same real-world event. Neither replaces the other.

## EXTEND

A small adapter or generic extension is required.

## NEW

The concept does not exist in MRE with the required semantics and belongs in the DE layer.

## AVOID

An MRE concept has a similar name but incompatible semantics and must not be reused.

---

# 4. MRE Architecture Observed

The inspected MRE repository contains separate landlord and tenant applications plus backend services including:

- gateway
- authenticator
- API
- tenant API
- emailer
- PDF generator

The landlord API is exposed under `/api/v2` and provides routes for:

- realms
- properties
- tenants
- leases
- rents
- accounting
- CSV exports
- emails

Supported API boundaries should be preferred over direct database access wherever practical.

---

# 5. Persisted MRE Core Entities

The inspected shared collection model contains the relevant persisted concepts:

- `Account`
- `Realm`
- `Property`
- `Tenant`
- `Lease`
- `Document`
- `Template`
- `Email`

MRE does not currently provide canonical equivalents for our planned:

- Financial Transaction
- Transaction Split
- Financial Account
- Ownership
- Acquisition
- Loan
- WEG
- Tax Classification
- Depreciation Asset
- Market Valuation
- Investment Scenario
- Investment Metric Snapshot

Those remain DE-layer responsibilities.

---

# 6. Critical Modeling Correction

Our earlier abstract model assumed roughly:

```text
Property
  └── Unit
       └── Lease
            └── Tenant
```

The inspected MRE model is materially different:

```text
Realm
│
├── Property
├── Lease Definition
└── Tenant / Occupant
     ├── leaseId
     ├── beginDate / endDate / terminationDate
     ├── properties[]
     │    ├── propertyId
     │    ├── embedded property snapshot
     │    ├── rent
     │    ├── expenses[]
     │    ├── entryDate
     │    └── exitDate
     ├── rents[]
     │    ├── contractual amounts
     │    ├── charges
     │    ├── debts
     │    ├── discounts
     │    ├── VAT
     │    ├── payments[]
     │    └── totals
     ├── guaranty
     └── guarantyPayback
```

This is the integration baseline.

---

# 7. MRE Property

**Strategy:** REFERENCE  
**Canonical Owner:** MRE

MRE `Property` contains operational rental information including:

- type
- name
- description
- surface
- address
- price

MRE assigns Properties directly to Tenant records and derives occupancy by examining Tenant property assignments.

Therefore MRE Property behaves as the **rentable operational object**.

For the initial condominium use case, one MRE Property should normally represent the apartment itself.

---

# 8. Unit Decision

**Strategy:** DEFER / REMOVE FROM MVP

The inspected MRE core has no separate canonical Unit entity.

The DE layer must not introduce a `UnitReference` merely to preserve our earlier abstract hierarchy.

If future use cases require a building containing several apartments, the project should introduce a deliberate higher-level Asset/Building model through a future ADR.

---

# 9. PropertyReference

Recommended logical reference:

```text
PropertyReference
├── id
├── mreRealmId
├── mrePropertyId
└── optional cached display metadata
```

Cached MRE fields are non-authoritative.

---

# 10. MRE Tenant

**Strategy:** REFERENCE  
**Canonical Owner:** MRE

MRE Tenant is not merely a person record. It combines substantial concrete rental-contract state, including:

- person/company information
- contacts
- contract reference
- lease definition reference
- contract dates
- assigned Properties
- rent per Property
- contractual expenses
- entry/exit dates
- generated rent terms
- operational payment records
- guaranty and guaranty payback

The Mongoose model is named `Occupant`, while shared types and API use Tenant terminology.

---

# 11. Shared Party Mapping

**Strategy:** EXTEND THROUGH ADAPTER  
**Canonical DE Entity:** `Party`

The accepted DE architecture still requires a shared Party abstraction.

Recommended mapping:

```text
Party
└── PartyExternalReference
     ├── system = MRE
     ├── mreRealmId
     ├── entityType = tenant
     └── externalId = MRE Tenant _id
```

The Party does not replace MRE Tenant.

A Party may additionally act as Owner, Borrower, Lender, Contractor or Tax Advisor.

Because MRE Tenant also contains rental-contract state, one real person may potentially map to multiple MRE Tenant records over time. The mapping layer must permit that.

---

# 12. MRE Lease

**Strategy:** REFERENCE WITH CORRECTED SEMANTICS

MRE Lease stores primarily:

- name
- description
- number of terms
- time range
- active state

When a Lease is used by a Tenant, MRE restricts structural modification.

Therefore MRE Lease should be interpreted as a **reusable lease definition / term model**, not the complete concrete tenant contract.

---

# 13. RentalContractReference

The concrete rental relationship is primarily represented by MRE Tenant plus its Lease definition.

Replace the earlier `LeaseReference` concept with:

```text
RentalContractReference
├── id
├── mreRealmId
├── mreTenantId
├── mreLeaseDefinitionId
└── contractReference
```

MRE remains authoritative for the rental relationship.

---

# 14. Rent Schedule

**Strategy:** REUSE

MRE generates contractual rent terms when Tenant/property contract data is created or changed.

Rent terms include contractual amounts, charges, discounts, VAT, debts, payments and totals.

MRE therefore already provides the operational equivalent of our expected `Rent Obligation` / rent schedule.

Do not duplicate it in the DE layer.

---

# 15. MRE Payment Records

**Strategy:** RECONCILE

MRE embeds payment records inside Tenant rent terms.

A payment contains operational fields such as:

- date
- method
- reference
- amount

Updating payment status through the MRE API modifies Tenant rents and triggers MRE contract/balance recomputation.

---

# 16. MRE Payment Is Not a DE Transaction

MRE rent payments are **operational settlement records**.

The DE Financial Ledger requires richer semantics:

- FinancialAccount provenance
- booking date
- value date
- bank import identity
- counterparty
- canonical transaction identity
- Transaction Splits
- status and reconciliation
- links to financing, WEG, tax and investment

Therefore:

> MRE Payment = operational rent settlement record.  
> DE Transaction = canonical actual cash movement.

Neither replaces the other.

---

# 17. RentPaymentReconciliation

Introduce a new DE integration entity:

```text
RentPaymentReconciliation
├── id
├── mreRealmId
├── mreTenantId
├── mreRentTerm
├── mrePaymentFingerprint
├── transactionId
├── transactionSplitId
├── matchedAmount
├── status
├── matchedAt
├── matchedBy
├── confidence
└── notes
```

Suggested states:

- UNMATCHED
- SUGGESTED
- MATCHED
- PARTIALLY_MATCHED
- CONFLICT
- IGNORED

---

# 18. Reconciliation Flow

```text
MRE Rent Term
      │
      ├── amount due
      └── operational payment status
                ▲
                │ reconciliation
                ▼
DE Financial Transaction
      │
      └── Transaction Split → Rental Income
```

A future workflow may update MRE payment state after a confirmed bank match, but the Ledger must never depend on MRE settlement state as its source of cash truth.

---

# 19. Relevant MRE Rent API

Observed routes:

```text
PATCH /api/v2/rents/payment/:id/:term
GET   /api/v2/rents/tenant/:id
GET   /api/v2/rents/tenant/:id/:term
GET   /api/v2/rents/:year/:month
```

Use these interfaces rather than directly mutating `Tenant.rents`.

---

# 20. Relevant MRE Tenant API

```text
GET    /api/v2/tenants
GET    /api/v2/tenants/:id
POST   /api/v2/tenants
PATCH  /api/v2/tenants/:id
DELETE /api/v2/tenants/:ids
```

MRE remains canonical for tenant rental operations.

## 20.1 Tenant existence (VC-2-02, baseline `479d0ad`)

- DE reads Tenants only to check that an MRE Tenant exists in the Realm before referencing it from a Party (api-design §20.1). Field read: `_id` (24-hex ObjectId). Nothing else is copied (P2-D1).
- **Quirk, as for properties (§21.1):** `GET /tenants/:id` answers **500**, not 404, for an id that does not exist in the Realm (`toOccupantData(null)` fails on the missing document), and for a non-ObjectId (`ObjectId(...)` throws). DE therefore decides existence via `GET /tenants` of the Realm and validates `externalId` against `^[0-9a-f]{24}$` at its API boundary.
- `GET /tenants` has **no filter** and no paging: `all()` → `_fetchTenants(realmId)` ignores any query parameter (`?_id=` included) and returns every Tenant of the Realm. DE loads the full list and checks **client-side** for an entry with `_id === externalId`; taking any first element would accept every id in a Realm with Tenants. The response holds personal data (and per-Tenant lookups, so it can be large): DE keeps only the `_id`s and never logs the body (technology.md §37).
- The headers are the same as for properties (`Authorization: Bearer <landlord token>`, `organizationid`). VC-2-02 pins this in the contract suite (`mre.contract.test.ts`, CI job `compose-smoke`): a created Tenant is listed in its Realm and not in another; `GET /tenants/:id` with an unknown id is not a 404; and in DE, a valid but unknown `externalId` in a Realm **with** Tenants is `404`.

---

# 21. Relevant MRE Property API

```text
GET    /api/v2/properties
GET    /api/v2/properties/:id
POST   /api/v2/properties
PATCH  /api/v2/properties/:id
DELETE /api/v2/properties/:ids
```

The DE layer should consume these entities rather than maintain a competing Property master.

## 21.1 Pinned contract (VC-0-09, baseline `479d0ad`)

Verified against the real MRE images by `services/de-backend/src/integrations/mre/mre.contract.test.ts` (CI job `compose-smoke`); an MRE upgrade must keep this suite green (§55). The suite writes accounts, Realms and properties — never point `MRE_CONTRACT_API_URL` at a shared or production MRE.

- All property calls need `Authorization: Bearer <landlord token>` and `organizationid: <realmId>`; a missing `organizationid` is answered with **404**.
- Fields DE reads for `PropertyReference` (data-model §9): `_id` (24-hex ObjectId), `name`, optional `surface` (number) and `address { street1, zipCode, city, country, … }`. `price` is a JS number and is **not** used as Money (§32).
- `GET /properties` returns only the Realm's properties (Realm isolation holds upstream).
- **Quirk:** `GET /properties/:id` for an id that does not exist in the given Realm does **not** return 404 — the handler fails on the missing document and answers **500**. DE must therefore decide existence (link → `404` in api-design §23.1) via `GET /properties` filtered by id, and must not map a 5xx of the single-item endpoint to "not found". A non-ObjectId id also ends in 500 upstream (`CastError`), so DE validates `mrePropertyId` against `^[0-9a-f]{24}$` at its API boundary (400). Implemented in VC-1-01 as `MreClient.listProperties` (pinned by the contract suite).

---

# 22. Relevant MRE Lease API

```text
GET    /api/v2/leases
GET    /api/v2/leases/:id
POST   /api/v2/leases
PATCH  /api/v2/leases/:id
DELETE /api/v2/leases/:ids
```

Structural fields of used Lease definitions are protected by MRE and must not be bypassed.

---

# 23. MRE Accounting Manager

**Strategy:** REUSE FOR OPERATIONAL REPORTING / RECONCILIATION

MRE exposes yearly accounting-oriented information including:

- incoming tenants
- outgoing tenants
- guaranty
- guaranty payback
- monthly settlement/payment information
- tenant balances

It also exposes CSV exports.

This capability is useful for migration and reconciliation, but it is **not German tax accounting** and must not replace the DE Taxation domain.

Observed routes:

```text
GET /api/v2/accounting/:year
GET /api/v2/csv/tenants/incoming/:year
GET /api/v2/csv/tenants/outgoing/:year
GET /api/v2/csv/settlements/:year
```

---

# 24. MRE Realm

**Strategy:** REUSE / REFERENCE

Realm functions as MRE's landlord/organization workspace and contains:

- members
- addresses
- contacts
- company information
- locale
- currency
- integrations
- simple bank information

Every MRE external reference in the DE layer should preserve `realmId`.

An MRE entity ID must not be assumed globally meaningful without Realm context.

---

# 25. MRE Account vs FinancialAccount

MRE `Account` represents an authenticated user account.

Our earlier `Account` entity represented a bank/cash account.

This naming collision is unacceptable.

**Required change:** rename the DE entity to:

> `FinancialAccount`

MRE `Account` remains an authentication/user concept.

---

# 26. FinancialAccount

MRE Realm contains simple bank metadata (`name`, `iban`), but this is insufficient for the DE Ledger.

FinancialAccount remains a NEW DE entity because it must support:

- account lifecycle
- canonical Transactions
- account holder
- institution
- reconciliation
- optional IBAN
- future bank import/API metadata

Do not reuse Realm.bankInfo as the Ledger account entity.

---

# 27. User vs Party

Do not equate:

```text
MRE Account == Party
```

Not every Party is a user, and not every real-world Party needs authentication.

Use explicit mappings where required.

---

# 28. MRE Documents

**Strategy:** REFERENCE / REUSE FOR RENTAL DOCUMENTS

MRE Document is strongly rental-oriented and references:

- Realm
- Tenant
- Lease
- Template

It stores either text or file metadata, including URL/version information.

This works well for rental documents but cannot represent all DE Investment Layer relationships without invasive MRE changes.

---

# 29. Generic DE Document Metadata

Keep a generic DE `Document` abstraction capable of relating one file to:

- Acquisition
- Loan
- WEG
- Transaction
- MaintenanceProject
- Tax year
- Depreciation Asset
- Market Valuation

A DE Document may point to an external MRE Document rather than copy the binary.

Conceptually:

```text
DocumentSource
├── sourceSystem = MRE
├── realmId
├── mreDocumentId
├── mreVersionId
└── source reference
```

---

# 30. MRE Template / PDF Generator

**Strategy:** REUSE WHERE PRACTICAL

MRE Template and PDF-generation capabilities should continue to handle rental contracts, notices and other rental-specific documents.

The PDF generation infrastructure may potentially also serve DE reports.

Do not force Tax, WEG or Investment reporting semantics into MRE Lease templates merely to reuse the infrastructure.

---

# 31. Security Deposit / Guaranty

**Strategy:** RECONCILE

MRE Tenant already contains:

- `guaranty`
- `guarantyPayback`

These represent useful operational deposit amounts.

Our DE `SecurityDeposit` remains necessary because it owns the actual financial lifecycle (phase-5-plan P5-D1…D8,
api-design §47):

- `mreTenantId`: the Tenant by id only; its name and contact data are not stored (P5-D1);
- `expectedAmount`: given on create, or copied **once** from `guaranty` (rounded half-up to the cent, `0` = not set),
  never followed afterwards;
- the holding account (a `SECURITY_DEPOSIT` FinancialAccount, P5-D4);
- the linked cash: receipt, interest and repayment splits (P5-D3); payer and IBANs stay on those Transactions, not on
  the deposit.

DE reads the two fields from the Realm's Tenant list `GET /api/v2/tenants` and picks the Tenant by `_id`, as for the
Party references (§20.1): at the baseline `GET /api/v2/tenants/:id` answers `500` for an unknown or malformed id.
`guarantyPayback` is read only for the comparison of P5-D7 (`checkMre`, VC-5-04); a missing value reads as `null`.
DE never writes either field.

Mapping:

```text
MRE Tenant.guaranty
        │
        └── expected / operational deposit amount

DE SecurityDeposit
        │
        ├── financial lifecycle
        └── Ledger Transactions
```

Security Deposit cash must never become Rental Income.

---

# 32. MRE Property.price

MRE Property `price` acts as rental pricing metadata and is used as a default rent amount in Tenant/property assignment logic.

It must **not** be interpreted as:

- acquisition purchase price
- market value
- tax value

Acquisition purchase price belongs in DE `Acquisition`.

Market value belongs in DE `MarketValuation`.

---

# 33. MRE Tenant Property Expenses

Expenses embedded under `Tenant.properties[]` are contractual rental charges/expenses for the tenant relationship.

Do not confuse them with:

- actual owner cash expenses
- WEG cost lines
- tax deductions

These concepts may later be reconciled during utility settlement, but they remain semantically distinct.

---

# 34. Occupancy

MRE derives Property occupancy and occupancy history from Tenant assignments.

**Strategy:** REUSE

Investment analytics should consume this operational occupancy information where practical rather than maintain a competing tenancy calendar.

Vacancy metrics remain derived Investment metrics.

---

# 35. Expected vs Actual Rental Revenue

Expected rental revenue should derive from MRE rental contract/rent-term data.

Actual rental revenue should derive from confirmed DE Ledger Transactions.

This enables a first-class comparison:

```text
Expected Rent
vs
Actual Cash Collected
```

---

# 36. Integration Mapping Matrix

| Project Concept | MRE Equivalent | Strategy | Canonical Owner | Notes |
|---|---|---|---|---|
| Property | Property | REFERENCE | MRE | Rentable operational object |
| Unit | None | DEFER | — | Do not invent for MVP |
| Party | Tenant partly | MAP/EXTEND | DE Party | Shared identity across roles |
| Rental Contract | Tenant + Lease | REFERENCE | MRE | Concrete relationship centered on Tenant |
| Lease Definition | Lease | REUSE | MRE | Reusable term definition |
| Rent Obligation | Tenant.rents | REUSE | MRE | Operational schedule |
| Rent Payment | Tenant.rents.payments | RECONCILE | MRE operational | Not bank truth |
| Financial Transaction | None | NEW | DE Ledger | Canonical cash |
| Transaction Split | None | NEW | DE Ledger | First-class |
| FinancialAccount | Realm.bankInfo partly | NEW | DE Ledger | Rename from Account |
| User Account | Account | REUSE | MRE | Authentication |
| Workspace | Realm | REUSE | MRE | Realm context required |
| Ownership | None | NEW | DE | Temporal legal ownership |
| Acquisition | None | NEW | DE | Aggregate Root |
| Loan | None | NEW | DE | Multi-property capable |
| WEG | None | NEW | DE | German domain |
| Security Deposit | guaranty/payback | RECONCILE | DE financial | MRE stores operational amounts |
| Rental Document | Document | REUSE/REFERENCE | MRE | |
| Generic Investment Document | None sufficient | NEW/REFERENCE | DE | Can reference MRE binary |
| Maintenance Project | None | NEW | DE | |
| Tax Classification | None | NEW | DE | |
| Depreciation | None | NEW | DE | |
| Market Valuation | None | NEW | DE | Never use Property.price |
| Investment Metrics | None | NEW | DE | Derived |
| Portfolio | None | NEW | DE | Post-MVP |
| AI Suggestion | None | NEW | DE | Non-authoritative |

---

# 37. Required Documentation Amendments

The MRE inspection requires the following refinements to earlier project documents.

## `data-model.md`

1. Rename `Account` → `FinancialAccount`.
2. Replace `LeaseReference` → `RentalContractReference`.
3. Move `UnitReference` out of required MVP entities.
4. Add `RentPaymentReconciliation`.
5. Add `mreRealmId` to MRE reference structures.
6. Explicitly state that MRE Property.price is rental pricing metadata.
7. Clarify SecurityDeposit reconciliation with MRE guaranty/payback.

## `domain-model.md`

1. Correct the assumed Property/Unit hierarchy.
2. Correct Lease semantics.
3. Add reconciliation between MRE operational payment state and DE cash.

## `glossary.md`

1. Introduce `FinancialAccount`.
2. Introduce `RentalContractReference`.
3. Clarify MRE Property semantics.

## `architecture-decisions.md`

Add formal decisions for:

- FinancialAccount naming
- MRE Property as rentable object
- RentalContractReference
- RentPaymentReconciliation

---

# 38. Direct Database Access Policy

The DE layer should avoid direct writes to MRE MongoDB collections.

Especially avoid direct mutation of:

- `Tenant.rents`
- Property records
- Tenant contract state

MRE's domain code recomputes rent schedules and protects paid history. Direct writes could bypass these invariants.

Use MRE APIs/domain operations wherever practical.

---

# 39. Sync Direction

## Rental Operations

```text
MRE → DE references and analytics
```

## Bank Data

```text
Bank → DE Ledger
```

## Rent Settlement

```text
DE Transaction
→ confirmed reconciliation
→ optional MRE payment update
```

## Tax / Investment

```text
DE only
```

Tax and investment state must not contaminate generic MRE entities.

---

# 40. MVP Integration Approach

Recommended first implementation:

1. Deploy a pinned MRE version without invasive changes.
2. Build the DE backend separately.
3. Implement an authenticated MRE API client.
4. Reference Realm and Property IDs.
5. Map MRE Tenant identities to Party.
6. Create RentalContractReference.
7. Implement FinancialAccount and Ledger.
8. Import bank Transactions.
9. Reconcile bank Transactions against MRE rent terms.
10. Reconcile SecurityDeposit against MRE guaranty information.
11. Add Financing, WEG, Tax and Investment domains afterward.

No event bus is required for MVP.

---

# 41. MRE Payment Identity Limitation

Embedded MRE payments do not appear to have a dedicated stable payment ID in the inspected model.

Reconciliation may therefore require a fingerprint from:

- realmId
- tenantId
- rent term
- date
- amount
- payment method
- reference

This is less robust than a stable identifier.

---

# 42. Potential Upstream Contribution: Payment ID

A generic stable ID on each MRE rent payment would improve:

- external reconciliation
- auditability
- payment updates
- integrations

This is a good candidate for a generic upstream contribution rather than a private DE-specific patch.

---

# 43. Potential Upstream Contribution: Webhooks

Generic events such as:

- PropertyUpdated
- TenantUpdated
- RentPaymentUpdated

could improve future synchronization.

They are not required for MVP.

---

# 44. Potential Upstream Contribution: External References

Optional generic external-reference metadata on key MRE entities may be useful to integrations broadly.

This should only be proposed if the design remains generic and upstream-compatible.

---

# 45. MRE Deletion Behavior

MRE prevents deletion of Tenants with paid rents/settlement history, which aligns with our auditability principles.

Properties can be deleted more freely in the inspected implementation.

Therefore external references should support missing/deleted upstream states without deleting DE financial history.

Suggested state:

- ACTIVE
- MISSING
- DELETED_UPSTREAM
- UNRESOLVED

---

# 46. Realm Isolation

Every MRE integration operation must preserve Realm authorization context.

The DE layer must not allow accidental cross-Realm reads or writes.

This becomes a formal security and integration-test requirement.

---

# 47. Authentication Direction

Strong architectural preference:

> Reuse MRE authentication and Realm authorization rather than create separate user credentials for DE modules.

The authentication direction is accepted (ADR-034 / TECH-ADR-005: reuse MRE authentication and Realm authority). The exact token/session propagation mechanism is an **implementation spike** to be resolved against the pinned MRE authenticator/gateway during scaffolding — it is not a new architecture decision.

## 47.1 Resolved mechanism (spike VC-0-06, pinned baseline `479d0ad`)

Observed in MRE:

- The authenticator issues landlord **access tokens** as HS256 JWTs signed with `ACCESS_TOKEN_SECRET`, payload `{ account: { email, … } }` (no role), valid **30 s**, refreshed via a refresh token. Tenant **session tokens** use the same secret with `{ account: { email, role: 'tenant' } }`; application credentials use `{ application: { clientId } }`, internal services `{ service: { … } }`.
- The landlord API (`/api/v2`, behind the gateway) runs `needAccessToken` → `checkOrganization` → `notRoles(['tenant'])`. `GET /api/v2/realms` returns the Realms whose `members[].email` equals the token's account email (secrets stripped), `401` for a missing/invalid/expired token and `403` for a tenant token. Members carry `role: 'administrator' | 'renter'`.

Mechanism used by DE (**delegated verification**):

1. The landlord UI sends the MRE access token as `Authorization: Bearer …` and the Realm as an explicit parameter.
2. DE forwards the token to MRE `GET /api/v2/realms` (`integrations/mre/http-mre-client.ts`). MRE verifies signature and expiry; DE does **not** hold `ACCESS_TOKEN_SECRET`, stores no credentials and does not read MRE MongoDB (§38).
3. Only after MRE accepted the token, DE reads its claims and accepts **landlord user tokens only** (`account.email`, role not `tenant`); tenant, application and service tokens are rejected (§48).
4. DE checks server-side that the requested Realm is in the returned list and that the caller is a member; the result is a `VerifiedMrePrincipal { email, mreRealmId, mreRole }` (`integrations/mre/mre-auth.ts`). A known Realm ID alone grants nothing.
5. If MRE is unreachable or answers unexpectedly, the request fails (`MRE_UNAVAILABLE`), it is never treated as authenticated.

Details: the `Bearer` scheme is matched case-insensitively (RFC 7235); the MRE call never follows redirects (a redirect means a misconfigured gateway → `MRE_UNAVAILABLE`); a structurally invalid realms response is rejected as a whole, while a single member with an unknown role or shape is dropped (it gets no access, other Realms stay usable). Application and service tokens are answered by MRE with `200` and their realm — only DE's landlord-account check refuses them, which the end-to-end test covers.

Consequences: one MRE call per verification; emails are compared exactly, as MRE does. **Verification cache (issue #161, `cachingPrincipalVerifier` in `wiring.ts`):** a successful verification is kept per (token, Realm), keyed by the token's SHA-256, until the token's `exp` and at most 30 s; a token without `exp` is not cached; rejections (401/403/503) are never cached; at most 1,000 entries, least recently used dropped first; concurrent requests for one key share one MRE call; per process only, no shared cache. The cache measures expiry with DE's own clock, so under clock skew between DE and the authenticator an entry may outlive the token's `exp` by that skew, at most 30 s. The role check (`assertDeAccess`) still runs on every request. A role change in MRE therefore reaches DE within 30 s at most. **DE access policy (VC-0-08, decided 2026-10-18 by the project owner — record: [PR #6 decision comment](https://github.com/DanielUtsch85/vermieter-cockpit/pull/6#issuecomment-6250297469)):** the MRE Realm role `administrator` has full access to all DE data; `renter` has **no** DE access until a narrower policy is specified; unknown roles are denied (`application/access.ts`). The Realm is passed in the `organizationid` header, as for the MRE landlord API (API-OPEN-002); every route under `/api/v1` is guarded (401 no/invalid token, 403 not a member or no DE role, 503 MRE unavailable). The CI `compose-smoke` job proves this against the real pinned MRE images (signup → signin → Realm → `/api/v1/health`: administrator 200, foreign Realm 403, renter 403, no token 401). Follow-ups: log unexpected guard errors once a logger exists; each request with a formally valid JWT costs one MRE call — the bounded cache above is in place (issue #161); rate limiting remains open (VC-X-10) and is still required before exposing DE beyond localhost.

## 47.2 Session contract for clients (issue #161)

What a DE client (the cockpit interface) must do with the MRE session, from the pinned baseline's authenticator (`services/authenticator/src/routes/landlord.js`, `index.js`):

1. **No DE login.** Sign-in runs through the MRE authenticator (`POST /api/v2/authenticator/landlord/signin`). MRE access tokens live 30 s; the client renews them with `POST /api/v2/authenticator/landlord/refreshtoken` and keeps the access token in memory only, never in `localStorage` or a cookie of its own.
2. **One origin is a prerequisite.** The refresh token is a cookie with `httpOnly` and `sameSite: strict`, so only a page on the same origin can renew. Recommended reverse-proxy layout: `/` and `/api/v2` to the MRE gateway, `/api/v1` to the DE backend, `/cockpit` to the interface. CORS is therefore not needed, and DE does not provide it.
3. **Realm choice** comes from `GET /api/v2/realms`. The chosen Realm id is sent as the `organizationid` header on every `/api/v1` call and belongs in the interface's URL, not in `localStorage`.
4. **Answers:** `401` means renew the token and retry once (a second `401` means sign in again); `403` means the caller has no DE role in this Realm. The client must not switch to another Realm on its own. `503` means MRE cannot be reached; show it, do not retry in a loop.
5. **What DE never does:** hold MRE secrets, issue tokens, or read refresh tokens. DE sees only the access token in the `Authorization` header and verifies it per §47.1.

---

# 48. Tenant-Facing Boundary

The MRE tenant-facing API should remain isolated from owner-only DE information.

The following must not become tenant-visible by accident:

- owner financing
- tax classifications
- AfA
- owner WEG financial information
- Investment metrics
- acquisition economics

---

# 49. Integration Testing Requirements

Minimum test coverage should include:

- Realm-aware Property reference
- Tenant → Party mapping
- RentalContractReference mapping
- rent-term retrieval
- exact rent payment match
- partial payment match
- multiple Transactions against one rent term
- overpayment/conflict
- Tenant termination
- Tenant contract update preserving paid history
- SecurityDeposit mapping
- deleted upstream reference handling
- Realm isolation

---

# 50. Reconciliation Examples

## Exact Match

```text
Expected rent: 1,250 EUR
Bank inflow:   1,250 EUR

→ MATCHED
```

## Partial Payment

```text
Expected rent: 1,250 EUR
Bank inflow:     800 EUR

→ PARTIALLY_MATCHED
```

## Multiple Payments

```text
Expected rent: 1,250 EUR
Bank inflows:    700 EUR + 550 EUR

→ multiple Transactions reconcile to one rent term
```

## Combined Transfer

One bank movement may contain more than one economic meaning.

Use Transaction Splits before reconciling the rental component.

---

# 51. Migration Principle

Existing MRE operational payment data must not automatically become authoritative historical bank Transactions.

Preferred migration:

1. reference MRE Properties and Tenants
2. import historical bank records where available
3. reconcile against MRE payment history

If Transactions must ever be synthesized from MRE records, provenance must explicitly indicate that they are migration-derived rather than bank-verified.

---

# 52. Source-of-Truth Matrix

| Information | Source of Truth |
|---|---|
| Operational Property | MRE Property |
| Tenant operational data | MRE Tenant |
| Concrete rental relationship | MRE Tenant + Lease definition |
| Expected rent | MRE rents |
| Operational rent payment status | MRE rent payment records |
| Actual cash movement | DE Financial Ledger |
| Financial split | DE TransactionSplit |
| Ownership | DE Ownership |
| Acquisition | DE Acquisition |
| Loan | DE Financing |
| Security deposit financial lifecycle | DE SecurityDeposit |
| WEG | DE WEG |
| Tax interpretation | DE Taxation |
| AfA | DE Depreciation |
| Market value | DE MarketValuation |
| Investment metrics | DE Investment |
| User authentication | MRE Account / Authenticator |
| Workspace / organization context | MRE Realm |

---

# 53. Integration Anti-Patterns

Do not:

- rebuild a full Tenant model in the DE layer
- treat MRE payment records as bank truth
- use MRE Property.price as market or acquisition value
- use MRE Account as a financial account
- mutate MRE internal MongoDB structures from DE code where an API exists
- invent a Unit hierarchy for MVP
- put German tax logic into MRE
- put WEG fields onto generic MRE Property
- copy MRE embedded Property snapshots as canonical data

---

# 54. Recommended Technical Boundary

```text
                     Browser
                        │
               Integrated Landlord UI
                        │
          ┌─────────────┴─────────────┐
          │                           │
       MRE API                    DE Backend
          │                           │
          │                     Financial Ledger
          │                     Financing
          │                     WEG
          │                     Tax
          │                     Investment
          │                           │
          └──── references/reconcile ─┘
```

The user may experience one application even if persistence and business-domain ownership remain separated.

---

# 55. Version Compatibility

Production must pin a known-compatible MRE commit or release.

Do not automatically deploy upstream `master`.

Each MRE upgrade should run:

- API compatibility tests
- schema/reference tests
- rent reconciliation regression tests
- authentication tests
- UI integration tests

Maintain a compatibility record containing MRE version and compatible DE version.

---

# 56. Fork Policy

A project fork may be maintained for controlled integration and release purposes.

However:

- the fork must remain close to upstream
- DE domain logic should remain outside MRE core files
- generic improvements should be proposed upstream where practical
- convenience is not sufficient reason to diverge

The fork uses the following branch policy:

- `master` tracks `microrealestate/microrealestate` as closely as possible
- `feature/...` or `mre-patch/...` branches are reserved for small, isolated MRE changes
- patches should remain minimal and upstream-worthy where practical
- synchronization should preserve fast-forward/rebase-friendly history and avoid unnecessary merge commits
- DE product development belongs in the separate `vermieter-cockpit` repository

For example, an isolated rent-payment API patch would use `mre-patch/rent-payment-api`.

---

# 57. Open Integration Decisions

## MRE-OPEN-001 — Party Mastering

How much shared person/organization data should Party own versus leaving operational contact data in MRE?

Initial bias: minimal shared identity plus external references.

## MRE-OPEN-002 — Rent Write-Back

After a bank Transaction is confirmed as rent, should the system automatically call the MRE payment API after human confirmation?

Likely yes; exact workflow belongs in MVP design.

## MRE-OPEN-003 — Payment Identity

Use fingerprinting only, add private IDs, or propose stable payment IDs upstream?

Preference: upstream generic ID if feasible.

## MRE-OPEN-004 — UI Packaging

Should DE screens live in the MRE landlord app or in a separate frontend with integrated navigation?

Requires dedicated frontend inspection.

## MRE-OPEN-005 — Shared Authentication

**Direction resolved (ADR-034 / TECH-ADR-005):** reuse MRE authentication and Realm authority; no separate DE credential store. The exact token/session propagation method against the pinned MRE authenticator/gateway is a Phase-0 implementation spike, not a new architecture decision (see §47).

## MRE-OPEN-006 — Document Storage

**Resolved (ADR-035):** non-rental documents use a separate pluggable `DocumentStorage` abstraction with a local-filesystem default; canonical metadata stays in PostgreSQL. Existing MRE rental documents may be referenced rather than copied where practical.

---

# 58. Key Findings

The MRE deep dive produced six high-confidence findings.

## Finding 1

MRE Property is already the rentable operational object. A separate Unit is not part of the inspected core.

## Finding 2

MRE Tenant carries most of the concrete rental relationship. MRE Lease is a reusable term/definition model.

## Finding 3

MRE already has useful rent scheduling, balance and operational payment-status logic and should retain it.

## Finding 4

MRE payment records are not bank-grounded cash Transactions, so explicit reconciliation is required.

## Finding 5

MRE Account collides semantically with our financial Account name, requiring `FinancialAccount`.

## Finding 6

The DE financial, WEG, tax and Investment layers can be implemented largely outside MRE core. This validates the project's central extension-over-modification strategy.

---

# 59. Architectural Conclusion

MRE should remain responsible for:

```text
Property
Tenant
Rental relationship
Rent schedule
Operational payment status
Rental documents
Authentication
Tenant communication
```

The DE Investment Layer should remain responsible for:

```text
Party identity across domains
Ownership
Acquisition
FinancialAccount
Bank Transactions
Transaction Splits
Loans
SecurityDeposit financial lifecycle
WEG
Tax
Depreciation
Market valuation
Investment analytics
Reporting
```

The two layers should connect through:

```text
stable references
+
explicit reconciliation
+
supported MRE APIs
```

rather than shared ownership of the same data.

---

# 60. Final Integration Principle

The project must not force MicroRealEstate to become something it is not.

MRE is a rental-management system.

Vermieter Cockpit DE adds the economic lifecycle around it.

> Let MRE own rental operations.  
> Let the DE layer own financial truth.  
> Reconcile where the worlds meet.
