# API Design

**Project:** Vermieter Cockpit DE *(working title)*  
**Version:** 0.1  
**Status:** Living Document  
**Document Type:** Business API Specification

---

# 1. Purpose

This document defines the API design principles and high-level business capabilities of Vermieter Cockpit DE.

The API is the primary contract between:

- frontend applications
- domain services
- MicroRealEstate integration
- automation
- AI assistance
- future external applications

This document intentionally focuses on **business capabilities**, not on raw persistence operations.

It defines:

- API design principles
- domain boundaries
- resource naming
- business commands
- query patterns
- integration contracts
- MRE adapter responsibilities
- reconciliation APIs
- idempotency
- concurrency
- validation
- authorization
- error semantics
- versioning
- auditability

This document does **not** define:

- final OpenAPI syntax
- concrete DTO schemas for every endpoint
- generated client code
- database implementation
- frontend component structure

Those may be derived later from this specification.

---

# 2. Governing Principles

The API must obey the project Constitution, Architecture Decisions, Domain Model, Data Model and MRE Integration specification.

The most important API principles are:

1. expose business capabilities, not database structure
2. preserve domain ownership
3. never duplicate financial truth
4. use explicit commands for state changes
5. make derived data read-only
6. prefer idempotent operations where possible
7. preserve auditability
8. make uncertainty and review state explicit
9. isolate MRE behind an integration boundary
10. prevent AI from silently writing canonical data

---

# 3. API Style

The API may use HTTP/JSON initially.

The exact implementation framework is not prescribed.

The recommended style is:

> REST-like resources for reads and simple lifecycle operations, combined with explicit domain actions for business state transitions.

Examples:

Preferred:

```text
POST /transactions/{id}/confirm
POST /transactions/{id}/split
POST /rent-reconciliations/{id}/confirm
POST /tax-classifications/{id}/confirm
POST /loans/{id}/recalculate-schedule
```

Discouraged:

```text
PATCH /transactions/{id}
{
  "status": "confirmed"
}
```

when `confirm` has business semantics, validation and audit behavior.

---

# 4. API Boundary Model

Conceptually:

```text
Frontend / External Client
          │
          ▼
      Public API
          │
          ├── Identity / Party
          ├── Ownership
          ├── Acquisition
          ├── Financial Ledger
          ├── Financing
          ├── Security Deposit
          ├── WEG
          ├── Taxation
          ├── Depreciation
          ├── Investment
          ├── Documents
          └── Reporting
                  │
                  ▼
          Domain Services
                  │
          ┌───────┴────────┐
          │                │
       DE Storage       MRE Adapter
                           │
                           ▼
                        MRE API
```

The public API must not expose raw MRE database structures directly.

---

# 5. API Versioning

Initial API namespace:

```text
/api/v1
```

Versioning is required for externally consumed contracts.

Internal service APIs may use separate versioning if needed.

Breaking API changes require:

- explicit version change or compatibility strategy
- migration notes
- updated integration tests

---

# 6. Resource Naming

Use plural nouns for collections.

Examples:

```text
/parties
/ownerships
/acquisitions
/transactions
/loans
/financial-accounts
/weg-associations
/tax-classifications
/depreciation-assets
/market-valuations
/investment-scenarios
```

Use explicit action subresources or verbs for business commands.

Examples:

```text
/transactions/{id}/confirm
/transactions/{id}/correct
/loans/{id}/recalculate-schedule
```

---

# 7. Identifier Rules

Every canonical DE entity uses its internal immutable ID.

MRE references must use explicit fields such as:

- `mreRealmId`
- `mrePropertyId`
- `mreTenantId`
- `mreLeaseDefinitionId`

Do not overload DE IDs with MRE IDs.

---

# 8. Authentication

The preferred architecture is to reuse MRE authentication and Realm authorization.

The DE API should accept an authenticated identity that can be mapped to:

- MRE Account
- MRE Realm membership
- DE access roles

Exact token format remains an implementation decision.

---

# 9. Realm Context

Any endpoint operating on MRE-linked data must execute inside an explicit authorized Realm context.

Realm context may be provided through:

- authenticated claims
- organization header
- route scope
- service context

The API must not allow cross-Realm data leakage.

---

# 10. Authorization

Authorization should be role- and domain-aware.

Potential roles include:

- Owner
- Co-Owner
- Administrator
- Tax Advisor
- Read-Only Advisor

Tenant-facing access remains within MRE tenant APIs and is outside the initial DE investor API.

---

# 11. API Response Envelope

The API should avoid unnecessary nesting.

Recommended normal response:

```json
{
  "id": "...",
  "..."
}
```

For paginated results:

```json
{
  "items": [],
  "page": 1,
  "pageSize": 50,
  "total": 125
}
```

Metadata should only be added when useful.

---

# 12. Error Model

All domain errors should use a consistent machine-readable structure.

Example:

```json
{
  "error": {
    "code": "TRANSACTION_SPLIT_MISMATCH",
    "message": "Transaction splits do not equal the transaction amount.",
    "details": {
      "transactionId": "...",
      "difference": "25.00"
    },
    "traceId": "..."
  }
}
```

---

# 13. Error Categories

Recommended categories:

- `VALIDATION_ERROR`
- `NOT_FOUND`
- `CONFLICT`
- `UNAUTHORIZED`
- `FORBIDDEN`
- `EXTERNAL_SYSTEM_ERROR`
- `REVIEW_REQUIRED`
- `INVARIANT_VIOLATION`
- `VERSION_CONFLICT`
- `IMPORT_ERROR`

---

# 14. HTTP Status Guidance

Recommended mapping:

| Situation | Status |
|---|---:|
| Success | 200 |
| Created | 201 |
| Accepted async-like processing if ever needed | 202 |
| No content | 204 |
| Invalid input | 400 |
| Unauthorized | 401 |
| Forbidden | 403 |
| Not found | 404 |
| Domain conflict | 409 |
| Validation/review issue | 422 |
| External dependency unavailable | 502/503 |

---

# 15. Idempotency

Commands that may be retried must support idempotency where duplicate execution would be harmful.

Important examples:

- bank import
- transaction creation from external source
- rent reconciliation confirmation
- payment write-back to MRE
- document import
- metric snapshot generation

Recommended mechanism:

```text
Idempotency-Key: <client-generated-key>
```

Implementation: one store for all commands (`idempotency_key`: Realm, command scope, key → fingerprint of the normalized payload, the created resource and its **result snapshot**), claimed and recorded in the same transaction as the resource. Same key and payload → the original result exactly as recorded then, **not** the resource's current state (a retried create after the resource changed still gets the original answer; the current state is a query's job). Same key, different payload → `409`. Keys are kept without expiry for now; retention is backlog VC-X-12.

---

# 16. Optimistic Concurrency

Mutable canonical entities should support version-based concurrency where appropriate.

Example:

```text
version = 12
```

Update command may require:

```text
If-Match: 12
```

or equivalent request field.

Conflict should return `409 VERSION_CONFLICT`.

---

# 17. Audit Context

Commands changing canonical state should preserve:

- actor
- timestamp
- source
- reason where applicable
- prior version
- resulting version

---

# 18. Query vs Command Separation

Reads should not change domain state.

Commands should make state changes explicit.

Example:

```text
GET /transactions/{id}
```

must not automatically confirm or classify a Transaction.

---

# 19. Party API

## Purpose

Manage canonical shared Party identity.

### Query

```text
GET /api/v1/parties
GET /api/v1/parties/{partyId}
```

Optional filters:

- `type`
- `name`
- `externalSystem`
- `externalId`

### Commands

```text
POST /api/v1/parties
POST /api/v1/parties/{partyId}/external-references
POST /api/v1/parties/{partyId}/deactivate
```

Avoid generic deletion where historical relationships exist.

---

# 20. MRE Party Mapping API

```text
POST /api/v1/parties/{partyId}/mre-mappings
```

Example request:

```json
{
  "mreRealmId": "...",
  "entityType": "tenant",
  "externalId": "..."
}
```

The API must validate that the referenced MRE entity exists where feasible.

---

# 21. MRE Discovery API

The DE layer may expose read-only convenience endpoints backed by the MRE adapter.

Examples:

```text
GET /api/v1/mre/realms
GET /api/v1/mre/properties
GET /api/v1/mre/properties/{mrePropertyId}
GET /api/v1/mre/tenants
GET /api/v1/mre/tenants/{mreTenantId}
GET /api/v1/mre/rents/{mreTenantId}
```

These endpoints should normalize integration data rather than leak raw MRE internals unnecessarily.

---

# 22. Property Reference API

Because MRE owns Property, the DE API should not provide full Property CRUD.

**Route convention:** the DE-side property resource is `property-references`. All property-scoped DE subresources use `/api/v1/property-references/{propertyReferenceId}/...` (e.g. ownerships, acquisitions, transactions, loans, weg, metrics). The generic `/api/v1/properties/...` form is not used for DE resources; only the explicit MRE integration passthrough under `/api/v1/mre/properties/...` refers to raw MRE Property identity.

Instead:

```text
GET  /api/v1/property-references
GET  /api/v1/property-references/{id}
POST /api/v1/property-references/link
POST /api/v1/property-references/{id}/refresh
```

---

# 23. Link Property Command

```text
POST /api/v1/property-references/link
```

Request:

```json
{
  "mreRealmId": "...",
  "mrePropertyId": "..."
}
```

Behavior:

1. validate Realm access
2. fetch MRE Property
3. prevent duplicate link
4. create DE PropertyReference
5. preserve MRE identifiers
6. optionally cache display metadata

## 23.1 Contract

- **Domain owner:** MRE Integration.
- **Authorization:** MRE identity; the caller must have access to the given `mreRealmId`; the resulting PropertyReference is scoped to that Realm.
- **Inputs:** `mreRealmId` (required), `mrePropertyId` (required).
- **Outputs:** `201 Created` with the new PropertyReference on first link; `200 OK` with the existing PropertyReference on a repeat of the same natural key (documented success repeat).
- **Error codes:** `401/403` missing identity or no access to the Realm; `404` MRE Property not found for `(mreRealmId, mrePropertyId)`. There is no `409`: a repeat of the same natural key is a success, not a conflict.
- **Idempotency:** natural key `(mreRealmId, mrePropertyId)`; a repeat returns the existing PropertyReference (`200`), never a duplicate and never `409`.
- **Side effects:** creates one PropertyReference; reads MRE via the anti-corruption client (`mre-integration.md`); writes an AuditRecord. DE records remain valid if the upstream MRE Property is later deleted.
- **Implementation (VC-1-01):**
  - The Realm is taken from the `organizationid` header and verified by the access guard (§47.1 of `mre-integration.md`). A body `mreRealmId` other than the header's Realm is `403`.
  - `mrePropertyId` must match `^[0-9a-f]{24}$` and `mreRealmId` must be non-empty; otherwise `400 VALIDATION_ERROR` with `details.fields[]` (`REQUIRED` / `INVALID_FORMAT`), before MRE is called.
  - An existing link for the natural key is returned (`200`) **without** asking MRE, so a repeat stays a success after the upstream Property was deleted.
  - A new link resolves the Property via `GET /properties` in the Realm, never `GET /properties/:id` (`mre-integration.md` §21.1); unknown in the Realm → `404 NOT_FOUND`; MRE no longer grants the Realm (upstream 404 from `checkOrganization`, e.g. membership revoked after the access guard) → `403`; MRE unreachable → `503 EXTERNAL_SYSTEM_ERROR` and nothing is written (§77).
  - Cached on create: `displayName` (MRE `name`), `cachedAddress` and `cachedSurface`, with `lastRefreshedAt`; MRE `price` is never cached.
  - Concurrent links of the same natural key yield one PropertyReference (unique constraint, insert-or-return in one transaction pinned to `READ COMMITTED`, independent of the session default), with exactly one AuditRecord (`LINKED`, actor = verified MRE account email). An empty MRE `name` is cached as `null`.

---

## 23.2 Refresh Property Reference (VC-1-02)

```text
POST /api/v1/property-references/{propertyReferenceId}/refresh
```

- **Domain owner:** MRE Integration. No request body.
- **Authorization:** as §23.1; the reference must belong to the verified Realm. A reference of another Realm is `404`, the same as an unknown id, so existence does not leak across Realms.
- **Behavior:** re-reads the Property via `GET /properties` in the Realm (never `GET /properties/:id`, `mre-integration.md` §21.1):
  - **found:** `displayName`, `cachedAddress` and `cachedSurface` are replaced by MRE's values, the state becomes `ACTIVE` (also from `MISSING`), `lastRefreshedAt` is set;
  - **not listed:** the state becomes `MISSING`; cached values and `lastRefreshedAt` are kept and nothing is deleted. MRE cannot tell deletion from invisibility, so DE never sets `DELETED_UPSTREAM` from a refresh.
- **Outputs:** `200 OK` with the PropertyReference (including `version`, `lastRefreshedAt` = values last read from MRE, `lastObservedAt` = latest applied MRE lookup).
- **Error codes:** `400 VALIDATION_ERROR` for an id that is not a UUID; `401/403` as §23.1 (also when MRE no longer grants the Realm); `404` unknown reference in this Realm; `503 EXTERNAL_SYSTEM_ERROR` when MRE is unavailable. On any error nothing is changed (§77).
- **Ordering:** MRE is read outside the row lock, so refreshes can finish out of order. Each observation is stamped with the **start** of its MRE lookup (`observedAt`, taken before the request; a slow response may show an older MRE state). `lastObservedAt` records the latest applied observation, FOUND or NOT_FOUND. An observation with `observedAt <= lastObservedAt` is **stale** and discarded: nothing is written, no version bump, no AuditRecord, and the response is the current state. So an older observation never brings back old values, never moves `lastRefreshedAt` backwards and never sets `ACTIVE` over a newer `MISSING`.
- **Idempotency:** a refresh without news changes only `lastRefreshedAt` and `lastObservedAt`. `version` increases, and an AuditRecord (`REFRESHED` or `MARKED_MISSING`, with `previousVersion`/`newVersion` and the changed fields) is written, only when cached values or the state change. Concurrent refreshes serialize on the row (`SELECT … FOR UPDATE` under READ COMMITTED).
- **Representation:** `cachedSurface` is a decimal string (e.g. `"64.5"`), never a JSON number. MRE stores surface as a JS number; DE takes its shortest decimal text exactly and leaves out negative, non-finite or exponent values.

---

# 24. Rental Contract Reference API

Concrete rental relationship references MRE Tenant + Lease Definition.

### Queries

```text
GET /api/v1/rental-contract-references
GET /api/v1/rental-contract-references/{id}
```

### Commands

```text
POST /api/v1/rental-contract-references/link
POST /api/v1/rental-contract-references/{id}/refresh
```

---

# 25. Ownership API

### Queries

```text
GET /api/v1/ownerships
GET /api/v1/ownerships/{id}
GET /api/v1/property-references/{propertyReferenceId}/ownerships
```

### Commands

```text
POST /api/v1/ownerships
POST /api/v1/ownerships/{id}/close
POST /api/v1/property-references/{propertyReferenceId}/ownership-changes
```

---

# 26. Ownership Creation

Example request:

```json
{
  "propertyReferenceId": "...",
  "ownerPartyId": "...",
  "share": "0.50",
  "validFrom": "2026-08-01",
  "sourceDocumentId": "..."
}
```

Validation:

- Party exists
- Property exists
- share is valid
- no invalid overlapping record
- total active shares do not exceed 100%

---

# 27. Acquisition API

### Queries

```text
GET /api/v1/acquisitions
GET /api/v1/acquisitions/{id}
GET /api/v1/property-references/{propertyReferenceId}/acquisitions
```

### Commands

```text
POST /api/v1/acquisitions
POST /api/v1/acquisitions/{id}/costs
POST /api/v1/acquisitions/{id}/confirm
POST /api/v1/acquisitions/{id}/land-building-allocation
```

---

# 28. Acquisition Confirmation

Confirmation should validate:

- PropertyReference exists
- Purchase Price exists
- Buyers exist
- ownership data is consistent
- required acquisition data is complete
- any configured review requirements are satisfied

---

# 29. FinancialAccount API

Use `FinancialAccount`, not `Account`. DE references to a financial account use `financialAccountId`.

### Queries

```text
GET /api/v1/financial-accounts
GET /api/v1/financial-accounts/{financialAccountId}
```

### Commands

```text
POST /api/v1/financial-accounts
POST /api/v1/financial-accounts/{financialAccountId}/close
```

Account types (`accountType`, per `data-model.md` §16): `BANK`, `SECURITY_DEPOSIT`, `LOAN_SETTLEMENT`, `CASH`, `OTHER`. The MVP may support a narrower subset.

## 29.1 `POST /api/v1/financial-accounts` — contract

- **Domain owner:** Financial Ledger.
- **Authorization:** authenticated MRE identity; scoped to the caller's Realm; the account is created within that Realm.
- **Field mapping:** request/response fields match the domain model verbatim (`data-model.md` §16): `accountType`, `displayName`, `currency`, `status`, optional `iban`. The response id is `financialAccountId` (the domain `id`). A FinancialAccount has **no** `propertyReferenceId` — a cash account is not owned by one property; property associations live on Transactions/Splits, not on the account.
- **Inputs:**
  ```json
  {
    "accountType": "BANK",
    "displayName": "Girokonto ...",
    "currency": "EUR",
    "iban": "DE..."
  }
  ```
  `accountType` from the list above; `currency` must be supported (Phase 1: at least `EUR`); `iban` is optional and stored as an external identifier only, never as internal identity.
- **Outputs:** `201 Created` with the `FinancialAccount` (`financialAccountId`, `accountType`, `displayName`, `currency`, `status = OPEN`, Realm, timestamps).
- **Error codes:** `400` invalid/unsupported `accountType` or `currency`; `401/403` missing identity / wrong Realm; `409` an `Idempotency-Key` reused with a **different** payload.
- **Idempotency:** accepts an `Idempotency-Key`. The same key with a semantically identical payload returns the original account (idempotent replay, no second account created); the same key with a different payload returns `409`.
- **Side effects:** creates the account; writes an AuditRecord.

`POST /{financialAccountId}/close` sets `status = CLOSED`; historical Transactions remain valid (`data-model.md` §16). Rejected if the account is not in the caller's Realm.

## 29.2 Implementation (VC-1-03)

- **Validation (`400 VALIDATION_ERROR`, `details.fields[]` with `REQUIRED` / `INVALID_FORMAT`):** `accountType` from the five types; `displayName` trimmed, 1–200 characters; `currency` supported (Phase 1: `EUR`); `iban` optional, normalized (spaces removed, upper case) and checked for structure and the ISO 7064 mod-97 checksum. An `Idempotency-Key` must be 1–255 visible ASCII characters.
- **Idempotency:** the key is scoped to the Realm and the command. "Semantically identical" means the same **normalized** payload, so `DE89 3704 …` and `DE893704…` are one request. A replay answers exactly like the original (`201`, the same body as recorded at creation, e.g. still `OPEN` / `version 1` after the account was closed) with the header `Idempotent-Replayed: true`. Concurrent requests with the same key create exactly one account.
- **Close:** `200` with the account (`status = CLOSED`, `closedAt`, `version` +1, AuditRecord `CLOSED`). Closing a closed account is a `200` no-op without an AuditRecord. An id that is not a UUID is `400`; an unknown account or one of another Realm is `404`.
- **Response:** `financialAccountId`, `mreRealmId`, `accountType`, `displayName`, `currency`, `iban` (normalized or `null`), `status`, `createdAt`, `closedAt`, `version`.

---

# 30. Transaction API

### Queries

```text
GET /api/v1/transactions
GET /api/v1/transactions/{id}
GET /api/v1/property-references/{propertyReferenceId}/transactions
```

Useful filters:

- date range
- account
- property
- status
- `reviewable` (pre-classification transactions: `status` ∈ { `IMPORTED`, `UNREVIEWED` })
- financial category
- counterparty
- source
- unreconciled
- needs review

---

# 31. Create Manual Transaction

```text
POST /api/v1/transactions
```

Manual creation should be allowed but provenance must be explicit.

Example:

```json
{
  "financialAccountId": "...",
  "bookingDate": "2026-09-01",
  "amount": {
    "amount": "1250.00",
    "currency": "EUR"
  },
  "direction": "INFLOW",
  "description": "Rent September",
  "propertyReferenceId": "...",
  "provenance": "MANUAL"
}
```

## 31.1 Contract

- **Domain owner:** Financial Ledger.
- **Authorization:** MRE identity; Realm-scoped; the target `financialAccountId` must belong to that Realm.
- **Inputs:** `financialAccountId` (required), `amount` (non-negative Money + `currency`, required), `direction` `INFLOW|OUTFLOW` (required), `bookingDate` (required); optional `valueDate`, `description`, `propertyReferenceId`, `rentalContractReferenceId`; `provenance = MANUAL`.
- **Outputs:** `201 Created` with the Transaction (`status = UNREVIEWED`).
- **Error codes:** `400` negative amount, missing `direction`, amount not representable in the currency scale, or unsupported currency; `404` unknown / other-Realm `financialAccountId`; `409` an `Idempotency-Key` reused with a **different** payload.
- **Idempotency:** accepts an `Idempotency-Key`. The same key with a semantically identical payload returns the original Transaction (no duplicate); the same key with a different payload returns `409`.
- **Side effects:** creates one Transaction; writes an AuditRecord.

## 31.2 Implementation (VC-1-04)

- **Money:** `amount` is `{ "amount": "<decimal string>", "currency": "EUR" }`. A JSON number or exponent notation is `400` (no float in transit). Field codes: `NEGATIVE_AMOUNT`, `SCALE_EXCEEDED` (more than two decimals for EUR, never rounded), `UNSUPPORTED_CURRENCY`, `AMOUNT_OUT_OF_RANGE`; `CURRENCY_MISMATCH` when it differs from the account's currency (no FX, data-model §17.7). Zero is allowed (non-negative, §17.4).
- **Dates:** `bookingDate` (required) and `valueDate` are real calendar dates `YYYY-MM-DD` within 1900–2100 (§88); timestamps or impossible dates are `400 INVALID_FORMAT`, other years `400 OUT_OF_RANGE`. Stored as `date`, never as a timestamp.
- **Optional fields:** an explicit `null` for `valueDate`, `description` or `propertyReferenceId` means the same as omitting it.
- **References:** `financialAccountId` and the optional `propertyReferenceId` must exist **in the caller's Realm**, otherwise `404` (same answer for unknown and foreign). The schema enforces this too (composite foreign keys with the Realm).
- **Decisions not fixed by §31.1:**
  - **Closed account → `409 CONFLICT`** with `details.reason = "ACCOUNT_CLOSED"`. Earlier Transactions stay valid (data-model §16), only new ones are refused. The account is locked `FOR SHARE` while posting, so a concurrent close waits and cannot slip in between check and insert.
  - **`rentalContractReferenceId` → `400 NOT_SUPPORTED`** until `RentalContractReference` exists (VC later), instead of storing an unchecked id.
  - `provenance` may be omitted or `MANUAL`; anything else is `400` (other provenances come from imports).
- **Idempotency:** as §15. The fingerprint is the normalized payload (`"1250"` and `"1250.00"` are one request; id case is ignored). A replay answers with the Transaction as created, before any check, so it still succeeds after the account was closed. A **rejected** request rolls back its key claim: the client may fix the request and retry with the same key.
- **Response:** `transactionId`, `mreRealmId`, `financialAccountId`, `amount`, `direction`, `bookingDate`, `valueDate`, `description`, `propertyReferenceId`, `provenance`, `status`, `createdAt`, `version`.

---

# 32. Bank Import API

```text
POST /api/v1/imports/bank-transactions
GET  /api/v1/imports/{importBatchId}
GET  /api/v1/imports/{importBatchId}/review-items
POST /api/v1/imports/{importBatchId}/review-items/{reviewItemId}/resolve
```

Input may initially use CSV upload.

Responsibilities: parse, validate, normalize, fingerprint, detect duplicates, create `IMPORTED` Transactions for genuinely new rows, flag ambiguous cross-file matches for human review (creating no Transaction), preserve source metadata.

## 32.1 Contract

- **Domain owner:** Financial Ledger (bank-import adapter).
- **Authorization:** MRE identity; Realm-scoped; the target `financialAccountId` must belong to that Realm.
- **Inputs:** multipart CSV upload plus:
  ```json
  {
    "financialAccountId": "...",
    "adapterId": "generic-csv",
    "adapterVersion": "1",
    "columnMapping": {
      "bookingDate": "Buchungstag",
      "amount": "Betrag",
      "counterpartyName": "Empfaenger",
      "counterpartyIban": "IBAN",
      "description": "Verwendungszweck"
    }
  }
  ```
  **Normalized row schema** (after mapping/normalization, per `data-model.md` §70.2–70.3): `bookingDate`, optional `valueDate`, non-negative `amount` + derived `direction`, `currency`, `counterpartyIbanRaw` / `counterpartyNameRaw`, `description`, optional `externalTransactionId`.
- **Outputs:** `201 Created` with an `ImportBatch` summary: `importBatchId`, `transactionCount`, `duplicateCount`, `needsReviewCount`, `errorCount`, and per-row results (`created` / `duplicate` / `needs_review` / `error`, each with a reason where applicable).
  - A `needs_review` result carries its **`reviewItemId`** and the **owning `importBatchId`** of that item (the `ImportReviewItem`, `data-model.md` §20A), plus the `conflictingTransactionIds`, so it can be listed (§32.3) and resolved (§32.2) under the correct path. An **adapter-version conflict** (`data-model.md` §70.4) is reported as `needs_review` with a **new** item owned by this batch.
  - A `duplicate` result is **structured by its cause** via a `duplicateOf` discriminator:
    - `TRANSACTION` — the row's identity matches an already-imported Transaction; the result references that `transactionId`;
    - `RESOLVED_REVIEW_ITEM` — the row re-presents a source identity whose `ImportReviewItem` is already `RESOLVED` (`data-model.md` §20A Ownership and Retry): the result carries the `reviewItemId`, its **owning `importBatchId`**, and the stored `resolution`; when `resolution = CREATE` it also carries the **same** `createdTransactionId`, and when `resolution = SKIP` the `createdTransactionId` field is **absent by definition** (no Transaction exists). In both variants **no new decision is made and no additional Transaction is created**.
  - `needsReviewCount` counts only the `PENDING` items **owned by this batch**: a row that re-presents a source identity whose item is still `PENDING` in an earlier batch references that existing item and does **not** increment this batch's counter (`data-model.md` §20A Ownership and Retry).
- **Error codes:** `400` unparseable file, missing mapping, unsupported `currency`, amount not representable; `404` unknown / other-Realm `financialAccountId`; `422` per-row normalization failures (reported per row; the batch still returns).
- **Idempotency:** duplicate detection uses the versioned identity in `data-model.md` §70 (stable external id, else adapter-bound source-statement + source-row identity), scoped to `(realm, financialAccountId)`. Re-importing the same file creates no duplicate Transactions and increments `duplicateCount`. Ambiguous cross-file matches are **not** auto-deduped — they become `needs_review` (see §32.2). A re-presented identity whose review item is already `RESOLVED` yields the structured `RESOLVED_REVIEW_ITEM` duplicate above — the stored decision is never re-opened and no additional Transaction is created. The same source row under a different `adapterVersion` (fallback branch) is an adapter-version conflict → `needs_review`, never an automatic Transaction (`data-model.md` §70.4).
- **Side effects:** creates `IMPORTED` Transactions for genuinely new rows only; **creates no Transaction for `needs_review` rows** — a newly ambiguous row creates an `ImportReviewItem` **owned by this batch** (resolved via §32.2), while a re-presented still-`PENDING` identity only references the existing item of its owning batch (no second item, `data-model.md` §20A); while own `PENDING` items remain, the batch `status` reflects it (e.g. `NEEDS_REVIEW`); creates one `ImportBatch`; writes an AuditRecord.

## 32.1a Implementation (VC-1-05 / VC-1-06)

- **Upload:** `multipart/form-data` with exactly two parts: `metadata` (a JSON string: `financialAccountId`, `adapterId`, `adapterVersion`, plus the adapter's own options such as `columnMapping` at the same level, §32.4) and `file`. The file is capped at **5 MiB** (`413` with `Connection: close`, nothing parsed): a declared `Content-Length` beyond the cap is refused before reading, otherwise reading stops at the cap; a missing or unexpected part, non-JSON metadata or a non-multipart body is `400 VALIDATION_ERROR`. An unknown adapter or version is `400` with field `adapterId` / `NOT_SUPPORTED`.
- **File-level errors** (§32.4: the file as a whole cannot be read) are `400 IMPORT_ERROR` with `details.reason` (e.g. `MISSING_COLUMN`); no batch is stored.
- **Per-row failures** do not fail the request: the batch is `201` and each such row has outcome `error` with field codes (the `422` of §32.1 is reported per row, not as the status). A sixth outcome `skipped` (`reason: ZERO_AMOUNT`) reports rows that move no cash, such as `0,00` balance lines; they are counted in `skippedCount`, not as errors.
- **Closed accounts:** an import may still post rows booked **up to and including the closing day** (the `Europe/Berlin` calendar day of `closedAt`) — statements usually arrive after an account was closed. Later rows are `error` with `bookingDate` / `ACCOUNT_CLOSED`. Manual Transactions stay refused on closed accounts (§31.2).
- **Duplicate rules** (`data-model.md` §70): a review item with the row's full source identity is always checked first (referenced while `PENDING`, structured duplicate once `RESOLVED`). A row with an external id is then decided by it, independent of adapter: same id **and** same content fingerprint → `duplicate/TRANSACTION`; same id, other content → new item `EXTERNAL_ID_CONTENT_CONFLICT`; no id match but the same content as an imported Transaction without id → new item `AMBIGUOUS_CROSS_FILE_MATCH`; else created. Otherwise the full source-row identity (adapter id + version, statement key = source statement id else `sha256:<content hash>`, row key = source row id else `pos:<n>`) decides: imported Transaction → `duplicate/TRANSACTION`; review item → referenced while `PENDING`, `duplicate/RESOLVED_REVIEW_ITEM` once resolved. The same row under another adapter version → new item `ADAPTER_VERSION_CONFLICT`. The same content fingerprint as an imported Transaction of **another** statement (including rows imported via external id) → new item `AMBIGUOUS_CROSS_FILE_MATCH`. Two identical rows **within one file** are two Transactions (their positions differ).
- **Concurrency:** the import locks the account row; two uploads of one file serialize, the second sees the first's rows as duplicates. Unique indexes on both identity branches and on the review-item identity back this up in the schema.
- **Response** (`201`, also `GET /imports/{importBatchId}`, `404` for unknown and foreign batches): `importBatchId`, `mreRealmId`, `financialAccountId`, `adapterId`, `adapterVersion`, `sourceFilename`, `contentHash`, `status` (`COMPLETED` | `NEEDS_REVIEW`), `transactionCount`, `duplicateCount`, `needsReviewCount`, `errorCount`, `skippedCount`, `importedAt`, `importedBy`, `rows` (in file order, each with `position`).
- **Audit:** one AuditRecord `IMPORTED` on the `ImportBatch` with the counts.

## 32.2 Resolve an ambiguous review item

```text
POST /api/v1/imports/{importBatchId}/review-items/{reviewItemId}/resolve
```

Resolves the `ImportReviewItem` (`data-model.md` §20A) identified by `reviewItemId`.

- **Domain owner:** Financial Ledger (bank-import adapter).
- **Authorization:** MRE identity; Realm-scoped; the `ImportBatch` and the `ImportReviewItem` must belong to the caller's Realm.
- **Path validation:** the item must belong to the path batch — `ImportReviewItem.importBatchId == {importBatchId}` (the owning batch, `data-model.md` §20A). A `reviewItemId` that exists but is owned by a different batch is answered with `404` under this path.
- **Inputs:** `{ "resolution": "CREATE" | "SKIP" }`.
- **Outputs:** `200 OK` with the updated `ImportReviewItem` (`status = RESOLVED`, the stored `resolution`, `resolvedByAccountId`/`resolvedAt`, and on `CREATE` `createdTransactionId` = the single new `IMPORTED` Transaction); the **owning** batch's `needsReviewCount` (identical to the path batch, per path validation) is decremented.
- **Error codes:** `404` unknown / other-Realm `importBatchId` or `reviewItemId`, or a review item not owned by `{importBatchId}`; `409` item already `RESOLVED` with a **different** resolution; `422` invalid `resolution` value.
- **Idempotency:** resolving an already-`RESOLVED` item with the **same** resolution is a `200` no-op returning the prior outcome (including the same `createdTransactionId`); a **different** resolution returns `409` (a review decision is never silently reversed). Identity is the canonical `reviewItemId`.
- **Side effects:** on `CREATE`, exactly **one** `IMPORTED` Transaction is created (an explicit human decision — never treated as a duplicate of the conflicting row) and recorded in `createdTransactionId`; on `SKIP`, **no** Transaction is created; the item becomes `RESOLVED`; writes an AuditRecord.

## 32.3 List review items

```text
GET /api/v1/imports/{importBatchId}/review-items
```

- **Domain owner:** Financial Ledger (bank-import adapter).
- **Authorization:** MRE identity; Realm-scoped; the `ImportBatch` must belong to the caller's Realm.
- **Inputs:** path `importBatchId`; optional query filter `status` (`PENDING` | `RESOLVED`).
- **Outputs:** `200 OK` with the list of `ImportReviewItem`s **owned by** `{importBatchId}` (`ImportReviewItem.importBatchId == {importBatchId}`, `data-model.md` §20A): each with `reviewItemId`, `status`, `ambiguityReason`, `normalizedRow`, `conflictingTransactionIds`, and when resolved `resolution` / `resolvedByAccountId` / `resolvedAt` / `createdTransactionId`. Items owned by other batches are never listed here, even if a later import re-presented their identity.
- **Error codes:** `404` unknown / other-Realm `importBatchId`.
- **Idempotency:** safe, read-only, repeatable.
- **Side effects:** none (read-only).

## 32.3a Implementation (VC-1-06a)

- **List** (`GET …/review-items`, optional `status=PENDING|RESOLVED`, other values `400`): `200` with `{ importBatchId, items }`, the items **owned by** the batch in file order. Each item: `reviewItemId`, `importBatchId`, `financialAccountId`, `adapterId`, `adapterVersion`, `status`, `ambiguityReason` (`AMBIGUOUS_CROSS_FILE_MATCH` | `ADAPTER_VERSION_CONFLICT` | `EXTERNAL_ID_CONTENT_CONFLICT`), `normalizedRow` (with `position`, `statementKey`, `rowKey`), `conflictingTransactionIds` **and** `conflictingTransactions` — the conflicting Transactions themselves (dates, amount, direction, counterparty, description, external id, their batch), so the row and what it may duplicate can be shown side by side — `priorReviewItemIds`, `resolution`, `resolvedByAccountId` (the MRE email), `resolvedAt`, `createdTransactionId`, `createdAt`. Unknown and foreign batches are `404`.
- **Resolve** (`POST …/resolve`, body `{ "resolution": "CREATE" | "SKIP" }`): `200` with the item (as in the list, without `conflictingTransactions`). Missing or invalid `resolution` → `422 VALIDATION_ERROR`; malformed ids → `400`; an item not owned by the path batch, unknown or foreign → `404`.
  - **Same resolution again:** `200` no-op with `Idempotent-Replayed: true` and the same `createdTransactionId`. **Other resolution:** `409 CONFLICT`, `details.reason = "ALREADY_RESOLVED"`, `details.resolution` = the stored one.
  - **`CREATE`** creates exactly one `IMPORTED` Transaction from the stored normalized row: the batch's provenance, the owning batch as `importBatchId`, the row's source identity (adapter, statement, row, fingerprint) and a link to the item. It keeps the row's external id unless the reason was `EXTERNAL_ID_CONTENT_CONFLICT` or another Transaction of the account holds that id meanwhile (`data-model.md` §70.4). A row booked after the account's closing day (Europe/Berlin, as for imports, §32.1a) is `409 CONFLICT` with `reason = "ACCOUNT_CLOSED"`; `SKIP` is always possible.
  - The owning batch's `needsReviewCount` is decremented; at `0` its `status` becomes `COMPLETED`. Its stored per-row outcomes stay as the import answered them.
  - Resolves serialize with imports into the same account (account row lock, then item row lock); two concurrent `CREATE`s create one Transaction, the second is the replay.
  - One AuditRecord `RESOLVED` on the `ImportReviewItem` (resolution, reason, conflicts, created Transaction).

## 32.4 Adapter `generic-csv`, version 1 (VC-1-10)

The first adapter reads any bank's CSV export with a header row. The ledger only sees the normalized row (`domains/ledger/bank-statement.ts`); adapters live in `integrations/bank-import/` behind the `BankStatementAdapter` port and are selected by `adapterId` + `adapterVersion`.

- **Options** (the adapter-specific part of the import request, §32.1; all except `columnMapping` optional):
  - `columnMapping`: header names for `bookingDate` and `amount` (required) and optionally `valueDate`, `currency`, `counterpartyName`, `counterpartyIban`, `description`, `externalTransactionId`, `sourceRowId`. Unknown keys are refused.
  - `delimiter` `;` (default) | `,` | tab; `decimalSeparator` `,` (default) | `.`; `dateFormat` `DD.MM.YYYY` (default) | `DD.MM.YY` (e.g. Sparkasse CSV-CAMT; `YY` always means `20YY`, nothing inferred per row) | `YYYY-MM-DD`; `encoding` `utf-8` (default) | `windows-1252`; `skipLines` 0–50 (preamble lines before the header).
- **Amount:** one signed column. A leading `-` is `OUTFLOW`, otherwise `INFLOW`; the stored amount is non-negative (§17.4). Thousands separators are accepted only at every third digit. Anything ambiguous is a row error, never guessed; more decimals than the currency allows are `SCALE_EXCEEDED`, never rounded; a zero amount is `ZERO_AMOUNT` (no cash moved, no direction).
- **Currency:** the account's. A mapped currency column must match it (`CURRENCY_MISMATCH`, no FX).
- **Normalization (§70.3):** reference placeholders in `externalTransactionId` / `sourceRowId` (`NOTPROVIDED`, `NONREF`, `NONE`, `N/A`, dashes) become null; whitespace trimmed and collapsed, IBANs without spaces and upper case (kept raw, not validated), dates as `YYYY-MM-DD` within §88's range, amounts canonical.
- **Identity inputs (§70.2):** `contentHash` = SHA-256 of the raw file bytes; `sourceStatementId` = none (a CSV export has no statement id); `sourceRowPosition` = 1-based data-row ordinal; `sourceRowId` and `externalTransactionId` only if mapped. The content fingerprint is SHA-256 over field set v1 (booking and value date, amount, currency, direction, counterparty IBAN else name, description).
- **File-level errors (→ `400`, nothing imported):** `INVALID_OPTIONS`, `UNSUPPORTED_ENCODING` (UTF-8 is decoded strictly, so a Windows-1252 file is refused instead of garbling umlauts), `UNPARSEABLE` (e.g. a broken quote; the message names the line), `EMPTY`, `MISSING_COLUMN`, `AMBIGUOUS_COLUMN`, `TOO_MANY_ROWS` (more than 10,000).
- **Row-level errors (→ per-row `error`, the batch still returns):** `REQUIRED`, `INVALID_FORMAT`, `OUT_OF_RANGE`, `SCALE_EXCEEDED`, `AMOUNT_OUT_OF_RANGE`, `ZERO_AMOUNT`, `CURRENCY_MISMATCH`, `TOO_LONG` (over 2,000 characters), `COLUMN_COUNT`.
- **Untrusted input (technology.md §36):** cell values are parsed as data only; nothing is evaluated.

---

# 33. Transaction Split Command

Preferred:

```text
PUT /api/v1/transactions/{transactionId}/splits
```

Request (amounts are **non-negative**; splits inherit the Transaction's `direction`):

```json
{
  "splits": [
    {
      "amount": "600.00",
      "financialCategoryCode": "LOAN_INTEREST",
      "loanId": "..."
    },
    {
      "amount": "600.00",
      "financialCategoryCode": "LOAN_PRINCIPAL",
      "loanId": "..."
    }
  ]
}
```

The command replaces the current unconfirmed split proposal atomically.

## 33.1 Contract

- **Domain owner:** Financial Ledger.
- **Authorization:** MRE identity; Realm-scoped; the Transaction must belong to the caller's Realm.
- **Inputs:** the full replacement list of splits; each `amount` is a **non-negative** Money in the Transaction's currency, plus `financialCategoryCode` and optional domain references. A split carries **no** `direction`.
- **Validation:** `sum(splits.amount) == transaction.amount` **exactly** (`data-model.md` §18).
- **Outputs:** `200 OK` with the updated split set.
- **Error codes:** `400` negative split amount, a split carrying a `direction`, or currency mismatch; `409` split sum ≠ transaction amount, or the Transaction is already `CONFIRMED` (splits are frozen — correct via reversal, ADR-037); `404` unknown / other-Realm transaction.
- **Idempotency:** naturally idempotent — a full atomic replacement of the unconfirmed proposal.
- **Side effects:** replaces the unconfirmed split proposal; writes an AuditRecord.

## 33.2 Implementation (VC-1-07)

- **Request:** `{ "splits": [ … ] }` with 1–100 splits, each `amount` (Money string pair, §86), `financialCategoryCode` (§36), optional `propertyReferenceId` and `description` (≤ 500 characters, trimmed; explicit `null` = omitted). Unknown keys are refused.
- **`400`:**
  - Per field: `NEGATIVE_AMOUNT`, `SCALE_EXCEEDED`, `INVALID_FORMAT` (also a JSON number as amount).
  - `NOT_ALLOWED` for a `direction` on a split.
  - `NOT_SUPPORTED` for references whose entities do not exist yet (`loanId`, `wegId`, `rentalContractReferenceId`, `maintenanceProjectId`, `acquisitionId`, `securityDepositId`, `taxClassificationId`): refused rather than stored unchecked.
  - `UNKNOWN_CATEGORY` for an unknown or inactive code; `CURRENCY_MISMATCH` (field `splits`) for a split currency other than the Transaction's.
- **`404`:** unknown or foreign Transaction; a `propertyReferenceId` not in the caller's Realm.
- **`409 INVARIANT_VIOLATION`**, `details.reason = "SPLIT_SUM_MISMATCH"`, with `expected`, `actual` and `difference` as Money: the sum differs from the Transaction amount by any amount, one cent included.
- **`409 CONFLICT`**, `reason = "TRANSACTION_FROZEN"`, with the `status`: the Transaction is `CONFIRMED`, `RECONCILED`, `CORRECTED` or `IGNORED`.
- **Status:** a valid set moves `IMPORTED` / `UNREVIEWED` to `CLASSIFIED` (domain-model §21); `CLASSIFIED` stays `CLASSIFIED`.
- **Replacement and idempotency:**
  - **Changed set:** replaced as a whole under the Transaction's row lock. The Transaction's `version` increases by 1, and one AuditRecord `SPLITS_REPLACED` is written.
  - **Same set again:** same order, same values (`"600"` equals `"600.00"`). Answered `200` with the stored set, no new version and no AuditRecord, even after confirmation. Only a **different** set is frozen.
- **Response `200`:** `transactionId`, `amount`, `direction`, `status`, `version`, `splits` (`splitId`, `position`, `amount`, `financialCategoryCode`, `propertyReferenceId`, `description`).
- **Category and direction are deliberately not cross-checked:** an `INCOME` category on an `OUTFLOW` (e.g. a refunded rent, `RENT_BASE` on the way out) or an expense category on an `INFLOW` (an insurance refund) is legitimate. The category says *what* the money is; `direction` says which way it moved. Do not add such a check.
- **Schema:** a split references its Transaction together with the Realm and the currency (composite foreign key), so it can never belong to another Realm's Transaction or carry another currency. Its amount is non-negative with at most two decimals.

---

# 34. Confirm Transaction

```text
POST /api/v1/transactions/{id}/confirm
```

## 34.1 Contract

- **Domain owner:** Financial Ledger.
- **Authorization:** MRE identity; Realm-scoped.
- **Inputs:** none beyond the path `{id}`.
- **Validation:** transaction exists in the caller's Realm; valid `amount` / `direction` (`data-model.md` §17.4); complete split coverage with exact sum (`data-model.md` §18); references resolve; no blocking review state.
- **Outputs:** `200 OK` with the Transaction at `status = CONFIRMED`. Confirming an already-`CONFIRMED` transaction returns `200` with the existing confirmed Transaction (no-op).
- **Error codes:** `404` unknown / other-Realm transaction; `409` split sum ≠ amount; `422` unresolved references / blocking review. Already-confirmed is **not** an error — it is a `200` no-op (see idempotency).
- **Idempotency:** repeated `confirm` of the same transaction is a consistent `200` no-op returning the existing confirmed Transaction; confirmed cash fields are immutable thereafter (ADR-037).
- **Side effects:** status → `CONFIRMED`; AuditRecord created; downstream recalculation may be triggered.

## 34.2 Implementation (VC-1-08)

- **Confirmable:** a `CLASSIFIED` Transaction (VC-1-07) whose split set still sums exactly to its amount (re-checked under the Transaction's row lock, not taken from when it was stored) and whose splits use only active categories.
- **`200`:** the Transaction (as in §31.2) with `status = CONFIRMED`, `confirmedAt`, `confirmedBy` (the MRE email), `version` + 1; one AuditRecord `CONFIRMED`. Already `CONFIRMED` or `RECONCILED` → `200` with the Transaction unchanged and `Idempotent-Replayed: true`, no new version or AuditRecord.
- **`409`:**
  - `INVARIANT_VIOLATION` with `reason = "SPLITS_MISSING"`: no split set yet (`IMPORTED`/`UNREVIEWED`). The complete coverage of §24 is required.
  - `INVARIANT_VIOLATION` with `reason = "SPLIT_SUM_MISMATCH"`, `expected`/`actual`/`difference`.
  - `CONFLICT` with `reason = "NOT_CONFIRMABLE"` and the `status`: `CORRECTED` or `IGNORED`.
- **`422 REVIEW_REQUIRED`** with `reason = "INACTIVE_CATEGORY"` and `financialCategoryCodes`: a split's category was deactivated since the split was stored (an unresolved reference): split again before confirming. PropertyReferences are bound by foreign key and cannot be unresolved; there is no other blocking review state for an existing Transaction in Phase 1.
- **`404`:** unknown or foreign Transaction; `400` for a malformed id.
- **Concurrency:** confirm takes the same row lock as a split replacement, so a replacement that waited on a confirm finds the Transaction frozen; two confirms yield one confirmation and one no-op.
- **Immutability (ADR-037), enforced by the database** (migration 0009), once `CONFIRMED` (and in the later `RECONCILED`/`CORRECTED`):
  - **Frozen fields:** account, Realm, amount, currency, direction, booking and value date, `confirmedAt`/`confirmedBy`, and the provenance and import identity a re-import relies on (`provenance`, import batch, external id, adapter, source keys, content fingerprint, review item).
  - **Status only moves forward:** `CONFIRMED` → `RECONCILED` / `CORRECTED`, `RECONCILED` → `CORRECTED` (domain-model §21). `CORRECTED` is terminal; nothing returns to `CONFIRMED` or to an unconfirmed state, so a superseded Transaction cannot be revived and counted twice.
  - **No deletion**, and its splits cannot be inserted, changed or deleted. Only `description` stays editable.
  - `confirmed_at`/`confirmed_by` are set exactly for the confirmed states (CHECK).
- **Split invariant in the database** (migration 0010, VC-1-09): a Transaction becomes `CONFIRMED` only with splits in its currency summing exactly to its amount, and none is inserted already confirmed, so "confirmed ⇒ covered exactly" holds for every row, not only for those confirmed through this endpoint.

---

# 35. Correct Transaction

```text
POST /api/v1/transactions/{id}/correct
```

**Phase-1 scope:** correction is **not part of the Phase-1 exit**; it is a gated fast-follow (see `docs/roadmap.md` Phase 1). The behavior is fixed by ADR-037 — the confirmed transaction is immutable, a linked reversal record negates it, and a new corrected transaction is created — but the full contract below must be completed before the fast-follow is implemented.

Example request:

```json
{
  "reason": "Incorrect booking date",
  "replacement": {
    "bookingDate": "2026-09-02"
  }
}
```

**Still to be specified before implementing the fast-follow:** the reversal and replacement roles and their fields; the chaining invariants (original ↔ reversal ↔ replacement, and the `CORRECTED` status transition); the effect on the original's splits and on any reconciliation; and the idempotency identity of a correction. Until then, `correct` is not part of the Phase-1 contract set.

---

# 36. Financial Categories API

Mostly read-only reference data.

```text
GET /api/v1/financial-categories
GET /api/v1/financial-categories/{code}
```

Administrative extension, if allowed:

```text
POST /api/v1/financial-categories
```

Core category codes should remain stable.

**Implementation (VC-1-07):** `GET /financial-categories` → `{ items: [{ code, name, categoryType, active }] }`, active first, then by code; `GET /financial-categories/{code}` → one category, `404` if unknown, `400` for a malformed code. In Phase 1 the catalog is global (the same for every Realm) and seeded by migration 0008: the examples of `data-model.md` §19 plus common landlord categories (`RENT_OPERATING_COST_SETTLEMENT`, `INSURANCE`, `PROPERTY_TAX`, `BANK_FEES`, `SECURITY_DEPOSIT`, `OWNER_CONTRIBUTION`/`OWNER_WITHDRAWAL`, `TRANSFER`, …). Codes are deactivated, never reused; the administrative `POST` is not implemented.

---

# 37. Rent Reconciliation API

### Queries

```text
GET /api/v1/rent-reconciliations
GET /api/v1/rent-reconciliations/{id}
GET /api/v1/rent-reconciliations/suggestions
```

### Commands

```text
POST /api/v1/rent-reconciliations/suggest
POST /api/v1/rent-reconciliations/{id}/confirm
POST /api/v1/rent-reconciliations/{id}/reject
POST /api/v1/rent-reconciliations/{id}/write-back-to-mre
```

---

# 38. Rent Match Suggestion

A suggestion may use:

- amount
- booking date
- tenant Party
- MRE Tenant
- rent term
- bank reference
- historical match patterns

Suggestions remain non-authoritative.

---

# 39. Confirm Rent Reconciliation

Confirmation must:

1. validate Transaction
2. validate MRE rent term
3. validate matched amount
4. prevent duplicate matching
5. create reconciliation record
6. preserve actor and timestamp

MRE write-back should be a separate explicit command.

---

# 40. MRE Rent Write-Back

```text
POST /api/v1/rent-reconciliations/{id}/write-back-to-mre
```

Responsibilities:

- verify reconciliation confirmed
- build MRE payment payload
- call supported MRE API
- record MRE response
- ensure idempotency
- mark write-back state

---

# 41. Loan API

### Queries

```text
GET /api/v1/loans
GET /api/v1/loans/{id}
GET /api/v1/property-references/{propertyReferenceId}/loans
```

### Commands

```text
POST /api/v1/loans
POST /api/v1/loans/{id}/terms
POST /api/v1/loans/{id}/allocations
POST /api/v1/loans/{id}/recalculate-schedule
POST /api/v1/loans/{id}/reconcile-payment
POST /api/v1/loans/{id}/refinance
```

---

# 42. Create Loan

Example:

```json
{
  "lenderPartyId": "...",
  "borrowerPartyIds": ["..."],
  "principalOriginal": {
    "amount": "250000.00",
    "currency": "EUR"
  },
  "startDate": "2026-09-01",
  "acquisitionId": "..."
}
```

---

# 43. Loan Terms

```text
POST /api/v1/loans/{id}/terms
```

A new terms period should not overwrite historical terms.

---

# 44. Loan Allocation

```text
PUT /api/v1/loans/{id}/allocations
```

Request:

```json
{
  "allocations": [
    {
      "propertyReferenceId": "...",
      "share": "0.60"
    },
    {
      "propertyReferenceId": "...",
      "share": "0.40"
    }
  ]
}
```

Validation:

`sum(shares) = 100%`

for a fully allocated Loan.

---

# 45. Loan Schedule Query

```text
GET /api/v1/loans/{id}/schedule
```

Optional query:

- `from`
- `to`
- `version`

Schedule is read-only derived Plan/Forecast data.

---

# 46. Loan Payment Reconciliation

```text
POST /api/v1/loans/{id}/reconcile-payment
```

Request may reference:

- Transaction
- interest split
- principal split
- schedule entry

The command validates split semantics before reconciliation.

---

# 47. Security Deposit API

### Queries

```text
GET /api/v1/security-deposits
GET /api/v1/security-deposits/{id}
GET /api/v1/rental-contract-references/{id}/security-deposit
```

### Commands

```text
POST /api/v1/security-deposits
POST /api/v1/security-deposits/{id}/link-transaction
POST /api/v1/security-deposits/{id}/return
POST /api/v1/security-deposits/{id}/reconcile-with-mre
```

---

# 48. Security Deposit Creation

May initialize expected amount from MRE Tenant.guaranty.

The API must distinguish:

- expected amount
- actual received cash
- actual return cash

---

# 49. WEG API

### Queries

```text
GET /api/v1/weg-associations
GET /api/v1/weg-associations/{id}
GET /api/v1/property-references/{propertyReferenceId}/weg
```

### Commands

```text
POST /api/v1/weg-associations
POST /api/v1/weg-associations/{id}/memberships
POST /api/v1/weg-associations/{id}/economic-plans
POST /api/v1/weg-associations/{id}/annual-statements
POST /api/v1/weg-associations/{id}/special-assessments
```

---

# 50. WEG Annual Statement Import

```text
POST /api/v1/weg-associations/{id}/annual-statements
```

May initially accept:

- manual structured input
- imported CSV
- document reference + manual lines

OCR is future work.

---

# 51. WEG Cost Line Classification

```text
POST /api/v1/weg-cost-lines/{id}/classify
```

Classification may include:

- financial category
- recoverability
- reserve impact

Tax classification remains a separate Taxation command.

---

# 52. Maintenance Project API

### Queries

```text
GET /api/v1/maintenance-projects
GET /api/v1/maintenance-projects/{id}
```

### Commands

```text
POST /api/v1/maintenance-projects
POST /api/v1/maintenance-projects/{id}/link-transaction
POST /api/v1/maintenance-projects/{id}/link-document
POST /api/v1/maintenance-projects/{id}/complete
```

---

# 53. Document API

### Queries

```text
GET /api/v1/documents
GET /api/v1/documents/{id}
```

### Commands

```text
POST /api/v1/documents
POST /api/v1/documents/{id}/links
POST /api/v1/documents/import-mre-reference
```

---

# 54. MRE Document Reference

```text
POST /api/v1/documents/import-mre-reference
```

Request:

```json
{
  "mreRealmId": "...",
  "mreDocumentId": "..."
}
```

Should create metadata reference without duplicating binary content unnecessarily.

---

# 55. Tax Classification API

### Queries

```text
GET /api/v1/tax-classifications
GET /api/v1/tax-classifications/{id}
GET /api/v1/tax-years/{year}/classifications
```

### Commands

```text
POST /api/v1/tax-classifications
POST /api/v1/tax-classifications/{id}/confirm
POST /api/v1/tax-classifications/{id}/mark-needs-review
POST /api/v1/tax-classifications/{id}/advisor-confirm
```

---

# 56. Create Tax Classification

Request must reference an existing source entity.

Example:

```json
{
  "jurisdiction": "DE",
  "taxYear": 2026,
  "sourceEntityType": "TRANSACTION_SPLIT",
  "sourceEntityId": "...",
  "taxCategory": "LOAN_INTEREST",
  "ruleVersionId": "...",
  "reviewState": "SUGGESTED"
}
```

---

# 57. Tax Confirmation

Tax confirmation should:

- validate rule version
- validate tax year
- validate source
- preserve review actor
- create AuditRecord

---

# 58. Tax Rules API

Mostly read-only:

```text
GET /api/v1/tax-rules
GET /api/v1/tax-rules/{ruleCode}
GET /api/v1/tax-rules/{ruleCode}/versions
```

Rule administration should be restricted to trusted maintainer workflows.

---

# 59. Depreciation API

### Queries

```text
GET /api/v1/depreciation-assets
GET /api/v1/depreciation-assets/{id}
GET /api/v1/depreciation-assets/{id}/schedule
```

### Commands

```text
POST /api/v1/depreciation-assets
POST /api/v1/depreciation-assets/{id}/recalculate
POST /api/v1/depreciation-assets/{id}/correct-basis
```

---

# 60. Depreciation Recalculate

```text
POST /api/v1/depreciation-assets/{id}/recalculate
```

Must create a new schedule version rather than silently replace historical versions.

---

# 61. Market Valuation API

### Queries

```text
GET /api/v1/property-references/{propertyReferenceId}/market-valuations
GET /api/v1/market-valuations/{id}
```

### Commands

```text
POST /api/v1/market-valuations
POST /api/v1/market-valuations/{id}/confirm
```

Never expose:

```text
PATCH Property.currentMarketValue
```

---

# 62. Investment Metric API

### Queries

```text
GET /api/v1/property-references/{propertyReferenceId}/metrics
GET /api/v1/property-references/{propertyReferenceId}/metrics/{metricCode}
GET /api/v1/portfolios/{id}/metrics
```

Metrics are read-only derived outputs.

---

# 63. Metric Calculation

```text
POST /api/v1/investment/calculations
```

Request:

```json
{
  "scopeType": "PROPERTY",
  "propertyReferenceId": "...",
  "asOfDate": "2028-12-31",
  "metricCodes": ["NOI", "LTV", "CCR"]
}
```

Response should include:

- value
- formula version
- important input references
- warnings
- calculation timestamp

---

# 64. Investment Metric Snapshot API

### Queries

```text
GET /api/v1/investment-metric-snapshots
GET /api/v1/investment-metric-snapshots/{id}
```

### Commands

```text
POST /api/v1/investment-metric-snapshots
POST /api/v1/property-references/{propertyReferenceId}/snapshot-metrics
```

Snapshot generation is explicit.

Trigger policy may evolve later.

---

# 65. Investment Scenario API

Post-MVP or later MVP phase.

### Queries

```text
GET /api/v1/investment-scenarios
GET /api/v1/investment-scenarios/{id}
```

### Commands

```text
POST /api/v1/investment-scenarios
PUT  /api/v1/investment-scenarios/{id}/assumptions
POST /api/v1/investment-scenarios/{id}/calculate
```

---

# 66. Scenario Isolation

Scenario calculation endpoints must never update:

- actual rent
- actual Transactions
- actual Loan terms
- current Market Valuation

---

# 67. Reporting API

### Queries / Generation

```text
POST /api/v1/reports/property-summary
POST /api/v1/reports/tax-package
POST /api/v1/reports/annual-summary
POST /api/v1/reports/portfolio-summary
```

Report creation must call domain calculations.

It must not implement hidden formulas.

---

# 68. Tax Package

Example:

```text
POST /api/v1/reports/tax-package
```

Request:

```json
{
  "propertyReferenceId": "...",
  "taxYear": 2027,
  "ownerPartyIds": ["..."]
}
```

Output may provide:

- downloadable archive
- report manifest
- missing-review warnings

---

# 69. Dashboard Query API

Dashboards should use dedicated read models where performance requires.

Example:

```text
GET /api/v1/dashboard/properties/{id}
```

Response may aggregate:

- rent status from MRE
- cashflow from Ledger
- remaining debt from Financing
- tax status
- current valuation
- metrics

This is a read model only.

---

# 70. Composite Read Models

Composite API responses are allowed for UI efficiency.

They must not become canonical owners of data.

Example:

```text
PropertyDashboardView
```

may include copies of:

- Property name
- rent due
- cashflow
- debt
- valuation

but these fields remain derived/read-only.

---

# 71. Search API

A future cross-domain search may exist:

```text
GET /api/v1/search?q=...
```

Search results should return references, not independent domain state.

---

# 72. Automation API

### Queries

```text
GET /api/v1/automation-rules
```

### Commands

```text
POST /api/v1/automation-rules
POST /api/v1/automation-rules/{id}/enable
POST /api/v1/automation-rules/{id}/disable
POST /api/v1/automation-rules/{id}/test
```

Automation must invoke existing business commands.

---

# 73. AI Suggestion API

### Queries

```text
GET /api/v1/ai-suggestions
GET /api/v1/ai-suggestions/{id}
```

### Commands

```text
POST /api/v1/ai-suggestions/{id}/accept
POST /api/v1/ai-suggestions/{id}/reject
```

Acceptance must translate into a normal domain command.

---

# 74. AI Transaction Classification Flow

```text
Transaction
    ↓
POST /ai/classification-suggestions
    ↓
AISuggestion
    ↓
User accepts
    ↓
PUT /transactions/{id}/splits
    ↓
POST /transactions/{id}/confirm
```

AI never skips the canonical command path.

---

# 75. MRE Adapter API Responsibilities

The internal MRE adapter should expose capabilities such as:

```text
listRealms()
getProperty()
listProperties()
getTenant()
listTenants()
getTenantRents()
getRentTerm()
recordRentPayment()
getLeaseDefinition()
getDocument()
```

The rest of the DE system should not call arbitrary MRE endpoints directly.

---

# 76. MRE Adapter Anti-Corruption Layer

MRE-specific field names should be translated at the adapter boundary.

Example:

MRE:

```text
Occupant
guaranty
leaseId
properties[]
```

DE integration model:

```text
RentalContractReference
expectedSecurityDeposit
propertyReferences
```

The DE domain must not become polluted with MRE implementation naming.

---

# 77. External System Error Handling

If MRE is unavailable:

- DE canonical data remains accessible
- MRE-dependent operations fail visibly
- errors are marked external
- no partial canonical state should be silently written

Example:

`MRE_UNAVAILABLE`

---

# 78. MRE Write-Back Safety

Any DE command that writes to MRE should:

1. validate DE state
2. verify Realm
3. use idempotency
4. call MRE supported API
5. record result
6. create audit event
7. avoid direct DB write

---

# 79. Bank Adapter Boundary

Future bank APIs should also sit behind an adapter.

The Financial Ledger must not depend on one bank vendor.

Conceptual interface:

```text
listAccounts()
listTransactions()
getTransaction()
```

Initial implementation may be CSV-only.

---

# 80. Import API Semantics

Imported records begin as non-confirmed unless explicitly trusted.

Recommended flow:

```text
Imported
→ Unreviewed
→ Classified
→ Confirmed
→ Reconciled
```

---

# 81. Batch Commands

Batch endpoints are acceptable when they preserve individual validation results.

Example:

```text
POST /api/v1/transactions/batch-confirm
```

Response should report per-item success/failure.

Do not make partial failures invisible.

---

# 82. Pagination

Collection endpoints should support pagination.

Recommended query:

```text
?page=1&pageSize=50
```

Large transaction datasets should additionally support cursor-based pagination later if needed.

---

# 83. Sorting

Use explicit fields:

```text
?sort=bookingDate:desc
```

Only allow approved sortable fields.

---

# 84. Filtering

Prefer semantic query fields over arbitrary database query syntax.

Good:

```text
?status=CONFIRMED&propertyReferenceId=...
```

Avoid exposing raw Mongo operators or SQL fragments.

---

# 85. Date Range Filtering

Use:

```text
?from=2026-01-01&to=2026-12-31
```

Date semantics must be documented per endpoint.

---

# 86. Money Representation

JSON Money should not use binary floating values.

Preferred conceptual shape:

```json
{
  "amount": "1250.00",
  "currency": "EUR"
}
```

Exact serialization may be standardized later.

---

# 87. Percentage Representation

Use one consistent convention.

Recommended API representation:

```json
{
  "share": "0.50"
}
```

for 50%.

Documentation must state this globally.

---

# 88. Dates and Timestamps

Business dates:

```text
YYYY-MM-DD
```

A business date must be a real calendar date with a year from **1900 to 2100**. Other years are refused as `OUT_OF_RANGE` (a typo such as `0202` would otherwise book into the year 202); malformed or impossible dates are `INVALID_FORMAT`.

System timestamps:

```text
RFC 3339 / ISO 8601
```

Avoid locale-formatted dates in DE API contracts.

MRE adapter is responsible for translating MRE-specific date formatting where necessary.

---

# 89. Review Warnings

Responses may include non-blocking warnings.

Example:

```json
{
  "warnings": [
    {
      "code": "TAX_CLASSIFICATION_NEEDS_REVIEW",
      "sourceEntityId": "..."
    }
  ]
}
```

Warnings must not be confused with errors.

---

# 90. Validation Error Detail

Example:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Validation failed.",
    "details": {
      "fields": [
        {
          "field": "share",
          "code": "OWNERSHIP_TOTAL_EXCEEDS_100"
        }
      ]
    }
  }
}
```

---

# 91. Derived Data Traceability

Derived endpoints should expose enough metadata to explain results.

Example metric response:

```json
{
  "metricCode": "LTV",
  "value": "0.68",
  "formulaVersion": "1",
  "inputs": {
    "marketValuationId": "...",
    "loanIds": ["..."]
  }
}
```

---

# 92. Audit API

Read-only audit queries:

```text
GET /api/v1/audit-records
GET /api/v1/entities/{entityType}/{entityId}/audit-records
```

Audit history should not be editable through normal user APIs.

---

# 93. Health APIs

Operational endpoints:

```text
GET /health
GET /ready
```

May expose dependency status such as:

- database
- MRE
- document storage

Do not leak secrets.

---

# 94. Capability Discovery

Optional future endpoint:

```text
GET /api/v1/capabilities
```

May indicate:

- MRE connected
- banking import enabled
- OCR enabled
- AI enabled
- tax rules available

Useful for modular deployments.

---

# 95. API Documentation

The implementation should eventually provide machine-readable OpenAPI documentation.

Every public endpoint should document:

- authorization
- inputs
- outputs
- error codes
- idempotency
- side effects
- domain owner

---

# 96. API Test Strategy

Each business command requires tests for:

- success path
- validation
- authorization
- duplicate/idempotency
- concurrency
- audit creation
- domain invariants

Integration endpoints additionally require MRE contract tests.

---

# 97. Contract Tests Against MRE

At minimum:

- Property retrieval
- Tenant retrieval
- rent retrieval
- payment write-back
- Lease retrieval
- Realm access isolation

MRE version upgrades must run these tests.

---

# 98. API Anti-Patterns

## Anti-Pattern 1 — Generic CRUD Everywhere

Avoid:

```text
PATCH /entity/{id}
```

for domain transitions with important meaning.

---

## Anti-Pattern 2 — Raw Database API

Never expose:

```text
/query?filter={$and:[...]}
```

---

## Anti-Pattern 3 — UI-Owned Business Logic

The API must expose calculated business results rather than require the frontend to reproduce formulas.

---

## Anti-Pattern 4 — Derived Value Update

Never expose:

```text
PATCH /metrics/LTV
```

---

## Anti-Pattern 5 — Direct AI Write

Never expose an AI path that bypasses canonical commands.

---

## Anti-Pattern 6 — Direct MRE DB Write

All MRE mutations use supported adapter/API paths.

---

## Anti-Pattern 7 — Hidden Cross-Domain Mutation

A Tax command must not silently rewrite Financial Ledger data.

---

# 99. Initial MVP API Surface

The MVP should prioritize:

### Integration

- MRE Realm
- PropertyReference
- Party mapping
- RentalContractReference
- rent reads

### Financial

- FinancialAccount
- Bank import
- Transaction
- TransactionSplit
- confirmation
- correction
- rent reconciliation

### Acquisition

- Acquisition
- Acquisition Costs
- Ownership
- Land/Building Allocation

### Financing

- Loan
- Loan Terms
- Loan Allocation
- Loan Schedule
- payment reconciliation

### German Property

- WEG
- WEG Membership
- Economic Plan
- Annual Statement
- Cost Lines

### Tax

- Tax Classification
- Tax Rule reads
- Depreciation

### Investment

- Market Valuation
- metrics
- metric snapshots

### Reporting

- Property Dashboard
- annual tax package

---

# 100. Deferred API Surface

Initially defer:

- Portfolio APIs
- Open Banking
- OCR
- advanced Utility Settlement
- automated Scenario engine
- AI endpoints beyond basic suggestion architecture
- mobile-specific APIs
- external third-party developer API

---

# 101. Recommended API Module Layout

Conceptually:

```text
api/
├── integration/
│   └── mre/
├── parties/
├── properties/
├── ownership/
├── acquisitions/
├── ledger/
├── financing/
├── deposits/
├── weg/
├── maintenance/
├── documents/
├── taxation/
├── depreciation/
├── investment/
├── reporting/
├── automation/
└── ai/
```

This is logical module structure, not necessarily separate services.

---

# 102. Command Naming Rule

Commands should use domain language.

Preferred:

```text
confirmTransaction()
reconcileRentPayment()
closeOwnership()
recalculateDepreciation()
```

Avoid:

```text
updateRecord()
setStatus()
saveData()
```

---

# 103. Query Naming Rule

Queries should describe user intent.

Preferred:

```text
getPropertyDashboard()
getOutstandingRentReconciliations()
getTaxYearSummary()
```

Avoid exposing persistence terminology.

---

# 104. Internal vs External APIs

Not every internal capability must be publicly exposed.

Example:

`recalculateAllDerivedMetrics()` may remain an internal service operation.

Public API should remain intentionally small.

---

# 105. API Evolution Rule

When adding a new endpoint, contributors must verify:

- Which domain owns the operation?
- Is this a query or command?
- Does it duplicate an existing capability?
- Does it expose implementation details?
- Can it violate accepted ADRs?
- Is it idempotent where necessary?
- Is audit behavior defined?
- Are MRE dependencies isolated?

---

# 106. AI Coding Agent Guidance

AI coding agents implementing APIs must:

- follow business command semantics
- avoid generic CRUD shortcuts
- preserve domain ownership
- use FinancialAccount naming
- use RentalContractReference rather than assuming MRE Lease is the full contract
- use MRE adapter interfaces
- implement reconciliation explicitly
- never create Ledger Transactions from MRE payments without provenance
- never expose editable derived metrics
- include tests for invariants
- surface ADR conflicts instead of bypassing them

---

# 107. Open API Decisions

## API-OPEN-001 — Authentication Token Sharing

How exactly should the DE API validate or reuse MRE authentication tokens?

**Direction accepted (ADR-034):** reuse MRE authentication + Realm authority. The exact token validation/propagation mechanism is an implementation spike (per TECH-ADR-005), not a new architecture decision.

---

## API-OPEN-002 — Organization Context Transport

Should Realm context be encoded primarily in:

- token claims
- header
- route
- combination

Implementation-level under ADR-034 (Realm authority reused); Realm membership must be verified server-side regardless of transport.

**Resolved at implementation level (VC-0-08):** the Realm is sent in the `organizationid` request header — the same header the MRE landlord API uses — and verified server-side against MRE on every `/api/v1` request (`mre-integration.md` §47.1). Route scoping may be added later where a resource path naturally carries the Realm.

---

## API-OPEN-003 — MRE Payment ID Limitation

How should reconciliation fingerprints be represented until MRE has stable payment IDs?

---

## API-OPEN-004 — Correction Endpoint Semantics

Should correction create:

- replacement record
- reversal + replacement
- versioned mutation

**Resolved by ADR-037:** reversal + replacement (confirmed transactions are immutable).

---

## API-OPEN-005 — Async Jobs

Large reports, imports and OCR may eventually require job APIs.

The initial MVP should avoid asynchronous infrastructure unless necessary.

---

## API-OPEN-006 — GraphQL

No need exists currently.

REST-like business APIs are preferred for the MVP.

GraphQL may be reconsidered only if composite query requirements justify it.

---

# 108. Final API Principle

The API should expose the business model the user understands.

It should not expose the database model the developer happens to use.

The correct abstraction chain is:

```text
User Intent
   ↓
Business Capability
   ↓
Domain Command / Query
   ↓
Domain Model
   ↓
Persistence / MRE Adapter
```

Never reverse this chain.

---

# Closing Statement

The API of Vermieter Cockpit DE is not intended to be a thin CRUD layer over storage.

It is the executable contract of the domain model.

Its role is to protect:

- financial truth
- domain boundaries
- historical traceability
- MRE compatibility
- human review
- reproducible calculations

The best API endpoint is not the one that exposes the most flexibility.

It is the one that makes the correct business action explicit and the incorrect state difficult or impossible to create.

> Commands express intent.  
> Queries explain state.  
> Adapters isolate external systems.  
> Reconciliation connects realities without merging them.
